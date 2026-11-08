// Page identity for browser comments: which comments belong to "this page".
// Keep in sync with pageKey() in browser/content.js (test/page-url.test.ts checks both).
//
// Rules (chosen so a comment never shows up on an unrelated page, while cosmetic URL noise
// does not hide it):
// - the #fragment is dropped (in-page anchors are the same page) unless it is a hash route
//   (#/… or #!/…, used by hash-routed SPAs), which is kept; "#/" alone counts as no route
// - query parameters are significant (?id=1 vs ?id=2 are different records), except
//   well-known tracking params (utm_*, fbclid, gclid, …); remaining params are sorted
// - a trailing slash on the path is ignored (/a/ == /a); host is case-insensitive
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|spm)$/i;

export function pageKey(href: string): string {
	let u: URL;
	try {
		u = new URL(href);
	} catch {
		return String(href || "").split("#")[0]!;
	}
	const route = /^#!?\//.test(u.hash) && !/^#!?\/?$/.test(u.hash) ? u.hash.replace(/\/+$/, "") : "";
	const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const q = params.length ? `?${new URLSearchParams(params)}` : "";
	const path = u.pathname.replace(/\/+$/, "") || "/";
	return `${u.protocol}//${u.host.toLowerCase()}${path}${q}${route}`;
}
