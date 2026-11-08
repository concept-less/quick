// Expected time + watchdog (shared/watchdog.ts, hub/watchdog.ts): triggers, cooldown, repeat detection,
// verdict parsing and the handling of each verdict, the attention of an escalation, reviewer isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	clockOnStatus,
	DEFAULT_WATCHDOG,
	decideAction,
	defaultExpected,
	detectRepeats,
	elapsedMs,
	markTriggered,
	multiplierAt,
	parseExpected,
	parseToolCalls,
	parseVerdict,
	recordReview,
	timingOf,
	triggerFor,
	watchdogConfig,
	type ToolCallRecord,
	type WatchdogConfig,
} from "../shared/watchdog.ts";
import { attentionOf, interruptFor } from "../shared/attention.ts";
import { reviewerEnv, REVIEWER_SYSTEM } from "../hub/watchdog.ts";
import type { Task } from "../shared/types.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG, cooldownMinutes: 10, stallMinutes: 20 };

function task(over: Partial<Task> = {}, activeMin = 0): Task {
	return {
		id: "t1", machine: "m", rev: 1, title: "实现登录", brief: "做一个登录页", cwd: "/tmp", status: "running",
		createdAt: T0 - activeMin * MIN, updatedAt: T0, statusSince: T0 - activeMin * MIN, source: { kind: "tui" }, attachments: [], unread: false, messages: 0,
		expect: { minutes: 20, source: "dispatch", at: T0 - activeMin * MIN, initial: 20 },
		clock: { activeMs: 0, activeSince: T0 - activeMin * MIN, progressAt: T0 },
		...over,
	};
}
const call = (name: string, cmd: string, result: string, isError = false, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({ ts: 0, name, key: `${name} ${JSON.stringify({ command: cmd })}`, text: `${name} ${cmd}`, result, isError, ...extra });

test("parseExpected: durations and plain minutes", () => {
	assert.equal(parseExpected("20m"), 20);
	assert.equal(parseExpected("1h30m"), 90);
	assert.equal(parseExpected("90s"), 1.5);
	assert.equal(parseExpected("45"), 45);
	assert.equal(parseExpected(12), 12);
	assert.throws(() => parseExpected("soon"));
	assert.throws(() => parseExpected(0));
});

test("defaultExpected: by kind of task", () => {
	assert.equal(defaultExpected({ title: "x", brief: "每天汇总", source: { kind: "cron" } }).kind, "cron");
	assert.equal(defaultExpected({ title: "发布 v0.5", brief: "打 tag 发 Release", source: { kind: "tui" } }).kind, "large");
	assert.equal(defaultExpected({ title: "修个 typo", brief: "README 里有错别字", source: { kind: "tui" } }).kind, "small");
	assert.equal(defaultExpected({ title: "修登录 bug", brief: "登录后跳转错了，修一下并加测试", source: { kind: "tui" } }).minutes, 30);
	assert.equal(defaultExpected({ title: "x", brief: "y".repeat(3000), source: { kind: "tui" } }).kind, "large");
});

test("config: defaults, validation, env switch", () => {
	const c = watchdogConfig({ multipliers: [3, "x", 1.5], cooldownMinutes: -1, model: "a/b" });
	assert.deepEqual(c.multipliers, [1.5, 3]);
	assert.equal(c.cooldownMinutes, DEFAULT_WATCHDOG.cooldownMinutes);
	assert.equal(c.model, "a/b");
	assert.equal(watchdogConfig({ enabled: false }).enabled, false);
	process.env.QA_WATCHDOG = "off";
	try {
		assert.equal(watchdogConfig({}).enabled, false);
	} finally {
		delete process.env.QA_WATCHDOG;
	}
});

test("clock counts active time only (waiting on a human does not count)", () => {
	let c = clockOnStatus(undefined, "starting", "running", T0);
	assert.equal(c.activeSince, T0);
	c = clockOnStatus({ activeMs: 0, activeSince: T0 }, "running", "needs_input", T0 + 10 * MIN);
	assert.equal(c.activeMs, 10 * MIN);
	assert.equal(c.activeSince, undefined);
	c = clockOnStatus(c, "needs_input", "running", T0 + 60 * MIN);
	const t = task({ clock: c });
	assert.equal(elapsedMs(t, T0 + 65 * MIN), 15 * MIN);
	assert.equal(timingOf(t, T0 + 65 * MIN).label, "15m / 20m");
	assert.equal(timingOf(t, T0 + 80 * MIN).mark, "[OVER]");
});

test("overtime: fires at 1.5x, then 3x, 6x, then keeps doubling", () => {
	const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG, cooldownMinutes: 10, stallMinutes: 0 };
	assert.deepEqual([0, 1, 2, 3, 4].map((l) => multiplierAt(cfg, l)), [1.5, 3, 6, 12, 24]);
	assert.equal(triggerFor(task({}, 29), cfg, T0), undefined);
	const t = task({}, 31);
	const trig = triggerFor(t, cfg, T0);
	assert.equal(trig?.kind, "overtime");
	assert.match(trig!.detail, /1\.5x/);
	t.watch = markTriggered(t, trig!, cfg, T0);
	assert.equal(t.watch.overLevel, 1);
	t.watch = recordReview(t, { at: T0, trigger: "overtime", detail: "", action: "corrected" }, { action: "corrected" });
	t.watch.followupDue = false;
	// at 50 min (under 3x = 60) nothing, at 61 min the next level
	assert.equal(triggerFor({ ...t, clock: { activeMs: 0, activeSince: T0 - 31 * MIN } } as Task, cfg, T0 + 19 * MIN), undefined);
	const late = { ...t, clock: { activeMs: 0, activeSince: T0 - 31 * MIN } } as Task;
	assert.equal(triggerFor(late, cfg, T0 + 30 * MIN)?.kind, "overtime");
	assert.match(triggerFor(late, cfg, T0 + 30 * MIN)!.detail, /3x/);
});

test("cooldown, off switch, pending escalation and non-running tasks suppress triggers", () => {
	const t = task({ watch: { reviews: [{ at: T0 - 5 * MIN, trigger: "overtime", detail: "", action: "silent" }] } }, 100);
	assert.equal(triggerFor(t, cfg, T0), undefined, "within cooldown");
	assert.equal(triggerFor(t, cfg, T0 + 6 * MIN)?.kind, "overtime", "after cooldown");
	assert.equal(triggerFor(task({ watch: { off: true, reviews: [] } }, 100), cfg, T0), undefined);
	assert.equal(triggerFor(task({ watch: { reviews: [], running: { at: T0, trigger: "manual" } } }, 100), cfg, T0), undefined);
	assert.equal(triggerFor(task({ watch: { reviews: [], pending: { at: T0, verdict: "STUCK", question: "?" } } }, 100), cfg, T0), undefined);
	assert.equal(triggerFor(task({ status: "needs_input" }, 100), cfg, T0), undefined);
	assert.equal(triggerFor(task({}, 100), { ...cfg, enabled: false }, T0), undefined);
});

test("stall: no progress for N minutes, once per progress point", () => {
	const t = task({ expect: { minutes: 600, source: "dispatch", at: 0 }, clock: { activeMs: 0, activeSince: T0 - 40 * MIN, progressAt: T0 - 25 * MIN }, statusSince: T0 - 40 * MIN, createdAt: T0 - 40 * MIN });
	const trig = triggerFor(t, cfg, T0);
	assert.equal(trig?.kind, "stalled");
	t.watch = recordReview({ ...t, watch: markTriggered(t, trig!, cfg, T0) }, { at: T0, trigger: "stalled", detail: "", action: "silent" }, { action: "silent" });
	assert.equal(triggerFor(t, cfg, T0 + 30 * MIN), undefined, "same stall is not reviewed again");
	t.clock = { ...t.clock!, progressAt: T0 + 1 * MIN };
	assert.equal(triggerFor(t, cfg, T0 + 30 * MIN)?.kind, "stalled", "a new stall after new progress");
	// progress from the worker's progress record (t8f4a) counts too
	(t as any).progress = { updatedAt: T0 + 25 * MIN };
	assert.equal(triggerFor(t, cfg, T0 + 30 * MIN), undefined);
});

test("repeat: same call with the same result, deduped by signature; follow-up after a correction comes first", () => {
	const calls = Array.from({ length: 5 }, () => call("bash", "npm run build", "Error: Cannot find module './x.js'", true));
	const reps = detectRepeats(calls);
	assert.ok(reps.length >= 1);
	const t = task({ expect: { minutes: 600, source: "dispatch", at: 0 } }, 2);
	const trig = triggerFor(t, cfg, T0, reps);
	assert.equal(trig?.kind, "repeat");
	t.watch = recordReview({ ...t, watch: markTriggered(t, trig!, cfg, T0) }, { at: T0, trigger: "repeat", detail: "", action: "corrected" }, { action: "corrected" });
	assert.equal(t.watch.followupDue, true);
	assert.equal(triggerFor(t, cfg, T0 + 5 * MIN, reps), undefined, "cooldown");
	assert.equal(triggerFor(t, cfg, T0 + 11 * MIN, reps)?.kind, "followup");
	t.watch = markTriggered(t, { kind: "followup", detail: "" }, cfg, T0 + 11 * MIN);
	t.watch = recordReview(t, { at: T0 + 11 * MIN, trigger: "followup", detail: "", action: "silent" }, { action: "silent" });
	assert.equal(triggerFor(t, cfg, T0 + 30 * MIN, [reps[0]!])?.kind ?? "none", "none", "the same signature is not reviewed twice");
});

test("detectRepeats: patterns and non-patterns", () => {
	// same command, different results (fix-test cycles) is fine
	const tests = Array.from({ length: 6 }, (_, i) => call("bash", "npm test", `fail ${"abc"[i % 3]} tests`, false));
	assert.equal(detectRepeats(tests).filter((r) => r.kind === "same_call").length, 0);
	// same error from different commands
	const errs = ["a", "b", "c", "d"].map((c) => call("bash", `node ${c}.js`, "EACCES: permission denied, open '/etc/x'", true));
	assert.equal(detectRepeats(errs)[0]?.kind, "same_error");
	// numbers in output do not make an error different
	const num = [1, 2, 3, 4].map((n) => call("bash", "curl http://x", `HTTP 503 after ${n * 100}ms`, true));
	assert.ok(detectRepeats(num).some((r) => r.kind === "same_error"));
	// polling: sleep N && check, numbers ignored, same result
	const poll = [30, 60, 30, 90].map((n) => call("bash", `sleep ${n} && gh run view 1`, "status: in_progress", false));
	assert.equal(detectRepeats(poll)[0]?.kind, "polling");
	// flip-flop edits
	const e = (o: string, n: string) => call("edit", "", "ok", false, { name: "edit", key: `edit ${o}${n}`, edit: [{ path: "src/a.ts", old: o, new: n }] });
	const flips = detectRepeats([e("x = 1", "x = 2"), e("x = 2", "x = 1"), e("x = 1", "x = 2")]);
	assert.equal(flips[0]?.kind, "flip_flop");
	assert.match(flips[0]!.detail, /src\/a\.ts/);
	// below the threshold / outside the window
	assert.equal(detectRepeats(errs.slice(0, 3)).length, 0);
	assert.equal(detectRepeats([...errs, ...tests, ...tests, ...tests, ...tests, ...tests], 4, 30).filter((r) => r.kind === "same_error").length, 0);
});

test("parseToolCalls: pairs calls with results, skips cut lines", () => {
	const lines = [
		'{"type":"message","timestamp":"2026-11-08T10:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"npm  run\\nbuild"}}]}}',
		'{"type":"message","timestamp":"2026-11-08T10:00:01Z","message":{"role":"toolResult","toolCallId":"a","toolName":"bash","content":[{"type":"text","text":"boom"}],"isError":true}}',
		'{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"b","name":"edit","arguments":{"path":"f.ts","edits":[{"oldText":"a","newText":"b"}]}}]}}',
	];
	const calls = parseToolCalls(`ial":true}\n${lines.join("\n")}\n`);
	assert.equal(calls.length, 2);
	assert.equal(calls[0]!.text, "bash npm run build");
	assert.equal(calls[0]!.isError, true);
	assert.equal(calls[0]!.result, "boom");
	assert.deepEqual(calls[1]!.edit, [{ path: "f.ts", old: "a", new: "b" }]);
});

test("parseVerdict: last valid JSON wins, tolerant of prose and code fences", () => {
	assert.equal(parseVerdict("no json"), undefined);
	assert.equal(parseVerdict('{"verdict":"MAYBE"}'), undefined);
	const r = parseVerdict('分析……它在 {重复} 做同一件事。\n{"verdict":"stuck","evidence":"同一个错误 5 次","advice":"先读报错里的路径","expected":"45m"}');
	assert.equal(r?.verdict, "STUCK");
	assert.equal(r?.expected, 45);
	assert.equal(parseVerdict('```json\n{"verdict":"ON_TRACK","evidence":"在推进","expected":"1h"}\n```')?.expected, 60);
	assert.equal(parseVerdict('{"verdict":"BAD-APPROACH","evidence":"改测试凑通过"}')?.verdict, "BAD_APPROACH");
});

test("decideAction: ON_TRACK is silent and updates the expectation", () => {
	const t = task({}, 31);
	const p = decideAction(t, { verdict: "ON_TRACK", evidence: "在推进", expected: 50 }, cfg, T0);
	assert.equal(p.action, "silent");
	assert.equal(p.expect, 50);
	// an estimate below the time already used is not accepted
	assert.ok(decideAction(t, { verdict: "ON_TRACK", evidence: "", expected: 10 }, cfg, T0).expect! > 31);
	const w = recordReview(t, { at: T0, trigger: "overtime", detail: "", action: "silent" }, p);
	assert.equal(w.overLevel, 0, "new expectation restarts the multipliers");
	assert.equal(w.pending, undefined);
});

test("decideAction: problem verdicts correct first, escalate when it happens again", () => {
	const t = task({}, 31);
	for (const v of ["DRIFTING", "STUCK", "BAD_APPROACH"] as const) {
		const p = decideAction(t, { verdict: v, evidence: "依据", advice: "换个办法" }, cfg, T0);
		assert.equal(p.action, "corrected");
		assert.match(p.message!, /【巡检纠偏】/);
		assert.match(p.message!, /换个办法/);
	}
	t.watch = recordReview(t, { at: T0, trigger: "repeat", detail: "", action: "corrected" }, { action: "corrected" });
	assert.equal(t.watch.corrections, 1);
	const again = decideAction(t, { verdict: "STUCK", evidence: "还是同一个错误。后面还有", advice: "x" }, cfg, T0);
	assert.equal(again.action, "escalated");
	assert.match(again.pending!.question, /纠偏后仍判断「陷入死胡同或循环」：还是同一个错误。/);
	assert.ok(again.pending!.options!.length >= 2);
	// ON_TRACK in between resets the count
	const ok = recordReview(t, { at: T0, trigger: "overtime", detail: "", action: "silent" }, { action: "silent" });
	assert.equal(decideAction({ ...t, watch: ok }, { verdict: "STUCK", evidence: "" }, cfg, T0).action, "corrected");
	// maxCorrections 0: escalate right away
	assert.equal(decideAction(task(), { verdict: "STUCK", evidence: "" }, { ...cfg, maxCorrections: 0 }, T0).action, "escalated");
});

test("decideAction: NEEDS_HUMAN escalates with the reviewer's question", () => {
	const p = decideAction(task(), { verdict: "NEEDS_HUMAN", evidence: "缺少 API key", question: "要用哪个 API key？", options: ["生产", "测试"] }, cfg, T0);
	assert.equal(p.action, "escalated");
	assert.equal(p.pending!.question, "要用哪个 API key？");
	assert.deepEqual(p.pending!.options, ["生产", "测试"]);
});

test("attention: an escalation is 需要你 [CHECK] (interrupts), ON_TRACK / [OVER] never interrupt", () => {
	const t = task({}, 40);
	const before = attentionOf(t, { now: T0 });
	assert.equal(before.level, "inflight");
	assert.equal(before.mark, "[OVER]");
	assert.equal(before.timing, "40m / 20m");
	const silent = { ...t, expect: { ...t.expect!, minutes: 60, source: "watchdog" as const } };
	assert.equal(interruptFor(before, attentionOf(silent, { now: T0 })), "none");
	const esc = { ...t, watch: { reviews: [], pending: { at: T0, verdict: "STUCK" as const, question: "巡检纠偏后仍判断卡住", options: ["继续", "中止任务"] } } };
	const need = attentionOf(esc, { now: T0 });
	assert.equal(need.level, "need");
	assert.equal(need.mark, "[CHECK]");
	assert.deepEqual(need.options, ["继续", "中止任务"]);
	assert.ok(need.actions.some((a) => a.id === "reply"));
	assert.equal(interruptFor(before, need), "now");
	assert.equal(attentionOf({ ...esc, snoozedUntil: T0 + MIN, snoozedAt: T0 }, { now: T0 }).level, "snoozed");
});

test("reviewer isolation: no quick-agent identity leaks into the reviewer's environment", () => {
	const env = reviewerEnv({ PATH: "/bin", HOME: "/h", QA_TASK_ID: "t8eb4", QA_HUB_URL: "http://127.0.0.1:7788", QA_TOKEN: "secret", QA_HOME: "/real", QA_PORT: "7788", QA_FRONT_ID: "f" }, "t1", "overtime");
	for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_HOME", "QA_PORT", "QA_FRONT_ID"]) assert.equal(env[k], undefined, k);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.QA_WATCH_TASK, "t1");
	// the prompt matches its real tool set (read/grep/find/ls; the verdict goes to stdout)
	assert.doesNotMatch(REVIEWER_SYSTEM, /qa_report|qa_comment|bash|edit|write/);
	assert.match(REVIEWER_SYSTEM, /read \/ grep \/ find \/ ls/);
});
