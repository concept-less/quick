// Lossless task handoff between machines of the mesh.
//
//   source hub (owns the task)                         target hub
//   ─────────────────────────                          ──────────
//   task.handoff → status=handoff (async from here on)
//   1. safe point: wait until the worker's turn ends (or --abort it), session file quiet
//   2. pack: session jsonl, task dir files, workspace snapshot (workspace.ts)
//   3. handoff.probe ───────────────────────────────►  pick target cwd, detect conflicts, bundle needs
//   4. git bundle (only commits the target lacks)
//   5. handoff.begin / handoff.chunk × N ───────────►  staging dir, append chunks (4 MB, over the mesh RPC)
//   6. handoff.apply ───────────────────────────────►  sha256 of every file, place session (header cwd
//                                                      rewritten), apply + verify workspace manifest
//   7. handoff.start ───────────────────────────────►  register task (same id, epoch+1), spawn worker
//   8. kill source window, task becomes a mirror here, forward messages queued during the handoff
//   Any failure before 7 succeeds: handoff.abort (target undoes everything) and the task is restored here.
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CONFIG_PATH, paths, type ProjectRule } from "../shared/config.ts";
import { ACTIVE_STATUSES, type HubEvent, type Task, type TaskEvent, type TaskStatus } from "../shared/types.ts";
import {
	applyWorkspace,
	checkBranch,
	DEFAULT_EXCLUDE,
	describeSnapshot,
	finalizeWorkspace,
	makeBundle,
	planTarget,
	quickInfo,
	sha256File,
	snapshotWorkspace,
	undoWorkspace,
	verifyWorkspace,
	type OnConflict,
	type Plan,
	type Snapshot,
	type Undo,
} from "./workspace.ts";

const CHUNK = 4 * 1024 * 1024;
const SKIP_TASK_FILES = new Set(["task.json", "events.jsonl", "run.sh"]);
const OUT_DIR = join(paths.home, "handoff", "out");
const IN_DIR = join(paths.home, "handoff", "in");
const DEPARTED = join(paths.home, "handoff", "departed.json");

export interface HandoffDeps {
	self: string;
	log(msg: string): void;
	tasks: Map<string, Task>;
	mirrorTasks: Map<string, Task>;
	taskDir(id: string): string;
	saveTask(t: Task): void;
	update(t: Task, patch: Partial<Task>, ev?: Omit<TaskEvent, "ts" | "taskId">): Task;
	recordEvent(t: Task, ev: Omit<TaskEvent, "ts" | "taskId">): TaskEvent;
	broadcast(e: HubEvent, filter?: (c: { taskId?: string }) => boolean): void;
	spawnWorker(t: Task, opts: { resumeMessage?: string; idle?: boolean; status?: TaskStatus }): Promise<void>;
	call<T = any>(machine: string, method: string, params: any, timeoutMs?: number): Promise<T>;
	reachable(machine: string): boolean;
	workerConnected(id: string): boolean;
	liveWindows(): Promise<Set<string>>;
	tmux(...args: string[]): Promise<unknown>;
	deliverMessage(t: Task, text: string): Promise<void>;
	projects(): ProjectRule[];
	httpError(status: number, msg: string): Error;
}

export interface HandoffOptions {
	to: string;
	cwd?: string;
	noWorkspace?: boolean;
	abort?: boolean;
	waitSec?: number;
	onConflict?: OnConflict;
	testFail?: string;
}

interface Outgoing {
	id: string;
	to: string;
	xfer: string;
	prevStatus: TaskStatus;
	prevActivity?: string;
	alive: boolean;
	aborted: boolean;
	queued: string[];
	settle?: () => void;
}

interface Incoming {
	xfer: string;
	taskId: string;
	from: string;
	dir: string;
	files: Map<string, { size: number; sha: string }>;
	applied?: { snap?: Snapshot; plan: Plan; sessionFile?: string; srcCwd: string };
	undo?: Undo;
	session?: { path: string; backup?: string; dropBackup?: boolean };
	timer: NodeJS.Timeout;
}

function settings() {
	let raw: any = {};
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).handoff ?? {};
	} catch {}
	return {
		maxBytes: Number(raw.maxWorkspaceMB ?? 200) * 1048576,
		exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : DEFAULT_EXCLUDE,
		waitSec: Number(raw.waitSeconds ?? 600),
	};
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
function within(p: string, root: string) {
	return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}
function expandHome(p: string) {
	return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}
function piSessionDir(cwd: string) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ? expandHome(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
function readDeparted(): Record<string, { digest: string; at: number }> {
	try {
		return JSON.parse(readFileSync(DEPARTED, "utf8"));
	} catch {
		return {};
	}
}
function addDeparted(key: string, digest: string) {
	const d = readDeparted();
	d[key] = { digest, at: Date.now() };
	for (const [k, v] of Object.entries(d)) if (Date.now() - v.at > 60 * 86400_000) delete d[k];
	mkdirSync(dirname(DEPARTED), { recursive: true });
	writeFileSync(DEPARTED, JSON.stringify(d, null, 1));
}
function listFiles(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...listFiles(dir, r));
		else if (e.isFile()) out.push(r);
	}
	return out;
}
/** Wait until a file stops changing (pi flushes the session after the turn). */
async function quiet(file: string | undefined, stableMs: number, maxMs: number) {
	if (!file || !existsSync(file)) return;
	const sig = () => {
		try {
			const s = statSync(file);
			return `${s.size}:${s.mtimeMs}`;
		} catch {
			return "";
		}
	};
	const end = Date.now() + maxMs;
	let last = sig();
	let since = Date.now();
	while (Date.now() < end) {
		await sleep(250);
		const now = sig();
		if (now !== last) (last = now), (since = Date.now());
		else if (Date.now() - since >= stableMs) return;
	}
}

export function createHandoff(d: HandoffDeps) {
	const outgoing = new Map<string, Outgoing>();
	const incoming = new Map<string, Incoming>();
	rmSync(IN_DIR, { recursive: true, force: true });
	rmSync(OUT_DIR, { recursive: true, force: true });

	const phase = (t: Task, text: string) => d.update(t, { activity: `交接 → ${outgoing.get(t.id)?.to}: ${text}` });

	// ------------------------------------------------------------ source side

	async function start(t: Task, o: HandoffOptions): Promise<Task> {
		const to = String(o.to ?? "").trim();
		if (!to) throw d.httpError(400, "target machine is required");
		if (to === d.self) throw d.httpError(400, `task ${t.id} already runs on ${d.self}`);
		if (!d.reachable(to)) throw d.httpError(400, `machine ${to} is not reachable (源机器和目标机器都必须在线)`);
		if (outgoing.has(t.id) || t.status === "handoff") throw d.httpError(409, `task ${t.id} is already being handed off`);
		const og: Outgoing = { id: t.id, to, xfer: `${t.id}-${randomBytes(4).toString("hex")}`, prevStatus: t.status, prevActivity: t.activity, alive: false, aborted: false, queued: [] };
		outgoing.set(t.id, og);
		d.update(
			t,
			{ status: "handoff", handoff: { from: d.self, to, startedAt: Date.now(), prevStatus: t.status, phase: "start" }, activity: `交接 → ${to}: 开始` },
			{ kind: "handoff", text: `开始交接 ${d.self} → ${to}${o.cwd ? `（目标目录 ${o.cwd}）` : ""}${o.noWorkspace ? "（不同步工作区）" : ""}` },
		);
		void run(t, og, o);
		return t;
	}

	async function safePoint(t: Task, og: Outgoing, o: HandoffOptions) {
		const live = await d.liveWindows();
		og.alive = live.has(t.id) && !t.closed;
		if (og.alive && ACTIVE_STATUSES.includes(og.prevStatus)) {
			if (o.abort) {
				phase(t, "中止 worker 当前运行");
				og.aborted = true;
				d.broadcast({ type: "task.cancel", taskId: t.id, ts: Date.now() }, (c) => c.taskId === t.id);
				if (!d.workerConnected(t.id) && t.tmuxTarget) await d.tmux("send-keys", "-t", t.tmuxTarget, "Escape").catch(() => {});
				await quiet(t.sessionFile, 2500, 30_000);
			} else {
				const wait = o.waitSec ?? settings().waitSec;
				phase(t, `等待 worker 本轮结束（最多 ${wait}s；--abort 可立即中止）`);
				await new Promise<void>((res, rej) => {
					const timer = setTimeout(() => rej(new Error(`worker 在 ${wait}s 内没有停下来。可以稍后重试，或加 --abort 中止当前运行后交接`)), wait * 1000);
					og.settle = () => {
						clearTimeout(timer);
						res();
					};
				});
			}
		}
		if (og.alive) await quiet(t.sessionFile, 1500, 15_000);
	}

	async function run(t: Task, og: Outgoing, o: HandoffOptions) {
		const pkg = join(OUT_DIR, og.xfer);
		const to = og.to;
		let begun = false;
		const cfgH = settings();
		const probe = (w: { mode: string; root: string; sub: string; head?: string | null; branch?: string | null } | undefined) =>
			d.call<Plan>(
				to,
				"handoff.probe",
				{
					taskId: t.id,
					mode: w?.mode ?? "none",
					sub: w?.sub ?? "",
					head: w?.head,
					branch: w?.branch,
					srcRoot: w?.root ?? t.cwd,
					srcHome: homedir(),
					srcProjects: d.projects(),
					explicitCwd: o.cwd,
					historyCwd: [...(t.handoffs ?? [])].reverse().map((h) => (h.from === to ? h.fromCwd : h.to === to ? h.toCwd : "")).find(Boolean),
					onConflict: o.onConflict ?? "fail",
					exclude: w?.mode === "dir" ? cfgH.exclude : [],
				},
				120_000,
			);
		try {
			// Early check so an obvious conflict does not interrupt the worker for nothing.
			phase(t, "检查目标机器");
			await probe(o.noWorkspace ? undefined : await quickInfo(t.cwd));
			await safePoint(t, og, o);
			phase(t, "打包会话和工作区");
			const files: { name: string; path: string }[] = [];
			const session = t.sessionFile && existsSync(t.sessionFile) ? t.sessionFile : undefined;
			if (session) files.push({ name: "session.jsonl", path: session });
			const tdir = d.taskDir(t.id);
			for (const rel of existsSync(tdir) ? listFiles(tdir) : []) if (!SKIP_TASK_FILES.has(rel)) files.push({ name: `task/${rel}`, path: join(tdir, rel) });
			let snap: Snapshot | undefined;
			if (!o.noWorkspace) snap = await snapshotWorkspace(t.cwd, join(pkg, "ws"), { maxBytes: cfgH.maxBytes, exclude: cfgH.exclude });

			const plan = await probe(snap);
			if (snap) {
				await checkBranch(snap, plan);
				await makeBundle(snap, plan, join(pkg, "ws"));
				for (const f of snap.files) files.push({ name: `ws/${f}`, path: join(pkg, "ws", f) });
			}

			const manifest = files.map((f) => ({ name: f.name, size: statSync(f.path).size, sha: sha256File(f.path) }));
			const total = manifest.reduce((a, f) => a + f.size, 0);
			await d.call(to, "handoff.begin", { xfer: og.xfer, taskId: t.id, files: manifest });
			begun = true;
			let sent = 0;
			for (const [i, f] of files.entries()) {
				const fd = openSync(f.path, "r");
				try {
					const buf = Buffer.alloc(CHUNK);
					for (let off = 0; off < manifest[i]!.size; ) {
						const n = readSync(fd, buf, 0, CHUNK, off);
						if (n <= 0) break;
						await d.call(to, "handoff.chunk", { xfer: og.xfer, name: f.name, offset: off, data: buf.subarray(0, n).toString("base64") }, 120_000);
						off += n;
						sent += n;
						phase(t, `传输 ${(sent / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
					}
				} finally {
					closeSync(fd);
				}
			}

			phase(t, "目标机器校验并应用");
			const applied = await d.call<{ sessionFile?: string; cwd: string; notes: string[] }>(
				to,
				"handoff.apply",
				{ xfer: og.xfer, snap, plan, srcCwd: t.cwd, sessionName: session ? basename(session) : undefined, testFail: o.testFail },
				15 * 60_000,
			);

			phase(t, "在目标机器启动 worker");
			const mode = !og.alive ? "closed" : og.aborted || ACTIVE_STATUSES.includes(og.prevStatus) ? "run" : "idle";
			const note = handoffNote(t, to, applied.cwd, snap, applied.notes, og.aborted, !!o.noWorkspace);
			const events = existsSync(join(tdir, "events.jsonl")) ? readFileSync(join(tdir, "events.jsonl"), "utf8") : "";
			const srcTask: Task = { ...t, status: og.prevStatus, activity: og.prevActivity, handoff: undefined };
			const nt = await d.call<Task>(to, "handoff.start", { xfer: og.xfer, task: srcTask, events, note, mode, srcTaskDir: tdir, testFail: o.testFail }, 120_000);

			// Committed: the task now lives on `to`.
			outgoing.delete(t.id);
			d.tasks.delete(t.id);
			const cur = d.mirrorTasks.get(t.id);
			if (!cur || (cur.epoch ?? 0) < (nt.epoch ?? 0) || cur.rev < nt.rev) d.mirrorTasks.set(t.id, nt);
			d.recordEvent(t, { kind: "handoff", text: `已交接到 ${to}（${applied.cwd}）` });
			d.saveTask(d.mirrorTasks.get(t.id)!); // task.json now says machine=<to>: never loaded as our own again
			if (t.tmuxTarget && og.alive) await d.tmux("kill-window", "-t", t.tmuxTarget).catch(() => {});
			if (snap) addDeparted(`${t.id}|${snap.root}`, snap.manifest.digest);
			if (session) addDeparted(`${t.id}|${session}`, sha256File(session));
			d.broadcast({ type: "task", task: d.mirrorTasks.get(t.id)! });
			d.log(`[handoff] ${t.id} → ${to} done`);
			for (const text of og.queued) await d.call(to, "task.message", { id: t.id, text }).catch((e) => d.log(`[handoff] forwarding queued message failed: ${(e as Error).message}`));
		} catch (e) {
			const msg = (e as Error).message;
			d.log(`[handoff] ${t.id} → ${to} failed: ${msg}`);
			if (begun) await d.call(to, "handoff.abort", { xfer: og.xfer }, 120_000).catch((e2) => d.log(`[handoff] abort on ${to} failed: ${(e2 as Error).message}`));
			outgoing.delete(t.id);
			const restored = og.aborted ? "idle" : og.prevStatus;
			d.update(t, { status: restored, handoff: undefined, activity: `交接到 ${to} 失败（已回滚，任务仍在 ${d.self}）` }, { kind: "handoff", text: `交接到 ${to} 失败，已回滚，任务仍在 ${d.self}：${msg}` });
			const resume = og.aborted ? [`【quick-agent】交接到 ${to} 失败（${msg.split("\n")[0]}），任务留在本机继续。交接前你被中止的工具调用可能没有完成，请检查后继续。`] : [];
			for (const text of [...og.queued, ...resume]) await d.deliverMessage(t, text).catch(() => {});
		} finally {
			rmSync(pkg, { recursive: true, force: true });
		}
	}

	function handoffNote(t: Task, to: string, dstCwd: string, snap: Snapshot | undefined, notes: string[], aborted: boolean, noWs: boolean) {
		const same = dstCwd === t.cwd;
		return [
			`【quick-agent 交接】本任务已从机器 ${d.self}（工作目录 ${t.cwd}）交接到本机 ${to}（工作目录 ${dstCwd}）。`,
			"- 会话历史完整保留：你看到的历史就是交接前的全部对话。",
			`- 工作区：${noWs ? "没有同步（--no-workspace），本机目录里的文件可能和源机器不同" : snap ? describeSnapshot(snap) : "-"}。`,
			...notes.map((n) => `- ${n}`),
			same ? "" : `- 路径映射：历史中出现的 ${t.cwd} 现在对应 ${dstCwd}。`,
			"- 历史里的工具输出来自源机器；本机环境（依赖、node_modules、.env 等被忽略的文件、运行中的进程和端口）可能不同，必要时重新确认。",
			aborted ? "- 交接时你正在进行的那一轮被中止了，最后一个工具调用的结果可能不完整，请先检查再继续。" : "",
			"请先确认现状，再继续完成任务；如果任务此前已经完成，简单确认即可，不必重复工作。",
		]
			.filter(Boolean)
			.join("\n");
	}

	/** Worker report while its task is being handed off: keep status=handoff, remember the worker's state. */
	function onReport(t: Task, body: any) {
		const og = outgoing.get(t.id);
		if (!og || !body.status) return;
		const st = body.status as TaskStatus;
		delete body.status;
		if (st === "exited") og.alive = false;
		og.prevStatus = st === "exited" ? "exited" : st;
		if (t.handoff) t.handoff.prevStatus = og.prevStatus;
		if (!ACTIVE_STATUSES.includes(st)) og.settle?.();
	}

	/** Messages to a task in handoff are queued and delivered to wherever it ends up. */
	function interceptMessage(t: Task, text: string): boolean {
		const og = outgoing.get(t.id);
		if (!og) return false;
		og.queued.push(text);
		d.update(t, {}, { kind: "message", text: `${text}（交接中，完成后转交）` });
		return true;
	}

	function busy(id: string) {
		return outgoing.has(id);
	}

	/** Hub restarted in the middle of a handoff we started: the task is still ours. */
	function recoverOnLoad(t: Task) {
		if (t.status !== "handoff") return;
		t.status = t.handoff?.prevStatus ?? "idle";
		t.activity = "交接被 hub 重启中断（任务仍在本机）";
		t.handoff = undefined;
	}

	// ------------------------------------------------------------ target side

	function inc(xfer: string): Incoming {
		const i = incoming.get(String(xfer));
		if (!i) throw d.httpError(404, `unknown handoff transfer ${xfer}`);
		return i;
	}

	async function undoIncoming(i: Incoming): Promise<string[]> {
		clearTimeout(i.timer);
		const errs: string[] = [];
		if (i.undo) errs.push(...(await undoWorkspace(i.undo)));
		if (i.session) {
			try {
				rmSync(i.session.path, { force: true });
				if (i.session.backup) renameSync(i.session.backup, i.session.path);
			} catch (e) {
				errs.push(`session: ${(e as Error).message}`);
			}
		}
		rmSync(i.dir, { recursive: true, force: true });
		incoming.delete(i.xfer);
		if (errs.length) d.log(`[handoff] undo ${i.xfer}: ${errs.join("; ")}`);
		return errs;
	}

	function placeSession(i: Incoming, dstCwd: string, name: string): string {
		const src = join(i.dir, "session.jsonl");
		const buf = readFileSync(src);
		const nl = buf.indexOf(10);
		const head = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString("utf8"));
		if (head.type !== "session") throw new Error("session file has no pi session header");
		head.cwd = dstCwd;
		const body = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl);
		const out = Buffer.concat([Buffer.from(JSON.stringify(head)), body]);
		const dir = piSessionDir(dstCwd);
		mkdirSync(dir, { recursive: true });
		const target = join(dir, basename(name));
		i.session = { path: target };
		if (existsSync(target)) {
			const departed = readDeparted()[`${i.taskId}|${target}`];
			const backup = `${target}.qa-bak-${Date.now()}`;
			i.session.dropBackup = departed?.digest === sha256File(target); // our own stale copy from an earlier handoff away
			renameSync(target, backup);
			i.session.backup = backup;
		}
		writeFileSync(target, out);
		// Verify: every line after the header byte-identical, header cwd updated.
		const back = readFileSync(target);
		const bnl = back.indexOf(10);
		if (!back.subarray(bnl < 0 ? back.length : bnl).equals(body) || JSON.parse(back.subarray(0, bnl < 0 ? back.length : bnl).toString()).cwd !== dstCwd)
			throw new Error("session verification failed after write");
		return target;
	}

	const methods: Record<string, (p: any, from: string) => Promise<any>> = {
		"task.handoff": async (p) => {
			const t = d.tasks.get(p.id);
			if (!t) throw d.httpError(404, `no such task on ${d.self}: ${p.id}`);
			return start(t, {
				to: p.to ?? p.machine,
				cwd: p.cwd ? String(p.cwd) : undefined,
				noWorkspace: !!p.noWorkspace,
				abort: !!p.abort,
				waitSec: p.waitSec !== undefined ? Number(p.waitSec) : undefined,
				onConflict: ["fail", "stash", "backup"].includes(p.onConflict) ? p.onConflict : "fail",
				testFail: process.env.QA_TEST_HOOKS ? p.testFail : undefined,
			});
		},

		"handoff.probe": async (p) => {
			const sub = String(p.sub ?? "");
			const srcRoot = String(p.srcRoot);
			let candidates: string[];
			// Explicit --cwd wins; then the cwd this task had when it was on this machine before.
			const explicit = !!p.explicitCwd || !!p.historyCwd;
			if (explicit) {
				let root = expandHome(String(p.explicitCwd || p.historyCwd));
				if (sub) {
					if (!root.endsWith(`/${sub}`)) throw new Error(`源工作目录是仓库 ${srcRoot} 的子目录 ${sub}，--cwd 必须是目标机器上同一子目录（以 /${sub} 结尾）`);
					root = root.slice(0, -sub.length - 1);
				}
				candidates = [root];
			} else {
				const fromProjects: string[] = [];
				for (const sp of (p.srcProjects ?? []) as ProjectRule[])
					if (within(srcRoot, sp.cwd))
						for (const tp of d.projects()) if (tp.match === sp.match) fromProjects.push(join(tp.cwd, relative(sp.cwd, srcRoot)));
				const others = [within(srcRoot, String(p.srcHome)) ? join(homedir(), relative(String(p.srcHome), srcRoot)) : "", srcRoot].filter(Boolean);
				// Project mapping is authoritative; otherwise prefer a path that already exists.
				const pool = fromProjects.length ? fromProjects : others;
				candidates = [...new Set([...pool.filter((c) => existsSync(c)), ...pool])];
			}
			const busyList = [...d.tasks.values()].filter((t) => ACTIVE_STATUSES.includes(t.status) || t.status === "handoff").map((t) => ({ id: t.id, cwd: t.cwd }));
			const departed = readDeparted();
			return planTarget({
				taskId: String(p.taskId),
				mode: p.mode,
				sub,
				head: p.head,
				branch: p.branch,
				candidates,
				explicit,
				onConflict: p.onConflict ?? "fail",
				exclude: p.exclude ?? [],
				busy: busyList,
				departed: (root) => departed[`${p.taskId}|${root}`]?.digest,
			});
		},

		"handoff.begin": async (p, from) => {
			const xfer = String(p.xfer);
			if (!/^[\w-]+$/.test(xfer)) throw new Error("bad transfer id");
			if (d.tasks.has(p.taskId)) throw new Error(`task ${p.taskId} already exists on ${d.self}`);
			const dir = join(IN_DIR, xfer);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			const files = new Map<string, { size: number; sha: string }>();
			for (const f of p.files ?? []) {
				const name = String(f.name);
				if (name.includes("..") || name.startsWith("/")) throw new Error(`bad file name ${name}`);
				files.set(name, { size: Number(f.size), sha: String(f.sha) });
				mkdirSync(dirname(join(dir, name)), { recursive: true });
				writeFileSync(join(dir, name), "");
			}
			const i: Incoming = { xfer, taskId: String(p.taskId), from, dir, files, timer: setTimeout(() => void undoIncoming(i), 30 * 60_000) };
			incoming.set(xfer, i);
			return { ok: true };
		},

		"handoff.chunk": async (p) => {
			const i = inc(p.xfer);
			const f = i.files.get(String(p.name));
			if (!f) throw new Error(`unexpected file ${p.name}`);
			const path = join(i.dir, String(p.name));
			if (statSync(path).size !== Number(p.offset)) throw new Error(`chunk offset mismatch for ${p.name}`);
			appendFileSync(path, Buffer.from(String(p.data), "base64"));
			return { ok: true };
		},

		"handoff.apply": async (p) => {
			const i = inc(p.xfer);
			try {
				for (const [name, f] of i.files) {
					const path = join(i.dir, name);
					const size = statSync(path).size;
					if (size !== f.size || sha256File(path) !== f.sha || (p.testFail === "checksum" && name === "session.jsonl"))
						throw new Error(`传输校验失败：${name}（大小 ${size}/${f.size}，sha256 不一致）`);
				}
				const plan = p.plan as Plan;
				const snap = p.snap as Snapshot | undefined;
				let sessionFile: string | undefined;
				if (snap) {
					i.undo = { root: plan.root };
					await applyWorkspace(snap, plan, join(i.dir, "ws"), i.taskId, i.undo);
					if (p.testFail === "verify") {
						const first = Object.keys(snap.manifest.files).find((k) => snap.manifest.files[k]!.startsWith("f:"));
						if (first) appendFileSync(join(plan.root, first), "corrupted by test hook\n");
					}
					await verifyWorkspace(snap, plan);
				}
				if (i.files.has("session.jsonl")) sessionFile = placeSession(i, plan.cwd, String(p.sessionName ?? `${i.taskId}.jsonl`));
				i.applied = { snap, plan, sessionFile, srcCwd: String(p.srcCwd) };
				return { sessionFile, cwd: plan.cwd, notes: plan.notes };
			} catch (e) {
				await undoIncoming(i);
				throw e;
			}
		},

		"handoff.start": async (p, from) => {
			const i = inc(p.xfer);
			if (!i.applied) throw new Error("handoff not applied yet");
			const src = p.task as Task;
			const { plan, sessionFile } = i.applied;
			const tdir = d.taskDir(src.id);
			const tbak = existsSync(tdir) ? `${tdir}.qa-bak-${i.xfer}` : undefined;
			let registered = false;
			let moved = false;
			try {
				if (p.testFail === "start") throw new Error("test hook: start failure");
				if (tbak) renameSync(tdir, tbak);
				moved = true;
				mkdirSync(tdir, { recursive: true });
				const srcTaskDir = String(p.srcTaskDir);
				for (const name of i.files.keys()) {
					if (!name.startsWith("task/")) continue;
					const dst = join(tdir, name.slice(5));
					mkdirSync(dirname(dst), { recursive: true });
					cpSync(join(i.dir, name), dst);
				}
				const rewrite = (s: string) => s.split(`${srcTaskDir}/`).join(`${tdir}/`);
				if (existsSync(join(tdir, "brief.md"))) writeFileSync(join(tdir, "brief.md"), rewrite(readFileSync(join(tdir, "brief.md"), "utf8")));
				writeFileSync(join(tdir, "events.jsonl"), String(p.events ?? ""));
				const mode = String(p.mode) as "run" | "idle" | "closed";
				const nt: Task = {
					...src,
					machine: d.self,
					cwd: plan.cwd,
					brief: rewrite(src.brief),
					attachments: (src.attachments ?? []).map(rewrite),
					sessionFile: sessionFile ?? undefined,
					epoch: (src.epoch ?? 0) + 1,
					rev: (src.rev ?? 0) + 1,
					tmuxTarget: undefined,
					closed: mode === "closed",
					handoff: undefined,
					handoffs: [...(src.handoffs ?? []), { from, to: d.self, fromCwd: i.applied.srcCwd, toCwd: plan.cwd, at: Date.now() }],
					pendingNote: mode === "run" ? undefined : String(p.note),
					activity: mode === "closed" ? `已从 ${from} 交接过来（窗口已关闭，追加指令即可在本机恢复会话）` : `已从 ${from} 交接过来`,
				};
				d.saveTask(nt);
				d.tasks.set(nt.id, nt);
				d.mirrorTasks.delete(nt.id);
				registered = true;
				if (mode === "run") await d.spawnWorker(nt, { resumeMessage: String(p.note) });
				else if (mode === "idle") await d.spawnWorker(nt, { idle: true, status: src.status });
			} catch (e) {
				if (registered) d.tasks.delete(src.id);
				if (moved) {
					rmSync(tdir, { recursive: true, force: true });
					if (tbak) renameSync(tbak, tdir);
				}
				await undoIncoming(i);
				throw e;
			}
			// Point of no return.
			clearTimeout(i.timer);
			if (tbak) rmSync(tbak, { recursive: true, force: true });
			if (i.undo) await finalizeWorkspace(i.undo).catch(() => {});
			if (i.session?.backup && i.session.dropBackup) rmSync(i.session.backup, { force: true });
			rmSync(i.dir, { recursive: true, force: true });
			incoming.delete(i.xfer);
			const nt = d.tasks.get(src.id)!;
			d.log(`[handoff] received ${nt.id} from ${from} (${plan.cwd})`);
			return d.update(nt, {}, { kind: "handoff", text: `交接完成 ${from} → ${d.self}（${i.applied.srcCwd} → ${plan.cwd}）` });
		},

		"handoff.abort": async (p) => {
			const i = incoming.get(String(p.xfer));
			if (!i) return { ok: true, note: "nothing to undo" };
			const errs = await undoIncoming(i);
			return { ok: errs.length === 0, errors: errs };
		},
	};

	return { methods, onReport, interceptMessage, busy, recoverOnLoad };
}
