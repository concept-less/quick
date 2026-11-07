// quick-front: the interactive, quick front agent. It understands tasks, assembles context and
// delegates them to worker agents through the quick-agent hub. It never does the work itself.
// Active only when QA_ROLE=front (set by `qa front`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hubUrl, loadConfig, matchProject } from "../../shared/config.ts";
import { HubClient } from "../../shared/hub-client.ts";
import { ACTIVE_STATUSES, ATTENTION_STATUSES, type Intake, type Task } from "../../shared/types.ts";

const FRONT_TOOLS = ["read", "grep", "find", "ls", "qa_dispatch", "qa_tasks", "qa_task_read", "qa_task_send", "qa_task_cancel"];

const ICON: Record<string, string> = {
	starting: "◌",
	running: "●",
	idle: "◐",
	needs_input: "?",
	blocked: "■",
	done: "✓",
	failed: "✗",
	cancelled: "⊘",
	exited: "⏏",
};

function frontRules(projects: string): string {
	return `你是 quick-agent 工作流中的 **前台 agent**：你和人类交互，并且必须 **快**。工作方式类似中断处理的上半部：
1. 理解任务：只做最少量的澄清。只有在缺少关键信息、无法写出可执行简报时才提问，而且一次问完。
2. 组装上下文：允许快速读取少量文件、grep/ls 确认工作目录和相关位置，但不要深入调研，不要动手实现。
3. 派单：调用 qa_dispatch 把任务交给一个独立的负责人 worker。brief 必须自包含：目标、背景、相关文件/位置、约束、验收标准，以及你掌握的全部上下文（含截图路径、元素选择器、页面 URL）。worker 看不到你和人类的对话。
4. 派完立刻用一两句话回复（任务 ID、标题、工作目录），结束本轮，不要等待 worker。
5. 一次请求包含多个互相独立的任务时，分别派单。属于已有任务的追加需求，用 qa_task_send 发给对应 worker，不要新建任务。
6. 人类问进度时用 qa_tasks / qa_task_read；要求中止时用 qa_task_cancel。
7. 收到 [quick-agent 汇报] 消息时，不需要主动行动；人类问起时再基于它回答。
8. 纯闲聊或一句话能回答的问题直接回答，不用派单。
9. 收到 [浏览器评论] 时，它来自人类在网页上框选元素后写的评论：判断它属于哪个项目/工作目录（参考下方项目映射；不确定就问人类），必要时快速确认相关源码位置，然后派单；如果它明显是某个已有任务的追加，就用 qa_task_send。

工作目录映射（来自 ~/.quick-agent/config.json 的 projects）：
${projects}`;
}

export default function quickFront(pi: ExtensionAPI) {
	if (process.env.QA_ROLE !== "front") return;

	const cfg = loadConfig();
	const hub = new HubClient(cfg);
	const tasks = new Map<string, Task>();
	let abort: AbortController | undefined;
	let current: ExtensionContext | undefined;
	let connected = false;
	const claimed = new Set<string>();

	const renderWidget = () => {
		const c = current;
		if (!c?.hasUI) return;
		const list = [...tasks.values()].filter((t) => !t.closed || t.unread || ACTIVE_STATUSES.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
		const th = c.ui.theme;
		if (!list.length) {
			c.ui.setWidget("qa-tasks", undefined);
		} else {
			const lines = list.slice(0, 8).map((t) => {
				const color = t.status === "done" ? "success" : ACTIVE_STATUSES.includes(t.status) ? "accent" : ATTENTION_STATUSES.includes(t.status) ? "warning" : "dim";
				const mark = t.unread ? th.fg("warning", "• ") : "  ";
				const detail = ACTIVE_STATUSES.includes(t.status) ? (t.activity ?? "") : (t.summary ?? "").split("\n")[0];
				return `${mark}${th.fg(color as any, `${ICON[t.status] ?? "·"} ${t.id}`)} ${t.title}${detail ? th.fg("dim", ` — ${detail.slice(0, 70)}`) : ""}`;
			});
			if (list.length > 8) lines.push(th.fg("dim", `  … 还有 ${list.length - 8} 个任务（/tasks）`));
			c.ui.setWidget("qa-tasks", lines);
		}
		const active = list.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
		const unread = list.filter((t) => t.unread).length;
		c.ui.setStatus("qa", `${connected ? "⚡" : "○ hub offline"} ${active} running${unread ? ` · ${unread} 待处理` : ""}`);
	};

	const refresh = async () => {
		try {
			for (const t of await hub.listTasks()) tasks.set(t.id, t);
			connected = true;
		} catch {
			connected = false;
		}
		renderWidget();
	};

	// ---------------------------------------------------------------- intake → front agent

	const deliverIntake = async (intake: Intake) => {
		if (claimed.has(intake.id)) return;
		claimed.add(intake.id);
		try {
			await hub.claimIntake(intake.id, `front:${process.pid}`);
		} catch {
			return; // someone else took it
		}
		const project = matchProject(cfg, intake.url);
		const el = intake.elements
			.map((e, i) =>
				[
					`  ${i + 1}. <${e.tag ?? "?"}> selector: \`${e.selector ?? "?"}\``,
					e.xpath ? `     xpath: \`${e.xpath}\`` : "",
					e.text ? `     text: ${JSON.stringify(e.text.slice(0, 300))}` : "",
					e.html ? `     html: \`\`\`html\n${e.html.slice(0, 1500)}\n\`\`\`` : "",
				]
					.filter(Boolean)
					.join("\n"),
			)
			.join("\n");
		const text = [
			`[浏览器评论 ${intake.id}]`,
			`评论: ${intake.comment}`,
			`页面: ${intake.title ?? ""} ${intake.url ?? ""}`,
			project ? `项目映射命中: ${project.cwd}${project.notes ? `（${project.notes}）` : ""}` : "项目映射: 未命中",
			intake.mode === "region" && intake.region ? `框选区域(viewport px): ${JSON.stringify(intake.region)}` : "",
			intake.elements.length ? `选中元素:\n${el}` : "",
			intake.viewport ? `视口: ${intake.viewport.width}x${intake.viewport.height} @${intake.viewport.dpr}x` : "",
			intake.consoleErrors?.length ? `控制台错误:\n${intake.consoleErrors.map((e) => `  - ${e}`).join("\n")}` : "",
			intake.screenshots.length ? `截图文件（派单时放进 attachments）:\n${intake.screenshots.map((s) => `  - ${s}`).join("\n")}` : "",
			`派单时请设置 intake_id="${intake.id}"。`,
		]
			.filter(Boolean)
			.join("\n");
		const images = intake.screenshots.slice(0, 2).flatMap((f) => {
			try {
				return [{ type: "image" as const, data: readFileSync(f).toString("base64"), mimeType: f.endsWith(".png") ? "image/png" : "image/jpeg" }];
			} catch {
				return [];
			}
		});
		const content = [{ type: "text" as const, text }, ...images];
		const c = current;
		if (c?.hasUI) c.ui.notify(`浏览器评论: ${intake.comment.slice(0, 60)}`, "info");
		if (!c || c.isIdle()) pi.sendUserMessage(content);
		else pi.sendUserMessage(content, { deliverAs: "followUp" });
	};

	// ---------------------------------------------------------------- tools

	pi.registerTool({
		name: "qa_dispatch",
		label: "Dispatch task",
		description:
			"Delegate a task to a new, independent worker agent (a full pi session in its own tmux window) that owns the task until done. Returns immediately with the task id.",
		promptSnippet: "Delegate a task to an independent worker agent (returns immediately)",
		promptGuidelines: ["Use qa_dispatch for any real work (coding, debugging, research, edits); the brief must be self-contained."],
		parameters: Type.Object({
			title: Type.String({ description: "Short task title (Chinese ok), distinguishes it from other tasks" }),
			cwd: Type.String({ description: "Absolute working directory for the worker" }),
			brief: Type.String({ description: "Self-contained task brief: goal, context, relevant files, constraints, acceptance criteria" }),
			attachments: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths of files the worker should look at (e.g. screenshots)" })),
			intake_id: Type.Optional(Type.String({ description: "Browser comment id when dispatching a [浏览器评论]" })),
		}),
		async execute(_id, p) {
			const intake = p.intake_id ? await hub.request<{ intake: Intake }>("GET", `/api/intake/${p.intake_id}`).then((r) => r.intake).catch(() => undefined) : undefined;
			const task = await hub.createTask({
				title: p.title,
				brief: p.brief,
				cwd: p.cwd,
				attachments: p.attachments,
				source: intake ? { kind: "browser", intakeId: intake.id, url: intake.url } : { kind: "tui" },
			});
			tasks.set(task.id, task);
			renderWidget();
			return {
				content: [{ type: "text", text: `Dispatched ${task.id} "${task.title}" in ${task.cwd} (status ${task.status}${task.summary ? `: ${task.summary}` : ""}).` }],
				details: { task },
			};
		},
	});

	pi.registerTool({
		name: "qa_tasks",
		label: "List tasks",
		description: "List quick-agent tasks with status, current activity and latest summary.",
		parameters: Type.Object({ include_closed: Type.Optional(Type.Boolean({ description: "Include closed/old tasks" })) }),
		async execute(_id, p) {
			const list = await hub.listTasks();
			for (const t of list) tasks.set(t.id, t);
			renderWidget();
			const shown = list.filter((t) => p.include_closed || !t.closed || t.unread).slice(0, 40);
			const text = shown.length
				? shown
						.map((t) => `${t.id} [${t.status}${t.unread ? ", unread" : ""}] ${t.title} — ${t.cwd}\n    ${(ACTIVE_STATUSES.includes(t.status) ? t.activity : t.summary)?.split("\n")[0]?.slice(0, 160) ?? ""}`)
						.join("\n")
				: "No tasks.";
			return { content: [{ type: "text", text }], details: { count: shown.length } };
		},
	});

	pi.registerTool({
		name: "qa_task_read",
		label: "Read task",
		description: "Read one task: brief, status, latest worker summary and recent events. Marks it as read.",
		parameters: Type.Object({ id: Type.String(), events: Type.Optional(Type.Number({ description: "Recent events to include (default 15)" })) }),
		async execute(_id, p) {
			const { task, events } = await hub.getTask(p.id, p.events ?? 15);
			const acked = task.unread ? await hub.ack(task.id).catch(() => task) : task;
			tasks.set(task.id, acked);
			renderWidget();
			const text = [
				`${task.id} "${task.title}" status=${task.status} cwd=${task.cwd}`,
				`tmux: ${task.tmuxTarget ?? "-"}  session: ${task.sessionFile ?? "-"}`,
				task.activity ? `activity: ${task.activity}` : "",
				`--- summary ---\n${task.summary ?? "(none yet)"}`,
				`--- events ---\n${events.map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.kind}${e.status ? `→${e.status}` : ""} ${(e.text ?? "").slice(0, 200)}`).join("\n")}`,
				`--- brief ---\n${task.brief}`,
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text }], details: { task } };
		},
	});

	pi.registerTool({
		name: "qa_task_send",
		label: "Send to task",
		description: "Send a follow-up instruction to the worker owning a task. Resumes the worker session if its window was closed.",
		parameters: Type.Object({ id: Type.String(), message: Type.String({ description: "Self-contained follow-up instruction" }) }),
		async execute(_id, p) {
			const task = await hub.sendMessage(p.id, p.message);
			tasks.set(task.id, task);
			renderWidget();
			return { content: [{ type: "text", text: `Sent to ${task.id} (status ${task.status}).` }], details: { task } };
		},
	});

	pi.registerTool({
		name: "qa_task_cancel",
		label: "Cancel task",
		description: "Abort the worker's current run. With close=true also closes its tmux window.",
		parameters: Type.Object({ id: Type.String(), close: Type.Optional(Type.Boolean()) }),
		async execute(_id, p) {
			let task = await hub.cancel(p.id);
			if (p.close) task = await hub.close(p.id);
			tasks.set(task.id, task);
			renderWidget();
			return { content: [{ type: "text", text: `Cancelled ${task.id}${p.close ? " and closed its window" : ""}.` }], details: { task } };
		},
	});

	// ---------------------------------------------------------------- commands

	const attach = (id: string, ctx: ExtensionContext) => {
		const t = tasks.get(id);
		const target = t?.tmuxTarget ?? `${cfg.tmuxSession}:${id}`;
		if (!process.env.TMUX) {
			ctx.ui.notify(`不在 tmux 中。运行: tmux attach -t ${cfg.tmuxSession} \\; select-window -t ${target}`, "warning");
			return;
		}
		try {
			execFileSync("tmux", ["switch-client", "-t", target], { stdio: "ignore" });
			if (t?.unread) void hub.ack(id).then((x) => tasks.set(x.id, x)).then(renderWidget).catch(() => {});
		} catch {
			ctx.ui.notify(`窗口 ${target} 不存在（可以用 qa_task_send 恢复 worker）`, "error");
		}
	};

	pi.registerCommand("attach", {
		description: "切换到某个 worker 的 tmux 窗口：/attach <task-id>",
		getArgumentCompletions: (prefix) => {
			const items = [...tasks.values()].filter((t) => !t.closed && t.id.startsWith(prefix)).map((t) => ({ value: t.id, label: `${t.id} ${t.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) return ctx.ui.notify("用法: /attach <task-id>", "warning");
			attach(id, ctx);
		},
	});

	pi.registerCommand("tasks", {
		description: "任务面板：查看、接管、追加指令、中止、关闭",
		handler: async (_args, ctx) => {
			await refresh();
			const list = [...tasks.values()].filter((t) => !t.closed || t.unread).sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt - a.updatedAt);
			if (!list.length) return ctx.ui.notify("没有进行中的任务", "info");
			const labels = list.map((t) => `${t.unread ? "• " : "  "}${ICON[t.status] ?? "·"} ${t.id} [${t.status}] ${t.title}`);
			const picked = await ctx.ui.select("quick-agent 任务", labels);
			if (picked === undefined) return;
			const t = list[labels.indexOf(picked)];
			if (!t) return;
			const actions = ["查看汇报", "接管（切换到 tmux 窗口）", "追加指令", "标记已读", "中止当前运行", "关闭窗口"];
			const a = await ctx.ui.select(`${t.id} ${t.title}`, actions);
			if (a === actions[0]) {
				const { task } = await hub.getTask(t.id, 0);
				await ctx.ui.editor(`${task.id} [${task.status}] ${task.title}`, `${task.summary ?? "(暂无汇报)"}\n\n---\n活动: ${task.activity ?? "-"}\n目录: ${task.cwd}\n会话: ${task.sessionFile ?? "-"}`);
				tasks.set(t.id, await hub.ack(t.id));
			} else if (a === actions[1]) attach(t.id, ctx);
			else if (a === actions[2]) {
				const msg = await ctx.ui.input(`发给 ${t.id} 的追加指令`, "");
				if (msg?.trim()) tasks.set(t.id, await hub.sendMessage(t.id, msg.trim()));
			} else if (a === actions[3]) tasks.set(t.id, await hub.ack(t.id));
			else if (a === actions[4]) tasks.set(t.id, await hub.cancel(t.id));
			else if (a === actions[5] && (await ctx.ui.confirm("关闭窗口", `关闭 ${t.id} 的 worker 窗口？`))) tasks.set(t.id, await hub.close(t.id));
			renderWidget();
		},
	});

	pi.registerCommand("hub", {
		description: "显示 quick-agent hub 地址与面板链接",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Hub: ${hubUrl(cfg)}  面板: ${hubUrl(cfg)}/?token=${cfg.token}`, "info");
		},
	});

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_e, ctx) => {
		current = ctx;
		const available = new Set(pi.getAllTools().map((t) => t.name));
		pi.setActiveTools(FRONT_TOOLS.filter((n) => available.has(n)));
		if (ctx.hasUI) ctx.ui.setTitle("quick-agent · front");
		pi.setSessionName(pi.getSessionName() ?? "quick-agent front");
		abort?.abort();
		abort = new AbortController();
		await refresh();
		hub.subscribe(
			(e) => {
				if (e.type === "task") {
					const prev = tasks.get(e.task.id);
					tasks.set(e.task.id, e.task);
					renderWidget();
					const ev = e.event;
					const newsworthy = ev && (ev.kind === "report" || ev.kind === "status") && ATTENTION_STATUSES.includes(e.task.status) && (prev?.status !== e.task.status || ev.kind === "report");
					if (newsworthy) {
						const t = e.task;
						current?.hasUI && current.ui.notify(`${ICON[t.status]} ${t.id} ${t.title}: ${t.status}`, t.status === "done" ? "info" : "warning");
						pi.sendMessage(
							{
								customType: "qa-report",
								content: `[quick-agent 汇报] ${t.id} "${t.title}" → ${t.status}\n${(t.summary ?? "").slice(0, 3000)}`,
								display: true,
								details: { taskId: t.id, status: t.status },
							},
							{ triggerTurn: false },
						);
					}
				} else if (e.type === "intake" && e.intake.status === "pending") {
					void deliverIntake(e.intake);
				}
			},
			abort.signal,
			(ok) => {
				connected = ok;
				renderWidget();
				if (ok) void hub.pendingIntake().then((list) => list.forEach((i) => void deliverIntake(i))).catch(() => {});
			},
			{ role: "front" },
		);
	});

	pi.on("before_agent_start", async (event) => {
		const projects = cfg.projects.length
			? cfg.projects.map((p) => `- URL 含 "${p.match}" → ${p.cwd}${p.notes ? `（${p.notes}）` : ""}`).join("\n")
			: "- （未配置）";
		event.systemPromptOptions.sections.quick_agent_front = `${frontRules(projects)}\n- 默认工作目录: ${cfg.defaultCwd}`;
	});

	// Defence in depth: the front agent must not do the work itself.
	pi.on("tool_call", async (event) => {
		if (["bash", "edit", "write"].includes(event.toolName)) {
			return { block: true, reason: "quick-front 不直接执行任务：请用 qa_dispatch 委派给 worker。" };
		}
	});

	pi.on("session_shutdown", async () => {
		abort?.abort();
	});
}
