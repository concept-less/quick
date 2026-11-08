// End-to-end upgrade over the mesh with real hub processes, real release tarballs built from this
// checkout and a fake GitHub Releases API (local HTTP server).
//
//   a ──dials──► b ◄──dials── c        (a reaches c via b: 2 hops)
//                ▲
//                └──dials── old        (hub running pre-upgrade code: no update.* methods)
//
// a, b, c are release installs (<home>/app/0.8.0, current → 0.8.0); v0.9.0 is "published".
// b runs a (fake) worker in tmux that keeps reporting to its hub while b upgrades + restarts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "qa-mesh-upgrade-"));
const SECRET = "test-mesh-secret";
const BASE_PORT = 20000 + Math.floor(Math.random() * 20000);
const env0: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "QA_UPDATE_ROOT", "QA_INSTALL_KIND", "QA_APP_DIR", "QA_UPDATE", "QA_UPDATE_AUTO_INSTALL", "GITHUB_TOKEN", "GH_TOKEN", "TMUX"]) delete env0[k];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TMUX = spawnSync("tmux", ["-V"]).status === 0;

// ---------------------------------------------------------------- release tarballs from this checkout

function buildTarball(version: string): Buffer {
	const stage = join(TMP, `stage-${version}`);
	const pkgDir = join(stage, "package");
	mkdirSync(pkgDir, { recursive: true });
	for (const d of ["bin", "cli", "hub", "shared", "extensions", "browser", "ui"]) cpSync(join(REPO, d), join(pkgDir, d), { recursive: true });
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ ...pkg, version }, null, 2));
	const file = join(stage, `quick-agent-${version}.tgz`);
	execFileSync("tar", ["-czf", file, "-C", stage, "package"]);
	return readFileSync(file);
}
const tgz = { "0.8.0": buildTarball("0.8.0"), "0.9.0": buildTarball("0.9.0") };

// The fake GitHub API runs in its own process: the tests block on spawnSync(quick …).
const GH_PORT = BASE_PORT + 50;
const gh = `http://127.0.0.1:${GH_PORT}`;
const ghDir = join(TMP, "gh");
mkdirSync(ghDir);
{
	const v = "0.9.0";
	const name = `quick-agent-${v}.tgz`;
	writeFileSync(join(ghDir, name), tgz[v]);
	writeFileSync(join(ghDir, "SHA256SUMS"), `${createHash("sha256").update(tgz[v]).digest("hex")}  ${name}\n`);
	writeFileSync(
		join(ghDir, "latest.json"),
		JSON.stringify({
			tag_name: `v${v}`,
			name: `quick-agent v${v}`,
			body: "- faster\n- better",
			html_url: `https://github.com/concept-less/quick/releases/tag/v${v}`,
			assets: [
				{ name, browser_download_url: `${gh}/dl/${name}`, size: tgz[v].length },
				{ name: "SHA256SUMS", browser_download_url: `${gh}/dl/SHA256SUMS` },
			],
		}),
	);
}
let ghProc: ChildProcess | undefined;
const releaseHits = () => Number(existsSync(join(ghDir, "hits")) ? readFileSync(join(ghDir, "hits"), "utf8") : 0);
async function startReleaseServer() {
	ghProc = spawn(
		process.execPath,
		[
			"-e",
			`const http = require("http"), fs = require("fs"), p = require("path"); const dir = ${JSON.stringify(ghDir)}; let hits = 0;
http.createServer((req, res) => {
	if (req.url === "/gh/repos/concept-less/quick/releases/latest") { fs.writeFileSync(p.join(dir, "hits"), String(++hits)); return res.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(p.join(dir, "latest.json"))); }
	const f = req.url.startsWith("/dl/") && p.join(dir, p.basename(req.url));
	if (f && fs.existsSync(f)) { const b = fs.readFileSync(f); return res.writeHead(200, { "content-length": b.length }).end(b); }
	res.writeHead(404).end();
}).listen(${GH_PORT}, "127.0.0.1");`,
		],
		{ stdio: "ignore" },
	);
	for (let i = 0; i < 50; i++) {
		await sleep(100);
		if (await fetch(`${gh}/dl/SHA256SUMS`).then((r) => r.ok).catch(() => false)) return;
	}
	throw new Error("fake GitHub API did not start");
}

// ---------------------------------------------------------------- machines

// Fake `pi` for workers: keeps reporting activity to its hub through HubClient (like a real worker).
const fakeBin = join(TMP, "bin");
mkdirSync(fakeBin);
writeFileSync(
	join(fakeBin, "pi"),
	`#!/usr/bin/env bash
exec node --import ${REPO}/bin/ts-hooks.mjs --input-type=module -e '
const { HubClient } = await import("${REPO}/shared/hub-client.ts");
const { writeFileSync } = await import("node:fs");
const hub = new HubClient();
const id = process.env.QA_TASK_ID;
const st = { pid: process.pid, ok: 0, fail: 0, okAfter: {}, err: "" };
for (let n = 0; ; n++) {
	try {
		await hub.report(id, n === 0 ? { status: "running", activity: "fake worker" } : { activity: "tick " + n });
		const h = await hub.health();
		st.ok++;
		st.okAfter[h.pid] = (st.okAfter[h.pid] ?? 0) + 1;
	} catch (e) { st.fail++; st.err = String(e.message); }
	writeFileSync(process.env.QA_HOME + "/fake-worker-" + id + ".json", JSON.stringify(st));
	await new Promise((r) => setTimeout(r, 150));
}
'
`,
);
chmodSync(join(fakeBin, "pi"), 0o755);

interface M {
	id: string;
	port: number;
	home: string;
	app: string;
	env: NodeJS.ProcessEnv;
}
const ids = ["a", "b", "c", "old"];
const machines: Record<string, M> = {};
const peersOf: Record<string, string[]> = { a: ["b"], b: [], c: ["b"], old: ["b"] };
ids.forEach((id, i) => {
	const home = join(TMP, `home-${id}`);
	const app = join(home, "app");
	mkdirSync(app, { recursive: true });
	machines[id] = { id, port: BASE_PORT + i, home, app, env: {} };
});
for (const m of Object.values(machines)) {
	writeFileSync(
		join(m.home, "config.json"),
		JSON.stringify({
			host: "127.0.0.1",
			port: m.port,
			uiPort: m.port + 100,
			token: `tok-${m.id}`,
			tmuxSession: `qa-test-${process.pid}-${m.id}`,
			defaultCwd: TMP,
			machine: { id: m.id },
			mesh: { secret: SECRET, peers: peersOf[m.id]!.map((p) => ({ url: `http://127.0.0.1:${machines[p]!.port}` })) },
			// c never restarts its hub on its own (auto-install is off by default).
			update: { restartHub: m.id === "c" ? "never" : "auto" },
		}),
	);
	m.env = { ...env0, QA_HOME: m.home, QA_PORT: String(m.port), QA_GITHUB_API: `${gh}/gh`, PATH: `${fakeBin}:${process.env.PATH}` };
	if (m.id === "old") continue;
	// install.sh equivalent: unpack 0.8.0 and point current at it.
	execFileSync("tar", ["-xzf", "-", "-C", m.app], { input: tgz["0.8.0"] });
	execFileSync("mv", [join(m.app, "package"), join(m.app, "0.8.0")]);
	symlinkSync("0.8.0", join(m.app, "current"));
}
// "old" runs the code from before the upgrade feature existed.
const oldCode = join(TMP, "old-code");
mkdirSync(oldCode);
execFileSync("bash", ["-c", `git -C ${REPO} archive a916df4 | tar -x -C ${oldCode}`]);

async function health(m: M): Promise<{ pid: number; version?: string } | undefined> {
	try {
		const r = await fetch(`http://127.0.0.1:${m.port}/health`, { signal: AbortSignal.timeout(1000) });
		return r.ok ? ((await r.json()) as any) : undefined;
	} catch {
		return undefined;
	}
}
async function api(m: M, method: string, path: string, body?: unknown): Promise<any> {
	const r = await fetch(`http://127.0.0.1:${m.port}${path}`, { method, headers: { authorization: `Bearer tok-${m.id}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const j = (await r.json()) as any;
	if (!r.ok) throw new Error(j.error);
	return j;
}
/** Run `quick` from the machine's installed version (app/current). */
function quick(m: M, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
	const r = spawnSync(process.execPath, ["--import", join(m.app, "current", "bin", "ts-hooks.mjs"), join(m.app, "current", "cli", "quick.ts"), ...args], { env: { ...m.env, ...extraEnv }, encoding: "utf8", timeout: 120_000 });
	return { code: r.status, out: r.stdout, err: r.stderr };
}
const link = (m: M) => readlinkSync(join(m.app, "current"));

// (root-level before hooks run concurrently: keep a single one)
before(async () => {
	await startReleaseServer();
	for (const m of Object.values(machines)) {
		const code = m.id === "old" ? oldCode : join(m.app, "current");
		spawn(process.execPath, ["--import", join(REPO, "bin", "ts-hooks.mjs"), join(code, "hub", "server.ts")], { env: m.env, stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
	}
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		try {
			const j = await api(machines.a!, "GET", "/api/machines");
			if (j.machines?.filter((x: any) => x.online).length === 4) return;
		} catch {}
	}
	throw new Error("mesh did not converge");
});

after(() => {
	ghProc?.kill();
	for (const m of Object.values(machines)) {
		try {
			process.kill(Number(readFileSync(join(m.home, "hub.pid"), "utf8")), "SIGTERM");
		} catch {}
		spawnSync("tmux", ["kill-session", "-t", `=qa-test-${process.pid}-${m.id}`]);
	}
	rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

test("quick upgrade --all --check: every machine sees the release, nothing is installed", () => {
	const r = quick(machines.a!, ["upgrade", "--all", "--check"]);
	if (process.env.SHOW_OUTPUT) console.log(r.out, r.err);
	assert.equal(r.code, 1, "old machine fails → non-zero exit");
	for (const id of ["a", "b", "c"]) assert.match(r.out, new RegExp(`^${id}\\s+当前 0\\.8\\.0\\s+最新 0\\.9\\.0\\s+↑ 有新版本`, "m"));
	assert.match(r.out, /^old\s.*✕ 对方 hub 版本过旧/m);
	for (const id of ["a", "b", "c"]) assert.equal(link(machines[id]!), "0.8.0");
});

test("CLI start prints a one-line hint when a newer release exists (cached)", () => {
	const hits = releaseHits();
	const r = quick(machines.c!, ["machines"], { QA_UPDATE_HINT: "1" });
	assert.equal(r.code, 0, r.err);
	assert.match(r.err.trim().split("\n").at(-1)!, /new version v0\.9\.0 available: quick upgrade/);
	quick(machines.c!, ["ls"], { QA_UPDATE_HINT: "1" });
	assert.ok(releaseHits() - hits <= 1, "second start served from the cache");
	const off = quick(machines.c!, ["ls"], { QA_UPDATE_HINT: "1", QA_UPDATE: "off" });
	assert.doesNotMatch(off.err, /new version/);
});

test("UI flow: a upgrades b through the mesh (download → verify → switch → restart); b's worker keeps running", { skip: !TMUX && "needs tmux" }, async () => {
	const a = machines.a!;
	const b = machines.b!;
	// A worker on b (fake pi in tmux) that keeps talking to its hub.
	const { task } = await api(a, "POST", "/api/tasks", { title: "long job", brief: "keep going", machine: "b", cwd: TMP });
	const wfile = join(b.home, `fake-worker-${task.id}.json`);
	const worker = () => (existsSync(wfile) ? JSON.parse(readFileSync(wfile, "utf8")) : { ok: 0, fail: 0, okAfter: {} });
	for (let i = 0; i < 100 && worker().ok < 3; i++) await sleep(100);
	assert.ok(worker().ok >= 3, "worker is reporting");
	const w0 = worker();

	// What the header shows: every machine with its versions.
	const all = await api(a, "GET", "/api/update?all=1");
	const sb = all.machines.find((x: any) => x.machine === "b");
	assert.equal(sb.running, "0.8.0");
	assert.equal(sb.latest.version, "0.9.0");
	assert.equal(sb.latest.notes, "- faster\n- better");
	assert.equal(sb.canInstall, true);
	assert.match(all.machines.find((x: any) => x.machine === "old").error, /版本过旧/);

	const pid0 = (await health(b))!.pid;
	const started = await api(a, "POST", "/api/update", { machine: "b", action: "install" });
	assert.ok(started.job, "job started");
	const steps = new Set<string>();
	let st: any;
	for (let i = 0; i < 200; i++) {
		await sleep(150);
		try {
			st = await api(a, "GET", "/api/update?machine=b");
			if (st.job) steps.add(st.job.step);
			if (st.job?.step === "done" && st.running === "0.9.0") break;
			if (st.job?.step === "error") break;
		} catch {
			steps.add("(unreachable)");
		}
	}
	assert.equal(st?.job?.step, "done", JSON.stringify(st?.job));
	assert.equal(st.running, "0.9.0");
	assert.equal(st.installed, "0.9.0");
	assert.equal(st.previous, "0.8.0");
	assert.ok(steps.has("restart") || steps.has("(unreachable)"), `went through a restart: ${[...steps]}`);
	assert.equal(link(b), "0.9.0");
	const pid1 = (await health(b))!.pid;
	assert.notEqual(pid1, pid0, "hub b restarted");

	// The worker never noticed: same process, no failed request, and it talks to the new hub.
	for (let i = 0; i < 50 && !(worker().okAfter[pid1] >= 3); i++) await sleep(100);
	const w1 = worker();
	assert.equal(w1.pid, w0.pid, "same worker process");
	assert.equal(w1.fail, 0, `no failed hub request (${w1.err})`);
	assert.ok(w1.okAfter[pid1] >= 3, "worker reports to the new hub");
	const t = (await api(b, "GET", `/api/tasks/${task.id}`)).task;
	assert.equal(t.status, "running");
	assert.equal(t.closed, false);
});

test("quick upgrade --all installs the rest, summarises, restartHub=never is respected", async () => {
	const pidA = (await health(machines.a!))!.pid;
	const pidC = (await health(machines.c!))!.pid;
	let r = quick(machines.a!, ["upgrade", "--all"]);
	for (let i = 0; i < 10 && /另一个升级|not reachable/.test(r.out); i++) {
		await sleep(1000); // mesh link to b re-established after its restart
		r = quick(machines.a!, ["upgrade", "--all"]);
	}
	if (process.env.SHOW_OUTPUT) console.log(r.out);
	assert.match(r.out, /^a\s.*✓ 已升级 0\.8\.0 → 0\.9\.0/m);
	assert.match(r.out, /^b\s.*✓ 已是最新/m);
	assert.match(r.out, /^c\s.*✓ 已升级 0\.8\.0 → 0\.9\.0/m);
	assert.match(r.out, /4 台机器：2 台已升级，1 台失败/);
	let h: any;
	for (let i = 0; i < 80; i++) {
		await sleep(150);
		h = await health(machines.a!);
		if (h && h.pid !== pidA && h.version === "0.9.0") break;
	}
	assert.equal(h?.version, "0.9.0", "a restarted on 0.9.0");
	assert.equal((await health(machines.c!))!.pid, pidC, "c (restartHub never) keeps running");
	assert.equal(link(machines.c!), "0.9.0");
});

test("rollback from the UI API switches back and restarts", async () => {
	const a = machines.a!;
	let st: any;
	for (let i = 0; i < 20; i++) {
		try {
			await api(a, "POST", "/api/update", { machine: "a", action: "rollback" });
			break;
		} catch (e) {
			await sleep(300); // previous job still finishing
		}
	}
	for (let i = 0; i < 100; i++) {
		await sleep(150);
		st = await api(a, "GET", "/api/update").catch(() => undefined);
		if (st?.job?.action === "rollback" && st.job.step === "done" && st.running === "0.8.0") break;
	}
	assert.equal(st?.running, "0.8.0", JSON.stringify(st?.job));
	assert.equal(link(a), "0.8.0");
	assert.equal(st.available, true, "0.9.0 offered again");
});
