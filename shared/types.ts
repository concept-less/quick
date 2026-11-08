// Data model shared by hub, CLI and extensions.
import type { TaskPeople } from "./team.ts";
import type { CronJob } from "./cron.ts";

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

/** Statuses that need the human's attention. */
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
	/** Short description of what the worker is doing right now. */
	activity?: string;
	/** True when there is news the human has not acknowledged yet. */
	unread: boolean;
	sessionFile?: string;
	tmuxTarget?: string;
	/** Number of follow-up messages sent to the worker. */
	messages: number;
	/** pi session id of the front agent that dispatched the task (receives its reports). */
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
}

export interface TaskEvent {
	ts: number;
	taskId: string;
	kind: "created" | "status" | "activity" | "report" | "message" | "cancel" | "close" | "ack" | "session" | "handoff" | "assign" | "comment";
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
	status: "pending" | "claimed" | "dispatched" | "dismissed";
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
	| { type: "cron"; job: CronJob };
