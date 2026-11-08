// quick-agent desktop client — Electron main process.
//
// Responsibilities:
//  - start / reuse the quick-agent hub and Web UI server (via bootstrap.mjs → shared/hub-process.ts + ui-process.ts)
//  - load the Web UI in a locked-down window; the hub token is injected as an HttpOnly cookie for the UI origin
//    only (never put in a URL, never exposed to page JavaScript)
//  - native attention management: menu-bar tray with running / inbox counts, Dock badge, system notifications
//    when a worker hands work back (click → jump to the task), global quick-dispatch shortcut
//  - remember window state, follow the system light/dark appearance
"use strict";

const { app, BrowserWindow, Menu, Tray, Notification, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, session, shell } = require("electron");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("./lib.cjs");

const IS_MAC = process.platform === "darwin";
const DEV = !app.isPackaged;
const SRC = __dirname;
const ASSETS = path.join(SRC, "..", "assets");

// ---------------------------------------------------------------- settings

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const DEFAULTS = {
	shortcut: "CommandOrControl+Shift+Space",
	notifications: true,
	digestMinutes: 30, // "已完成待扫" hand-backs are batched into one notification this often
	quiet: { mode: "off" }, // 专注模式: { mode: "focus", minutes?, until? }
	quickMode: "front", // "front" = hand to the front agent, "direct" = hand straight to a worker
	cwd: undefined, // advanced: working directory of the front agent process (default: config defaultCwd)
	repo: undefined, // quick-agent repository (default: auto-detect)
	node: undefined, // node binary (default: login-shell PATH)
	bounds: undefined,
	maximized: false,
};
let settings = { ...DEFAULTS };
function loadSettings() {
	try {
		settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) };
	} catch {}
}
let saveTimer;
function saveSettings() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try {
			fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
			fs.writeFileSync(SETTINGS_FILE(), `${JSON.stringify(settings, null, 2)}\n`);
		} catch (e) {
			log(`save settings: ${e.message}`);
		}
	}, 300);
}

function log(msg) {
	console.log(`[quick-agent desktop] ${msg}`);
}

// ---------------------------------------------------------------- environment (PATH, node, repo)

/** GUI apps on macOS get a minimal PATH; recover the login-shell PATH (node, pi, tmux, ssh…). */
function fixPath() {
	const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".volta/bin"), "/usr/bin", "/bin"];
	let shellPath = "";
	if (process.platform !== "win32") {
		try {
			const sh = process.env.SHELL || "/bin/zsh";
			const out = execFileSync(sh, ["-ilc", 'printf "__QA_PATH__%s__QA_END__" "$PATH"'], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
			shellPath = /__QA_PATH__(.*)__QA_END__/s.exec(out)?.[1] ?? "";
		} catch {}
	}
	const parts = [...shellPath.split(":"), ...(process.env.PATH || "").split(":"), ...extra].filter(Boolean);
	process.env.PATH = [...new Set(parts)].join(":");
	delete process.env.QA_TASK_ID; // the desktop client is never a worker
	delete process.env.QA_ROLE;
	delete process.env.ELECTRON_RUN_AS_NODE;
}

function which(bin) {
	for (const d of (process.env.PATH || "").split(":")) {
		const p = path.join(d, bin);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {}
	}
	return undefined;
}

function findNode() {
	const cands = [process.env.QA_NODE, settings.node, which("node")].filter(Boolean);
	for (const c of cands) {
		try {
			const v = execFileSync(c, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5000 }).trim();
			const [maj, min] = v.split(".").map(Number);
			if (maj > 22 || (maj === 22 && min >= 18)) return { bin: c, version: v };
			log(`node ${c} is ${v}, need >= 22.18`);
		} catch {}
	}
	return undefined;
}

const isRepo = (d) => !!d && fs.existsSync(path.join(d, "ui", "server.ts")) && fs.existsSync(path.join(d, "shared", "ui-process.ts"));
function findRepo() {
	const cands = [process.env.QA_REPO, settings.repo];
	if (DEV) cands.push(path.resolve(SRC, "..", ".."));
	const q = which("quick");
	if (q) {
		try {
			cands.push(path.resolve(path.dirname(fs.realpathSync(q)), ".."));
		} catch {}
	}
	cands.push(path.join(process.resourcesPath || "", "quick-agent")); // bundled copy (packaged app fallback)
	return cands.find(isRepo);
}

/** bootstrap.mjs is run by the system node, so it must live outside app.asar. */
const BOOTSTRAP = path.join(SRC, "bootstrap.mjs").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

let env = { node: undefined, repo: undefined };
let conn; // { token, uiUrl, uiPort, hubUrl, cwd, uiLog, hubLog, machine }

function runBootstrap(args, timeout = 60000) {
	return new Promise((resolve, reject) => {
		execFile(env.node.bin, [BOOTSTRAP, env.repo, ...args], { timeout, env: { ...process.env, NODE_NO_WARNINGS: "1" }, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
			const line = String(stdout).trim().split("\n").filter(Boolean).pop();
			let r;
			try {
				r = line ? JSON.parse(line) : undefined;
			} catch {}
			if (r?.ok) return resolve(r);
			reject(new Error(r?.error || stderr?.trim() || err?.message || "bootstrap failed"));
		});
	});
}

async function ensureBackend() {
	env.node = findNode();
	if (!env.node) throw new Error("找不到 Node.js ≥ 22.18（quick-agent 需要它运行 hub 和 Web UI）。\n请安装新版 Node，或在设置文件中指定 \"node\" 路径 / 设置环境变量 QA_NODE。");
	env.repo = findRepo();
	if (!env.repo) throw new Error("找不到 quick-agent 仓库（需要包含 ui/server.ts）。\n请确认 `quick` 命令在 PATH 中，或在设置文件中指定 \"repo\" / 设置环境变量 QA_REPO。");
	const args = ["ensure"];
	if (settings.cwd) args.push("--cwd", settings.cwd);
	conn = await runBootstrap(args);
	log(`backend: hub ${conn.hub} (${conn.hubUrl}), ui ${conn.ui} (${conn.uiUrl}, cwd ${conn.cwd}), repo ${env.repo}, node ${env.node.version}`);
	// Log the window in: HttpOnly cookie scoped to the UI origin (same cookie the server sets on ?token=).
	await session.defaultSession.cookies.set({
		url: conn.uiUrl,
		name: `qa_ui_${conn.uiPort}`,
		value: encodeURIComponent(conn.token),
		httpOnly: true,
		sameSite: "strict",
		path: "/",
		expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
	});
	return conn;
}

async function uiHealthy() {
	if (!conn) return false;
	try {
		const r = await fetch(`${conn.uiUrl}/health`, { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------- main window

let win;
let quitting = false;
let startHidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAsHidden;
let pendingToRenderer = [];

const bg = () => (nativeTheme.shouldUseDarkColors ? "#0e0e0e" : "#f4f4f0");

function statusPage(kind, message) {
	const q = new URLSearchParams({ kind, message: message || "", log: conn?.uiLog || path.join(os.homedir(), ".quick-agent", "ui.log") });
	return { file: path.join(SRC, "status.html"), query: Object.fromEntries(q) };
}

function createWindow() {
	const b = lib.validBounds(settings.bounds, screen.getAllDisplays()) || { width: 1280, height: 840 };
	win = new BrowserWindow({
		...b,
		minWidth: 720,
		minHeight: 480,
		title: "quick-agent",
		show: false,
		backgroundColor: bg(),
		icon: IS_MAC ? undefined : path.join(ASSETS, "icon.png"),
		webPreferences: {
			preload: path.join(SRC, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			spellcheck: false,
		},
	});
	// `--hidden`: start in the menu bar only (login item / background start); the window opens on demand.
	if (!startHidden)
		win.once("ready-to-show", () => {
			if (settings.maximized) win.maximize();
			win.show();
		});
	startHidden = false;
	const remember = () => {
		if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
		settings.maximized = win.isMaximized();
		if (!settings.maximized) settings.bounds = win.getBounds();
		saveSettings();
	};
	win.on("resize", remember);
	win.on("move", remember);
	win.on("close", (e) => {
		remember();
		// Closing the window detaches the client; workers (and the hub / UI server) keep running.
		if (!quitting && IS_MAC) {
			e.preventDefault();
			win.hide();
		}
	});
	win.on("closed", () => (win = undefined));
	if (process.env.QA_DESKTOP_DEBUG) win.on("show", () => log("window shown"));
	win.on("focus", () => updateIndicators());

	const wc = win.webContents;
	const allowed = (u) => {
		try {
			const url = new URL(u);
			if (url.protocol === "file:") return url.pathname.endsWith("/status.html");
			return !!conn && url.origin === new URL(conn.uiUrl).origin;
		} catch {
			return false;
		}
	};
	const openExternal = (u) => {
		if (/^https?:\/\//i.test(u)) shell.openExternal(u);
	};
	wc.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: "deny" };
	});
	wc.on("will-navigate", (e, url) => {
		if (!allowed(url)) {
			e.preventDefault();
			openExternal(url);
		}
	});
	wc.on("will-redirect", (e, url) => {
		if (!allowed(url)) e.preventDefault();
	});
	wc.on("will-attach-webview", (e) => e.preventDefault());
	wc.on("did-finish-load", () => {
		injectGlue();
		flushRenderer();
	});
	wc.on("render-process-gone", (_e, d) => {
		log(`renderer gone: ${d.reason}`);
		if (d.reason !== "clean-exit") setTimeout(() => loadUi(), 1000);
	});
	wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
		if (isMain && code !== -3 && url.startsWith("http")) showStatus("error", `无法加载 Web UI：${desc} (${code})`);
	});
	return win;
}

function showStatus(kind, message) {
	if (!win) return;
	const p = statusPage(kind, message);
	win.loadFile(p.file, { query: p.query });
}

async function loadUi() {
	if (!win) createWindow();
	try {
		if (!(await uiHealthy())) {
			showStatus("loading", "正在启动 quick-agent hub 与前台 agent…");
			await ensureBackend();
			startHubStream();
		}
		await win.loadURL(`${conn.uiUrl}/`);
	} catch (e) {
		log(`startup failed: ${e.message}`);
		showStatus("error", e.message);
	}
}

function showWindow() {
	if (process.env.QA_DESKTOP_DEBUG) log(`showWindow: ${new Error().stack.split("\n").slice(2, 5).map((l) => l.trim()).join(" < ")}`);
	if (!win) {
		createWindow();
		loadUi();
	}
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
	if (IS_MAC) app.focus({ steal: true });
}

/** Send to the renderer once the Web UI is loaded (buffers across reloads / cold start). */
function toRenderer(channel, ...args) {
	pendingToRenderer.push([channel, args]);
	flushRenderer();
}
function flushRenderer() {
	if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
	if (!conn || !win.webContents.getURL().startsWith(conn.uiUrl)) return;
	for (const [c, a] of pendingToRenderer.splice(0)) win.webContents.send(c, ...a);
}

function openTask(id) {
	showWindow();
	toRenderer("qa:open-task", id);
}
/** Attention views: "need" (需要你) · "inflight" (已托付/进行中) · "skim" (已完成待扫). */
function showView(v) {
	showWindow();
	toRenderer("qa:view", v);
}

/**
 * Default handlers for the desktop bridge, used until the Web UI registers its own via window.quickDesktop.
 * They only rely on stable Web UI entry points: a global openTask(id) when present, otherwise URL hashes
 * (#task=<id>, #view=need|inflight|skim) that the Web UI can honour. Nothing here touches credentials.
 */
function injectGlue() {
	if (!win || !conn || !win.webContents.getURL().startsWith(conn.uiUrl)) return;
	win.webContents
		.executeJavaScript(
			`(() => { const d = window.quickDesktop; if (!d || window.__qaGlue) return; window.__qaGlue = 1;
  d.fallback("qa:open-task", (id) => { if (typeof window.openTask === "function") window.openTask(id); else location.hash = "task=" + encodeURIComponent(id); });
  d.fallback("qa:view", (v) => { if (typeof window.qaShowView === "function") window.qaShowView(v); else location.hash = "view=" + v; });
  d.fallback("qa:action", (a) => { if (a === "focus-input") { const i = document.querySelector("#input, textarea"); if (i) i.focus(); } });
})()`,
		)
		.catch(() => {});
}

// ---------------------------------------------------------------- hub stream → tray / dock / notifications

const tasks = new Map();
const gate = new lib.NotificationGate();
const liveNotifications = new Set(); // keep references so click handlers survive GC
let hubAbort;
let hubConnected = false;

async function hubFetch(p, init = {}) {
	const r = await fetch(conn.hubUrl + p, {
		...init,
		headers: { authorization: `Bearer ${conn.token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
		signal: init.signal || AbortSignal.timeout(10000),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
	return data;
}

async function loadSnapshot() {
	const { tasks: list } = await hubFetch("/api/tasks");
	tasks.clear();
	for (const t of list) {
		tasks.set(t.id, t);
		gate.shouldShow(`${t.id}:${t.status}:${t.updatedAt}`); // never notify for the snapshot itself
	}
	updateIndicators();
}

function onHubEvent(e) {
	if (e.type === "hello") return void loadSnapshot().catch(() => {});
	if (e.type !== "task" || !e.task) return;
	const prev = tasks.get(e.task.id);
	tasks.set(e.task.id, e.task);
	const n = lib.notificationFor(prev, e.task, e.event);
	if (n && gate.shouldShow(`${e.task.id}:${e.task.status}:${e.task.updatedAt}`)) {
		if (n.kind === "urgent") notifyUrgent(e.task, n);
		else digest.add(e.task);
	}
	updateIndicators();
}

function startHubStream() {
	if (hubAbort) hubAbort.abort();
	hubAbort = new AbortController();
	const signal = hubAbort.signal;
	(async () => {
		let delay = 1000;
		while (!signal.aborted) {
			try {
				const res = await fetch(`${conn.hubUrl}/api/events?role=desktop`, { headers: { authorization: `Bearer ${conn.token}`, accept: "text/event-stream" }, signal });
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				hubConnected = true;
				delay = 1000;
				await loadSnapshot().catch(() => {});
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const frame = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = frame
							.split("\n")
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).trimStart())
							.join("\n");
						if (!data) continue;
						try {
							onHubEvent(JSON.parse(data));
						} catch {}
					}
				}
			} catch {}
			if (signal.aborted) break;
			hubConnected = false;
			updateIndicators();
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * 2, 15000);
		}
	})();
}

// Notifications are deliberately restrained (attention is the scarce resource, see docs/attention.md):
//  - "需要你" (asked / blocked / failed / stopped) notifies immediately — the only thing allowed to interrupt;
//  - "已完成待扫" never interrupts on its own: hand-backs are batched into one quiet digest (default every 30 min);
//  - 专注模式 holds everything (no banners, tray count still updates) and summarises once when it ends;
//  - progress and activity never notify; nothing notifies while the window is in front (it already shows it);
//  - no sounds.
const digest = new lib.Digest();
let heldUrgent = []; // "需要你" items that arrived during 专注, summarised afterwards

function windowInFront() {
	return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
}

function showNotification({ title, subtitle, body, onClick }) {
	if (!settings.notifications || !Notification.isSupported()) return;
	log(`notify: ${title} — ${String(body || "").slice(0, 80)}`);
	const notif = new Notification({ title, subtitle, body, silent: true });
	liveNotifications.add(notif);
	const drop = () => liveNotifications.delete(notif);
	notif.on("click", () => {
		drop();
		onClick?.();
	});
	notif.on("close", drop);
	notif.show();
	setTimeout(drop, 30 * 60 * 1000);
}

function notifyUrgent(task, n) {
	if (lib.quietMode(settings) !== "off") {
		heldUrgent.push(task.id);
		return void log(`held (专注): ${n.title}`);
	}
	if (windowInFront()) return void log(`not notified (window in front): ${n.title}`);
	showNotification({ title: n.title, subtitle: n.subtitle, body: n.body, onClick: () => openTask(task.id) });
}

function flushDigest(force = false) {
	digest.prune((id) => lib.bucket(tasks.get(id)) === "skim");
	if (!digest.size) return;
	if (!force && lib.quietMode(settings) !== "off") return; // held until 专注 ends
	if (windowInFront()) {
		digest.flush(); // the user is looking at the app already
		return;
	}
	const d = digest.flush();
	showNotification({ title: d.title, body: d.body, onClick: () => (d.ids.length === 1 ? openTask(d.ids[0]) : showView("skim")) });
}

let quietTimer;
let lastQuietMode = "off";
function setQuiet(mode, minutes) {
	settings.quiet = mode === "off" ? { mode: "off" } : { mode, minutes, until: minutes ? Date.now() + minutes * 60000 : undefined };
	saveSettings();
	checkQuiet();
	updateIndicators();
}
/** Runs every 30 s: ends expired quiet periods and summarises what was held. */
function checkQuiet() {
	const mode = lib.quietMode(settings);
	if (lastQuietMode !== "off" && mode === "off") {
		if (settings.quiet?.mode !== "off") {
			settings.quiet = { mode: "off" };
			saveSettings();
		}
		const need = lib.byBucket([...tasks.values()], "need", 50);
		const held = heldUrgent.filter((id) => need.some((t) => t.id === id));
		heldUrgent = [];
		if (held.length && need.length && !windowInFront())
			showNotification({ title: `专注结束 · ${need.length} 件事需要你`, body: need.slice(0, 4).map((t) => t.title.slice(0, 24)).join("、"), onClick: () => showView("need") });
		flushDigest(true);
		updateIndicators();
	}
	lastQuietMode = mode;
}
function quietLabel() {
	const mode = lib.quietMode(settings);
	if (mode === "off") return "";
	const until = settings.quiet?.until ? `至 ${new Date(settings.quiet.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
	return `专注${until ? ` ${until}` : ""}`;
}

// ---------------------------------------------------------------- tray + dock (only "需要你" is counted)

let tray;
let trayTimer;
function updateIndicators() {
	clearTimeout(trayTimer);
	trayTimer = setTimeout(renderIndicators, 120);
}
function renderIndicators() {
	const list = [...tasks.values()];
	const s = lib.summarize(list);
	if (IS_MAC && app.dock) app.dock.setBadge(lib.badge(s));
	else app.setBadgeCount?.(s.need);
	if (!tray) return;
	const quiet = lib.quietMode(settings);
	if (IS_MAC) tray.setTitle(hubConnected ? `${lib.trayTitle(s)}${quiet !== "off" ? " ☾" : ""}` : "⚡–", { fontType: "monospacedDigit" });
	tray.setToolTip(s.need ? `quick-agent · ${s.need} 件事需要你` : "quick-agent · 没有需要你的事");
	const item = (t) => ({ label: `${t.title.slice(0, 42)}  · ${lib.STATUS_LABEL[t.status] || t.status}`, click: () => openTask(t.id) });
	const need = lib.byBucket(list, "need", 8).map(item);
	const quietItem = (label, mode, minutes) => ({
		label,
		type: "radio",
		checked: quiet === mode && (mode === "off" || (settings.quiet?.minutes ?? 0) === (minutes ?? 0)),
		click: () => setQuiet(mode, minutes),
	});
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: hubConnected ? (s.need ? `需要你 · ${s.need}` : "没有需要你的事") : "hub 未连接", enabled: false },
			...need,
			{ type: "separator" },
			{ label: `已托付/进行中 · ${s.inflight}`, click: () => showView("inflight") },
			{ label: `已完成待扫 · ${s.skim}`, click: () => showView("skim") },
			{ type: "separator" },
			{ label: "把一件事交出去…", accelerator: settings.shortcut, click: showQuick },
			{ label: "打开 quick-agent", click: showWindow },
			{ type: "separator" },
			{
				label: quiet === "off" ? "专注模式" : `专注模式（${quietLabel()}）`,
				submenu: [
					{ label: "专注时不弹任何通知，结束后汇总", enabled: false },
					quietItem("关闭", "off"),
					{ type: "separator" },
					quietItem("专注 30 分钟", "focus", 30),
					quietItem("专注 1 小时", "focus", 60),
					quietItem("专注 2 小时", "focus", 120),
					quietItem("专注，直到我关闭", "focus"),
				],
			},
			{
				label: "通知设置",
				submenu: [
					{ label: "系统通知", type: "checkbox", checked: settings.notifications, click: (i) => ((settings.notifications = i.checked), saveSettings()) },
					{ type: "separator" },
					{ label: "待扫汇总间隔", enabled: false },
					...[5, 10, 30, 60].map((m) => ({
						label: `${m} 分钟`,
						type: "radio",
						checked: settings.digestMinutes === m,
						click: () => {
							settings.digestMinutes = m;
							saveSettings();
							scheduleDigest();
						},
					})),
				],
			},
			{ type: "separator" },
			{ label: "退出（worker 继续在后台运行）", click: () => app.quit() },
		]),
	);
}
let digestTimer;
function scheduleDigest() {
	clearInterval(digestTimer);
	digestTimer = setInterval(() => flushDigest(false), Math.max(1, settings.digestMinutes || 30) * 60000);
}

function createTray() {
	const img = nativeImage.createFromPath(path.join(ASSETS, IS_MAC ? "trayTemplate.png" : "icon.png"));
	if (IS_MAC) img.setTemplateImage(true);
	tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : IS_MAC ? img : img.resize({ width: 16, height: 16 }));
	if (!IS_MAC) tray.on("click", showWindow);
	renderIndicators();
}

// ---------------------------------------------------------------- quick dispatch window

let quick;
let quickReturnFocus = false; // the app was in the background when the quick window opened
/** Hide the quick window; on macOS give focus back to the app the user came from (Spotlight-like). */
function hideQuick() {
	if (!quick || !quick.isVisible()) return;
	quick.hide();
	if (IS_MAC && quickReturnFocus) app.hide();
}
function createQuick() {
	const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
	const width = 680;
	quick = new BrowserWindow({
		width,
		height: 168,
		x: Math.round(d.x + (d.width - width) / 2),
		y: Math.round(d.y + d.height * 0.22),
		frame: false,
		resizable: false,
		movable: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
		backgroundColor: bg(),
		webPreferences: { preload: path.join(SRC, "quick-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
	});
	quick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	quick.loadFile(path.join(SRC, "quick.html"));
	quick.on("blur", () => quick?.hide());
	quick.on("closed", () => (quick = undefined));
	quick.webContents.on("will-navigate", (e) => e.preventDefault());
	quick.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
function showQuick() {
	if (!quick) createQuick();
	if (!quick.isVisible()) quickReturnFocus = !BrowserWindow.getFocusedWindow();
	const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
	const [w] = quick.getSize();
	quick.setPosition(Math.round(d.x + (d.width - w) / 2), Math.round(d.y + d.height * 0.22));
	const send = () => quick.webContents.send("quick:show", { mode: settings.quickMode, cwd: conn?.cwd || settings.cwd || "", connected: !!conn });
	if (quick.webContents.isLoading()) quick.webContents.once("did-finish-load", send);
	else send();
	quick.show();
	quick.focus();
}
function toggleQuick() {
	if (quick?.isVisible()) hideQuick();
	else showQuick();
}

ipcMain.handle("quick:submit", async (e, payload) => {
	if (!quick || e.sender !== quick.webContents) throw new Error("forbidden");
	const text = String(payload?.text ?? "").trim();
	const mode = payload?.mode === "direct" ? "direct" : "front";
	if (!text) return { ok: false, message: "内容为空" };
	settings.quickMode = mode;
	saveSettings();
	try {
		if (!conn || !(await uiHealthy())) {
			await ensureBackend();
			startHubStream();
		}
		if (mode === "front") {
			const r = await fetch(`${conn.uiUrl}/api/prompt`, {
				method: "POST",
				headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
				body: JSON.stringify({ text }),
				signal: AbortSignal.timeout(15000),
			});
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
			if (payload?.open) {
				quickReturnFocus = false;
				showWindow();
			}
			return { ok: true, message: "已交给前台" };
		}
		const { task } = await hubFetch("/api/tasks", {
			method: "POST",
			body: JSON.stringify({ title: lib.titleFromText(text), brief: text, cwd: conn.cwd || conn.defaultCwd, source: { kind: "api" } }),
		});
		tasks.set(task.id, task);
		updateIndicators();
		if (payload?.open) {
			quickReturnFocus = false;
			openTask(task.id);
		}
		return { ok: true, message: `已交给 worker ${task.id}` };
	} catch (err) {
		return { ok: false, message: err.message };
	}
});
ipcMain.on("quick:hide", (e) => {
	if (quick && e.sender === quick.webContents) hideQuick();
});

// Renderer (Web UI / status page) → main
ipcMain.on("qa:retry", (e) => {
	if (win && e.sender === win.webContents) {
		conn = undefined;
		loadUi();
	}
});
ipcMain.on("qa:open-external-ui", (e) => {
	if (win && e.sender === win.webContents && conn) shell.openExternal(`${conn.uiUrl}/?token=${encodeURIComponent(conn.token)}`);
});

// ---------------------------------------------------------------- shortcuts + menu

let shortcutOk = false;
function registerShortcut() {
	globalShortcut.unregisterAll();
	try {
		shortcutOk = globalShortcut.register(settings.shortcut, toggleQuick);
	} catch {
		shortcutOk = false;
	}
	if (!shortcutOk) log(`global shortcut ${settings.shortcut} is not available (in use by another app?)`);
}

// No sessions anywhere: the menu is organised around attention (需要你 / 已托付 / 待扫) and handing things off.
function buildMenu() {
	const template = [
		...(IS_MAC ? [{ role: "appMenu" }] : []),
		{
			label: "文件",
			submenu: [
				{ label: "把一件事交出去…", accelerator: settings.shortcut, click: showQuick },
				{ label: "聚焦输入框", accelerator: "CmdOrCtrl+L", click: () => (showWindow(), toRenderer("qa:action", "focus-input")) },
				{ type: "separator" },
				IS_MAC ? { role: "close" } : { role: "quit" },
			],
		},
		{ role: "editMenu" },
		{
			label: "注意力",
			submenu: [
				{ label: "需要你", accelerator: "CmdOrCtrl+1", click: () => showView("need") },
				{ label: "已托付 / 进行中", accelerator: "CmdOrCtrl+2", click: () => showView("inflight") },
				{ label: "已完成待扫", accelerator: "CmdOrCtrl+3", click: () => showView("skim") },
				{ type: "separator" },
				{ label: "专注 1 小时", accelerator: "CmdOrCtrl+Shift+F", click: () => setQuiet("focus", 60) },
				{ label: "结束专注", click: () => setQuiet("off") },
			],
		},
		{
			label: "视图",
			submenu: [
				{ label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => loadUi() },
				{ role: "toggleDevTools", accelerator: "Alt+CmdOrCtrl+I" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
		{
			label: "帮助",
			submenu: [
				{ label: "在浏览器中打开 Web UI", click: () => conn && shell.openExternal(`${conn.uiUrl}/?token=${encodeURIComponent(conn.token)}`) },
				{ label: "打开 hub 面板", click: () => conn && shell.openExternal(`${conn.hubUrl}/?token=${encodeURIComponent(conn.token)}`) },
				{ label: "打开日志目录", click: () => shell.openPath(path.join(os.homedir(), ".quick-agent")) },
				{ label: "打开客户端设置文件", click: () => (saveSettings(), setTimeout(() => shell.openPath(SETTINGS_FILE()), 400)) },
				{ type: "separator" },
				{ label: "quick-agent on GitHub", click: () => shell.openExternal("https://github.com/concept-less/quick") },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- deep links: quick-agent://task/<id>

function handleDeepLink(url) {
	const m = /^quick-agent:\/\/(?:task\/)?(t[0-9a-z]+)/i.exec(String(url || ""));
	if (m) openTask(m[1]);
	else if (/^quick-agent:\/\/(quick|new)\b/i.test(String(url || ""))) showQuick();
	else if (/^quick-agent:\/\/view\/(need|inflight|skim)\b/i.test(String(url || ""))) showView(/view\/(\w+)/.exec(url)[1]);
	else if (/^quick-agent:/.test(String(url || ""))) showWindow();
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.setName("quick-agent");
	app.on("second-instance", (_e, argv) => {
		const link = argv.find((a) => a.startsWith("quick-agent://"));
		if (link) handleDeepLink(link);
		else if (argv.includes("--quick")) showQuick(); // e.g. bind `open -a quick-agent --args --quick` in Raycast/Alfred
		else showWindow();
	});
	app.on("open-url", (e, url) => {
		e.preventDefault();
		app.whenReady().then(() => handleDeepLink(url));
	});
	if (!DEV) app.setAsDefaultProtocolClient("quick-agent");

	app.whenReady().then(async () => {
		loadSettings();
		fixPath();
		nativeTheme.themeSource = "system";
		// Only the permissions the UI needs (clipboard write for copy buttons); everything else is denied.
		session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "clipboard-sanitized-write"));
		buildMenu();
		createTray();
		registerShortcut();
		scheduleDigest();
		lastQuietMode = lib.quietMode(settings);
		setInterval(checkQuiet, 30000);
		createWindow();
		if (startHidden && IS_MAC) app.hide(); // hand focus back to whatever the user was doing
		await loadUi();
		// Watchdog: if the UI server dies (killed, `quick ui stop`), bring it back and reload.
		setInterval(async () => {
			if (!conn || quitting) return;
			if (!(await uiHealthy())) {
				log("web ui not responding, restarting");
				conn = undefined;
				loadUi();
			}
		}, 20000);
	});
	// macOS also emits `activate` when the app is launched; for a `--hidden` start ignore activations until the app
	// has been in the background once (a later Dock click then opens the window as usual).
	let ignoreActivate = startHidden;
	app.on("did-resign-active", () => (ignoreActivate = false));
	app.on("activate", () => {
		if (ignoreActivate) return;
		showWindow();
	});
	app.on("before-quit", () => {
		quitting = true;
	});
	app.on("will-quit", () => {
		globalShortcut.unregisterAll();
		hubAbort?.abort();
	});
	app.on("window-all-closed", () => {
		if (!IS_MAC) app.quit();
	});
	nativeTheme.on("updated", () => {
		if (win && !win.isDestroyed()) win.setBackgroundColor(bg());
	});
}
