const $ = (id) => document.getElementById(id);
const DEFAULT_HUB = "http://127.0.0.1:7788";
const AUTO_ORIGINS = ["http://*/*", "https://*/*"];

function status(text, cls = "") {
	$("status").textContent = text;
	$("status").className = cls;
	$("dot").className = `dot ${cls}`;
}

async function send(msg) {
	try {
		return await chrome.runtime.sendMessage(msg);
	} catch (e) {
		return { ok: false, error: String(e?.message || e) };
	}
}

async function test() {
	status("连接中…");
	const r = await send({ type: "qa-health" });
	if (r?.ok) {
		const mid = typeof r.health.machine === "string" ? r.health.machine : r.health.machine?.id;
		const m = mid ? ` · ${mid}` : "";
		status(`已连接 hub（${r.health.tasks} 个任务${m}）`, "ok");
		showVersionHint(r.health.version);
	} else {
		status(r?.error || "连接失败", "err");
		$("settings").open = true;
	}
}

/** The hub was upgraded but this (unpacked) extension still runs older files: offer reload / download. */
function showVersionHint(hubVersion) {
	const mine = chrome.runtime.getManifest().version;
	const num = (v) => String(v || "0").split("-")[0].split(".").map((x) => Number(x) || 0);
	const older = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
	$("verHint")?.remove();
	if (!hubVersion || !older(mine, hubVersion)) return;
	const d = document.createElement("div");
	d.id = "verHint";
	d.className = "hint";
	d.style.cssText = "border:1px solid var(--line-2);padding:8px 10px";
	d.append(`插件 v${mine} 比 hub v${hubVersion} 旧。`);
	const reload = document.createElement("a");
	reload.textContent = "重新加载插件";
	reload.title = "从 ~/.quick-agent/app/current/browser 加载的插件，重新加载即是新版";
	reload.onclick = () => chrome.runtime.reload();
	const zip = document.createElement("a");
	zip.textContent = "下载新版 zip";
	zip.onclick = async () => {
		const { hubUrl } = await chrome.storage.local.get({ hubUrl: DEFAULT_HUB });
		chrome.tabs.create({ url: `${hubUrl.replace(/\/+$/, "")}/extension.zip` });
	};
	d.append(reload, " · ", zip);
	$("status").after(d);
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";

/** Render a Chrome shortcut string ("⌘⇧E" on mac, "Ctrl+Shift+E" elsewhere) as <kbd>s. */
function renderKeys(target, keys) {
	target.innerHTML = "";
	if (!keys) {
		target.textContent = "未设置";
		return;
	}
	const plus = keys.includes("+");
	const parts = plus ? keys.split("+") : [...keys];
	for (const k of parts) {
		const kbd = document.createElement("kbd");
		kbd.textContent = k;
		target.append(kbd);
	}
}

async function showShortcuts() {
	const cmds = await chrome.commands.getAll();
	const key = (n) => cmds.find((x) => x.name === n)?.shortcut || "";
	renderKeys($("kPick"), key("toggle-picker"));
	renderKeys($("kPopup"), key("_execute_action"));
	$("pickKey").textContent = key("toggle-picker") || "E";
}

// ---------------------------------------------------------------- send key (shared with content.js via chrome.storage)
async function showSendKey(v) {
	if (!v) v = (await chrome.storage.local.get({ sendKey: "enter" })).sendKey;
	for (const b of $("sendKey").querySelectorAll("button")) {
		b.classList.toggle("on", b.dataset.v === v);
		b.setAttribute("aria-checked", String(b.dataset.v === v));
	}
}
async function setSendKey(v) {
	await chrome.storage.local.set({ sendKey: v });
	showSendKey(v);
}
$("modOpt").textContent = `${MOD}${IS_MAC ? "" : "+"}Enter 发送`;
$("modOpt").title = `${MOD}+Enter 发送，Enter 换行`;
$("sendKey").addEventListener("click", (e) => {
	const v = e.target.closest("button")?.dataset.v;
	if (v) setSendKey(v);
});

async function init() {
	const s = await chrome.storage.local.get({ hubUrl: DEFAULT_HUB, token: "" });
	$("hubUrl").value = s.hubUrl;
	$("token").value = s.token;
	$("auto").checked = await chrome.permissions.contains({ origins: AUTO_ORIGINS });
	showShortcuts();
	showSendKey();
	if (s.token) test();
	else {
		status("还没配置：填写 Hub 地址和 Token 后点「保存并测试」", "err");
		$("settings").open = true;
	}
}

$("save").onclick = async () => {
	let hubUrl = $("hubUrl").value.trim() || DEFAULT_HUB;
	if (!/^https?:\/\//i.test(hubUrl)) hubUrl = `http://${hubUrl}`;
	$("hubUrl").value = hubUrl;
	await chrome.storage.local.set({ hubUrl, token: $("token").value.trim() });
	test();
};
async function pick() {
	$("pickErr").style.display = "none";
	const r = await send({ type: "qa-toggle-active" });
	if (r?.ok) return window.close();
	$("pickErr").textContent = r?.error || "无法在此页面运行";
	$("pickErr").style.display = "block";
}
$("pick").onclick = pick;
$("dash").onclick = () => send({ type: "qa-open-dashboard" });
$("shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
$("auto").onchange = async (e) => {
	// permissions.request must run directly in the click handler (user gesture).
	// The background also listens to permissions.onAdded/onRemoved, so this works even if the
	// popup closes while Chrome shows the permission prompt.
	if (e.target.checked) e.target.checked = await chrome.permissions.request({ origins: AUTO_ORIGINS });
	else await chrome.permissions.remove({ origins: AUTO_ORIGINS });
	await send({ type: "qa-auto-sync" });
};

// Popup keys (only when not typing in a field): E/Enter pick, D dashboard, "," settings, M send key.
document.addEventListener("keydown", async (e) => {
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
	if (typing) {
		if (e.key === "Enter" && e.target.closest("#settings")) {
			e.preventDefault();
			$("save").click();
		}
		return;
	}
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	const k = e.key.toLowerCase();
	if (k === "e" || (k === "enter" && document.activeElement === document.body)) {
		e.preventDefault();
		pick();
	} else if (k === "d") {
		e.preventDefault();
		$("dash").click();
	} else if (k === ",") {
		e.preventDefault();
		$("settings").open = !$("settings").open;
		if ($("settings").open) $("hubUrl").focus();
	} else if (k === "m") {
		e.preventDefault();
		const cur = (await chrome.storage.local.get({ sendKey: "enter" })).sendKey;
		setSendKey(cur === "enter" ? "mod" : "enter");
	}
});

init();
