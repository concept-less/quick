// Tests for shared/update.ts: version compare, release lookup + cache, install kinds,
// download → verify → atomic switch, rollback, prune, lock.
// Run: npm test   (temp dirs + a local HTTP server that mimics the GitHub API; no network, no real hub)
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "qa-update-test-"));
process.env.QA_HOME = join(TMP, "home");
for (const k of ["QA_UPDATE_ROOT", "QA_INSTALL_KIND", "QA_APP_DIR", "QA_UPDATE", "QA_NO_UPDATE", "QA_UPDATE_AUTO_INSTALL", "QA_UPDATE_CACHE_MINUTES", "GITHUB_TOKEN", "GH_TOKEN", "QA_GITHUB_REPO"]) delete process.env[k];

let server: Server;
let base = "";
const mock = { release: 404 as number | object, hits: 0, files: new Map<string, Buffer>() };
before(async () => {
	server = createServer((req, res) => {
		if (req.url === "/gh/repos/concept-less/quick/releases/latest") {
			mock.hits++;
			if (typeof mock.release === "number") return res.writeHead(mock.release).end("{}");
			return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mock.release));
		}
		const f = mock.files.get(req.url ?? "");
		if (f) return res.writeHead(200, { "content-length": f.length }).end(f);
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	process.env.QA_GITHUB_API = `${base}/gh`;
});
after(() => {
	server.close();
	rmSync(TMP, { recursive: true, force: true });
});

const U = await import("../shared/update.ts");
const { loadConfig, paths } = await import("../shared/config.ts");
const APP = paths.app;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** A release tarball like `npm pack` makes (package/…), registered on the mock server. */
function tarball(version: string, opts: { name?: string; pkgVersion?: string } = {}): Buffer {
	const dir = mkdtempSync(join(TMP, "pkg-"));
	mkdirSync(join(dir, "package", "bin"), { recursive: true });
	writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ name: opts.name ?? "quick-agent", version: opts.pkgVersion ?? version }));
	writeFileSync(join(dir, "package", "bin", "quick"), "#!/bin/sh\n");
	const file = join(dir, "x.tgz");
	execFileSync("tar", ["-czf", file, "-C", dir, "package"]);
	return readFileSync(file);
}
/** Publish a fake release vX on the mock GitHub API. */
function release(version: string, opts: { sums?: "ok" | "bad" | "none"; tgz?: Buffer; notes?: string } = {}) {
	const name = `quick-agent-${version}.tgz`;
	const tgz = opts.tgz ?? tarball(version);
	mock.files.set(`/dl/v${version}/${name}`, tgz);
	const assets: any[] = [{ name, browser_download_url: `${base}/dl/v${version}/${name}`, size: tgz.length }];
	if ((opts.sums ?? "ok") !== "none") {
		const h = opts.sums === "bad" ? "0".repeat(64) : sha(tgz);
		mock.files.set(`/dl/v${version}/SHA256SUMS`, Buffer.from(`${h}  ${name}\n${"1".repeat(64)}  quick-agent-extension-${version}-chrome.zip\n`));
		assets.push({ name: "SHA256SUMS", browser_download_url: `${base}/dl/v${version}/SHA256SUMS` });
	}
	mock.release = { tag_name: `v${version}`, name: `quick-agent v${version}`, body: opts.notes ?? `notes for ${version}`, html_url: `https://github.com/concept-less/quick/releases/tag/v${version}`, assets };
	rmSync(U.STATE_PATH, { force: true }); // drop the cache
}
/** Pretend `version` was installed by install.sh: app/<version> + current link. */
function installFake(version: string) {
	mkdirSync(join(APP, version, "bin"), { recursive: true });
	writeFileSync(join(APP, version, "package.json"), JSON.stringify({ name: "quick-agent", version }));
	U.switchTo(version);
	process.env.QA_UPDATE_ROOT = join(APP, version);
}
const link = (n: string) => readlinkSync(join(APP, n));

// ---------------------------------------------------------------- tests

describe("compareVersions", () => {
	test("orders semver incl. prereleases and v prefix", () => {
		assert.equal(U.compareVersions("0.4.0", "0.3.9"), 1);
		assert.equal(U.compareVersions("v1.0.0", "1.0.0"), 0);
		assert.equal(U.compareVersions("1.0.0-beta.2", "1.0.0"), -1);
		assert.equal(U.compareVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
		assert.equal(U.compareVersions("0.10.0", "0.9.0"), 1);
		assert.equal(U.compareVersions("0.3.0", "0.4.0"), -1);
	});
	test("parseSums reads sha256sum output", () => {
		const m = U.parseSums(`${"a".repeat(64)}  quick-agent-1.0.0.tgz\n${"B".repeat(64)} *x.zip\ngarbage\n`);
		assert.equal(m.get("quick-agent-1.0.0.tgz"), "a".repeat(64));
		assert.equal(m.get("x.zip"), "b".repeat(64));
		assert.equal(m.size, 2);
	});
});

describe("config", () => {
	test("defaults and env overrides", () => {
		const u = loadConfig().update;
		assert.equal(u.enabled, true);
		assert.equal(u.autoInstall, false, "auto-install is opt-in");
		assert.equal(u.cacheMinutes, 10);
		assert.equal(u.restartHub, "auto");
		assert.equal(u.githubRepo, "concept-less/quick");
		process.env.QA_UPDATE = "off";
		process.env.QA_UPDATE_AUTO_INSTALL = "1";
		try {
			assert.equal(loadConfig().update.enabled, false);
			assert.equal(loadConfig().update.autoInstall, true);
		} finally {
			delete process.env.QA_UPDATE;
			delete process.env.QA_UPDATE_AUTO_INSTALL;
		}
	});
});

describe("install kinds", () => {
	test("git checkout = dev, app dir = release, else unmanaged", () => {
		const dev = join(TMP, "devcopy");
		mkdirSync(join(dev, ".git"), { recursive: true });
		assert.equal(U.detectInstall(dev), "dev");
		const loose = join(TMP, "loose");
		mkdirSync(loose);
		assert.equal(U.detectInstall(loose), "unmanaged");
		mkdirSync(join(APP, "0.0.1"), { recursive: true });
		assert.equal(U.detectInstall(join(APP, "0.0.1")), "release");
		rmSync(join(APP, "0.0.1"), { recursive: true });
	});
});

describe("release lookup + cache", () => {
	test("reads the latest release and caches it (TTL)", async () => {
		release("0.4.0", { notes: "hello" });
		const s = loadConfig().update;
		mock.hits = 0;
		const a = await U.getLatest(s, { kind: "release" });
		assert.equal(a.latest?.version, "0.4.0");
		assert.equal(a.latest?.notes, "hello");
		assert.equal(a.cached, false);
		const b = await U.getLatest(s, { kind: "release" });
		assert.equal(b.cached, true);
		assert.equal(mock.hits, 1, "second lookup served from update.json");
		// Expired cache → network again.
		U.patchState({ checkedAt: Date.now() - 11 * 60_000 });
		await U.getLatest(s, { kind: "release" });
		assert.equal(mock.hits, 2);
		await U.getLatest(s, { kind: "release", maxAgeMs: 0 });
		assert.equal(mock.hits, 3, "maxAgeMs 0 = refresh");
	});
	test("failure keeps the last good answer and is cached too", async () => {
		mock.release = 500;
		mock.hits = 0;
		const s = loadConfig().update;
		const r = await U.getLatest(s, { kind: "release", maxAgeMs: 0 });
		assert.match(r.error ?? "", /HTTP 500/);
		assert.equal(r.latest?.version, "0.4.0", "stale latest still reported");
		await U.getLatest(s, { kind: "release" });
		assert.equal(mock.hits, 1, "errors are cached as well (no hammering)");
	});
	test("a release with a non-version tag is rejected", async () => {
		mock.release = { tag_name: "nightly", assets: [] };
		const r = await U.getLatest(loadConfig().update, { kind: "release", maxAgeMs: 0 });
		assert.match(r.error ?? "", /not a version/);
	});
	test("dev checkouts only get a hint", async () => {
		release("9.0.0");
		process.env.QA_UPDATE_ROOT = join(TMP, "devcopy");
		writeFileSync(join(TMP, "devcopy", "package.json"), JSON.stringify({ name: "quick-agent", version: "0.3.0" }));
		const st = await U.updateStatus();
		assert.equal(st.kind, "dev");
		assert.equal(st.available, true);
		assert.equal(st.canInstall, false);
		assert.match(st.blocker!, /开发模式/);
		assert.match(U.hintLine(st)!, /new version v9\.0\.0 available \(dev checkout/);
		const r = await U.runUpgrade();
		assert.equal(r.ok, false);
		assert.equal(r.installed, false);
		delete process.env.QA_UPDATE_ROOT;
	});
});

describe("release install: download → verify → atomic switch → rollback", () => {
	test("status of a release install", async () => {
		installFake("0.3.0");
		release("0.4.0");
		const st = await U.updateStatus();
		assert.equal(st.kind, "release");
		assert.equal(st.installed, "0.3.0");
		assert.equal(st.available, true);
		assert.equal(st.canInstall, true);
		assert.equal(U.hintLine(st), "new version v0.4.0 available: quick upgrade");
	});
	test("checksum mismatch: nothing changes", async () => {
		release("0.4.0", { sums: "bad" });
		const r = await U.runUpgrade();
		assert.equal(r.ok, false);
		assert.match(r.error!, /checksum mismatch/);
		assert.equal(link("current"), "0.3.0");
		assert.ok(!existsSync(join(APP, "0.4.0")));
		assert.deepEqual(U.listVersions(), ["0.3.0"]);
	});
	test("missing SHA256SUMS blocks the install", async () => {
		release("0.4.0", { sums: "none" });
		const st = await U.updateStatus();
		assert.equal(st.canInstall, false);
		assert.match(st.blocker!, /SHA256SUMS/);
	});
	test("archive with the wrong version / package is refused", async () => {
		release("0.4.0", { tgz: tarball("0.4.0", { pkgVersion: "0.3.5" }) });
		assert.match((await U.runUpgrade()).error!, /version 0\.3\.5, expected 0\.4\.0/);
		release("0.4.0", { tgz: tarball("0.4.0", { name: "evil" }) });
		assert.match((await U.runUpgrade()).error!, /contains evil/);
		assert.equal(link("current"), "0.3.0");
	});
	test("check-only does not install", async () => {
		release("0.4.0");
		const r = await U.runUpgrade({ check: true });
		assert.equal(r.ok, true);
		assert.equal(r.available, true);
		assert.equal(r.installed, false);
		assert.equal(r.latest, "0.4.0");
		assert.equal(link("current"), "0.3.0");
	});
	test("installs, switches current, keeps previous, reports progress", async () => {
		release("0.4.0");
		const steps: string[] = [];
		const r = await U.runUpgrade({ onProgress: (p) => steps.at(-1) !== p.step && steps.push(p.step) });
		assert.equal(r.ok, true, r.error);
		assert.equal(r.installed, true);
		assert.equal(r.from, "0.3.0");
		assert.equal(r.to, "0.4.0");
		assert.deepEqual(steps, ["check", "download", "verify", "switch"]);
		assert.equal(link("current"), "0.4.0");
		assert.equal(link("previous"), "0.3.0");
		assert.equal(U.readVersion(U.activeRoot()), "0.4.0", "a restart would run 0.4.0");
		assert.equal(U.readState().installed?.to, "0.4.0");
		assert.ok(!readFileSync(join(APP, "0.4.0", "package.json"), "utf8").includes("0.3.0"));
		assert.deepEqual(readdirSync(APP).filter((n) => n.startsWith(".")), [], "temp dirs / links cleaned up");
		// Up to date now.
		const again = await U.runUpgrade();
		assert.equal(again.available, false);
		assert.equal(again.installed, false);
	});
	test("rollback swaps current and previous (and back)", async () => {
		const r = await U.runUpgrade({ rollback: true });
		assert.equal(r.ok, true, r.error);
		assert.equal(r.to, "0.3.0");
		assert.equal(link("current"), "0.3.0");
		assert.equal(link("previous"), "0.4.0");
		const st = await U.updateStatus();
		assert.equal(st.previous, "0.4.0");
		assert.equal(st.available, true, "0.4.0 is offered again");
		U.rollback();
		assert.equal(link("current"), "0.4.0");
	});
	test("old versions are pruned (current + previous + 1 kept)", async () => {
		for (const v of ["0.5.0", "0.6.0", "0.7.0"]) {
			release(v);
			const r = await U.runUpgrade();
			assert.equal(r.to, v, r.error);
		}
		assert.deepEqual(U.listVersions(), ["0.5.0", "0.6.0", "0.7.0"]);
		assert.equal(link("previous"), "0.6.0");
	});
	test("rollback without previous fails cleanly", () => {
		rmSync(join(APP, "previous"));
		assert.throws(() => U.rollback(), /没有可回滚/);
	});
});

describe("lock", () => {
	test("only one upgrade at a time; stale locks are taken over", () => {
		const release = U.acquireLock();
		assert.ok(release);
		assert.equal(U.acquireLock(), undefined);
		release!();
		writeFileSync(join(paths.home, "update.lock"), JSON.stringify({ pid: 999999, at: Date.now() }));
		const r2 = U.acquireLock();
		assert.ok(r2, "dead pid → stale");
		r2!();
	});
});
