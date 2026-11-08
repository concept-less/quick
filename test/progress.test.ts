// Progress (shared/progress.ts) and 工作记录 parsing (shared/transcript.ts): pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyActivity, applyProgress, finishProgress, humanizeActivity, progressLine, progressText, stepCounts } from "../shared/progress.ts";
import { attentionOf } from "../shared/attention.ts";
import { entryText, readTranscript } from "../shared/transcript.ts";
import type { Task } from "../shared/types.ts";

test("raw tool activity becomes plain words", () => {
	const h = (s: string) => humanizeActivity(s).text;
	assert.equal(h("bash cd /Users/tianyu/quick-agent && scripts/release.sh patch 2>&1 | tail -25"), "执行发布脚本");
	assert.equal(h("bash cd /x && git push origin main"), "推送代码");
	assert.equal(h("bash git push --tags"), "推送 tag");
	assert.equal(h("bash git add -A && git commit -m 'x' && git log --oneline -3"), "提交代码");
	assert.equal(h("bash NODE_NO_WARNINGS=1 npm test 2>&1 | tail -30"), "跑测试");
	assert.equal(h("bash node --test test/a.test.ts"), "跑测试");
	assert.equal(h("bash npm ci"), "安装依赖");
	assert.equal(h("bash gh run watch 123"), "等 CI 结果");
	assert.equal(h("bash ssh devbox 'uptime'"), "在 devbox 上执行命令");
	assert.equal(h("bash sleep 30"), "等待");
	assert.equal(h("bash ls -la"), "查看文件");
	assert.equal(h("bash ./scripts/foo.sh"), "运行 foo.sh");
	assert.equal(h("bash frobnicate --x"), "运行 frobnicate");
	assert.equal(h("write /a/b/hub/server.ts"), "编写 server.ts");
	assert.equal(h("edit ui/app.html"), "修改 app.html");
	assert.equal(h("read README.md"), "阅读 README.md");
	assert.equal(h("grep foo"), "查找代码和文件");
	assert.equal(h("思考中"), "思考中");
	assert.equal(h("收到追加指令"), "收到追加指令");
	assert.equal(h("some_tool"), "使用工具 some_tool");
	assert.equal(humanizeActivity("bash git push").milestone, true);
	assert.equal(humanizeActivity("read a.ts").milestone, false);
});

test("plan, current step, note and milestones", () => {
	let { progress: p, milestones } = applyProgress(undefined, { plan: ["改代码", "跑测试", { title: "发布 Release", expected_minutes: 15 }, "迁移机器"], current: 1, note: "开始改代码" }, 1000);
	assert.deepEqual(p.steps!.map((s) => s.state), ["active", "todo", "todo", "todo"]);
	assert.equal(p.steps![2]!.expectedMinutes, 15);
	assert.equal(p.startedAt, 1000);
	assert.deepEqual(milestones, []);
	assert.equal(progressLine({ progress: p }), "1/4 改代码");
	({ progress: p, milestones } = applyProgress(p, { current: 3, note: "正在发布 v0.4.1：已打 tag，等 CI 构建 dmg" }, 2000));
	assert.deepEqual(p.steps!.map((s) => s.state), ["done", "done", "active", "todo"]);
	assert.deepEqual(milestones, ["完成：改代码", "完成：跑测试"]);
	assert.equal(progressLine({ progress: p }), "3/4 发布 Release");
	assert.deepEqual(stepCounts(p), { done: 2, total: 4, active: p.steps![2], index: 3 });
	// re-plan keeps the state of unchanged titles
	({ progress: p } = applyProgress(p, { plan: ["改代码", "跑测试", "发布 Release", "迁移 mac", "迁移 cloud"] }, 3000));
	assert.deepEqual(p.steps!.map((s) => s.state), ["done", "done", "active", "todo", "todo"]);
	// explicit done for non-linear work
	({ progress: p } = applyProgress(p, { done: [5] }, 3500));
	assert.equal(p.steps![4]!.state, "done");
	assert.equal(p.updatedAt, 3500);
	// activity pings change "now" but never updatedAt (no-progress detection relies on it)
	const q = applyActivity(p, "bash git push origin main", 9000)!;
	assert.equal(q.now, "推送代码");
	assert.equal(q.nowAt, 9000);
	assert.equal(q.updatedAt, 3500);
	assert.equal(q.recent!.at(-1)!.text, "推送代码");
	const f = finishProgress(q, 10_000)!;
	assert.ok(f.steps!.every((s) => s.state === "done"));
	assert.equal(progressLine({ progress: f }), "5/5 收尾");
	const txt = progressText({ progress: p, createdAt: 0 }, 1000 + 125_000);
	assert.match(txt, /^■ 改代码\n■ 跑测试\n▶ 发布 Release\n□ 迁移 mac\n■ 迁移 cloud\n当前：正在发布 v0\.4\.1/);
	assert.match(txt, /已用 2 分钟/);
});

test("milestones are deduplicated and capped", () => {
	let p = applyActivity(undefined, "edit a.ts", 1)!;
	p = applyActivity(p, "bash npm test", 2)!;
	p = applyActivity(p, "edit a.ts", 3)!;
	p = applyActivity(p, "read b.ts", 4)!; // not a milestone
	assert.deepEqual(p.recent!.map((m) => m.text), ["跑测试", "修改 a.ts"]);
	assert.equal(p.now, "阅读 b.ts");
	for (let k = 0; k < 10; k++) p = applyActivity(p, `write f${k}.ts`, 10 + k)!;
	assert.equal(p.recent!.length, 6);
});

test("attention reason of a running task is plain words, never the raw command", () => {
	const base: Task = { id: "t1", machine: "m", rev: 1, title: "x", brief: "", cwd: "/", status: "running", createdAt: 0, updatedAt: 0, source: { kind: "cli" }, attachments: [], unread: false, messages: 0 };
	// older worker, no progress object (e.g. replicated from an older hub): humanized on the fly
	assert.equal(attentionOf({ ...base, activity: "bash cd /x && scripts/release.sh patch 2>&1 | tail -25" }).reason, "进行中：执行发布脚本");
	const { progress } = applyProgress(undefined, { plan: ["a", "b", "c"], current: 2 });
	const a = attentionOf({ ...base, activity: "bash git push", progress });
	assert.equal(a.reason, "进行中：2/3 b");
	assert.equal(a.level, "inflight");
});

test("work log: text, thinking, tools with results, instructions, reports, incremental tail", () => {
	const dir = mkdtempSync(join(tmpdir(), "qa-tl-"));
	const f = join(dir, "s.jsonl");
	const line = (o: any) => `${JSON.stringify(o)}\n`;
	const msg = (ts: number, message: any) => line({ type: "message", id: String(ts), timestamp: new Date(ts).toISOString(), message });
	writeFileSync(
		f,
		line({ type: "session", version: 3 }) +
			msg(1000, { role: "system", content: "" }) +
			msg(1001, { role: "user", content: [{ type: "text", text: "<file>brief</file>\n任务简报" }] }) +
			msg(1002, {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "先看看代码" },
					{ type: "text", text: "开始" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "git status" } },
					{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } },
				],
			}) +
			msg(1003, { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "On branch main" }] }),
	);
	let page = readTranscript(f);
	assert.equal(page.available, true);
	assert.deepEqual(page.entries.map((e) => e.kind), ["brief", "thinking", "text", "tool", "tool"]);
	assert.equal(page.entries[3]!.result, "On branch main");
	assert.equal(page.entries[4]!.running, true);
	assert.equal(page.pendingFrom, 4);
	// result of c2 + a follow-up instruction + a big output + a report arrive later
	appendFileSync(
		f,
		msg(1004, { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "-1 a\n+1 b" } }) +
			msg(1005, { role: "user", content: [{ type: "text", text: "【quick-agent 追加指令】\n顺便加个测试" }] }) +
			msg(1006, { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm test" } }, { type: "toolCall", id: "c4", name: "qa_report", arguments: { status: "done", summary: "做完了" } }] }) +
			msg(1007, { role: "toolResult", toolCallId: "c3", toolName: "bash", content: [{ type: "text", text: "x".repeat(5000) }] }) +
			'{"type":"message","partial',
	);
	page = readTranscript(f, { after: page.pendingFrom! - 1 });
	assert.deepEqual(page.entries.map((e) => [e.i, e.kind]), [[4, "tool"], [5, "instruction"], [6, "tool"], [7, "report"]]);
	assert.equal(page.entries[0]!.diff, "-1 a\n+1 b");
	assert.equal(page.entries[1]!.text, "顺便加个测试");
	assert.equal(page.entries[2]!.truncated, true);
	assert.ok(page.entries[2]!.result!.length < 2000);
	assert.equal(page.pendingFrom, undefined);
	assert.equal(readTranscript(f, { full: 6 }).entries[0]!.result!.length, 5000);
	// scroll back
	assert.deepEqual(readTranscript(f, { before: 3, limit: 2 }).entries.map((e) => e.i), [1, 2]);
	assert.match(entryText(page.entries[1]!), /追加指令\s+顺便加个测试/);
	assert.equal(readTranscript(join(dir, "missing.jsonl")).available, false);
	rmSync(dir, { recursive: true, force: true });
});
