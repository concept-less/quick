#!/usr/bin/env node
// End-to-end check of expected time + watchdog with the REAL reviewer agent (pi -p, read-only tools) in a fully
// isolated environment: own QA_HOME, hub port, Web UI port and tmux session. Workers are fake (a script named
// `pi` on the hub's PATH) so their behaviour is deterministic:
//   - loop:   runs the same failing build command every 10s       → expected STUCK, correction, STUCK again → 需要你
//   - steady: makes visible progress on a list of files every 10s → expected ON_TRACK, new estimate, silent
// Both get an expectation of 1m, so the first review is an overtime review (1.5x = 90s).
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core [CHROMIUM=…] [WATCH_MODEL=tokenjoy/claude-sonnet-5-5] node test/watchdog-e2e.mjs [--shots DIR] [--keep]
//
// Isolation: every QA_* variable of the calling environment (QA_TASK_ID, QA_HUB_URL, QA_TOKEN …) is dropped; the
// script fails if the real ~/.quick-agent changes or if a worker / the reviewer saw anything but the temporary hub.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const SHOTS = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : undefined;
const TMP = mkdtempSync(join(tmpdir(), "qa-watch-e2e-"));
const HOME = join(TMP, "home");
const PORT = 22000 + Math.floor(Math.random() * 20000);
const UI_PORT = PORT + 1;
const TOKEN = "tok-watch-e2e";
const SESSION = `qa-watchE${PORT}`;
const MODEL = process.env.WATCH_MODEL || "tokenjoy/claude-sonnet-5-5";
const REAL_PI = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

const REAL_TASKS = join(homedir(), ".quick-agent", "tasks");
const outer = process.env.QA_TASK_ID;
const realSnapshot = () => ({
	list: existsSync(REAL_TASKS) ? readdirSync(REAL_TASKS).sort().join(",") : "",
	own: outer && existsSync(join(REAL_TASKS, outer, "task.json")) ? JSON.parse(readFileSync(join(REAL_TASKS, outer, "task.json"), "utf8")).status : "",
});
const real0 = realSnapshot();

const BIN = join(TMP, "bin");
const WORK = join(TMP, "work");
for (const d of [HOME, BIN, WORK]) mkdirSync(d, { recursive: true });
writeFileSync(
	join(BIN, "pi"),
	`#!/usr/bin/env bash
brief=""; for a in "$@"; do case $a in @*) brief=\${a#@};; esac; done
dir=$(dirname "$brief"); sess="$dir/fake-session.jsonl"
mode=$(grep -o 'MODE=[a-z]*' "$brief" | head -1 | cut -d= -f2)
env > "$dir/fake-env.txt"
H="http://127.0.0.1:${PORT}"
r() { curl -sf -X POST -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' "$H/api/tasks/$QA_TASK_ID/report" -d "$1" >/dev/null; }
curl -sN -H "authorization: Bearer ${TOKEN}" "$H/api/events?task=$QA_TASK_ID&role=worker" >> "$dir/fake-sse.txt" &
n=0
call() { n=$((n+1)); ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  printf '{"type":"message","timestamp":"%s","message":{"role":"assistant","content":[{"type":"toolCall","id":"c%s","name":"%s","arguments":%s}]}}\\n' "$ts" $n "$1" "$2" >> "$sess"
  printf '{"type":"message","timestamp":"%s","message":{"role":"toolResult","toolCallId":"c%s","toolName":"%s","content":[{"type":"text","text":"%s"}],"isError":%s}}\\n' "$ts" $n "$1" "$3" "$4" >> "$sess"; }
: > "$sess"
sleep 1 # let the hub finish spawning (it marks the task "starting" after tmux returns)
r "{\\"sessionFile\\":\\"$sess\\",\\"kind\\":\\"session\\",\\"activity\\":\\"worker 已连接\\"}"
r '{"status":"running","activity":"思考中"}'
if [ "$mode" = loop ]; then
  call read '{"path":"package.json"}' '{ \\"scripts\\": { \\"build\\": \\"node src/index.js\\" } }' false
  for i in $(seq 1 200); do
    call bash '{"command":"npm run build"}' "Error: Cannot find module './missing.js'\\nRequire stack:\\n- src/index.js\\nCommand exited with code 1" true
    r '{"activity":"bash npm run build"}'; sleep 10
  done
else
  r '{"status":"running","summary":"计划：给 docs/ 下 20 个文件逐个补充用法说明，每个文件改完检查一遍链接。","kind":"report"}'
  for i in $(seq 1 200); do
    call read "{\\"path\\":\\"docs/file$i.md\\"}" "# file$i\\n(没有用法说明)" false
    call edit "{\\"path\\":\\"docs/file$i.md\\",\\"edits\\":[{\\"oldText\\":\\"(没有用法说明)\\",\\"newText\\":\\"## 用法 $i\\"}]}" "Successfully replaced 1 block(s) in docs/file$i.md." false
    r "{\\"status\\":\\"running\\",\\"summary\\":\\"已完成 $i/20 个文件的用法说明（docs/file$i.md）\\",\\"kind\\":\\"report\\"}"; sleep 10
  done
fi
`,
	{ mode: 0o755 },
);
writeFileSync(
	join(HOME, "config.json"),
	JSON.stringify({
		host: "127.0.0.1", port: PORT, uiPort: UI_PORT, token: TOKEN, model: "fake/fake", tmuxSession: SESSION, defaultCwd: WORK, machine: { id: "demo" }, update: { enabled: false },
		watchdog: { tickSeconds: 2, cooldownMinutes: 0.5, stallMinutes: 0, repeatThreshold: 12, maxCorrections: 1, model: MODEL, thinking: "low", piBin: REAL_PI, timeoutMinutes: 4 },
	}),
);
const env = { ...process.env, QA_HOME: HOME, QA_PORT: String(PORT), QA_UI_PORT: String(UI_PORT), QA_UPDATE: "off", NODE_NO_WARNINGS: "1" };
for (const k of Object.keys(env)) if (k.startsWith("QA_") && !["QA_HOME", "QA_PORT", "QA_UI_PORT", "QA_UPDATE"].includes(k)) delete env[k];
delete env.TMUX;
// The Web UI hosts a front agent: give it its own agent dir (this checkout as the only package).
const agentDir = join(TMP, "agent");
mkdirSync(agentDir);
const realAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
for (const f of ["auth.json", "models-store.json"]) if (existsSync(join(realAgent, f))) cpSync(join(realAgent, f), join(agentDir, f));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO] }));

const api = async (method, path, body) => {
	const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const j = await r.json();
	if (!r.ok) throw new Error(`${path}: ${j.error}`);
	return j;
};
/** Messages the worker of a task actually received (task.message frames on its own stream). */
const received = (id) => {
	const f = join(HOME, "tasks", id, "fake-sse.txt");
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return {}; } }).filter((e) => e.type === "task.message" && e.taskId === id).map((e) => e.text);
};
const task = async (id) => (await api("GET", `/api/tasks/${id}?events=0`)).task;
async function until(f, ms, what) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await f().catch(() => undefined);
		if (v) return v;
		if (Date.now() > end) throw new Error(`timeout: ${what}`);
		await sleep(1000);
	}
}

const procs = [];
let browser;
async function cleanup() {
	await browser?.close().catch(() => {});
	for (const p of procs) p.kill();
	spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`]);
	if (!KEEP) rmSync(TMP, { recursive: true, force: true });
}
const fail = async (msg) => {
	console.error(`FAIL: ${msg}\n(hub log: ${HOME}/hub.log${KEEP ? "" : "; rerun with --keep to inspect"})`);
	try {
		console.error(readFileSync(join(HOME, "hub.log"), "utf8").split("\n").slice(-30).join("\n"));
	} catch {}
	await cleanup();
	process.exit(1);
};

try {
	const hubLog = join(HOME, "hub.log");
	const hub = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: { ...env, PATH: `${BIN}:${process.env.PATH}` }, stdio: ["ignore", "inherit", "inherit"] });
	procs.push(hub);
	await until(() => api("GET", "/health"), 15_000, "hub start");
	log(`hub on :${PORT} (QA_HOME ${HOME}), reviewer ${MODEL} via ${REAL_PI}`);
	void hubLog;

	// attention events as a front end sees them
	const events = [];
	const ac = new AbortController();
	void (async () => {
		const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of r.body) {
			buf += dec.decode(chunk, { stream: true });
			let i;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (frame.startsWith("data: ")) {
					const e = JSON.parse(frame.slice(6));
					if (e.type === "attention") events.push({ id: e.item.taskId, level: e.item.level, mark: e.item.mark, interrupt: e.interrupt });
				}
			}
		}
	})().catch(() => {});

	const loop = (await api("POST", "/api/tasks", { title: "修复构建（模拟：反复执行同一条失败命令）", brief: "MODE=loop 让 npm run build 通过。项目入口 src/index.js。", cwd: WORK, expected: "1m" })).task;
	const steady = (await api("POST", "/api/tasks", { title: "给 docs 补用法说明（模拟：正常但比预估慢）", brief: "MODE=steady 给 docs/ 下 20 个 markdown 文件逐个补充「用法」一节。", cwd: WORK, expected: "1m" })).task;
	log(`loop ${loop.id}, steady ${steady.id}, both expected 1m`);

	// UI
	const ui = spawn(process.execPath, [join(REPO, "ui", "server.ts"), "--cwd", WORK], { env: { ...env, PI_CODING_AGENT_DIR: agentDir }, stdio: "ignore" });
	procs.push(ui);
	let page;
	if (SHOTS) {
		const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
		browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
		page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
		mkdirSync(SHOTS, { recursive: true });
		await until(async () => (await fetch(`http://127.0.0.1:${UI_PORT}/`)).status < 500, 20_000, "ui start");
		await page.goto(`http://127.0.0.1:${UI_PORT}/?token=${TOKEN}`);
		await page.waitForSelector(".titem", { timeout: 20_000 });
	}
	const shot = async (name, openId) => {
		if (!page) return;
		await page.reload();
		await page.waitForSelector(".titem", { timeout: 20_000 });
		if (openId) {
			await page.click(`.titem[data-id="${openId}"]`);
			await page.waitForSelector("#detail.on .dbody", { timeout: 10_000 });
			await sleep(800);
		}
		await page.screenshot({ path: join(SHOTS, name) });
		log(`screenshot ${name}`);
	};

	// 1. overtime → first review of both
	const firstLoop = await until(async () => (await task(loop.id)).watch?.reviews?.find((r) => r.verdict || r.error), 6 * 60_000, "first review of the loop task");
	log(`loop review 1: [${firstLoop.verdict ?? "ERROR"}] trigger=${firstLoop.trigger} action=${firstLoop.action}\n    依据: ${firstLoop.evidence ?? firstLoop.error}\n    建议: ${firstLoop.advice ?? "-"}`);
	if (firstLoop.trigger !== "overtime") await fail(`first trigger should be overtime, got ${firstLoop.trigger}`);
	if (firstLoop.verdict !== "STUCK" || firstLoop.action !== "corrected") await fail(`loop task: expected STUCK + corrected, got ${firstLoop.verdict}/${firstLoop.action}`);
	await until(async () => received(loop.id).some((x) => x.includes("巡检纠偏")), 10_000, "correction delivered").catch(() => fail("correction did not reach the worker"));
	log("correction delivered to the loop worker (追加指令)");

	const firstSteady = await until(async () => (await task(steady.id)).watch?.reviews?.find((r) => r.verdict || r.error), 6 * 60_000, "first review of the steady task");
	const st = await task(steady.id);
	log(`steady review 1: [${firstSteady.verdict ?? "ERROR"}] trigger=${firstSteady.trigger} action=${firstSteady.action} expect=${st.expect.minutes}m (${st.expect.source})\n    依据: ${firstSteady.evidence ?? firstSteady.error}`);
	if (firstSteady.verdict !== "ON_TRACK" || firstSteady.action !== "silent" || st.expect.source !== "watchdog") await fail(`steady task: expected ON_TRACK silent, got ${firstSteady.verdict}/${firstSteady.action}`);
	if (received(steady.id).length) await fail("steady worker got a correction");
	await shot("1-queue-over.png");
	await shot("2-steady-on-track.png", steady.id);

	// 2. follow-up after the cooldown: still STUCK → 需要你
	const esc = await until(async () => {
		const t = await task(loop.id);
		return t.watch?.pending ? t : undefined;
	}, 8 * 60_000, "escalation of the loop task");
	const last = esc.watch.reviews.at(-1);
	log(`loop review ${esc.watch.reviews.length}: [${last.verdict}] trigger=${last.trigger} action=${last.action}\n    问题: ${esc.watch.pending.question}\n    选项: ${(esc.watch.pending.options ?? []).join(" / ")}`);
	const item = (await api("GET", "/api/attention?archived=0")).items.find((i) => i.taskId === loop.id);
	if (item?.level !== "need" || item.mark !== "[CHECK]") await fail(`loop task should be 需要你 [CHECK], got ${item?.level} ${item?.mark}`);
	await sleep(1500);
	if (!events.some((e) => e.id === loop.id && e.level === "need" && e.interrupt === "now")) await fail("no interrupt=now for the escalation");
	if (events.some((e) => e.id === steady.id && e.interrupt !== "none")) await fail("the steady task interrupted someone");
	log(`attention: ${loop.id} → 需要你 [CHECK] (interrupt now); ${steady.id} never interrupted (${events.filter((e) => e.id === steady.id).length} quiet attention events)`);
	await shot("3-queue-need.png");
	await shot("4-loop-detail.png", loop.id);

	// isolation
	for (const id of [loop.id, steady.id]) {
		const vars = readFileSync(join(HOME, "tasks", id, "fake-env.txt"), "utf8");
		if (!vars.includes(`QA_HOME=${HOME}\n`) || !vars.includes(`QA_TASK_ID=${id}\n`) || /^QA_(HUB_URL|TOKEN)=/m.test(vars)) await fail(`worker ${id} environment is not isolated`);
	}
	const real1 = realSnapshot();
	if (real1.list !== real0.list || real1.own !== real0.own) await fail(`the real ~/.quick-agent changed: ${JSON.stringify(real0)} → ${JSON.stringify(real1)}`);
	log("isolation: workers only knew the temporary hub; the real ~/.quick-agent is unchanged");

	ac.abort();
	await cleanup();
	log("ALL PASSED");
} catch (e) {
	await fail(e.message);
}
