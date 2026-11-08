// Minimal HTTP + SSE client for the quick-agent hub (uses global fetch).
import { readFileSync } from "node:fs";
import { hubToken, hubUrl, loadConfig, paths, type QaConfig } from "./config.ts";
import type { UpgradeResult } from "./update.ts";
import type { CronRun } from "./cron.ts";
import type { CronView } from "../hub/cron.ts";
import type { AttentionCounts, AttentionItem, FocusState } from "./attention.ts";
import type { Project } from "./projects.ts";
import type { HubEvent, Intake, MachineInfo, MachineView, Task, TaskEvent } from "./types.ts";
import type { PublicMember, Role, TaskComment, Viewer } from "./team.ts";

export class HubError extends Error {
	status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export interface CronInput {
	title: string;
	brief: string;
	cron?: string;
	every?: string | number;
	at?: string | number;
	in?: string | number;
	tz?: string;
	machine?: string;
	requires?: string[];
	cwd?: string;
	/** Project of the dispatched tasks (id or name). */
	project?: string;
	overlap?: "skip" | "queue" | "parallel";
	catchUp?: "latest" | "skip";
	silent?: boolean;
	enabled?: boolean;
	createdBy?: string;
	/** Hub that owns (fires) the job; default the hub receiving the request. */
	hub?: string;
}

/** A hub restart is in progress (marker written by `quick hub reload`, at most 60 s old). */
export function hubRestarting(): boolean {
	try {
		return Date.now() - Number(readFileSync(paths.restarting, "utf8")) < 60_000;
	} catch {
		return false;
	}
}

export class HubClient {
	readonly base: string;
	readonly token: string;

	constructor(cfg: QaConfig = loadConfig()) {
		this.base = hubUrl(cfg);
		this.token = hubToken(cfg);
	}

	async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, retry = true): Promise<T> {
		let res: Response;
		for (let attempt = 0; ; attempt++) {
			try {
				res = await fetch(this.base + path, {
					method,
					headers: {
						authorization: `Bearer ${this.token}`,
						...(body === undefined ? {} : { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal,
				});
				break;
			} catch (err) {
				// The hub is being restarted (upgrade / `quick hub reload`): wait for it instead of failing.
				if (retry && attempt < 60 && !signal?.aborted && hubRestarting()) {
					await new Promise((r) => setTimeout(r, 250));
					continue;
				}
				throw new HubError(`quick-agent hub unreachable at ${this.base} (${(err as Error).message}). Start it with: quick hub start`);
			}
		}
		const text = await res.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { error: text };
		}
		if (!res.ok) throw new HubError(data?.error ?? `HTTP ${res.status}`, res.status);
		return data as T;
	}

	health() {
		return this.request<{ ok: boolean; pid: number; tasks: number; machine?: string; version?: string }>("GET", "/health", undefined, undefined, false);
	}
	listTasks() {
		return this.request<{ tasks: Task[] }>("GET", "/api/tasks").then((r) => r.tasks);
	}
	getTask(id: string, events = 30) {
		return this.request<{ task: Task; events: TaskEvent[]; comments?: TaskComment[] }>("GET", `/api/tasks/${enc(id)}?events=${events}`);
	}

	// ---- team (docs/team-collaboration.md)
	me() {
		return this.request<{ me?: PublicMember; viewer: Viewer; machine: string }>("GET", "/api/me");
	}
	team() {
		return this.request<{ me?: PublicMember; root: boolean; members: (PublicMember & { machines: string[] })[]; invites?: any[] }>("GET", "/api/team");
	}
	addMember(body: { id: string; name?: string; role?: Role; machineOwner?: boolean }) {
		return this.request<{ member: PublicMember; token: string }>("POST", "/api/team/members", body);
	}
	updateMember(id: string, body: { role?: Role; name?: string; resetToken?: boolean; remove?: boolean }) {
		return this.request<any>("POST", `/api/team/members/${enc(id)}`, body);
	}
	invite(body: { role?: Role; hours?: number; revoke?: string }) {
		return this.request<{ code: string; invite: any }>("POST", "/api/team/invites", body);
	}
	join(body: { code: string; id: string; name?: string }) {
		return this.request<{ member: PublicMember; token: string }>("POST", "/api/team/join", body);
	}
	/** Hand a task to a person (assignee), ask someone to verify/decide (reviewer), add/remove watchers. null clears. */
	assign(id: string, body: { assignee?: string | null; reviewer?: string | null; watchersAdd?: string[]; watchersRemove?: string[]; note?: string }) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/assign`, body).then((r) => r.task);
	}
	comment(id: string, text: string, opts: { toWorker?: boolean; asWorker?: boolean } = {}) {
		return this.request<{ task: Task; comment: TaskComment }>("POST", `/api/tasks/${enc(id)}/comments`, { text, ...opts });
	}
	comments(id: string, limit = 100) {
		return this.request<{ comments: TaskComment[] }>("GET", `/api/tasks/${enc(id)}/comments?limit=${limit}`).then((r) => r.comments);
	}
	createTask(input: {
		title: string;
		brief: string;
		cwd?: string;
		attachments?: string[];
		source?: Task["source"];
		model?: string;
		owner?: string;
		/** Machine to run the worker on (default: best-priority online machine that has `requires`). */
		machine?: string;
		/** Resource tags the worker needs (see shared/schedule.ts). */
		requires?: string[];
		/** Team: hand the task to a person, ask someone to verify/decide, people who follow it. */
		assignee?: string;
		reviewer?: string;
		watchers?: string[];
		/** Project id or name (default: inferred from cwd / git / page URL / text; unknown names are created). */
		project?: string;
		/** Front's automatic risk/complexity judgement; hub applies project rules and safety checks. */
		lifecycle?: import("./lifecycle.ts").LifecycleInput;
	}) {
		return this.request<{ task: Task }>("POST", "/api/tasks", input).then((r) => r.task);
	}
	/** Set resources/priority/notes of a machine (default this hub's machine); null clears a field. */
	configureMachine(input: { machine?: string; resources?: string[] | null; resourceNotes?: string | null; priority?: number | null; description?: string; owner?: string | null }) {
		return this.request<{ machine: MachineInfo }>("POST", "/api/machine", input).then((r) => r.machine);
	}
	sendMessage(id: string, text: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/message`, { text }).then((r) => r.task);
	}
	cancel(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/cancel`, {}).then((r) => r.task);
	}
	close(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/close`, {}).then((r) => r.task);
	}
	/** Move a task to another machine (async: poll the task to follow progress). */
	handoff(id: string, body: { to: string; cwd?: string; noWorkspace?: boolean; abort?: boolean; waitSec?: number; onConflict?: "fail" | "stash" | "backup"; testFail?: string }) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/handoff`, body).then((r) => r.task);
	}
	ack(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/ack`, {}).then((r) => r.task);
	}
	/** 稍后提醒: hide from need/skim for `minutes` (0 = bring back now). */
	snooze(id: string, minutes: number) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/snooze`, { minutes }).then((r) => r.task);
	}
	retry(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/retry`, {}).then((r) => r.task);
	}
	/** The attention queue (shared/attention.ts), sorted by priority, with counts and focus state. */
	attention(archived = 30, scope: "mine" | "team" = "mine") {
		return this.request<{ items: AttentionItem[]; counts: AttentionCounts; focus: FocusState; digestMinutes: number; pendingDigest: number }>("GET", `/api/attention?archived=${archived}${scope === "team" ? "&scope=team" : ""}`);
	}
	/** Focus mode: only "需要你" interrupts; digests are held until it ends. minutes omitted = until turned off. */
	setFocus(on: boolean, minutes?: number) {
		return this.request<{ focus: FocusState }>("POST", "/api/attention/focus", { on, minutes }).then((r) => r.focus);
	}
	/** Worker → hub state report. needsHuman marks an explicit request for a human decision. */
	report(id: string, body: { status?: Task["status"]; summary?: string; activity?: string; sessionFile?: string; kind?: TaskEvent["kind"]; settled?: boolean; scope?: {risk:"critical"|"complex";reason:string}; needsHuman?: boolean; question?: string; options?: string[] }) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/report`, body).then((r) => r.task);
	}
	projects() {
		return this.request<{ self: string; projects: Project[] }>("GET", "/api/projects");
	}
	createProject(body: { name: string; urls?: string[]; paths?: string[]; remotes?: string[]; keywords?: string[]; notes?: string }) {
		return this.request<{ project: Project }>("POST", "/api/projects", body).then((r) => r.project);
	}
	renameProject(id: string, name: string) {
		return this.request<{ project: Project }>("POST", `/api/projects/${enc(id)}/rename`, { name }).then((r) => r.project);
	}
	mergeProject(id: string, into: string) {
		return this.request<{ project: Project }>("POST", `/api/projects/${enc(id)}/merge`, { into }).then((r) => r.project);
	}
	/** Add / remove identification rules of a project. */
	projectRules(id: string, body: { add?: Partial<Record<"urls" | "paths" | "remotes" | "keywords", string[]>>; remove?: Partial<Record<"urls" | "paths" | "remotes" | "keywords", string[]>>; notes?: string }) {
		return this.request<{ project: Project }>("POST", `/api/projects/${enc(id)}/rules`, body).then((r) => r.project);
	}
	/** Classify tasks never classified (all: every task not set by hand). */
	backfillProjects(all = false) {
		return this.request<{ checked: number; changed: number }>("POST", "/api/projects/backfill", { all });
	}
	/** Manually move a task to a project ("" = unsorted); remembered across reclassification. */
	setTaskProject(id: string, project: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/project`, { project }).then((r) => r.task);
	}
	machines() {
		return this.request<{ self: string; machines: MachineView[]; links: any }>("GET", "/api/machines");
	}
	/** Upgrade (or with check: just check) machines through the mesh. */
	upgrade(body: { machines?: string[]; all?: boolean; check?: boolean }) {
		return this.request<{ results: UpgradeResult[] }>("POST", "/api/upgrade", body).then((r) => r.results);
	}
	/** Update status of one machine (default this one) or, with all, of every online machine. */
	updateStatus(q: { machine?: string; all?: boolean; refresh?: boolean } = {}) {
		const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();
		return this.request<any>("GET", `/api/update${qs ? `?${qs}` : ""}`);
	}
	/** Start an asynchronous upgrade / rollback on a machine (progress: updateStatus). */
	startUpdate(body: { machine?: string; action: "install" | "rollback" }) {
		return this.request<any>("POST", "/api/update", body);
	}
	fs(body: { machine?: string; op: "ls" | "read" | "grep"; path: string; pattern?: string; offset?: number; limit?: number }) {
		return this.request<any>("POST", "/api/fs", body);
	}
	/** Scheduled jobs of the whole mesh. */
	listCron() {
		return this.request<{ jobs: CronView[]; tz: string; self: string }>("GET", "/api/cron");
	}
	getCron(id: string) {
		return this.request<{ job: CronView }>("GET", `/api/cron/${enc(id)}`).then((r) => r.job);
	}
	/** Create a scheduled job: exactly one of cron / every / at / in; tz defaults to the hub's local zone. */
	createCron(input: CronInput) {
		return this.request<{ job: CronView }>("POST", "/api/cron", input).then((r) => r.job);
	}
	updateCron(id: string, patch: Partial<CronInput> & { enabled?: boolean }) {
		return this.request<{ job: CronView }>("POST", `/api/cron/${enc(id)}`, patch).then((r) => r.job);
	}
	cronAction(id: string, action: "pause" | "resume" | "delete") {
		return this.request<{ job: CronView }>("POST", `/api/cron/${enc(id)}/${action}`, {}).then((r) => r.job);
	}
	runCron(id: string) {
		return this.request<{ job: CronView; run: CronRun }>("POST", `/api/cron/${enc(id)}/run`, {});
	}
	pendingIntake() {
		return this.request<{ intake: Intake[] }>("GET", "/api/intake?status=pending").then((r) => r.intake);
	}
	claimIntake(id: string, by: string) {
		return this.request<{ intake: Intake }>("POST", `/api/intake/${enc(id)}/claim`, { by }).then((r) => r.intake);
	}
	updateIntake(id: string, body: { status?: Intake["status"]; taskId?: string }) {
		return this.request<{ intake: Intake }>("POST", `/api/intake/${enc(id)}`, body).then((r) => r.intake);
	}

	/**
	 * Subscribe to the hub event stream. Reconnects with backoff until `signal` aborts.
	 * `onState` reports connection changes.
	 */
	subscribe(
		onEvent: (e: HubEvent) => void,
		signal: AbortSignal,
		onState?: (connected: boolean) => void,
		query: Record<string, string> = {},
	): void {
		const qs = new URLSearchParams(query).toString();
		const loop = async () => {
			let delay = 500;
			while (!signal.aborted) {
				try {
					const res = await fetch(`${this.base}/api/events${qs ? `?${qs}` : ""}`, {
						headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
						signal,
					});
					if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
					onState?.(true);
					delay = 500;
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buf += decoder.decode(value, { stream: true });
						let idx: number;
						while ((idx = buf.indexOf("\n\n")) >= 0) {
							const frame = buf.slice(0, idx);
							buf = buf.slice(idx + 2);
							const data = frame
								.split("\n")
								.filter((l) => l.startsWith("data:"))
								.map((l) => l.slice(5).trimStart())
								.join("\n");
							if (!data) continue;
							try {
								onEvent(JSON.parse(data) as HubEvent);
							} catch {
								/* ignore malformed frame */
							}
						}
					}
				} catch {
					/* fall through to reconnect */
				}
				if (signal.aborted) break;
				onState?.(false);
				await new Promise((r) => setTimeout(r, delay));
				delay = Math.min(delay * 2, 10_000);
			}
		};
		void loop();
	}
}

function enc(s: string) {
	return encodeURIComponent(s);
}
