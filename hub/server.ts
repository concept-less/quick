// quick-agent hub: task registry, attention inbox, worker lifecycle (tmux), intake, SSE,
// and the multi-machine mesh (see mesh.ts).
// Run: node hub/server.ts   (normally started automatically by pi or `quick hub start`)
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { intakeRetentionMs, loadConfig, matchProject, paths, REPO_ROOT, saveConfigPatch } from "../shared/config.ts";
import { applyResourceEdits, candidateMachines, detectResources, mergeResources, normalizeRequires, pickMachineForCwd, ScheduleError } from "../shared/schedule.ts";
import type { Project } from "../shared/projects.ts";
import {
	ACTIVE_STATUSES,
	ATTENTION_STATUSES,
	type HubEvent,
	type Intake,
	type MachineInfo,
	type Task,
	type TaskEvent,
	type TaskStatus,
} from "../shared/types.ts";
import { dashboardHtml } from "./dashboard.ts";
import { Mesh } from "./mesh.ts";
import { activeRoot, compareVersions, readJob, readState, readVersion, runUpgrade, spawnReload, type Step, updateStatus, type UpgradeResult, writeJob } from "../shared/update.ts";
import { createHandoff } from "./handoff.ts";
import { createTeam } from "./team.ts";
import { AGENT, can, personalAttention, teamRow, type Viewer } from "../shared/team.ts";
import { createCron } from "./cron.ts";
import { createAttention, keyOf } from "./attention.ts";
import { createProjects } from "./projects.ts";
import { applyActivity, applyProgress, finishProgress, restartProgress } from "../shared/progress.ts";
import { readTranscript } from "../shared/transcript.ts";
import { createWatchdog } from "./watchdog.ts";
import { EXPECT_SOURCE_LABEL, fmtMinutes } from "../shared/watchdog.ts";
import { checkModelSpec, listPiModels, type PiModel } from "../shared/worker-model.ts";

const run = promisify(execFile);
const cfg = loadConfig();
const SELF = cfg.machine.id;
const EXTENSION_DIR = join(REPO_ROOT, "browser");
const STARTED_AT = Date.now();
const MAX_TRANSFER = 25 * 1024 * 1024;
/** Version of the code this hub process is running. */
const VERSION = readVersion(REPO_ROOT);
const UPGRADE_RPC_TIMEOUT_MS = 6 * 60_000;

/** Tasks owned (executed) by this machine. */
const tasks = new Map<string, Task>();
/** Replicas of tasks owned by other machines. */
const mirrorTasks = new Map<string, Task>();
const intakes = new Map<string, Intake>();
const mirrorIntakes = new Map<string, Intake>();
const pendingMessages = new Map<string, string[]>();

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function log(msg: string) {
	console.log(`${new Date().toISOString()} ${msg}`);
}

// ---------------------------------------------------------------- persistence

function taskDir(id: string) {
	return join(paths.tasks, id);
}
function saveTask(t: Task) {
	mkdirSync(taskDir(t.id), { recursive: true });
	writeFileSync(join(taskDir(t.id), "task.json"), JSON.stringify(t, null, 2));
}
function saveIntake(i: Intake) {
	mkdirSync(join(paths.intake, i.id), { recursive: true });
	writeFileSync(join(paths.intake, i.id, "intake.json"), JSON.stringify(i, null, 2));
}
function loadAll() {
	for (const id of safeReaddir(paths.tasks)) {
		try {
			const t = JSON.parse(readFileSync(join(taskDir(id), "task.json"), "utf8")) as Task;
			t.machine ??= SELF;
			t.rev ??= 0;
			if (t.machine === SELF) {
				handoff.recoverOnLoad(t);
				watchdog.onLoad(t);
				tasks.set(t.id, t);
			}
		} catch {}
	}
	for (const id of safeReaddir(paths.intake)) {
		try {
			const i = JSON.parse(readFileSync(join(paths.intake, id, "intake.json"), "utf8")) as Intake;
			i.machine ??= SELF;
			i.rev ??= 0;
			if (i.machine !== SELF) continue; // local copies of remote intakes (screenshots) are not authoritative
			// One-shot: a claimed comment was consumed by a front agent and is never delivered again.
			if (i.status === "claimed") i.status = "consumed";
			intakes.set(i.id, i);
		} catch {}
	}
}
function safeReaddir(p: string) {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}
function readEvents(id: string, limit: number): TaskEvent[] {
	const f = join(taskDir(id), "events.jsonl");
	if (!existsSync(f)) return [];
	const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
	return lines.slice(-limit).map((l) => JSON.parse(l) as TaskEvent);
}
function newId(prefix: string, exists: (id: string) => boolean) {
	for (;;) {
		const id = prefix + randomBytes(3).toString("hex").slice(0, 4);
		if (!exists(id)) return id;
	}
}

// ---------------------------------------------------------------- local SSE clients

interface SseClient {
	res: ServerResponse;
	taskId?: string; // set for worker connections
	role: string;
	/** Who is connected (team member / root). */
	viewer?: Viewer;
	/** Stable id of a front agent connection (role=front). */
	front?: string;
}
const clients = new Set<SseClient>();
/** Attention model (hub/attention.ts); created once the persisted tasks are loaded. */
let attention: ReturnType<typeof createAttention>;

function broadcast(e: HubEvent, filter?: (c: SseClient) => boolean) {
	if (e.type === "task" && projects) e = { ...e, task: projects.view(e.task) };
	const frame = `data: ${JSON.stringify(e)}\n\n`;
	for (const c of clients) if (!filter || filter(c)) c.res.write(frame);
	// Every task change is re-evaluated by the attention model (which may emit an "attention" event).
	if (e.type === "task" && !filter) attention?.onTask(e.task, e.event);
}

/**
 * Front agent that should proactively tell a person about a task that needs them: among that person's
 * connected fronts, the one that dispatched it, else the persistent Web UI front, else any. Every connected
 * front of the person still receives the report in its conversation; this only picks who speaks up.
 */
function pickFront(t: Task, key: string): string | undefined {
	const fronts = [...clients].filter((c) => keyOf(c.viewer) === key).map((c) => c.front).filter((f): f is string => !!f);
	if (t.owner && fronts.includes(t.owner)) return t.owner;
	return fronts.find((f) => f.startsWith("webui@")) ?? fronts[0];
}
function workerConnected(taskId: string) {
	for (const c of clients) if (c.taskId === taskId) return true;
	return false;
}

// ---------------------------------------------------------------- mesh

/** Auto-detected resource tags (refreshed when the machine config is reloaded). */
let detected = detectResources();

function machineInfo(): MachineInfo {
	return {
		id: SELF,
		description: cfg.machine.description,
		resources: mergeResources(detected, cfg.machine.resources),
		resourceNotes: cfg.machine.resourceNotes,
		priority: cfg.machine.priority,
		owner: cfg.machine.owner,
		defaultCwd: cfg.defaultCwd,
		projects: cfg.projects.filter((p) => !p.machine || p.machine === SELF),
		hostname: hostname(),
		platform: platform(),
		startedAt: STARTED_AT,
		activeTasks: [...tasks.values()].filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
		version: VERSION,
	};
}

const mesh = new Mesh({
	selfId: SELF,
	secret: cfg.mesh.secret,
	peers: cfg.mesh.peers,
	info: machineInfo,
	log,
	onTopologyChange: () => broadcast({ type: "machines", machines: mesh.machines() }),
	snapshot: () => {
		const recent = (o: { updatedAt?: number; createdAt: number }) => Date.now() - (o.updatedAt ?? o.createdAt) < 14 * 86400_000;
		return [
			...[...tasks.values(), ...mirrorTasks.values()].filter(recent).map((task) => ({ kind: "task", data: { task } })),
			...[...intakes.values(), ...mirrorIntakes.values()].filter((i) => !intakeExpired(i)).map((intake) => ({ kind: "intake", data: { intake } })),
			...team.snapshot(),
			...cron.snapshot(),
			...projects.snapshot(),
		];
	},
	onEvent: (kind, data) => {
		if (kind === "task") {
			const t = data.task as Task;
			if (!t || t.machine === SELF) return false;
			// Replicas are ordered by (epoch, rev); epoch increases with every handoff to another machine.
			const ep = (x: Task) => x.epoch ?? 0;
			const own = tasks.get(t.id);
			if (own) {
				if (ep(t) <= ep(own)) return false;
				yieldTask(own, t);
			}
			const cur = mirrorTasks.get(t.id);
			if (cur && (ep(cur) > ep(t) || (ep(cur) === ep(t) && cur.machine === t.machine && cur.rev >= t.rev))) return false;
			mirrorTasks.set(t.id, t);
			broadcast({ type: "task", task: t, event: data.event });
			return true;
		}
		if (kind === "cron") return cron.onReplica(data.job);
		if (kind === "project") return projects.onReplica(data.project);
		if (kind === "intake") {
			const i = data.intake as Intake;
			if (!i || i.machine === SELF) return false;
			const cur = mirrorIntakes.get(i.id);
			if (cur && cur.machine === i.machine && cur.rev >= i.rev) return false;
			if (intakeExpired(i)) return false;
			mirrorIntakes.set(i.id, i);
			broadcast({ type: "intake", intake: i });
			return true;
		}
		if (kind === "member" || kind === "invite") return team.applyRemote(kind, data);
		return false;
	},
	onRequest: (method, params, from) => {
		const fn = methods[method];
		if (!fn) throw new Error(`unknown method ${method}`);
		return fn(params ?? {}, from);
	},
});

// ---------------------------------------------------------------- projects (see hub/projects.ts)

/** Persist + replicate a project change of an own task without touching updatedAt (list order stays). */
function patchTask(t: Task, patch: Partial<Task>, note?: string) {
	Object.assign(t, patch, { rev: (t.rev ?? 0) + 1 });
	saveTask(t);
	const full = note ? recordEvent(t, { kind: "project", text: note }) : undefined;
	broadcast({ type: "task", task: t, event: full });
	mesh.flood("task", { task: t, event: full });
}

const projects = createProjects({
	self: SELF,
	file: join(paths.home, "projects.json"),
	log,
	tasks,
	patchTask,
	broadcast: (e) => broadcast(e),
	flood: (kind, data) => mesh.flood(kind, data),
	configRules: () => cfg.projects,
	repoRoot: REPO_ROOT,
	uiPort: cfg.uiPort,
	httpError: (status, msg) => new HttpError(status, msg),
});

/** Checkout of a project on a machine, if known. */
function projectDir(p: Project | undefined, machine: string): string | undefined {
	return p?.dirs.find((x) => x.machine === machine && (machine !== SELF || existsSync(x.path)))?.path;
}

/** Call a method on a machine (locally when it is us). */
function call<T = any>(machine: string, method: string, params: any, timeoutMs?: number): Promise<T> {
	return mesh.request<T>(machine, method, params, timeoutMs);
}

/** Another machine took over a task we own (a newer handoff epoch): stop running it here. */
function yieldTask(own: Task, newer: Task) {
	log(`task ${own.id} is now owned by ${newer.machine} (epoch ${newer.epoch ?? 0}); yielding`);
	tasks.delete(own.id);
	if (own.tmuxTarget && !own.closed) void tmux("kill-window", "-t", own.tmuxTarget).catch(() => {});
	saveTask(newer);
}

// ---------------------------------------------------------------- local task mutations

function recordEvent(t: Task, ev: Omit<TaskEvent, "ts" | "taskId">) {
	const full: TaskEvent = { ts: Date.now(), taskId: t.id, ...ev };
	mkdirSync(taskDir(t.id), { recursive: true });
	appendFileSync(join(taskDir(t.id), "events.jsonl"), `${JSON.stringify(full)}\n`);
	return full;
}

function update(t: Task, patch: Partial<Task>, ev?: Omit<TaskEvent, "ts" | "taskId">) {
	const prev = t.status;
	watchdog?.beforeUpdate(t, patch, ev);
	Object.assign(t, patch, { updatedAt: Date.now(), rev: (t.rev ?? 0) + 1 });
	if (patch.status && patch.status !== prev) {
		t.statusSince = t.updatedAt;
		// A new status is new attention: an old snooze no longer applies.
		t.snoozedUntil = t.snoozedAt = undefined;
		if (!patch.ask) t.ask = undefined;
	}
	if (patch.status && patch.status !== prev && !("progress" in patch)) {
		// Progress follows the run: a finished plan is complete; a new run after done/cancel starts a fresh one.
		if (patch.status === "done") t.progress = finishProgress(t.progress, t.updatedAt);
		else if (ACTIVE_STATUSES.includes(patch.status) && (prev === "done" || prev === "cancelled") && t.progress) t.progress = restartProgress(t.updatedAt);
	}
	if (patch.status && patch.status !== prev && ATTENTION_STATUSES.includes(patch.status)) t.unread = true;
	if (patch.status && ACTIVE_STATUSES.includes(patch.status)) {
		t.unread = false;
		t.ask = undefined;
	}
	// Silent scheduled jobs: a successful run is archived right away instead of waiting in 待扫.
	if (patch.status === "done" && t.source?.kind === "cron" && t.source.silent) t.unread = false;
	saveTask(t);
	const full = ev ? recordEvent(t, ev) : undefined;
	broadcast({ type: "task", task: t, event: full });
	mesh.flood("task", { task: t, event: full });
	return t;
}

const INTAKE_RETENTION_MS = intakeRetentionMs(cfg);
/** Consumed comments are only kept for a short while (debugging); pending ones until a front agent claims them. */
function intakeExpired(i: Intake, now = Date.now()) {
	if (i.status === "pending") return false;
	return now - (i.consumedAt ?? i.createdAt) > INTAKE_RETENTION_MS;
}
/** Before deleting an intake directory: copy files that local tasks still reference into those tasks. */
function rescueIntakeFiles(dir: string) {
	const prefix = `${resolve(dir)}/`;
	for (const t of tasks.values()) {
		const refs = t.attachments.filter((a) => resolve(a).startsWith(prefix) && existsSync(a));
		if (!refs.length) continue;
		const moved = writeFiles(join(taskDir(t.id), "attachments", basename(dir)), readFiles(refs));
		t.attachments = t.attachments.map((a) => moved.get(a) ?? a);
		for (const [from, to] of moved) t.brief = t.brief.split(from).join(to);
		saveTask(t);
	}
}
function pruneIntakes() {
	const now = Date.now();
	for (const i of [...intakes.values()]) {
		if (!intakeExpired(i, now)) continue;
		intakes.delete(i.id);
		const dir = join(paths.intake, i.id);
		try {
			rescueIntakeFiles(dir);
			rmSync(dir, { recursive: true, force: true });
		} catch (e) {
			log(`[intake] prune ${i.id} failed: ${(e as Error).message}`);
		}
	}
	for (const i of [...mirrorIntakes.values()]) if (intakeExpired(i, now)) mirrorIntakes.delete(i.id);
	// Local copies of remote intakes (screenshots fetched on claim) and leftovers without an owner here.
	for (const id of safeReaddir(paths.intake)) {
		if (intakes.has(id)) continue;
		const dir = join(paths.intake, id);
		try {
			if (now - statSync(dir).mtimeMs <= INTAKE_RETENTION_MS) continue;
			if (mirrorIntakes.get(id)?.status === "pending") continue;
			rescueIntakeFiles(dir);
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

function updateIntake(i: Intake, patch: Partial<Intake>) {
	Object.assign(i, patch, { rev: (i.rev ?? 0) + 1 });
	saveIntake(i);
	broadcast({ type: "intake", intake: i });
	mesh.flood("intake", { intake: i });
	return i;
}

function ownTask(id: string) {
	const t = tasks.get(id);
	if (!t) throw new HttpError(404, `no such task on ${SELF}: ${id}`);
	return t;
}

// ---------------------------------------------------------------- tmux

async function tmux(...args: string[]) {
	return run("tmux", args, { env: process.env });
}

async function ensureTmuxSession() {
	try {
		await tmux("has-session", "-t", `=${cfg.tmuxSession}`);
	} catch {
		await tmux("new-session", "-d", "-s", cfg.tmuxSession, "-n", "hub", "-c", cfg.defaultCwd);
	}
	await tmux("set", "-g", "extended-keys", "on").catch(() => {});
}

async function liveWindows(): Promise<Set<string>> {
	try {
		const { stdout } = await tmux("list-windows", "-t", `=${cfg.tmuxSession}`, "-F", "#{window_name}");
		return new Set(stdout.split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}

function sh(s: string) {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Spawn (or resume) the worker pi process for a task in its own tmux window. */
async function spawnWorker(t: Task, opts: { resumeMessage?: string; model?: string; idle?: boolean; status?: TaskStatus } = {}) {
	await ensureTmuxSession();
	const dir = taskDir(t.id);
	const briefPath = join(dir, "brief.md");
	const model = opts.model ?? cfg.workerModel ?? cfg.model;
	// The quick-agent pi package is installed globally; QA_TASK_ID selects the worker role.
	const piArgs = ["--model", model];
	let initial: string[];
	if ((opts.resumeMessage || opts.idle) && t.sessionFile && existsSync(t.sessionFile)) {
		piArgs.push("--session", t.sessionFile);
		initial = opts.resumeMessage ? [opts.resumeMessage] : [];
	} else {
		piArgs.push("--name", `[${t.id}] ${t.title}`);
		initial = [`@${briefPath}`, "以上是你负责的任务简报（quick-agent task brief）。请完整负责并完成它。"];
	}
	const script = [
		"#!/usr/bin/env bash",
		`export PATH=${sh(process.env.PATH ?? "")}`,
		`export QA_TASK_ID=${sh(t.id)}`,
		`export QA_HOME=${sh(paths.home)}`,
		...(process.env.PI_CODING_AGENT_DIR ? [`export PI_CODING_AGENT_DIR=${sh(process.env.PI_CODING_AGENT_DIR)}`] : []),
		"export NODE_NO_WARNINGS=1",
		`cd ${sh(t.cwd)} || exit 1`,
		`pi ${[...piArgs, ...initial].map(sh).join(" ")}`,
		"code=$?",
		`if [ $code -ne 0 ]; then echo; echo "[quick-agent] pi exited with code $code. Press Enter to close."; read -r; fi`,
		"",
	].join("\n");
	const scriptPath = join(dir, "run.sh");
	writeFileSync(scriptPath, script, { mode: 0o755 });
	const target = `${cfg.tmuxSession}:${t.id}`;
	await tmux("new-window", "-d", "-t", `${cfg.tmuxSession}:`, "-n", t.id, "-c", t.cwd, `bash ${sh(scriptPath)}`);
	await tmux("set-window-option", "-t", target, "automatic-rename", "off").catch(() => {});
	const status = opts.status ?? "starting";
	update(t, { status, tmuxTarget: target, closed: false, activity: opts.idle ? "已恢复，等待指令" : "启动中" }, { kind: "status", status, text: opts.resumeMessage || opts.idle ? "resumed" : "spawned" });
}

// ---------------------------------------------------------------- methods (local implementations, callable over the mesh)

type FileBlob = { name: string; data: string };

function readFiles(list: string[]): FileBlob[] {
	let total = 0;
	const out: FileBlob[] = [];
	for (const f of list) {
		try {
			if (!statSync(f).isFile()) continue;
			const buf = readFileSync(f);
			total += buf.length;
			if (total > MAX_TRANSFER) throw new HttpError(413, `attachments exceed ${MAX_TRANSFER / 1048576} MB`);
			out.push({ name: f, data: buf.toString("base64") });
		} catch (e) {
			if (e instanceof HttpError) throw e;
		}
	}
	return out;
}

const inIntakeDir = (f: string) => resolve(f).startsWith(`${resolve(paths.intake)}/`);

/** Message to an existing task with files (screenshots of a browser comment): store them with the task, rewrite paths. */
function adoptFiles(t: Task, text: string, files: FileBlob[] | undefined, intakeId?: string): string {
	if (!files?.length) return text;
	const sub = String(intakeId ?? `m${t.messages + 1}`).replace(/[^\w-]/g, "_");
	const moved = writeFiles(join(taskDir(t.id), "attachments", sub), files);
	for (const [from, to] of moved) {
		text = text.split(from).join(to);
		if (!t.attachments.includes(to)) t.attachments.push(to);
	}
	saveTask(t);
	return text;
}

/** Write transferred files into dir; returns original path → new path. */
function writeFiles(dir: string, files: FileBlob[] | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!files?.length) return map;
	mkdirSync(dir, { recursive: true });
	for (const [n, f] of files.entries()) {
		const target = join(dir, `${n}-${basename(f.name).replace(/[^\w.-]/g, "_")}`);
		writeFileSync(target, Buffer.from(f.data, "base64"));
		map.set(f.name, target);
	}
	return map;
}

async function createTaskLocal(body: any): Promise<Task> {
	const title = String(body.title ?? "").trim() || "untitled";
	let brief = String(body.brief ?? "").trim();
	if (!brief) throw new HttpError(400, "brief is required");
	let cwd = String(body.cwd ?? "").trim();
	const explicitProject = typeof body.project === "string" && body.project.trim() ? body.project.trim() : undefined;
	if (!cwd) {
		const p = matchProject(cfg, body.source?.url);
		const proj = explicitProject ? projects.find(explicitProject) : projects.find(projects.classifyUrl(body.source?.url) ?? "");
		cwd = p && (!p.machine || p.machine === SELF) ? p.cwd : (projectDir(proj, SELF) ?? cfg.defaultCwd);
	}
	if (!existsSync(cwd)) throw new HttpError(400, `cwd does not exist on ${SELF}: ${cwd}`);
	const id = newId("t", (x) => tasks.has(x) || mirrorTasks.has(x));
	let attachments: string[] = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
	// Files shipped from another machine: store them with the task and rewrite references.
	const moved = writeFiles(join(taskDir(id), "attachments"), body.files);
	if (moved.size) {
		attachments = attachments.map((a) => moved.get(a) ?? a);
		for (const [from, to] of moved) brief = brief.split(from).join(to);
	}
	const t: Task = {
		id,
		machine: SELF,
		rev: 0,
		title,
		brief,
		cwd,
		status: "starting",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		source: body.source ?? { kind: "api" },
		attachments,
		unread: false,
		messages: 0,
		owner: typeof body.owner === "string" ? body.owner : undefined,
		...team.newTaskPeople(body),
	};
	watchdog.onCreate(t, body);
	try {
		Object.assign(t, projects.classifyOwn(t, explicitProject));
	} catch (e) {
		log(`[projects] classify ${id} failed: ${(e as Error).message}`);
	}
	tasks.set(id, t);
	mkdirSync(taskDir(id), { recursive: true });
	const briefDoc = [
		`# 任务 ${id}: ${title}`,
		"",
		`- 机器: ${SELF}`,
		`- 工作目录: ${cwd}`,
		t.project ? `- 项目: ${projects.get(t.project)?.name ?? t.project}` : "",
		`- 来源: ${t.source.kind}${t.source.url ? ` (${t.source.url})` : ""}`,
		t.expect ? `- 预期用时: ${fmtMinutes(t.expect.minutes)}（${EXPECT_SOURCE_LABEL[t.expect.source]}；可以用 qa_expect 带理由修正一次）` : "",
		attachments.length ? `- 附件:\n${attachments.map((a) => `  - ${a}`).join("\n")}` : "",
		...team.briefLines(t),
		"",
		"## 任务简报",
		"",
		brief,
		"",
	].join("\n");
	writeFileSync(join(taskDir(id), "brief.md"), briefDoc);
	saveTask(t);
	recordEvent(t, { kind: "created", text: title });
	try {
		await spawnWorker(t, { model: body.model });
	} catch (err) {
		update(t, { status: "failed", summary: `spawn failed: ${(err as Error).message}` }, { kind: "status", status: "failed", text: (err as Error).message });
	}
	return t;
}

/** A scheduled run that could not be dispatched: keep a failed task here so it reaches 需要你. */
function recordFailedTask(body: any, reason: string): Task {
	const id = newId("t", (x) => tasks.has(x) || mirrorTasks.has(x));
	const t: Task = {
		id,
		machine: SELF,
		rev: 0,
		title: String(body.title ?? "untitled"),
		brief: String(body.brief ?? ""),
		cwd: String(body.cwd || cfg.defaultCwd),
		status: "failed",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		source: body.source ?? { kind: "api" },
		attachments: [],
		unread: true,
		messages: 0,
		summary: `派单失败：${reason}\n\n（定时计划 ${body.source?.cronId ?? ""} 到点后没能派出任务；检查机器/资源/目录后可以用 quick cron run ${body.source?.cronId ?? "<id>"} 重试）`,
	};
	tasks.set(id, t);
	mkdirSync(taskDir(id), { recursive: true });
	writeFileSync(join(taskDir(id), "brief.md"), `# 任务 ${id}: ${t.title}\n\n${t.brief}\n`);
	saveTask(t);
	recordEvent(t, { kind: "created", text: t.title });
	return update(t, {}, { kind: "status", status: "failed", text: reason });
}

async function deliverMessage(t: Task, text: string, opts?: { watchdog?: boolean }) {
	if (handoff.interceptMessage(t, text)) return;
	// A human message answers an open watchdog escalation (with its context) and resets the correction count.
	if (!opts?.watchdog) text = watchdog.onHumanMessage(t, text);
	if (t.pendingNote) {
		text = `${t.pendingNote}\n\n---\n${text}`;
		t.pendingNote = undefined;
	}
	t.messages += 1;
	if (workerConnected(t.id)) {
		broadcast({ type: "task.message", taskId: t.id, text, ts: Date.now() }, (c) => c.taskId === t.id);
		update(t, { status: "running", activity: "收到追加指令" }, { kind: "message", text });
		return;
	}
	const live = await liveWindows();
	if (live.has(t.id)) {
		// Window alive but worker not (yet) connected: queue for when it subscribes.
		pendingMessages.set(t.id, [...(pendingMessages.get(t.id) ?? []), text]);
		update(t, {}, { kind: "message", text: `${text} (queued)` });
		return;
	}
	// Window gone: resume the worker session with this message.
	recordEvent(t, { kind: "message", text });
	await spawnWorker(t, { resumeMessage: text });
}

function resolvePath(p: unknown): string {
	const s = String(p ?? "").trim();
	if (!s) throw new HttpError(400, "path is required");
	return resolve(s.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

/** Persist resources/priority/description of this machine and re-announce it in the mesh (no restart needed). */
function configureMachine(p: any, from: string): MachineInfo {
	saveConfigPatch((raw) => {
		raw.machine = { ...(raw.machine ?? {}), id: raw.machine?.id ?? SELF };
		if (Array.isArray(p.resources)) raw.machine.resources = p.resources.map(String).map((x: string) => x.trim()).filter(Boolean);
		if (p.resources === null) delete raw.machine.resources;
		raw.machine.resources = applyResourceEdits(raw.machine.resources, p.addResources, p.removeResources);
		if (!raw.machine.resources) delete raw.machine.resources;
		if (typeof p.resourceNotes === "string") raw.machine.resourceNotes = p.resourceNotes;
		if (p.resourceNotes === null) delete raw.machine.resourceNotes;
		if (typeof p.description === "string") raw.machine.description = p.description;
		if (typeof p.owner === "string" && p.owner) {
			if (!team.member(p.owner)) throw new HttpError(400, `no such team member: ${p.owner} (quick team ls)`);
			raw.machine.owner = p.owner;
		}
		if (p.owner === null || p.owner === "") delete raw.machine.owner;
		if (p.priority === null) delete raw.machine.priority;
		else if (p.priority !== undefined) {
			const n = Number(p.priority);
			if (!Number.isFinite(n)) throw new HttpError(400, `invalid priority: ${p.priority}`);
			raw.machine.priority = n;
		}
	});
	const fresh = loadConfig().machine;
	cfg.machine = { ...fresh, id: SELF };
	detected = detectResources();
	log(`[machine] config updated by ${from}: priority ${cfg.machine.priority ?? "-"}, resources ${machineInfo().resources?.join(",")}`);
	mesh.advertise(true);
	broadcast({ type: "machines", machines: mesh.machines() });
	return machineInfo();
}

// ---------------------------------------------------------------- worker default model (config.json workerModel)

const MODEL_LIST_TTL_MS = 60_000;
let modelList: { at: number; models: PiModel[] } | undefined;
let modelListing: Promise<PiModel[]> | undefined;
/** Models of this machine's pi (cached for a minute; `refresh` forces a new `pi --list-models`). */
async function piModels(refresh = false): Promise<PiModel[]> {
	if (!refresh && modelList && Date.now() - modelList.at < MODEL_LIST_TTL_MS) return modelList.models;
	modelListing ??= listPiModels().then(
		(models) => {
			modelList = { at: Date.now(), models };
			return models;
		},
		(e) => {
			modelList = undefined;
			throw e;
		},
	).finally(() => (modelListing = undefined));
	return modelListing;
}

/** Current worker model of this machine: raw setting, inherited value, effective model and the model list. */
async function workerModelInfo(refresh = false) {
	let models: PiModel[] = [];
	let listError: string | undefined;
	try {
		models = await piModels(refresh);
	} catch (e) {
		listError = (e as Error).message;
	}
	const effective = cfg.workerModel ?? cfg.model;
	const known = (spec: string) => checkModelSpec(spec, models).ok;
	return {
		machine: SELF,
		workerModel: cfg.workerModel ?? null,
		model: cfg.model,
		frontModel: cfg.frontModel ?? null,
		effective,
		source: cfg.workerModel ? "workerModel" : "model",
		/** Does the effective model exist in this machine's pi? (undefined when the list failed) */
		effectiveKnown: listError ? undefined : known(effective),
		models: models.map((m) => ({ provider: m.provider, id: m.id, thinking: m.thinking })),
		listError,
		listedAt: modelList?.at,
	};
}

/** Set (string) or clear (null / "") this machine's worker default model; validated, persisted, live for new workers. */
async function setWorkerModel(spec: unknown, from: string) {
	let value: string | undefined;
	if (spec !== null && spec !== undefined && spec !== "") {
		let models: PiModel[];
		try {
			models = await piModels(true);
		} catch (e) {
			throw new HttpError(502, `${SELF}: 无法校验模型，未保存：${(e as Error).message}`);
		}
		const r = checkModelSpec(spec, models);
		if (!r.ok) throw new HttpError(400, `${SELF}: ${r.error}，未保存`);
		value = r.model;
	}
	saveConfigPatch((raw) => {
		if (value) raw.workerModel = value;
		else delete raw.workerModel;
	});
	const saved = loadConfig().workerModel;
	if (saved !== value) throw new HttpError(500, `${SELF}: 写入 config.json 后读回的是 ${saved ?? "(未设置)"}，与 ${value ?? "(未设置)"} 不一致`);
	const before = cfg.workerModel;
	cfg.workerModel = value;
	log(`[worker-model] ${before ?? "(inherit)"} -> ${value ?? `(inherit ${cfg.model})`} by ${from}`);
	const info = await workerModelInfo();
	broadcast({ type: "workerModel", info: { ...info, models: undefined } });
	return info;
}

const methods: Record<string, (p: any, from: string) => Promise<any>> = {
	"workerModel.info": async (p) => workerModelInfo(!!p.refresh),
	"workerModel.set": async (p, from) => setWorkerModel(p.model, from),
	"machine.info": async () => machineInfo(),
	"machine.configure": async (p, from) => configureMachine(p, from),

	// Upgrade this machine synchronously (`quick upgrade --all` / `--machine`); the hub reloads itself afterwards.
	"update.run": async (p, from) => {
		log(`[update] upgrade requested by ${from}${p.check ? " (check only)" : ""}`);
		if (jobActive()) throw new Error(`已有升级在进行中（${job!.step}）`);
		const r = await runUpgrade({ check: !!p.check, machine: SELF });
		if (r.installed) {
			log(`[update] upgraded ${r.from} → ${r.to} (${r.kind})`);
			broadcast({ type: "update", machine: SELF, from: r.from, to: r.to, ts: Date.now() });
			r.note = restartNote();
			setTimeout(scheduleRestart, 1500);
		}
		return r;
	},
	// Web UI: version / latest release / job progress, and the asynchronous upgrade button.
	"update.status": async (p) => localUpdateStatus(!!p.refresh),
	"update.start": async (p, from) => {
		startJob(p.action === "rollback" ? "rollback" : "install", from);
		return localUpdateStatus();
	},

	"task.create": async (p) => createTaskLocal(p),
	"task.attachment": async (p) => {
		const t = ownTask(p.id);
		const f = t.attachments[Number(p.n) || 0];
		if (!f || !existsSync(f) || !statSync(f).isFile()) throw new HttpError(404, "no such attachment");
		const [blob] = readFiles([f]);
		if (!blob) throw new HttpError(404, "no such attachment");
		return blob;
	},
	"task.get": async (p) => ({ task: ownTask(p.id), events: readEvents(p.id, Math.min(Number(p.events ?? 30) || 30, 500)), comments: team.readComments(p.id, Math.min(Number(p.comments ?? 50) || 50, 500)) }),
	"task.message": async (p) => {
		const t = ownTask(p.id);
		const text = String(p.text ?? "").trim();
		if (!text) throw new HttpError(400, "text is required");
		const touched = team.touched(t, p.viewer?.user);
		if (touched.pings !== t.pings) Object.assign(t, touched);
		await deliverMessage(t, adoptFiles(t, text, p.files, p.intakeId));
		return t;
	},
	"task.cancel": async (p) => {
		const t = ownTask(p.id);
		if (handoff.busy(t.id)) throw new HttpError(409, `task ${t.id} is being handed off`);
		broadcast({ type: "task.cancel", taskId: t.id, ts: Date.now() }, (c) => c.taskId === t.id);
		if (!workerConnected(t.id) && t.tmuxTarget) await tmux("send-keys", "-t", t.tmuxTarget, "Escape").catch(() => {});
		return update(t, { status: "cancelled", activity: undefined }, { kind: "cancel" });
	},
	"task.close": async (p) => {
		const t = ownTask(p.id);
		if (handoff.busy(t.id)) throw new HttpError(409, `task ${t.id} is being handed off`);
		if (t.tmuxTarget) await tmux("kill-window", "-t", t.tmuxTarget).catch(() => {});
		return update(t, { closed: true, unread: false, ...(ACTIVE_STATUSES.includes(t.status) ? { status: "cancelled" as TaskStatus } : {}) }, { kind: "close", text: "closed by user" });
	},
	"task.ack": async (p) => {
		// Per person (shared/team.ts): clears the person's pings; only the holder's ack marks the task read
		// (and settles it in the attention model: archived, snooze cleared).
		const t = ownTask(p.id);
		const r = team.ack(t, p.viewer);
		const settle = r.holder ? { unread: false, ackedAt: Date.now(), snoozedUntil: undefined, snoozedAt: undefined, ...watchdog.onAck(t) } : {};
		return update(t, { ...r.patch, ...settle }, { kind: "ack", ...(p.viewer?.user ? { by: p.viewer.user } : {}) });
	},
	// 稍后提醒: minutes > 0 hides the task from need/skim until then; 0 / null brings it back now.
	"task.snooze": async (p) => {
		const t = ownTask(p.id);
		const minutes = p.minutes === null || p.minutes === undefined ? 60 : Number(p.minutes);
		if (!Number.isFinite(minutes) || minutes < 0) throw new HttpError(400, `invalid minutes: ${p.minutes}`);
		const until = minutes > 0 ? Date.now() + minutes * 60_000 : undefined;
		return update(t, { snoozedUntil: until, snoozedAt: until ? Date.now() : undefined }, { kind: "snooze", text: until ? `snoozed ${minutes} min` : "unsnoozed", ...(p.viewer?.user ? { by: p.viewer.user } : {}) });
	},
	"task.retry": async (p) => {
		const t = ownTask(p.id);
		await deliverMessage(t, String(p.text ?? "").trim() || "上一轮没有成功结束。请检查当时的状态和报错，从中断处继续，把任务做完；如果仍然无法继续，用 qa_report 说明原因。");
		return t;
	},
	"task.transcript": async (p) => {
		const t = ownTask(p.id);
		const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
		return { ...readTranscript(t.sessionFile, { after: num(p.after), before: num(p.before), limit: num(p.limit), full: num(p.full) }), status: t.status, machine: t.machine };
	},
	"task.project": async (p) => projects.move(ownTask(p.id), p.project),
	"task.screen": async (p) => {
		const t = ownTask(p.id);
		if (!t.tmuxTarget || t.closed) return { alive: false, text: "" };
		try {
			const { stdout } = await tmux("capture-pane", "-p", "-J", "-t", t.tmuxTarget);
			return { alive: true, text: stdout.replace(/\s+$/, "") };
		} catch {
			return { alive: false, text: "" };
		}
	},

	"intake.claim": async (p) => {
		const i = intakes.get(p.id);
		if (!i) throw new HttpError(404, `no such intake on ${SELF}: ${p.id}`);
		if (i.status !== "pending") throw new HttpError(409, `intake already ${i.status}`);
		// Delivered and claimed = consumed: it is never handed to a front agent again.
		updateIntake(i, { status: "consumed", consumedAt: Date.now(), claimedBy: String(p.by ?? "front") });
		return { intake: i, files: p.withFiles ? readFiles(i.screenshots) : [] };
	},
	"intake.update": async (p) => {
		const i = intakes.get(p.id);
		if (!i) throw new HttpError(404, `no such intake on ${SELF}: ${p.id}`);
		const patch: Partial<Intake> = {};
		if (p.status) {
			if (!["consumed", "dispatched", "dismissed"].includes(p.status)) throw new HttpError(400, `invalid intake status: ${p.status}`);
			patch.status = p.status;
			// A consumed comment never goes back to pending (it would be delivered again).
			if (i.status === "pending") patch.consumedAt = Date.now();
		}
		if (p.taskId) patch.taskId = p.taskId;
		return updateIntake(i, patch);
	},

	// Read-only file system access for front agents assembling context on other machines.
	"fs.ls": async (p) => {
		const dir = resolvePath(p.path);
		const entries = readdirSync(dir, { withFileTypes: true })
			.filter((e) => p.all || !e.name.startsWith("."))
			.slice(0, 500)
			.map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
			.sort();
		return { path: dir, entries };
	},
	"fs.read": async (p) => {
		const f = resolvePath(p.path);
		const st = statSync(f);
		if (!st.isFile()) throw new HttpError(400, `not a file: ${f}`);
		const lines = readFileSync(f, "utf8").split("\n");
		const offset = Math.max(1, Number(p.offset ?? 1) || 1);
		const limit = Math.min(Math.max(1, Number(p.limit ?? 400) || 400), 2000);
		let text = lines.slice(offset - 1, offset - 1 + limit).join("\n");
		if (text.length > 100_000) text = `${text.slice(0, 100_000)}\n…(truncated)`;
		return { path: f, totalLines: lines.length, offset, text };
	},
	"fs.grep": async (p) => {
		const dir = resolvePath(p.path);
		const pattern = String(p.pattern ?? "");
		if (!pattern) throw new HttpError(400, "pattern is required");
		try {
			const { stdout } = await run("grep", ["-rnIE", "--max-count=5", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist", "-e", pattern, dir], {
				timeout: 15_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			return { text: stdout.slice(0, 60_000) };
		} catch (e: any) {
			if (e.code === 1) return { text: "" };
			return { text: String(e.stdout ?? "").slice(0, 60_000), error: e.message };
		}
	},
};

const handoff = createHandoff({
	self: SELF,
	log,
	tasks,
	mirrorTasks,
	taskDir,
	saveTask,
	update,
	recordEvent,
	broadcast,
	spawnWorker,
	call,
	reachable: (m) => mesh.reachable(m),
	workerConnected,
	liveWindows,
	tmux,
	deliverMessage,
	projects: () => cfg.projects.filter((p) => !p.machine || p.machine === SELF),
	httpError: (status, msg) => new HttpError(status, msg),
});
Object.assign(methods, handoff.methods);

const team = createTeam({
	file: paths.team,
	log,
	flood: (kind, data) => mesh.flood(kind, data),
	onChange: () => broadcast({ type: "team", members: team.roster(), ts: Date.now() }),
	rootToken: () => cfg.token,
	machineOwner: () => cfg.machine.owner,
	ownTask,
	taskDir,
	update,
	deliverMessage,
	httpError: (status, msg) => new HttpError(status, msg),
});
Object.assign(methods, team.methods);
const cron = createCron({
	self: SELF,
	file: paths.cron,
	log,
	findTask: (id) => tasks.get(id) ?? mirrorTasks.get(id),
	dispatch: (body) => apiCreateTask(body),
	recordFailed: recordFailedTask,
	broadcast,
	flood: (kind, data) => mesh.flood(kind, data),
	call,
	reachable: (m) => mesh.reachable(m),
	httpError: (status, msg) => new HttpError(status, msg),
});
Object.assign(methods, cron.methods);
const watchdog = createWatchdog({
	tasks,
	config: () => cfg.watchdog,
	defaultModel: () => cfg.workerModel ?? cfg.model,
	taskDir,
	update,
	deliverMessage: (t, text, opts) => deliverMessage(t, text, opts),
	log,
	httpError: (status, msg) => new HttpError(status, msg),
});
Object.assign(methods, watchdog.methods);

// ---------------------------------------------------------------- global (mesh-wide) views

function findTask(id: string): Task {
	const t = tasks.get(id) ?? mirrorTasks.get(id);
	if (!t) throw new HttpError(404, `no such task: ${id}`);
	return t;
}
function findIntake(id: string): Intake {
	const i = intakes.get(id) ?? mirrorIntakes.get(id);
	if (!i) throw new HttpError(404, `no such intake: ${id}`);
	return i;
}
function allTasks() {
	return [...tasks.values(), ...mirrorTasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => projects.view(t));
}
function allIntakes() {
	return [...intakes.values(), ...mirrorIntakes.values()];
}

/** Choose the machine for a dispatch: explicit machine, URL project pin, or resources + priority (see shared/schedule.ts). */
async function chooseMachine(body: any): Promise<string> {
	let machine = String(body.machine ?? "").trim();
	const requires = normalizeRequires(body.requires);
	const cwd = String(body.cwd ?? "").trim();
	const url = body.source?.url;
	if (!machine && !cwd && url) {
		const p = matchProject(cfg, url);
		if (p) machine = p.machine ?? SELF;
		else machine = mesh.machines().find((m) => !m.self && m.online && m.projects?.some((r) => matchProject({ projects: [r] } as any, url)))?.id ?? "";
		// A pin that cannot satisfy the requirements falls back to scheduling.
		if (machine && requires.length) {
			try {
				await pickMachineForCwd(mesh.machines(), { machine, requires }, async () => true);
			} catch {
				machine = "";
			}
		}
	}
	if (!machine && !cwd) {
		// A project checked out on some machines: prefer the best of those that satisfy the requirements.
		const proj = body.project ? projects.find(String(body.project)) : projects.find(projects.classifyUrl(url) ?? "");
		if (proj?.dirs.length) {
			try {
				machine = candidateMachines(mesh.machines(), { requires }).find((m) => projectDir(proj, m.id))?.id ?? "";
			} catch {}
		}
	}
	try {
		const m = await pickMachineForCwd(mesh.machines(), { machine: machine || undefined, requires, cwd: cwd || undefined }, async (m, dir) => {
			if (m.self) return existsSync(resolvePath(dir));
			await call(m.id, "fs.ls", { path: dir });
			return true;
		});
		return m.id;
	} catch (e) {
		if (e instanceof ScheduleError) throw new HttpError(400, `${e.message} (see /api/machines)`);
		throw e;
	}
}

async function apiCreateTask(body: any): Promise<Task> {
	const machine = await chooseMachine(body);
	if (!mesh.reachable(machine)) throw new HttpError(400, `machine ${machine} is not reachable (see /api/machines)`);
	const params = { ...body };
	delete params.machine;
	delete params.requires;
	if (!String(body.cwd ?? "").trim() && body.project) {
		const dir = projectDir(projects.find(String(body.project)), machine);
		if (dir) params.cwd = dir;
	}
	if (Array.isArray(body.attachments) && body.attachments.length) {
		// Remote machine: ship every attachment. Here: copy browser-comment screenshots into the task,
		// the intake directory itself is pruned after the retention period.
		const list = body.attachments.map(String);
		const files = machine !== SELF ? list : list.filter(inIntakeDir);
		if (files.length) params.files = readFiles(files);
	}
	const task = await call<Task>(machine, "task.create", params);
	if (task.machine !== SELF) mirrorTasks.set(task.id, task);
	// Mark the originating browser comment as dispatched (on whichever machine owns it).
	if (task.source?.intakeId) {
		const i = intakes.get(task.source.intakeId) ?? mirrorIntakes.get(task.source.intakeId);
		if (i) await call(i.machine, "intake.update", { id: i.id, status: "dispatched", taskId: task.id }).catch((e) => log(`intake.update failed: ${e.message}`));
	}
	return task;
}

/** /api/team…: roster, invites, member management (docs/team-collaboration.md). */
async function apiTeam(m: string, p: string, url: URL, viewer: Viewer, req: IncomingMessage): Promise<any> {
	const owners = () => mesh.machines().filter((x) => x.owner);
	if (p === "/api/team" && m === "GET") {
		return {
			me: viewer.user ? team.member(viewer.user) : undefined,
			root: !!viewer.root,
			members: team.roster().map((x) => ({ ...x, machines: owners().filter((o) => o.owner === x.id).map((o) => o.id) })),
			invites: can(viewer, "team.manage") ? team.listInvites() : undefined,
		};
	}
	if (m !== "POST") throw new HttpError(405, "method not allowed");
	const body = await readJson(req);
	if (p === "/api/team/members") {
		// Bootstrapping: the machine token may create the first owner; afterwards adding people needs owner.
		need(viewer, "team.manage");
		const r = team.addMember(body);
		if (body.machineOwner && viewer.root) {
			saveConfigPatch((raw) => {
				raw.machine = { ...(raw.machine ?? {}), id: raw.machine?.id ?? SELF, owner: r.member.id };
			});
			cfg.machine.owner = r.member.id;
			mesh.advertise(true);
			broadcast({ type: "machines", machines: mesh.machines() });
		}
		return r;
	}
	if (p === "/api/team/invites") {
		need(viewer, "team.manage");
		if (body.revoke) return team.revokeInvite(String(body.revoke));
		return team.createInvite(body, viewer.user ?? "root");
	}
	const mt = /^\/api\/team\/members\/([\w-]+)$/.exec(p);
	if (mt) {
		const id = mt[1]!;
		const self = viewer.user === id;
		if (body.name !== undefined && (self || can(viewer, "team.manage"))) return { member: team.rename(id, body.name) };
		if (body.resetToken && (self || can(viewer, "team.manage"))) return team.resetToken(id);
		need(viewer, "team.manage");
		if (body.remove) return team.remove(id);
		if (body.role) return { member: team.setRole(id, body.role) };
		throw new HttpError(400, "nothing to do (role | name | resetToken | remove)");
	}
	void url;
	throw new HttpError(404, "not found");
}

/** Claim an intake wherever it lives; remote screenshots are copied here so local front agents can read them. */
async function apiClaimIntake(id: string, by: string): Promise<Intake> {
	const i = findIntake(id);
	if (i.machine === SELF) return (await call<{ intake: Intake }>(SELF, "intake.claim", { id, by })).intake;
	const r = await call<{ intake: Intake; files: FileBlob[] }>(i.machine, "intake.claim", { id, by, withFiles: true });
	const moved = writeFiles(join(paths.intake, id), r.files);
	const local: Intake = { ...r.intake, screenshots: r.intake.screenshots.map((s) => moved.get(s) ?? s) };
	mirrorIntakes.set(id, { ...local });
	return local;
}

/** Manual project change: stored by the owning hub; remembered here when that hub is too old to store it. */
async function moveTask(id: string, owner: string, project: unknown): Promise<Task> {
	try {
		const task = await call<Task>(owner, "task.project", { id, project });
		if (task.machine !== SELF) mirrorTasks.set(task.id, task);
		return projects.view(task);
	} catch (e) {
		if (!/unknown method task\.project/.test((e as Error).message) && mesh.reachable(owner)) throw e;
		projects.override(id, project);
		const t = projects.view(findTask(id));
		broadcast({ type: "task", task: t });
		return t;
	}
}

// ---------------------------------------------------------------- intake

function storeDataUrl(dir: string, name: string, dataUrl: string): string | undefined {
	const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(dataUrl);
	if (!m) return undefined;
	const file = join(dir, `${name.replace(/[^\w.-]/g, "_")}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
	writeFileSync(file, Buffer.from(m[2]!, "base64"));
	return file;
}

/** Pin anchor from the extension: selector + relative offset inside that element, document-coordinate fallback. */
function cleanAnchor(a: any): Intake["anchor"] {
	if (!a || typeof a !== "object") return undefined;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	const out: NonNullable<Intake["anchor"]> = {};
	if (typeof a.selector === "string" && a.selector) out.selector = a.selector.slice(0, 1000);
	if (num(a.fx) !== undefined) out.fx = num(a.fx);
	if (num(a.fy) !== undefined) out.fy = num(a.fy);
	if (a.doc && num(a.doc.x) !== undefined && num(a.doc.y) !== undefined) out.doc = { x: a.doc.x, y: a.doc.y };
	return Object.keys(out).length ? out : undefined;
}

function createIntake(body: any): Intake {
	const comment = String(body.comment ?? "").trim();
	if (!comment) throw new HttpError(400, "comment is required");
	const id = newId("c", (x) => intakes.has(x) || mirrorIntakes.has(x));
	const dir = join(paths.intake, id);
	mkdirSync(dir, { recursive: true });
	const screenshots: string[] = [];
	for (const [n, s] of (Array.isArray(body.screenshots) ? body.screenshots : []).entries()) {
		const f = storeDataUrl(dir, s?.name ?? `shot-${n}`, String(s?.dataUrl ?? ""));
		if (f) screenshots.push(f);
	}
	const i: Intake = {
		id,
		machine: SELF,
		rev: 0,
		createdAt: Date.now(),
		status: "pending",
		kind: "browser-comment",
		comment,
		url: body.url,
		title: body.title,
		mode: body.mode,
		elements: Array.isArray(body.elements) ? body.elements.slice(0, 20) : [],
		region: body.region,
		anchor: cleanAnchor(body.anchor),
		viewport: body.viewport,
		screenshots,
		consoleErrors: Array.isArray(body.consoleErrors) ? body.consoleErrors.slice(-30).map(String) : undefined,
		userAgent: body.userAgent,
	};
	intakes.set(id, i);
	updateIntake(i, {});
	return i;
}

// ---------------------------------------------------------------- self-upgrade (GitHub Releases)

let upgradesInFlight = 0;
async function apiUpgrade(body: any): Promise<UpgradeResult[]> {
	upgradesInFlight++;
	try {
		return await upgradeMachines(body);
	} finally {
		upgradesInFlight--;
	}
}
async function upgradeMachines(body: any): Promise<UpgradeResult[]> {
	const check = !!body.check;
	let targets: string[] = Array.isArray(body.machines) ? body.machines.map(String).filter(Boolean) : [];
	if (body.all) targets = mesh.machines().filter((m) => m.online).map((m) => m.id);
	if (!targets.length) targets = [SELF];
	return Promise.all(
		[...new Set(targets)].map(async (machine) => {
			try {
				if (!mesh.reachable(machine)) throw new Error(`machine ${machine} is not reachable`);
				return { ...(await mesh.request<UpgradeResult>(machine, "update.run", { check }, UPGRADE_RPC_TIMEOUT_MS)), machine };
			} catch (e) {
				let msg = (e as Error).message;
				if (/unknown method update\.run/.test(msg)) msg = "对方 hub 版本过旧，不支持远程升级（请在那台机器上手动升级一次）";
				const version = mesh.machines().find((m) => m.id === machine)?.version ?? "?";
				return { machine, ok: false, error: msg, from: version, to: version, installed: false, checkOnly: check, available: false, root: "", kind: "unmanaged" } as UpgradeResult;
			}
		}),
	);
}

/** Asynchronous upgrade started from the UI: progress is polled through GET /api/update. */
interface UpdateJob {
	machine: string;
	action: "install" | "rollback";
	from: string;
	to?: string;
	step: Step;
	received?: number;
	total?: number;
	message?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
}
let job: UpdateJob | undefined = (() => {
	// A job that ended in "restart" was finished by the hub that is starting now.
	const j = readJob<UpdateJob>();
	if (j?.step === "restart") {
		if (j.to && compareVersions(VERSION, j.to) === 0) Object.assign(j, { step: "done", endedAt: Date.now(), message: `已切换到 ${j.to}` });
		else Object.assign(j, { step: "error", endedAt: Date.now(), error: `重启后运行的是 ${VERSION}，不是 ${j.to}` });
		writeJob(j);
	}
	return j && Date.now() - j.startedAt < 3600_000 ? j : undefined;
})();
const jobActive = () => !!job && !["done", "error"].includes(job.step);
let jobBroadcastAt = 0;
function publishJob(force = false) {
	if (!job || (!force && Date.now() - jobBroadcastAt < 300)) return;
	jobBroadcastAt = Date.now();
	writeJob(job);
	broadcast({ type: "update.job", machine: SELF, job: { ...job } });
}

async function localUpdateStatus(refresh = false) {
	const st = await updateStatus({ refresh, machine: SELF });
	return { ...st, running: VERSION, restartPending: compareVersions(st.installed, VERSION) !== 0, hubPid: process.pid, job: job ? { ...job } : undefined };
}

function startJob(action: "install" | "rollback", from: string): UpdateJob {
	if (jobActive()) throw new HttpError(409, `已有升级在进行中（${job!.step}）`);
	job = { machine: SELF, action, from: readVersion(activeRoot()), step: action === "install" ? "check" : "switch", startedAt: Date.now() };
	log(`[update] ${action} requested by ${from}`);
	publishJob(true);
	void runUpgrade({
		rollback: action === "rollback",
		machine: SELF,
		onProgress: (p) => {
			Object.assign(job!, p);
			publishJob(p.step !== "download");
		},
	}).then((r) => {
		const j = job!;
		if (!r.ok) Object.assign(j, { step: "error", error: r.error, endedAt: Date.now() });
		else if (!r.installed) Object.assign(j, { step: "done", to: r.to, message: "已是最新版本", endedAt: Date.now() });
		else {
			j.to = r.to;
			log(`[update] ${action === "rollback" ? "rolled back" : "upgraded"} ${r.from} → ${r.to} (${r.kind})`);
			broadcast({ type: "update", machine: SELF, from: r.from, to: r.to, ts: Date.now() });
			if (cfg.update.restartHub === "never") Object.assign(j, { step: "done", message: `已安装 ${r.to}，运行 quick hub reload 生效`, endedAt: Date.now() });
			else {
				j.step = "restart";
				scheduleRestart();
			}
		}
		publishJob(true);
	});
	return job;
}

let restarting = false;
function restartNote() {
	return cfg.update.restartHub === "never" ? "运行 quick hub reload 生效" : "hub 和 Web UI 服务马上平滑重启（worker 不受影响）";
}
/**
 * Load the new code: `quick hub reload` (from the new version) restarts the hub and the Web UI server.
 * Workers run in tmux and keep running; their hub requests wait for the new hub (hub.restarting marker).
 * Only mesh RPCs still travelling through us delay it (e.g. other machines' upgrade results).
 */
function scheduleRestart(waited = 0) {
	if (restarting || cfg.update.restartHub === "never") return;
	if ((upgradesInFlight > 0 || mesh.busy()) && waited < 60_000) return void setTimeout(() => scheduleRestart(waited + 1000), 1000);
	restarting = true;
	log(`[update] reloading hub to run quick-agent ${readVersion(activeRoot())} (running ${VERSION})`);
	spawnReload();
}
/** Someone else (CLI auto-install, install.sh without restart) switched versions since we started. */
function maybeRestart() {
	const st = readState();
	if (!st.installed || st.installed.at <= STARTED_AT || jobActive()) return;
	if (compareVersions(readVersion(activeRoot()), VERSION) !== 0) scheduleRestart();
}

let announced = "";
function backgroundUpdate() {
	if (!cfg.update.enabled) return;
	void updateStatus({ machine: SELF })
		.then((st) => {
			if (!st.available || !st.latest) return;
			if (announced !== st.latest.version) {
				announced = st.latest.version;
				log(`[update] ${st.installed} → ${st.latest.version} available${st.blocker ? ` (${st.blocker})` : ""}`);
				broadcast({ type: "update.available", machine: SELF, version: st.latest.version, ts: Date.now() });
			}
			if (cfg.update.autoInstall && st.canInstall && !jobActive()) startJob("install", "auto-install");
		})
		.catch((e) => log(`[update] check failed: ${(e as Error).message}`));
}

// Periodically reconcile local tasks whose tmux window disappeared.
async function reconcile() {
	const live = await liveWindows();
	for (const t of tasks.values()) {
		if (t.closed || t.status === "handoff") continue;
		if (!live.has(t.id) && t.tmuxTarget && Date.now() - t.updatedAt > 5000) {
			const patch: Partial<Task> = { closed: true };
			if (ACTIVE_STATUSES.includes(t.status)) patch.status = "exited";
			update(t, patch, { kind: "close", text: "tmux window closed" });
		}
	}
}

// ---------------------------------------------------------------- HTTP

function send(res: ServerResponse, status: number, data: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...cors() });
	res.end(JSON.stringify(data));
}
function cors() {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	};
}
async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += (c as Buffer).length;
		if (size > 40 * 1024 * 1024) throw new HttpError(413, "body too large");
		chunks.push(c as Buffer);
	}
	if (!size) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}
/** Who is calling: the machine token (root / machine owner) or a team member's token; undefined = unauthorized. */
function viewerOf(req: IncomingMessage, url: URL): Viewer | undefined {
	const h = req.headers.authorization;
	const token = h?.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
	return team.identify(token);
}
function need(v: Viewer, action: Parameters<typeof can>[1]) {
	if (!can(v, action)) throw new HttpError(403, `forbidden: ${action} needs the owner role`);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const p = url.pathname;
	const m = req.method ?? "GET";
	if (m === "OPTIONS") {
		res.writeHead(204, cors());
		return res.end();
	}
	if (p === "/health") return send(res, 200, { ok: true, machine: SELF, pid: process.pid, tasks: tasks.size, mesh: mesh.enabled, version: VERSION, startedAt: STARTED_AT });
	if (p === "/" || p === "/dashboard") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(dashboardHtml(cfg.uiPort));
	}
	if (p === "/extension.zip") {
		// Browser extension package (no secrets inside): download, unzip, "Load unpacked".
		const zip = join(paths.home, "quick-agent-extension.zip");
		await run("python3", ["-m", "zipfile", "-c", zip, ...readdirSync(EXTENSION_DIR)
			.filter((f) => /\.(js|json|html|css|png)$/.test(f) && !f.startsWith("."))
			.map((f) => join(EXTENSION_DIR, f))]);
		res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="quick-agent-extension.zip"' });
		return res.end(readFileSync(zip));
	}

	// ---- hub ↔ hub (mesh secret)
	if (p === "/mesh/link" || p === "/mesh/send") {
		if (!mesh.checkSecret(req)) throw new HttpError(401, "bad mesh secret");
		if (p === "/mesh/link" && m === "GET") return mesh.handleLinkRequest(req, res);
		if (p === "/mesh/send" && m === "POST") {
			const body = await readJson(req);
			mesh.handleSend(String(req.headers["x-qa-machine"] ?? ""), Array.isArray(body.frames) ? body.frames : []);
			return send(res, 200, { ok: true });
		}
		throw new HttpError(405, "method not allowed");
	}

	// ---- joining the team: the invite code is the credential
	if (p === "/api/team/join" && m === "POST") return send(res, 200, team.join(await readJson(req)));

	// ---- local clients (machine token) and team members (user tokens)
	const viewer = viewerOf(req, url);
	if (!viewer) throw new HttpError(401, "unauthorized");

	if (p === "/api/events" && m === "GET") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...cors() });
		const client: SseClient = { res, taskId: url.searchParams.get("task") ?? undefined, role: url.searchParams.get("role") ?? "client", viewer, front: url.searchParams.get("front") ?? undefined };
		clients.add(client);
		if (!client.taskId) attention.watch(viewer);
		res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now() })}\n\n`);
		const ping = setInterval(() => res.write(": ping\n\n"), 15000);
		req.on("close", () => {
			clearInterval(ping);
			clients.delete(client);
		});
		if (client.taskId) {
			const queued = pendingMessages.get(client.taskId);
			if (queued?.length) {
				pendingMessages.delete(client.taskId);
				for (const text of queued) res.write(`data: ${JSON.stringify({ type: "task.message", taskId: client.taskId, text, ts: Date.now() })}\n\n`);
			}
		}
		return;
	}

	if (p === "/api/upgrade" && m === "POST") {
		need(viewer, "upgrade");
		return send(res, 200, { results: await apiUpgrade(await readJson(req)) });
	}
	if (p === "/api/me" && m === "GET") return send(res, 200, { me: viewer.user ? team.member(viewer.user) : undefined, viewer, machine: SELF });
	if (p.startsWith("/api/team")) return send(res, 200, await apiTeam(m, p, url, viewer, req));
	if (p === "/api/update" && m === "GET") {
		const refresh = url.searchParams.get("refresh") === "1";
		if (url.searchParams.get("all") === "1") {
			const list = mesh.machines().filter((x) => x.online || x.self);
			const machines = await Promise.all(
				list.map((x) =>
					call(x.id, "update.status", { refresh }, 20_000)
						.then((st) => ({ ...st, machine: x.id, self: x.id === SELF }))
						.catch((e) => ({ machine: x.id, self: x.id === SELF, running: x.version, error: /unknown method/.test(e.message) ? "对方 hub 版本过旧，需要在那台机器上手动升级一次" : e.message })),
				),
			);
			return send(res, 200, { self: SELF, machines });
		}
		const machine = url.searchParams.get("machine") || SELF;
		return send(res, 200, { ...(await call(machine, "update.status", { refresh }, 20_000)), machine, self: machine === SELF });
	}
	if (p === "/api/update" && m === "POST") {
		need(viewer, "upgrade");
		const body = await readJson(req);
		const machine = String(body.machine || SELF);
		if (!mesh.reachable(machine)) throw new HttpError(400, `machine ${machine} is not reachable`);
		return send(res, 200, { ...(await call(machine, "update.start", { action: body.action }, 20_000)), machine, self: machine === SELF });
	}
	if (p === "/api/worker-model" && m === "GET") {
		// Worker default model of this / another / every machine (Web UI settings, `quick worker-model`).
		const refresh = url.searchParams.get("refresh") === "1";
		const one = (id: string) =>
			call(id, "workerModel.info", { refresh }, 60_000)
				.then((r) => ({ ...r, machine: id, self: id === SELF }))
				.catch((e) => ({ machine: id, self: id === SELF, error: /unknown method/.test(e.message) ? "对方 hub 版本过旧，不支持远程设置 worker 模型（需先升级那台机器）" : e.message }));
		if (url.searchParams.get("all") === "1") {
			const list = mesh.machines().filter((x) => x.online || x.self);
			return send(res, 200, { self: SELF, canEdit: can(viewer, "machine.configure"), machines: await Promise.all(list.map((x) => one(x.id))) });
		}
		const machine = url.searchParams.get("machine") || SELF;
		if (!mesh.reachable(machine)) throw new HttpError(400, `machine ${machine} is not reachable (see /api/machines)`);
		return send(res, 200, { ...(await one(machine)), canEdit: can(viewer, "machine.configure") });
	}
	if (p === "/api/worker-model" && m === "POST") {
		// body: { model: "provider/id[:thinking]" | null, machine?: id, machines?: id[] | "all" }. Each machine validates against its own pi.
		need(viewer, "machine.configure");
		const body = await readJson(req);
		if (!("model" in body)) throw new HttpError(400, "body.model is required (null clears the setting)");
		const targets: string[] = body.machines === "all" ? mesh.machines().filter((x) => x.online || x.self).map((x) => x.id) : Array.isArray(body.machines) ? body.machines.map(String) : [String(body.machine || SELF)];
		if (!targets.length) throw new HttpError(400, "no target machine");
		const results = await Promise.all(
			targets.map(async (id) => {
				if (!mesh.reachable(id)) return { machine: id, ok: false, error: `machine ${id} is not reachable` };
				try {
					return { machine: id, ok: true, info: await call(id, "workerModel.set", { model: body.model ?? null }, 60_000) };
				} catch (e) {
					const msg = (e as Error).message;
					return { machine: id, ok: false, status: (e as any).status, error: /unknown method/.test(msg) ? `${id}: 对方 hub 版本过旧，不支持远程设置 worker 模型` : msg };
				}
			}),
		);
		const failed = results.filter((r) => !r.ok);
		const status = !failed.length ? 200 : failed.length === results.length ? ((failed.length === 1 && (failed[0] as any).status) || 400) : 207;
		return send(res, status, { ok: !failed.length, results, ...(failed.length ? { error: failed.map((r) => r.error).join("；") } : {}) });
	}
	if (p === "/api/machines" && m === "GET") return send(res, 200, { self: SELF, machines: mesh.machines(), links: mesh.linkStatus() });
	if (p === "/api/machine" && m === "POST") {
		// Configure resources/priority of this or another machine (`quick machine set`).
		need(viewer, "machine.configure");
		const body = await readJson(req);
		const target = String(body.machine || SELF);
		if (!mesh.reachable(target)) throw new HttpError(400, `machine ${target} is not reachable (see /api/machines)`);
		const params = { ...body };
		delete params.machine;
		return send(res, 200, { machine: await call(target, "machine.configure", params) });
	}
	if (p === "/api/fs" && m === "POST") {
		const body = await readJson(req);
		const op = String(body.op ?? "");
		if (!["ls", "read", "grep"].includes(op)) throw new HttpError(400, "op must be ls, read or grep");
		return send(res, 200, await call(String(body.machine || SELF), `fs.${op}`, body));
	}

	if (p === "/api/tasks" && m === "GET") return send(res, 200, { tasks: allTasks() });

	if (p === "/api/projects" && m === "GET") return send(res, 200, { self: SELF, projects: projects.list() });
	if (p === "/api/projects" && m === "POST") return send(res, 200, { project: projects.create(await readJson(req)) });
	if (p === "/api/projects/order" && m === "POST") return send(res, 200, { projects: projects.reorder((await readJson(req)).ids) });
	if (p === "/api/projects/backfill" && m === "POST") return send(res, 200, projects.backfill(!!(await readJson(req)).all));
	const mp = /^\/api\/projects\/([^/]+)\/(rename|merge|rules)$/.exec(p);
	if (mp && m === "POST") {
		const key = decodeURIComponent(mp[1]!);
		const body = await readJson(req);
		if (mp[2] === "rename") return send(res, 200, { project: projects.rename(key, String(body.name ?? "")) });
		if (mp[2] === "merge") return send(res, 200, { project: projects.merge(key, String(body.into ?? "")) });
		return send(res, 200, { project: projects.setRules(key, body) });
	}
	if (p === "/api/tasks" && m === "POST") {
		const body = await readJson(req);
		// The requester is whoever asks; only the machine token may dispatch on someone's behalf (e.g. schedules).
		if (!viewer.root || !body.requester) body.requester = viewer.user;
		if (!body.requester) delete body.requester;
		return send(res, 200, { task: await apiCreateTask(body) });
	}

	// ---- attention (see shared/attention.ts): the one queue every front end renders, per person (shared/team.ts)
	if (p === "/api/attention" && m === "GET") {
		let who = viewer;
		const as = url.searchParams.get("user");
		if (as && as !== viewer.user) {
			need(viewer, "attention.other");
			if (!team.member(as)) throw new HttpError(400, `no such team member: ${as}`);
			who = { user: as, role: team.member(as)!.role };
		}
		return send(res, 200, attention.view(who, { archived: Number(url.searchParams.get("archived") ?? 30), scope: url.searchParams.get("scope") === "team" ? "team" : "mine" }));
	}
	if (p === "/api/attention/focus" && m === "POST") {
		const body = await readJson(req);
		return send(res, 200, { focus: attention.setFocus({ on: body.on !== false, minutes: body.minutes }) });
	}
	if (p === "/api/attention/settings" && m === "POST") {
		const body = await readJson(req);
		if (body.digestMinutes !== undefined) attention.setDigestMinutes(Number(body.digestMinutes));
		return send(res, 200, attention.view(viewer, { archived: 0 }));
	}

	let mt = /^\/api\/tasks\/([\w-]+)(?:\/(\w+))?$/.exec(p);
	if (mt) {
		const id = mt[1]!;
		const action = mt[2];
		if (action === "report") {
			// Worker → its own hub only.
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			const t = ownTask(id);
			const body = await readJson(req);
			handoff.onReport(t, body);
			const patch: Partial<Task> = {};
			if (body.status) patch.status = body.status;
			// A worker exiting after it finished (or after the user closed it) is not news.
			if (body.status === "exited" && (t.closed || !ACTIVE_STATUSES.includes(t.status))) {
				return send(res, 200, { task: update(t, { activity: "pi 已退出" }) });
			}
			if (typeof body.summary === "string") patch.summary = body.summary;
			if (typeof body.activity === "string") {
				patch.activity = body.activity;
				// Raw tool line → plain words + milestones (also covers older workers that never send a plan).
				if (body.kind === "activity") patch.progress = applyActivity(t.progress, body.activity);
			}
			if (typeof body.sessionFile === "string") patch.sessionFile = body.sessionFile;
			let progressNote: string | undefined;
			if (body.progress && typeof body.progress === "object") {
				const r = applyProgress(patch.progress ?? t.progress, body.progress);
				patch.progress = r.progress;
				const planned = Array.isArray(body.progress.plan) && r.progress.steps?.length;
				progressNote = planned ? `计划：${r.progress.steps!.map((x) => x.title).join(" / ")}` : r.milestones.length ? r.milestones.join("；") : undefined;
			}
			// Worker revises its expectation once, with a reason (qa_expect).
			if (body.expect) {
				Object.assign(patch, watchdog.workerExpect(t, body.expect));
				return send(res, 200, { task: update(t, patch, { kind: "expect", text: `worker 修正预期为 ${fmtMinutes(patch.expect!.minutes)}：${patch.expect!.reason}` }) });
			}
			// Explicit attention request from the worker: a human decision is required.
			if (body.needsHuman) {
				const question = String(body.question ?? body.summary ?? "").trim();
				const options = Array.isArray(body.options) ? body.options.map(String).filter(Boolean).slice(0, 8) : undefined;
				patch.ask = { question, options: options?.length ? options : undefined, at: Date.now() };
				if (!patch.status || ACTIVE_STATUSES.includes(patch.status)) patch.status = "needs_input";
			}
			// First progress of this run: elapsed time counts from when the run started, not from the first report.
			if (patch.progress && !t.progress) patch.progress = { ...patch.progress, startedAt: ACTIVE_STATUSES.includes(t.status) ? (t.statusSince ?? t.createdAt) : patch.progress.startedAt };
			if (body.kind === "progress") {
				// Progress never interrupts: keep the event log to plan changes and finished steps.
				return send(res, 200, { task: update(t, patch, progressNote ? { kind: "progress", text: progressNote } : undefined) });
			}
			const kind = body.kind ?? (body.status ? "status" : body.summary ? "report" : "activity");
			const text = body.summary ?? body.activity ?? body.sessionFile;
			// Activity pings are frequent: replicate them but keep the event log lean.
			return send(res, 200, { task: update(t, patch, kind === "activity" && !body.status ? undefined : { kind, status: body.status, text }) });
		}
		const owner = findTask(id).machine;
		if (action === "screen" && m === "GET") return send(res, 200, await call(owner, "task.screen", { id }));
		if (action === "attachment" && m === "GET") {
			const f = await call<FileBlob>(owner, "task.attachment", { id, n: Number(url.searchParams.get("n") ?? 0) });
			const ext = f.name.toLowerCase().split(".").pop() ?? "";
			res.writeHead(200, { "content-type": ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext] ?? "application/octet-stream" });
			return res.end(Buffer.from(f.data, "base64"));
		}
		if (!action && m === "GET") return send(res, 200, await call(owner, "task.get", { id, events: url.searchParams.get("events") ?? 30, comments: url.searchParams.get("comments") ?? 50 }));
		if (action === "transcript" && m === "GET") {
			const q: Record<string, string> = {};
			for (const k of ["after", "before", "limit", "full"]) {
				const v = url.searchParams.get(k);
				if (v !== null) q[k] = v;
			}
			try {
				return send(res, 200, await call(owner, "task.transcript", { id, ...q }));
			} catch (e) {
				if (/unknown method/.test((e as Error).message)) throw new HttpError(501, `${owner} 上的 hub 版本较旧，还不能提供工作记录（升级后可用）`);
				throw e;
			}
		}
		if (action === "comments" && m === "GET") return send(res, 200, await call(owner, "task.comments", { id, limit: url.searchParams.get("limit") ?? 100 }));
		if (m !== "POST") throw new HttpError(405, "method not allowed");
		const body = await readJson(req);
		if (action === "project") return send(res, 200, { task: await moveTask(id, owner, body.project) });
		if (action === "comments") {
			const r = await call<{ task: Task; comment: any }>(owner, "task.comment", { id, text: body.text, toWorker: body.toWorker, by: viewer.root && body.asWorker ? AGENT : (viewer.user ?? "root") });
			if (r.task.machine !== SELF) mirrorTasks.set(r.task.id, r.task);
			return send(res, 200, r);
		}
		if (!["message", "cancel", "close", "ack", "snooze", "retry", "handoff", "assign", "watch"].includes(action ?? "")) throw new HttpError(404, "unknown action");
		if (action === "message" && body.intakeId) {
			// A browser comment appended to an existing task: ship its screenshots, then link (consume) it.
			const i = findIntake(String(body.intakeId));
			const shots = i.screenshots.filter((f) => existsSync(f));
			const files = shots.length ? readFiles(shots) : undefined;
			const task = await call<Task>(owner, "task.message", { ...body, files, intakeId: i.id, id, viewer, by: viewer.user });
			if (task.machine !== SELF) mirrorTasks.set(task.id, task);
			await call(i.machine, "intake.update", { id: i.id, status: "dispatched", taskId: task.id }).catch((e) => log(`intake.update failed: ${e.message}`));
			return send(res, 200, { task });
		}
		// Mesh RPC params are trusted: the owning hub learns who acts from here, never from the client body.
		const task = await call<Task>(owner, `task.${action}`, { ...body, id, viewer, by: viewer.user });
		if (task.machine !== SELF) mirrorTasks.set(task.id, task);
		return send(res, 200, { task });
	}

	// Scheduled jobs: list/create here; per-job mutations are routed to the owning hub.
	if (p === "/api/cron" && m === "GET") return send(res, 200, { jobs: cron.list(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, self: SELF });
	if (p === "/api/cron" && m === "POST") {
		const body = await readJson(req);
		const target = String(body.hub || SELF);
		if (!mesh.reachable(target)) throw new HttpError(400, `hub ${target} is not reachable (see /api/machines)`);
		const params = { ...body };
		delete params.hub;
		// Runs are dispatched for whoever created the plan (only the machine token may set someone else).
		if (!viewer.root || !params.requester) params.requester = viewer.user;
		if (!params.requester) delete params.requester;
		const job = await call(target, "cron.create", params);
		return send(res, 200, { job: cron.view(job) });
	}
	mt = /^\/api\/cron\/([\w-]+)(?:\/(\w+))?$/.exec(p);
	if (mt) {
		const id = mt[1]!;
		const action = mt[2] ?? (m === "DELETE" ? "delete" : m === "POST" ? "update" : "");
		if (!action && m === "GET") return send(res, 200, { job: cron.get(id) });
		if (m !== "POST" && m !== "DELETE") throw new HttpError(405, "method not allowed");
		if (!["update", "run", "pause", "resume", "delete"].includes(action)) throw new HttpError(404, "unknown action");
		const body = m === "POST" ? await readJson(req) : {};
		const job = cron.get(id);
		if (job.requester && job.requester !== viewer.user && !viewer.root && viewer.role !== "owner") throw new HttpError(403, `forbidden: plan ${id} belongs to ${job.requester}`);
		delete body.requester;
		const r = await cron.routed(`cron.${action}`, id, body);
		if (action === "run") return send(res, 200, { job: cron.view(r.job), run: r.run });
		return send(res, 200, { job: r.deleted ? r : cron.view(r) });
	}

	if (p === "/api/intake" && m === "POST") return send(res, 200, { intake: createIntake(await readJson(req)) });
	if (p === "/api/intake" && m === "GET") {
		const status = url.searchParams.get("status");
		const list = allIntakes().filter((i) => !status || i.status === status).sort((a, b) => a.createdAt - b.createdAt);
		return send(res, 200, { intake: list });
	}
	mt = /^\/api\/intake\/([\w-]+)(?:\/(\w+))?$/.exec(p);
	if (mt) {
		const id = mt[1]!;
		const i = findIntake(id);
		if (m === "GET" && !mt[2]) return send(res, 200, { intake: i, task: i.taskId ? (tasks.get(i.taskId) ?? mirrorTasks.get(i.taskId)) : undefined });
		if (m === "GET" && mt[2] === "screenshot") {
			const f = i.screenshots[Number(url.searchParams.get("n") ?? 0)];
			if (!f || !existsSync(f)) throw new HttpError(404, "no screenshot on this machine");
			res.writeHead(200, { "content-type": f.endsWith(".png") ? "image/png" : "image/jpeg" });
			return res.end(readFileSync(f));
		}
		const body = await readJson(req);
		if (mt[2] === "claim") return send(res, 200, { intake: await apiClaimIntake(id, String(body.by ?? "front")) });
		return send(res, 200, { intake: await call(i.machine, "intake.update", { id, status: body.status, taskId: body.taskId }) });
	}

	// Browser comments are one-shot: pages show no marks for sent comments. Kept (always empty) for older extensions.
	if (p === "/api/pages" && m === "GET") return send(res, 200, { comments: [] });

	throw new HttpError(404, "not found");
}

// ---------------------------------------------------------------- main

loadAll();
cron.load();
projects.start();
// Created after loading so the persisted tasks form its baseline (no interrupts for old news at startup).
attention = createAttention({
	file: paths.attention,
	allTasks: () => allTasks(),
	personalize: (t, base, v) => personalAttention(t, base, v, team.roster()),
	teamRow: (t, base) => teamRow(t, base, team.roster()),
	viewers: () => [...clients].filter((c) => !c.taskId && c.viewer).map((c) => c.viewer!),
	broadcastTo: (key, e) => broadcast(e, (c) => !c.taskId && keyOf(c.viewer) === key),
	pickFront,
	log,
});
const server = createServer((req, res) => {
	handle(req, res).catch((err) => {
		const status = err instanceof HttpError ? err.status : 500;
		if (status === 500) console.error(err);
		if (!res.headersSent) send(res, status, { error: (err as Error).message });
		else res.end();
	});
});
server.listen(cfg.port, cfg.host, () => {
	writeFileSync(paths.pid, String(process.pid));
	log(`[quick-agent hub] v${VERSION} machine "${SELF}" listening on http://${cfg.host}:${cfg.port} (pid ${process.pid}, mesh ${mesh.enabled ? `on, ${cfg.mesh.peers.length} peer(s)` : "off"})`);
	log(`[quick-agent hub] web ui: run \`quick ui\` → http://127.0.0.1:${cfg.uiPort}/`);
	mesh.start();
	cron.start();
	watchdog.start();
	// Background release check: never blocks startup, cached for update.cacheMinutes, silent on failure.
	setTimeout(backgroundUpdate, 10_000).unref();
	rmSync(paths.restarting, { force: true });
});
setInterval(backgroundUpdate, Math.max(1, cfg.update.cacheMinutes) * 60_000).unref();
setInterval(maybeRestart, 60_000).unref();
setInterval(() => attention.tick(), 30_000).unref();
pruneIntakes();
setInterval(pruneIntakes, Math.min(3600_000, Math.max(60_000, INTAKE_RETENTION_MS / 4))).unref();
setInterval(() => void reconcile().catch(() => {}), 5000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		mesh.stop();
		for (const c of clients) c.res.end();
		server.close();
		process.exit(0);
	});
}
