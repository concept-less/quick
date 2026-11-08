// Task progress: a step list the worker reports (qa_progress) plus a human-readable "now" line.
// Pure functions shared by the hub (ingest), the attention model, the CLI, the front and the tests.
//
// Two sources:
//  - the worker's own plan: steps (done / active / todo), a one-line note, optional percent / eta;
//  - fallback for workers that never report a plan (older workers, short tasks): the raw tool activity
//    ("bash cd … && git push") is translated into plain words ("推送代码") and the significant ones are kept
//    as recent milestones.
// Progress never touches attention levels and never notifies; it is only shown where the human looks.
import type { Task } from "./types.ts";

export type StepState = "done" | "active" | "todo";
export interface ProgressStep {
	title: string;
	state: StepState;
	/** Worker's own estimate for this step (minutes), optional. */
	expectedMinutes?: number;
}
export interface Milestone {
	ts: number;
	text: string;
}
export interface TaskProgress {
	/** The worker's plan (absent = the worker never reported one; fall back to `now`). */
	steps?: ProgressStep[];
	/** The worker's own one-line explanation of where things are. */
	note?: string;
	noteAt?: number;
	/** 0–100, optional. */
	percent?: number;
	/** Free-form remaining time estimate ("约 10 分钟"). */
	eta?: string;
	/** Current tool activity in plain words (automatic). */
	now?: string;
	nowAt?: number;
	/** Recent milestones, oldest first (step completions, significant tool activity). */
	recent?: Milestone[];
	/** When this run of work started. */
	startedAt: number;
	/** Last substantive change (plan / step / note / percent / eta). Activity pings do NOT bump it (they set nowAt). */
	updatedAt: number;
}

/** What a worker may send (qa_progress / report body `progress`). */
export interface ProgressInput {
	/** Full plan, 1–12 short step titles (or {title, expected_minutes}); replaces the old plan (states of unchanged titles are kept). */
	plan?: (string | { title: string; expected_minutes?: number; expectedMinutes?: number })[];
	/** 1-based index of the step being worked on now: earlier steps become done, later ones todo. 0 = none started; > length = all done. */
	current?: number;
	/** 1-based indices to mark done explicitly (non-linear plans). */
	done?: number[];
	note?: string;
	percent?: number;
	eta?: string;
}

export const MAX_STEPS = 12;
export const MAX_RECENT = 6;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Merge a worker report into the stored progress. Returns the new progress and the milestone texts it produced. */
export function applyProgress(prev: TaskProgress | undefined, input: ProgressInput, now = Date.now()): { progress: TaskProgress; milestones: string[] } {
	const p: TaskProgress = prev ? { ...prev, steps: prev.steps?.map((s) => ({ ...s })), recent: prev.recent?.slice() } : { startedAt: now, updatedAt: now };
	const before = new Map((prev?.steps ?? []).map((s) => [s.title, s.state]));
	const milestones: string[] = [];
	if (Array.isArray(input.plan)) {
		const items = input.plan
			.map((x) => {
				const o = typeof x === "object" && x ? x : { title: x as string };
				const title = clip(o.title, 60);
				const em = Number((o as any).expected_minutes ?? (o as any).expectedMinutes);
				const step: ProgressStep = { title, state: before.get(title) ?? "todo" };
				if (Number.isFinite(em) && em > 0) step.expectedMinutes = Math.round(em * 10) / 10;
				return step;
			})
			.filter((x) => x.title)
			.slice(0, MAX_STEPS);
		p.steps = items.length ? items : undefined;
	}
	if (p.steps?.length) {
		if (typeof input.current === "number" && Number.isFinite(input.current)) {
			const cur = Math.round(input.current);
			p.steps.forEach((s, k) => (s.state = k + 1 < cur ? "done" : k + 1 === cur ? "active" : "todo"));
		}
		for (const d of Array.isArray(input.done) ? input.done : []) {
			const s = p.steps[Math.round(Number(d)) - 1];
			if (s) s.state = "done";
		}
		for (const s of p.steps) if (s.state === "done" && before.get(s.title) !== "done") milestones.push(`完成：${s.title}`);
	}
	if (typeof input.note === "string" && input.note.trim()) {
		p.note = clip(input.note, 200);
		p.noteAt = now;
	}
	if (input.percent !== undefined && input.percent !== null) {
		const n = Number(input.percent);
		p.percent = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined;
	}
	if (typeof input.eta === "string") p.eta = clip(input.eta, 40) || undefined;
	for (const m of milestones) pushMilestone(p, m, now);
	p.updatedAt = now;
	return { progress: p, milestones };
}

/** Record a raw tool activity: updates `now`/`nowAt` and keeps significant actions as milestones. Never bumps updatedAt (no-progress detection relies on that). */
export function applyActivity(prev: TaskProgress | undefined, activity: string, now = Date.now()): TaskProgress | undefined {
	const h = humanizeActivity(activity);
	if (!h.text) return prev;
	const p: TaskProgress = prev ? { ...prev, recent: prev.recent?.slice() } : { startedAt: now, updatedAt: now };
	p.now = h.text;
	p.nowAt = now;
	if (h.milestone) pushMilestone(p, h.text, now);
	return p;
}

function pushMilestone(p: TaskProgress, text: string, ts: number) {
	const r = (p.recent ??= []);
	// Same action again within the last few (edit a.ts, run tests, edit a.ts …): refresh instead of repeating.
	const k = r.slice(-3).findIndex((m) => m.text === text);
	if (k >= 0) r.splice(r.length - Math.min(3, r.length) + k, 1);
	r.push({ ts, text });
	if (r.length > MAX_RECENT) r.splice(0, r.length - MAX_RECENT);
}

/** A new run after the plan was finished (done / cancelled): start a fresh progress, keep nothing stale. */
export function restartProgress(now = Date.now()): TaskProgress {
	return { startedAt: now, updatedAt: now };
}

/** Task reported done: the plan is complete. */
export function finishProgress(p: TaskProgress | undefined, now = Date.now()): TaskProgress | undefined {
	if (!p) return p;
	const q: TaskProgress = { ...p, steps: p.steps?.map((s) => ({ ...s, state: "done" as StepState })), updatedAt: now };
	if (q.percent !== undefined) q.percent = 100;
	q.eta = undefined;
	return q;
}

export function stepCounts(p?: TaskProgress): { done: number; total: number; active?: ProgressStep; index: number } {
	const steps = p?.steps ?? [];
	const done = steps.filter((s) => s.state === "done").length;
	const ai = steps.findIndex((s) => s.state === "active");
	const next = ai >= 0 ? ai : steps.findIndex((s) => s.state !== "done");
	return { done, total: steps.length, active: next >= 0 ? steps[next] : undefined, index: next >= 0 ? next + 1 : steps.length };
}

/** One short line for cards, lists and the attention reason: "3/6 发布 Release" or "推送代码". */
export function progressLine(t: Pick<Task, "progress" | "activity">): string {
	const p = t.progress;
	const c = stepCounts(p);
	if (c.total) return c.active ? `${c.index}/${c.total} ${c.active.title}` : `${c.total}/${c.total} 收尾`;
	return p?.now || humanizeActivity(t.activity ?? "").text;
}

/** Multi-line plain-text rendering (quick show, qa_task_read). */
export function progressText(t: Pick<Task, "progress" | "activity" | "statusSince" | "createdAt"> & { status?: Task["status"] }, now = Date.now()): string {
	const p = t.progress;
	const active = !t.status || ["starting", "running", "handoff"].includes(t.status);
	const lines: string[] = [];
	for (const s of p?.steps ?? []) lines.push(`${STEP_MARK[s.state]} ${s.title}`);
	const doing = active ? p?.now || humanizeActivity(t.activity ?? "").text : "";
	const cur = p?.note || doing;
	if (cur) lines.push(`${active ? "当前" : "最后说明"}：${cur}${p?.note && doing && doing !== p.note ? `（此刻：${doing}）` : ""}`);
	const start = p?.startedAt ?? t.statusSince ?? t.createdAt;
	const meta = [active ? `已用 ${duration(now - start)}` : `用时 ${duration((t.statusSince ?? now) - start)}`];
	if (active && p?.percent !== undefined) meta.push(`${p.percent}%`);
	if (active && p?.eta) meta.push(`预计还要 ${p.eta}`);
	if (active && p?.updatedAt) meta.push(`更新于 ${duration(now - p.updatedAt)}前`);
	lines.push(meta.join(" · "));
	if (active && p?.recent?.length) lines.push(`最近：${p.recent.slice(-4).map((m) => m.text).join(" / ")}`);
	return lines.join("\n");
}

export const STEP_MARK: Record<StepState, string> = { done: "■", active: "▶", todo: "□" };

export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} 秒`;
	if (s < 3600) return `${Math.round(s / 60)} 分钟`;
	if (s < 86400) {
		const h = Math.floor(s / 3600);
		const m = Math.round((s % 3600) / 60);
		return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
	}
	return `${Math.round(s / 86400)} 天`;
}

// ---------------------------------------------------------------- activity → plain words

const base = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
const HAS_CJK = /[\u3400-\u9fff]/;
/** Tools whose activity line is "<tool> <arg>" (see extensions/worker.ts describeTool). */
const FILE_TOOLS: Record<string, [string, boolean]> = { read: ["阅读", false], write: ["编写", true], edit: ["修改", true] };
const SEARCH_TOOLS = new Set(["grep", "find", "ls", "glob", "rg"]);

/** Translate one activity line into plain words. milestone = worth listing under "recent". */
export function humanizeActivity(activity: string): { text: string; milestone: boolean } {
	const a = String(activity ?? "").replace(/\s+/g, " ").trim();
	if (!a) return { text: "", milestone: false };
	if (HAS_CJK.test(a.split(" ")[0] ?? "")) return { text: a.slice(0, 120), milestone: false }; // already words (思考中, 收到追加指令 …)
	const sp = a.indexOf(" ");
	const tool = (sp < 0 ? a : a.slice(0, sp)).toLowerCase();
	const arg = sp < 0 ? "" : a.slice(sp + 1);
	if (tool === "bash" || tool === "shell" || tool === "exec") return arg ? humanizeCommand(arg) : { text: "运行命令", milestone: false };
	const ft = FILE_TOOLS[tool];
	if (ft) return { text: arg ? `${ft[0]} ${base(arg)}` : `${ft[0]}文件`, milestone: ft[1] };
	if (SEARCH_TOOLS.has(tool)) return { text: "查找代码和文件", milestone: false };
	if (tool === "codemode") return { text: "运行脚本", milestone: false };
	if (tool === "qa_comment") return { text: "在任务下留言", milestone: true };
	if (tool === "qa_report" || tool === "qa_progress") return { text: "汇报进度", milestone: false };
	if (/^(web_?search|fetch|web_?fetch)/.test(tool)) return { text: "查资料", milestone: false };
	if (/^mcp/.test(tool)) return { text: "调用外部工具", milestone: false };
	return { text: `使用工具 ${tool}`, milestone: false };
}

type Rule = [RegExp, string | ((m: RegExpMatchArray) => string), boolean?];
// Matched against one command segment (cd / env / sudo prefixes removed). Third field: milestone.
const RULES: Rule[] = [
	[/^git (?:-C \S+ )?push\b.*--tags?\b/, "推送 tag", true],
	[/^git (?:-C \S+ )?push\b/, "推送代码", true],
	[/^git (?:-C \S+ )?commit\b/, "提交代码", true],
	[/^git (?:-C \S+ )?tag\b/, "打 tag", true],
	[/^git (?:-C \S+ )?rebase\b/, "同步到最新代码（rebase）", true],
	[/^git (?:-C \S+ )?(?:pull|fetch)\b/, "拉取最新代码", false],
	[/^git (?:-C \S+ )?merge\b/, "合并分支", true],
	[/^git (?:-C \S+ )?clone\b/, "克隆仓库", true],
	[/^git (?:-C \S+ )?worktree\b/, "准备独立工作目录", true],
	[/^git (?:-C \S+ )?(?:checkout|switch)\b/, "切换分支", false],
	[/^git (?:-C \S+ )?(?:add|stash|reset|restore)\b/, "整理代码改动", false],
	[/^git\b/, "查看代码改动", false],
	[/^gh (?:run|workflow) (?:watch|view)\b/, "等 CI 结果", false],
	[/^gh (?:run|workflow)\b/, "查看 CI", false],
	[/^gh release (?:create|upload|edit)\b/, "发布 Release", true],
	[/^gh release\b/, "查看 Release", false],
	[/^gh pr (?:create|merge)\b/, "提交 PR", true],
	[/^gh\b/, "查看 GitHub", false],
	[/(?:^|\/)release(?:\.sh|\.mjs|\.js)?\b|^npm run release\b/, "执行发布脚本", true],
	[/^(?:npm|pnpm|yarn|bun) (?:run )?test\b|^node (?:\S+ )*--test\b|^(?:npx |pnpm )?(?:vitest|jest|mocha|playwright test)\b|^(?:python3? -m )?pytest\b|^(?:go|cargo) test\b|^make (?:test|check)\b|^tsx? .*\.test\./, "跑测试", true],
	[/^(?:npm|pnpm|yarn|bun) (?:ci|install|i|add)\b|^pip3? install\b|^(?:uv|poetry) (?:add|install|sync)\b|^brew install\b|^apt(?:-get)? install\b/, "安装依赖", true],
	[/^(?:npm|pnpm|yarn|bun) run (?:build|dist|pack)\S*|^(?:npx )?(?:tsc|vite build|electron-builder|esbuild)\b|^(?:go|cargo) build\b|^make\b|^npm pack\b/, "构建", true],
	[/^(?:npm|pnpm|yarn|bun) run (?:lint|check|fmt|format)\S*|^(?:npx )?(?:eslint|biome|prettier)\b/, "检查代码格式", false],
	[/^(?:npm|pnpm|yarn|bun) publish\b/, "发布 npm 包", true],
	[/^(?:npm|pnpm|yarn|bun) (?:run )?(\S+)/, (m) => `运行 ${m[1]} 脚本`, false],
	[/^ssh (?:-\S+ (?:\S+ )?)*([\w.@-]+)/, (m) => `在 ${m[1]!.replace(/^.*@/, "")} 上执行命令`, false],
	[/^(?:scp|rsync)\b/, "同步文件到其他机器", true],
	[/^(?:curl|wget|http)\b/, "请求网络接口", false],
	[/^docker (?:build|compose build)\b/, "构建镜像", true],
	[/^docker\b/, "操作容器", false],
	[/^(?:sleep|wait)\b/, "等待", false],
	[/^tmux\b/, "操作终端窗口", false],
	[/^(?:kill|pkill|killall)\b/, "停止进程", false],
	[/^rm\b/, "删除文件", false],
	[/^(?:mkdir|cp|mv|ln|touch|chmod)\b/, "整理文件", false],
	[/^(?:ls|find|fd|rg|grep|cat|head|tail|wc|tree|stat|du|file|less|sed -n|awk)\b/, "查看文件", false],
	[/^(?:ps|top|lsof|df|free|uptime|which|whoami|env|printenv|echo|date|uname|pwd)\b/, "查看系统状态", false],
	[/^(?:quick|qa)\b/, "操作 quick-agent", false],
	[/^(?:node|python3?|bun|deno|tsx|ruby|bash|sh|zsh) (?:-\S+ )*(\S+)/, (m) => `运行 ${base(m[1]!)}`, false],
	[/^\.?\/?(?:[\w.-]+\/)*([\w.-]+\.(?:sh|py|mjs|js|ts))\b/, (m) => `运行 ${m[1]}`, false],
];

/** Split a shell line into command segments, drop navigation / env prefixes, pick the most telling one. */
export function humanizeCommand(cmd: string): { text: string; milestone: boolean } {
	const segs = cmd
		.split(/\s*(?:&&|\|\||;|\|)\s*/)
		.map((s) =>
			s
				.trim()
				.replace(/^\(+|\)+$/g, "")
				.replace(/^(?:(?:sudo|time|nohup|exec|env)\s+|timeout\s+\S+\s+|[A-Z_][A-Z0-9_]*=\S*\s+)+/, "")
				.trim(),
		)
		.filter((s) => s && !/^(?:cd|pushd|popd|export|set|source|\.)\b/.test(s) && !/^[A-Z_][A-Z0-9_]*=\S*$/.test(s));
	if (!segs.length) return { text: "运行命令", milestone: false };
	let best: { text: string; milestone: boolean; rank: number } | undefined;
	for (const s of segs) {
		for (let k = 0; k < RULES.length; k++) {
			const [re, out, ms] = RULES[k]!;
			const m = s.match(re);
			if (!m) continue;
			const text = typeof out === "string" ? out : out(m);
			// Milestones beat lookups ("npm test | tail" is a test run, "git push && git log" is a push).
			const rank = (ms ? 0 : 100) + k;
			if (!best || rank < best.rank) best = { text, milestone: !!ms, rank };
			break;
		}
	}
	if (best) return { text: best.text, milestone: best.milestone };
	const first = segs[0]!.split(" ")[0]!;
	return { text: `运行 ${base(first)}`, milestone: false };
}
