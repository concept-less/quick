// Machine resources over a real two-hub mesh: publishing, remote configuration, dispatch routing errors.
// (Successful dispatches would launch real pi workers, so only the selection outcome is checked.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "qa-dispatch-"));
const BASE_PORT = 20000 + Math.floor(Math.random() * 20000);
const env0 = { ...process.env, NODE_NO_WARNINGS: "1" };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "QA_MACHINE_PRIORITY", "QA_UPDATE_ROOT", "QA_INSTALL_KIND"]) delete (env0 as any)[k];

interface M {
	id: string;
	port: number;
	home: string;
	env: NodeJS.ProcessEnv;
	proc?: ChildProcess;
}
const ms: Record<string, M> = {};
const machine: Record<string, any> = {
	srv: { id: "srv", priority: 10, resources: ["-*", "linux", "docker"] },
	lap: { id: "lap", resources: ["-*", "macos", "gui", "browser:chrome-gui"] }, // priority set later over the mesh
};
["srv", "lap"].forEach((id, i) => {
	const home = join(TMP, `home-${id}`);
	mkdirSync(home, { recursive: true });
	ms[id] = { id, port: BASE_PORT + i, home, env: { ...env0, QA_HOME: home, QA_PORT: String(BASE_PORT + i) } };
});
for (const m of Object.values(ms)) {
	writeFileSync(
		join(m.home, "config.json"),
		JSON.stringify({
			host: "127.0.0.1",
			port: m.port,
			token: `tok-${m.id}`,
			tmuxSession: `qa-test-${process.pid}-${m.id}`,
			defaultCwd: m.home,
			machine: machine[m.id],
			mesh: { secret: "s", peers: m.id === "lap" ? [{ url: `http://127.0.0.1:${ms.srv!.port}` }] : [] },
			update: { enabled: false },
		}),
	);
}

const sleep = (ms2: number) => new Promise((r) => setTimeout(r, ms2));
async function api(m: M, method: string, path: string, body?: any) {
	const r = await fetch(`http://127.0.0.1:${m.port}${path}`, {
		method,
		headers: { authorization: `Bearer tok-${m.id}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: r.status, json: (await r.json()) as any };
}
const view = async (m: M, id: string) => (await api(m, "GET", "/api/machines")).json.machines.find((x: any) => x.id === id);

before(async () => {
	for (const m of Object.values(ms)) m.proc = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: m.env, stdio: ["ignore", "ignore", "pipe"] });
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		try {
			if ((await view(ms.srv!, "lap"))?.online) return;
		} catch {}
	}
	throw new Error("mesh did not converge");
});

after(() => {
	for (const m of Object.values(ms)) {
		m.proc?.kill();
		try {
			process.kill(Number(readFileSync(join(m.home, "hub.pid"), "utf8")), "SIGTERM");
		} catch {}
	}
	rmSync(TMP, { recursive: true, force: true });
});

test("resources and priority are published through the mesh", async () => {
	const lap = await view(ms.srv!, "lap");
	assert.deepEqual(lap.resources, ["macos", "gui", "browser:chrome-gui"]);
	assert.equal(lap.priority, undefined);
	const srv = await view(ms.lap!, "srv");
	assert.equal(srv.priority, 10);
	assert.deepEqual(srv.resources, ["linux", "docker"]);
});

test("a remote machine can be configured over the mesh without restarting its hub", async () => {
	const r = await api(ms.srv!, "POST", "/api/machine", { machine: "lap", priority: 50, addResources: ["codex"], resourceNotes: "human laptop" });
	assert.equal(r.status, 200, JSON.stringify(r.json));
	assert.equal(r.json.machine.priority, 50);
	assert.ok(r.json.machine.resources.includes("codex"));
	const raw = JSON.parse(readFileSync(join(ms.lap!.home, "config.json"), "utf8"));
	assert.equal(raw.machine.priority, 50);
	assert.ok(raw.machine.resources.includes("codex"));
	assert.equal(raw.token, "tok-lap"); // other keys kept
	for (let i = 0; i < 50 && (await view(ms.srv!, "lap")).priority !== 50; i++) await sleep(100);
	const lap = await view(ms.srv!, "lap");
	assert.equal(lap.priority, 50);
	assert.equal(lap.resourceNotes, "human laptop");
});

test("dispatch errors are explicit when no machine has the resources", async () => {
	const r = await api(ms.lap!, "POST", "/api/tasks", { title: "x", brief: "y", requires: ["gpu"] });
	assert.equal(r.status, 400);
	assert.match(r.json.error, /no online machine has the required resources gpu/);
	assert.match(r.json.error, /srv lacks gpu/);
	const r2 = await api(ms.lap!, "POST", "/api/tasks", { title: "x", brief: "y", machine: "srv", requires: ["browser:chrome-gui"] });
	assert.equal(r2.status, 400);
	assert.match(r2.json.error, /srv lacks required resources: browser:chrome-gui/);
});

test("cwd is matched against the chosen machines (remote path probe)", async () => {
	// The path exists only on lap's file system view → error lists the browser-capable candidate only.
	const r = await api(ms.srv!, "POST", "/api/tasks", { title: "x", brief: "y", requires: ["browser"], cwd: "/definitely/not/here" });
	assert.equal(r.status, 400);
	assert.match(r.json.error, /does not exist on any candidate machine \(lap\)/);
	const r2 = await api(ms.srv!, "POST", "/api/tasks", { title: "x", brief: "y", cwd: "/definitely/not/here" });
	assert.match(r2.json.error, /candidate machine \(srv, lap\)/); // priority order
});

test("quick machine shows and sets local resources", () => {
	const q = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "cli", "quick.ts"), ...args], { env: { ...ms.srv!.env, QA_UPDATE: "off" }, encoding: "utf8", timeout: 60_000 });
	let r = q("machine", "set", "--priority", "5", "--add", "gpu");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /优先级: 5/);
	assert.match(r.stdout, /gpu/);
	r = q("machines");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /srv\s+self\s+P5\s+★/);
	assert.match(r.stdout, /资源: macos, gui, browser:chrome-gui, codex/);
});
