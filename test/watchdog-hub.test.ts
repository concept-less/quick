// Watchdog on a real, isolated hub (own QA_HOME, port and tmux session): a fake worker that loops on the same
// failing command gets a correction, then 需要你 on the second STUCK; a steady worker that is merely slower
// than expected gets ON_TRACK silently. The reviewer is a deterministic mock (config watchdog.command).
// Also asserts isolation: neither the workers nor the reviewer see the real hub's identity (QA_TASK_ID,
// QA_HUB_URL, QA_TOKEN …), and the real ~/.quick-agent is not touched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "qa-watch-")));
const HOME = join(TMP, "qa-home");
const BIN = join(TMP, "bin");
const WORK = join(TMP, "work");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const SESSION = `qa-watchT${PORT}`;
const TOKEN = "tok-watch";
const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", QA_HOME: HOME, QA_PORT: String(PORT), QA_MACHINE: "mwatch", QA_UPDATE: "off", PATH: `${BIN}:${process.env.PATH}` };
// This test may itself run inside a quick-agent worker: never pass that identity on.
for (const k of Object.keys(env)) if (k.startsWith("QA_") && !["QA_HOME", "QA_PORT", "QA_MACHINE", "QA_UPDATE"].includes(k)) delete env[k];

// Real hub state before the test (must be unchanged afterwards).
const REAL_TASKS = join(homedir(), ".quick-agent", "tasks");
const realSnapshot = () => {
	const list = existsSync(REAL_TASKS) ? readdirSync(REAL_TASKS).sort() : [];
	const own = process.env.QA_TASK_ID ? join(REAL_TASKS, process.env.QA_TASK_ID, "events.jsonl") : "";
	return { list: list.join(","), events: own && existsSync(own) ? statSync(own).size : -1 };
};
let real0: ReturnType<typeof realSnapshot>;

let hub: ChildProcess | undefined;
async function api(method: string, path: string, body?: any) {
	const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const json = (await r.json()) as any;
	if (!r.ok) throw new Error(`${path}: ${json.error}`);
	return json;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | undefined> | T | undefined, ms: number, what: string): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await f();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timeout: ${what}`);
		await sleep(250);
	}
}
/** Messages the worker of a task actually received (task.message frames on its own stream). */
const received = (id: string): string[] =>
	readFileSync(join(HOME, "tasks", id, "fake-sse.txt"), "utf8").split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return {}; } }).filter((e: any) => e.type === "task.message" && e.taskId === id).map((e: any) => e.text);
const getTask = async (id: string) => (await api("GET", `/api/tasks/${id}?events=50`)).task;

// Fake worker: reports to the isolated hub only, writes a pi-like JSONL record of its tool calls, keeps
// the SSE stream of its messages in fake-sse.txt. MODE=loop repeats one failing command; MODE=steady makes progress.
const FAKE_PI = `#!/usr/bin/env bash
brief=""; for a in "$@"; do case $a in @*) brief=\${a#@};; esac; done
dir=$(dirname "$brief"); sess="$dir/fake-session.jsonl"
mode=$(grep -o 'MODE=[a-z]*' "$brief" | head -1 | cut -d= -f2)
env > "$dir/fake-env.txt"
H="http://127.0.0.1:${PORT}"
r() { curl -sf -X POST -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' "$H/api/tasks/$QA_TASK_ID/report" -d "$1" >/dev/null; }
curl -sN -H "authorization: Bearer ${TOKEN}" "$H/api/events?task=$QA_TASK_ID&role=worker" >> "$dir/fake-sse.txt" &
n=0
call() { n=$((n+1)); ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  printf '{"type":"message","timestamp":"%s","message":{"role":"assistant","content":[{"type":"toolCall","id":"c%s","name":"bash","arguments":{"command":"%s"}}]}}\\n' "$ts" $n "$1" >> "$sess"
  printf '{"type":"message","timestamp":"%s","message":{"role":"toolResult","toolCallId":"c%s","toolName":"bash","content":[{"type":"text","text":"%s"}],"isError":%s}}\\n' "$ts" $n "$2" "$3" >> "$sess"; }
: > "$sess"
sleep 1 # let the hub finish spawning (it marks the task "starting" after tmux returns)
r "{\\"sessionFile\\":\\"$sess\\",\\"kind\\":\\"session\\",\\"activity\\":\\"worker 已连接\\"}"
r '{"status":"running","activity":"思考中"}'
for i in $(seq 1 400); do
  if [ "$mode" = loop ]; then call "npm run build" "Error: Cannot find module ./missing.js" true; r '{"activity":"bash npm run build"}'
  else call "edit step $i" "applied change $i" false; r "{\\"status\\":\\"running\\",\\"summary\\":\\"第 $i 步完成\\",\\"kind\\":\\"report\\"}"; fi
  sleep 0.5
done
`;

// Mock reviewer: STUCK when the hub detected a repeated pattern, ON_TRACK otherwise; records its environment.
const MOCK_REVIEWER = `import { readFileSync, appendFileSync } from "node:fs";
const prompt = readFileSync(process.argv[2], "utf8");
appendFileSync(${JSON.stringify(join(TMP, "reviewer-env.jsonl"))}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QA_")))) + "\\n");
const repeated = /## 检测到的重复模式\\n- /.test(prompt);
console.log("分析：" + (repeated ? "同一条命令反复失败" : "每一步都有新结果"));
console.log(JSON.stringify(repeated
  ? { verdict: "STUCK", evidence: "npm run build 连续失败，错误相同：Cannot find module ./missing.js", advice: "先确认 ./missing.js 为什么不存在，不要再重复同一条命令" }
  : { verdict: "ON_TRACK", evidence: "每一步都有新的结果，在稳步推进", expected: "10m" }));
`;

before(async () => {
	real0 = realSnapshot();
	mkdirSync(HOME, { recursive: true });
	mkdirSync(BIN, { recursive: true });
	mkdirSync(WORK, { recursive: true });
	writeFileSync(join(BIN, "pi"), FAKE_PI, { mode: 0o755 });
	writeFileSync(join(TMP, "reviewer.mjs"), MOCK_REVIEWER);
	writeFileSync(
		join(HOME, "config.json"),
		JSON.stringify({
			host: "127.0.0.1", port: PORT, token: TOKEN, model: "fake/fake", tmuxSession: SESSION, defaultCwd: WORK, machine: { id: "mwatch" }, update: { enabled: false },
			watchdog: { tickSeconds: 0.5, cooldownMinutes: 0.05, stallMinutes: 0, maxCorrections: 1, command: [process.execPath, join(TMP, "reviewer.mjs")] },
		}),
	);
	hub = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env, stdio: "ignore" });
	await until(() => api("GET", "/health").catch(() => undefined), 15_000, "hub start");
});

after(() => {
	hub?.kill();
	try {
		execFileSync("tmux", ["kill-session", "-t", `=${SESSION}`], { stdio: "ignore" });
	} catch {}
	rmSync(TMP, { recursive: true, force: true });
});

test("looping worker: STUCK → correction to the worker → STUCK again → 需要你 [CHECK]; answer clears it", async () => {
	const { task } = await api("POST", "/api/tasks", { title: "兜圈子的模拟任务", brief: "MODE=loop 构建项目", cwd: WORK, expected: "3s" });
	assert.equal(task.expect.minutes, 0.05);
	assert.equal(task.expect.source, "dispatch");
	const id = task.id;
	const corrected = await until(async () => {
		const t = await getTask(id);
		return t.watch?.reviews?.find((r: any) => r.action === "corrected") ? t : undefined;
	}, 20_000, "first STUCK review");
	const first = corrected.watch.reviews.find((r: any) => r.action === "corrected");
	assert.equal(first.verdict, "STUCK");
	assert.match(first.advice, /missing\.js/);
	// the correction reached the worker through the normal message path
	await until(() => received(id).some((x) => x.includes("巡检纠偏")), 5000, "correction delivered to the worker");
	const escalated = await until(async () => {
		const t = await getTask(id);
		return t.watch?.pending ? t : undefined;
	}, 20_000, "escalation");
	assert.equal(escalated.watch.pending.verdict, "STUCK");
	assert.equal(escalated.status, "running", "the watchdog never stops the task");
	const q = await api("GET", "/api/attention?archived=0");
	const item = q.items.find((i: any) => i.taskId === id);
	assert.equal(item.level, "need");
	assert.equal(item.mark, "[CHECK]");
	assert.ok(item.options.length >= 2);
	// no more reviews while it waits for the human
	const n = escalated.watch.reviews.length;
	await sleep(1500);
	assert.equal((await getTask(id)).watch.reviews.length, n);
	// the human answers: escalation cleared, the worker receives the answer with the question's context
	await api("POST", `/api/tasks/${id}/message`, { text: "按巡检建议换个方法继续" });
	const t2 = await getTask(id);
	assert.equal(t2.watch.pending, undefined);
	assert.equal(t2.watch.corrections, 0);
	assert.equal((await api("GET", "/api/attention?archived=0")).items.find((i: any) => i.taskId === id).level, "inflight");
	await until(() => received(id).some((x) => x.includes("这是对巡检问题的回答")), 5000, "answer delivered with context");
	await api("POST", `/api/tasks/${id}/cancel`, {});
});

test("steady worker over its expectation: ON_TRACK, new expectation, nobody is bothered", async () => {
	const { task } = await api("POST", "/api/tasks", { title: "正常但比预估慢的任务", brief: "MODE=steady 一步步做", cwd: WORK, expected: "3s" });
	const id = task.id;
	const t = await until(async () => {
		const x = await getTask(id);
		return x.watch?.reviews?.some((r: any) => r.verdict) ? x : undefined;
	}, 20_000, "ON_TRACK review");
	const r = t.watch.reviews[0];
	assert.equal(r.trigger, "overtime");
	assert.equal(r.verdict, "ON_TRACK");
	assert.equal(r.action, "silent");
	assert.equal(t.expect.source, "watchdog");
	assert.equal(t.expect.minutes, 10);
	assert.equal(t.watch.pending, undefined);
	assert.ok(!received(id).some((x) => x.includes("巡检纠偏")), "no message to the worker");
	const item = (await api("GET", "/api/attention?archived=0")).items.find((i: any) => i.taskId === id);
	assert.equal(item.level, "inflight");
	assert.match(item.timing, / \/ 10m$/);
	await api("POST", `/api/tasks/${id}/cancel`, {});
});

test("per-task switch, worker revision once with a reason, default expectation", async () => {
	const { task } = await api("POST", "/api/tasks", { title: "长时间轮询", brief: "MODE=loop 盯 CI", cwd: WORK, watch: false });
	assert.equal(task.watch.off, true);
	assert.equal(task.expect.source, "default");
	await sleep(3000);
	assert.equal((await getTask(task.id)).watch.reviews.length, 0, "watchdog off: no reviews");
	await assert.rejects(api("POST", `/api/tasks/${task.id}/report`, { expect: { expected: "2h" } }), /理由/);
	const r = await api("POST", `/api/tasks/${task.id}/report`, { expect: { expected: "2h", reason: "CI 要排队" } });
	assert.equal(r.task.expect.minutes, 120);
	assert.equal(r.task.expect.source, "worker");
	await assert.rejects(api("POST", `/api/tasks/${task.id}/report`, { expect: { expected: "3h", reason: "again" } }), /修正过一次/);
	const on = await api("POST", `/api/tasks/${task.id}/watch`, { off: false });
	assert.equal(on.task.watch.off, false);
	await api("POST", `/api/tasks/${task.id}/cancel`, {});
});

test("isolation: workers and the reviewer only know the temporary hub; the real hub is untouched", () => {
	const ids = readdirSync(join(HOME, "tasks"));
	assert.ok(ids.length >= 3);
	for (const id of ids) {
		const f = join(HOME, "tasks", id, "fake-env.txt");
		if (!existsSync(f)) continue;
		const vars = Object.fromEntries(readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("QA_")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		assert.equal(vars.QA_HOME, HOME);
		assert.equal(vars.QA_TASK_ID, id, "the worker's own task, not the outer one");
		assert.equal(vars.QA_HUB_URL, `http://127.0.0.1:${PORT}`, "only the isolated hub");
		assert.equal(vars.QA_TOKEN, readFileSync(join(HOME,"tasks",id,"worker.token"),"utf8").trim(), "restricted own-worker token");
		assert.notEqual(vars.QA_TOKEN, TOKEN, "never inherit hub root identity");
	}
	const reviewers = readFileSync(join(TMP, "reviewer-env.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(reviewers.length >= 3, `reviewer runs: ${reviewers.length}`);
	for (const e of reviewers) {
		assert.deepEqual(Object.keys(e).sort(), ["QA_WATCH_TASK", "QA_WATCH_TRIGGER"], "reviewer has no quick-agent identity");
	}
	assert.deepEqual(realSnapshot(), real0, "real ~/.quick-agent unchanged");
});
