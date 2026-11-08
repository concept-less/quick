// Pure helpers for the desktop main process (no Electron imports, unit-tested with node --test).
//
// quick-agent has no "sessions" — only attention. Every task is in exactly one attention bucket:
//   need     需要你        the worker asked, is blocked, failed or stopped — it waits on a human (interrupt-worthy)
//   inflight 已托付/进行中  handed off and being worked on (no attention needed)
//   skim     已完成待扫    handed back, worth a glance when convenient (never interrupts)
// (Mapping kept in sync with docs/attention.md / the Web UI.)
"use strict";

const NEED = ["needs_input", "blocked", "failed", "exited", "idle"];
const INFLIGHT = ["starting", "running"];
const SKIM = ["done"];

const STATUS_LABEL = {
	starting: "启动中",
	running: "进行中",
	idle: "停下了",
	needs_input: "需要你回答",
	blocked: "受阻",
	done: "完成",
	failed: "失败",
	cancelled: "已取消",
	exited: "已退出",
};
const BUCKET_LABEL = { need: "需要你", inflight: "已托付/进行中", skim: "已完成待扫" };

/** Attention bucket of a task, or null when it needs nothing (cancelled, closed, already skimmed). */
function bucket(t) {
	if (!t || t.status === "cancelled") return null;
	if (NEED.includes(t.status)) return t.closed ? null : "need";
	if (INFLIGHT.includes(t.status)) return "inflight";
	if (SKIM.includes(t.status)) return t.unread ? "skim" : null;
	return null;
}

function summarize(tasks) {
	const s = { need: 0, inflight: 0, skim: 0 };
	for (const t of tasks) {
		const b = bucket(t);
		if (b) s[b]++;
	}
	return s;
}

/** Menu-bar title / Dock badge only ever show what needs you. */
function trayTitle(s) {
	return s.need ? `⚡${s.need}` : "⚡";
}
function badge(s) {
	return s.need ? String(s.need) : "";
}

function byBucket(tasks, b, limit = 8) {
	return tasks
		.filter((t) => bucket(t) === b)
		.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
		.slice(0, limit);
}

/**
 * Classify a hub task update for notifications:
 *  - "urgent": moved into `need` (or a new question while still there) → notify immediately
 *  - "digest": handed back into `skim` → batched into a periodic digest
 *  - undefined: nothing to tell (progress, activity, acks, starting/running)
 */
function notificationFor(prev, task, event) {
	if (!task) return undefined;
	const b = bucket(task);
	if (b !== "need" && b !== "skim") return undefined;
	const transitioned = !prev || prev.status !== task.status;
	const newReport = !!event && event.kind === "report" && (!prev || prev.summary !== task.summary);
	if (!transitioned && !newReport) return undefined;
	if (!prev && b === "skim" && !(event && event.kind === "report")) return undefined;
	const body = String(task.summary || task.activity || "").replace(/\s+/g, " ").trim().slice(0, 240);
	if (b === "need") {
		const head = { needs_input: "需要你决定", blocked: "受阻，需要你", failed: "失败了，需要你看看" }[task.status] || "停下了，需要你看看";
		return { kind: "urgent", title: `${head} · ${task.title}`, subtitle: `${task.id}${task.machine ? ` @${task.machine}` : ""}`, body: body || STATUS_LABEL[task.status] };
	}
	return { kind: "digest", title: task.title, body };
}

/** Collects "skim" hand-backs and turns them into one calm notification. */
class Digest {
	constructor() {
		this.items = new Map();
	}
	add(task) {
		this.items.set(task.id, { id: task.id, title: task.title, status: task.status });
	}
	/** Drop items that are no longer waiting to be skimmed (acknowledged elsewhere, re-run, …). */
	prune(isStillSkim) {
		for (const id of [...this.items.keys()]) if (!isStillSkim(id)) this.items.delete(id);
	}
	get size() {
		return this.items.size;
	}
	flush() {
		if (!this.items.size) return undefined;
		const list = [...this.items.values()];
		this.items.clear();
		const names = list.map((x) => x.title.slice(0, 24));
		const title = list.length === 1 ? `已完成待扫 · ${list[0].title}` : `${list.length} 件事已完成待扫`;
		const body = list.length === 1 ? "有空时扫一眼" : `${names.slice(0, 4).join("、")}${list.length > 4 ? ` 等 ${list.length} 件` : ""}`;
		return { title, body, ids: list.map((x) => x.id) };
	}
}

/**
 * 专注模式 (focus / do-not-disturb): no banners at all — "需要你" still lands in the tray count, hand-backs keep
 * collecting — and a single summary when it ends (docs/attention.md: P5/P6). Returns "focus" or "off".
 */
function quietMode(settings, now = Date.now()) {
	const q = settings && settings.quiet;
	if (!q || !q.mode || q.mode === "off") return "off";
	if (q.until && now >= q.until) return "off";
	return "focus";
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

module.exports = { NEED, INFLIGHT, SKIM, STATUS_LABEL, BUCKET_LABEL, bucket, summarize, trayTitle, badge, byBucket, notificationFor, Digest, quietMode, NotificationGate, validBounds, titleFromText };
