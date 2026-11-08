// Front role: your normal interactive pi *is* the quick-agent front agent.
// It understands tasks, assembles context and delegates them to worker agents through the hub.
// Toggle per session with /qa on|off, or start pi with --qa-off (or QA_ROLE=off) for a plain pi.
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { hubUrl, loadConfig, matchProject, REPO_ROOT } from "../shared/config.ts";
import { HubClient } from "../shared/hub-client.ts";
import { openAttach, planAttach, runForeground, type AttachResult } from "../shared/attach.ts";
import { ensureHub } from "../shared/hub-process.ts";
import { autoUpdate, compareVersions, readState, readVersion } from "../shared/update.ts";
import { ACTIVE_STATUSES, ATTENTION_STATUSES, type Intake, type MachineView, type Task } from "../shared/types.ts";

const QA_TOOLS = ["qa_dispatch", "qa_tasks", "qa_task_read", "qa_task_send", "qa_task_cancel", "qa_machines", "qa_remote_fs"];
const FRONT_TOOLS = ["read", "grep", "find", "ls", ...QA_TOOLS];

const ICON: Record<string, string> = {
	starting: "◌", running: "●", idle: "◐", needs_input: "?", blocked: "■", done: "✓", failed: "✗", cancelled: "⊘", exited: "⏏",
};

function frontRules(cwd: string, defaultCwd: string, projects: string, machines: string): string {
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
10. 你没有 bash/edit/write，这是刻意的：所有实际工作都交给 worker。
11. 多机：worker 可以跑在 mesh 里的任何在线机器上（qa_dispatch 的 machine 参数，默认是本机）。代码/环境在哪台机器就派到哪台；人类点名机器时照做。需要了解远程机器上的目录或文件时用 qa_remote_fs（ls/read/grep，只读），本地文件仍用 read/grep/ls。cwd 必须是目标机器上的路径。

本机: ${machines.split("\n")[0]}
mesh 中的机器（qa_machines 查看最新状态）:
${machines}

当前 pi 的工作目录（人类说"这个项目"时默认指它，也是派单的默认 cwd）: ${cwd}
兜底工作目录: ${defaultCwd}
浏览器 URL → 工作目录映射（~/.quick-agent/config.json 的 projects）：
${projects}`;
}

export function setupFront(pi: ExtensionAPI) {
	const cfg = loadConfig();
	const hub = new HubClient(cfg);
	const owner = `${hostname()}:${process.pid}`;
	const tasks = new Map<string, Task>();
	let machines: MachineView[] = [];
	let machinesAt = 0;
	const selfId = () => machines.find((m) => m.self)?.id ?? cfg.machine.id;
	const tag = (t: Task) => (t.machine && t.machine !== selfId() ? `${t.id}@${t.machine}` : t.id);
	const loadMachines = async (maxAgeMs = 10_000) => {
		if (Date.now() - machinesAt < maxAgeMs) return machines;
		try {
			machines = (await hub.machines()).machines;
			machinesAt = Date.now();
		} catch {}
		return machines;
	};
	const describeMachines = (list: MachineView[]) =>
		(list.length ? list : [{ id: cfg.machine.id, self: true, online: true, hops: 0 } as MachineView])
			.map(
				(m) =>
					`- ${m.id}${m.self ? "（本机）" : ""} ${m.online ? "在线" : "离线"}${m.hops > 1 ? `，经 ${m.via} 转发` : ""}${m.description ? `：${m.description}` : ""}${m.defaultCwd ? `；默认目录 ${m.defaultCwd}` : ""}${m.activeTasks ? `；运行中任务 ${m.activeTasks}` : ""}${m.projects?.length ? `；项目 ${m.projects.map((p) => `${p.match}→${p.cwd}`).join(", ")}` : ""}`,
			)
			.join("\n");
	const claimed = new Set<string>();
	let abort: AbortController | undefined;
	let current: ExtensionContext | undefined;
	let connected = false;
	/** Front mode on/off for this pi process. */
	let enabled = false;
	/** Tools active before front mode took over, restored by /qa off. */
	let savedTools: string[] | undefined;

	pi.registerFlag("qa-off", { description: "Start pi as a plain agent (quick-agent front mode off)", type: "boolean", default: false });

	// ---------------------------------------------------------------- mode switching

	const applyFrontTools = () => {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		const want = FRONT_TOOLS.filter((n) => available.has(n));
		const active = pi.getActiveTools();
		if (active.length !== want.length || active.some((n) => !want.includes(n))) pi.setActiveTools(want);
	};

	const setEnabled = (on: boolean, ctx?: ExtensionContext) => {
		if (on === enabled) return;
		enabled = on;
		if (on) {
			savedTools = pi.getActiveTools().filter((n) => !QA_TOOLS.includes(n));
			applyFrontTools();
		} else {
			pi.setActiveTools(savedTools ?? ["read", "bash", "edit", "write"]);
		}
		renderWidget(ctx);
	};

	// ---------------------------------------------------------------- widget / status

	const renderWidget = (ctx = current) => {
		if (!ctx?.hasUI) return;
		const tui = ctx.mode === "tui";
		const th = { fg: (c: string, s: string) => (tui ? ctx.ui.theme.fg(c as any, s) : s) };
		const list = [...tasks.values()]
			.filter((t) => !t.closed || t.unread || ACTIVE_STATUSES.includes(t.status))
			.sort((a, b) => b.updatedAt - a.updatedAt);
		if (!list.length) ctx.ui.setWidget("qa-tasks", undefined);
		else {
			const lines = list.slice(0, 8).map((t) => {
				const color = t.status === "done" ? "success" : ACTIVE_STATUSES.includes(t.status) ? "accent" : ATTENTION_STATUSES.includes(t.status) ? "warning" : "dim";
				const mark = t.unread ? th.fg("warning", "• ") : "  ";
				const detail = ACTIVE_STATUSES.includes(t.status) ? (t.activity ?? "") : (t.summary ?? "").split("\n")[0];
				return `${mark}${th.fg(color as any, `${ICON[t.status] ?? "·"} ${tag(t)}`)} ${t.title}${detail ? th.fg("dim", ` — ${detail.slice(0, 70)}`) : ""}`;
			});
			if (list.length > 8) lines.push(th.fg("dim", `  … 还有 ${list.length - 8} 个任务（/tasks）`));
			ctx.ui.setWidget("qa-tasks", lines);
		}
		const active = list.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
		const unread = list.filter((t) => t.unread).length;
		const mode = enabled ? "⚡ quick-agent" : "○ plain pi";
		ctx.ui.setStatus("qa", `${mode}${connected ? "" : " · hub offline"} · ${active} running${unread ? ` · ${unread} 待处理` : ""}`);
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
		if (!enabled || claimed.has(intake.id)) return;
		const project = matchProject(cfg, intake.url);
		// Prefer the pi whose cwd belongs to the matched project; others wait a moment before claiming.
		const mine = project && current && (current.cwd === project.cwd || current.cwd.startsWith(`${project.cwd}/`));
		if (!mine) await new Promise((r) => setTimeout(r, 1500));
		if (claimed.has(intake.id)) return;
		claimed.add(intake.id);
		try {
			// The hub copies screenshots of remote intakes to this machine and returns local paths.
			intake = await hub.claimIntake(intake.id, owner);
		} catch {
			return; // another front agent took it
		}
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
			`[浏览器评论 ${intake.id}]${intake.machine && intake.machine !== selfId() ? `（来自机器 ${intake.machine} 上的浏览器）` : ""}`,
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
		defaultActive: false,
		description:
			"Delegate a task to a new, independent worker agent (a full pi session in its own tmux window) that owns the task until done. Returns immediately with the task id.",
		promptSnippet: "Delegate a task to an independent worker agent (returns immediately)",
		promptGuidelines: ["Use qa_dispatch for any real work (coding, debugging, research, edits); the qa_dispatch brief must be self-contained."],
		parameters: Type.Object({
			title: Type.String({ description: "Short task title (Chinese ok), distinguishes it from other tasks" }),
			cwd: Type.String({ description: "Absolute working directory for the worker" }),
			brief: Type.String({ description: "Self-contained task brief: goal, context, relevant files, constraints, acceptance criteria" }),
			attachments: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths of files the worker should look at (e.g. screenshots)" })),
			intake_id: Type.Optional(Type.String({ description: "Browser comment id when dispatching a [浏览器评论]" })),
			machine: Type.Optional(Type.String({ description: "Machine id (from qa_machines) to run the worker on; default this machine. cwd must exist there." })),
		}),
		async execute(_id, p) {
			const intake = p.intake_id ? await hub.request<{ intake: Intake }>("GET", `/api/intake/${p.intake_id}`).then((r) => r.intake).catch(() => undefined) : undefined;
			const task = await hub.createTask({
				title: p.title,
				brief: p.brief,
				cwd: p.cwd,
				attachments: p.attachments,
				owner,
				machine: p.machine,
				source: intake ? { kind: "browser", intakeId: intake.id, url: intake.url } : { kind: "tui" },
			});
			tasks.set(task.id, task);
			renderWidget();
			return {
				content: [{ type: "text", text: `Dispatched ${task.id} "${task.title}" on machine ${task.machine} in ${task.cwd} (status ${task.status}${task.summary ? `: ${task.summary}` : ""}).` }],
				details: { task },
			};
		},
	});

	pi.registerTool({
		name: "qa_tasks",
		label: "List tasks",
		defaultActive: false,
		description: "List quick-agent tasks with status, current activity and latest summary.",
		parameters: Type.Object({ include_closed: Type.Optional(Type.Boolean({ description: "Include closed/old tasks" })) }),
		async execute(_id, p) {
			const list = await hub.listTasks();
			for (const t of list) tasks.set(t.id, t);
			renderWidget();
			const shown = list.filter((t) => p.include_closed || !t.closed || t.unread).slice(0, 40);
			const text = shown.length
				? shown
						.map((t) => `${t.id} [${t.status}${t.unread ? ", unread" : ""}] ${t.title} — ${t.machine}:${t.cwd}\n    ${(ACTIVE_STATUSES.includes(t.status) ? t.activity : t.summary)?.split("\n")[0]?.slice(0, 160) ?? ""}`)
						.join("\n")
				: "No tasks.";
			return { content: [{ type: "text", text }], details: { count: shown.length } };
		},
	});

	pi.registerTool({
		name: "qa_task_read",
		label: "Read task",
		defaultActive: false,
		description: "Read one quick-agent task: brief, status, latest worker summary and recent events. Marks it as read.",
		parameters: Type.Object({ id: Type.String(), events: Type.Optional(Type.Number({ description: "Recent events to include (default 15)" })) }),
		async execute(_id, p) {
			const { task, events } = await hub.getTask(p.id, p.events ?? 15);
			const acked = task.unread ? await hub.ack(task.id).catch(() => task) : task;
			tasks.set(task.id, acked);
			renderWidget();
			const text = [
				`${task.id} "${task.title}" status=${task.status} machine=${task.machine} cwd=${task.cwd}`,
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
		defaultActive: false,
		description: "Send a follow-up instruction to the worker owning a quick-agent task. Resumes the worker session if its window was closed.",
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
		defaultActive: false,
		description: "Abort a quick-agent worker's current run. With close=true also closes its tmux window.",
		parameters: Type.Object({ id: Type.String(), close: Type.Optional(Type.Boolean()) }),
		async execute(_id, p) {
			let task = await hub.cancel(p.id);
			if (p.close) task = await hub.close(p.id);
			tasks.set(task.id, task);
			renderWidget();
			return { content: [{ type: "text", text: `Cancelled ${task.id}${p.close ? " and closed its window" : ""}.` }], details: { task } };
		},
	});

	pi.registerTool({
		name: "qa_machines",
		label: "Machines",
		defaultActive: false,
		description: "List machines in the quick-agent mesh (id, online, description, default cwd, projects, active tasks). Workers can be dispatched to any online machine.",
		parameters: Type.Object({}),
		async execute() {
			const list = await loadMachines(0);
			return { content: [{ type: "text", text: describeMachines(list) }], details: { machines: list } };
		},
	});

	pi.registerTool({
		name: "qa_remote_fs",
		label: "Remote FS",
		defaultActive: false,
		description:
			"Read-only file access on another machine of the quick-agent mesh: op=ls (list dir), read (text file, offset/limit lines), grep (regex, recursive). Use it to assemble context before dispatching a worker there.",
		parameters: Type.Object({
			machine: Type.String({ description: "Machine id" }),
			op: StringEnum(["ls", "read", "grep"] as const),
			path: Type.String({ description: "Absolute path on that machine (~ allowed)" }),
			pattern: Type.Optional(Type.String({ description: "Regex for grep" })),
			offset: Type.Optional(Type.Number({ description: "First line for read (1-based)" })),
			limit: Type.Optional(Type.Number({ description: "Max lines for read (default 400)" })),
		}),
		async execute(_id, p) {
			const r = await hub.fs(p);
			const text =
				p.op === "ls" ? `${r.path}\n${r.entries.join("\n")}` : p.op === "read" ? `${r.path} (lines ${r.offset}-, total ${r.totalLines})\n${r.text}` : r.text || "(no matches)";
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// ---------------------------------------------------------------- watching workers

	const dashboardUrl = (id?: string) => `${hubUrl(cfg)}/?token=${cfg.token}${id ? `#${id}` : ""}`;
	const markRead = (id: string) => {
		if (tasks.get(id)?.unread) void hub.ack(id).then((x) => tasks.set(x.id, x)).then(() => renderWidget()).catch(() => {});
	};

	/**
	 * Jump into a worker's tmux window, local or remote (shared/attach.ts). Inside tmux this switches
	 * client / opens a window and pi keeps running; outside tmux pi's TUI is stopped, the terminal is
	 * handed to `tmux attach` / `ssh -t …`, and the TUI is restarted and fully redrawn on detach.
	 */
	const attach = async (id: string, ctx: ExtensionContext): Promise<void> => {
		let r: AttachResult;
		try {
			r = openAttach(await planAttach(cfg, hub, id, { task: tasks.get(id), selfId: selfId() }), { remoteWindow: true });
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
			return;
		}
		markRead(id);
		if (r.kind === "switched") return ctx.ui.notify(r.message, "info");
		if (ctx.mode !== "tui") return ctx.ui.notify(`请在终端里运行: quick attach ${id}`, "info");
		const fg = r;
		const code = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
			tui.stop(); // cooked mode, cursor visible, bracketed paste/kitty off, stdin paused
			process.stdout.write(`\n${fg.message}\n`);
			void runForeground(fg).then((c) => {
				tui.start(); // raw mode + input handlers back
				tui.requestRender(true); // full redraw
				done(c);
			});
			return { render: () => [], invalidate() {} };
		});
		if (code) ctx.ui.notify(`${id}: ${fg.cmd} 退出码 ${code}`, "warning");
		renderWidget();
	};

	/** Pick a worker whose window is still open (id, machine, status, title). */
	const pickTask = async (ctx: ExtensionContext, title: string): Promise<string | undefined> => {
		await refresh();
		const list = [...tasks.values()]
			.filter((t) => !t.closed)
			.sort((a, b) => Number(ACTIVE_STATUSES.includes(b.status)) - Number(ACTIVE_STATUSES.includes(a.status)) || b.updatedAt - a.updatedAt);
		if (!list.length) {
			ctx.ui.notify("没有打开着的 worker 窗口", "info");
			return undefined;
		}
		const labels = list.map((t) => `${t.unread ? "•" : " "} ${ICON[t.status] ?? "·"} ${t.id.padEnd(6)} ${(t.machine || selfId()).padEnd(12)} ${`[${t.status}]`.padEnd(13)} ${t.title}`);
		const picked = await ctx.ui.select(title, labels);
		return picked === undefined ? undefined : list[labels.indexOf(picked)]?.id;
	};

	const attachCommand = {
		description: "进入 worker 的 tmux 窗口（本机/远程均可；不带 id 弹出选择）：/qa-attach [task-id]",
		getArgumentCompletions: (p: string) => taskCompletions(p),
		handler: async (args: string, ctx: ExtensionContext) => {
			const id = args.trim() || (await pickTask(ctx, "进入 worker 窗口"));
			if (id) await attach(id, ctx);
		},
	};

	/** Live, read-only view of a worker's terminal inside this pi (works without tmux on our side). */
	const peek = async (id: string, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`实时画面请在面板查看: ${dashboardUrl(id)}`, "info");
			return;
		}
		const first = await hub.request<{ alive: boolean; text: string }>("GET", `/api/tasks/${id}/screen`).catch(() => ({ alive: false, text: "" }));
		if (!first.alive) {
			const t = tasks.get(id);
			await ctx.ui.editor(`${id} 的窗口已关闭 — 最新汇报`, t?.summary ?? "(暂无汇报)");
			return;
		}
		markRead(id);
		const action = await ctx.ui.custom<"send" | "attach" | undefined>(
			(tui, theme, keybindings, done) => {
				let lines: string[] = first.text.split("\n");
				let inflight = false;
				const capture = () => {
					if (inflight) return;
					inflight = true;
					hub
						.request<{ alive: boolean; text: string }>("GET", `/api/tasks/${id}/screen`)
						.then((r) => (lines = r.alive ? r.text.split("\n") : ["(窗口已关闭)"]))
						.catch(() => (lines = ["(连接 hub 失败)"]))
						.finally(() => {
							inflight = false;
							tui.requestRender();
						});
				};
				capture();
				const timer = setInterval(capture, 1000);
				const close = (v: "send" | "attach" | undefined) => {
					clearInterval(timer);
					done(v);
				};
				return {
					render(width: number): string[] {
						const t = tasks.get(id);
						const rows = Math.max(8, Math.floor(tui.terminal.rows * 0.8) - 3);
						const head = `${theme.fg("accent", `⚡ ${t ? tag(t) : id}`)} ${t?.title ?? ""} ${theme.fg("dim", `[${t?.status ?? "?"}]`)}`;
						const help = theme.fg("dim", "Esc 关闭 · Enter 追加指令 · a 进入窗口");
						const body = lines.slice(-rows).map((l) => truncateToWidth(` ${l}`, width));
						return [truncateToWidth(head, width), truncateToWidth(theme.fg("dim", "─".repeat(width)), width), ...body, truncateToWidth(help, width)];
					},
					handleInput(data: string) {
						if (keybindings.matches(data, "tui.select.cancel") || data === "q") close(undefined);
						else if (keybindings.matches(data, "tui.select.confirm")) close("send");
						else if (data === "a") close("attach");
					},
					invalidate() {},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "85%" } },
		);
		if (action === "send") {
			const msg = await ctx.ui.input(`发给 ${id} 的追加指令`, "");
			if (msg?.trim()) tasks.set(id, await hub.sendMessage(id, msg.trim()));
			renderWidget();
		} else if (action === "attach") await attach(id, ctx);
	};

	// ---------------------------------------------------------------- commands

	const taskCompletions = (prefix: string) => {
		const items = [...tasks.values()].filter((t) => t.id.startsWith(prefix)).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => ({ value: t.id, label: `${t.id} ${t.title}` }));
		return items.length ? items : null;
	};

	pi.registerCommand("qa", {
		description: "quick-agent 前台模式：/qa on | off | status",
		getArgumentCompletions: (p) => ["on", "off", "status"].filter((x) => x.startsWith(p)).map((x) => ({ value: x, label: x })),
		handler: async (args, ctx) => {
			const a = args.trim();
			if (a === "on") setEnabled(true, ctx);
			else if (a === "off") setEnabled(false, ctx);
			ctx.ui.notify(
				enabled
					? "quick-agent 前台模式：开（只理解和派单；/qa off 切换为普通 pi）"
					: "quick-agent 前台模式：关（普通 pi；/qa on 恢复前台模式）",
				"info",
			);
		},
	});

	pi.registerCommand("peek", {
		description: "实时查看某个 worker 的终端：/peek <task-id>",
		getArgumentCompletions: taskCompletions,
		handler: async (args, ctx) => {
			const id = args.trim() || [...tasks.values()].filter((t) => ACTIVE_STATUSES.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
			if (!id) return ctx.ui.notify("用法: /peek <task-id>", "warning");
			await peek(id, ctx);
		},
	});

	pi.registerCommand("qa-attach", attachCommand);
	pi.registerCommand("attach", { ...attachCommand, description: "同 /qa-attach：进入 worker 的 tmux 窗口" });
	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "quick-agent: 选择并进入 worker 的 tmux 窗口",
		handler: async (ctx) => {
			const id = await pickTask(ctx, "进入 worker 窗口");
			if (id) await attach(id, ctx);
		},
	});

	pi.registerCommand("tasks", {
		description: "quick-agent 任务面板：查看、实时观看、接管、追加指令、中止、关闭",
		handler: async (_args, ctx) => {
			await refresh();
			const list = [...tasks.values()].filter((t) => !t.closed || t.unread).sort((a, b) => Number(b.unread) - Number(a.unread) || b.updatedAt - a.updatedAt);
			if (!list.length) return ctx.ui.notify("没有进行中的任务", "info");
			if (ctx.mode !== "tui") {
				// RPC clients may not implement dialogs: show a list plus the dashboard link instead.
				pi.sendMessage({
					customType: "qa-tasks",
					display: true,
					content: `quick-agent 任务（面板 ${dashboardUrl()}）\n${list.map((t) => `${t.unread ? "•" : " "} ${ICON[t.status] ?? "·"} ${t.id} [${t.status}] ${t.title} — ${((ACTIVE_STATUSES.includes(t.status) ? t.activity : t.summary) ?? "").split("\n")[0]?.slice(0, 100)}`).join("\n")}`,
				});
				return;
			}
			const labels = list.map((t) => `${t.unread ? "• " : "  "}${ICON[t.status] ?? "·"} ${tag(t)} [${t.status}] ${t.title}`);
			const picked = await ctx.ui.select("quick-agent 任务", labels);
			if (picked === undefined) return;
			const t = list[labels.indexOf(picked)];
			if (!t) return;
			const actions = ["查看汇报", "实时观看 worker", "接管（进入 tmux 窗口）", "追加指令", "标记已读", "中止当前运行", "关闭窗口"];
			const a = await ctx.ui.select(`${t.id} ${t.title}`, actions);
			if (a === "查看汇报") {
				const { task } = await hub.getTask(t.id, 0);
				await ctx.ui.editor(`${task.id} [${task.status}] ${task.title}`, `${task.summary ?? "(暂无汇报)"}\n\n---\n活动: ${task.activity ?? "-"}\n目录: ${task.cwd}\n会话: ${task.sessionFile ?? "-"}`);
				tasks.set(t.id, await hub.ack(t.id));
			} else if (a === "实时观看 worker") await peek(t.id, ctx);
			else if (a?.startsWith("接管")) await attach(t.id, ctx);
			else if (a === "追加指令") {
				const msg = await ctx.ui.input(`发给 ${t.id} 的追加指令`, "");
				if (msg?.trim()) tasks.set(t.id, await hub.sendMessage(t.id, msg.trim()));
			} else if (a === "标记已读") tasks.set(t.id, await hub.ack(t.id));
			else if (a === "中止当前运行") tasks.set(t.id, await hub.cancel(t.id));
			else if (a === "关闭窗口" && (await ctx.ui.confirm("关闭窗口", `关闭 ${t.id} 的 worker 窗口？`))) tasks.set(t.id, await hub.close(t.id));
			renderWidget();
		},
	});

	pi.registerCommand("hub", {
		description: "quick-agent hub 地址、面板链接与浏览器插件",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Hub ${hubUrl(cfg)} · 面板 ${dashboardUrl()} · 插件 ${hubUrl(cfg)}/extension.zip`, "info");
		},
	});

	// ---------------------------------------------------------------- lifecycle

	/** Version of the extension code loaded into this pi process. */
	const loadedVersion = readVersion(REPO_ROOT);
	let updateNotified = "";
	const notifyUpgraded = (to: string) => {
		if (!current?.hasUI || updateNotified === to || compareVersions(to, loadedVersion) <= 0) return;
		updateNotified = to;
		current.ui.notify(`quick-agent 已升级到 ${to}（当前加载 ${loadedVersion}），运行 /reload 生效`, "info");
	};

	pi.on("session_start", async (_e, ctx) => {
		current = ctx;
		// Interactive pi (terminal TUI, or RPC clients such as desktop apps) becomes the front agent.
		// Scripted pi (-p / --mode json) stays untouched.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		const off = pi.getFlag("qa-off") === true || process.env.QA_ROLE === "off";
		if (!off) {
			// Re-applied on every session start (/new, /resume, /reload) because tools reset.
			enabled = false;
			setEnabled(true, ctx);
		}
		// Background version check (throttled, silent on failure); never awaited.
		const installed = readState().installed;
		if (installed) notifyUpgraded(installed.to);
		setTimeout(() => void autoUpdate({ trigger: "pi" }).then((r) => r?.installed && notifyUpgraded(r.to)), 5000).unref?.();
		try {
			if ((await ensureHub(cfg, hub)) === "started") ctx.ui.notify(`quick-agent hub 已启动 ${hubUrl(cfg)}`, "info");
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
		}
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
					const t = e.task;
					const newsworthy = ev && (ev.kind === "report" || ev.kind === "status") && ATTENTION_STATUSES.includes(t.status) && (prev?.status !== t.status || ev.kind === "report");
					if (!newsworthy) return;
					const mine = t.owner === owner;
					if (mine || !t.owner) current?.hasUI && current.ui.notify(`${ICON[t.status]} ${t.id} ${t.title}: ${t.status}`, t.status === "done" ? "info" : "warning");
					// Reports enter the conversation only of the pi that dispatched the task.
					if (mine) {
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
				} else if (e.type === "update") {
					notifyUpgraded(e.to);
				} else if (e.type === "machines") {
					machines = e.machines;
					machinesAt = Date.now();
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

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		// Other extensions (e.g. MCP activating codemode) may have changed tools since startup.
		applyFrontTools();
		const projects = cfg.projects.length
			? cfg.projects.map((p) => `- URL 含 "${p.match}" → ${p.machine ? `${p.machine}:` : ""}${p.cwd}${p.notes ? `（${p.notes}）` : ""}`).join("\n")
			: "- （未配置）";
		const ms = await loadMachines();
		const selfLine = describeMachines(ms.filter((m) => m.self));
		event.systemPromptOptions.sections.quick_agent_front = frontRules(ctx.cwd, cfg.defaultCwd, projects, `${selfLine}\n${describeMachines(ms.filter((m) => !m.self)) || "- （没有其他机器）"}`);
	});

	// Defence in depth: in front mode only the front toolset may run.
	pi.on("tool_call", async (event) => {
		if (enabled && !FRONT_TOOLS.includes(event.toolName)) {
			return { block: true, reason: `前台模式不直接执行 ${event.toolName}：请用 qa_dispatch 委派给 worker（人类可用 /qa off 切换为普通 pi）。` };
		}
	});

	pi.on("session_shutdown", async () => {
		abort?.abort();
	});
}
