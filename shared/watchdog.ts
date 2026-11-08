// Expected time + watchdog review (预期时间与巡检): the pure part, shared by the hub, the CLI, the
// extensions and the tests. See docs/watchdog.md for the design and its reasons.
//
//   - Every task carries an expectation (Task.expect): from the dispatch (qa_dispatch expected="20m"),
//     revised once by the worker (qa_expect, with a reason), by an ON_TRACK review, or a default by kind.
//   - The hub keeps an active-time clock (Task.clock): time spent starting/running, not waiting on a human.
//   - triggerFor() decides when a task deserves an independent, read-only review: over the expectation by
//     a growing multiple (1.5x, 3x, 6x …), no progress for N minutes, a repeated pattern in the worker's
//     recent tool calls (detectRepeats), or a follow-up after a correction. Cooldown + dedupe keep the
//     reviews themselves from becoming noise.
//   - decideAction() maps a verdict to what the hub does: ON_TRACK is silent, DRIFTING / STUCK /
//     BAD_APPROACH send a correction to the worker (escalated to the human when it happens again),
//     NEEDS_HUMAN goes to 需要你.
// No I/O here.
import { parseDuration } from "./cron.ts";
import type { Task, TaskStatus } from "./types.ts";

export type Verdict = "ON_TRACK" | "DRIFTING" | "STUCK" | "BAD_APPROACH" | "NEEDS_HUMAN";
export const VERDICTS: Verdict[] = ["ON_TRACK", "DRIFTING", "STUCK", "BAD_APPROACH", "NEEDS_HUMAN"];
export const VERDICT_LABEL: Record<Verdict, string> = {
	ON_TRACK: "正常，只是比预估难",
	DRIFTING: "偏离了简报",
	STUCK: "陷入死胡同或循环",
	BAD_APPROACH: "方法有问题",
	NEEDS_HUMAN: "需要人拍板",
};

export type TriggerKind = "overtime" | "stalled" | "repeat" | "followup" | "manual";
export const TRIGGER_LABEL: Record<TriggerKind, string> = { overtime: "超时", stalled: "无进展", repeat: "重复模式", followup: "纠偏后复查", manual: "手动" };

/** Where the current expectation came from. */
export type ExpectSource = "dispatch" | "default" | "worker" | "watchdog";
export const EXPECT_SOURCE_LABEL: Record<ExpectSource, string> = { dispatch: "派单预估", default: "按类型默认", worker: "worker 修正", watchdog: "巡检更新" };

export interface TaskExpect {
	/** Expected active time of the whole task, minutes. */
	minutes: number;
	source: ExpectSource;
	reason?: string;
	at: number;
	/** First expectation (what the dispatch / default said), minutes. */
	initial?: number;
	/** The worker has used its one revision. */
	workerRevised?: boolean;
}

/** Active-time clock maintained by the owning hub. */
export interface TaskClock {
	/** Accumulated active (starting/running) time before activeSince, ms. */
	activeMs: number;
	/** Set while the task is active. */
	activeSince?: number;
	/** Last real progress: a report, a progress update, a status change or a message (not activity pings). */
	progressAt?: number;
}

export type WatchAction = "silent" | "corrected" | "escalated" | "error";

export interface WatchReview {
	at: number;
	trigger: TriggerKind;
	/** Why it was triggered, one line (e.g. "已用 31m，超过预期 20m 的 1.5x"). */
	detail: string;
	verdict?: Verdict;
	evidence?: string;
	advice?: string;
	/** New total estimate from the reviewer (ON_TRACK), minutes. */
	expected?: number;
	action: WatchAction;
	/** Error text when the review itself failed. */
	error?: string;
	durationMs?: number;
}

/** Watchdog state of one task (Task.watch). */
export interface TaskWatch {
	/** Watchdog turned off for this task (e.g. long polling jobs). */
	off?: boolean;
	/** Newest last, at most MAX_REVIEWS. */
	reviews: WatchReview[];
	/** A review is running right now. */
	running?: { at: number; trigger: TriggerKind };
	/** Overtime reviews done against the current expectation (index into the multipliers). */
	overLevel?: number;
	/** Corrections sent since the last ON_TRACK / human message. */
	corrections?: number;
	/** A correction was sent; re-check once after the cooldown. */
	followupDue?: boolean;
	/** progressAt value a stall review was already done for (one review per stall). */
	stallSeen?: number;
	/** Signatures of repeat patterns already reviewed. */
	repeatSeen?: string[];
	/** Escalated to the human: shown as 需要你 until answered, acknowledged or the task stops. */
	pending?: { at: number; verdict: Verdict; question: string; options?: string[]; advice?: string };
}

export const MAX_REVIEWS = 12;

export interface WatchdogConfig {
	enabled: boolean;
	/** Overtime thresholds as multiples of the expectation; beyond the last one it keeps doubling. */
	multipliers: number[];
	/** Minimum minutes between two reviews of the same task. */
	cooldownMinutes: number;
	/** Minutes without progress (while running) before a review; 0 = off. */
	stallMinutes: number;
	/** Repeat detection: same call+result / same error / edit flip-flop at least `threshold` times among the last `window` tool calls. */
	repeatThreshold: number;
	repeatWindow: number;
	/** Model of the reviewer agent (default: workerModel / model). A cheaper, faster one is fine. */
	model?: string;
	/** Thinking level of the reviewer (pi --thinking). */
	thinking?: string;
	/** Reviewer gives up after this many minutes (the review is recorded as an error). */
	timeoutMinutes: number;
	/** Corrections sent before a further problem verdict is escalated to the human. */
	maxCorrections: number;
	/** Reviews running at the same time on this hub. */
	maxConcurrent: number;
	/** Seconds between checks. */
	tickSeconds: number;
	/** pi executable for the reviewer (default "pi"). */
	piBin?: string;
	/** Replace the reviewer entirely (tests): argv; the prompt file path is appended. Must print the verdict JSON. */
	command?: string[];
	/** Defaults by kind of task, minutes. */
	defaults: { small: number; normal: number; large: number; cron: number };
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
	enabled: true,
	multipliers: [1.5, 3, 6],
	cooldownMinutes: 10,
	stallMinutes: 20,
	repeatThreshold: 4,
	repeatWindow: 30,
	timeoutMinutes: 8,
	maxCorrections: 1,
	maxConcurrent: 2,
	tickSeconds: 30,
	defaults: { small: 15, normal: 30, large: 60, cron: 15 },
};

/** config.json "watchdog" → effective config (unknown / invalid values fall back to the defaults). */
export function watchdogConfig(raw: any = {}): WatchdogConfig {
	const d = DEFAULT_WATCHDOG;
	const num = (v: unknown, def: number, min = 0) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : def);
	const mult = Array.isArray(raw?.multipliers) ? raw.multipliers.map(Number).filter((x: number) => Number.isFinite(x) && x > 0).sort((a: number, b: number) => a - b) : [];
	const env = process.env.QA_WATCHDOG;
	return {
		enabled: env !== undefined ? !/^(0|off|false|no)$/i.test(env) : raw?.enabled !== false,
		multipliers: mult.length ? mult : d.multipliers,
		cooldownMinutes: num(raw?.cooldownMinutes, d.cooldownMinutes),
		stallMinutes: num(raw?.stallMinutes, d.stallMinutes),
		repeatThreshold: Math.max(2, Math.round(num(raw?.repeatThreshold, d.repeatThreshold, 2))),
		repeatWindow: Math.max(4, Math.round(num(raw?.repeatWindow, d.repeatWindow, 4))),
		model: typeof raw?.model === "string" && raw.model ? raw.model : undefined,
		thinking: typeof raw?.thinking === "string" && raw.thinking ? raw.thinking : undefined,
		timeoutMinutes: num(raw?.timeoutMinutes, d.timeoutMinutes, 0.1),
		maxCorrections: Math.round(num(raw?.maxCorrections, d.maxCorrections)),
		maxConcurrent: Math.max(1, Math.round(num(raw?.maxConcurrent, d.maxConcurrent, 1))),
		tickSeconds: num(raw?.tickSeconds, d.tickSeconds, 0.2),
		piBin: typeof raw?.piBin === "string" && raw.piBin ? raw.piBin : undefined,
		command: Array.isArray(raw?.command) && raw.command.length ? raw.command.map(String) : undefined,
		defaults: {
			small: num(raw?.defaults?.small, d.defaults.small, 1),
			normal: num(raw?.defaults?.normal, d.defaults.normal, 1),
			large: num(raw?.defaults?.large, d.defaults.large, 1),
			cron: num(raw?.defaults?.cron, d.defaults.cron, 1),
		},
	};
}

// ---------------------------------------------------------------- expected time

/** "20m", "1h30m", "90s", "45" (minutes), 45 → minutes (fractional allowed); throws on garbage. */
export function parseExpected(v: string | number): number {
	if (typeof v === "number") {
		if (!(v > 0) || !Number.isFinite(v)) throw new Error(`invalid expected time: ${v}`);
		return v;
	}
	const ms = parseDuration(String(v));
	return ms / 60_000;
}

const LARGE = /发布|release|部署|deploy|迁移|migrat|重构|refactor|调研|research|设计文档|端到端|e2e|多机|架构|实现.*(功能|机制|系统)|新增.*(功能|机制)/i;
const SMALL = /typo|错别字|改文案|改个|小改|重命名|rename|查一下|看一下|确认一下|一句话|提醒/i;

/** Default expectation by kind of task when the dispatch gave none (heuristics, see docs/watchdog.md). */
export function defaultExpected(t: Pick<Task, "title" | "brief" | "source">, cfg: WatchdogConfig = DEFAULT_WATCHDOG): { minutes: number; kind: keyof WatchdogConfig["defaults"] } {
	if (t.source?.kind === "cron") return { minutes: cfg.defaults.cron, kind: "cron" };
	const text = `${t.title}\n${t.brief}`;
	if (LARGE.test(text) || t.brief.length > 2500) return { minutes: cfg.defaults.large, kind: "large" };
	if (t.brief.length < 300 && SMALL.test(text)) return { minutes: cfg.defaults.small, kind: "small" };
	return { minutes: cfg.defaults.normal, kind: "normal" };
}

export const ACTIVE_CLOCK: TaskStatus[] = ["starting", "running"];

/** Clock patch for a status change at `now` (call before applying it). */
export function clockOnStatus(clock: TaskClock | undefined, prev: TaskStatus, next: TaskStatus, now: number): TaskClock {
	const c: TaskClock = { activeMs: 0, ...clock };
	const was = ACTIVE_CLOCK.includes(prev) && c.activeSince !== undefined;
	const is = ACTIVE_CLOCK.includes(next);
	if (was && !is) {
		c.activeMs += Math.max(0, now - c.activeSince!);
		c.activeSince = undefined;
	} else if (!was && is) c.activeSince = now;
	if (prev !== next) c.progressAt = now;
	return c;
}

/** Active time of the task so far, ms. Tasks from before the clock existed fall back to wall time while active. */
export function elapsedMs(t: Pick<Task, "clock" | "status" | "createdAt" | "statusSince">, now = Date.now()): number {
	const c = t.clock;
	if (!c) return ACTIVE_CLOCK.includes(t.status) ? Math.max(0, now - (t.statusSince ?? t.createdAt)) : 0;
	return c.activeMs + (c.activeSince !== undefined ? Math.max(0, now - c.activeSince) : 0);
}

/** "12m", "1h05m", "45s". */
export function fmtMinutes(min: number): string {
	if (!Number.isFinite(min)) return "?";
	if (min < 1) return `${Math.max(0, Math.round(min * 60))}s`;
	if (min < 10 && Math.abs(min - Math.round(min)) * 60 >= 5) return `${Math.floor(min)}m${String(Math.round((min % 1) * 60)).padStart(2, "0")}s`;
	const m = Math.round(min);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Sum of per-step estimates in the worker's progress plan (minutes), if it gave any. */
export function planMinutes(t: object): number | undefined {
	const steps = (t.progress as any)?.steps;
	if (!Array.isArray(steps)) return undefined;
	let sum = 0;
	let any = false;
	for (const s of steps) {
		const m = Number(s?.expectedMinutes ?? s?.expected_minutes);
		if (Number.isFinite(m) && m > 0) {
			sum += m;
			any = true;
		}
	}
	return any ? sum : undefined;
}

/** Last real progress of the task, ms: the progress record (t8f4a) or the hub's clock. */
export function lastProgressAt(t: Pick<Task, "clock" | "statusSince" | "createdAt">): number {
	const p = Number((t.progress as any)?.updatedAt) || 0;
	return Math.max(p, t.clock?.progressAt ?? 0, t.statusSince ?? 0, t.createdAt);
}

export interface Timing {
	elapsedMin: number;
	expectedMin?: number;
	over: boolean;
	/** elapsed / expected. */
	ratio?: number;
	/** "12m / 20m" */
	label: string;
	/** "[OVER]" when over the expectation. */
	mark?: string;
}

export function timingOf(t: Task, now = Date.now()): Timing {
	const elapsedMin = elapsedMs(t, now) / 60_000;
	const expectedMin = t.expect?.minutes;
	const ratio = expectedMin ? elapsedMin / expectedMin : undefined;
	const over = ratio !== undefined && ratio > 1;
	return { elapsedMin, expectedMin, over, ratio, label: `${fmtMinutes(elapsedMin)} / ${expectedMin ? fmtMinutes(expectedMin) : "?"}`, mark: over ? "[OVER]" : undefined };
}

// ---------------------------------------------------------------- repeated patterns

export interface ToolCallRecord {
	ts: number;
	name: string;
	/** Normalised call key (name + args, whitespace collapsed). */
	key: string;
	/** Short human version of the call. */
	text: string;
	/** Short result text (tail of the output). */
	result: string;
	isError: boolean;
	/** edit: path + old/new text (flip-flop detection). */
	edit?: { path: string; old: string; new: string }[];
}

const squash = (s: unknown, n = 4000) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** Error/output text with volatile parts (numbers, hashes, temp paths) removed, for comparison. */
export function normalizeOutput(s: string): string {
	return squash(s, 2000)
		.replace(/\b[0-9a-f]{7,40}\b/gi, "#")
		.replace(/\d+(\.\d+)?/g, "#")
		.replace(/\/tmp\/\S+/g, "/tmp/…")
		.slice(-400);
}

function resultText(content: any): string {
	if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
	return String(content ?? "");
}

function describeCall(name: string, a: any): string {
	const s = a?.command ?? a?.path ?? a?.pattern ?? a?.query ?? a?.code ?? "";
	return `${name}${s ? ` ${squash(s, 200)}` : ""}`;
}

/**
 * Tool calls (with their results) from the tail of a pi session file (JSONL; internal detail of the
 * worker, never shown to the human). Unparseable lines (e.g. a cut-off first line) are skipped.
 */
export function parseToolCalls(jsonl: string, limit = 200): ToolCallRecord[] {
	const calls = new Map<string, ToolCallRecord>();
	const order: ToolCallRecord[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const m = e?.type === "message" ? e.message : undefined;
		if (!m) continue;
		const ts = Date.parse(e.timestamp) || Number(m.timestamp) || 0;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content) {
				if (c?.type !== "toolCall") continue;
				const args = c.arguments ?? {};
				const rec: ToolCallRecord = { ts, name: String(c.name), key: `${c.name} ${squash(JSON.stringify(args))}`, text: describeCall(String(c.name), args), result: "", isError: false };
				if (c.name === "edit") {
					const edits = Array.isArray(args.edits) ? args.edits : args.oldText !== undefined ? [{ oldText: args.oldText, newText: args.newText }] : [];
					rec.edit = edits.map((x: any) => ({ path: String(args.path ?? ""), old: squash(x?.oldText, 2000), new: squash(x?.newText, 2000) }));
				}
				calls.set(String(c.id), rec);
				order.push(rec);
			}
		} else if (m.role === "toolResult") {
			const rec = calls.get(String(m.toolCallId));
			if (rec) {
				rec.result = squash(resultText(m.content), 4000).slice(-600);
				rec.isError = m.isError === true;
			}
		}
	}
	return order.slice(-limit);
}

export interface RepeatSignal {
	kind: "same_call" | "same_error" | "flip_flop" | "polling";
	count: number;
	/** Stable id of the pattern (dedupe). */
	sig: string;
	/** One line for the human / the reviewer. */
	detail: string;
}

/**
 * Repeated patterns among the last `window` tool calls:
 *  - same_call: the same call with the same (normalised) result `threshold` times — nothing changes between tries;
 *  - same_error: the same error text `threshold` times, whatever the call;
 *  - polling: a sleep/wait command (numbers ignored) `threshold` times with the same result;
 *  - flip_flop: an edit that undoes an earlier edit of the same file (来回改同一处).
 * Strongest first.
 */
export function detectRepeats(calls: ToolCallRecord[], threshold = 4, window = 30): RepeatSignal[] {
	const recent = calls.slice(-window);
	const out: RepeatSignal[] = [];
	const count = <K>(f: (c: ToolCallRecord) => K | undefined) => {
		const m = new Map<K, { n: number; c: ToolCallRecord }>();
		for (const c of recent) {
			const k = f(c);
			if (k === undefined) continue;
			const cur = m.get(k);
			m.set(k, { n: (cur?.n ?? 0) + 1, c });
		}
		return m;
	};
	for (const [k, v] of count((c) => (c.isError ? normalizeOutput(c.result) || "(empty error)" : undefined))) {
		if (v.n >= threshold) out.push({ kind: "same_error", count: v.n, sig: `err:${hash(k)}`, detail: `同一个错误出现 ${v.n} 次：${squash(v.c.result, 160)}` });
	}
	for (const [k, v] of count((c) => `${c.key}\u0000${normalizeOutput(c.result)}`)) {
		if (v.n >= threshold) out.push({ kind: "same_call", count: v.n, sig: `call:${hash(k)}`, detail: `同一条命令重复 ${v.n} 次、结果相同：${v.c.text}` });
	}
	const waits = (c: ToolCallRecord) => (c.name === "bash" && /\b(sleep|wait|until|watch)\b/.test(c.key) ? `${c.key.replace(/\d+/g, "#")}\u0000${normalizeOutput(c.result)}` : undefined);
	for (const [k, v] of count(waits)) {
		if (v.n >= threshold && !out.some((o) => o.kind === "same_call" && o.detail.endsWith(v.c.text))) out.push({ kind: "polling", count: v.n, sig: `poll:${hash(k)}`, detail: `反复等待/轮询 ${v.n} 次、结果没变：${v.c.text}` });
	}
	const seen: { path: string; old: string; new: string }[] = [];
	const flips = new Map<string, number>();
	for (const c of recent) {
		for (const e of c.edit ?? []) {
			if (seen.some((s) => s.path === e.path && s.old === e.new && s.new === e.old)) flips.set(e.path, (flips.get(e.path) ?? 0) + 1);
			seen.push(e);
		}
	}
	for (const [path, n] of flips) out.push({ kind: "flip_flop", count: n + 1, sig: `flip:${hash(path)}:${n}`, detail: `来回改同一处：${path}（改回又改去 ${n} 次）` });
	const rank = { same_error: 0, same_call: 1, flip_flop: 2, polling: 3 };
	return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count);
}

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- triggers

export interface Trigger {
	kind: TriggerKind;
	detail: string;
	/** Repeat signature to remember (kind repeat). */
	sig?: string;
	signal?: RepeatSignal;
}

/** Overtime threshold for the given level, as a multiple of the expectation. */
export function multiplierAt(cfg: Pick<WatchdogConfig, "multipliers">, level: number): number {
	const m = cfg.multipliers.length ? cfg.multipliers : DEFAULT_WATCHDOG.multipliers;
	if (level < m.length) return m[level]!;
	return m[m.length - 1]! * 2 ** (level - m.length + 1);
}

/**
 * Does this task deserve a review now? undefined = no. Only running tasks with the watchdog on, no
 * review in flight, no open escalation, and outside the cooldown. Order: follow-up after a correction,
 * repeated pattern, overtime, no progress.
 */
export function triggerFor(t: Task, cfg: WatchdogConfig, now: number, repeats: RepeatSignal[] = []): Trigger | undefined {
	if (!cfg.enabled || t.watch?.off) return undefined;
	if (t.status !== "running") return undefined;
	const w = t.watch;
	if (w?.running || w?.pending) return undefined;
	const last = w?.reviews?.[w.reviews.length - 1]?.at ?? 0;
	if (now - last < cfg.cooldownMinutes * 60_000) return undefined;
	const elapsed = elapsedMs(t, now) / 60_000;
	if (w?.followupDue) return { kind: "followup", detail: `已发出纠偏建议，复查是否走出来（已用 ${fmtMinutes(elapsed)}）` };
	const fresh = repeats.find((r) => !w?.repeatSeen?.includes(r.sig));
	if (fresh) return { kind: "repeat", detail: fresh.detail, sig: fresh.sig, signal: fresh };
	const exp = t.expect?.minutes;
	if (exp) {
		const k = multiplierAt(cfg, w?.overLevel ?? 0);
		if (elapsed >= exp * k) return { kind: "overtime", detail: `已用 ${fmtMinutes(elapsed)}，超过预期 ${fmtMinutes(exp)} 的 ${k}x` };
	}
	if (cfg.stallMinutes > 0) {
		const p = lastProgressAt(t);
		const quiet = (now - p) / 60_000;
		if (quiet >= cfg.stallMinutes && w?.stallSeen !== p) return { kind: "stalled", detail: `${fmtMinutes(quiet)} 没有新进展（已用 ${fmtMinutes(elapsed)}）` };
	}
	return undefined;
}

/** Book-keeping after a trigger fired (before the review runs): dedupe stalls / repeats, advance the overtime level past the current time. */
export function markTriggered(t: Task, trig: Trigger, cfg: WatchdogConfig, now: number): TaskWatch {
	const w: TaskWatch = { reviews: [], ...t.watch, running: { at: now, trigger: trig.kind } };
	if (trig.kind === "followup") w.followupDue = false;
	if (trig.sig) w.repeatSeen = [...(w.repeatSeen ?? []), trig.sig].slice(-20);
	if (trig.kind === "stalled" || trig.kind === "followup" || trig.kind === "repeat") w.stallSeen = lastProgressAt(t);
	const exp = t.expect?.minutes;
	if (exp) {
		const elapsed = elapsedMs(t, now) / 60_000;
		let lvl = w.overLevel ?? 0;
		while (elapsed >= exp * multiplierAt(cfg, lvl) && lvl < 30) lvl++;
		w.overLevel = lvl;
	}
	return w;
}

// ---------------------------------------------------------------- the reviewer's answer

export interface ReviewResult {
	verdict: Verdict;
	evidence: string;
	advice?: string;
	/** New total estimate (minutes), ON_TRACK. */
	expected?: number;
	question?: string;
	options?: string[];
}

/** The verdict JSON from the reviewer's output (the last JSON object that has a valid verdict). */
export function parseVerdict(out: string): ReviewResult | undefined {
	const text = String(out ?? "");
	const candidates: string[] = [];
	for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!);
	// Balanced {...} blocks, scanned from every "{".
	for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
		let depth = 0;
		let inStr = false;
		for (let j = i; j < text.length; j++) {
			const ch = text[j];
			if (inStr) {
				if (ch === "\\") j++;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				candidates.push(text.slice(i, j + 1));
				break;
			}
		}
	}
	let found: ReviewResult | undefined;
	for (const c of candidates) {
		let o: any;
		try {
			o = JSON.parse(c);
		} catch {
			continue;
		}
		const v = String(o?.verdict ?? "").toUpperCase().replace(/[\s-]+/g, "_") as Verdict;
		if (!VERDICTS.includes(v)) continue;
		let expected: number | undefined;
		try {
			if (o.expected !== undefined && o.expected !== null && o.expected !== "") expected = parseExpected(typeof o.expected === "number" ? o.expected : String(o.expected));
		} catch {}
		found = {
			verdict: v,
			evidence: squash(o.evidence ?? o.reason ?? "", 800),
			advice: o.advice ? String(o.advice).trim().slice(0, 2000) : undefined,
			expected,
			question: o.question ? squash(o.question, 300) : undefined,
			options: Array.isArray(o.options) ? o.options.map((x: unknown) => squash(x, 80)).filter(Boolean).slice(0, 4) : undefined,
		};
	}
	return found;
}

export interface ActionPlan {
	action: WatchAction;
	/** ON_TRACK: the new expectation (minutes), when it changes. */
	expect?: number;
	/** Correction text for the worker. */
	message?: string;
	/** Escalation to the human. */
	pending?: TaskWatch["pending"];
}

/**
 * What to do with a verdict:
 *  - ON_TRACK: silent; adopt the reviewer's new estimate if it is later than now (never shorter than the time already used).
 *  - DRIFTING / STUCK / BAD_APPROACH: send the advice to the worker; when `maxCorrections` corrections were
 *    already sent (no ON_TRACK / human message since), escalate to the human instead.
 *  - NEEDS_HUMAN: escalate.
 */
export function decideAction(t: Task, r: ReviewResult, cfg: WatchdogConfig, now: number): ActionPlan {
	const elapsed = elapsedMs(t, now) / 60_000;
	if (r.verdict === "ON_TRACK") {
		let next = r.expected;
		if (next === undefined || next <= elapsed) next = Math.max(elapsed * 1.5, (t.expect?.minutes ?? 0) * 1.5, elapsed + 5);
		next = Math.ceil(next);
		return { action: "silent", expect: next !== t.expect?.minutes ? next : undefined };
	}
	const label = VERDICT_LABEL[r.verdict];
	if (r.verdict === "NEEDS_HUMAN" || (t.watch?.corrections ?? 0) >= cfg.maxCorrections) {
		const again = r.verdict !== "NEEDS_HUMAN";
		const question =
			r.verdict === "NEEDS_HUMAN" && r.question
				? r.question
				: `巡检${again ? "纠偏后仍判断" : "判断"}「${label}」：${firstSentence(r.evidence) || "需要你决定怎么继续"}`;
		const options = r.options?.length ? r.options : again ? ["按巡检建议换个方法继续", "放宽预期，让它继续", "中止任务"] : undefined;
		return { action: "escalated", pending: { at: now, verdict: r.verdict, question, options, advice: r.advice } };
	}
	const message = [
		`【巡检纠偏】独立巡检判断这个任务「${label}」（${r.verdict}）。`,
		r.evidence ? `依据：${r.evidence}` : "",
		r.advice ? `建议：${r.advice}` : "",
		"请先停下当前的做法，对照任务简报重新判断，按上面的建议调整后继续；如果你确认巡检判断有误，用 qa_report(status=\"progress\") 说明理由后继续。不要回复本条消息本身。",
	]
		.filter(Boolean)
		.join("\n");
	return { action: "corrected", message };
}

function firstSentence(s: string | undefined): string {
	const x = squash(s, 400);
	const m = /^(.+?(?:[。！？；]|[.!?;](?=\s|$)))/.exec(x);
	return (m ? m[1]! : x).slice(0, 160);
}

/** Apply a finished review to the watch state (pure). */
export function recordReview(t: Task, review: WatchReview, plan: ActionPlan | undefined): TaskWatch {
	const w: TaskWatch = { reviews: [], ...t.watch, running: undefined };
	w.reviews = [...(w.reviews ?? []), review].slice(-MAX_REVIEWS);
	if (plan?.action === "silent") {
		w.corrections = 0;
		if (plan.expect !== undefined) w.overLevel = 0;
	} else if (plan?.action === "corrected") {
		w.corrections = (w.corrections ?? 0) + 1;
		w.followupDue = true;
	} else if (plan?.action === "escalated") {
		w.pending = plan.pending;
		w.followupDue = false;
	}
	return w;
}

/** Human-facing one line of a review, e.g. "14:05 [STUCK] 重复模式 · 已把建议发给 worker". */
export const ACTION_LABEL: Record<WatchAction, string> = { silent: "静默更新预期", corrected: "已把建议发给 worker", escalated: "已交给你决定", error: "巡检失败" };

export function reviewLine(r: WatchReview): string {
	return `[${r.verdict ?? "ERROR"}] ${TRIGGER_LABEL[r.trigger]}：${r.detail} · ${ACTION_LABEL[r.action]}${r.expected ? `（新预估 ${fmtMinutes(r.expected)}）` : ""}`;
}
