// Preload for the quick-dispatch window (local file, sandboxed). Text goes to the main process, which talks to
// the Web UI / hub with the token; the page itself never sees credentials.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

let onShow = null;
let last = null;
ipcRenderer.on("quick:show", (_e, info) => {
	last = info;
	if (onShow) onShow(info);
});
contextBridge.exposeInMainWorld("quickInput", {
	submit: (text, mode, open) => ipcRenderer.invoke("quick:submit", { text: String(text ?? ""), mode: mode === "direct" ? "direct" : "front", open: !!open }),
	hide: () => ipcRenderer.send("quick:hide"),
	onShow: (cb) => {
		if (typeof cb !== "function") return;
		onShow = cb;
		if (last) cb(last);
	},
});
