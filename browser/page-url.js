// GENERATED from shared/page-url.mjs by scripts/sync-shared.mjs. Do not edit.
// Loaded before content.js (same isolated world).
(() => {
// Page identity for browser comments: which comments belong to "this page".
// SINGLE SOURCE used by the hub (GET /api/pages) and, via scripts/sync-shared.mjs, by the
// browser extension (browser/page-url.js -> content.js). Plain JS so both can load it.
//
// Two URLs are the same page when they only differ in:
//   - scheme/host case, default port, duplicate or trailing slashes ("/a/" == "/a", "/" kept)
//   - query parameter order, tracking parameters (utm_*, fbclid, gclid, …)
//   - a plain in-page anchor ("#section")
// They are DIFFERENT pages when the path, a real query parameter or a hash ROUTE
// ("#/users", "#!/users") differs: SPAs with hash routing render distinct screens there.
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid|spm|scm)$/i;
function pageKey(raw) {
	let u;
	try {
		u = new URL(String(raw ?? ""));
	} catch {
		return String(raw ?? "").split("#")[0];
	}
	if (!/^https?:$/.test(u.protocol)) return u.href.split("#")[0];
	let path = u.pathname.replace(/\/{2,}/g, "/");
	if (path.length > 1) path = path.replace(/\/+$/, "");
	const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const query = params.length ? `?${new URLSearchParams(params)}` : "";
	const route = /^#!?\/./.test(u.hash) ? u.hash.replace(/\/+$/, "") : ""; // "#/" alone is the root route
	return `${u.protocol}//${u.host.toLowerCase()}${path}${query}${route}`;
}
globalThis.__qaPageKey = pageKey;
})();
