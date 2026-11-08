// Data model shared by hub, CLI and extensions.
import type { TaskPeople } from "./team.ts";
import type { CronJob } from "./cron.ts";
import type { TaskProgress } from "./progress.ts";
import type { AttentionCounts, AttentionItem, AttentionLevel, FocusState, Interrupt } from "./attention.ts";
import type { TaskClock, TaskExpect, TaskWatch } from "./watchdog.ts";

export type TaskStatus =
	| "starting" // tmux window spawned, worker not yet connected
	| "running" // worker agent is executing
	| "idle" // worker stopped without an explicit report (waiting for you)
	| "needs_input" // worker asked a question
	| "blocked" // worker cannot continue
	| "done" // worker reported completion
	| "failed" // worker crashed / spawn failed
	| "cancelled" // you cancelled it
	| "exited" // pi process in the window exited
	| "handoff"; // being moved to another machine (see hub/handoff.ts)

/** Statuses that may need the human's attention (the full attention model lives in shared/attention.ts). */
export const ATTENTION_STATUSES: TaskStatus[] = ["idle", "needs_input", "blocked", "done", "failed", "exited"];
export const ACTIVE_STATUSES: TaskStatus[] = ["starting", "running"];
export const CLOSED_STATUSES: TaskStatus[] = ["cancelled"];

export interface TaskSource {
	kind: "tui" | "browser" | "cli" | "api" | "cron";
	intakeId?: string;
	url?: string;
	/** Scheduled job (shared/cron.ts) that dispatched this task. */
	cronId?: string;
	/** Hub that owns that job. */
	cronHub?: string;
	/** Successful runs of the job are archived right away (no 待扫 entry). */
	silent?: boolean;
}

/** Team fields (requester, assignee, reviewer, watchers, pings, comments) come from TaskPeople (shared/team.ts). */
export interface Task extends TaskPeople {
	id: string;
	/** Machine (hub) that owns the task and runs its worker. */
	machine: string;
	/** Monotonic revision, bumped by the owning hub on every change (replication ordering). */
	rev: number;
	title: string;
	brief: string;
	cwd: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	source: TaskSource;
	attachments: string[];
	/** Latest summary / question / final answer from the worker. */
	summary?: string;
	/** Short description of what the worker is doing right now (raw tool line, e.g. "bash git push"). */
	activity?: string;
	/** Human-readable progress: the worker's plan / note, plus the activity in plain words (shared/progress.ts). */
	progress?: TaskProgress;
	/** True when there is news the human has not acknowledged yet (cleared by task.ack, "知道了"). */
	unread: boolean;
	/** When the status last changed (attention "since"). */
	statusSince?: number;
	/** When the human last acknowledged the task. */
	ackedAt?: number;
	/** "稍后提醒": hidden from need/skim until then (set by task.snooze). */
	snoozedUntil?: number;
	snoozedAt?: number;
	/** Explicit question from the worker (qa_report needs_human); cleared when the worker runs again. */
	ask?: { question: string; options?: string[]; at: number };
	/** Internal: pi session file of the worker (used to resume it; never shown to the human). */
	sessionFile?: string;
	tmuxTarget?: string;
	/** Number of follow-up messages sent to the worker. */
	messages: number;
	/** Id of the front agent that dispatched the task (preferred for proactive delivery of its reports). */
	owner?: string;
	/** Arbitrary flag set when the worker has closed its window. */
	closed?: boolean;
	/** Number of machine handoffs; orders replicas across owners (higher epoch wins, then rev). */
	epoch?: number;
	/** Set while a handoff is in progress. */
	handoff?: { from: string; to: string; startedAt: number; prevStatus: TaskStatus; phase?: string };
	/** Completed handoffs, oldest first. */
	handoffs?: { from: string; to: string; fromCwd: string; toCwd: string; at: number }[];
	/** Note for the worker, prepended to the next message it receives (e.g. after a handoff). */
	pendingNote?: string;
	/** Project id (shared/projects.ts); absent = unsorted. */
	project?: string;
	/** How the project was determined ("manual" / "explicit" are never reclassified); absent = not classified yet. */
	projectVia?: string;
	/** Expected active time (shared/watchdog.ts): dispatch estimate, default by kind, one worker revision, watchdog updates. */
	expect?: TaskExpect;
	/** Active-time clock kept by the owning hub (time starting/running, not waiting on a human). */
	clock?: TaskClock;
	/** Watchdog reviews of this task (巡检) and its state. */
	watch?: TaskWatch;
}

export interface TaskEvent {
	ts: number;
	taskId: string;
	kind: "created" | "status" | "activity" | "report" | "message" | "cancel" | "close" | "ack" | "snooze" | "session" | "handoff" | "assign" | "comment" | "project" | "progress" | "expect" | "watch";
	text?: string;
	/** Team member (or "agent") who caused the event, when known. */
	by?: string;
	status?: TaskStatus;
}

export interface IntakeElement {
	selector?: string;
	xpath?: string;
	tag?: string;
	text?: string;
	html?: string;
	rect?: { x: number; y: number; width: number; height: number };
	attributes?: Record<string, string>;
}

export interface Intake {
	id: string;
	/** Machine (hub) where the intake was submitted; it arbitrates claims. */
	machine: string;
	rev: number;
	createdAt: number;
	/**
	 * One-shot: "pending" until a front agent claims it; claiming consumes it ("consumed", never delivered
	 * again, also across hub restarts). "dispatched" = consumed and linked to a task (new or existing).
	 * "claimed" is the legacy name of "consumed" (older hubs).
	 */
	status: "pending" | "consumed" | "claimed" | "dispatched" | "dismissed";
	/** When a front agent claimed (consumed) it; consumed intakes are pruned after the retention period. */
	consumedAt?: number;
	kind: "browser-comment";
	comment: string;
	url?: string;
	title?: string;
	/** Selection mode used in the page. */
	mode?: "element" | "region";
	elements: IntakeElement[];
	/** Viewport coordinates at submit time (add viewport.scrollX/Y for document coordinates). */
	region?: { x: number; y: number; width: number; height: number };
	/** Where the page pin goes: element (selector) + offset as a fraction of its box; `doc` = document coordinates fallback. */
	anchor?: { selector?: string; fx?: number; fy?: number; doc?: { x: number; y: number } };
	viewport?: { width: number; height: number; dpr: number; scrollX: number; scrollY: number };
	/** Absolute paths of stored screenshots. */
	screenshots: string[];
	consoleErrors?: string[];
	userAgent?: string;
	claimedBy?: string;
	taskId?: string;
}

/** A machine in the mesh as seen from one hub. */
export interface MachineInfo {
	id: string;
	description?: string;
	defaultCwd?: string;
	projects?: { match: string; cwd: string; notes?: string; machine?: string }[];
	hostname?: string;
	platform?: string;
	startedAt?: number;
	activeTasks?: number;
	/** quick-agent version of that hub. */
	version?: string;
	/** Effective resource tags (detected + configured), e.g. ["macos","gui","browser:chrome-gui","codex"]. */
	resources?: string[];
	resourceNotes?: string;
	/** Dispatch preference, lower = preferred (absent = 100). */
	priority?: number;
	/** Team member who owns this machine ("Bob's machine"), if set. */
	owner?: string;
}
export interface MachineView extends MachineInfo {
	self: boolean;
	online: boolean;
	/** 0 = self, 1 = directly linked, … */
	hops: number;
	/** Machine id of the next hop (for hops > 1). */
	via?: string;
}

/** Messages broadcast over the hub SSE stream. */
export type HubEvent =
	| { type: "hello"; ts: number }
	| { type: "task"; task: Task; event?: TaskEvent }
	| { type: "task.message"; taskId: string; text: string; ts: number }
	| { type: "task.cancel"; taskId: string; ts: number }
	| { type: "intake"; intake: Intake }
	| { type: "machines"; machines: MachineView[] }
	| { type: "update"; machine: string; from: string; to: string; ts: number }
	/** Team roster changed (members are listed without token hashes). */
	| { type: "team"; members: import("./team.ts").PublicMember[]; ts: number }
	| { type: "cron"; job: CronJob }
	/** Attention of a task changed. interrupt says whether to tell the human now / in the digest / not at all; front names the front agent that should proactively tell the human. */
	| { type: "attention"; item: AttentionItem; prevLevel?: AttentionLevel; interrupt: Interrupt; counts: AttentionCounts; focus: FocusState; front?: string; ts: number }
	/** Batched "skim" hand-backs (timer, or focus mode ended). */
	| { type: "attention.digest"; items: AttentionItem[]; counts: AttentionCounts; reason: "timer" | "focus_end"; ts: number }
	/** Focus mode / counts changed without a specific task. */
	| { type: "attention.state"; counts: AttentionCounts; focus: FocusState; ts: number }
	| { type: "update.available"; machine: string; version: string; ts: number }
	| { type: "update.job"; machine: string; job: { step: string; from: string; to?: string; error?: string; message?: string; received?: number; total?: number } }

	| { type: "projects"; projects: import("./projects.ts").Project[] }
	/** Worker default model of this machine changed (config.json workerModel). */
	| { type: "workerModel"; info: Record<string, unknown> };
