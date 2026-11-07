// quick-agent hub: task registry, attention inbox, worker lifecycle (tmux), intake, SSE.
// Run: node hub/server.ts   (normally via `qa hub start`)
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig, matchProject, paths, REPO_ROOT, WORKER_EXTENSION } from "../shared/config.ts";
const EXTENSION_DIR = join(REPO_ROOT, "browser");
import {
	ACTIVE_STATUSES,
	ATTENTION_STATUSES,
	type HubEvent,
	type Intake,
	type Task,
	type TaskEvent,
	type TaskStatus,
} from "../shared/types.ts";
import { dashboardHtml } from "./dashboard.ts";

const run = promisify(execFile);
const cfg = loadConfig();
const tasks = new Map<string, Task>();
const intakes = new Map<string, Intake>();
const pendingMessages = new Map<string, string[]>();

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
			tasks.set(t.id, t);
		} catch {}
	}
	for (const id of safeReaddir(paths.intake)) {
		try {
			const i = JSON.parse(readFileSync(join(paths.intake, id, "intake.json"), "utf8")) as Intake;
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

// ---------------------------------------------------------------- SSE

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

// ---------------------------------------------------------------- task mutations

function recordEvent(t: Task, ev: Omit<TaskEvent, "ts" | "taskId">) {
	const full: TaskEvent = { ts: Date.now(), taskId: t.id, ...ev };
	mkdirSync(taskDir(t.id), { recursive: true });
	appendFileSync(join(taskDir(t.id), "events.jsonl"), `${JSON.stringify(full)}\n`);
	return full;
}

function update(t: Task, patch: Partial<Task>, ev?: Omit<TaskEvent, "ts" | "taskId">) {
	const prev = t.status;
	Object.assign(t, patch, { updatedAt: Date.now() });
	if (patch.status && patch.status !== prev && ATTENTION_STATUSES.includes(patch.status)) t.unread = true;
	if (patch.status && ACTIVE_STATUSES.includes(patch.status)) t.unread = false;
	saveTask(t);
	const full = ev ? recordEvent(t, ev) : undefined;
	broadcast({ type: "task", task: t, event: full });
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
	const piArgs = ["-e", WORKER_EXTENSION, "--model", model];
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

async function createTask(body: any): Promise<Task> {
	const title = String(body.title ?? "").trim() || "untitled";
	const brief = String(body.brief ?? "").trim();
	if (!brief) throw new HttpError(400, "brief is required");
	let cwd = String(body.cwd ?? "").trim();
	if (!cwd) cwd = matchProject(cfg, body.source?.url)?.cwd ?? cfg.defaultCwd;
	if (!existsSync(cwd)) throw new HttpError(400, `cwd does not exist: ${cwd}`);
	const id = newId("t", (x) => tasks.has(x));
	const attachments: string[] = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
	const t: Task = {
		id,
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
	};
	tasks.set(id, t);
	mkdirSync(taskDir(id), { recursive: true });
	const briefDoc = [
		`# 任务 ${id}: ${title}`,
		"",
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
	if (t.source.intakeId) {
		const i = intakes.get(t.source.intakeId);
		if (i) {
			i.status = "dispatched";
			i.taskId = id;
			saveIntake(i);
			broadcast({ type: "intake", intake: i });
		}
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

// Periodically reconcile tasks whose tmux window disappeared.
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
	const id = newId("c", (x) => intakes.has(x));
	const dir = join(paths.intake, id);
	mkdirSync(dir, { recursive: true });
	const screenshots: string[] = [];
	for (const [n, s] of (Array.isArray(body.screenshots) ? body.screenshots : []).entries()) {
		const f = storeDataUrl(dir, s?.name ?? `shot-${n}`, String(s?.dataUrl ?? ""));
		if (f) screenshots.push(f);
	}
	const i: Intake = {
		id,
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
	saveIntake(i);
	broadcast({ type: "intake", intake: i });
	return i;
}

// ---------------------------------------------------------------- HTTP

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

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
		if (size > 30 * 1024 * 1024) throw new HttpError(413, "body too large");
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
function getTask(id: string) {
	const t = tasks.get(id);
	if (!t) throw new HttpError(404, `no such task: ${id}`);
	return t;
}
function sortedTasks() {
	return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const p = url.pathname;
	const m = req.method ?? "GET";
	if (m === "OPTIONS") {
		res.writeHead(204, cors());
		return res.end();
	}
	if (p === "/health") return send(res, 200, { ok: true, pid: process.pid, tasks: tasks.size });
	if (p === "/" || p === "/dashboard") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(dashboardHtml());
	}
	if (p === "/extension.zip") {
		// Browser extension package (no secrets inside): download, unzip, "Load unpacked".
		const zip = join(paths.home, "quick-agent-extension.zip");
		await run("python3", ["-m", "zipfile", "-c", zip, ...readdirSync(EXTENSION_DIR).map((f) => join(EXTENSION_DIR, f))]);
		res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="quick-agent-extension.zip"' });
		return res.end(readFileSync(zip));
	}
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

	if (p === "/api/tasks" && m === "GET") return send(res, 200, { tasks: sortedTasks() });
	if (p === "/api/tasks" && m === "POST") return send(res, 200, { task: await createTask(await readJson(req)) });

	let mt = /^\/api\/tasks\/([\w-]+)(?:\/(\w+))?$/.exec(p);
	if (mt) {
		const t = getTask(mt[1]!);
		const action = mt[2];
		if (!action && m === "GET") {
			const n = Math.min(Number(url.searchParams.get("events") ?? 30) || 30, 500);
			return send(res, 200, { task: t, events: readEvents(t.id, n) });
		}
		if (m !== "POST") throw new HttpError(405, "method not allowed");
		const body = await readJson(req);
		switch (action) {
			case "message": {
				const text = String(body.text ?? "").trim();
				if (!text) throw new HttpError(400, "text is required");
				await deliverMessage(t, text);
				return send(res, 200, { task: t });
			}
			case "cancel":
				broadcast({ type: "task.cancel", taskId: t.id, ts: Date.now() }, (c) => c.taskId === t.id);
				if (!workerConnected(t.id) && t.tmuxTarget) await tmux("send-keys", "-t", t.tmuxTarget, "Escape").catch(() => {});
				return send(res, 200, { task: update(t, { status: "cancelled", activity: undefined }, { kind: "cancel" }) });
			case "close":
				if (t.tmuxTarget) await tmux("kill-window", "-t", t.tmuxTarget).catch(() => {});
				return send(res, 200, {
					task: update(t, { closed: true, unread: false, ...(ACTIVE_STATUSES.includes(t.status) ? { status: "cancelled" as TaskStatus } : {}) }, { kind: "close", text: "closed by user" }),
				});
			case "ack":
				return send(res, 200, { task: update(t, { unread: false }) });
			case "report": {
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
				// Activity pings are frequent: persist them but keep the event log lean.
				return send(res, 200, { task: update(t, patch, kind === "activity" && !body.status ? undefined : { kind, status: body.status, text }) });
			}
		}
		throw new HttpError(404, "unknown action");
	}

	if (p === "/api/intake" && m === "POST") {
		const i = createIntake(await readJson(req));
		return send(res, 200, { intake: i });
	}
	if (p === "/api/intake" && m === "GET") {
		const status = url.searchParams.get("status");
		const list = [...intakes.values()].filter((i) => !status || i.status === status).sort((a, b) => a.createdAt - b.createdAt);
		return send(res, 200, { intake: list });
	}
	mt = /^\/api\/intake\/([\w-]+)(?:\/(\w+))?$/.exec(p);
	if (mt) {
		const i = intakes.get(mt[1]!);
		if (!i) throw new HttpError(404, "no such intake");
		if (m === "GET" && !mt[2]) return send(res, 200, { intake: i, task: i.taskId ? tasks.get(i.taskId) : undefined });
		if (m === "GET" && mt[2] === "screenshot") {
			const f = i.screenshots[Number(url.searchParams.get("n") ?? 0)];
			if (!f || !existsSync(f)) throw new HttpError(404, "no screenshot");
			res.writeHead(200, { "content-type": f.endsWith(".png") ? "image/png" : "image/jpeg" });
			return res.end(readFileSync(f));
		}
		const body = await readJson(req);
		if (mt[2] === "claim") {
			if (i.status !== "pending") throw new HttpError(409, `intake already ${i.status}`);
			i.status = "claimed";
			i.claimedBy = String(body.by ?? "front");
		} else {
			if (body.status) i.status = body.status;
			if (body.taskId) i.taskId = body.taskId;
		}
		saveIntake(i);
		broadcast({ type: "intake", intake: i });
		return send(res, 200, { intake: i });
	}

	// Browser badges: comments on a page and the status of their tasks.
	if (p === "/api/pages" && m === "GET") {
		const pageUrl = url.searchParams.get("url") ?? "";
		const strip = (u: string) => u.split("#")[0];
		const list = [...intakes.values()]
			.filter((i) => i.url && strip(i.url) === strip(pageUrl))
			.map((i) => {
				const t = i.taskId ? tasks.get(i.taskId) : undefined;
				return { id: i.id, comment: i.comment, elements: i.elements.slice(0, 3), region: i.region, status: i.status, taskId: i.taskId, taskStatus: t?.status, taskTitle: t?.title, summary: t?.summary };
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
	console.log(`[quick-agent hub] listening on http://${cfg.host}:${cfg.port} (pid ${process.pid})`);
});
setInterval(() => void reconcile().catch(() => {}), 5000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		for (const c of clients) c.res.end();
		server.close();
		process.exit(0);
	});
}
