// Multi-machine upgrade over the mesh: real hub processes on temp ports / temp homes.
//
//   a ──dials──► b ◄──dials── c        (a reaches c via b: 2 hops)
//                ▲
//                └──dials── old        (hub running the pre-upgrade code: no update.run)
//
// Every machine "installs" into its own temp git clone (QA_UPDATE_ROOT), so nothing real is touched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "qa-mesh-upgrade-"));
const SECRET = "test-mesh-secret";
const BASE_PORT = 20000 + Math.floor(Math.random() * 20000);
const env0 = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", NODE_NO_WARNINGS: "1" };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "QA_UPDATE_ROOT", "QA_INSTALL_KIND"]) delete (env0 as any)[k];

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: env0, stdio: "pipe" }).toString().trim();
const pkg = (v: string) => JSON.stringify({ name: "quick-agent", version: v }, null, 2);

// origin with 0.3.0; every machine clones it; then 0.4.0 is pushed.
const origin = join(TMP, "origin.git");
const seed = join(TMP, "seed");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
execFileSync("git", ["clone", "-q", origin, seed], { stdio: "pipe" });
writeFileSync(join(seed, "package.json"), pkg("0.3.0"));
git(seed, "add", ".");
git(seed, "commit", "-qm", "0.3.0");
git(seed, "push", "-q", "origin", "main");

interface M {
	id: string;
	port: number;
	home: string;
	root: string;
	code: string;
	env: NodeJS.ProcessEnv;
	proc?: ChildProcess;
}
const ids = ["a", "b", "c", "old"];
const machines: Record<string, M> = {};
ids.forEach((id, i) => {
	const home = join(TMP, `home-${id}`);
	const root = join(TMP, `install-${id}`);
	mkdirSync(home, { recursive: true });
	execFileSync("git", ["clone", "-q", origin, root], { stdio: "pipe" });
	machines[id] = { id, port: BASE_PORT + i, home, root, code: REPO, env: {} };
});
// "old" runs the code before the upgrade feature existed.
const oldCode = join(TMP, "old-code");
mkdirSync(oldCode);
execFileSync("bash", ["-c", `git -C ${REPO} archive a916df4 | tar -x -C ${oldCode}`]);
machines.old!.code = oldCode;

const peersOf: Record<string, string[]> = { a: ["b"], b: [], c: ["b"], old: ["b"] };
for (const m of Object.values(machines)) {
	writeFileSync(
		join(m.home, "config.json"),
		JSON.stringify({
			host: "127.0.0.1",
			port: m.port,
			token: `tok-${m.id}`,
			tmuxSession: `qa-test-${process.pid}-${m.id}`,
			machine: { id: m.id },
			mesh: { secret: SECRET, peers: peersOf[m.id]!.map((p) => ({ url: `http://127.0.0.1:${machines[p]!.port}` })) },
			// Background checks off (deterministic); c never restarts its hub on its own.
			update: { enabled: false, sources: ["git"], restartHub: m.id === "c" ? "never" : "idle" },
		}),
	);
	m.env = { ...env0, QA_HOME: m.home, QA_PORT: String(m.port), QA_UPDATE_ROOT: m.root };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function health(m: M): Promise<{ pid: number; version?: string } | undefined> {
	try {
		const r = await fetch(`http://127.0.0.1:${m.port}/health`, { signal: AbortSignal.timeout(1000) });
		return r.ok ? ((await r.json()) as any) : undefined;
	} catch {
		return undefined;
	}
}
function quick(m: M, ...args: string[]) {
	const r = spawnSync(process.execPath, [join(REPO, "cli", "quick.ts"), ...args], { env: m.env, encoding: "utf8", timeout: 120_000 });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

before(async () => {
	for (const m of Object.values(machines)) {
		m.proc = spawn(process.execPath, [join(m.code, "hub", "server.ts")], { env: m.env, stdio: ["ignore", "ignore", "pipe"] });
	}
	// Wait until a sees everybody (old via b, c via b).
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		try {
			const r = await fetch(`http://127.0.0.1:${machines.a!.port}/api/machines`, { headers: { authorization: "Bearer tok-a" } });
			const j = (await r.json()) as any;
			if (j.machines?.filter((x: any) => x.online).length === 4) return;
		} catch {}
	}
	throw new Error("mesh did not converge");
});

after(() => {
	for (const m of Object.values(machines)) {
		m.proc?.kill();
		try {
			process.kill(Number(readFileSync(join(m.home, "hub.pid"), "utf8")), "SIGTERM");
		} catch {}
	}
	rmSync(TMP, { recursive: true, force: true });
});

test("quick upgrade --all --check reports every machine without installing", async () => {
	writeFileSync(join(seed, "package.json"), pkg("0.4.0"));
	git(seed, "commit", "-qam", "0.4.0");
	git(seed, "push", "-q", "origin", "main");

	const r = quick(machines.a!, "upgrade", "--all", "--check", "--json");
	assert.equal(r.code, 0, r.err);
	const res = JSON.parse(r.out) as any[];
	const by = Object.fromEntries(res.map((x) => [x.machine, x]));
	assert.deepEqual(Object.keys(by).sort(), ["a", "b", "c", "old"]);
	for (const id of ["a", "b", "c"]) {
		assert.equal(by[id].ok, true, `${id}: ${by[id].error}`);
		assert.equal(by[id].available, true);
		assert.equal(by[id].installed, false);
		assert.equal(by[id].latest.version, "0.4.0");
		assert.equal(by[id].root, machines[id]!.root);
	}
	assert.equal(by.old.ok, false);
	assert.match(by.old.error, /版本过旧/);
	for (const m of Object.values(machines)) assert.equal(JSON.parse(readFileSync(join(m.root, "package.json"), "utf8")).version, "0.3.0");
});

test("quick upgrade <machine> targets one machine (2 hops away)", () => {
	const r = quick(machines.a!, "upgrade", "c", "--check");
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^c\s+当前 0\.3\.0\s+最新 0\.4\.0 \(git\)/m);
	assert.doesNotMatch(r.out, /^b\s/m);
});

test("quick upgrade --all installs everywhere, summarises, and idle hubs restart", async () => {
	const before = Object.fromEntries(await Promise.all(Object.values(machines).map(async (m) => [m.id, (await health(m))?.pid])));
	const r = quick(machines.a!, "upgrade", "--all");
	if (process.env.SHOW_OUTPUT) console.log(r.out);
	assert.equal(r.code, 1, "old machine fails → non-zero exit");
	assert.match(r.out, /^a\s.*✓ 已升级 0\.3\.0 → 0\.4\.0/m);
	assert.match(r.out, /^b\s.*✓ 已升级 0\.3\.0 → 0\.4\.0/m);
	assert.match(r.out, /^c\s.*✓ 已升级 0\.3\.0 → 0\.4\.0/m);
	assert.match(r.out, /^old\s.*✕ 对方 hub 版本过旧/m);
	assert.match(r.out, /4 台机器：3 台已升级，1 台失败/);
	for (const id of ["a", "b", "c"]) assert.equal(JSON.parse(readFileSync(join(machines[id]!.root, "package.json"), "utf8")).version, "0.4.0");

	// a and b (restartHub=idle, no running workers) restart themselves; c (never) keeps running.
	let pids: Record<string, number | undefined> = {};
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		pids = Object.fromEntries(await Promise.all(Object.values(machines).map(async (m) => [m.id, (await health(m))?.pid])));
		if (pids.a && pids.b && pids.a !== before.a && pids.b !== before.b) break;
	}
	assert.notEqual(pids.a, before.a, "hub a restarted");
	assert.notEqual(pids.b, before.b, "hub b restarted");
	assert.equal(pids.c, before.c, "hub c not restarted");

	// Second run: nothing to do. Wait for the mesh to reconnect after the restarts first.
	let again: any[] = [];
	for (let i = 0; i < 40; i++) {
		const out = quick(machines.a!, "upgrade", "--all", "--check", "--json");
		again = out.code === 0 || out.out ? JSON.parse(out.out || "[]") : [];
		if (again.length === 4) break;
		await sleep(500);
	}
	for (const x of again.filter((x) => x.machine !== "old")) assert.equal(x.available, false, `${x.machine} up to date`);
});

test("unknown machine is reported, not thrown", () => {
	const r = quick(machines.a!, "upgrade", "nope", "--check", "--json");
	const res = JSON.parse(r.out);
	assert.equal(res[0].ok, false);
	assert.match(res[0].error, /not reachable/);
	assert.ok(!existsSync(join(TMP, "nothing")));
});
