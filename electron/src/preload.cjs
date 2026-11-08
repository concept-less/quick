// Preload for the main window. Sandboxed + context-isolated: exposes a tiny, explicit bridge
// (window.quickDesktop) and only on the trusted pages — the local Web UI origin and our own status page.
// No token, no Node APIs and no raw ipcRenderer ever reach the page.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const trusted = (() => {
	try {
		const { protocol, hostname, pathname } = window.location;
		if (protocol === "file:") return pathname.endsWith("/status.html");
		return protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost");
	} catch {
		return false;
	}
})();

if (trusted) {
	// Messages that arrive before any handler exists are buffered (cold start, reloads).
	// Handlers registered by the Web UI itself win; `fallback` handlers are the client's defaults (main.cjs glue).
	const CH = ["qa:open-task", "qa:view", "qa:action"];
	const handlers = {};
	const fallbacks = {};
	const queued = Object.fromEntries(CH.map((c) => [c, []]));
	const handler = (ch) => handlers[ch] || fallbacks[ch];
	for (const ch of CH) {
		ipcRenderer.on(ch, (_e, arg) => {
			if (typeof arg !== "string" || arg.length > 200) return;
			const h = handler(ch);
			if (h) h(arg);
			else queued[ch].push(arg);
		});
	}
	const register = (table, ch, cb) => {
		if (!CH.includes(ch) || typeof cb !== "function") return;
		table[ch] = cb;
		for (const a of queued[ch].splice(0)) handler(ch)(a);
	};
	const on = (ch) => (cb) => register(handlers, ch, cb);
	contextBridge.exposeInMainWorld("quickDesktop", {
		platform: process.platform,
		onOpenTask: on("qa:open-task"),
		/** v: "need" (需要你) | "skim" (待扫) | "snoozed" (稍后) | "inflight" (不用管) */
		onView: on("qa:view"),
		onAction: on("qa:action"),
		fallback: (ch, cb) => register(fallbacks, ch, cb),
		retry: () => ipcRenderer.send("qa:retry"),
		/** Version of the desktop client; updateApp() downloads the newer macOS build from the release and swaps it in. */
		appVersion: (process.argv.find((a) => a.startsWith("--qa-app-version=")) || "").split("=")[1] || undefined,
		updateApp: () => ipcRenderer.send("qa:update-app"),
		openInBrowser: () => ipcRenderer.send("qa:open-external-ui"),
	});
}
