#!/usr/bin/env node
// End-to-end demo of task progress + 工作记录 in a fully isolated environment:
//   hub + Web UI from this checkout on temp ports → a simulated worker (connected like a real one: SSE as
//   role=worker, qa_progress reports, writes its pi session file) and an "old" worker that only sends raw
//   activity → headless Chromium: step list updates live, card shows "n/m step", nothing interrupts,
//   the work log tails live, keeps your scroll position, pages back, and a 追加指令 sent from the pinned
//   composer shows up in the log together with the worker's answer.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROMIUM=/path/to/chrome] node test/e2e-progress.mjs [--keep] [--shots DIR]
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const SHOTS = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : undefined;
const TMP = mkdtempSync(join(tmpdir(), "qa-e2e-progress-"));
const PORT = 21000 + Math.floor(Math.random() * 20000);
const UI_PORT = PORT + 1;
const HOME = join(TMP, "home");
const TOKEN = "e2e-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");

const agentDir = join(TMP, "pi-agent");
mkdirSync(agentDir, { recursive: true });
const realAgent = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
for (const f of ["auth.json", "models-store.json", "models.json"]) if (existsSync(join(realAgent, f))) cpSync(join(realAgent, f), join(agentDir, f));
const s0 = existsSync(join(realAgent, "settings.json")) ? JSON.parse(readFileSync(join(realAgent, "settings.json"), "utf8")) : {};
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: s0.defaultProvider, defaultModel: s0.defaultModel, packages: [REPO] }));
mkdirSync(join(HOME, "tasks"), { recursive: true });
writeFileSync(join(HOME, "config.json"), JSON.stringify({ host: "127.0.0.1", port: PORT, uiPort: UI_PORT, token: TOKEN, tmuxSession: `qa-e2ep-${process.pid}`, defaultCwd: TMP, machine: { id: "demo" }, update: { enabled: false } }));
const env = { ...process.env, QA_HOME: HOME, QA_PORT: String(PORT), QA_UI_PORT: String(UI_PORT), QA_UPDATE: "off", PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" };
for (const k of ["QA_TASK_ID", "QA_ROLE", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "TMUX"]) delete env[k];
const quick = (...args) => execFileSync(process.execPath, [join(REPO, "cli", "quick.ts"), ...args], { env, encoding: "utf8", timeout: 120_000 });

// ---------------------------------------------------------------- fixtures
const now = Date.now();
const sess = (id) => join(TMP, `${id}.jsonl`);
const msg = (message, ts = Date.now()) => `${JSON.stringify({ type: "message", id: String(ts) + Math.random(), timestamp: new Date(ts).toISOString(), message })}\n`;
const fixture = (id, title, extra) => {
	mkdirSync(join(HOME, "tasks", id), { recursive: true });
	writeFileSync(join(HOME, "tasks", id, "task.json"), JSON.stringify({ id, machine: "demo", rev: 1, title, brief: `${title}\n\n验收：...`, cwd: TMP, status: "running", statusSince: now - 9 * 60_000, createdAt: now - 9 * 60_000, updatedAt: now - 1000, source: { kind: "cli" }, attachments: [], unread: false, messages: 0, sessionFile: sess(id), ...extra }));
};
fixture("t0a01", "发布 v0.4.1 并迁移两台机器");
fixture("t0a02", "迁移 mac + cloud 到 Release 安装（老 worker）");
fixture("t0a03", "整理并推送提交", { status: "done", unread: false, ackedAt: now - 1000, progress: { steps: [{ title: "整理提交", state: "done" }, { title: "跑测试", state: "done" }, { title: "推送", state: "done" }], startedAt: now - 3_600_000, updatedAt: now - 3_000_000 } });
// a long history for t0a01 (scroll back), the others short
let hist = msg({ role: "user", content: [{ type: "text", text: "<file name=\"brief.md\"># 任务 t0a01: 发布 v0.4.1</file>\n以上是你负责的任务简报" }] }, now - 9 * 60_000);
for (let k = 0; k < 70; k++) {
	const ts = now - 9 * 60_000 + k * 6000;
	hist += msg({ role: "assistant", content: [{ type: "thinking", thinking: `看看第 ${k} 个文件` }, { type: "toolCall", id: `h${k}`, name: k % 5 === 4 ? "bash" : "read", arguments: k % 5 === 4 ? { command: `cd /repo && git log --oneline -${k}` } : { path: `/repo/src/file${k}.ts` } }] }, ts);
	hist += msg({ role: "toolResult", toolCallId: `h${k}`, toolName: k % 5 === 4 ? "bash" : "read", content: [{ type: "text", text: `line 1 of result ${k}\nline 2` }] }, ts + 500);
}
writeFileSync(sess("t0a01"), hist);
writeFileSync(sess("t0a02"), msg({ role: "user", content: [{ type: "text", text: "brief" }] }, now - 60_000));
writeFileSync(sess("t0a03"), msg({ role: "user", content: [{ type: "text", text: "brief" }] }, now - 3_600_000) + msg({ role: "assistant", content: [{ type: "text", text: "提交已整理并推送。" }, { type: "toolCall", id: "r", name: "qa_report", arguments: { status: "done", summary: "已推送 3 个提交到 origin/main" } }] }, now - 3_000_000));

// ---------------------------------------------------------------- simulated workers
const hubUrl = `http://127.0.0.1:${PORT}`;
const api = async (method, path, body) => {
	const r = await fetch(hubUrl + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const j = await r.json();
	if (!r.ok) throw new Error(`${path}: ${j.error}`);
	return j;
};
const report = (id, body) => api("POST", `/api/tasks/${id}/report`, body);
let callN = 0;
/** One tool call of the simulated worker: activity ping + call + result in the session file. */
async function tool(id, name, args, result, ms = 400) {
	const cid = `c${++callN}`;
	await report(id, { activity: `${name} ${args.command ?? args.path ?? ""}`, kind: "activity" });
	appendFileSync(sess(id), msg({ role: "assistant", content: [{ type: "toolCall", id: cid, name, arguments: args }] }));
	await sleep(ms);
	appendFileSync(sess(id), msg({ role: "toolResult", toolCallId: cid, toolName: name, content: [{ type: "text", text: result }], ...(name === "edit" ? { details: { diff: " 12 const a = 1;\n-13 const v = \"0.4.0\";\n+13 const v = \"0.4.1\";\n 14 export {}" } } : {}) }));
}
const say = (id, text) => appendFileSync(sess(id), msg({ role: "assistant", content: [{ type: "text", text }] }));
const answered = [];
let stopWorkers = false;
const sse = new AbortController();
async function connectWorker(id) {
	// Same connection a real worker opens (extensions/worker.ts): the hub then delivers 追加指令 live.
	const res = await fetch(`${hubUrl}/api/events?role=worker&task=${id}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: sse.signal });
	(async () => {
		const dec = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of res.body) {
				buf += dec.decode(chunk, { stream: true });
				let k;
				while ((k = buf.indexOf("\n\n")) >= 0) {
					const data = buf.slice(0, k).split("\n").find((l) => l.startsWith("data: "));
					buf = buf.slice(k + 2);
					const e = data && JSON.parse(data.slice(6));
					if (e?.type === "task.message" && e.taskId === id) {
						appendFileSync(sess(id), msg({ role: "user", content: [{ type: "text", text: `【quick-agent 追加指令】\n${e.text}` }] }));
						await sleep(1200);
						say(id, `收到：${e.text}。我在发布完成后顺手更新 CHANGELOG。`);
						await report(id, { kind: "progress", progress: { note: "收到追加指令：发布后更新 CHANGELOG" } });
						answered.push(e.text);
					}
				}
			}
		} catch {}
	})();
}
async function newWorker() {
	const id = "t0a01";
	await connectWorker(id);
	await report(id, { status: "running", activity: "思考中" });
	await report(id, { kind: "progress", progress: { plan: ["核对改动", "跑测试", { title: "打 tag 并推送", expected_minutes: 2 }, { title: "等 CI 构建 dmg", expected_minutes: 12 }, "发布 Release", "迁移两台机器"], current: 2, note: "改动已核对，正在跑测试" } });
	say(id, "改动已核对，开始跑测试。");
	await tool(id, "bash", { command: "cd /repo && npm test 2>&1 | tail -5" }, "# tests 100\n# pass 100\n# fail 0", 1500);
	for (let r = 0; !stopWorkers; r++) {
		await report(id, { kind: "progress", progress: { current: 3, note: "测试全过，正在打 tag v0.4.1" } });
		await tool(id, "edit", { path: "/repo/package.json", edits: [{ oldText: '"0.4.0"', newText: '"0.4.1"' }] }, "Successfully replaced 1 block(s) in /repo/package.json.");
		await tool(id, "bash", { command: "cd /repo && git commit -am 'release v0.4.1' && git tag v0.4.1 && git push origin main --tags" }, "To github.com:concept-less/quick.git\n * [new tag] v0.4.1 -> v0.4.1", 1200);
		await report(id, { kind: "progress", progress: { current: 4, note: "正在发布 v0.4.1：已打 tag，等 CI 构建 dmg", eta: "约 10 分钟" } });
		say(id, "tag 已推送，等 CI 构建。");
		for (let k = 0; k < 6 && !stopWorkers; k++) await tool(id, "bash", { command: "gh run watch 12345 --exit-status" }, `build ${k * 15}%`, 1500);
		if (r > 50) break;
	}
}
async function oldWorker() {
	// An older worker: no qa_progress, only raw activity lines.
	const id = "t0a02";
	const cmds = ["bash cd /Users/tianyu/quick-agent && scripts/release.sh patch 2>&1 | tail -25", "bash git push origin main", "bash ssh devbox 'quick update'", "edit /Users/tianyu/quick-agent/install.sh", "bash npm test 2>&1 | tail"];
	for (let k = 0; !stopWorkers && k < 400; k++) {
		const a = cmds[k % cmds.length];
		await report(id, { activity: a, kind: "activity" });
		const [name, ...rest] = a.split(" ");
		appendFileSync(sess(id), msg({ role: "assistant", content: [{ type: "toolCall", id: `o${k}`, name, arguments: name === "bash" ? { command: rest.join(" ") } : { path: rest.join(" ") } }] }) + msg({ role: "toolResult", toolCallId: `o${k}`, toolName: name, content: [{ type: "text", text: "ok" }] }));
		await sleep(1800);
	}
}

// ---------------------------------------------------------------- run
let browser;
async function cleanup() {
	stopWorkers = true;
	sse.abort();
	await browser?.close().catch(() => {});
	for (const f of ["ui.pid", "hub.pid"]) {
		try {
			process.kill(Number(readFileSync(join(HOME, f), "utf8")), "SIGTERM");
		} catch {}
	}
	spawnSync("tmux", ["kill-session", "-t", `=qa-e2ep-${process.pid}`]);
	if (!KEEP) rmSync(TMP, { recursive: true, force: true });
}
const checks = {};
const check = (name, ok) => ((checks[name] = !!ok), log(`${ok ? "ok  " : "FAIL"} ${name}`));
const shot = async (page, name, el) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await (el ? page.locator(el).screenshot({ path: join(SHOTS, name) }) : page.screenshot({ path: join(SHOTS, name) }));
};

try {
	log("quick ui --no-open");
	process.stdout.write(quick("ui", "--no-open", "--cwd", TMP).replace(/^/gm, "    "));
	void newWorker();
	void oldWorker();
	await sleep(2500);

	browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`http://127.0.0.1:${UI_PORT}/?token=${TOKEN}`);
	await page.waitForSelector('.titem[data-id="t0a01"]', { timeout: 20_000 });
	await page.waitForFunction(() => /3\/6|4\/6/.test(document.querySelector('.titem[data-id="t0a01"]')?.textContent ?? ""), null, { timeout: 15_000 });
	const card = await page.textContent('.titem[data-id="t0a01"]');
	check(`card shows step progress ("${card.match(/进行中：[^\d]*\d\/6 [^\s]+( [^\s]+)?/)?.[0]}")`, /进行中：\d\/6/.test(card));
	check("card has a thin progress bar", await page.locator('.titem[data-id="t0a01"] .pbar').count());
	const oldCard = await page.textContent('.titem[data-id="t0a02"]');
	check(`old worker card is plain words ("${oldCard.match(/进行中：\S+/)?.[0]}")`, /进行中：/.test(oldCard) && !/scripts\/release\.sh|git push|ssh devbox/.test(oldCard));
	await shot(page, "1-list.png", "#side");

	// detail: steps + now line + raw command collapsed
	await page.click('.titem[data-id="t0a01"]');
	await page.waitForSelector("#dprog .steps li");
	const steps0 = await page.$$eval("#dprog .steps li", (l) => l.map((x) => x.className));
	check(`detail step list ${steps0.join(",")}`, steps0.length === 6 && steps0[0] === "done");
	check("raw command folded into 细节 (closed)", (await page.locator("#dprog details.praw").count()) === 1 && !(await page.$eval("#dprog details.praw", (d) => d.open)));
	await page.waitForFunction(() => /4/.test(String([...document.querySelectorAll("#dprog .steps li")].findIndex((x) => x.className === "active") + 1)), null, { timeout: 20_000 });
	check("step list updated live without reopening (step 4 active)", true);
	const nowLine = await page.textContent("#dprog .pnow");
	check(`now line is the worker's sentence ("${nowLine}")`, /等 CI 构建 dmg/.test(nowLine));
	await page.waitForFunction(() => document.querySelectorAll("#tlog .le").length > 10, null, { timeout: 15_000 });
	await sleep(1500);
	await shot(page, "2-detail-progress.png", "#side");

	// work log: tails live, grouped reads, scroll back keeps position, live updates do not yank you down
	const box = page.locator("#tlog");
	check("consecutive reads are folded into one row", (await page.locator("#tlog .le.group").count()) > 0);
	check("pinned to the bottom initially", await box.evaluate((b) => b.scrollTop + b.clientHeight >= b.scrollHeight - 41));
	const n0 = await page.locator("#tlog .le").count();
	await page.waitForFunction((n) => document.querySelectorAll("#tlog .le").length > n, n0, { timeout: 15_000 });
	check("new work log entries appear live", true);
	await box.evaluate((b) => (b.scrollTop = 0));
	for (let k = 0; k < 10 && (await page.locator("#tlog [data-older]").count()); k++) {
		await page.click("#tlog [data-older]");
		await sleep(500);
	}
	const first = await page.$eval("#tlog .le", (e) => e.textContent);
	check(`scroll back loads older entries (first: "${first.slice(0, 30)}")`, /简报/.test(first));
	await box.evaluate((b) => (b.scrollTop = 400));
	await sleep(300);
	const top = await box.evaluate((b) => b.scrollTop);
	await sleep(4500);
	const top2 = await box.evaluate((b) => b.scrollTop);
	check(`reading older entries is not interrupted by live updates (scrollTop ${top} → ${top2})`, top > 0 && Math.abs(top2 - top) < 5);
	await page.locator("#tlog .le.tool:has(.k:text-is('edit')) summary").last().click();
	await sleep(200);
	check("edit shows a diff", (await page.locator("#tlog .le.tool .dp").count()) > 0);
	await page.evaluate(() => document.querySelector("#tlogSec")?.scrollIntoView());
	await shot(page, "3-worklog-scrollback.png", "#side");

	// 追加指令 from the pinned composer: echo right away, then the worker's answer in the log
	await box.evaluate((b) => (b.scrollTop = b.scrollHeight));
	await sleep(300);
	await page.fill("#tmsg", "发布完成后顺手更新 CHANGELOG");
	await page.keyboard.press("Enter");
	await page.waitForSelector("#tlog .le.instruction", { timeout: 5000 });
	check("instruction shows up in the log immediately", true);
	await page.waitForFunction(() => [...document.querySelectorAll("#tlog .le.text")].some((e) => /收到：发布完成后顺手更新 CHANGELOG/.test(e.textContent)), null, { timeout: 15_000 });
	check("worker's answer appears in the log", answered.length === 1);
	await sleep(2500);
	check("following the tail again once back at the bottom", await box.evaluate((b) => b.scrollTop + b.clientHeight >= b.scrollHeight - 41));
	check("local echo replaced by the real entry", (await page.locator("#tlog .le.instruction.local").count()) === 0);
	await sleep(500);
	await page.evaluate(() => document.querySelector("#tlogSec")?.scrollIntoView());
	await shot(page, "4-instruction-answer.png", "#side");

	// old worker fallback in the detail
	await page.click("[data-back]");
	await page.click('.titem[data-id="t0a02"]');
	await page.waitForSelector("#dprog .pnow");
	const oldNow = await page.textContent("#dprog .pnow");
	check(`old worker detail: plain words (${oldNow}) + milestones`, !/scripts\/|git push|ssh /.test(oldNow) && (await page.locator("#dprog .precent").count()) === 1);
	await sleep(500);
	await shot(page, "5-old-worker.png", "#side");

	// finished task: completed checklist + full log still readable
	await page.click("[data-back]");
	await page.evaluate(() => window.qaShowView?.("archived"));
	await page.evaluate(() => openTask("t0a03"));
	await page.waitForSelector("#dprog .steps li");
	await page.waitForFunction(() => [...document.querySelectorAll("#tlog .le.report")].length === 1, null, { timeout: 10_000 });
	check("done task: checklist complete and work log readable", (await page.$$eval("#dprog .steps li", (l) => l.every((x) => x.className === "done"))) && true);
	await sleep(600);
	await page.evaluate(() => document.querySelector("#tlogSec")?.scrollIntoView());
	await shot(page, "6-done.png", "#side");

	// attention: nothing of this interrupts
	const q = await api("GET", "/api/attention");
	check(`no interrupts: 需要你 = ${q.counts.need}, no warning toasts`, q.counts.need === 0 && (await page.locator(".toast.warning").count()) === 0);

	// CLI
	const show = quick("show", "t0a01");
	check("quick show prints the step list", /── 进度 ──\n■ 核对改动/.test(show));
	const ls = quick("ls");
	check("quick ls shows n/m", /\d\/6 /.test(ls));
	const lg = quick("log", "t0a01", "-n", "5");
	check("quick log prints the latest entries", lg.trim().split("\n").length >= 5);
	if (SHOTS) writeFileSync(join(SHOTS, "cli.txt"), `$ quick ls\n${ls}\n$ quick show t0a01\n${show}\n$ quick log t0a01 -n 5\n${lg}`);
} catch (e) {
	console.error(e);
	checks.exception = false;
}
await cleanup();
const failed = Object.entries(checks).filter(([, v]) => !v);
console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join("; ")}` : `ALL ${Object.keys(checks).length} CHECKS PASSED`);
process.exit(failed.length ? 1 : 0);
