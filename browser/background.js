// quick-agent browser extension — service worker.
// Talks to the hub (through an ssh port-forward), captures and crops screenshots.

const DEFAULTS = { hubUrl: "http://127.0.0.1:7788", token: "" };

async function settings() {
	const s = await chrome.storage.local.get(DEFAULTS);
	return { hubUrl: String(s.hubUrl || DEFAULTS.hubUrl).replace(/\/+$/, ""), token: String(s.token || "") };
}

async function hub(method, path, body) {
	const { hubUrl, token } = await settings();
	if (!token) throw new Error("未配置 token：点击插件图标填写 Hub 地址和 Token");
	let res;
	try {
		res = await fetch(hubUrl + path, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch (e) {
		throw new Error(`连不上 hub (${hubUrl})。ssh 端口转发开着吗？ ${e.message}`);
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

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
	fctx.strokeStyle = "#ff2d55";
	fctx.lineWidth = 3;
	for (const b of boxes) fctx.strokeRect(b.x * scale * fs, b.y * scale * fs, b.width * scale * fs, b.height * scale * fs);
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

// ---------------------------------------------------------------- messaging

async function togglePicker(tab) {
	if (!tab?.id) return;
	try {
		await chrome.tabs.sendMessage(tab.id, { type: "qa-toggle" });
	} catch {
		// Content script not present (page loaded before install, or restricted page): inject it.
		try {
			await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
			await chrome.tabs.sendMessage(tab.id, { type: "qa-toggle" });
		} catch (e) {
			console.warn("quick-agent: cannot run on this page", e);
		}
	}
}

chrome.commands.onCommand.addListener(async (command, tab) => {
	if (command === "toggle-picker") togglePicker(tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	(async () => {
		switch (msg.type) {
			case "qa-submit": {
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
				return { ok: true, intake: r.intake };
			}
			case "qa-page-comments": {
				const r = await hub("GET", `/api/pages?url=${encodeURIComponent(msg.url)}`);
				return { ok: true, comments: r.comments };
			}
			case "qa-health": {
				const { hubUrl } = await settings();
				const h = await fetch(`${hubUrl}/health`).then((r) => r.json());
				await hub("GET", "/api/tasks");
				return { ok: true, health: h };
			}
			case "qa-toggle-active": {
				const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
				await togglePicker(tab);
				return { ok: true };
			}
			case "qa-open-dashboard": {
				const { hubUrl, token } = await settings();
				await chrome.tabs.create({ url: `${hubUrl}/?token=${encodeURIComponent(token)}` });
				return { ok: true };
			}
		}
		return { ok: false, error: `unknown message ${msg.type}` };
	})()
		.then(sendResponse)
		.catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
	return true; // async response
});
