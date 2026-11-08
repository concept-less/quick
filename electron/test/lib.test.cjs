"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../src/lib.cjs");

const I = (o) => ({ taskId: "t0001", title: "demo", status: "running", level: "inflight", mark: "[RUN]", reason: "进行中", since: 1, actions: [], ...o });

test("tray and badge only show what needs you (hub counts)", () => {
	const c = { ...lib.emptyCounts(), need: 2, skim: 3, inflight: 5 };
	assert.equal(lib.trayTitle(c), "■2");
	assert.equal(lib.badge(c), "2");
	assert.equal(lib.trayTitle(lib.emptyCounts()), "□");
	assert.equal(lib.badge(lib.emptyCounts()), "");
});

test("byLevel: need oldest wait first, others newest first", () => {
	const l = [I({ taskId: "a", level: "need", since: 5 }), I({ taskId: "b", level: "need", since: 1 }), I({ taskId: "c" }), I({ taskId: "d", level: "skim", since: 1 }), I({ taskId: "e", level: "skim", since: 9 })];
	assert.deepEqual(lib.byLevel(l, "need").map((i) => i.taskId), ["b", "a"]);
	assert.deepEqual(lib.byLevel(l, "skim").map((i) => i.taskId), ["e", "d"]);
});

test("urgent notification uses the explicit question", () => {
	const n = lib.urgentNotification(I({ level: "need", mark: "[ASK]", title: "迁移", question: "用哪个数据库？", options: ["pg", "sqlite"], machine: "mac" }));
	assert.equal(n.title, "需要你 [ASK] · 迁移");
	assert.equal(n.body, "用哪个数据库？");
	assert.equal(n.subtitle, "t0001 @mac");
	assert.doesNotMatch(n.title, /\p{Extended_Pictographic}/u, "no emoji");
});

test("digest notification", () => {
	assert.equal(lib.digestNotification([]), undefined);
	const d = lib.digestNotification([I({ taskId: "a", title: "写文档" }), I({ taskId: "b", title: "修 bug" })], "timer");
	assert.equal(d.title, "2 件事已完成待扫");
	assert.equal(d.body, "写文档、修 bug");
	assert.deepEqual(d.ids, ["a", "b"]);
	assert.match(lib.digestNotification([I({ title: "单件" })], "focus_end").title, /^专注结束 · 待扫 · 单件/);
});

test("focus state from the hub", () => {
	assert.equal(lib.focusOn(undefined), false);
	assert.equal(lib.focusOn({ on: true }), true);
	assert.equal(lib.focusOn({ on: true, until: 2000 }, 1000), true);
	assert.equal(lib.focusOn({ on: true, until: 2000 }, 3000), false, "expired");
});

test("notification gate dedupes", () => {
	const g = new lib.NotificationGate(2);
	assert.equal(g.shouldShow("a"), true);
	assert.equal(g.shouldShow("a"), false);
	g.shouldShow("b");
	g.shouldShow("c");
	assert.equal(g.shouldShow("a"), true, "evicted");
});

test("window bounds validation", () => {
	const displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
	assert.deepEqual(lib.validBounds({ x: 10, y: 10, width: 800, height: 600 }, displays), { x: 10, y: 10, width: 800, height: 600 });
	assert.deepEqual(lib.validBounds({ x: 5000, y: 10, width: 800, height: 600 }, displays), { width: 800, height: 600 });
	assert.equal(lib.validBounds({ width: 10, height: 10 }, displays), undefined);
	assert.equal(lib.validBounds(null, displays), undefined);
});

test("title from text", () => {
	assert.equal(lib.titleFromText("  fix login\nmore details"), "fix login");
	assert.equal(lib.titleFromText("x".repeat(80)).length, 58);
});
