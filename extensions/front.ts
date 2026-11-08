// Front role: your normal interactive pi *is* the quick-agent front agent.
// It understands tasks, assembles context and delegates them to worker agents through the hub.
// Toggle with /qa on|off, or start pi with --qa-off (or QA_ROLE=off) for a plain pi.
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
import { priorityOf, rankMachines, resourcesOf } from "../shared/schedule.ts";
import { ACTIVE_STATUSES, ATTENTION_STATUSES, type Intake, type MachineView, type Task } from "../shared/types.ts";
import { createTeamFront, TEAM_TOOLS } from "./team-tools.ts";
import { formatWall } from "../shared/cron.ts";
import type { CronView } from "../hub/cron.ts";
import { attentionOf, itemLine, LEVEL_LABEL, type AttentionCounts, type AttentionItem, type FocusState } from "../shared/attention.ts";

const QA_TOOLS = ["qa_dispatch", "qa_cron", "qa_tasks", "qa_task_read", "qa_task_send", "qa_task_cancel", "qa_handoff", "qa_machines", "qa_remote_fs", ...TEAM_TOOLS];
const FRONT_TOOLS = ["read", "grep", "find", "ls", ...QA_TOOLS];

const ICON: Record<string, string> = {
	starting: "◌", running: "●", idle: "◐", needs_input: "?", blocked: "■", done: "✓", failed: "✕", cancelled: "⊘", exited: "○", handoff: "⇄",
};

function frontRules(cwd: string, defaultCwd: string, projects: string, machines: string): string {
	return `你是 quick-agent 工作流中的 **前台 agent**：你和人类交互，并且必须 **快**。工作方式类似中断处理的上半部：
1. 理解任务：只做最少量的澄清。只有在缺少关键信息、无法写出可执行简报时才提问，而且一次问完。
2. 组装上下文：允许快速读取少量文件、grep/ls 确认工作目录和相关位置，但不要深入调研，不要动手实现。
3. 派单：调用 qa_dispatch 把任务交给一个独立的负责人 worker。brief 必须自包含：目标、背景、相关文件/位置、约束、验收标准，以及你掌握的全部上下文（含截图路径、元素选择器、页面 URL）。worker 看不到你和人类的对话。
4. 派完立刻用一两句话回复（任务 ID、标题、工作目录），结束本轮，不要等待 worker。
5. 一次请求包含多个互相独立的任务时，分别派单。属于已有任务的追加需求，用 qa_task_send 发给对应 worker，不要新建任务。
6. 人类问进度或"有什么需要我的"时用 qa_tasks（按注意力排好：需要你 / 待扫 / 稍后 / 不用管）/ qa_task_read；要求中止时用 qa_task_cancel。
7. 注意力是人类最稀缺的资源。收到 [quick-agent 汇报] 时按它标注的注意力处理：
   - 「需要你」且消息要求你转告：用一两句话告诉人类哪个任务、需要他决定什么（问题和选项），然后结束本轮；人类回答后用 qa_task_send 转给 worker。不要替人类做决定，不要复述整份汇报。
   - 「待扫」或其他：不要主动说话，它已经进了人类的待扫队列；人类问起时再基于它回答。
8. 纯闲聊或一句话能回答的问题直接回答，不用派单。
9. 收到 [浏览器评论] 时，它来自人类在网页上框选元素后写的评论：判断它属于哪个项目/工作目录（参考下方项目映射；不确定就问人类），必要时快速确认相关源码位置，然后派单；如果它明显是某个已有任务的追加，就用 qa_task_send。
10. 你没有 bash/edit/write，这是刻意的：所有实际工作都交给 worker。
11. 多机：worker 可以跑在 mesh 里的任何在线机器上。需要了解远程机器上的目录或文件时用 qa_remote_fs（ls/read/grep，只读），本地文件仍用 read/grep/ls。
12. 选机器（每台机器的资源标签和优先级见下方列表，优先级数字越小越优先）：
   - 先判断任务需要哪些资源，把它们写进 qa_dispatch 的 requires（如 ["browser:chrome-gui"]、["macos"]、["codex"]、["gpu"]）；hub 会在满足全部资源的在线机器里选优先级最高的。没有特殊需要就不传 machine 也不传 requires，hub 自动选首选机器。
   - 任务需要人类本机的图形界面、浏览器（例如让 codex 操作人类 Mac 上的 Chrome）或人类电脑上的本地文件/应用时，必须派到那台机器（requires 写上对应资源，或直接传 machine）。
   - 人类点名机器时照做（传 machine）。代码/环境只在某台机器上时派到那台。
   - cwd 必须是选中机器上的路径，不能把一台机器的路径用到另一台。拿不准就不传 cwd：hub 会用选中机器的项目映射或默认目录；需要特定项目时，用该机器 projects/默认目录下的路径（可先用 qa_remote_fs 确认）。只传 cwd 不传 machine 时，hub 会选择该路径存在的、优先级最高的机器。
   - 资源不满足或机器离线时 qa_dispatch 会报错：不要换到不满足条件的机器硬派；拿不准该用哪台机器、或资源声明不清楚时，先问人类。

12. 人类要求把某个任务"挪到/交接到/换到"另一台机器继续时，用 qa_handoff（worker 的完整上下文、任务元数据、未提交的代码改动都会带过去，任务 id 不变）。worker 正在运行时默认等它这一轮结束；人类说"马上/立刻"才设 abort=true。目标目录有冲突时 qa_handoff 会失败并给出选项，把选项转述给人类，不要自己替他选 stash/backup。

13. 定时/周期性的事（"每天早上 9 点帮我…"、"每周一…"、"30 分钟后…"、"每 2 小时检查…"、"明天下午 3 点提醒/执行…"）用 qa_cron 建计划，不要用 qa_dispatch 立刻派单：
   - 触发规则四选一：cron（标准 5 段"分 时 日 月 周"，如每天 9 点 "0 9 * * *"、工作日 18:30 "30 18 * * 1-5"、每周一 10 点 "0 10 * * 1"）、every（固定间隔，如 "2h"、"30m"）、at（一次性时间点 "YYYY-MM-DD HH:MM"）、in（多久之后一次，如 "30m"）。时区默认 hub 所在机器的本地时区（${Intl.DateTimeFormat().resolvedOptions().timeZone}），不要自己猜时区；只有人类明确说了时区（或说的是别处的时间）才传 tz。
   - brief 是每次运行时派给 worker 的简报，要和 qa_dispatch 一样自包含（worker 看不到对话）；可用 {{date}} {{time}} {{n}} 占位符。机器/资源/cwd 的选择规则同上，到点时才选机器。
   - 只是定期汇报、成功了不用看的（如"每小时检查一下，有问题再告诉我"），设 silent=true：成功直接归档，失败或需要人类决定时照样进入「需要你」。
   - 建完用一两句话复述：计划 ID、规则、下次运行时间。人类要求查看/暂停/恢复/删除/立即运行计划时用 qa_cron 的 list/pause/resume/delete/run。

本机: ${machines.split("\n")[0]}
mesh 中的机器（qa_machines 查看最新状态）:
${machines}

当前 pi 的工作目录（本机路径；人类说"这个项目"时默认指它，派到本机时可作为 cwd）: ${cwd}
兜底工作目录: ${defaultCwd}
浏览器 URL → 工作目录映射（~/.quick-agent/config.json 的 projects）：
${projects}`;
}

export function setupFront(pi: ExtensionAPI) {
	const cfg = loadConfig();
	const hub = new HubClient(cfg);
	/** Stable id of this front agent (the Web UI sets QA_FRONT_ID so it survives restarts). */
	const owner = process.env.QA_FRONT_ID || `${hostname()}:${process.pid}`;
	let counts: AttentionCounts | undefined;
	let focus: FocusState = { on: false };
	/** Reports already in this conversation, keyed by task:level:since (rebuilt from the persisted conversation). */
	const delivered = new Set<string>();
	const reportKey = (i: AttentionItem) => `${i.taskId}:${i.level}:${i.since}`;
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
	/** "，首选" for the machine an unconstrained dispatch lands on. */
	const rank = (_list: MachineView[], m: MachineView) => (machines.length && m.online && rankMachines(machines.filter((x) => x.online))[0]?.id === m.id ? "，默认首选" : "");
	const team = createTeamFront(pi, hub, (t) => {
		tasks.set(t.id, t);
		renderWidget();
	});
	const describeMachines = (list: MachineView[]) =>
		(list.length ? list : [{ id: cfg.machine.id, self: true, online: true, hops: 0 } as MachineView])
			.map(
				(m) =>
					`- ${m.id}${m.self ? "（本机）" : ""} ${m.online ? "在线" : "离线"}${m.hops > 1 ? `，经 ${m.via} 转发` : ""}${m.description ? `：${m.description}` : ""}${m.owner ? `；所有者 ${m.owner}` : ""}；优先级 ${priorityOf(m)}${rank(list, m)}；资源 ${resourcesOf(m).join(", ") || "（未声明）"}${m.resourceNotes ? `（${m.resourceNotes}）` : ""}${m.platform ? `；系统 ${m.platform}` : ""}${m.defaultCwd ? `；默认目录 ${m.defaultCwd}` : ""}${m.activeTasks ? `；运行中任务 ${m.activeTasks}` : ""}${m.projects?.length ? `；项目 ${m.projects.map((p) => `${p.match}→${p.cwd}`).join(", ")}` : ""}`,
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
				const detail = ACTIVE_STATUSES.includes(t.status) || t.status === "handoff" ? (t.activity ?? "") : (t.summary ?? "").split("\n")[0];
				return `${mark}${th.fg(color as any, `${ICON[t.status] ?? "·"} ${tag(t)}`)} ${t.title}${detail ? th.fg("dim", ` — ${detail.slice(0, 70)}`) : ""}`;
			});
			if (list.length > 8) lines.push(th.fg("dim", `  … 还有 ${list.length - 8} 个任务（/tasks）`));
			if (counts?.need) lines.unshift(th.fg("warning", `需要你 ${counts.need}${counts.skim ? ` · 待扫 ${counts.skim}` : ""}${focus.on ? " · 专注" : ""}`));
			ctx.ui.setWidget("qa-tasks", lines);
		}
		const active = list.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
		const need = counts?.need ?? 0;
		const skim = counts?.skim ?? 0;
		const mode = enabled ? "quick-agent" : "plain pi";
		ctx.ui.setStatus("qa", `${mode}${connected ? "" : " · hub offline"}${need ? ` · 需要你 ${need}` : ""}${skim ? ` · 待扫 ${skim}` : ""} · ${active} running${focus.on ? " · 专注" : ""}`);
	};

	const refresh = async () => {
		try {
			const [list, q] = await Promise.all([hub.listTasks(), hub.attention(0)]);
			for (const t of list) tasks.set(t.id, t);
			counts = q.counts;
			focus = q.focus;
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

	// ---------------------------------------------------------------- reports → front agent (attention-routed)
	//
	// Reports are routed by task and attention, not by which conversation dispatched the task:
	//  - every connected front agent (Web UI, terminal pi) gets every 需要你 / 待扫 report as a card in its
	//    conversation (deduplicated per conversation), so nothing depends on the dispatcher still running;
	//  - only one front speaks up proactively for 需要你: the hub picks it (dispatcher if online, else the
	//    persistent Web UI front, else any) and marks it in the attention event; 待扫 never triggers a turn;
	//  - on (re)connect a front catches up on 需要你 / 待扫 items it has not shown yet, in one message.

	const rememberDelivered = (ctx?: ExtensionContext) => {
		try {
			for (const en of (ctx?.sessionManager.getEntries() ?? []) as any[]) {
				if (en?.type !== "custom_message" || en.customType !== "qa-report") continue;
				for (const k of [en.details?.key, ...(en.details?.keys ?? [])]) if (k) delivered.add(k);
			}
		} catch {}
	};

	const reportText = (i: AttentionItem, t?: Task) =>
		[
			`[quick-agent 汇报] ${i.taskId} "${i.title}" → ${i.status} · 注意力: ${LEVEL_LABEL[i.level]} ${i.mark}`,
			// The summary follows; repeat the reason only when it adds something (no explicit question, not a plain hand-back).
			i.level === "need" && !i.question ? `原因: ${i.reason}` : "",
			i.question ? `问题: ${i.question}` : "",
			i.options?.length ? `选项: ${i.options.join(" / ")}` : "",
			(t?.summary ?? "").slice(0, 3000),
		]
			.filter(Boolean)
			.join("\n");

	const onAttention = (i: AttentionItem, interrupt: "now" | "digest" | "none", speakUp: boolean) => {
		if (!enabled || (i.level !== "need" && i.level !== "skim")) return;
		if (interrupt === "now" && current?.hasUI) current.ui.notify(`需要你 ${i.mark} ${i.taskId} ${i.title}：${i.reason.slice(0, 80)}`, "warning");
		const key = reportKey(i);
		if (delivered.has(key) || interrupt === "none") return;
		delivered.add(key);
		const proactive = interrupt === "now" && speakUp;
		const content = reportText(i, tasks.get(i.taskId)) + (proactive ? "\n（这件事需要人类决定：请用一两句话转告人类，等他回答。）" : "");
		const msg = { customType: "qa-report", content, display: true, details: { taskId: i.taskId, status: i.status, level: i.level, key } };
		if (proactive) pi.sendMessage(msg, current && !current.isIdle() ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true });
		else pi.sendMessage(msg, { triggerTurn: false });
	};

	const catchUp = async () => {
		if (!enabled) return;
		let q: Awaited<ReturnType<HubClient["attention"]>>;
		try {
			q = await hub.attention(0);
		} catch {
			return;
		}
		counts = q.counts;
		focus = q.focus;
		renderWidget();
		const missed = q.items.filter((i) => (i.level === "need" || i.level === "skim") && !delivered.has(reportKey(i)));
		if (!missed.length) return;
		for (const i of missed) delivered.add(reportKey(i));
		const text = [
			`[quick-agent 汇报] 你不在时有 ${missed.length} 件事更新（需要你 ${missed.filter((i) => i.level === "need").length} · 待扫 ${missed.filter((i) => i.level === "skim").length}）`,
			...missed.map((i) => `- ${LEVEL_LABEL[i.level]} ${itemLine(i)}`),
		].join("\n");
		pi.sendMessage({ customType: "qa-report", content: text, display: true, details: { catchUp: true, keys: missed.map(reportKey) } }, { triggerTurn: false });
	};

	// ---------------------------------------------------------------- tools

	pi.registerTool({
		name: "qa_dispatch",
		label: "Dispatch task",
		defaultActive: false,
		description:
			"Delegate a task to a new, independent worker agent (a full pi agent in its own tmux window, which the human can take over) that owns the task until done. Returns immediately with the task id.",
		promptSnippet: "Delegate a task to an independent worker agent (returns immediately)",
		promptGuidelines: ["Use qa_dispatch for any real work (coding, debugging, research, edits); the qa_dispatch brief must be self-contained."],
		parameters: Type.Object({
			title: Type.String({ description: "Short task title (Chinese ok), distinguishes it from other tasks" }),
			cwd: Type.Optional(
				Type.String({ description: "Absolute working directory ON THE TARGET MACHINE. Omit to use the chosen machine's project mapping / default directory." }),
			),
			brief: Type.String({ description: "Self-contained task brief: goal, context, relevant files, constraints, acceptance criteria" }),
			attachments: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths of files the worker should look at (e.g. screenshots)" })),
			intake_id: Type.Optional(Type.String({ description: "Browser comment id when dispatching a [浏览器评论]" })),
			machine: Type.Optional(
				Type.String({ description: "Machine id (from qa_machines) to run the worker on. Omit to let the hub pick the online machine with the best priority that has all `requires`." }),
			),
			requires: Type.Optional(
				Type.Array(Type.String(), { description: 'Resource tags the worker needs, e.g. ["browser:chrome-gui"], ["macos"], ["codex"], ["gpu"]. "browser" matches any browser:* tag.' }),
			),
			reviewer: Type.Optional(Type.String({ description: "Team: member id asked to verify/decide when the worker hands back (\"让 Alice 验收\")" })),
			assignee: Type.Optional(Type.String({ description: "Team: member id responsible for the task instead of the requester (\"交给 Bob 负责\")" })),
			watchers: Type.Optional(Type.Array(Type.String(), { description: "Team: member ids who follow the task quietly" })),
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
				requires: p.requires,
				reviewer: p.reviewer,
				assignee: p.assignee,
				watchers: p.watchers,
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

	const cronLine = (j: CronView) =>
		`${j.id} [${j.finished ? "done" : j.enabled ? (j.running ? "running" : "on") : "paused"}] ${j.title} — ${j.describe}${j.nextRunAt ? `; next ${formatWall(j.nextRunAt, j.tz)} ${j.tz}` : ""}${j.hub !== selfId() ? `; hub ${j.hub}` : ""}${j.silent ? "; silent" : ""}${j.tasks[0] ? `; last ${j.tasks[0].id} ${j.tasks[0].status ?? "?"}` : ""}`;

	pi.registerTool({
		name: "qa_cron",
		label: "Scheduled tasks",
		defaultActive: false,
		description:
			"Scheduled (cron) tasks: when a plan is due the hub dispatches a new worker task with its brief. action=create needs title, brief and exactly one of cron (5-field 'm h dom mon dow'), every ('2h'), at ('YYYY-MM-DD HH:MM' in tz) or in ('30m'). Other actions: list, delete, pause, resume, run (run once now; need id).",
		promptSnippet: "Create / list / pause / resume / delete / run scheduled worker tasks (cron, every, at, in)",
		promptGuidelines: ["Use qa_cron (not qa_dispatch) when the human asks for something recurring or at a later time (每天/每周/每隔/…分钟后/明天…点)."],
		parameters: Type.Object({
			action: StringEnum(["create", "list", "delete", "pause", "resume", "run"] as const),
			id: Type.Optional(Type.String({ description: "Plan id (s1234) for delete/pause/resume/run" })),
			title: Type.Optional(Type.String({ description: "Short plan title" })),
			brief: Type.Optional(Type.String({ description: "Self-contained brief for each run's worker; {{date}} {{time}} {{n}} are substituted" })),
			cron: Type.Optional(Type.String({ description: 'Standard 5-field cron, e.g. "0 9 * * *" (daily 09:00), "30 18 * * 1-5"' })),
			every: Type.Optional(Type.String({ description: 'Fixed interval, e.g. "2h", "30m"' })),
			at: Type.Optional(Type.String({ description: 'One-off wall time "YYYY-MM-DD HH:MM" in tz' })),
			in: Type.Optional(Type.String({ description: 'One-off delay from now, e.g. "30m"' })),
			tz: Type.Optional(Type.String({ description: "IANA time zone (default: the hub machine's local zone)" })),
			machine: Type.Optional(Type.String({ description: "Machine to run on (default: chosen at fire time)" })),
			requires: Type.Optional(Type.Array(Type.String(), { description: "Resource tags each run needs" })),
			cwd: Type.Optional(Type.String({ description: "Working directory on the target machine" })),
			silent: Type.Optional(Type.Boolean({ description: "Archive successful runs right away (failures still need the human)" })),
			overlap: Type.Optional(StringEnum(["skip", "queue", "parallel"] as const, { description: "When the previous run is still going (default skip)" })),
		}),
		async execute(_id, p) {
			if (p.action === "list") {
				const r = await hub.listCron();
				const text = r.jobs.length ? r.jobs.map(cronLine).join("\n") : "No scheduled tasks.";
				return { content: [{ type: "text", text }], details: { count: r.jobs.length } };
			}
			if (p.action === "create") {
				if (!p.title || !p.brief) throw new Error("create needs title and brief");
				const job = await hub.createCron({
					title: p.title,
					brief: p.brief,
					cron: p.cron,
					every: p.every,
					at: p.at,
					in: p.in,
					tz: p.tz,
					machine: p.machine,
					requires: p.requires,
					cwd: p.cwd,
					silent: p.silent,
					overlap: p.overlap,
					createdBy: "tui",
				});
				return { content: [{ type: "text", text: `Created ${cronLine(job)}` }], details: { job } };
			}
			if (!p.id) throw new Error(`${p.action} needs id`);
			if (p.action === "run") {
				const r = await hub.runCron(p.id);
				return { content: [{ type: "text", text: r.run.result === "dispatched" ? `Ran ${p.id} now: task ${r.run.taskId} on ${r.run.machine}.` : `Run of ${p.id} failed: ${r.run.reason}` }], details: r };
			}
			const job = await hub.cronAction(p.id, p.action);
			return { content: [{ type: "text", text: p.action === "delete" ? `Deleted ${p.id} "${job.title}".` : cronLine(job as CronView) }], details: { job } };
		},
	});

	pi.registerTool({
		name: "qa_tasks",
		label: "List tasks",
		defaultActive: false,
		description: "List quick-agent tasks as the attention queue of the person you work for (需要你 / 待扫 / 稍后 / 不用管 / 已归档), most urgent first, with the reason and latest summary.",
		parameters: Type.Object({
			include_closed: Type.Optional(Type.Boolean({ description: "Include archived tasks" })),
			scope: Type.Optional(StringEnum(["mine", "team"] as const, { description: "Team: mine (default) = that person's queue; team = everyone's open tasks and who holds the ball" })),
		}),
		async execute(_id, p) {
			const [list, q] = await Promise.all([hub.listTasks(), hub.attention(p.include_closed ? 40 : 0, p.scope)]);
			for (const t of list) tasks.set(t.id, t);
			counts = q.counts;
			focus = q.focus;
			renderWidget();
			await team.load();
			const byId = new Map(list.map((t) => [t.id, t]));
			const shown = q.items.slice(0, 40);
			const c = q.counts;
			const head = `${p.scope === "team" ? "团队视图 · " : ""}需要你 ${c.need} · 待扫 ${c.skim} · 稍后 ${c.snoozed} · 不用管 ${c.inflight}${focus.on ? " · 专注模式开启" : ""}`;
			const text = shown.length
				? `${head}\n${shown
						.map((i) => {
							const t = byId.get(i.taskId);
							return `${LEVEL_LABEL[i.level]} ${itemLine(i)}${t ? `\n    ${t.machine}:${t.cwd}${team.people(t)}` : ""}${i.options?.length ? `\n    选项: ${i.options.join(" / ")}` : ""}`;
						})
						.join("\n")}`
				: "No tasks.";
			return { content: [{ type: "text", text }], details: { count: shown.length, counts: q.counts } };
		},
	});

	pi.registerTool({
		name: "qa_task_read",
		label: "Read task",
		defaultActive: false,
		description: "Read one quick-agent task: brief, status, attention, latest worker summary and recent events. A finished (待扫) task is marked as seen.",
		parameters: Type.Object({ id: Type.String(), events: Type.Optional(Type.Number({ description: "Recent events to include (default 15)" })) }),
		async execute(_id, p) {
			const { task, events, comments } = await hub.getTask(p.id, p.events ?? 15);
			await team.load();
			const att = attentionOf(task);
			// Reading on the human's behalf settles 待扫, but never a question that still waits on the human.
			const acked = att.level === "skim" ? await hub.ack(task.id).catch(() => task) : task;
			tasks.set(task.id, acked);
			renderWidget();
			const text = [
				`${task.id} "${task.title}" status=${task.status} machine=${task.machine} cwd=${task.cwd}`,
				`attention: ${LEVEL_LABEL[att.level]} ${att.mark} ${att.reason}${task.ask?.options?.length ? ` (options: ${task.ask.options.join(" / ")})` : ""}`,
				`tmux: ${task.tmuxTarget ?? "-"}`,
				task.activity ? `activity: ${task.activity}` : "",
				team.people(task) ? `people:${team.people(task)}` : "",
				`--- summary ---\n${task.summary ?? "(none yet)"}`,
				comments?.length ? `--- comments ---\n${comments.slice(-10).map((c) => `${new Date(c.ts).toLocaleTimeString()} ${c.author}: ${c.text.slice(0, 400)}`).join("\n")}` : "",
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
		description: "Send a follow-up instruction (or the human's answer) to the worker owning a quick-agent task. Restarts the worker with its full context if its window was closed.",
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
		name: "qa_handoff",
		label: "Hand off task",
		defaultActive: false,
		description:
			"Move a quick-agent task to another online machine of the mesh, losslessly: the worker's full context (conversation history), task metadata/events and the workspace (git commit + staged/unstaged diff + untracked files, or a tar of a non-git dir) are transferred, verified by hash, and the worker resumes there under the same task id. Asynchronous: returns once the handoff has started (task status becomes 'handoff'); check progress with qa_task_read.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			machine: Type.String({ description: "Target machine id (from qa_machines)" }),
			cwd: Type.Optional(Type.String({ description: "Target working directory on that machine (default: derived from project mapping / home dir / same path)" })),
			no_workspace: Type.Optional(Type.Boolean({ description: "Do not transfer the workspace (target cwd must already exist)" })),
			abort: Type.Optional(Type.Boolean({ description: "Interrupt a running worker instead of waiting for its turn to end" })),
			on_conflict: Type.Optional(StringEnum(["fail", "stash", "backup"] as const, { description: "Only when the human chose it: what to do with conflicting state in the target dir (default fail)" })),
		}),
		async execute(_id, p) {
			const task = await hub.handoff(p.id, { to: p.machine, cwd: p.cwd, noWorkspace: p.no_workspace, abort: p.abort, onConflict: p.on_conflict });
			tasks.set(task.id, task);
			renderWidget();
			return {
				content: [{ type: "text", text: `Handoff of ${task.id} to ${p.machine} started (status ${task.status}: ${task.activity ?? ""}). Progress and result appear in the task's activity/events (qa_task_read).` }],
				details: { task },
			};
		},
	});

	pi.registerTool({
		name: "qa_machines",
		label: "Machines",
		defaultActive: false,
		description: "List machines in the quick-agent mesh (id, online, priority, resource tags, description, default cwd, projects, active tasks). Workers can be dispatched to any online machine that has the required resources.",
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
						const head = `${theme.fg("accent", `■ ${t ? tag(t) : id}`)} ${t?.title ?? ""} ${theme.fg("dim", `[${t?.status ?? "?"}]`)}`;
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
		description: "quick-agent 注意力队列：需要你 / 待扫 / 稍后 / 不用管；查看、回答、知道了、稍后提醒、接管、中止",
		handler: async (_args, ctx) => {
			await refresh();
			const order = { need: 0, skim: 1, snoozed: 2, inflight: 3, archived: 4 } as const;
			const list = [...tasks.values()]
				.map((t) => ({ t, a: attentionOf(t) }))
				.filter(({ a }) => a.level !== "archived")
				.sort((x, y) => order[x.a.level] - order[y.a.level] || y.t.updatedAt - x.t.updatedAt);
			if (!list.length) return ctx.ui.notify("没有需要你的事，也没有进行中的任务", "info");
			if (ctx.mode !== "tui") {
				// RPC clients may not implement dialogs: show the queue as a message instead.
				pi.sendMessage({
					customType: "qa-tasks",
					display: true,
					content: `quick-agent 注意力队列\n${list.map(({ t, a }) => `${LEVEL_LABEL[a.level]} ${a.mark} ${t.id} ${t.title} — ${a.reason.slice(0, 100)}`).join("\n")}`,
				});
				return;
			}
			const labels = list.map(({ t, a }) => `${LEVEL_LABEL[a.level]} ${a.mark} ${tag(t)} ${t.title}`);
			const picked = await ctx.ui.select("quick-agent 注意力队列", labels);
			if (picked === undefined) return;
			const t = list[labels.indexOf(picked)]?.t;
			if (!t) return;
			const actions = ["查看汇报", "回答 / 追加指令", "知道了", "稍后提醒（1 小时）", "实时观看 worker", "接管（进入 tmux 窗口）", "中止当前运行", "关闭窗口"];
			const a = await ctx.ui.select(`${t.id} ${t.title}`, actions);
			if (a === "查看汇报") {
				const { task } = await hub.getTask(t.id, 0);
				const att = attentionOf(task);
				await ctx.ui.editor(`${task.id} [${LEVEL_LABEL[att.level]}] ${task.title}`, `${task.summary ?? "(暂无汇报)"}\n\n---\n注意力: ${LEVEL_LABEL[att.level]} ${att.mark} ${att.reason}\n活动: ${task.activity ?? "-"}\n目录: ${task.cwd}\n接管: /attach ${task.id}`);
				if (att.level === "skim") tasks.set(t.id, await hub.ack(t.id));
			} else if (a === "实时观看 worker") await peek(t.id, ctx);
			else if (a?.startsWith("接管")) await attach(t.id, ctx);
			else if (a === "回答 / 追加指令") {
				const msg = await ctx.ui.input(`发给 ${t.id} 的追加指令`, "");
				if (msg?.trim()) tasks.set(t.id, await hub.sendMessage(t.id, msg.trim()));
			} else if (a === "知道了") tasks.set(t.id, await hub.ack(t.id));
			else if (a?.startsWith("稍后提醒")) tasks.set(t.id, await hub.snooze(t.id, 60));
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
		delivered.clear();
		rememberDelivered(ctx);
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
					tasks.set(e.task.id, e.task);
					renderWidget();
				} else if (e.type === "attention") {
					counts = e.counts;
					focus = e.focus;
					renderWidget();
					onAttention(e.item, e.interrupt, e.front === owner);
				} else if (e.type === "attention.digest") {
					counts = e.counts;
					renderWidget();
					if (enabled && current?.hasUI) current.ui.notify(`待扫 ${e.items.length} 件：${e.items.slice(0, 4).map((i) => i.title.slice(0, 24)).join("、")}`, "info");
				} else if (e.type === "attention.state") {
					counts = e.counts;
					focus = e.focus;
					renderWidget();
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
				if (ok) void catchUp();
			},
			{ role: "front", front: owner },
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
		const teamRules = await team.prompt(ms);
		event.systemPromptOptions.sections.quick_agent_front = frontRules(ctx.cwd, cfg.defaultCwd, projects, `${selfLine}\n${describeMachines(ms.filter((m) => !m.self)) || "- （没有其他机器）"}`) + (teamRules ? `\n\n${teamRules}` : "");
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
