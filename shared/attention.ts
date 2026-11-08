// The attention model: the single definition of "what does the human need to look at".
//
// quick-agent's core is attention management: it gets things done for you and only interrupts you when
// it truly needs you. Every task is in exactly one attention level, computed here from the task record
// (status, unread/ack, snooze, the worker's explicit ask). The hub serves the result (GET /api/attention,
// SSE "attention" events) and every front end — Web UI, Electron, terminal pi front, browser extension,
// CLI — renders it instead of interpreting task statuses itself.
//
//   need      需要你   the worker asked, is blocked, failed or stopped and waits on a human decision
//   skim      待扫     handed back (done) and not yet acknowledged; worth a glance, never interrupts
//   snoozed   稍后     need/skim the human postponed ("稍后提醒"); comes back when the snooze ends
//   inflight  不用管   handed off and being worked on
//   archived  已归档   acknowledged, cancelled/closed, or done long ago
//
// Interrupt policy (interruptFor): only "need" interrupts immediately, also in focus mode; "skim" is
// batched into a digest by the hub (held while focus mode is on); nothing else ever notifies.
// Pure module: no I/O, safe to import from the hub, the extensions and the CLI.
import type { Task } from "./types.ts";

export type AttentionLevel = "need" | "skim" | "snoozed" | "inflight" | "archived";
export const ATTENTION_LEVELS: AttentionLevel[] = ["need", "skim", "snoozed", "inflight", "archived"];
export const LEVEL_LABEL: Record<AttentionLevel, string> = { need: "需要你", skim: "待扫", snoozed: "稍后", inflight: "不用管", archived: "已归档" };

export type AttentionActionId = "reply" | "retry" | "ack" | "snooze" | "unsnooze" | "cancel" | "attach";
export interface AttentionAction {
	id: AttentionActionId;
	label: string;
}
export const ACTION_LABEL: Record<AttentionActionId, string> = {
	reply: "回答",
	retry: "重试",
	ack: "知道了",
	snooze: "稍后提醒",
	unsnooze: "现在处理",
	cancel: "中止",
	attach: "接管",
};

export interface AttentionItem {
	taskId: string;
	title: string;
	machine?: string;
	status: Task["status"];
	level: AttentionLevel;
	/** Monospace marker for terse renderers, e.g. [ASK] [DONE]. */
	mark: string;
	/** Why the task is in this level, one human-readable line. */
	reason: string;
	/** When the task entered this level (ms). */
	since: number;
	/** Explicit question from the worker (qa_report needs_human), if any. */
	question?: string;
	options?: string[];
	snoozedUntil?: number;
	/** What the human can do from here, most relevant first. */
	actions: AttentionAction[];
	updatedAt: number;
}

export interface AttentionCounts {
	need: number;
	skim: number;
	snoozed: number;
	inflight: number;
	archived: number;
}

export interface FocusState {
	on: boolean;
	since?: number;
	/** Ends automatically at this time (ms); open-ended when absent. */
	until?: number;
}

export interface AttentionOptions {
	now?: number;
	/** Done-and-unacknowledged tasks older than this are archived automatically. */
	archiveAfterMs?: number;
}

export const DEFAULT_ARCHIVE_AFTER_MS = 7 * 86400_000;
const NEED_STATUSES: Task["status"][] = ["needs_input", "blocked", "failed", "exited", "idle"];
const ACTIVE: Task["status"][] = ["starting", "running", "handoff"];

const NEED_REASON: Record<string, [string, string]> = {
	needs_input: ["[ASK]", "worker 在等你决定"],
	blocked: ["[BLOCKED]", "worker 受阻，需要你"],
	failed: ["[FAILED]", "失败了，需要你看看"],
	exited: ["[EXITED]", "worker 意外退出，需要你看看"],
	idle: ["[STOPPED]", "worker 停下了，等你决定下一步"],
};

const act = (...ids: AttentionActionId[]): AttentionAction[] => ids.map((id) => ({ id, label: ACTION_LABEL[id] }));
const firstLine = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

export function attentionOf(t: Task, opts: AttentionOptions = {}): AttentionItem {
	const now = opts.now ?? Date.now();
	const archiveAfter = opts.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
	const statusSince = t.statusSince ?? t.updatedAt ?? t.createdAt;
	const base = { taskId: t.id, title: t.title, machine: t.machine, status: t.status, updatedAt: t.updatedAt };
	const snoozed = !!t.snoozedUntil && t.snoozedUntil > now;
	const question = t.ask?.question;
	const options = t.ask?.options?.length ? t.ask.options : undefined;
	const archived = (reason: string, since = t.ackedAt ?? t.updatedAt): AttentionItem => ({ ...base, level: "archived", mark: "[ARCHIVED]", reason, since, actions: act("reply") });

	if (t.status === "cancelled") return archived("已取消", t.updatedAt);
	if (ACTIVE.includes(t.status)) {
		const reason = t.status === "handoff" ? `交接中：${firstLine(t.activity) || "迁移到另一台机器"}` : t.status === "starting" ? "已交出去，正在启动" : `进行中：${firstLine(t.activity) || "worker 在做"}`;
		return { ...base, level: "inflight", mark: t.status === "handoff" ? "[MOVE]" : "[RUN]", reason, since: statusSince, actions: t.status === "handoff" ? [] : act("reply", "cancel", "attach") };
	}
	if (t.closed && !t.unread) return archived("窗口已关闭");
	if (NEED_STATUSES.includes(t.status)) {
		if (!t.unread) return archived("你已确认");
		const [mark, why] = NEED_REASON[t.status]!;
		const reason = question ? `${why}：${firstLine(question)}` : `${why}${t.summary ? `：${firstLine(t.summary)}` : ""}`;
		const acts = t.status === "needs_input" ? act("reply", "snooze", "ack", "attach") : act("reply", "retry", "snooze", "ack", "attach");
		if (snoozed) return { ...base, level: "snoozed", mark: "[LATER]", reason, since: t.snoozedAt ?? statusSince, snoozedUntil: t.snoozedUntil, question, options, actions: act("unsnooze", "reply", "ack") };
		return { ...base, level: "need", mark, reason, since: Math.max(statusSince, t.snoozedUntil && t.snoozedUntil <= now ? t.snoozedUntil : 0), question, options, actions: acts };
	}
	// done
	if (!t.unread) return archived("已确认");
	if (now - statusSince > archiveAfter) return archived("完成很久了，自动归档", statusSince + archiveAfter);
	const reason = `已完成：${firstLine(t.summary) || "worker 汇报完成"}`;
	if (snoozed) return { ...base, level: "snoozed", mark: "[LATER]", reason, since: t.snoozedAt ?? statusSince, snoozedUntil: t.snoozedUntil, actions: act("unsnooze", "ack", "reply") };
	return { ...base, level: "skim", mark: "[DONE]", reason, since: statusSince, actions: act("ack", "reply", "snooze") };
}

export function countLevels(items: AttentionItem[]): AttentionCounts {
	const c: AttentionCounts = { need: 0, skim: 0, snoozed: 0, inflight: 0, archived: 0 };
	for (const i of items) c[i.level]++;
	return c;
}

/** Priority order: need (oldest wait first), skim, snoozed (soonest back first), inflight, archived (newest first). */
export function sortQueue(items: AttentionItem[]): AttentionItem[] {
	const rank = (l: AttentionLevel) => ATTENTION_LEVELS.indexOf(l);
	return [...items].sort((a, b) => {
		if (a.level !== b.level) return rank(a.level) - rank(b.level);
		if (a.level === "need") return a.since - b.since;
		if (a.level === "snoozed") return (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0);
		return b.since - a.since;
	});
}

export function attentionQueue(tasks: Task[], opts: AttentionOptions = {}) {
	const items = sortQueue(tasks.map((t) => attentionOf(t, opts)));
	return { items, counts: countLevels(items) };
}

export type Interrupt = "now" | "digest" | "none";

/**
 * Should this change reach the human, and how?
 *  - "now": entered "need" (incl. a snooze ending), or a new question while already there. Passes focus mode.
 *  - "digest": entered "skim" — batched into one calm summary (held while focus mode is on).
 *  - "none": progress, acks, archiving, starting/running.
 */
export function interruptFor(prev: AttentionItem | undefined, next: AttentionItem, reportedNow = false): Interrupt {
	if (next.level === "need") {
		if (!prev) return reportedNow ? "now" : "none"; // first sight of a replica / at startup: not news
		if (prev.level !== "need") return "now";
		if (reportedNow && (prev.reason !== next.reason || prev.since !== next.since)) return "now";
		return "none";
	}
	if (next.level === "skim" && (!prev || prev.level !== "skim")) return prev || reportedNow ? "digest" : "none";
	return "none";
}

export function focusActive(f: FocusState | undefined, now = Date.now()): boolean {
	return !!f?.on && (!f.until || f.until > now);
}

/** Short text for one item, e.g. `[ASK] t1234 修复登录页 — worker 在等你决定：要不要…`. */
export function itemLine(i: AttentionItem): string {
	return `${i.mark} ${i.taskId} ${i.title} — ${i.reason}`;
}
