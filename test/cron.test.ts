// Scheduled jobs: cron parsing, next-run computation (time zones, DST) and the timer's decisions (shared/cron.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CronError,
	decide,
	describeRule,
	formatWall,
	nextCronTime,
	nextRun,
	parseAt,
	parseCron,
	parseDuration,
	parseRule,
	renderBrief,
	runsBetween,
	zonedInstant,
	type CronJob,
} from "../shared/cron.ts";

const SH = "Asia/Shanghai";
const NY = "America/New_York";
const at = (s: string, tz = SH) => parseAt(s, tz);
const wall = (ms: number | undefined, tz = SH) => (ms === undefined ? "-" : formatWall(ms, tz));
/** The next n fire times as wall-clock strings. */
function seq(expr: string, from: string, n: number, tz = SH) {
	const out: string[] = [];
	let t: number | undefined = at(from, tz);
	for (let i = 0; i < n && t !== undefined; i++) {
		t = nextCronTime(expr, t, tz);
		out.push(wall(t, tz));
	}
	return out;
}

test("parseCron: fields, lists, ranges, steps, names, aliases", () => {
	const s = parseCron("*/15 9-17 * * mon-fri");
	assert.deepEqual(s.minute, [0, 15, 30, 45]);
	assert.deepEqual(s.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
	assert.deepEqual(s.dow, [1, 2, 3, 4, 5]);
	assert.equal(s.domStar, true);
	assert.equal(s.dowStar, false);
	assert.deepEqual(parseCron("0 0 1,15 jan,JUL *").month, [1, 7]);
	assert.deepEqual(parseCron("0 0 1,15 * *").dom, [1, 15]);
	assert.deepEqual(parseCron("5/20 * * * *").minute, [5, 25, 45]);
	assert.deepEqual(parseCron("0 8-20/4 * * *").hour, [8, 12, 16, 20]);
	assert.deepEqual(parseCron("0 0 * * 7").dow, [0]); // 7 = Sunday
	assert.deepEqual(parseCron("0 0 * * 5-7").dow, [0, 5, 6]);
	assert.deepEqual(parseCron("@daily"), parseCron("0 0 * * *"));
	assert.deepEqual(parseCron("@hourly").minute, [0]);
	assert.equal(parseCron("0 0 */2 * *").domStar, false); // a step restricts the field
});

test("parseCron: clear errors", () => {
	for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "1,,2 * * * *", "1-2-3 * * * *"]) {
		assert.throws(() => parseCron(bad), CronError, bad);
	}
});

test("nextCronTime: daily, weekly, monthly in a fixed-offset zone", () => {
	assert.deepEqual(seq("0 9 * * *", "2026-11-09 08:59", 3), ["2026-11-09 09:00", "2026-11-10 09:00", "2026-11-11 09:00"]);
	// strictly after: exactly at 09:00 → tomorrow
	assert.equal(wall(nextCronTime("0 9 * * *", at("2026-11-09 09:00"), SH)), "2026-11-10 09:00");
	// 2026-11-09 is a Monday
	assert.deepEqual(seq("30 8 * * 1", "2026-11-05 00:00", 2), ["2026-11-09 08:30", "2026-11-16 08:30"]);
	assert.deepEqual(seq("0 0 31 * *", "2026-01-31 12:00", 3), ["2026-03-31 00:00", "2026-05-31 00:00", "2026-07-31 00:00"]);
	assert.deepEqual(seq("0 12 29 2 *", "2026-01-01 00:00", 1), ["2028-02-29 12:00"]);
	assert.deepEqual(seq("*/20 * * * *", "2026-11-09 23:50", 3), ["2026-11-10 00:00", "2026-11-10 00:20", "2026-11-10 00:40"]);
	assert.deepEqual(seq("0 9-17/4 * * mon-fri", "2026-11-13 14:00", 3), ["2026-11-13 17:00", "2026-11-16 09:00", "2026-11-16 13:00"]);
});

test("nextCronTime: day-of-month OR day-of-week when both are restricted", () => {
	// 1st of the month or any Friday
	assert.deepEqual(seq("0 0 1 * fri", "2026-11-25 00:00", 3), ["2026-11-27 00:00", "2026-12-01 00:00", "2026-12-04 00:00"]);
});

test("nextCronTime: time zones", () => {
	const from = Date.UTC(2026, 10, 9, 0, 0); // 2026-11-09 00:00Z
	assert.equal(new Date(nextCronTime("0 9 * * *", from, SH)!).toISOString(), "2026-11-09T01:00:00.000Z");
	assert.equal(new Date(nextCronTime("0 9 * * *", from, "UTC")!).toISOString(), "2026-11-09T09:00:00.000Z");
	assert.equal(new Date(nextCronTime("0 9 * * *", from, NY)!).toISOString(), "2026-11-09T14:00:00.000Z"); // EST
	assert.equal(new Date(nextCronTime("0 9 * * *", Date.UTC(2026, 6, 1), NY)!).toISOString(), "2026-07-01T13:00:00.000Z"); // EDT
	assert.equal(new Date(nextCronTime("0 9 * * *", from, "Asia/Kolkata")!).toISOString(), "2026-11-09T03:30:00.000Z"); // +05:30
});

test("DST spring forward: a skipped wall time fires right after the jump, once", () => {
	// 2026-03-08 02:00 EST → 03:00 EDT in New York
	const from = at("2026-03-07 12:00", NY);
	const t = nextCronTime("30 2 * * *", from, NY)!;
	assert.equal(new Date(t).toISOString(), "2026-03-08T07:30:00.000Z"); // 03:30 EDT
	assert.equal(wall(t, NY), "2026-03-08 03:30");
	assert.equal(wall(nextCronTime("30 2 * * *", t, NY), NY), "2026-03-09 02:30");
	// hourly job: 02:30 does not exist, 03:30 still fires exactly once
	assert.deepEqual(seq("30 * * * *", "2026-03-08 00:45", 3, NY), ["2026-03-08 01:30", "2026-03-08 03:30", "2026-03-08 04:30"]);
	// a fixed 03:00 job is unaffected
	assert.equal(new Date(nextCronTime("0 3 * * *", from, NY)!).toISOString(), "2026-03-08T07:00:00.000Z");
});

test("DST fall back: fixed-time jobs fire once, hourly jobs follow real time", () => {
	// 2026-11-01 02:00 EDT → 01:00 EST: 01:xx happens twice
	const from = at("2026-10-31 12:00", NY);
	const t = nextCronTime("30 1 * * *", from, NY)!;
	assert.equal(new Date(t).toISOString(), "2026-11-01T05:30:00.000Z"); // first 01:30 (EDT)
	assert.equal(new Date(nextCronTime("30 1 * * *", t, NY)!).toISOString(), "2026-11-02T06:30:00.000Z"); // not again at 01:30 EST
	// hourly: both 01:30s, one hour apart
	const h1 = nextCronTime("30 * * * *", at("2026-11-01 00:45", NY), NY)!;
	const h2 = nextCronTime("30 * * * *", h1, NY)!;
	const h3 = nextCronTime("30 * * * *", h2, NY)!;
	assert.deepEqual([h1, h2, h3].map((x) => new Date(x).toISOString()), ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"]);
	assert.deepEqual([h1, h2, h3].map((x) => wall(x, NY)), ["2026-11-01 01:30", "2026-11-01 01:30", "2026-11-01 02:30"]);
});

test("zonedInstant: ordinary, gap and overlap wall times", () => {
	assert.equal(new Date(zonedInstant({ y: 2026, mo: 11, d: 9, h: 9, mi: 0 }, SH)).toISOString(), "2026-11-09T01:00:00.000Z");
	assert.equal(new Date(zonedInstant({ y: 2026, mo: 3, d: 8, h: 2, mi: 15 }, NY)).toISOString(), "2026-03-08T07:15:00.000Z");
	assert.equal(new Date(zonedInstant({ y: 2026, mo: 11, d: 1, h: 1, mi: 15 }, NY)).toISOString(), "2026-11-01T05:15:00.000Z");
});

test("parseDuration", () => {
	assert.equal(parseDuration("30s"), 30_000);
	assert.equal(parseDuration("10m"), 600_000);
	assert.equal(parseDuration("2h"), 7_200_000);
	assert.equal(parseDuration("1h30m"), 5_400_000);
	assert.equal(parseDuration("1d"), 86_400_000);
	assert.equal(parseDuration("1w"), 7 * 86_400_000);
	assert.equal(parseDuration("45"), 45 * 60_000); // bare number = minutes
	assert.equal(parseDuration("1.5h"), 5_400_000);
	for (const bad of ["", "abc", "10x", "h", "0s", "-5m", "5m extra"]) assert.throws(() => parseDuration(bad), CronError, bad);
});

test("parseAt: wall times in the job zone, ISO with offset, HH:MM", () => {
	assert.equal(new Date(parseAt("2026-11-09 09:00", SH)).toISOString(), "2026-11-09T01:00:00.000Z");
	assert.equal(new Date(parseAt("2026-11-09T09:00:30", "UTC")).toISOString(), "2026-11-09T09:00:30.000Z");
	assert.equal(new Date(parseAt("2026-11-09", SH)).toISOString(), "2026-11-08T16:00:00.000Z");
	assert.equal(new Date(parseAt("2026-11-09T09:00:00+02:00", SH)).toISOString(), "2026-11-09T07:00:00.000Z");
	const now = at("2026-11-09 10:00");
	assert.equal(wall(parseAt("09:00", SH, now)), "2026-11-10 09:00");
	assert.equal(wall(parseAt("11:00", SH, now)), "2026-11-09 11:00");
	for (const bad of ["tomorrow", "2026-13-01 00:00", "25:00", "2026-11-09 9"]) assert.throws(() => parseAt(bad, SH), CronError, bad);
});

test("parseRule: exactly one trigger, time zone default and validation", () => {
	const now = Date.UTC(2026, 10, 9, 0, 0);
	assert.deepEqual(parseRule({ cron: "0 9 * * *" }, now, SH), { rule: { kind: "cron", expr: "0 9 * * *" }, tz: SH });
	assert.deepEqual(parseRule({ every: "2h", tz: NY }, now, SH), { rule: { kind: "every", everyMs: 7_200_000, anchor: now }, tz: NY });
	assert.deepEqual(parseRule({ in: "30m" }, now, SH).rule, { kind: "at", at: now + 1_800_000 });
	assert.deepEqual(parseRule({ at: "2026-11-09 09:00" }, now, SH).rule, { kind: "at", at: Date.UTC(2026, 10, 9, 1, 0) });
	assert.throws(() => parseRule({}, now, SH), /exactly one/);
	assert.throws(() => parseRule({ cron: "0 9 * * *", every: "1h" }, now, SH), /exactly one/);
	assert.throws(() => parseRule({ cron: "0 9 * * *", tz: "Mars/Olympus" }, now, SH), /time zone/);
	assert.throws(() => parseRule({ every: "500" + "ms" }, now, SH), CronError);
	assert.throws(() => parseRule({ cron: "0 0 31 2 *" }, now, SH), /never fires/);
});

test("nextRun / runsBetween for every and at rules", () => {
	const every = { kind: "every" as const, everyMs: 10_000, anchor: 1_000_000 };
	assert.equal(nextRun(every, 0, "UTC"), 1_000_000);
	assert.equal(nextRun(every, 1_000_000, "UTC"), 1_010_000);
	assert.equal(nextRun(every, 1_015_000, "UTC"), 1_020_000);
	assert.deepEqual(runsBetween(every, 1_000_000, 1_035_000, "UTC"), [1_010_000, 1_020_000, 1_030_000]);
	const once = { kind: "at" as const, at: 5000 };
	assert.equal(nextRun(once, 4999, "UTC"), 5000);
	assert.equal(nextRun(once, 5000, "UTC"), undefined);
	assert.match(describeRule({ kind: "every", everyMs: 5_400_000, anchor: 0 }, SH), /every 1h30m/);
	assert.match(describeRule({ kind: "cron", expr: "0 9 * * *" }, SH), /Asia\/Shanghai/);
});

// ---------------------------------------------------------------- timer decisions

const base = { enabled: true, rule: { kind: "every" as const, everyMs: 60_000, anchor: 0 }, tz: "UTC", overlap: "skip" as const, catchUp: "latest" as const };
const BOOT = 1_000_000;

test("decide: nothing before the slot, fire when due", () => {
	assert.deepEqual(decide({ ...base, nextRunAt: BOOT + 60_000 }, BOOT + 59_000, BOOT, false), { action: "none" });
	const d = decide({ ...base, nextRunAt: 1_020_000 }, 1_020_500, BOOT, false);
	assert.deepEqual(d, { action: "fire", trigger: "schedule", scheduledAt: 1_020_000, missed: 0, next: 1_080_000 });
	assert.deepEqual(decide({ ...base, enabled: false, nextRunAt: 1_020_000 }, 1_020_500, BOOT, false), { action: "none" });
	assert.deepEqual(decide({ ...base, finished: true, nextRunAt: 1_020_000 }, 1_020_500, BOOT, false), { action: "none" });
});

test("decide: overlap policies", () => {
	const j = { ...base, nextRunAt: 1_020_000 };
	assert.equal(decide({ ...j, overlap: "skip" }, 1_020_500, BOOT, true).action, "skip");
	assert.equal(decide({ ...j, overlap: "queue" }, 1_020_500, BOOT, true).action, "queue");
	assert.equal(decide({ ...j, overlap: "parallel" }, 1_020_500, BOOT, true).action, "fire");
	// a queued run starts once the previous one is done, without waiting for the next slot
	assert.deepEqual(decide({ ...base, nextRunAt: 1_080_000, queued: 1_020_000 }, 1_030_000, BOOT, false), { action: "fire", trigger: "queued", scheduledAt: 1_020_000, missed: 0, next: 1_080_000 });
	assert.deepEqual(decide({ ...base, nextRunAt: 1_080_000, queued: 1_020_000 }, 1_030_000, BOOT, true), { action: "none" });
});

test("decide: missed slots while the hub was down → catch up the latest once, or skip", () => {
	// hub was down from 0.4M to BOOT (1.0M): slots 0.42M … 0.96M passed (every 60s)
	const j = { ...base, nextRunAt: 420_000 };
	const d = decide(j, BOOT + 1000, BOOT, false);
	assert.equal(d.action, "fire");
	assert.equal((d as any).trigger, "catchup");
	assert.equal((d as any).scheduledAt, 960_000); // the latest missed slot
	assert.equal((d as any).missed, 10);
	assert.equal((d as any).next, 1_020_000);
	const s = decide({ ...j, catchUp: "skip" }, BOOT + 1000, BOOT, false);
	assert.equal(s.action, "skip");
	assert.equal((s as any).result, "missed");
	assert.equal((s as any).next, 1_020_000);
	// a slot that is only slightly late during normal operation is not "missed"
	assert.equal((decide({ ...base, nextRunAt: BOOT + 60_000 }, BOOT + 65_000, BOOT, false) as any).trigger, "schedule");
	// but a long stall (beyond the grace period) is
	const hourly = { ...base, rule: { kind: "every" as const, everyMs: 3600_000, anchor: 0 } };
	assert.equal((decide({ ...hourly, nextRunAt: 3600_000 }, 3600_000 + 120_000, BOOT, false) as any).trigger, "catchup");
});

test("decide: one-shot jobs", () => {
	const once = { ...base, rule: { kind: "at" as const, at: 1_020_000 }, nextRunAt: 1_020_000 };
	assert.deepEqual(decide(once, 1_020_100, BOOT, false), { action: "fire", trigger: "schedule", scheduledAt: 1_020_000, missed: 0, next: undefined });
	const missed = { ...once, rule: { kind: "at" as const, at: 900_000 }, nextRunAt: 900_000 };
	assert.equal((decide(missed, BOOT + 10, BOOT, false) as any).trigger, "catchup");
	assert.equal(decide({ ...missed, catchUp: "skip" }, BOOT + 10, BOOT, false).action, "skip");
});

test("renderBrief substitutes placeholders and adds run context", () => {
	const job = { id: "s1234", title: "日报", brief: "整理 {{date}} 的日报（第 {{n}} 次，{{ time }}）", rule: { kind: "cron", expr: "0 9 * * *" }, tz: SH } as CronJob;
	const b = renderBrief(job, at("2026-11-09 09:00"), 3, "t00aa");
	assert.match(b, /^整理 2026-11-09 的日报（第 3 次，09:00）/);
	assert.match(b, /s1234「日报」的第 3 次运行/);
	assert.match(b, /上一次运行的任务 t00aa/);
});
