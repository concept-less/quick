// Progress + 工作记录 on a real (isolated) hub: worker reports → task.progress over SSE without interrupting,
// old workers (activity only) fall back to plain words, and the work log is paged from the session file.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "qa-proghub-")));
const HOME = join(TMP, "qa-home");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, NODE_NO_WARNINGS: "1", QA_HOME: HOME, QA_PORT: String(PORT), QA_MACHINE: "cloud", QA_UPDATE: "off" };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE_PRIORITY"]) delete (env as any)[k];
const SESSION = join(TMP, "session.jsonl");
const line = (ts: number, message: any) => `${JSON.stringify({ type: "message", id: String(ts), timestamp: new Date(ts).toISOString(), message })}\n`;

let hub: ChildProcess | undefined;
async function api(method: string, path: string, body?: any) {
	const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const json = (await r.json()) as any;
	if (!r.ok) throw new Error(`${path}: ${json.error}`);
	return json;
}
const report = (id: string, body: any) => api("POST", `/api/tasks/${id}/report`, body).then((r) => r.task);

const events: any[] = [];
const sse = new AbortController();

before(async () => {
	mkdirSync(join(HOME, "tasks"), { recursive: true });
	writeFileSync(join(HOME, "config.json"), JSON.stringify({ host: "127.0.0.1", port: PORT, token: "tok", tmuxSession: `qa-progtest-${process.pid}`, defaultCwd: TMP, update: { enabled: false } }));
	const now = Date.now();
	for (const id of ["tp001", "tp002"]) {
		mkdirSync(join(HOME, "tasks", id), { recursive: true });
		const task = { id, machine: "cloud", rev: 1, title: `progress ${id}`, brief: "b", cwd: TMP, status: "running", statusSince: now - 60_000, createdAt: now - 60_000, updatedAt: now - 1000, source: { kind: "cli" }, attachments: [], unread: false, messages: 0, sessionFile: id === "tp001" ? SESSION : undefined };
		writeFileSync(join(HOME, "tasks", id, "task.json"), JSON.stringify(task));
	}
	writeFileSync(SESSION, line(now - 50_000, { role: "user", content: [{ type: "text", text: "简报" }] }) + line(now - 40_000, { role: "assistant", content: [{ type: "text", text: "开始做" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] }));
	hub = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env, stdio: "ignore" });
	for (let i = 0; i < 60; i++) {
		await new Promise((r) => setTimeout(r, 150));
		try {
			await api("GET", "/health");
			break;
		} catch {}
	}
	const res = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { authorization: "Bearer tok" }, signal: sse.signal });
	(async () => {
		const dec = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of res.body as any) {
				buf += dec.decode(chunk, { stream: true });
				let k;
				while ((k = buf.indexOf("\n\n")) >= 0) {
					const block = buf.slice(0, k);
					buf = buf.slice(k + 2);
					const data = block.split("\n").find((l) => l.startsWith("data: "));
					if (data) events.push(JSON.parse(data.slice(6)));
				}
			}
		} catch {}
	})();
	await new Promise((r) => setTimeout(r, 200));
});
after(async () => {
	sse.abort();
	if (hub) await new Promise((r) => (hub!.once("exit", r), hub!.kill("SIGTERM")));
	rmSync(TMP, { recursive: true, force: true });
});

test("old worker (activity only): plain words + milestones, nothing interrupts", async () => {
	events.length = 0;
	let t = await report("tp002", { activity: "bash cd /x && scripts/release.sh patch 2>&1 | tail -25", kind: "activity" });
	assert.equal(t.progress.now, "执行发布脚本");
	t = await report("tp002", { activity: "bash git push origin main", kind: "activity" });
	assert.deepEqual(t.progress.recent.map((m: any) => m.text), ["执行发布脚本", "推送代码"]);
	const pu = t.progress.updatedAt;
	await new Promise((r) => setTimeout(r, 150));
	const att = events.filter((e) => e.type === "attention" && e.item.taskId === "tp002");
	assert.ok(att.length >= 1);
	assert.equal(att.at(-1).item.reason, "进行中：推送代码");
	assert.ok(att.every((e) => e.interrupt === "none" && e.item.level === "inflight"));
	assert.ok(events.some((e) => e.type === "task" && e.task.id === "tp002" && e.task.progress?.now === "推送代码"));
	// activity does not bump progress.updatedAt
	t = await report("tp002", { activity: "read a.ts", kind: "activity" });
	assert.equal(t.progress.updatedAt, pu);
	const { counts } = await api("GET", "/api/attention");
	assert.equal(counts.need, 0);
});

test("worker plan: steps update live over SSE, persisted, event log lean, done completes the plan", async () => {
	events.length = 0;
	let t = await report("tp001", { kind: "progress", progress: { plan: ["改代码", "跑测试", { title: "发布 Release", expected_minutes: 10 }], current: 1, note: "开始改代码" } });
	assert.deepEqual(t.progress.steps.map((s: any) => s.state), ["active", "todo", "todo"]);
	assert.equal(t.progress.steps[2].expectedMinutes, 10);
	t = await report("tp001", { kind: "progress", progress: { current: 3, note: "正在发布：已打 tag，等 CI" } });
	assert.deepEqual(t.progress.steps.map((s: any) => s.state), ["done", "done", "active"]);
	await new Promise((r) => setTimeout(r, 150));
	const last = events.filter((e) => e.type === "task" && e.task.id === "tp001").at(-1);
	assert.equal(last.task.progress.note, "正在发布：已打 tag，等 CI");
	assert.ok(!events.some((e) => e.type === "attention" && e.interrupt !== "none"));
	const { items } = await api("GET", "/api/attention");
	assert.equal(items.find((i: any) => i.taskId === "tp001").reason, "进行中：3/3 发布 Release");
	const { task, events: evs } = await api("GET", "/api/tasks/tp001?events=20");
	assert.equal(task.progress.steps.length, 3);
	const pe = evs.filter((e: any) => e.kind === "progress").map((e: any) => e.text);
	assert.deepEqual(pe, ["计划：改代码 / 跑测试 / 发布 Release", "完成：改代码；完成：跑测试"]);
	// done → all steps done; a new run after done starts fresh
	t = await report("tp001", { status: "done", summary: "ok", kind: "report" });
	assert.ok(t.progress.steps.every((s: any) => s.state === "done"));
	t = await report("tp001", { status: "running", activity: "思考中" });
	assert.equal(t.progress.steps, undefined);
});

test("工作记录: paged from the session file, live tail", async () => {
	let page = await api("GET", "/api/tasks/tp001/transcript?limit=50");
	assert.equal(page.available, true);
	assert.deepEqual(page.entries.map((e: any) => e.kind), ["brief", "text", "tool"]);
	assert.equal(page.pendingFrom, 2);
	appendFileSync(SESSION, line(Date.now(), { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "pass 12" }] }) + line(Date.now(), { role: "user", content: [{ type: "text", text: "【quick-agent 追加指令】\n再跑一次" }] }));
	page = await api("GET", `/api/tasks/tp001/transcript?after=${page.pendingFrom - 1}`);
	assert.deepEqual(page.entries.map((e: any) => [e.i, e.kind]), [[2, "tool"], [3, "instruction"]]);
	assert.equal(page.entries[0].result, "pass 12");
	const none = await api("GET", "/api/tasks/tp002/transcript");
	assert.equal(none.available, false);
});
