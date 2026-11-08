"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../src/lib.cjs");

const T = (o) => ({ id: "t0001", title: "demo", status: "running", unread: false, updatedAt: 1, ...o });

test("attention buckets", () => {
	assert.equal(lib.bucket(T({ status: "needs_input" })), "need");
	assert.equal(lib.bucket(T({ status: "blocked" })), "need");
	assert.equal(lib.bucket(T({ status: "failed" })), "need");
	assert.equal(lib.bucket(T({ status: "idle" })), "need", "stopped without a report");
	assert.equal(lib.bucket(T({ status: "exited", unread: false })), "need");
	assert.equal(lib.bucket(T({ status: "blocked", closed: true })), null);
	assert.equal(lib.bucket(T({ status: "running" })), "inflight");
	assert.equal(lib.bucket(T({ status: "starting" })), "inflight");
	assert.equal(lib.bucket(T({ status: "done", unread: true })), "skim");
	assert.equal(lib.bucket(T({ status: "done", unread: false })), null, "already skimmed");
	assert.equal(lib.bucket(T({ status: "cancelled", unread: true })), null);
});

test("tray and badge only show what needs you", () => {
	const s = lib.summarize([T({}), T({ status: "starting" }), T({ status: "blocked" }), T({ status: "done", unread: true })]);
	assert.deepEqual(s, { need: 1, inflight: 2, skim: 1 });
	assert.equal(lib.trayTitle(s), "■1");
	assert.equal(lib.badge(s), "1");
	assert.equal(lib.trayTitle({ need: 0, inflight: 5, skim: 3 }), "□");
	assert.equal(lib.badge({ need: 0, inflight: 5, skim: 3 }), "");
});

test("byBucket sorts newest first", () => {
	const l = lib.byBucket([T({ id: "a", status: "blocked", updatedAt: 1 }), T({ id: "b", status: "needs_input", updatedAt: 5 }), T({ id: "c", status: "running" })], "need");
	assert.deepEqual(l.map((t) => t.id), ["b", "a"]);
});

test("notifications: urgent for need, digest for skim, nothing for progress", () => {
	const prev = T({});
	assert.equal(lib.notificationFor(prev, T({ activity: "x" }), { kind: "activity" }), undefined);
	assert.equal(lib.notificationFor(prev, T({ summary: "50%" }), { kind: "report" }), undefined, "progress report");
	const n = lib.notificationFor(prev, T({ status: "needs_input", summary: "which db?" }), { kind: "report" });
	assert.equal(n.kind, "urgent");
	assert.match(n.title, /需要你决定/);
	assert.equal(n.body, "which db?");
	assert.equal(lib.notificationFor(prev, T({ status: "failed" }), { kind: "status" }).kind, "urgent");
	assert.equal(lib.notificationFor(prev, T({ status: "done", unread: true, summary: "ok" }), { kind: "report" }).kind, "digest");
	assert.equal(lib.notificationFor(T({ status: "done", unread: true, summary: "ok" }), T({ status: "done", summary: "ok" }), { kind: "ack" }), undefined);
	assert.equal(lib.notificationFor(T({ status: "blocked", summary: "a" }), T({ status: "blocked", summary: "b" }), { kind: "report" }).kind, "urgent", "new question while blocked");
	assert.equal(lib.notificationFor(undefined, T({ status: "starting" }), { kind: "created" }), undefined);
});

test("digest batches and prunes", () => {
	const d = new lib.Digest();
	assert.equal(d.flush(), undefined);
	d.add(T({ id: "a", title: "写文档" }));
	d.add(T({ id: "b", title: "修 bug" }));
	d.add(T({ id: "c", title: "跑测试" }));
	d.prune((id) => id !== "c");
	const f = d.flush();
	assert.equal(f.title, "2 件事已完成待扫");
	assert.equal(f.body, "写文档、修 bug");
	assert.deepEqual(f.ids, ["a", "b"]);
	assert.equal(d.size, 0);
	d.add(T({ id: "x", title: "单件" }));
	assert.match(d.flush().title, /已完成待扫 · 单件/);
});

test("quiet modes", () => {
	assert.equal(lib.quietMode({}), "off");
	assert.equal(lib.quietMode({ quiet: { mode: "focus" } }), "focus");
	assert.equal(lib.quietMode({ quiet: { mode: "dnd", until: 2000 } }, 1000), "focus");
	assert.equal(lib.quietMode({ quiet: { mode: "dnd", until: 2000 } }, 3000), "off", "expired");
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
