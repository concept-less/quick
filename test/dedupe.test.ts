// Tests for shared/dedupe.ts: the hub refuses a second worker for the same open job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDuplicates, findDuplicates, isOpen, normalize, similarity } from "../shared/dedupe.ts";
import type { Task } from "../shared/types.ts";

const T = (o: Partial<Task>): Task => ({
	id: "t0001",
	machine: "mac",
	rev: 1,
	title: "demo",
	brief: "",
	cwd: "/proj",
	status: "running",
	createdAt: 1,
	updatedAt: 1,
	source: { kind: "tui" },
	attachments: [],
	unread: false,
	messages: 0,
	...o,
});

const BRIEF = "## 目标\n把前台 Web UI 从「会话」改成「注意力」管理：去掉切换/新建会话，按是否需要用户注意力组织任务。\n## 验收\n页面里没有会话字样，测试通过。";

test("normalize / similarity", () => {
	assert.equal(normalize(" Hello, 世界！ "), "hello世界");
	assert.equal(similarity(BRIEF, BRIEF), 1);
	assert.ok(similarity(BRIEF, `${BRIEF}\n补充：截图放到 docs/。`) > 0.85);
	assert.ok(similarity(BRIEF, "在 /tmp 下创建 hello.txt，内容 hi") < 0.2);
	assert.equal(similarity("", ""), 0);
});

test("open statuses", () => {
	assert.ok(isOpen(T({ status: "needs_input" })));
	assert.ok(!isOpen(T({ status: "done" })));
	assert.ok(!isOpen(T({ status: "running", closed: true })));
});

test("same brief in the same cwd is a duplicate; resubmission with small edits too", () => {
	const tasks = [T({ id: "t1111", brief: BRIEF, title: "注意力改版" }), T({ id: "t2222", brief: "跑一遍测试", title: "测试" })];
	const d = findDuplicates(tasks, { title: "UI 去会话", brief: `${BRIEF}\n（再说一遍）`, cwd: "/proj/" });
	assert.deepEqual(
		d.map((x) => x.task.id),
		["t1111"],
	);
	assert.equal(d[0]!.reason, "similar-brief");
	assert.match(describeDuplicates(d), /t1111 "注意力改版" \[running\]/);
});

test("same normalized title is a duplicate even with a reworded brief", () => {
	const d = findDuplicates([T({ id: "t1111", title: "修复登录页 bug", brief: "a" })], { title: "修复登录页 BUG！", brief: "完全不同的说明" });
	assert.equal(d[0]?.reason, "same-title");
});

test("not duplicates: finished tasks, other cwd, other machine, different work, short titles", () => {
	const base = { brief: BRIEF, title: "注意力改版" };
	const input = { ...base, cwd: "/proj", machine: "mac" };
	assert.equal(findDuplicates([T({ ...base, status: "done" })], input).length, 0);
	assert.equal(findDuplicates([T({ ...base, status: "cancelled" })], input).length, 0);
	assert.equal(findDuplicates([T({ ...base, cwd: "/other" })], input).length, 0);
	assert.equal(findDuplicates([T({ ...base, machine: "linux" })], input).length, 0);
	assert.equal(findDuplicates([T({ title: "其它", brief: "升级 hub 并重启所有机器" })], input).length, 0);
	assert.equal(findDuplicates([T({ title: "测试", brief: "x" })], { title: "测试", brief: "y", cwd: "/proj" }).length, 0);
});
