// Scheduled tasks (cron): rule parsing, next-run computation (time zones + DST) and the pure
// scheduling decision used by the hub's timer (hub/cron.ts). Zero dependencies.
//
// Not to be confused with shared/schedule.ts, which picks the *machine* for a dispatch.
//
// Rules (exactly one per job):
//   cron   standard 5-field expression "m h dom mon dow" (* , - / , month/day names, @daily …), in a time zone
//   every  fixed interval (e.g. 2h), counted from an anchor instant; DST does not affect it
//   at     a single instant (from "2026-11-09 09:00" in the job's time zone, an ISO string, or "in 30m")
//
// DST policy for cron rules (same as Vixie cron / cronie for "fixed-time" jobs):
//   - a wall-clock time that does not exist (spring forward gap) fires right after the jump, e.g. 02:30 → 03:30
//   - a wall-clock time that exists twice (fall back overlap) fires once, at the first occurrence —
//     except for jobs that run every hour (hour field covers all 24 hours), which follow real time
//     and also fire in the repeated hour

export type CronRule = { kind: "cron"; expr: string } | { kind: "every"; everyMs: number; anchor: number } | { kind: "at"; at: number };
export type OverlapPolicy = "skip" | "queue" | "parallel";
export type CatchUpPolicy = "latest" | "skip";

export interface CronRun {
	/** When this run was decided (ms). */
	at: number;
	/** Scheduled time it belongs to (ms), absent for manual runs. */
	scheduledAt?: number;
	trigger: "schedule" | "catchup" | "manual" | "queued";
	result: "dispatched" | "skipped" | "queued" | "missed" | "failed";
	taskId?: string;
	machine?: string;
	reason?: string;
}

export interface CronJob {
	id: string;
	/** Hub (machine) that owns the job: the only one whose timer fires it. */
	hub: string;
	rev: number;
	title: string;
	/** Task brief template ({{date}} {{time}} {{datetime}} {{n}} are substituted per run). */
	brief: string;
	rule: CronRule;
	/** IANA time zone used for cron rules and for "at" wall times (default: the hub's local zone). */
	tz: string;
	machine?: string;
	requires?: string[];
	cwd?: string;
	/** Project of the tasks it dispatches (shared/projects.ts; default: inferred per run). */
	project?: string;
	enabled: boolean;
	overlap: OverlapPolicy;
	catchUp: CatchUpPolicy;
	/** Successful runs are archived right away (no 待扫 entry). */
	silent: boolean;
	createdAt: number;
	updatedAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	runCount: number;
	/** A run is waiting for the previous one to finish (overlap=queue, at most one). */
	queued?: number;
	/** Most recent runs, newest last (bounded). */
	runs: CronRun[];
	/** One-shot job has fired (or was skipped); it will not fire again. */
	finished?: boolean;
	/** Tombstone so mesh replicas learn about deletions. */
	deleted?: boolean;
	/** Who created it (cli/tui/api/ui). */
	createdBy?: string;
	/** Team member the runs are dispatched for (task requester); absent in single-user setups. */
	requester?: string;
}

export class CronError extends Error {}

// ---------------------------------------------------------------- cron expressions

export interface CronSpec {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	/** 0 = Sunday … 6 = Saturday (7 is folded into 0). */
	dow: number[];
	domStar: boolean;
	dowStar: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ALIASES: Record<string, string> = {
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly": "0 * * * *",
};

function parseField(src: string, min: number, max: number, names: string[] | undefined, label: string): { values: number[]; star: boolean } {
	const out = new Set<number>();
	const num = (s: string) => {
		const lower = s.toLowerCase();
		const n = names ? names.indexOf(lower) : -1;
		if (n >= 0) return n + (names === MONTHS ? 1 : 0);
		if (!/^\d+$/.test(s)) throw new CronError(`cron ${label}: invalid value "${s}"`);
		return Number(s);
	};
	let star = false;
	for (const part of src.split(",")) {
		if (!part) throw new CronError(`cron ${label}: empty list item in "${src}"`);
		const [range, stepS, extra] = part.split("/");
		if (extra !== undefined) throw new CronError(`cron ${label}: invalid step in "${part}"`);
		let step = 1;
		if (stepS !== undefined) {
			if (!/^\d+$/.test(stepS) || Number(stepS) < 1) throw new CronError(`cron ${label}: invalid step "${stepS}"`);
			step = Number(stepS);
		}
		let lo: number;
		let hi: number;
		if (range === "*") {
			lo = min;
			hi = max;
			if (stepS === undefined) star = true;
		} else if (range!.includes("-")) {
			const [a, b, c] = range!.split("-");
			if (c !== undefined || !a || !b) throw new CronError(`cron ${label}: invalid range "${range}"`);
			lo = num(a);
			hi = num(b);
		} else {
			lo = num(range!);
			// "5/15" means 5,20,35,50 (from 5 to max)
			hi = stepS !== undefined ? max : lo;
		}
		if (lo < min || hi > max || lo > hi) throw new CronError(`cron ${label}: ${range} out of range ${min}-${max}`);
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return { values: [...out].sort((a, b) => a - b), star };
}

export function parseCron(expr: string): CronSpec {
	const src = (ALIASES[expr.trim().toLowerCase()] ?? expr).trim();
	const f = src.split(/\s+/);
	if (f.length !== 5) throw new CronError(`cron expression needs 5 fields (minute hour day-of-month month day-of-week), got ${f.length}: "${expr}"`);
	const minute = parseField(f[0]!, 0, 59, undefined, "minute");
	const hour = parseField(f[1]!, 0, 23, undefined, "hour");
	const dom = parseField(f[2]!, 1, 31, undefined, "day-of-month");
	const month = parseField(f[3]!, 1, 12, MONTHS, "month");
	const dowRaw = parseField(f[4]!, 0, 7, DAYS, "day-of-week");
	const dow = [...new Set(dowRaw.values.map((d) => d % 7))].sort((a, b) => a - b);
	// "*/2" style restricts the field (it is not a star for the dom/dow OR rule)
	return { minute: minute.values, hour: hour.values, dom: dom.values, month: month.values, dow, domStar: dom.star, dowStar: dowRaw.star };
}

// ---------------------------------------------------------------- time zones

export function localTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function validTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
	let f = fmtCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
		fmtCache.set(tz, f);
	}
	return f;
}

export interface Wall {
	y: number;
	mo: number; // 1-12
	d: number;
	h: number;
	mi: number;
	s?: number;
}

/** Wall-clock time of an instant in a zone. */
export function wallTime(ms: number, tz: string): Wall & { s: number } {
	const p: Record<string, number> = {};
	for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
	return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** Zone offset (ms, local − UTC) at an instant. */
export function zoneOffset(ms: number, tz: string): number {
	const w = wallTime(ms, tz);
	return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant of a wall-clock time in a zone. Overlap (time exists twice) → the earlier instant;
 * gap (time does not exist) → shifted forward by the gap (02:30 → 03:30).
 */
export function zonedInstant(w: Wall, tz: string): number {
	return Math.min(...zonedInstants(w, tz));
}

/** All instants of a wall-clock time (two during a fall-back overlap; the shifted one in a gap). */
export function zonedInstants(w: Wall, tz: string): number[] {
	const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s ?? 0);
	const offs = [...new Set([zoneOffset(naive - 86400_000, tz), zoneOffset(naive, tz), zoneOffset(naive + 86400_000, tz)])];
	const same = (ms: number) => {
		const x = wallTime(ms, tz);
		return x.y === w.y && x.mo === w.mo && x.d === w.d && x.h === w.h && x.mi === w.mi;
	};
	const valid = [...new Set(offs.map((o) => naive - o).filter(same))].sort((a, b) => a - b);
	if (valid.length) return valid;
	// gap: interpret with the offset in effect before the transition
	return [naive - zoneOffset(naive - 86400_000, tz)];
}

// ---------------------------------------------------------------- next run

/** First instant strictly after `after` (ms) matching the cron spec in `tz`; undefined if none within ~8 years. */
export function nextCronTime(spec: CronSpec | string, after: number, tz: string = localTimeZone()): number | undefined {
	const s = typeof spec === "string" ? parseCron(spec) : spec;
	const start = wallTime(after, tz);
	// Walk calendar days in the zone's wall clock (a day before, to be safe around DST shifts).
	let day = Date.UTC(start.y, start.mo - 1, start.d) - 86400_000;
	const dayMatches = (dt: Date) => {
		if (!s.month.includes(dt.getUTCMonth() + 1)) return false;
		const domOk = s.dom.includes(dt.getUTCDate());
		const dowOk = s.dow.includes(dt.getUTCDay());
		// Standard cron: when both day fields are restricted, either may match.
		if (s.domStar && s.dowStar) return true;
		if (s.domStar) return dowOk;
		if (s.dowStar) return domOk;
		return domOk || dowOk;
	};
	const everyHour = s.hour.length === 24;
	const afterNaive = Date.UTC(start.y, start.mo - 1, start.d, start.h, start.mi);
	for (let i = 0; i < 366 * 8 + 2; i++, day += 86400_000) {
		const dt = new Date(day);
		if (!dayMatches(dt)) continue;
		let best: number | undefined;
		let bestHour = -1;
		// Days without an offset change (almost all) map wall → instant with a constant offset.
		const off0 = zoneOffset(day - 14 * 3600_000, tz);
		const steady = off0 === zoneOffset(day + 38 * 3600_000, tz);
		for (const h of s.hour) {
			// A DST gap shifts a time forward by at most a couple of hours: stop once later hours cannot win.
			if (best !== undefined && h > bestHour + 2) break;
			for (const mi of s.minute) {
				// Cheap prefilter on the naive wall clock (offsets change by < 3h within a day).
				const naive = day + h * 3600_000 + mi * 60_000;
				if (naive < afterNaive - 3 * 3600_000) continue;
				if (steady) {
					if (naive - off0 <= after) continue;
					if (best === undefined || naive - off0 < best) {
						best = naive - off0;
						bestHour = h;
					}
					break;
				}
				const w = { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h, mi };
				// Hourly-or-finer jobs follow real time (they also run in a repeated hour); fixed-time jobs run once.
				const t = (everyHour ? zonedInstants(w, tz) : [zonedInstant(w, tz)]).find((x) => x > after);
				if (t !== undefined) {
					if (best === undefined || t < best) {
						best = t;
						bestHour = h;
					}
					break; // minutes ascend (and gap shifts are monotonic)
				}
			}
		}
		if (best !== undefined) return best;
	}
	return undefined;
}

/** Next fire time of a rule strictly after `after`. */
export function nextRun(rule: CronRule, after: number, tz: string): number | undefined {
	if (rule.kind === "cron") return nextCronTime(rule.expr, after, tz);
	if (rule.kind === "every") {
		if (after < rule.anchor) return rule.anchor;
		const n = Math.floor((after - rule.anchor) / rule.everyMs) + 1;
		return rule.anchor + n * rule.everyMs;
	}
	return rule.at > after ? rule.at : undefined;
}

/** Scheduled times in (from, to], at most `limit` (used to count missed runs). */
export function runsBetween(rule: CronRule, from: number, to: number, tz: string, limit = 1000): number[] {
	const out: number[] = [];
	for (let t = nextRun(rule, from, tz); t !== undefined && t <= to && out.length < limit; t = nextRun(rule, t, tz)) out.push(t);
	return out;
}

// ---------------------------------------------------------------- parsing user input

const UNIT: Record<string, number> = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3600_000, hr: 3600_000, d: 86400_000, w: 7 * 86400_000 };

/** "30m", "2h", "1h30m", "90s", "1d", "45" (minutes) → ms. */
export function parseDuration(s: string): number {
	const src = String(s).trim().toLowerCase().replace(/\s+/g, "");
	if (/^\d+(\.\d+)?$/.test(src)) return Math.round(Number(src) * 60_000);
	const re = /(\d+(?:\.\d+)?)(sec|min|hr|s|m|h|d|w)/g;
	let total = 0;
	let consumed = 0;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		if (m.index !== consumed) break;
		total += Number(m[1]) * UNIT[m[2]!]!;
		consumed = m.index + m[0].length;
	}
	if (!src || consumed !== src.length || total <= 0) throw new CronError(`invalid duration "${s}" (examples: 30s, 10m, 2h, 1h30m, 1d)`);
	return Math.round(total);
}

/**
 * Absolute time: ISO with zone ("2026-11-09T09:00:00Z", "…+08:00"), or a wall time in `tz`:
 * "2026-11-09 09:00", "2026-11-09T09:00:30", "2026-11-09" (00:00), "09:00" (next occurrence).
 */
export function parseAt(s: string, tz: string, now = Date.now()): number {
	const src = String(s).trim();
	if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i.test(src)) {
		const t = Date.parse(src);
		if (Number.isFinite(t)) return t;
	}
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(src);
	if (m) {
		const w = { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
		if (w.mo < 1 || w.mo > 12 || w.d < 1 || w.d > 31 || w.h > 23 || w.mi > 59 || w.s > 59) throw new CronError(`invalid time "${s}"`);
		return zonedInstant(w, tz);
	}
	m = /^(\d{1,2}):(\d{2})$/.exec(src);
	if (m) {
		const h = +m[1]!;
		const mi = +m[2]!;
		if (h > 23 || mi > 59) throw new CronError(`invalid time "${s}"`);
		return nextCronTime(`${mi} ${h} * * *`, now, tz)!;
	}
	throw new CronError(`invalid time "${s}" (use "YYYY-MM-DD HH:MM" in ${tz}, an ISO time with offset, or --in 30m)`);
}

export interface RuleInput {
	cron?: string;
	every?: string | number;
	at?: string | number;
	in?: string | number;
	tz?: string;
}

/** Normalise user input (exactly one of cron / every / at / in) into a rule. */
export function parseRule(input: RuleInput, now = Date.now(), defaultTz = localTimeZone()): { rule: CronRule; tz: string } {
	const tz = (input.tz ?? "").trim() || defaultTz;
	if (!validTimeZone(tz)) throw new CronError(`unknown time zone "${tz}"`);
	const given = (["cron", "every", "at", "in"] as const).filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== "");
	if (given.length !== 1) throw new CronError(`give exactly one of cron / every / at / in (got ${given.length ? given.join(", ") : "none"})`);
	const k = given[0]!;
	const ms = (v: string | number) => (typeof v === "number" ? v : parseDuration(v));
	if (k === "cron") {
		const expr = String(input.cron).trim();
		parseCron(expr);
		if (nextCronTime(expr, now, tz) === undefined) throw new CronError(`cron "${expr}" never fires`);
		return { rule: { kind: "cron", expr }, tz };
	}
	if (k === "every") {
		const everyMs = ms(input.every!);
		if (!(everyMs >= 1000)) throw new CronError("interval must be at least 1s");
		return { rule: { kind: "every", everyMs, anchor: now }, tz };
	}
	if (k === "in") {
		const d = ms(input.in!);
		if (!(d > 0)) throw new CronError("delay must be positive");
		return { rule: { kind: "at", at: now + d }, tz };
	}
	const at = typeof input.at === "number" ? input.at : parseAt(String(input.at), tz, now);
	return { rule: { kind: "at", at }, tz };
}

// ---------------------------------------------------------------- display

export function formatDuration(ms: number): string {
	const parts: string[] = [];
	let r = Math.round(ms / 1000);
	for (const [u, n] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
		if (r >= n) {
			parts.push(`${Math.floor(r / n)}${u}`);
			r %= n;
		}
	}
	return parts.join("") || "0s";
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-11-09 09:00" in tz. */
export function formatWall(ms: number, tz: string, seconds = false): string {
	const w = wallTime(ms, tz);
	return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}${seconds ? `:${pad(w.s)}` : ""}`;
}

export function describeRule(rule: CronRule, tz: string): string {
	if (rule.kind === "cron") return `cron "${rule.expr}" (${tz})`;
	if (rule.kind === "every") return `every ${formatDuration(rule.everyMs)}`;
	return `once at ${formatWall(rule.at, tz, true)} (${tz})`;
}

/** Brief for one run: placeholders substituted, plus a short footer the worker can rely on. */
export function renderBrief(job: CronJob, firedAt: number, n: number, prevTaskId?: string): string {
	const date = formatWall(firedAt, job.tz).slice(0, 10);
	const time = formatWall(firedAt, job.tz).slice(11);
	const body = job.brief.replace(/\{\{\s*(date|time|datetime|n)\s*\}\}/g, (_m, k: string) => ({ date, time, datetime: `${date} ${time}`, n: String(n) })[k]!);
	return [
		body,
		"",
		"---",
		`这是定时计划 ${job.id}「${job.title}」的第 ${n} 次运行（${describeRule(job.rule, job.tz)}；本次触发 ${date} ${time} ${job.tz}${prevTaskId ? `；上一次运行的任务 ${prevTaskId}` : ""}）。`,
		"按简报完成后用 qa_report 汇报；需要人类决定时用 needs_input，无法完成时用 blocked。",
	].join("\n");
}

// ---------------------------------------------------------------- scheduling decision

export const LATE_GRACE_MS = 90_000;

export type Decision =
	| { action: "none" }
	/** Fire a run now (scheduledAt is the slot it belongs to). */
	| { action: "fire"; trigger: CronRun["trigger"]; scheduledAt?: number; missed: number; next?: number }
	/** Slot passed but we must not run now (overlap=skip, or missed with catchUp=skip). */
	| { action: "skip"; result: "skipped" | "missed"; reason: string; scheduledAt?: number; missed: number; next?: number }
	/** Remember one pending run (overlap=queue). */
	| { action: "queue"; scheduledAt: number; missed: number; next?: number };

/**
 * What the timer should do for a job at `now`.
 * `bootAt`: when this hub process started — slots before it were missed while the hub was down.
 * `running`: a previous run is still in progress.
 */
export function decide(job: Pick<CronJob, "enabled" | "finished" | "deleted" | "nextRunAt" | "rule" | "tz" | "overlap" | "catchUp" | "queued">, now: number, bootAt: number, running: boolean): Decision {
	if (!job.enabled || job.finished || job.deleted) return { action: "none" };
	const due = job.nextRunAt;
	if (due === undefined || due > now) {
		// No slot due: a queued run starts as soon as the previous one is done.
		if (job.queued && !running) return { action: "fire", trigger: "queued", scheduledAt: job.queued, missed: 0, next: due };
		return { action: "none" };
	}
	const slots = [due, ...runsBetween(job.rule, due, now, job.tz, 10_000)];
	const latest = slots[slots.length - 1]!;
	const next = nextRun(job.rule, now, job.tz);
	// Missed: the slot passed while the hub was not running (or the hub was stalled for long).
	const missedSlot = latest < bootAt || now - latest > LATE_GRACE_MS;
	const missed = missedSlot ? slots.length : slots.length - 1;
	if (missedSlot && job.catchUp === "skip") return { action: "skip", result: "missed", reason: `missed ${slots.length} run(s) while the hub was down (catch-up off)`, scheduledAt: latest, missed, next };
	if (running) {
		if (job.overlap === "skip") return { action: "skip", result: "skipped", reason: "previous run still in progress", scheduledAt: latest, missed, next };
		if (job.overlap === "queue") return { action: "queue", scheduledAt: latest, missed, next };
	}
	return { action: "fire", trigger: missedSlot ? "catchup" : "schedule", scheduledAt: latest, missed, next };
}
