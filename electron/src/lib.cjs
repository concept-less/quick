// Pure helpers for the desktop main process (no Electron imports, unit-tested with node --test).
//
// quick-agent has no "sessions" — only attention. The attention model is defined once, in the hub
// (shared/attention.ts, served as GET /api/attention and SSE "attention" events). The desktop client does
// not classify tasks itself: it renders the hub's items and obeys the hub's interrupt decision
// ("now" = notify immediately, digests arrive as "attention.digest"). Levels:
//   need      需要你   the worker asked, is blocked, failed or stopped — it waits on a human (the only interrupt)
//   skim      待扫     handed back, worth a glance when convenient (batched by the hub, never interrupts)
//   snoozed   稍后     postponed by the human, comes back by itself
//   inflight  不用管   handed off and being worked on
//   archived  已归档   acknowledged / cancelled / old
"use strict";

const LEVELS = ["need", "skim", "snoozed", "inflight", "archived"];
const LEVEL_LABEL = { need: "需要你", skim: "待扫", snoozed: "稍后", inflight: "不用管", archived: "已归档" };

function emptyCounts() {
	return { need: 0, skim: 0, snoozed: 0, inflight: 0, archived: 0 };
}

/** Menu-bar title / Dock badge only ever show what needs you (the hub's counts.need, same number as the Web UI). */
function trayTitle(c) {
	return c && c.need ? `■${c.need}` : "□";
}
function badge(c) {
	return c && c.need ? String(c.need) : "";
}

/** Items of one level in the hub's priority order (need: oldest wait first; others: newest first). */
function byLevel(items, level, limit = 8) {
	const list = items.filter((i) => i.level === level);
	list.sort((a, b) => (level === "need" ? a.since - b.since : level === "snoozed" ? (a.snoozedUntil || 0) - (b.snoozedUntil || 0) : b.since - a.since));
	return list.slice(0, limit);
}

/** Native notification for an item the hub decided to interrupt with ("now"). */
function urgentNotification(item) {
	const body = String(item.question || item.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
	return { title: `需要你 ${item.mark} · ${item.title}`, subtitle: `${item.taskId}${item.machine ? ` @${item.machine}` : ""}`, body, options: item.options || [] };
}

/** One calm notification for a hub digest of "skim" hand-backs. */
function digestNotification(items, reason) {
	if (!items || !items.length) return undefined;
	const names = items.map((x) => String(x.title).slice(0, 24));
	const prefix = reason === "focus_end" ? "专注结束 · " : "";
	const title = items.length === 1 ? `${prefix}待扫 · ${items[0].title}` : `${prefix}${items.length} 件事已完成待扫`;
	const body = items.length === 1 ? "有空时扫一眼" : `${names.slice(0, 4).join("、")}${items.length > 4 ? ` 等 ${items.length} 件` : ""}`;
	return { title, body, ids: items.map((x) => x.taskId) };
}

/** Focus mode as reported by the hub ({on, until}). */
function focusOn(focus, now = Date.now()) {
	return !!(focus && focus.on && (!focus.until || focus.until > now));
}

/** Remembers which (task, status, updatedAt) were already notified so reconnects don't repeat them. */
class NotificationGate {
	constructor(max = 1000) {
		this.max = max;
		this.seen = new Set();
	}
	shouldShow(key) {
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		if (this.seen.size > this.max) this.seen.delete(this.seen.values().next().value);
		return true;
	}
}

/** Keep saved window bounds only if they are visible on one of the current displays. */
function validBounds(saved, displays) {
	if (!saved || typeof saved !== "object") return undefined;
	const { x, y, width, height } = saved;
	if (![width, height].every((n) => Number.isFinite(n) && n >= 400)) return undefined;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
	const visible = displays.some((d) => {
		const a = d.workArea || d.bounds;
		return x + 100 > a.x && y + 40 > a.y && x + 100 < a.x + a.width && y + 40 < a.y + a.height;
	});
	return visible ? { x, y, width, height } : { width, height };
}

/** First non-empty line as a task title (direct hand-off from the quick input). */
function titleFromText(text) {
	const first = String(text || "").trim().split("\n")[0].trim();
	return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

module.exports = { LEVELS, LEVEL_LABEL, emptyCounts, trayTitle, badge, byLevel, urgentNotification, digestNotification, focusOn, NotificationGate, validBounds, titleFromText };
