// Tests for shared/update.ts: version sources (npm → GitHub → git), install kinds, state/lock.
// Run: node --test test/   (everything happens in temp dirs; no network, no real hub)
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "qa-update-test-"));
process.env.QA_HOME = join(TMP, "home");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GITHUB_TOKEN: "test-token" });
delete process.env.QA_UPDATE_ROOT;
delete process.env.QA_INSTALL_KIND;

const U = await import("../shared/update.ts");
const { loadConfig } = await import("../shared/config.ts");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const pkg = (version: string) => `${JSON.stringify({ name: "quick-agent", version, repository: { url: "git+ssh://git@github.com/concept-less/quick.git" } }, null, 2)}\n`;

/** A bare "origin" with version 0.3.0 tagged, and a clone of it. */
function gitFixture(name: string) {
	const origin = join(TMP, `${name}-origin.git`);
	const seed = join(TMP, `${name}-seed`);
	const clone = join(TMP, `${name}-clone`);
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "-q", origin, seed], { stdio: "pipe" });
	writeFileSync(join(seed, "package.json"), pkg("0.3.0"));
	sh(seed, "add", ".");
	sh(seed, "commit", "-qm", "v0.3.0");
	sh(seed, "tag", "v0.3.0");
	sh(seed, "push", "-q", "origin", "main", "--tags");
	execFileSync("git", ["clone", "-q", origin, clone], { stdio: "pipe" });
	const release = (version: string) => {
		writeFileSync(join(seed, "package.json"), pkg(version));
		sh(seed, "commit", "-qam", `v${version}`);
		sh(seed, "tag", `v${version}`);
		sh(seed, "push", "-q", "origin", "main", "--tags");
	};
	return { origin, seed, clone, release };
}

// ---------------------------------------------------------------- mock npm registry + GitHub API

let server: Server;
let base = "";
const mock = { npm: 404 as number | object, github: 404 as number | object, files: new Map<string, Buffer>() };
before(async () => {
	server = createServer((req, res) => {
		const reply = (v: number | object) => {
			if (typeof v === "number") return res.writeHead(v).end("{}");
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
		};
		if (req.url?.startsWith("/npm/")) return reply(mock.npm);
		if (req.url?.startsWith("/gh/repos/")) {
			if (req.headers.authorization !== "Bearer test-token") return reply(401);
			return reply(mock.github);
		}
		const f = mock.files.get(req.url ?? "");
		if (f) return res.writeHead(200).end(f);
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
	server.close();
	rmSync(TMP, { recursive: true, force: true });
});

function settings(over: Record<string, unknown> = {}) {
	return { ...loadConfig().update, npmRegistry: `${base}/npm`, githubApi: `${base}/gh`, githubRepo: "concept-less/quick", npmPackage: "quick-agent", ...over } as ReturnType<typeof loadConfig>["update"];
}

// ---------------------------------------------------------------- tests

describe("compareVersions", () => {
	test("orders semver incl. prereleases and v prefix", () => {
		assert.equal(U.compareVersions("0.4.0", "0.3.9"), 1);
		assert.equal(U.compareVersions("v1.0.0", "1.0.0"), 0);
		assert.equal(U.compareVersions("1.0.0-beta.2", "1.0.0"), -1);
		assert.equal(U.compareVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
		assert.equal(U.compareVersions("0.10.0", "0.9.0"), 1);
	});
});

describe("config", () => {
	test("QA_UPDATE=off disables background checks", () => {
		process.env.QA_UPDATE = "off";
		try {
			assert.equal(loadConfig().update.enabled, false);
		} finally {
			delete process.env.QA_UPDATE;
		}
		assert.equal(loadConfig().update.enabled, true);
		assert.equal(loadConfig().update.githubRepo, "concept-less/quick");
	});
});

describe("version sources (npm → GitHub → git)", () => {
	const fx = gitFixture("src");
	test("npm wins when available", async () => {
		mock.npm = { version: "0.5.0", repository: { url: "git+https://github.com/concept-less/quick.git" } };
		mock.github = { tag_name: "v0.4.0", assets: [] };
		const c = await U.checkForUpdate(settings(), fx.clone);
		assert.equal(c.kind, "git");
		assert.equal(c.latest?.source, "npm");
		assert.equal(c.latest?.version, "0.5.0");
	});
	test("npm package from another repository is ignored → GitHub release", async () => {
		mock.npm = { version: "9.9.9", repository: "github:someone/else" };
		const c = await U.checkForUpdate(settings(), fx.clone);
		assert.equal(c.tried[0]?.ok, false);
		assert.match(c.tried[0]!.error!, /someone\/else/);
		assert.equal(c.latest?.source, "github");
		assert.equal(c.latest?.version, "0.4.0");
	});
	test("npm 404 + GitHub 500 → git", async () => {
		mock.npm = 404;
		mock.github = 500;
		fx.release("0.3.1");
		const c = await U.checkForUpdate(settings(), fx.clone);
		assert.deepEqual(c.tried.map((t) => [t.source, t.ok]), [["npm", false], ["github", false], ["git", true]]);
		assert.equal(c.latest?.version, "0.3.1");
		assert.equal(c.current, "0.3.0");
		assert.equal(c.git?.behind, 1);
		assert.equal(c.available, true);
		assert.equal(c.blocker, undefined);
	});
	test("non-git copy falls back to git ls-remote tags", async () => {
		const dir = join(TMP, "lsremote");
		mkdirSync(dir);
		writeFileSync(join(dir, "package.json"), pkg("0.3.0"));
		const c = await U.checkForUpdate(settings({ gitUrl: fx.origin }), dir);
		assert.equal(c.kind, "release");
		assert.equal(c.latest?.source, "git");
		assert.equal(c.latest?.version, "0.3.1");
	});
});

describe("git install", () => {
	test("fast-forwards to upstream and records state", async () => {
		const fx = gitFixture("ff");
		fx.release("0.4.0");
		const s = settings({ sources: ["git"] });
		const c = await U.checkForUpdate(s, fx.clone);
		assert.equal(c.available, true);
		assert.equal(await U.installUpdate(c, s), "0.4.0");
		assert.equal(U.readVersion(fx.clone), "0.4.0");
		assert.equal(U.readState().installed?.to, "0.4.0");
		const again = await U.checkForUpdate(s, fx.clone);
		assert.equal(again.available, false);
	});
	test("dirty tree / diverged branch block auto-install", async () => {
		const fx = gitFixture("dirty");
		fx.release("0.4.0");
		const s = settings({ sources: ["git"] });
		writeFileSync(join(fx.clone, "package.json"), pkg("0.3.0-local"));
		let c = await U.checkForUpdate(s, fx.clone);
		assert.equal(c.available, true);
		assert.match(c.blocker ?? "", /未提交/);
		await assert.rejects(U.installUpdate(c, s), /未提交/);
		sh(fx.clone, "commit", "-qam", "local change");
		c = await U.checkForUpdate(s, fx.clone);
		assert.match(c.blocker ?? "", /分叉/);
	});
	test("detached HEAD checks out the newest tag", async () => {
		const fx = gitFixture("detached");
		sh(fx.clone, "checkout", "-q", "v0.3.0");
		fx.release("0.4.0");
		const s = settings({ sources: ["git"] });
		const c = await U.checkForUpdate(s, fx.clone);
		assert.equal(c.available, true, JSON.stringify(c));
		assert.equal(await U.installUpdate(c, s), "0.4.0");
		assert.equal(sh(fx.clone, "describe", "--tags"), "v0.4.0");
	});
});

describe("release install (GitHub asset)", () => {
	test("downloads, verifies and swaps the directory", async () => {
		const root = join(TMP, "rel", "quick-agent");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), pkg("0.3.0"));
		writeFileSync(join(root, "old.txt"), "old");
		const stage = join(TMP, "stage", "package");
		mkdirSync(stage, { recursive: true });
		writeFileSync(join(stage, "package.json"), pkg("0.4.0"));
		writeFileSync(join(stage, "new.txt"), "new");
		execFileSync("tar", ["-czf", join(TMP, "pkg.tgz"), "-C", join(TMP, "stage"), "package"]);
		mock.files.set("/dl/quick-agent-0.4.0.tgz", readFileSync(join(TMP, "pkg.tgz")));
		mock.npm = 404;
		mock.github = { tag_name: "v0.4.0", assets: [{ name: "quick-agent-0.4.0.tgz", browser_download_url: `${base}/dl/quick-agent-0.4.0.tgz` }] };
		const c = await U.checkForUpdate(settings(), root);
		assert.equal(c.kind, "release");
		assert.equal(c.latest?.source, "github");
		assert.equal(await U.installUpdate(c, settings()), "0.4.0");
		assert.ok(existsSync(join(root, "new.txt")) && !existsSync(join(root, "old.txt")));
		assert.equal(U.readVersion(`${root}.prev`), "0.3.0");
	});
});

describe("npm-global install", () => {
	test("runs npm install -g <pkg>@<version>", async () => {
		const root = join(TMP, "g", "node_modules", "quick-agent");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), pkg("0.3.0"));
		const bin = join(TMP, "fakebin");
		mkdirSync(bin, { recursive: true });
		// Fake npm: records its arguments and "installs" by rewriting package.json.
		writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" > ${TMP}/npm-args\nsed -i 's/0.3.0/0.5.0/' ${root}/package.json\n`);
		chmodSync(join(bin, "npm"), 0o755);
		const PATH = process.env.PATH;
		process.env.PATH = `${bin}:${PATH}`;
		try {
			mock.npm = { version: "0.5.0", repository: { url: "https://github.com/concept-less/quick" } };
			const c = await U.checkForUpdate(settings(), root);
			assert.equal(c.kind, "npm-global");
			assert.equal(await U.installUpdate(c, settings()), "0.5.0");
			assert.equal(readFileSync(join(TMP, "npm-args"), "utf8").trim(), "install -g quick-agent@0.5.0");
		} finally {
			process.env.PATH = PATH;
		}
	});
});

describe("background autoUpdate", () => {
	test("throttled, can be disabled, respects the lock", async () => {
		const fx = gitFixture("auto");
		fx.release("0.4.0");
		const cfgPath = join(process.env.QA_HOME!, "config.json");
		const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
		raw.update = { sources: ["git"], intervalHours: 6 };
		writeFileSync(cfgPath, JSON.stringify(raw));
		process.env.QA_UPDATE_ROOT = fx.clone;
		try {
			writeFileSync(U.STATE_PATH, "{}");
			process.env.QA_UPDATE = "0";
			assert.equal(await U.autoUpdate({ trigger: "test" }), undefined);
			assert.equal(U.readState().checkedAt, undefined, "disabled → no check at all");
			delete process.env.QA_UPDATE;

			const release = U.acquireLock()!;
			assert.ok(release);
			assert.equal(await U.autoUpdate({ trigger: "test" }), undefined, "locked → skipped");
			release();

			const r = await U.autoUpdate({ trigger: "test" });
			assert.equal(r?.installed, true);
			assert.equal(r?.to, "0.4.0");
			fx.release("0.5.0");
			assert.equal(await U.autoUpdate({ trigger: "test" }), undefined, "throttled by intervalHours");
			assert.equal(U.readVersion(fx.clone), "0.4.0");
		} finally {
			delete process.env.QA_UPDATE_ROOT;
		}
	});
	test("runUpgrade check-only does not install", async () => {
		const fx = gitFixture("checkonly");
		fx.release("0.4.0");
		process.env.QA_UPDATE_ROOT = fx.clone;
		try {
			const r = await U.runUpgrade({ check: true });
			assert.equal(r.ok, true);
			assert.equal(r.available, true);
			assert.equal(r.installed, false);
			assert.equal(U.readVersion(fx.clone), "0.3.0");
			const r2 = await U.runUpgrade({});
			assert.equal(r2.installed, true);
			assert.equal(`${r2.from}→${r2.to}`, "0.3.0→0.4.0");
		} finally {
			delete process.env.QA_UPDATE_ROOT;
		}
	});
});
