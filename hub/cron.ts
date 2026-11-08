// Scheduled jobs in the hub: persistence (~/.quick-agent/cron.json), the timer that fires due jobs,
// mesh replication and the cron.* methods (callable over the mesh on the owning hub).
//
// Multi-hub de-duplication: every job has exactly one owner hub (`job.hub`, the hub it was created
// on). Only the owner stores the authoritative copy and only the owner's timer fires it; other hubs
// keep read-only replicas (flooded like tasks, ordered by rev) and route mutations to the owner via
// mesh RPC. No leader election, no clock agreement needed. The dispatched task itself may run on any
// machine (normal machine selection). If the owner hub is down, its jobs fire when it comes back,
// according to the job's catch-up policy.
//
// Crash safety: a run is persisted (lastRunAt/nextRunAt advanced) before the task is dispatched, so a
// crash between the two loses at most that run instead of firing it twice (at-most-once per slot).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
	CronError,
	type CronJob,
	type CronRun,
	decide,
	describeRule,
	formatWall,
	localTimeZone,
	nextRun,
	parseRule,
	renderBrief,
	type RuleInput,
} from "../shared/cron.ts";
import { normalizeRequires } from "../shared/schedule.ts";
import type { HubEvent, Task, TaskStatus } from "../shared/types.ts";

const MAX_RUNS = 20;
const TOMBSTONE_MS = 14 * 86400_000;
/** Statuses during which a run counts as still in progress for the overlap policy. */
const IN_PROGRESS: TaskStatus[] = ["starting", "running", "handoff"];

export interface CronDeps {
	self: string;
	file: string;
	log(msg: string): void;
	findTask(id: string): Task | undefined;
	/** Same path as POST /api/tasks (machine selection included). */
	dispatch(body: any): Promise<Task>;
	/** Record a task that could not be dispatched (status failed, needs the human). */
	recordFailed(body: any, reason: string): Task;
	broadcast(e: HubEvent): void;
	flood(kind: string, data: any): void;
	call<T = any>(machine: string, method: string, params: any): Promise<T>;
	reachable(machine: string): boolean;
	httpError(status: number, msg: string): Error;
}

export interface CronView extends CronJob {
	describe: string;
	running: boolean;
	/** Tasks of the most recent dispatched runs (newest first). */
	tasks: { id: string; status?: TaskStatus; unread?: boolean; machine?: string; summary?: string; at: number }[];
}

export function createCron(d: CronDeps) {
	const own = new Map<string, CronJob>();
	const mirror = new Map<string, CronJob>();
	const firing = new Set<string>();
	const bootAt = Date.now();
	let timer: ReturnType<typeof setInterval> | undefined;

	// ------------------------------------------------------------ persistence

	function load() {
		if (!existsSync(d.file)) return;
		try {
			const raw = JSON.parse(readFileSync(d.file, "utf8"));
			for (const j of (raw.jobs ?? []) as CronJob[]) {
				// The file is local and authoritative: adopt jobs even if the machine id changed.
				j.hub = d.self;
				j.runs ??= [];
				j.rev ??= 0;
				if (j.deleted && Date.now() - j.updatedAt > TOMBSTONE_MS) continue;
				own.set(j.id, j);
			}
			d.log(`[cron] loaded ${[...own.values()].filter((j) => !j.deleted).length} job(s)`);
		} catch (e) {
			d.log(`[cron] cannot read ${d.file}: ${(e as Error).message}`);
		}
	}
	function persist() {
		const tmp = `${d.file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: 1, jobs: [...own.values()] }, null, 2));
		renameSync(tmp, d.file);
	}
	function changed(j: CronJob) {
		j.rev = (j.rev ?? 0) + 1;
		j.updatedAt = Date.now();
		persist();
		d.broadcast({ type: "cron", job: j });
		d.flood("cron", { job: j });
	}

	// ------------------------------------------------------------ helpers

	function ownJob(id: string): CronJob {
		const j = own.get(id);
		if (!j || j.deleted) throw d.httpError(404, `no such scheduled job on ${d.self}: ${id}`);
		return j;
	}
	function anyJob(id: string): CronJob {
		const j = own.get(id) ?? mirror.get(id);
		if (!j || j.deleted) throw d.httpError(404, `no such scheduled job: ${id}`);
		return j;
	}
	function newId() {
		for (;;) {
			const id = `s${randomBytes(3).toString("hex").slice(0, 4)}`;
			if (!own.has(id) && !mirror.has(id)) return id;
		}
	}
	function bad(e: unknown): never {
		if (e instanceof CronError) throw d.httpError(400, e.message);
		throw e;
	}
	function running(j: CronJob): boolean {
		if (firing.has(j.id)) return true;
		return j.runs.some((r) => r.taskId && IN_PROGRESS.includes(d.findTask(r.taskId)?.status as TaskStatus));
	}
	function pushRun(j: CronJob, r: CronRun) {
		j.runs.push(r);
		if (j.runs.length > MAX_RUNS) j.runs.splice(0, j.runs.length - MAX_RUNS);
	}
	function lastTaskId(j: CronJob) {
		return [...j.runs].reverse().find((r) => r.taskId)?.taskId;
	}
	function ruleInput(p: any): RuleInput | undefined {
		const r: RuleInput = {};
		for (const k of ["cron", "every", "at", "in"] as const) if (p[k] !== undefined && p[k] !== null && p[k] !== "") r[k] = p[k];
		if (!Object.keys(r).length) return undefined;
		if (p.tz) r.tz = String(p.tz);
		return r;
	}
	function applyOptions(j: CronJob, p: any) {
		if (typeof p.title === "string" && p.title.trim()) j.title = p.title.trim();
		if (typeof p.brief === "string" && p.brief.trim()) j.brief = p.brief.trim();
		for (const k of ["machine", "cwd"] as const) {
			if (p[k] === null || p[k] === "") delete j[k];
			else if (typeof p[k] === "string") j[k] = p[k].trim();
		}
		if (p.requires === null) delete j.requires;
		else if (p.requires !== undefined) {
			const r = normalizeRequires(p.requires);
			if (r.length) j.requires = r;
			else delete j.requires;
		}
		if (p.overlap !== undefined) {
			if (!["skip", "queue", "parallel"].includes(p.overlap)) throw d.httpError(400, "overlap must be skip, queue or parallel");
			j.overlap = p.overlap;
		}
		const cu = p.catchUp ?? p.catch_up;
		if (cu !== undefined) {
			if (!["latest", "skip"].includes(cu)) throw d.httpError(400, "catchUp must be latest or skip");
			j.catchUp = cu;
		}
		if (p.silent !== undefined) j.silent = !!p.silent;
	}

	// ------------------------------------------------------------ firing

	async function fire(j: CronJob, trigger: CronRun["trigger"], scheduledAt: number | undefined, note?: string): Promise<CronRun> {
		const now = Date.now();
		j.runCount += 1;
		j.lastRunAt = now;
		const n = j.runCount;
		const prev = lastTaskId(j);
		const run: CronRun = { at: now, scheduledAt, trigger, result: "dispatched", ...(note ? { reason: note } : {}) };
		pushRun(j, run);
		firing.add(j.id);
		changed(j); // persisted before dispatch: at most once per slot
		const stamp = formatWall(scheduledAt ?? now, j.tz).slice(5);
		const body = {
			title: `${j.title} (${stamp})`,
			brief: renderBrief(j, scheduledAt ?? now, n, prev),
			cwd: j.cwd,
			machine: j.machine,
			requires: j.requires,
			source: { kind: "cron", cronId: j.id, cronHub: d.self, ...(j.silent ? { silent: true } : {}) },
			...(j.requester ? { requester: j.requester } : {}),
		};
		try {
			const t = await d.dispatch(body);
			run.taskId = t.id;
			run.machine = t.machine;
			d.log(`[cron] ${j.id} "${j.title}" ${trigger} → task ${t.id} on ${t.machine}`);
		} catch (e) {
			const reason = (e as Error).message;
			run.result = "failed";
			run.reason = reason;
			try {
				const t = d.recordFailed(body, reason);
				run.taskId = t.id;
				run.machine = t.machine;
			} catch {}
			d.log(`[cron] ${j.id} "${j.title}" ${trigger} failed: ${reason}`);
		} finally {
			firing.delete(j.id);
		}
		if (own.get(j.id) === j) changed(j);
		return run;
	}

	function tick() {
		const now = Date.now();
		for (const j of own.values()) {
			if (firing.has(j.id)) continue;
			let dec;
			try {
				dec = decide(j, now, bootAt, running(j));
			} catch (e) {
				d.log(`[cron] ${j.id}: ${(e as Error).message}`);
				continue;
			}
			if (dec.action === "none") continue;
			const oneShot = j.rule.kind === "at";
			if (dec.action === "fire") {
				if (dec.trigger === "queued") j.queued = undefined;
				else {
					j.nextRunAt = dec.next;
					if (oneShot && dec.next === undefined) j.finished = true;
				}
				void fire(j, dec.trigger, dec.scheduledAt, dec.missed ? `catch-up: ${dec.missed} missed run(s) while the hub was down, ran the latest once` : undefined);
			} else if (dec.action === "skip") {
				j.nextRunAt = dec.next;
				if (oneShot && dec.next === undefined) j.finished = true;
				pushRun(j, { at: now, scheduledAt: dec.scheduledAt, trigger: "schedule", result: dec.result, reason: dec.reason });
				d.log(`[cron] ${j.id} "${j.title}" ${dec.result}: ${dec.reason}`);
				changed(j);
			} else if (dec.action === "queue") {
				j.nextRunAt = dec.next;
				const already = !!j.queued;
				j.queued = dec.scheduledAt;
				pushRun(j, { at: now, scheduledAt: dec.scheduledAt, trigger: "schedule", result: already ? "skipped" : "queued", reason: already ? "a run is already queued" : "previous run still in progress; queued" });
				changed(j);
			}
		}
		// Purge old tombstones.
		for (const [id, j] of own) if (j.deleted && now - j.updatedAt > TOMBSTONE_MS) own.delete(id);
	}

	// ------------------------------------------------------------ mutations (owner hub)

	function create(p: any): CronJob {
		const title = String(p.title ?? "").trim();
		const brief = String(p.brief ?? "").trim();
		if (!title) throw d.httpError(400, "title is required");
		if (!brief) throw d.httpError(400, "brief is required");
		const input = ruleInput(p);
		if (!input) throw d.httpError(400, "give one of cron / every / at / in");
		const now = Date.now();
		let parsed;
		try {
			parsed = parseRule(input, now, localTimeZone());
		} catch (e) {
			bad(e);
		}
		const j: CronJob = {
			id: newId(),
			hub: d.self,
			rev: 0,
			title,
			brief,
			rule: parsed.rule,
			tz: parsed.tz,
			enabled: p.enabled !== false,
			overlap: "skip",
			catchUp: "latest",
			silent: false,
			createdAt: now,
			updatedAt: now,
			runCount: 0,
			runs: [],
			createdBy: typeof p.createdBy === "string" ? p.createdBy : undefined,
			requester: typeof p.requester === "string" && p.requester ? p.requester : undefined,
		};
		applyOptions(j, p);
		if (j.rule.kind === "at" && j.rule.at <= now) throw d.httpError(400, `time ${formatWall(j.rule.at, j.tz)} (${j.tz}) is in the past`);
		j.nextRunAt = j.enabled ? nextRun(j.rule, now, j.tz) : undefined;
		own.set(j.id, j);
		d.log(`[cron] created ${j.id} "${j.title}" ${describeRule(j.rule, j.tz)}, next ${j.nextRunAt ? formatWall(j.nextRunAt, j.tz, true) : "-"}`);
		changed(j);
		return j;
	}

	function update(p: any): CronJob {
		const j = ownJob(String(p.id));
		applyOptions(j, p);
		const input = ruleInput(p);
		const now = Date.now();
		if (input || p.tz) {
			try {
				const r = parseRule(input ?? ruleInputOf(j, p.tz), now, j.tz);
				j.rule = r.rule;
				j.tz = r.tz;
			} catch (e) {
				bad(e);
			}
			j.finished = false;
			j.nextRunAt = j.enabled ? nextRun(j.rule, now, j.tz) : undefined;
		}
		if (p.enabled === true && !j.enabled) return resume({ id: j.id });
		if (p.enabled === false && j.enabled) return pause({ id: j.id });
		changed(j);
		return j;
	}
	function ruleInputOf(j: CronJob, tz: string): RuleInput {
		if (j.rule.kind === "cron") return { cron: j.rule.expr, tz };
		if (j.rule.kind === "every") return { every: j.rule.everyMs, tz };
		return { at: j.rule.at, tz };
	}

	function pause(p: any): CronJob {
		const j = ownJob(String(p.id));
		j.enabled = false;
		j.nextRunAt = undefined;
		j.queued = undefined;
		changed(j);
		return j;
	}
	function resume(p: any): CronJob {
		const j = ownJob(String(p.id));
		j.enabled = true;
		// Runs that fell into the paused period are not caught up; a one-shot that expired while paused runs once (catch-up policy).
		j.nextRunAt = j.finished ? undefined : j.rule.kind === "at" ? j.rule.at : nextRun(j.rule, Date.now(), j.tz);
		changed(j);
		return j;
	}
	function remove(p: any): CronJob {
		const j = ownJob(String(p.id));
		j.deleted = true;
		j.enabled = false;
		j.nextRunAt = undefined;
		j.queued = undefined;
		changed(j);
		return j;
	}
	async function runNow(p: any): Promise<{ job: CronJob; run: CronRun }> {
		const j = ownJob(String(p.id));
		const run = await fire(j, "manual", undefined);
		return { job: j, run };
	}

	const methods: Record<string, (p: any, from: string) => Promise<any>> = {
		"cron.create": async (p) => create(p),
		"cron.update": async (p) => update(p),
		"cron.pause": async (p) => pause(p),
		"cron.resume": async (p) => resume(p),
		"cron.delete": async (p) => remove(p),
		"cron.run": async (p) => runNow(p),
	};

	// ------------------------------------------------------------ views

	function view(j: CronJob): CronView {
		const tasks = [...j.runs]
			.reverse()
			.filter((r) => r.taskId)
			.slice(0, 5)
			.map((r) => {
				const t = d.findTask(r.taskId!);
				return { id: r.taskId!, status: t?.status, unread: t?.unread, machine: t?.machine ?? r.machine, summary: t?.summary?.split("\n").find((l) => l.trim())?.slice(0, 200), at: r.at };
			});
		return { ...j, describe: describeRule(j.rule, j.tz), running: running(j), tasks };
	}
	function list(): CronView[] {
		return [...own.values(), ...mirror.values()].filter((j) => !j.deleted).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || b.createdAt - a.createdAt).map(view);
	}

	/** Route a mutation to the job's owner hub. */
	async function routed(method: string, id: string, params: any = {}) {
		const j = anyJob(id);
		if (j.hub !== d.self && !d.reachable(j.hub)) throw d.httpError(503, `job ${id} belongs to hub ${j.hub}, which is offline`);
		const r = await d.call(j.hub, method, { ...params, id });
		return r;
	}

	return {
		methods,
		load,
		start() {
			timer = setInterval(() => {
				try {
					tick();
				} catch (e) {
					d.log(`[cron] tick failed: ${(e as Error).message}`);
				}
			}, 1000);
			timer.unref?.();
		},
		stop() {
			if (timer) clearInterval(timer);
		},
		list,
		get(id: string) {
			return view(anyJob(id));
		},
		view,
		routed,
		snapshot() {
			return [...own.values(), ...mirror.values()].map((job) => ({ kind: "cron", data: { job } }));
		},
		/** Replica from another hub; returns true when it was newer (and should be forwarded). */
		onReplica(job: CronJob | undefined): boolean {
			if (!job || job.hub === d.self) return false;
			const cur = mirror.get(job.id);
			if (cur && cur.hub === job.hub && cur.rev >= job.rev) return false;
			mirror.set(job.id, job);
			d.broadcast({ type: "cron", job });
			return true;
		},
		/** Job ids with work in progress (for status endpoints). */
		active() {
			return [...own.values()].filter((j) => !j.deleted && j.enabled && !j.finished).length;
		},
	};
}
