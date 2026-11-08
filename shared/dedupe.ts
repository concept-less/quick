// Duplicate-dispatch detection. The same request often reaches quick-agent twice: the human types it into
// two front agents (terminal pi + Web UI), presses Enter twice, or a front agent retries a dispatch. The hub
// refuses an obviously duplicated task (409) unless the caller passes force=true; the front agent additionally
// sees the list of open tasks in its system prompt and judges semantic duplicates itself (see extensions/front.ts).
import type { Task, TaskStatus } from "./types.ts";

/** Tasks that are still somebody's job: a second worker for the same thing would be wasted or conflicting. */
export const OPEN_STATUSES: TaskStatus[] = ["starting", "running", "idle", "needs_input", "blocked"];

export const isOpen = (t: Pick<Task, "status" | "closed">) => OPEN_STATUSES.includes(t.status) && !t.closed;

/** Lower-case, drop whitespace / punctuation / symbols (works for CJK and latin alike). */
export function normalize(s: string): string {
	return String(s ?? "")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(s: string): Map<string, number> {
	const n = normalize(s);
	const m = new Map<string, number>();
	if (n.length === 1) m.set(n, 1);
	for (let i = 0; i < n.length - 1; i++) {
		const g = n.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return m;
}

/** Sørensen–Dice coefficient over character bigrams (multiset), 0..1. */
export function similarity(a: string, b: string): number {
	const A = bigrams(a);
	const B = bigrams(b);
	let na = 0;
	let nb = 0;
	let inter = 0;
	for (const v of A.values()) na += v;
	for (const v of B.values()) nb += v;
	for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
	return na + nb ? (2 * inter) / (na + nb) : 0;
}

const normPath = (p: string) => String(p ?? "").trim().replace(/\/+$/, "") || "/";

export interface DispatchInput {
	title: string;
	brief: string;
	cwd?: string;
	machine?: string;
}
export interface DuplicateMatch {
	task: Task;
	score: number;
	reason: "same-title" | "similar-brief";
}

/** Brief similarity at/above which two dispatches are treated as the same task. */
export const BRIEF_THRESHOLD = 0.75;

/**
 * Open tasks that look like the same job as `input`: same working directory (and machine, when both are
 * known), and either the same normalized title or a near-identical brief. Best match first.
 */
export function findDuplicates(tasks: Iterable<Task>, input: DispatchInput, threshold = BRIEF_THRESHOLD): DuplicateMatch[] {
	const title = normalize(input.title);
	const out: DuplicateMatch[] = [];
	for (const t of tasks) {
		if (!isOpen(t)) continue;
		if (input.cwd && normPath(t.cwd) !== normPath(input.cwd)) continue;
		if (input.machine && t.machine && t.machine !== input.machine) continue;
		const score = similarity(input.brief, t.brief);
		if (title.length >= 4 && normalize(t.title) === title) out.push({ task: t, score: Math.max(score, 1), reason: "same-title" });
		else if (score >= threshold) out.push({ task: t, score, reason: "similar-brief" });
	}
	return out.sort((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt);
}

/** Human/agent-readable explanation used in the hub's 409 error and by the front agent's tool result. */
export function describeDuplicates(matches: DuplicateMatch[]): string {
	return matches
		.slice(0, 5)
		.map((m) => `${m.task.id} "${m.task.title}" [${m.task.status}] @${m.task.machine} ${m.task.cwd} (${m.reason === "same-title" ? "同标题" : `简报相似度 ${m.score.toFixed(2)}`})`)
		.join("\n");
}
