// Team collaboration, pure part: members, roles, permissions, @mention parsing, "whose ball is it" and
// per-person attention on top of the task attention model (shared/attention.ts).
// See docs/team-collaboration.md. No I/O: safe to import from the hub, the extensions and the CLI.
import type { Task } from "./types.ts";

export type Role = "owner" | "member";

/** A person on the team. Replicated across the mesh (hub/team.ts); last writer wins by (updatedAt, rev). */
export interface Member {
	/** Short id used for @mentions, e.g. "alice". */
	id: string;
	name: string;
	role: Role;
	/** sha256(token) hex; the token itself is shown once. */
	tokenHash: string;
	/** First characters of the token, to recognise it. */
	tokenHint: string;
	createdAt: number;
	updatedAt: number;
	rev: number;
	removed?: boolean;
}
/** Roster entry without secrets (what clients see). */
export type PublicMember = Omit<Member, "tokenHash">;

export interface Invite {
	id: string;
	codeHash: string;
	role: Role;
	by: string;
	createdAt: number;
	expiresAt: number;
	usedBy?: string;
	revoked?: boolean;
	updatedAt: number;
	rev: number;
}

/** Who is asking. root = the machine token: acts as the machine owner, or as the single user when none is set. */
export interface Viewer {
	user?: string;
	role: Role;
	root?: boolean;
}

/** Author id of comments written by a task's worker. */
export const AGENT = "agent";

export type PingKind = "assign" | "review" | "mention" | "verdict";
/** Someone was called on a task; stays until that person acts on the task (ack, reply, comment, assign). */
export interface Ping {
	id: string;
	user: string;
	kind: PingKind;
	/** Who caused it (member id or "agent"). */
	by: string;
	at: number;
	text?: string;
	commentId?: string;
}
export const PING_MARK: Record<PingKind, string> = { assign: "[ASSIGNED]", review: "[REVIEW]", mention: "[@]", verdict: "[VERDICT]" };
/** Pings that put a task into the person's "need"; others only into "skim". */
export const NEED_PINGS: PingKind[] = ["assign", "review", "mention"];

export interface TaskComment {
	id: string;
	taskId: string;
	ts: number;
	/** Member id, or "agent" for the task's worker. */
	author: string;
	text: string;
	/** Member ids called by this comment. */
	mentions: string[];
	/** Forwarded to the worker as a follow-up instruction (@worker). */
	toWorker?: boolean;
}

/** Team fields carried by Task (all optional: tasks from before the team existed have none). */
export interface TaskPeople {
	requester?: string;
	assignee?: string;
	reviewer?: string;
	watchers?: string[];
	pings?: Ping[];
	comments?: number;
	lastComment?: { id: string; author: string; text: string; ts: number };
}

// ---------------------------------------------------------------- ids, roles, permissions

export function memberId(s: string): string {
	return String(s ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}
export const RESERVED_IDS = ["all", "agent", "worker", "root", "team", "me", "everyone"];

export type Action = "team.manage" | "machine.configure" | "upgrade" | "attention.other";
/** Daily collaboration (dispatch, comment, assign, view) is open to every member; management needs owner. */
export function can(v: Viewer | undefined, action: Action): boolean {
	if (!v) return false;
	if (v.root) return true;
	switch (action) {
		case "team.manage":
		case "machine.configure":
		case "upgrade":
		case "attention.other":
			return v.role === "owner";
	}
}

export function publicMember(m: Member): PublicMember {
	const { tokenHash: _h, ...rest } = m;
	return rest;
}

/** Newer record wins: (updatedAt, rev). */
export function newer(a: { updatedAt: number; rev: number } | undefined, b: { updatedAt: number; rev: number }): boolean {
	if (!a) return true;
	return b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && b.rev > a.rev);
}

// ---------------------------------------------------------------- mentions

export interface Mentions {
	users: string[];
	all: boolean;
	worker: boolean;
}

/**
 * Plain-text @mentions: `@id`, `@name` or `@name-without-spaces` (case-insensitive, longest match wins),
 * `@all`, and `@worker` / `@agent` for the task's worker. Unknown `@xxx` is left alone.
 * An ASCII id must not be followed by [A-Za-z0-9_-] ("@alice这里" works, "@alicex" does not match alice).
 */
export function parseMentions(text: string, members: Pick<Member, "id" | "name" | "removed">[]): Mentions {
	const keys: { key: string; id: string }[] = [];
	for (const m of members) {
		if (m.removed) continue;
		for (const k of new Set([m.id, m.name, m.name.replace(/\s+/g, "")])) if (k) keys.push({ key: k.toLowerCase(), id: m.id });
	}
	for (const k of ["all", "worker", "agent"]) keys.push({ key: k, id: `#${k}` });
	keys.sort((a, b) => b.key.length - a.key.length);
	const out: Mentions = { users: [], all: false, worker: false };
	const lower = text.toLowerCase();
	for (let i = lower.indexOf("@"); i >= 0; i = lower.indexOf("@", i + 1)) {
		const prev = i > 0 ? lower[i - 1]! : " ";
		if (/[a-z0-9_.+-]/.test(prev)) continue; // e-mail addresses, foo@bar
		const rest = lower.slice(i + 1);
		const hit = keys.find((k) => rest.startsWith(k.key) && !(/[a-z0-9_-]$/.test(k.key) && /^[a-z0-9_-]/.test(rest.slice(k.key.length))));
		if (!hit) continue;
		if (hit.id === "#all") out.all = true;
		else if (hit.id === "#worker" || hit.id === "#agent") out.worker = true;
		else if (!out.users.includes(hit.id)) out.users.push(hit.id);
	}
	return out;
}

// ---------------------------------------------------------------- whose ball is it

/**
 * The person a task's hand-back goes to.
 *  - done (to be verified): reviewer ?? assignee ?? requester
 *  - anything else (question, blocked, failed, stopped): assignee ?? reviewer ?? requester
 * undefined: nobody recorded (tasks from before the team, root dispatches) → the team owners.
 */
export function holderOf(t: Task & TaskPeople): string | undefined {
	if (t.status === "done") return t.reviewer ?? t.assignee ?? t.requester;
	return t.assignee ?? t.reviewer ?? t.requester;
}

export function participants(t: Task & TaskPeople): string[] {
	return [...new Set([t.requester, t.assignee, t.reviewer, ...(t.watchers ?? [])].filter((x): x is string => !!x))];
}

export function displayName(id: string | undefined, members: Pick<Member, "id" | "name">[]): string {
	if (!id) return "-";
	if (id === AGENT) return "worker";
	return members.find((m) => m.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- per-person attention

/** The part of an attention item (shared/attention.ts AttentionItem) this module reads and writes. */
export interface BaseItem {
	taskId: string;
	level: "need" | "skim" | "snoozed" | "inflight" | "archived";
	mark: string;
	reason: string;
	since: number;
	actions: { id: string; label: string }[];
	[k: string]: unknown;
}

export interface People {
	holder?: string;
	requester?: string;
	assignee?: string;
	reviewer?: string;
	watchers?: string[];
	/** Why this person sees it: their ping, or their relation to the task. */
	ping?: PingKind;
	by?: string;
	relation?: "holder" | "requester" | "assignee" | "reviewer" | "watcher";
}

const ACK = { id: "ack", label: "知道了" };
const REPLY = { id: "reply", label: "回答" };

function peopleOf(t: Task & TaskPeople): People {
	return { holder: holderOf(t), requester: t.requester, assignee: t.assignee, reviewer: t.reviewer, watchers: t.watchers?.length ? t.watchers : undefined };
}

function oneLine(s: string | undefined, n = 160) {
	return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/**
 * Where a task sits for one person. Returns undefined when it is none of their business
 * (it then appears only in the team view). A root viewer without an owner sees the base item (single-user mode).
 */
export function personalAttention<I extends BaseItem>(t: Task & TaskPeople, base: I, viewer: Viewer, members: Pick<Member, "id" | "name">[] = []): (I & { people: People }) | undefined {
	const people = peopleOf(t);
	if (!viewer.user) return { ...base, people };
	const u = viewer.user;
	const name = (id?: string) => displayName(id, members);
	const holder = people.holder;
	const isHolder = holder ? holder === u : viewer.role === "owner";
	const relation: People["relation"] = isHolder ? "holder" : t.assignee === u ? "assignee" : t.reviewer === u ? "reviewer" : t.requester === u ? "requester" : t.watchers?.includes(u) ? "watcher" : undefined;

	const pings = (t.pings ?? []).filter((p) => p.user === u && !(p.kind === "review" && base.level === "archived" && t.status === "cancelled"));
	const needPing = pings.filter((p) => NEED_PINGS.includes(p.kind)).sort((a, b) => a.at - b.at)[0];
	const ping = needPing ?? pings.sort((a, b) => b.at - a.at)[0];
	if (ping) {
		const level = needPing ? "need" : base.level === "need" && isHolder ? "need" : "skim";
		const why: Record<PingKind, string> = {
			assign: `${name(ping.by)} 把任务交给你负责`,
			review: `${name(ping.by)} 请你验收、拍板`,
			mention: `${name(ping.by)} @你`,
			verdict: `${name(ping.by)} 已验收`,
		};
		const reason = `${why[ping.kind]}${ping.text ? `：${oneLine(ping.text)}` : isHolder && base.level === "need" ? `；${base.reason}` : ""}`;
		const actions = [...base.actions.filter((a) => a.id !== "ack"), ACK].sort((a, b) => Number(b.id === "ack" || b.id === "reply") - Number(a.id === "ack" || a.id === "reply"));
		return { ...base, level, mark: PING_MARK[ping.kind], reason, since: ping.at, actions: actions.length ? actions : [ACK, REPLY], people: { ...people, ping: ping.kind, by: ping.by, relation } };
	}
	if (isHolder) {
		if (base.level === "skim" && t.reviewer === u && t.requester !== u) {
			return { ...base, level: "need", mark: "[REVIEW]", reason: `请你验收：${oneLine(t.summary) || "worker 汇报完成"}`, people: { ...people, relation } };
		}
		return { ...base, people: { ...people, relation } };
	}
	if (!relation) return undefined;
	if (base.level === "need" || base.level === "skim" || base.level === "snoozed") {
		const what = t.status === "done" ? "验收" : "处理";
		return { ...base, level: "inflight", mark: "[WAIT]", reason: `等 ${name(holder) === "-" ? "owner" : name(holder)} ${what}：${oneLine(base.reason, 120)}`, actions: [REPLY], people: { ...people, relation } };
	}
	return { ...base, people: { ...people, relation } };
}

/** Is this viewer the one whose acknowledgement counts for the task itself (unread → read)? */
export function isHolderFor(t: Task & TaskPeople, viewer: Viewer): boolean {
	if (!viewer.user) return true;
	const h = holderOf(t);
	return h ? h === viewer.user : viewer.role === "owner";
}

/** Team view row: every task with who holds the ball now ("agent" while the worker is on it). */
export function teamRow<I extends BaseItem>(t: Task & TaskPeople, base: I, members: Pick<Member, "id" | "name">[] = []): I & { people: People; ball: string } {
	const people = peopleOf(t);
	// Someone explicitly called on a settled task (asked to review, @mentioned) holds the ball again.
	const ping = base.level === "archived" ? (t.pings ?? []).filter((p) => NEED_PINGS.includes(p.kind)).sort((a, b) => a.at - b.at)[0] : undefined;
	if (ping) return { ...base, level: "need", mark: PING_MARK[ping.kind], reason: `${displayName(ping.by, members)} 点名 ${displayName(ping.user, members)}${ping.text ? `：${oneLine(ping.text, 100)}` : ""}`, since: ping.at, people, ball: ping.user };
	const ball = base.level === "inflight" ? (t.assignee ?? AGENT) : (people.holder ?? "owner");
	return { ...base, people, ball };
}
