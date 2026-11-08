// quick-agent hub: task registry, attention inbox, worker lifecycle (tmux), intake, SSE,
// and the multi-machine mesh (see mesh.ts).
// Run: node hub/server.ts   (normally started automatically by pi or `quick hub start`)
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig, matchProject, paths, REPO_ROOT } from "../shared/config.ts";
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
import { autoUpdate, readState, readVersion, runUpgrade, type UpgradeResult } from "../shared/update.ts";

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
			if (t.machine === SELF) tasks.set(t.id, t);
		} catch {}
	}
	for (const id of safeReaddir(paths.intake)) {
		try {
			const i = JSON.parse(readFileSync(join(paths.intake, id, "intake.json"), "utf8")) as Intake;
			i.machine ??= SELF;
			i.rev ??= 0;
			if (i.machine !== SELF) continue; // local copies of remote intakes (screenshots) are not authoritative
			// Claims do not survive a hub restart: let a front agent pick them up again.
			if (i.status === "claimed") i.status = "pending";
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
}
const clients = new Set<SseClient>();

function broadcast(e: HubEvent, filter?: (c: SseClient) => boolean) {
	const frame = `data: ${JSON.stringify(e)}\n\n`;
	for (const c of clients) if (!filter || filter(c)) c.res.write(frame);
}
function workerConnected(taskId: string) {
	for (const c of clients) if (c.taskId === taskId) return true;
	return false;
}

// ---------------------------------------------------------------- mesh

function machineInfo(): MachineInfo {
	return {
		id: SELF,
		description: cfg.machine.description,
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
			...[...intakes.values(), ...mirrorIntakes.values()].filter((i) => recent(i)).map((intake) => ({ kind: "intake", data: { intake } })),
		];
	},
	onEvent: (kind, data) => {
		if (kind === "task") {
			const t = data.task as Task;
			if (!t || t.machine === SELF) return false;
			const cur = mirrorTasks.get(t.id);
			if (cur && cur.machine === t.machine && cur.rev >= t.rev) return false;
			mirrorTasks.set(t.id, t);
			broadcast({ type: "task", task: t, event: data.event });
			return true;
		}
		if (kind === "intake") {
			const i = data.intake as Intake;
			if (!i || i.machine === SELF) return false;
			const cur = mirrorIntakes.get(i.id);
			if (cur && cur.machine === i.machine && cur.rev >= i.rev) return false;
			mirrorIntakes.set(i.id, i);
			broadcast({ type: "intake", intake: i });
			return true;
		}
		return false;
	},
	onRequest: (method, params, from) => {
		const fn = methods[method];
		if (!fn) throw new Error(`unknown method ${method}`);
		return fn(params ?? {}, from);
	},
});

/** Call a method on a machine (locally when it is us). */
function call<T = any>(machine: string, method: string, params: any): Promise<T> {
	return mesh.request<T>(machine, method, params);
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
	Object.assign(t, patch, { updatedAt: Date.now(), rev: (t.rev ?? 0) + 1 });
	if (patch.status && patch.status !== prev && ATTENTION_STATUSES.includes(patch.status)) t.unread = true;
	if (patch.status && ACTIVE_STATUSES.includes(patch.status)) t.unread = false;
	saveTask(t);
	const full = ev ? recordEvent(t, ev) : undefined;
	broadcast({ type: "task", task: t, event: full });
	mesh.flood("task", { task: t, event: full });
	return t;
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
async function spawnWorker(t: Task, opts: { resumeMessage?: string; model?: string } = {}) {
	await ensureTmuxSession();
	const dir = taskDir(t.id);
	const briefPath = join(dir, "brief.md");
	const model = opts.model ?? cfg.workerModel ?? cfg.model;
	// The quick-agent pi package is installed globally; QA_TASK_ID selects the worker role.
	const piArgs = ["--model", model];
	let initial: string[];
	if (opts.resumeMessage && t.sessionFile && existsSync(t.sessionFile)) {
		piArgs.push("--session", t.sessionFile);
		initial = [opts.resumeMessage];
	} else {
		piArgs.push("--name", `[${t.id}] ${t.title}`);
		initial = [`@${briefPath}`, "以上是你负责的任务简报（quick-agent task brief）。请完整负责并完成它。"];
	}
	const script = [
		"#!/usr/bin/env bash",
		`export PATH=${sh(process.env.PATH ?? "")}`,
		`export QA_TASK_ID=${sh(t.id)}`,
		`export QA_HOME=${sh(paths.home)}`,
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
	update(t, { status: "starting", tmuxTarget: target, closed: false, activity: "启动中" }, { kind: "status", status: "starting", text: opts.resumeMessage ? "resumed" : "spawned" });
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
	if (!cwd) {
		const p = matchProject(cfg, body.source?.url);
		cwd = p && (!p.machine || p.machine === SELF) ? p.cwd : cfg.defaultCwd;
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
	};
	tasks.set(id, t);
	mkdirSync(taskDir(id), { recursive: true });
	const briefDoc = [
		`# 任务 ${id}: ${title}`,
		"",
		`- 机器: ${SELF}`,
		`- 工作目录: ${cwd}`,
		`- 来源: ${t.source.kind}${t.source.url ? ` (${t.source.url})` : ""}`,
		attachments.length ? `- 附件:\n${attachments.map((a) => `  - ${a}`).join("\n")}` : "",
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

async function deliverMessage(t: Task, text: string) {
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

const methods: Record<string, (p: any, from: string) => Promise<any>> = {
	"machine.info": async () => machineInfo(),

	// Upgrade this machine (`quick upgrade --all` / `--machine`). The hub restarts itself afterwards when idle.
	"update.run": async (p, from) => {
		log(`[update] upgrade requested by ${from}${p.check ? " (check only)" : ""}`);
		const r = await runUpgrade({ check: !!p.check, machine: SELF });
		if (r.installed) {
			log(`[update] upgraded ${r.from} → ${r.to} (${r.kind})`);
			broadcast({ type: "update", machine: SELF, from: r.from, to: r.to, ts: Date.now() });
			r.note = restartNote();
			setTimeout(maybeRestart, 1500);
		}
		return r;
	},

	"task.create": async (p) => createTaskLocal(p),
	"task.get": async (p) => ({ task: ownTask(p.id), events: readEvents(p.id, Math.min(Number(p.events ?? 30) || 30, 500)) }),
	"task.message": async (p) => {
		const t = ownTask(p.id);
		const text = String(p.text ?? "").trim();
		if (!text) throw new HttpError(400, "text is required");
		await deliverMessage(t, text);
		return t;
	},
	"task.cancel": async (p) => {
		const t = ownTask(p.id);
		broadcast({ type: "task.cancel", taskId: t.id, ts: Date.now() }, (c) => c.taskId === t.id);
		if (!workerConnected(t.id) && t.tmuxTarget) await tmux("send-keys", "-t", t.tmuxTarget, "Escape").catch(() => {});
		return update(t, { status: "cancelled", activity: undefined }, { kind: "cancel" });
	},
	"task.close": async (p) => {
		const t = ownTask(p.id);
		if (t.tmuxTarget) await tmux("kill-window", "-t", t.tmuxTarget).catch(() => {});
		return update(t, { closed: true, unread: false, ...(ACTIVE_STATUSES.includes(t.status) ? { status: "cancelled" as TaskStatus } : {}) }, { kind: "close", text: "closed by user" });
	},
	"task.ack": async (p) => update(ownTask(p.id), { unread: false }),
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
		updateIntake(i, { status: "claimed", claimedBy: String(p.by ?? "front") });
		return { intake: i, files: p.withFiles ? readFiles(i.screenshots) : [] };
	},
	"intake.update": async (p) => {
		const i = intakes.get(p.id);
		if (!i) throw new HttpError(404, `no such intake on ${SELF}: ${p.id}`);
		const patch: Partial<Intake> = {};
		if (p.status) patch.status = p.status;
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
	return [...tasks.values(), ...mirrorTasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
function allIntakes() {
	return [...intakes.values(), ...mirrorIntakes.values()];
}

async function apiCreateTask(body: any): Promise<Task> {
	let machine = String(body.machine ?? "").trim();
	if (!machine && !body.cwd) machine = matchProject(cfg, body.source?.url)?.machine ?? "";
	machine ||= SELF;
	if (!mesh.reachable(machine)) throw new HttpError(400, `machine ${machine} is not reachable (see /api/machines)`);
	const params = { ...body };
	delete params.machine;
	if (machine !== SELF && Array.isArray(body.attachments) && body.attachments.length) params.files = readFiles(body.attachments.map(String));
	const task = await call<Task>(machine, "task.create", params);
	if (task.machine !== SELF) mirrorTasks.set(task.id, task);
	// Mark the originating browser comment as dispatched (on whichever machine owns it).
	if (task.source?.intakeId) {
		const i = intakes.get(task.source.intakeId) ?? mirrorIntakes.get(task.source.intakeId);
		if (i) await call(i.machine, "intake.update", { id: i.id, status: "dispatched", taskId: task.id }).catch((e) => log(`intake.update failed: ${e.message}`));
	}
	return task;
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

// ---------------------------------------------------------------- intake

function storeDataUrl(dir: string, name: string, dataUrl: string): string | undefined {
	const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(dataUrl);
	if (!m) return undefined;
	const file = join(dir, `${name.replace(/[^\w.-]/g, "_")}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
	writeFileSync(file, Buffer.from(m[2]!, "base64"));
	return file;
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
		viewport: body.viewport,
		screenshots,
		consoleErrors: Array.isArray(body.consoleErrors) ? body.consoleErrors.slice(-30).map(String) : undefined,
		userAgent: body.userAgent,
	};
	intakes.set(id, i);
	updateIntake(i, {});
	return i;
}

// ---------------------------------------------------------------- self-upgrade

let upgradesInFlight = 0;
async function apiUpgrade(body: any): Promise<UpgradeResult[]> {
	upgradesInFlight++;
	try {
		return await upgradeMachines(body);
	} finally {
		upgradesInFlight--;
		setTimeout(maybeRestart, 1500);
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
				return { machine, ok: false, error: msg, from: version, to: version, current: version, installed: false, checkOnly: check, available: false, tried: [], root: "", kind: "git" } as UpgradeResult;
			}
		}),
	);
}

let restarting = false;
function restartNote() {
	return cfg.update.restartHub === "never" ? "运行 quick hub restart 生效" : "hub 将在没有运行中的 worker 时自动重启";
}
/** After an upgrade was installed (by anyone) since this hub started: restart once no local worker is busy. */
function maybeRestart() {
	if (restarting || cfg.update.restartHub === "never") return;
	const st = readState();
	if (!st.installed || st.installed.at <= STARTED_AT) return;
	if ([...tasks.values()].some((t) => !t.closed && ACTIVE_STATUSES.includes(t.status))) return;
	// Do not cut off mesh RPCs (e.g. other machines' upgrade results still travelling through us).
	if (upgradesInFlight > 0 || mesh.busy()) return void setTimeout(maybeRestart, 2000);
	restarting = true;
	log(`[update] restarting hub to load quick-agent ${st.installed.to} (running ${VERSION})`);
	const out = openSync(paths.log, "a");
	spawn(process.execPath, ["--import", join(REPO_ROOT, "bin", "ts-hooks.mjs"), join(REPO_ROOT, "cli", "quick.ts"), "hub", "restart"], {
		detached: true,
		stdio: ["ignore", out, out],
		env: { ...process.env, NODE_NO_WARNINGS: "1", QA_TASK_ID: "" },
	}).unref();
	closeSync(out);
}

function backgroundUpdate() {
	void autoUpdate({ trigger: "hub", log }).then((r) => {
		if (r?.installed) {
			broadcast({ type: "update", machine: SELF, from: r.from, to: r.to, ts: Date.now() });
			maybeRestart();
		}
	});
}

// Periodically reconcile local tasks whose tmux window disappeared.
async function reconcile() {
	const live = await liveWindows();
	for (const t of tasks.values()) {
		if (t.closed) continue;
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
		"access-control-allow-methods": "GET, POST, OPTIONS",
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
function authorized(req: IncomingMessage, url: URL) {
	const h = req.headers.authorization;
	if (h === `Bearer ${cfg.token}`) return true;
	return url.searchParams.get("token") === cfg.token;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const p = url.pathname;
	const m = req.method ?? "GET";
	if (m === "OPTIONS") {
		res.writeHead(204, cors());
		return res.end();
	}
	if (p === "/health") return send(res, 200, { ok: true, machine: SELF, pid: process.pid, tasks: tasks.size, mesh: mesh.enabled, version: VERSION });
	if (p === "/" || p === "/dashboard") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(dashboardHtml());
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

	// ---- local clients (API token)
	if (!authorized(req, url)) throw new HttpError(401, "unauthorized");

	if (p === "/api/events" && m === "GET") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...cors() });
		const client: SseClient = { res, taskId: url.searchParams.get("task") ?? undefined, role: url.searchParams.get("role") ?? "client" };
		clients.add(client);
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

	if (p === "/api/upgrade" && m === "POST") return send(res, 200, { results: await apiUpgrade(await readJson(req)) });
	if (p === "/api/machines" && m === "GET") return send(res, 200, { self: SELF, machines: mesh.machines(), links: mesh.linkStatus() });
	if (p === "/api/fs" && m === "POST") {
		const body = await readJson(req);
		const op = String(body.op ?? "");
		if (!["ls", "read", "grep"].includes(op)) throw new HttpError(400, "op must be ls, read or grep");
		return send(res, 200, await call(String(body.machine || SELF), `fs.${op}`, body));
	}

	if (p === "/api/tasks" && m === "GET") return send(res, 200, { tasks: allTasks() });
	if (p === "/api/tasks" && m === "POST") return send(res, 200, { task: await apiCreateTask(await readJson(req)) });

	let mt = /^\/api\/tasks\/([\w-]+)(?:\/(\w+))?$/.exec(p);
	if (mt) {
		const id = mt[1]!;
		const action = mt[2];
		if (action === "report") {
			// Worker → its own hub only.
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			const t = ownTask(id);
			const body = await readJson(req);
			const patch: Partial<Task> = {};
			if (body.status) patch.status = body.status;
			// A worker exiting after it finished (or after the user closed it) is not news.
			if (body.status === "exited" && (t.closed || !ACTIVE_STATUSES.includes(t.status))) {
				return send(res, 200, { task: update(t, { activity: "pi 已退出" }) });
			}
			if (typeof body.summary === "string") patch.summary = body.summary;
			if (typeof body.activity === "string") patch.activity = body.activity;
			if (typeof body.sessionFile === "string") patch.sessionFile = body.sessionFile;
			const kind = body.kind ?? (body.status ? "status" : body.summary ? "report" : "activity");
			const text = body.summary ?? body.activity ?? body.sessionFile;
			// Activity pings are frequent: replicate them but keep the event log lean.
			return send(res, 200, { task: update(t, patch, kind === "activity" && !body.status ? undefined : { kind, status: body.status, text }) });
		}
		const owner = findTask(id).machine;
		if (action === "screen" && m === "GET") return send(res, 200, await call(owner, "task.screen", { id }));
		if (!action && m === "GET") return send(res, 200, await call(owner, "task.get", { id, events: url.searchParams.get("events") ?? 30 }));
		if (m !== "POST") throw new HttpError(405, "method not allowed");
		const body = await readJson(req);
		if (!["message", "cancel", "close", "ack"].includes(action ?? "")) throw new HttpError(404, "unknown action");
		const task = await call<Task>(owner, `task.${action}`, { ...body, id });
		if (task.machine !== SELF) mirrorTasks.set(task.id, task);
		return send(res, 200, { task });
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

	// Browser badges: comments on a page (from any machine) and the status of their tasks.
	if (p === "/api/pages" && m === "GET") {
		const pageUrl = url.searchParams.get("url") ?? "";
		const strip = (u: string) => u.split("#")[0];
		const list = allIntakes()
			.filter((i) => i.url && strip(i.url) === strip(pageUrl))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((i) => {
				const t = i.taskId ? (tasks.get(i.taskId) ?? mirrorTasks.get(i.taskId)) : undefined;
				return { id: i.id, comment: i.comment, elements: i.elements.slice(0, 3), region: i.region, status: i.status, taskId: i.taskId, taskStatus: t?.status, taskTitle: t?.title, summary: t?.summary, machine: t?.machine };
			});
		return send(res, 200, { comments: list });
	}

	throw new HttpError(404, "not found");
}

// ---------------------------------------------------------------- main

loadAll();
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
	mesh.start();
	// Background version check: never blocks startup, throttled by update.intervalHours, silent on failure.
	setTimeout(backgroundUpdate, 10_000).unref();
});
setInterval(backgroundUpdate, 3600_000).unref();
setInterval(maybeRestart, 60_000).unref();
setInterval(() => void reconcile().catch(() => {}), 5000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		mesh.stop();
		for (const c of clients) c.res.end();
		server.close();
		process.exit(0);
	});
}
