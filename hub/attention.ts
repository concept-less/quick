// Hub side of the attention model (shared/attention.ts): keeps the last computed attention of every task
// per person, turns task changes into "attention" SSE events with a centrally decided interrupt, batches
// "skim" hand-backs into digests, and persists focus mode / digest interval in ~/.quick-agent/attention.json.
//
// All interruption policy lives here and in shared/attention.ts; clients only render what they receive.
// Team mode (shared/team.ts): the base item of a task is personalised for each viewer (personalAttention);
// every SSE connection receives its own person's items, counts and interrupts. Without a team everyone is
// "root" and sees the base model.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	attentionOf,
	countLevels,
	focusActive,
	interruptFor,
	sortQueue,
	type AttentionItem,
	type FocusState,
	type Interrupt,
} from "../shared/attention.ts";
import type { Viewer } from "../shared/team.ts";
import type { HubEvent, Task, TaskEvent } from "../shared/types.ts";

interface Batch {
	/** Task ids handed back since the last digest. */
	ids: string[];
	/** When the first item of the batch arrived; the batch is sent digestMinutes later. */
	since: number;
}
interface Persisted {
	focus: FocusState;
	digestMinutes: number;
	/** Pending digest per person (key: member id, or "root"). */
	pendingBy: Record<string, Batch>;
	lastDigestAt?: number;
}

export interface AttentionDeps {
	file: string;
	allTasks: () => Task[];
	/** Base item → this viewer's item (undefined: none of their business). Identity when absent. */
	personalize?: (t: Task, base: AttentionItem, viewer: Viewer) => AttentionItem | undefined;
	/** Team view row (scope=team). */
	teamRow?: (t: Task, base: AttentionItem) => AttentionItem;
	/** Distinct viewers of the connected SSE clients. */
	viewers: () => Viewer[];
	/** Send an event to the connections of one person (key from keyOf). */
	broadcastTo: (key: string, e: HubEvent) => void;
	/** Which connected front agent of this person should proactively tell them about this task. */
	pickFront: (t: Task, key: string) => string | undefined;
	log: (msg: string) => void;
}

export const keyOf = (v?: Viewer) => v?.user ?? "root";
const ROOT: Viewer = { role: "owner", root: true };

export function createAttention(d: AttentionDeps) {
	let st: Persisted = { focus: { on: false }, digestMinutes: 30, pendingBy: {} };
	try {
		if (existsSync(d.file)) st = { ...st, ...JSON.parse(readFileSync(d.file, "utf8")) };
	} catch {}
	st.pendingBy ??= {};
	const save = () => {
		try {
			writeFileSync(d.file, JSON.stringify(st, null, 2));
		} catch {}
	};

	const itemFor = (t: Task, v: Viewer): AttentionItem | undefined => {
		const base = attentionOf(t);
		return d.personalize ? d.personalize(t, base, v) : base;
	};
	const queueFor = (v: Viewer) => {
		const items: AttentionItem[] = [];
		for (const t of d.allTasks()) {
			const i = itemFor(t, v);
			if (i) items.push(i);
		}
		return sortQueue(items);
	};
	const countsFor = (v: Viewer) => countLevels(queueFor(v));
	const focus = (): FocusState => (focusActive(st.focus) ? st.focus : { on: false });

	/** Last item per person per task (baseline: what each person saw before the change). */
	const last = new Map<string, Map<string, AttentionItem | undefined>>();
	const lastFor = (key: string, v: Viewer) => {
		let m = last.get(key);
		if (!m) {
			m = new Map();
			for (const t of d.allTasks()) m.set(t.id, itemFor(t, v));
			last.set(key, m);
		}
		return m;
	};
	lastFor("root", ROOT);
	const activeViewers = () => {
		const seen = new Map<string, Viewer>([["root", ROOT]]);
		for (const v of d.viewers()) if (!seen.has(keyOf(v))) seen.set(keyOf(v), v);
		return [...seen.entries()];
	};

	/** Re-evaluate one task after it changed (or time passed) and tell every affected person. */
	const onTask = (t: Task, ev?: TaskEvent) => {
		const reported = ev?.kind === "report" || ev?.kind === "status" || ev?.kind === "assign" || ev?.kind === "comment";
		for (const [key, v] of activeViewers()) {
			const m = lastFor(key, v);
			const known = m.has(t.id);
			const prev = m.get(t.id);
			const item = itemFor(t, v);
			m.set(t.id, item);
			if (!item) {
				if (prev) d.broadcastTo(key, { type: "attention.state", counts: countsFor(v), focus: focus(), ts: Date.now() });
				continue;
			}
			const interrupt: Interrupt = interruptFor(known ? prev : undefined, item, reported);
			const moved = !prev || prev.level !== item.level || prev.reason !== item.reason || prev.since !== item.since;
			if (!moved && interrupt === "none") continue;
			if (interrupt === "digest") {
				const b = (st.pendingBy[key] ??= { ids: [], since: Date.now() });
				if (!b.ids.includes(t.id)) b.ids.push(t.id);
				save();
			}
			d.broadcastTo(key, { type: "attention", item, prevLevel: prev?.level, interrupt, counts: countsFor(v), focus: focus(), front: interrupt === "now" ? d.pickFront(t, key) : undefined, ts: Date.now() });
			if (interrupt === "now") d.log(`[attention] ${t.id} → need for ${key} (${item.reason.slice(0, 80)})`);
		}
	};

	const flushDigest = (reason: "timer" | "focus_end", only?: string) => {
		const byId = new Map(d.allTasks().map((t) => [t.id, t]));
		const viewers = new Map(activeViewers());
		for (const [key, b] of Object.entries(st.pendingBy)) {
			if (only && key !== only) continue;
			delete st.pendingBy[key];
			const v = viewers.get(key) ?? (key === "root" ? ROOT : { user: key, role: "member" as const });
			const items = b.ids
				.map((id) => byId.get(id))
				.filter((t): t is Task => !!t)
				.map((t) => itemFor(t, v))
				.filter((i): i is AttentionItem => !!i && i.level === "skim");
			if (items.length) d.broadcastTo(key, { type: "attention.digest", items, counts: countsFor(v), reason, ts: Date.now() });
		}
		st.lastDigestAt = Date.now();
		save();
	};

	let wasFocus = focusActive(st.focus);
	/** Runs every 30 s: time-based moves (snooze ends, auto-archive), focus expiry, digest timer. */
	const tick = () => {
		const tasks = d.allTasks();
		for (const [key, v] of activeViewers()) {
			const m = lastFor(key, v);
			for (const t of tasks) {
				const now = itemFor(t, v);
				if (m.get(t.id)?.level !== now?.level) onTask(t);
			}
		}
		const f = focusActive(st.focus);
		if (wasFocus && !f) {
			st.focus = { on: false };
			save();
			for (const [key, v] of activeViewers()) d.broadcastTo(key, { type: "attention.state", counts: countsFor(v), focus: focus(), ts: Date.now() });
			flushDigest("focus_end");
		}
		wasFocus = f;
		if (f) return;
		const due = Math.max(1, st.digestMinutes) * 60_000;
		for (const [key, b] of Object.entries(st.pendingBy)) if (Date.now() - b.since >= due) flushDigest("timer", key);
	};

	/** Focus mode is per hub (the person at this machine): only "need" interrupts, digests wait for its end. */
	const setFocus = (p: { on?: boolean; minutes?: number | null }) => {
		const on = p.on ?? true;
		const was = focusActive(st.focus);
		st.focus = on ? { on: true, since: Date.now(), until: p.minutes ? Date.now() + Number(p.minutes) * 60_000 : undefined } : { on: false };
		save();
		for (const [key, v] of activeViewers()) d.broadcastTo(key, { type: "attention.state", counts: countsFor(v), focus: focus(), ts: Date.now() });
		wasFocus = focusActive(st.focus);
		if (was && !wasFocus) flushDigest("focus_end");
		return focus();
	};

	const setDigestMinutes = (m: number) => {
		if (Number.isFinite(m) && m >= 1) st.digestMinutes = Math.round(m);
		save();
	};

	const view = (v: Viewer = ROOT, opts: { archived?: number; scope?: "mine" | "team" } = {}) => {
		const all = queueFor(v);
		const counts = countLevels(all);
		const keepArchived = opts.archived ?? 30;
		let items: AttentionItem[];
		if (opts.scope === "team" && d.teamRow) {
			items = sortQueue(d.allTasks().map((t) => d.teamRow!(t, attentionOf(t)))).filter((i) => i.level !== "archived");
		} else {
			let a = 0;
			items = all.filter((i) => i.level !== "archived" || a++ < keepArchived);
		}
		const key = keyOf(v);
		return { items, counts, focus: focus(), digestMinutes: st.digestMinutes, pendingDigest: st.pendingBy[key]?.ids.length ?? 0, viewer: key, scope: opts.scope ?? "mine", ts: Date.now() };
	};

	/** A connection of this person opened: make sure their baseline exists before the next change. */
	const watch = (v?: Viewer) => void lastFor(keyOf(v), v ?? ROOT);

	return { onTask, tick, setFocus, setDigestMinutes, view, flushDigest, watch };
}
