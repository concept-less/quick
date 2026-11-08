// The attention model (shared/attention.ts): levels, ordering and the interrupt policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionOf, attentionQueue, focusActive, interruptFor } from "../shared/attention.ts";
import type { Task } from "../shared/types.ts";

const NOW = 1_000_000_000;
const T = (o: Partial<Task>): Task => ({
	id: "t0001", machine: "m", rev: 1, title: "demo", brief: "", cwd: "/tmp", status: "running", createdAt: NOW - 1000, updatedAt: NOW - 500, statusSince: NOW - 500,
	source: { kind: "cli" }, attachments: [], unread: false, messages: 0, ...o,
});
const lv = (o: Partial<Task>) => attentionOf(T(o), { now: NOW }).level;

test("levels", () => {
	assert.equal(lv({ status: "running" }), "inflight");
	assert.equal(lv({ status: "starting" }), "inflight");
	assert.equal(lv({ status: "handoff" }), "inflight");
	for (const s of ["needs_input", "blocked", "failed", "exited", "idle"] as const) assert.equal(lv({ status: s, unread: true }), "need", s);
	assert.equal(lv({ status: "needs_input", unread: false }), "archived", "acknowledged / put aside");
	assert.equal(lv({ status: "done", unread: true }), "skim");
	assert.equal(lv({ status: "done", unread: false }), "archived");
	assert.equal(lv({ status: "done", unread: true, statusSince: NOW - 8 * 86400_000 }), "archived", "done long ago");
	assert.equal(lv({ status: "cancelled", unread: true }), "archived");
	assert.equal(lv({ status: "needs_input", unread: true, snoozedUntil: NOW + 60_000 }), "snoozed");
	assert.equal(lv({ status: "needs_input", unread: true, snoozedUntil: NOW - 1 }), "need", "snooze over");
	assert.equal(lv({ status: "done", unread: true, snoozedUntil: NOW + 60_000 }), "snoozed");
});

test("item carries reason, since, question and actions", () => {
	const i = attentionOf(T({ status: "needs_input", unread: true, statusSince: NOW - 100, ask: { question: "用 pg 还是 sqlite？", options: ["pg", "sqlite"], at: NOW - 100 } }), { now: NOW });
	assert.equal(i.mark, "[ASK]");
	assert.match(i.reason, /用 pg 还是 sqlite/);
	assert.equal(i.since, NOW - 100);
	assert.deepEqual(i.options, ["pg", "sqlite"]);
	assert.deepEqual(i.actions.map((a) => a.id), ["reply", "snooze", "ack", "attach"]);
	assert.deepEqual(attentionOf(T({ status: "failed", unread: true }), { now: NOW }).actions.map((a) => a.id).slice(0, 2), ["reply", "retry"]);
	assert.equal(attentionOf(T({ status: "done", unread: true }), { now: NOW }).actions[0]!.id, "ack");
	assert.doesNotMatch(JSON.stringify(i), /\p{Extended_Pictographic}/u, "no emoji");
});

test("queue order and counts", () => {
	const q = attentionQueue(
		[
			T({ id: "run", status: "running" }),
			T({ id: "done", status: "done", unread: true }),
			T({ id: "ask-new", status: "needs_input", unread: true, statusSince: NOW - 10 }),
			T({ id: "ask-old", status: "blocked", unread: true, statusSince: NOW - 99 }),
			T({ id: "old", status: "done" }),
		],
		{ now: NOW },
	);
	assert.deepEqual(q.items.map((i) => i.taskId), ["ask-old", "ask-new", "done", "run", "old"]);
	assert.deepEqual(q.counts, { need: 2, skim: 1, snoozed: 0, inflight: 1, archived: 1 });
});

test("interrupt policy: only need interrupts, skim goes to the digest", () => {
	const run = attentionOf(T({ status: "running" }), { now: NOW });
	const ask = attentionOf(T({ status: "needs_input", unread: true }), { now: NOW });
	const done = attentionOf(T({ status: "done", unread: true }), { now: NOW });
	assert.equal(interruptFor(run, ask, true), "now");
	assert.equal(interruptFor(run, done, true), "digest");
	assert.equal(interruptFor(run, attentionOf(T({ status: "running", activity: "x" }), { now: NOW }), false), "none");
	assert.equal(interruptFor(ask, ask, false), "none", "no repeat");
	const ask2 = attentionOf(T({ status: "needs_input", unread: true, ask: { question: "另一个问题", at: NOW } }), { now: NOW });
	assert.equal(interruptFor(ask, ask2, true), "now", "new question while waiting");
	assert.equal(interruptFor(undefined, ask, false), "none", "startup / replica snapshot is not news");
	assert.equal(interruptFor(undefined, ask, true), "now");
	const snoozed = attentionOf(T({ status: "needs_input", unread: true, snoozedUntil: NOW + 1 }), { now: NOW });
	assert.equal(interruptFor(ask, snoozed, false), "none");
	assert.equal(interruptFor(snoozed, ask, false), "now", "snooze ended");
	assert.equal(interruptFor(done, attentionOf(T({ status: "done" }), { now: NOW }), false), "none", "ack");
});

test("focus", () => {
	assert.equal(focusActive(undefined), false);
	assert.equal(focusActive({ on: true }, NOW), true);
	assert.equal(focusActive({ on: true, until: NOW - 1 }, NOW), false);
});
