// Worker default model (config.json workerModel): parsing / validation units, and a real two-hub mesh with a fake
// `pi` per hub: list, set locally and remotely, apply to all, validation / permission / listing errors (nothing is
// saved), persistence across a hub restart, new workers launched with the new model, front settings untouched.
// Fully isolated: temp QA_HOME + ports + tmux sessions, every QA_* variable of the caller is removed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkModelSpec, cleanPiEnv, parseModelList } from "../shared/worker-model.ts";

const TABLE = (rows: string[]) => ["provider   model                     context  max-out  thinking  images", ...rows].join("\n") + "\n";

test("parseModelList reads the pi --list-models table", () => {
	const out = TABLE([
		"anthropic  claude-opus-5-5           1M       128K     yes       yes",
		"tokenjoy   anthropic-compat/gpt-5.6-sol  200K  64K     no        no",
		"tokenjoy   gpt-6.1-sol               200K     64K      no        yes",
		"tokenjoy   gpt-6.1-sol               200K     64K      no        yes",
	]);
	assert.deepEqual(parseModelList(`Warning: something\n${out}`).map((m) => [m.provider, m.id, m.thinking]), [
		["anthropic", "claude-opus-5-5", true],
		["tokenjoy", "anthropic-compat/gpt-5.6-sol", false],
		["tokenjoy", "gpt-6.1-sol", false],
	]);
	assert.deepEqual(parseModelList("No models available\n"), []);
});

test("checkModelSpec: exact provider/id, thinking only where supported, near matches in the error", () => {
	const models = parseModelList(TABLE(["tokenjoy  gpt-6.1-sol  200K  64K  no  yes", "tokenjoy  claude-opus-5-5  1M  128K  yes  yes", "tokenjoy  anthropic-compat/gpt-5.6-sol  200K  64K  no  no"]));
	assert.deepEqual(checkModelSpec(" tokenjoy/gpt-6.1-sol ", models), { ok: true, model: "tokenjoy/gpt-6.1-sol" });
	assert.deepEqual(checkModelSpec("tokenjoy/claude-opus-5-5:high", models), { ok: true, model: "tokenjoy/claude-opus-5-5:high" });
	assert.deepEqual(checkModelSpec("tokenjoy/anthropic-compat/gpt-5.6-sol", models), { ok: true, model: "tokenjoy/anthropic-compat/gpt-5.6-sol" });
	const bad = (s: unknown) => {
		const r = checkModelSpec(s, models);
		assert.equal(r.ok, false, String(s));
		return (r as any).error as string;
	};
	assert.match(bad("tokenjoy/gpt-6.1-sol:high"), /不支持思考级别/);
	assert.match(bad("tokenjoy/claude-opus-5-5:ultra"), /未知思考级别/);
	assert.match(bad("gpt-6.1-sol"), /provider\/id/);
	assert.match(bad("openai/gpt-6.1-sol"), /没有模型 openai\/gpt-6.1-sol（相近：tokenjoy\/gpt-6.1-sol）/);
	assert.match(bad("tokenjoy/gpt-6.1 sol"), /空白/);
	assert.match(bad(""), /不能为空/);
	assert.match(bad(42), /不能为空/);
});

test("cleanPiEnv drops task / hub identity so a probe pi never acts as a worker", () => {
	const e = cleanPiEnv({ PATH: "/bin", QA_TASK_ID: "t1", QA_HUB_URL: "x", QA_TOKEN: "y", QA_HOME: "/h", PI_SESSION_FILE: "s", PI_CODING_AGENT_DIR: "/a", HOME: "/home/u" });
	assert.deepEqual(e, { PATH: "/bin", PI_CODING_AGENT_DIR: "/a", HOME: "/home/u", NODE_NO_WARNINGS: "1" });
});

// ---------------------------------------------------------------- two hubs with a fake pi each

const REPO = resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "qa-wmodel-"));
const PORT = 22000 + Math.floor(Math.random() * 20000);
const env0: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
for (const k of Object.keys(env0)) if (k.startsWith("QA_") || k.startsWith("PI_")) delete env0[k];

interface H {
	id: string;
	port: number;
	home: string;
	bin: string;
	session: string;
	proc?: ChildProcess;
}
const hubs: H[] = ["ha", "hb"].map((id, i) => ({ id, port: PORT + i, home: join(TMP, id), bin: join(TMP, `bin-${id}`), session: `qa-wm-${process.pid}-${id}` }));
const MODELS: Record<string, string[]> = {
	ha: ["tokenjoy   claude-opus-5-5   1M    128K  yes  yes", "tokenjoy   gpt-6.1-sol   200K  64K  no  yes", "anthropic  claude-only-a   1M    128K  yes  yes"],
	hb: ["tokenjoy   claude-opus-5-5   1M    128K  yes  yes", "tokenjoy   gpt-6.1-sol   200K  64K  no  yes"],
};
for (const h of hubs) {
	mkdirSync(join(h.home, "work"), { recursive: true });
	mkdirSync(h.bin, { recursive: true });
	writeFileSync(join(h.bin, "models.txt"), TABLE(MODELS[h.id]!));
	// --list-models prints models.txt (or fails when "fail" exists); a worker launch records its argv and its QA_TASK_ID.
	writeFileSync(
		join(h.bin, "pi"),
		`#!/usr/bin/env bash
D=${JSON.stringify(h.bin)}
if [ "$1" = "--list-models" ]; then
  [ -n "$QA_TASK_ID" ] && echo "leaked QA_TASK_ID" >> "$D/leak.log"
  if [ -e "$D/fail" ]; then echo "boom: provider down" >&2; exit 3; fi
  cat "$D/models.txt"; exit 0
fi
echo "$QA_TASK_ID $*" >> "$D/calls.log"
sleep 600
`,
	);
	chmodSync(join(h.bin, "pi"), 0o755);
	writeFileSync(
		join(h.home, "config.json"),
		JSON.stringify({
			host: "127.0.0.1",
			port: h.port,
			token: `root-${h.id}`,
			model: "tokenjoy/claude-opus-5-5",
			...(h.id === "ha" ? { frontModel: "tokenjoy/claude-opus-5-5:high", custom: { keep: true } } : {}),
			tmuxSession: h.session,
			defaultCwd: join(h.home, "work"),
			machine: { id: h.id, priority: h.id === "ha" ? 1 : 50 },
			mesh: { secret: "wm-secret", peers: h.id === "hb" ? [{ url: `http://127.0.0.1:${hubs[0]!.port}` }] : [] },
			update: { enabled: false },
		}, null, 2),
	);
}
const [A, B] = hubs as [H, H];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conf = (h: H) => JSON.parse(readFileSync(join(h.home, "config.json"), "utf8"));

async function api(h: H, token: string, method: string, path: string, body?: any) {
	const r = await fetch(`http://127.0.0.1:${h.port}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: r.status, json: (await r.json()) as any };
}
async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn().catch(() => undefined);
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(100);
	}
}
function startHub(h: H) {
	const log = openSync(join(h.home, "hub.log"), "a");
	h.proc = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: { ...env0, QA_HOME: h.home, PATH: `${h.bin}:${process.env.PATH}`, QA_TASK_ID: "must-not-leak" }, stdio: ["ignore", log, log] });
}
const meshUp = () => until(async () => (await api(B, "root-hb", "GET", "/api/machines")).json.machines?.find((m: any) => m.id === "ha")?.online, "mesh", 20_000);

before(async () => {
	for (const h of hubs) startHub(h);
	await meshUp();
});
after(() => {
	for (const h of hubs) {
		h.proc?.kill();
		spawnSync("tmux", ["kill-session", "-t", `=${h.session}`]);
	}
	if (!process.env.QA_TEST_KEEP) rmSync(TMP, { recursive: true, force: true });
	else console.log(`kept ${TMP}`);
});

test("GET /api/worker-model?all=1: every machine, inherited from model, its own model list", async () => {
	const r = await api(B, "root-hb", "GET", "/api/worker-model?all=1");
	assert.equal(r.status, 200);
	assert.equal(r.json.canEdit, true);
	const byId = Object.fromEntries(r.json.machines.map((m: any) => [m.machine, m]));
	assert.deepEqual(Object.keys(byId).sort(), ["ha", "hb"]);
	assert.equal(byId.ha.workerModel, null);
	assert.equal(byId.ha.source, "model");
	assert.equal(byId.ha.effective, "tokenjoy/claude-opus-5-5");
	assert.equal(byId.ha.effectiveKnown, true);
	assert.equal(byId.ha.frontModel, "tokenjoy/claude-opus-5-5:high");
	assert.equal(byId.ha.models.length, 3);
	assert.equal(byId.hb.models.length, 2);
	assert.equal(byId.hb.self, true);
});

test("set locally: validated, persisted (other keys kept), live for the next worker, front untouched", async () => {
	const before = conf(A);
	const r = await api(A, "root-ha", "POST", "/api/worker-model", { model: "tokenjoy/gpt-6.1-sol" });
	assert.equal(r.status, 200, JSON.stringify(r.json));
	assert.equal(r.json.results[0].info.workerModel, "tokenjoy/gpt-6.1-sol");
	const after = conf(A);
	assert.equal(after.workerModel, "tokenjoy/gpt-6.1-sol");
	assert.deepEqual({ ...after, workerModel: undefined }, { ...before, workerModel: undefined });
	assert.equal(after.model, "tokenjoy/claude-opus-5-5");
	assert.equal(after.frontModel, "tokenjoy/claude-opus-5-5:high");
	const g = (await api(A, "root-ha", "GET", "/api/worker-model")).json;
	assert.equal(g.effective, "tokenjoy/gpt-6.1-sol");
	assert.equal(g.source, "workerModel");
	// no hub restart: the next worker gets the new model
	const t = (await api(A, "root-ha", "POST", "/api/tasks", { title: "wm probe", brief: "noop", machine: "ha", cwd: join(A.home, "work") })).json.task;
	assert.ok(t?.id, "task created");
	const line = await until(async () => existsSync(join(A.bin, "calls.log")) && readFileSync(join(A.bin, "calls.log"), "utf8").split("\n").find((l) => l.startsWith(`${t.id} `)), "worker launched");
	assert.match(line, /--model tokenjoy\/gpt-6\.1-sol /);
});

test("set a remote machine through the mesh; hb's own config changes, ha's does not", async () => {
	const r = await api(A, "root-ha", "POST", "/api/worker-model", { machine: "hb", model: "tokenjoy/claude-opus-5-5:low" });
	assert.equal(r.status, 200, JSON.stringify(r.json));
	assert.equal(conf(B).workerModel, "tokenjoy/claude-opus-5-5:low");
	assert.equal(conf(A).workerModel, "tokenjoy/gpt-6.1-sol");
	assert.equal((await api(B, "root-hb", "GET", "/api/worker-model")).json.effective, "tokenjoy/claude-opus-5-5:low");
});

test("errors are explicit and save nothing: unknown model, bad thinking, no permission, listing failure", async () => {
	const keep = () => [conf(A).workerModel, conf(B).workerModel];
	const k0 = keep();
	let r = await api(A, "root-ha", "POST", "/api/worker-model", { model: "tokenjoy/gpt-6.1 sol" });
	assert.equal(r.status, 400);
	assert.match(r.json.error, /空白/);
	r = await api(A, "root-ha", "POST", "/api/worker-model", { model: "tokenjoy/gpt-6.1-sol:high" });
	assert.equal(r.status, 400);
	assert.match(r.json.error, /不支持思考级别.*未保存/);
	r = await api(A, "root-ha", "POST", "/api/worker-model", { machine: "hb", model: "anthropic/claude-only-a" });
	assert.equal(r.status, 400);
	assert.match(r.json.error, /hb: 这台机器的 pi 里没有模型 anthropic\/claude-only-a/);
	r = await api(A, "root-ha", "POST", "/api/worker-model", { machine: "nope", model: "tokenjoy/gpt-6.1-sol" });
	assert.equal(r.status, 400);
	r = await api(A, "root-ha", "POST", "/api/worker-model", {});
	assert.equal(r.status, 400);
	// a listing failure is not a silent pass
	writeFileSync(join(A.bin, "fail"), "");
	r = await api(A, "root-ha", "POST", "/api/worker-model", { model: "tokenjoy/claude-opus-5-5" });
	assert.equal(r.status, 502);
	assert.match(r.json.error, /无法校验模型，未保存.*boom: provider down/);
	const g = (await api(A, "root-ha", "GET", "/api/worker-model?refresh=1")).json;
	assert.match(g.listError, /boom/);
	assert.equal(g.effectiveKnown, undefined);
	rmSync(join(A.bin, "fail"));
	// team member without the owner role
	const owner = (await api(A, "root-ha", "POST", "/api/team/members", { id: "simon", name: "Simon", machineOwner: true })).json;
	assert.ok(owner.token);
	const inv = (await api(A, "root-ha", "POST", "/api/team/invites", {})).json;
	const bob = (await api(A, "nobody", "POST", "/api/team/join", { code: inv.code, id: "bob", name: "Bob" })).json;
	r = await api(A, bob.token, "POST", "/api/worker-model", { model: "tokenjoy/claude-opus-5-5" });
	assert.equal(r.status, 403);
	const view = await api(A, bob.token, "GET", "/api/worker-model");
	assert.equal(view.status, 200);
	assert.equal(view.json.canEdit, false);
	assert.deepEqual(keep(), k0);
	// the probes never ran with a task identity
	for (const h of hubs) assert.equal(existsSync(join(h.bin, "leak.log")), false, `${h.id}: QA_TASK_ID leaked into pi --list-models`);
});

test("apply to all machines: per-machine validation, partial failure reported per machine (207)", async () => {
	let r = await api(B, "root-hb", "POST", "/api/worker-model", { machines: "all", model: "anthropic/claude-only-a" });
	assert.equal(r.status, 207);
	const res = Object.fromEntries(r.json.results.map((x: any) => [x.machine, x]));
	assert.equal(res.ha.ok, true);
	assert.equal(res.hb.ok, false);
	assert.match(r.json.error, /hb: .*claude-only-a/);
	assert.equal(conf(A).workerModel, "anthropic/claude-only-a");
	assert.equal(conf(B).workerModel, "tokenjoy/claude-opus-5-5:low");
	r = await api(B, "root-hb", "POST", "/api/worker-model", { machines: "all", model: "tokenjoy/gpt-6.1-sol" });
	assert.equal(r.status, 200, JSON.stringify(r.json));
	assert.deepEqual([conf(A).workerModel, conf(B).workerModel], ["tokenjoy/gpt-6.1-sol", "tokenjoy/gpt-6.1-sol"]);
});

test("clear falls back to model; a restarted hub keeps the persisted value", async () => {
	let r = await api(B, "root-hb", "POST", "/api/worker-model", { model: null });
	assert.equal(r.status, 200);
	assert.equal("workerModel" in conf(B), false);
	assert.equal(r.json.results[0].info.source, "model");
	assert.equal(r.json.results[0].info.effective, "tokenjoy/claude-opus-5-5");
	A.proc?.kill();
	await until(async () => !(await api(A, "root-ha", "GET", "/api/worker-model").then(() => true, () => false)), "ha down");
	startHub(A);
	await meshUp();
	const g = (await api(A, "root-ha", "GET", "/api/worker-model")).json;
	assert.equal(g.workerModel, "tokenjoy/gpt-6.1-sol");
	assert.equal(conf(A).frontModel, "tokenjoy/claude-opus-5-5:high");
	assert.deepEqual(conf(A).custom, { keep: true });
});
