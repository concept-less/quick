// Watchdog (巡检) in the hub: keeps the active-time clock and the expectation of own tasks, checks them on a
// timer, and runs an independent, read-only reviewer agent when a task looks off (over time, no progress,
// repeated pattern). The verdict is applied without bothering the human unless a decision is truly needed:
//   ON_TRACK                         → new expectation, one quiet line in the task's 巡检 list
//   DRIFTING / STUCK / BAD_APPROACH  → correction sent to the worker (normal message path); again → human
//   NEEDS_HUMAN                      → Task.watch.pending → 需要你 (shared/attention.ts)
// The reviewer never edits code and never stops a task: only read/grep/find/ls tools, and the hub only
// ever sends it a message. Stopping is the human's call. Design: docs/watchdog.md.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Task, TaskEvent } from "../shared/types.ts";
import {
	ACTIVE_CLOCK,
	clockOnStatus,
	decideAction,
	defaultExpected,
	detectRepeats,
	EXPECT_SOURCE_LABEL,
	elapsedMs,
	fmtMinutes,
	lastProgressAt,
	markTriggered,
	parseExpected,
	parseToolCalls,
	parseVerdict,
	planMinutes,
	recordReview,
	reviewLine,
	type RepeatSignal,
	type ToolCallRecord,
	type Trigger,
	TRIGGER_LABEL,
	triggerFor,
	VERDICT_LABEL,
	type WatchdogConfig,
	type WatchReview,
} from "../shared/watchdog.ts";

const run = promisify(execFile);

export interface WatchdogDeps {
	tasks: Map<string, Task>;
	config(): WatchdogConfig;
	/** Default model of workers (reviewer fallback). */
	defaultModel(): string;
	taskDir(id: string): string;
	update(t: Task, patch: Partial<Task>, ev?: Omit<TaskEvent, "ts" | "taskId">): Task;
	/** Send a message to the worker through the normal path (追加指令). */
	deliverMessage(t: Task, text: string, opts: { watchdog: true }): Promise<void>;
	log(msg: string): void;
	httpError(status: number, msg: string): Error;
}

export const REVIEWER_SYSTEM = `你是 quick-agent 的巡检员（watchdog）。一个 worker agent 正在独立负责一个任务，它的实际耗时超出了预期、或者长时间没有进展、或者出现了重复模式。你的工作是独立、快速地审视它，判断它是否需要纠偏。

规则：
- 你只读：只能用 read / grep / find / ls 看材料和工作目录，不能修改任何文件、不能执行命令、不能中止任务。
- 判断要有依据：引用具体的命令、错误、文件或步骤。
- 宁可判 ON_TRACK 也不要误报。任务只是比预估难、但在稳步推进（每次尝试都有新信息、改动在收敛），就是 ON_TRACK，并给出新的总预估。
- DRIFTING：做的事偏离了任务简报的目标、范围或约束（例如做了简报没要求的大改动、换了目标、违反约束）。
- STUCK：死胡同或循环：反复执行同一条命令得到同样的结果、同一个错误反复出现、来回改同一处、无限轮询或等待、长时间卡在一个不会结束的命令上。
- BAD_APPROACH：方法本身有问题（例如改测试凑通过、绕过而不是修复根因、用错工具或错误的层次去解决、用低效的方式做本可直接做的事）。必须给出具体的替代方案。
- NEEDS_HUMAN：只有当缺少只有人类才有的信息、权限或凭证，或者存在必须由人拍板的取舍时才用。worker 自己能合理决定的不算。
- advice 是直接发给 worker 的纠偏建议：具体、可执行、两三句话以内。
- 不要使用 emoji。

你没有任何汇报或沟通工具：你的回答（标准输出）由 hub 读取和解析，hub 再决定是否纠偏或请人决定。
输出：先用几句话写你的分析，最后一行只输出一个 JSON 对象（不要代码块）：
{"verdict":"ON_TRACK|DRIFTING|STUCK|BAD_APPROACH|NEEDS_HUMAN","evidence":"依据，一到三句","advice":"给 worker 的建议（ON_TRACK 可为空）","expected":"新的总预估，例如 45m（ON_TRACK 必填）","question":"NEEDS_HUMAN 时问人类的一句话","options":["选项A","选项B"]}`;

interface CallCache {
	mtime: number;
	size: number;
	calls: ToolCallRecord[];
	repeats: RepeatSignal[];
}

/** Last `bytes` of a file (the first, possibly cut, line is dropped by the parser). */
function readTail(file: string, bytes: number): string {
	const st = statSync(file);
	const len = Math.min(bytes, st.size);
	const buf = Buffer.alloc(len);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buf, 0, len, st.size - len);
	} finally {
		closeSync(fd);
	}
	return buf.toString("utf8");
}

/** Run a command with stdin closed (pi -p would otherwise wait for piped input) and a hard timeout; resolves stdout. */
function runOut(cmd: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> {
	return new Promise((resolveP, reject) => {
		const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, o.timeoutMs);
		child.stdout.on("data", (b) => {
			if (out.length < 8 * 1024 * 1024) out += b;
		});
		child.stderr.on("data", (b) => {
			if (err.length < 64 * 1024) err += b;
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (killed) return reject(Object.assign(new Error("timeout"), { killed: true }));
			if (code !== 0) return reject(new Error(`reviewer exited with code ${code}: ${(err || out).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`));
			resolveP(out);
		});
	});
}

/**
 * Environment of the reviewer: no quick-agent identity at all. Every QA_* variable (QA_TASK_ID, QA_HUB_URL,
 * QA_TOKEN, QA_HOME, QA_PORT, QA_FRONT_ID …) is dropped so it can neither act as a worker nor reach any hub;
 * QA_WATCH_TASK marks it as the reviewer (extensions/quick-agent.ts then loads no role).
 */
export function reviewerEnv(base: NodeJS.ProcessEnv, taskId: string, trigger: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(base)) if (!k.startsWith("QA_")) env[k] = v;
	return { ...env, NODE_NO_WARNINGS: "1", QA_WATCH_TASK: taskId, QA_WATCH_TRIGGER: trigger };
}

export function createWatchdog(d: WatchdogDeps) {
	const cache = new Map<string, CallCache>();
	const inflight = new Set<string>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let tickSeconds = 0;

	// ------------------------------------------------------------ clock + expectation

	/** Fields of a new task: expectation (dispatch or default), clock, per-task switch. */
	function onCreate(t: Task, body: any) {
		const cfg = d.config();
		const now = Date.now();
		let minutes: number | undefined;
		let source: "dispatch" | "default" = "dispatch";
		let reason: string | undefined;
		if (body.expected !== undefined && body.expected !== null && body.expected !== "") {
			try {
				minutes = parseExpected(body.expected);
			} catch (e) {
				throw d.httpError(400, `invalid expected: ${(e as Error).message} (examples: 20m, 1h30m)`);
			}
		}
		if (minutes === undefined) {
			const def = defaultExpected(t, cfg);
			minutes = def.minutes;
			source = "default";
			reason = `没有派单预估，按「${{ small: "小改动", normal: "普通任务", large: "大任务", cron: "定时任务" }[def.kind]}」默认`;
		}
		t.expect = { minutes, source, reason, at: now, initial: minutes };
		t.clock = { activeMs: 0, activeSince: ACTIVE_CLOCK.includes(t.status) ? now : undefined, progressAt: now };
		if (body.watch === false || body.watchdog === false) t.watch = { off: true, reviews: [] };
	}

	/** Called by the hub's update() before a patch is applied: clock, progress time, escalation lifetime. */
	function beforeUpdate(t: Task, patch: Partial<Task>, ev?: Omit<TaskEvent, "ts" | "taskId">) {
		const now = Date.now();
		if (patch.status && patch.status !== t.status) {
			patch.clock = clockOnStatus(patch.clock ?? t.clock ?? initialClock(t), t.status, patch.status, now);
			// The task stopped: an open escalation is moot (whatever it stopped with is the new attention).
			if (!ACTIVE_CLOCK.includes(patch.status) && t.watch?.pending && !patch.watch) patch.watch = { ...t.watch, pending: undefined };
		}
		// (Progress records count through their own updatedAt, see lastProgressAt; activity pings do not count.)
		const progressed = (typeof patch.summary === "string" && patch.summary !== t.summary) || ev?.kind === "message" || ev?.kind === "report";
		if (progressed && !(patch.status && patch.status !== t.status)) patch.clock = { ...(patch.clock ?? t.clock ?? initialClock(t)), progressAt: now };
	}

	function initialClock(t: Task) {
		return { activeMs: 0, activeSince: ACTIVE_CLOCK.includes(t.status) ? (t.statusSince ?? t.createdAt) : undefined, progressAt: t.updatedAt };
	}

	/** Tasks loaded from disk: stale "review running" flags from a previous hub, missing clocks. */
	function onLoad(t: Task) {
		if (t.watch?.running) t.watch = { ...t.watch, running: undefined };
		if (!t.clock) t.clock = initialClock(t);
	}

	/** Worker revision (qa_expect): once per task, with a reason. */
	function workerExpect(t: Task, raw: any): Partial<Task> {
		const reason = String(raw?.reason ?? "").trim();
		if (!reason) throw d.httpError(400, "修正预期必须给出理由（reason）");
		if (t.expect?.workerRevised) throw d.httpError(409, `预期已经修正过一次（${fmtMinutes(t.expect.minutes)}：${t.expect.reason ?? ""}）；超时后巡检会重新评估`);
		let minutes: number;
		try {
			minutes = parseExpected(raw.expected ?? raw.minutes);
		} catch (e) {
			throw d.httpError(400, `invalid expected: ${(e as Error).message} (examples: 20m, 1h30m)`);
		}
		const prev = t.expect;
		return {
			expect: { minutes, source: "worker", reason: reason.slice(0, 300), at: Date.now(), initial: prev?.initial ?? prev?.minutes, workerRevised: true },
			watch: t.watch ? { ...t.watch, overLevel: 0 } : t.watch,
		};
	}

	// ------------------------------------------------------------ human side

	/** A human message to the worker: answers an escalation (with its context) and resets the correction count. */
	function onHumanMessage(t: Task, text: string): string {
		const w = t.watch;
		if (!w) return text;
		const pending = w.pending;
		t.watch = { ...w, pending: undefined, corrections: 0, followupDue: false };
		if (!pending) return text;
		return `（这是对巡检问题的回答。巡检问题：${pending.question}${pending.advice ? `；巡检建议：${pending.advice}` : ""}）\n${text}`;
	}

	/** 知道了 on an escalation: the human saw it and lets the worker carry on. */
	function onAck(t: Task): Partial<Task> {
		return t.watch?.pending ? { watch: { ...t.watch, pending: undefined, corrections: 0 } } : {};
	}

	// ------------------------------------------------------------ detection

	function repeatsOf(t: Task, cfg: WatchdogConfig): CallCache | undefined {
		const f = t.sessionFile;
		if (!f || !existsSync(f)) return undefined;
		try {
			const st = statSync(f);
			const c = cache.get(t.id);
			if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
			const calls = parseToolCalls(readTail(f, 768 * 1024));
			const next = { mtime: st.mtimeMs, size: st.size, calls, repeats: detectRepeats(calls, cfg.repeatThreshold, cfg.repeatWindow) };
			cache.set(t.id, next);
			return next;
		} catch {
			return undefined;
		}
	}

	function tick() {
		const cfg = d.config();
		if (cfg.tickSeconds !== tickSeconds) start();
		if (!cfg.enabled) return;
		const now = Date.now();
		for (const t of d.tasks.values()) {
			if (t.status !== "running" || (t.lifecycle?.workspace && !["developing","changes_requested"].includes(t.lifecycle.phase))) {
				cache.delete(t.id);
				continue;
			}
			if (inflight.size >= cfg.maxConcurrent) return;
			if (inflight.has(t.id)) continue;
			const trig = triggerFor(t, cfg, now, repeatsOf(t, cfg)?.repeats);
			if (trig) void review(t, trig);
		}
	}

	// ------------------------------------------------------------ the review

	async function gitState(cwd: string): Promise<string> {
		const g = async (...args: string[]) => {
			try {
				const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
				return stdout.trim();
			} catch {
				return "";
			}
		};
		const [branch, status, stat, log] = await Promise.all([g("rev-parse", "--abbrev-ref", "HEAD"), g("status", "--short"), g("diff", "--stat", "HEAD"), g("log", "--oneline", "-5")]);
		if (!branch && !status) return "(不是 git 仓库或无法读取)";
		const cut = (s: string, n: number) => (s.split("\n").length > n ? `${s.split("\n").slice(0, n).join("\n")}\n…` : s);
		return [`分支: ${branch}`, `最近提交:\n${log || "(无)"}`, `git status --short:\n${cut(status, 60) || "(干净)"}`, `git diff --stat HEAD:\n${cut(stat, 40) || "(无)"}`].join("\n");
	}

	function promptFor(t: Task, trig: Trigger, calls: ToolCallRecord[], repeats: RepeatSignal[], git: string): string {
		const now = Date.now();
		const elapsed = elapsedMs(t, now) / 60_000;
		const exp = t.expect;
		const progress = (t as any).progress;
		const recent = calls.slice(-40).map((c, i) => `${i + 1}. ${new Date(c.ts).toLocaleTimeString()} ${c.isError ? "[ERROR] " : ""}${c.text}\n   → ${c.result.slice(-300) || "(无输出)"}`);
		const history = (t.watch?.reviews ?? []).slice(-5).map((r) => `- ${new Date(r.at).toLocaleTimeString()} ${reviewLine(r)}${r.advice ? `\n  当时的建议：${r.advice}` : ""}`);
		const plan = planMinutes(t);
		return [
			`# 巡检材料：任务 ${t.id}「${t.title}」`,
			"",
			"## 为什么巡检",
			`${TRIGGER_LABEL[trig.kind]}：${trig.detail}`,
			"",
			"## 时间",
			`已用（worker 实际工作时间）: ${fmtMinutes(elapsed)}`,
			`预期: ${exp ? `${fmtMinutes(exp.minutes)}（${EXPECT_SOURCE_LABEL[exp.source]}${exp.reason ? `：${exp.reason}` : ""}${exp.initial && exp.initial !== exp.minutes ? `；最初 ${fmtMinutes(exp.initial)}` : ""}）` : "(无)"}`,
			plan ? `worker 计划里各步骤预估合计: ${fmtMinutes(plan)}` : "",
			`距上次进展: ${fmtMinutes((now - lastProgressAt(t)) / 60_000)}`,
			"",
			"## 任务简报",
			t.brief,
			"",
			"## worker 的进度",
			progress ? "```json\n" + JSON.stringify(progress, null, 1).slice(0, 4000) + "\n```" : "(worker 没有上报进度计划)",
			`最新汇报: ${t.summary ? t.summary.slice(0, 2000) : "(无)"}`,
			`当前活动: ${t.activity ?? "(无)"}`,
			"",
			"## 检测到的重复模式",
			repeats.length ? repeats.map((r) => `- ${r.detail}`).join("\n") : "(无)",
			"",
			`## 最近的工具调用和输出（最近 ${recent.length} 条，旧的在前）`,
			recent.length ? recent.join("\n") : "(读不到 worker 的工具记录)",
			"",
			"## 工作区状态",
			`工作目录: ${t.cwd}`,
			git,
			"",
			"## 之前的巡检",
			history.length ? history.join("\n") : "(第一次巡检)",
			"",
			t.sessionFile ? `需要更多细节时，worker 的完整内部记录（JSONL，很长，从末尾读）在：${t.sessionFile}` : "",
			"",
			"按系统提示的要求给出结论，最后一行输出 JSON。",
		]
			.filter((l) => l !== "")
			.join("\n");
	}

	async function runReviewer(t: Task, promptFile: string, trig: Trigger): Promise<string> {
		const cfg = d.config();
		const env = reviewerEnv(process.env, t.id, trig.kind);
		const cwd = existsSync(t.cwd) ? t.cwd : undefined;
		const timeoutMs = cfg.timeoutMinutes * 60_000;
		if (cfg.command) return runOut(cfg.command[0]!, [...cfg.command.slice(1), promptFile], { cwd, env, timeoutMs });
		const args = ["-p", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--tools", "read,grep,find,ls", "--model", cfg.model ?? d.defaultModel()];
		if (cfg.thinking) args.push("--thinking", cfg.thinking);
		args.push("--system-prompt", REVIEWER_SYSTEM, `@${promptFile}`, "审视这个任务，按要求给出结论。");
		return runOut(cfg.piBin ?? "pi", args, { cwd, env, timeoutMs });
	}

	async function review(t0: Task, trig: Trigger) {
		const cfg = d.config();
		const t = d.tasks.get(t0.id);
		if (!t || inflight.has(t.id)) return;
		inflight.add(t.id);
		const started = Date.now();
		d.update(t, { watch: markTriggered(t, trig, cfg, started) });
		d.log(`[watchdog] ${t.id}: ${TRIGGER_LABEL[trig.kind]} — ${trig.detail}`);
		const base: WatchReview = { at: started, trigger: trig.kind, detail: trig.detail, action: "error" };
		let review: WatchReview = base;
		let plan: ReturnType<typeof decideAction> | undefined;
		try {
			const c = repeatsOf(t, cfg);
			const dir = join(d.taskDir(t.id), "watch");
			mkdirSync(dir, { recursive: true });
			const n = (t.watch?.reviews?.length ?? 0) + 1;
			const promptFile = join(dir, `${started}-prompt.md`);
			writeFileSync(promptFile, promptFor(t, trig, c?.calls ?? [], c?.repeats ?? [], await gitState(t.cwd)));
			const out = await runReviewer(t, promptFile, trig);
			writeFileSync(join(dir, `${started}-output.txt`), out);
			const r = parseVerdict(out);
			if (!r) throw new Error(`巡检没有给出可解析的结论（输出 ${out.length} 字节，见 tasks/${t.id}/watch/）`);
			const cur = d.tasks.get(t.id) ?? t;
			// The task may have finished or been answered while the review ran: a stale verdict is only recorded.
			const stillActive = (cur.status === "running" || cur.status === "starting") && (!cur.lifecycle?.workspace || ["developing","changes_requested"].includes(cur.lifecycle.phase));
			plan = stillActive ? decideAction(cur, r, cfg, Date.now()) : undefined;
			review = { ...base, verdict: r.verdict, evidence: r.evidence, advice: r.advice, expected: plan?.expect ?? r.expected, action: plan?.action ?? "silent", durationMs: Date.now() - started };
			void n;
		} catch (e) {
			const msg = (e as Error & { killed?: boolean }).killed ? `巡检超时（${cfg.timeoutMinutes} 分钟）` : String((e as Error).message).split("\n")[0]!.slice(0, 300);
			review = { ...base, action: "error", error: msg, durationMs: Date.now() - started };
			d.log(`[watchdog] ${t.id}: review failed: ${msg}`);
		} finally {
			inflight.delete(t.id);
		}
		const cur = d.tasks.get(t.id);
		if (!cur) return;
		const patch: Partial<Task> = { watch: recordReview(cur, review, plan) };
		if (plan?.action === "silent" && plan.expect !== undefined) {
			patch.expect = { ...(cur.expect ?? { initial: plan.expect }), minutes: plan.expect, source: "watchdog", reason: review.evidence?.slice(0, 300), at: Date.now() } as Task["expect"];
		}
		const text = review.verdict ? `${reviewLine(review)}${review.evidence ? ` — ${review.evidence}` : ""}` : `巡检失败：${review.error}`;
		d.update(cur, patch, { kind: "watch", text, by: "watchdog" });
		d.log(`[watchdog] ${t.id}: ${review.verdict ?? "ERROR"} → ${review.action}`);
		if (plan?.action === "corrected" && plan.message) await d.deliverMessage(cur, plan.message, { watchdog: true }).catch((e) => d.log(`[watchdog] ${t.id}: correction not delivered: ${e.message}`));
	}

	// ------------------------------------------------------------ methods + timer

	const methods: Record<string, (p: any) => Promise<any>> = {
		/** Per-task switch / manual review: { id, off?: boolean, now?: true }. */
		"task.watch": async (p) => {
			const t = d.tasks.get(String(p.id));
			if (!t) throw d.httpError(404, `no such task: ${p.id}`);
			if (typeof p.off === "boolean") d.update(t, { watch: { reviews: [], ...t.watch, off: p.off } }, { kind: "watch", text: p.off ? "巡检已关闭" : "巡检已开启", by: p.by });
			if (p.expected !== undefined) {
				let minutes: number;
				try {
					minutes = parseExpected(p.expected);
				} catch (e) {
					throw d.httpError(400, `invalid expected: ${(e as Error).message}`);
				}
				d.update(t, { expect: { ...(t.expect ?? { initial: minutes }), minutes, source: "dispatch", reason: `由 ${p.by ?? "人"} 设置`, at: Date.now() } as Task["expect"], watch: t.watch ? { ...t.watch, overLevel: 0 } : t.watch }, { kind: "expect", text: `预期设为 ${fmtMinutes(minutes)}`, by: p.by });
			}
			if (p.now) {
				if (inflight.has(t.id)) throw d.httpError(409, "巡检已经在进行");
				if (!["running", "starting"].includes(t.status)) throw d.httpError(409, `任务不在运行（${t.status}）`);
				const elapsed = fmtMinutes(elapsedMs(t) / 60_000);
				void review(t, { kind: "manual", detail: `手动发起（已用 ${elapsed}）` });
			}
			return d.tasks.get(t.id);
		},
	};

	function start() {
		if (timer) clearInterval(timer);
		tickSeconds = d.config().tickSeconds;
		timer = setInterval(() => {
			try {
				tick();
			} catch (e) {
				d.log(`[watchdog] tick failed: ${(e as Error).message}`);
			}
		}, tickSeconds * 1000);
		timer.unref?.();
	}

	return { onCreate, beforeUpdate, onLoad, workerExpect, onHumanMessage, onAck, tick, start, methods, review, verdictLabel: VERDICT_LABEL };
}
