// quick-agent browser extension — service worker.
// Talks to the user's own quick-agent hub (default http://127.0.0.1:7788), injects the picker
// on demand (activeTab), captures and crops screenshots. No remote code, no analytics.

const DEFAULTS = { hubUrl: "http://127.0.0.1:7788", token: "" };
// Optional: run the content scripts on every page so comment pins show up automatically and
// console errors are recorded from page load. Only active if the user grants it in the popup.
const AUTO_ORIGINS = ["http://*/*", "https://*/*"];
const AUTO_SCRIPTS = [
	{ id: "qa-console-hook", js: ["console-hook.js"], matches: AUTO_ORIGINS, runAt: "document_start", world: "MAIN", allFrames: false },
	{ id: "qa-content", js: ["content.js"], matches: AUTO_ORIGINS, runAt: "document_idle", allFrames: false },
];

async function settings() {
	const s = await chrome.storage.local.get(DEFAULTS);
	return { hubUrl: String(s.hubUrl || DEFAULTS.hubUrl).trim().replace(/\/+$/, ""), token: String(s.token || "").trim() };
}

class HubError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code; // "no-token" | "unreachable" | "auth" | "http"
	}
}

async function hub(method, path, body) {
	const { hubUrl, token } = await settings();
	if (!token) throw new HubError("还没配置 Token：点击工具栏里的 quick-agent 图标，填写 Hub 地址和 Token", "no-token");
	let res;
	try {
		res = await fetch(hubUrl + path, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch {
		throw new HubError(`连不上 hub（${hubUrl}）。请确认 hub 已启动（quick hub start），或 ssh 端口转发已开启。`, "unreachable");
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) throw new HubError("Token 不对：在 hub 所在机器运行 quick token 获取正确的 Token", "auth");
	if (!res.ok) throw new HubError(data.error || `hub 返回 HTTP ${res.status}`, "http");
	return data;
}

// ---------------------------------------------------------------- toolbar badge

async function setBadge(text, color, title) {
	try {
		await chrome.action.setBadgeText({ text });
		if (color) await chrome.action.setBadgeBackgroundColor({ color });
		await chrome.action.setTitle({ title: title ? `quick-agent — ${title}` : "quick-agent" });
	} catch {}
}
const markOk = () => setBadge("", null, "");
const markErr = (e) => setBadge("!", "#ff3b30", String(e?.message || e));

// ---------------------------------------------------------------- screenshots

function bufToBase64(buf) {
	const bytes = new Uint8Array(buf);
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
async function blobToDataUrl(blob) {
	return `data:${blob.type};base64,${bufToBase64(await blob.arrayBuffer())}`;
}

/**
 * Capture the visible tab and return [annotated full viewport (jpeg), crop around selection (png)].
 * `boxes` are viewport CSS-pixel rects to outline; `focus` is the union rect to crop.
 */
async function captureShots(windowId, boxes, focus, dpr) {
	const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
	const scale = bmp.width / Math.max(1, focus.viewportWidth || bmp.width / dpr);
	const shots = [];

	// Full viewport with red outlines, downscaled to max 1600px wide.
	const fw = Math.min(1600, bmp.width);
	const fs = fw / bmp.width;
	const full = new OffscreenCanvas(fw, Math.round(bmp.height * fs));
	const fctx = full.getContext("2d");
	fctx.drawImage(bmp, 0, 0, full.width, full.height);
	fctx.strokeStyle = "#ff3b30";
	fctx.lineWidth = 3;
	for (const b of boxes || []) fctx.strokeRect(b.x * scale * fs, b.y * scale * fs, b.width * scale * fs, b.height * scale * fs);
	shots.push({ name: "viewport", dataUrl: await blobToDataUrl(await full.convertToBlob({ type: "image/jpeg", quality: 0.85 })) });

	// Crop around the selection with padding.
	const pad = 24;
	const sx = Math.max(0, Math.floor((focus.x - pad) * scale));
	const sy = Math.max(0, Math.floor((focus.y - pad) * scale));
	const sw = Math.min(bmp.width - sx, Math.ceil((focus.width + pad * 2) * scale));
	const sh = Math.min(bmp.height - sy, Math.ceil((focus.height + pad * 2) * scale));
	if (sw > 4 && sh > 4) {
		const crop = new OffscreenCanvas(sw, sh);
		crop.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
		shots.push({ name: "selection", dataUrl: await blobToDataUrl(await crop.convertToBlob({ type: "image/png" })) });
	}
	return shots;
}

// ---------------------------------------------------------------- picker injection

const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/;

/** Make sure our content scripts are in the tab (activeTab grants this after a user gesture). */
async function ensureInjected(tabId) {
	try {
		const r = await chrome.tabs.sendMessage(tabId, { type: "qa-ping" });
		if (r?.ok) return;
	} catch {}
	// Console hook first (MAIN world) so errors from now on are recorded, then the picker UI.
	await chrome.scripting.executeScript({ target: { tabId }, files: ["console-hook.js"], world: "MAIN" }).catch(() => {});
	await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

/** Toggle the picker in a tab. Returns { ok, active } or throws a user-readable error. */
async function togglePicker(tab) {
	if (!tab?.id) throw new Error("没有可用的标签页");
	if (tab.url && RESTRICTED.test(tab.url)) throw new Error("浏览器内置页面和扩展商店页面不允许插件运行，请在普通网页上使用");
	try {
		await ensureInjected(tab.id);
		return await chrome.tabs.sendMessage(tab.id, { type: "qa-toggle" });
	} catch (e) {
		throw new Error(`无法在此页面运行：${e?.message || e}`);
	}
}

chrome.commands.onCommand.addListener(async (command, tab) => {
	if (command !== "toggle-picker") return;
	try {
		tab = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
		await togglePicker(tab);
	} catch (e) {
		// No UI to show the error in from a shortcut: flag it on the toolbar icon instead.
		markErr(e);
	}
});

// ---------------------------------------------------------------- optional "all sites" mode

async function syncAutoScripts() {
	const granted = await chrome.permissions.contains({ origins: AUTO_ORIGINS });
	const existing = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);
	const ours = AUTO_SCRIPTS.map((s) => s.id).filter((id) => existing.includes(id));
	if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
	if (granted) await chrome.scripting.registerContentScripts(AUTO_SCRIPTS);
	return granted;
}
chrome.runtime.onInstalled.addListener(() => syncAutoScripts().catch(console.warn));
chrome.runtime.onStartup.addListener(() => syncAutoScripts().catch(console.warn));
chrome.permissions.onAdded.addListener(() => syncAutoScripts().catch(console.warn));
chrome.permissions.onRemoved.addListener(() => syncAutoScripts().catch(console.warn));

// ---------------------------------------------------------------- messaging

const handlers = {
	async "qa-submit"(msg, sender) {
		const p = msg.payload;
		if (msg.withScreenshot !== false) {
			try {
				p.screenshots = await captureShots(sender.tab.windowId, msg.boxes, msg.focus, p.viewport?.dpr || 1);
			} catch (e) {
				p.screenshots = [];
				p.screenshotError = String(e?.message || e);
			}
		}
		const r = await hub("POST", "/api/intake", p);
		markOk();
		return { intake: r.intake };
	},
	async "qa-page-comments"(msg) {
		const r = await hub("GET", `/api/pages?url=${encodeURIComponent(msg.url)}`);
		return { comments: r.comments };
	},
	async "qa-health"() {
		const { hubUrl } = await settings();
		let h;
		try {
			h = await fetch(`${hubUrl}/health`).then((r) => r.json());
		} catch {
			throw new HubError(`连不上 hub（${hubUrl}）。请确认 hub 已启动（quick hub start），或 ssh 端口转发已开启。`, "unreachable");
		}
		await hub("GET", "/api/tasks");
		markOk();
		return { health: h };
	},
	async "qa-toggle-active"() {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		const r = await togglePicker(tab);
		return { active: r?.active };
	},
	async "qa-open-dashboard"() {
		const { hubUrl, token } = await settings();
		await chrome.tabs.create({ url: `${hubUrl}/?token=${encodeURIComponent(token)}` });
		return {};
	},
	async "qa-auto-sync"() {
		return { granted: await syncAutoScripts() };
	},
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	// Only accept messages from our own extension pages / content scripts.
	if (sender.id !== chrome.runtime.id) return false;
	const h = handlers[msg?.type];
	if (!h) return false;
	h(msg, sender)
		.then((r) => sendResponse({ ok: true, ...r }))
		.catch((e) => sendResponse({ ok: false, error: String(e?.message || e), code: e?.code }));
	return true; // async response
});
