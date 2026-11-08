// Runs in the page's MAIN world at document_start: records console errors and uncaught
// exceptions so a comment can carry them. Answers requests from content.js via postMessage.
(() => {
	if (window.__qaConsoleHook) return;
	window.__qaConsoleHook = true;
	const buf = [];
	const push = (s) => {
		buf.push(`${new Date().toISOString().slice(11, 19)} ${String(s).slice(0, 500)}`);
		if (buf.length > 50) buf.shift();
	};
	const fmt = (a) => {
		if (a instanceof Error) return `${a.name}: ${a.message}`;
		if (typeof a === "object") {
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		}
		return String(a);
	};
	const origError = console.error;
	console.error = function (...args) {
		push(`console.error ${args.map(fmt).join(" ")}`);
		return origError.apply(this, args);
	};
	window.addEventListener("error", (e) => push(`uncaught ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
	window.addEventListener("unhandledrejection", (e) => push(`unhandledrejection ${fmt(e.reason)}`));
	// SPA route changes (history.pushState/replaceState) are invisible to the isolated content script:
	// announce them with a DOM event, which crosses worlds. content.js also polls location as a fallback.
	for (const k of ["pushState", "replaceState"]) {
		const orig = history[k];
		if (typeof orig !== "function") continue;
		history[k] = function (...args) {
			const r = orig.apply(this, args);
			try {
				window.dispatchEvent(new Event("qa:locationchange"));
			} catch {}
			return r;
		};
	}
	window.addEventListener("message", (e) => {
		if (e.source === window && e.data && e.data.__qa === "get-errors") {
			window.postMessage({ __qa: "errors", errors: buf.slice() }, "*");
		}
	});
})();
