// Data model shared by hub, CLI and extensions.

export type TaskStatus =
	| "starting" // tmux window spawned, worker not yet connected
	| "running" // worker agent is executing
	| "idle" // worker stopped without an explicit report (waiting for you)
	| "needs_input" // worker asked a question
	| "blocked" // worker cannot continue
	| "done" // worker reported completion
	| "failed" // worker crashed / spawn failed
	| "cancelled" // you cancelled it
	| "exited"; // pi process in the window exited

/** Statuses that need the human's attention. */
export const ATTENTION_STATUSES: TaskStatus[] = ["idle", "needs_input", "blocked", "done", "failed", "exited"];
export const ACTIVE_STATUSES: TaskStatus[] = ["starting", "running"];
export const CLOSED_STATUSES: TaskStatus[] = ["cancelled"];

export interface TaskSource {
	kind: "tui" | "browser" | "cli" | "api";
	intakeId?: string;
	url?: string;
}

export interface Task {
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
}

export interface TaskEvent {
	ts: number;
	taskId: string;
	kind: "created" | "status" | "activity" | "report" | "message" | "cancel" | "close" | "ack" | "session";
	text?: string;
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
	region?: { x: number; y: number; width: number; height: number };
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
	| { type: "update"; machine: string; from: string; to: string; ts: number };
