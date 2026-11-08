// Desktop client self-update from GitHub Releases (no electron-updater: the app is ad-hoc signed and
// Squirrel.Mac refuses unsigned updates). Flow:
//   1. the hub already knows the latest release (GET /api/update → latest.assets)
//   2. pick quick-agent-<v>-<arch>-mac.zip (+ SHA256SUMS), download, verify sha256
//   3. unpack with ditto next to the running .app, then a detached shell script waits for this
//      process to exit, swaps the bundles (old one kept as <app>.prev until the new one launched) and
//      reopens the app.
// When the bundle is not writable (e.g. /Applications owned by root) or the zip is missing, the .dmg is
// downloaded to ~/Downloads and opened instead (drag the app into Applications).
"use strict";
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function cmp(a, b) {
	const p = (v) => String(v || "0").replace(/^v/, "").split("-")[0].split(".").map((x) => Number(x) || 0);
	const x = p(a), y = p(b);
	for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
	return 0;
}

/** What the latest release offers this client: undefined when it is not newer or has no mac build. */
function plan(latest, appVersion, arch = process.arch) {
	if (!latest || !latest.version || cmp(latest.version, appVersion) <= 0) return undefined;
	const assets = latest.assets || [];
	const v = latest.version;
	const zip = assets.find((a) => a.name === `quick-agent-${v}-${arch}-mac.zip`) || assets.find((a) => /-mac\.zip$/.test(a.name) && a.name.includes(arch));
	const dmg = assets.find((a) => a.name === `quick-agent-${v}-${arch}.dmg`) || assets.find((a) => a.name.endsWith(".dmg") && a.name.includes(arch));
	const sums = assets.find((a) => a.name === "SHA256SUMS");
	if (!zip && !dmg) return undefined;
	return { version: v, url: latest.url, zip, dmg, sums };
}

function parseSums(text) {
	const m = new Map();
	for (const line of String(text).split("\n")) {
		const x = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
		if (x) m.set(x[2], x[1].toLowerCase());
	}
	return m;
}

async function download(asset, file, onProgress) {
	const res = await fetch(asset.download, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
	if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} ${asset.name}`);
	const total = Number(res.headers.get("content-length")) || asset.size || 0;
	const hash = crypto.createHash("sha256");
	const out = fs.createWriteStream(file);
	let got = 0;
	for await (const chunk of res.body) {
		hash.update(chunk);
		got += chunk.length;
		if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
		onProgress?.(total ? got / total : 0);
	}
	await new Promise((r) => out.end(r));
	return hash.digest("hex");
}

async function verify(p, asset, sha) {
	if (!p.sums) throw new Error("Release 没有 SHA256SUMS，拒绝安装");
	const res = await fetch(p.sums.download, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
	const expected = parseSums(await res.text()).get(asset.name);
	if (!expected) throw new Error(`SHA256SUMS 里没有 ${asset.name}`);
	if (expected !== sha) throw new Error(`${asset.name} 校验失败`);
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5 * 60_000 }, (e, so, se) => (e ? reject(new Error(String(se || e.message).trim())) : resolve(so))));

/** /Applications/quick-agent.app (the bundle containing the running executable). */
function bundlePath(exe) {
	const i = exe.indexOf(".app/Contents/MacOS/");
	return i >= 0 ? exe.slice(0, i + 4) : undefined;
}

function writable(dir) {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Install `p` (from plan()). Returns { mode: "swap" } after scheduling the swap (the caller quits the app),
 * or { mode: "dmg", file } after opening the downloaded disk image.
 */
async function install(p, { exe, pid, onProgress, openPath, log = () => {} }) {
	const app = bundlePath(exe);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quick-agent-update-"));
	if (p.zip && app && writable(path.dirname(app)) && writable(app)) {
		const zip = path.join(tmp, p.zip.name);
		await verify(p, p.zip, await download(p.zip, zip, onProgress));
		const out = path.join(tmp, "x");
		fs.mkdirSync(out);
		await run("ditto", ["-x", "-k", zip, out]);
		const fresh = fs.readdirSync(out).find((d) => d.endsWith(".app"));
		if (!fresh) throw new Error("zip 里没有 .app");
		const staged = `${app}.new`;
		fs.rmSync(staged, { recursive: true, force: true });
		await run("ditto", [path.join(out, fresh), staged]);
		fs.rmSync(tmp, { recursive: true, force: true });
		// Swap after we exit; keep the old bundle until the new one is in place.
		const script = `
while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.3; done
rm -rf "${app}.prev"
mv "${app}" "${app}.prev" && mv "${staged}" "${app}" || { mv "${app}.prev" "${app}"; exit 1; }
xattr -dr com.apple.quarantine "${app}" 2>/dev/null
open "${app}" && rm -rf "${app}.prev"
`;
		spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
		log(`update ${p.version} staged at ${staged}, swapping after exit`);
		return { mode: "swap" };
	}
	if (!p.dmg) throw new Error("Release 没有可用的 .dmg，且无法原地替换应用");
	const file = path.join(os.homedir(), "Downloads", p.dmg.name);
	await verify(p, p.dmg, await download(p.dmg, file, onProgress));
	await openPath(file);
	return { mode: "dmg", file };
}

module.exports = { cmp, plan, parseSums, bundlePath, install };
