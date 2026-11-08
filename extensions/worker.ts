// Worker role: turns a pi agent into the owner ("负责人") of one quick-agent task.
// Selected by extensions/quick-agent.ts when QA_TASK_ID is set (the hub sets it when spawning a worker).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { HubClient } from "../shared/hub-client.ts";

const WORKER_RULES = `你是 quick-agent 工作流中的 **负责人 worker**。前台 agent 把一个任务完整地交给了你，由你独立负责到底：
- 任务简报在第一条消息里。按简报的目标和验收标准把事情完整做完，不要只做一半就回头请示。
- 人类的注意力是最稀缺的资源。只有真正需要人类决策时（需求含糊到无法合理假设、破坏性或不可逆操作、缺少权限或凭证），才调用 qa_report(status="needs_input", needs_human=true, question="一句话的问题", options=["建议选项A","选项B"])，summary 里写清背景，然后结束本轮等待回复。这会立即通知人类；能合理假设的就自己决定，并在最终汇报里说明。
- 遇到无法继续的阻塞，调用 qa_report(status="blocked")。
- 完成后必须调用 qa_report(status="done")。summary 用简洁的中文写：做了什么、改了哪些文件、如何验证的、遗留问题。这是人类在收件箱里看到的内容，必须能独立看懂。
- 较长任务中途可以用 status="progress" 汇报关键进展（不要频繁）。
- 之后可能收到以【quick-agent 追加指令】开头的消息，把它当作同一任务的延续，处理完再次 qa_report。
- 团队协作：简报里可能写着发起人、负责人和验收人（成员 id）。qa_report 的汇报和提问会自动交给该拍板的人。需要问某个具体的人、或让别人知道某件事时，用 qa_comment 在任务下评论并写 @成员id（例如 @alice）；收到以【团队评论】开头的消息时，那是队友在任务下写给你的。`;

export function setupWorker(pi: ExtensionAPI, taskId: string) {
	let hub: HubClient | undefined;
	let abort: AbortController | undefined;
	let reportedThisRun = false;
	let cancelRequested = false;
	let lastActivityAt = 0;
	let current: ExtensionContext | undefined;

	const report = (body: Parameters<HubClient["report"]>[1]) => hub?.report(taskId, body).catch(() => undefined);

	pi.registerTool({
		name: "qa_report",
		label: "Report to quick-agent",
		description:
			"Report the state of your quick-agent task to the human's attention queue. status: done (task complete; lands in 待扫, never interrupts), needs_input (a human decision is required: set needs_human=true with a one-line question and options; interrupts the human immediately), blocked (cannot continue; also interrupts), progress (milestone update; task continues, no notification).",
		promptSnippet: "Report task status (done / needs_input / blocked / progress) to the human's quick-agent inbox",
		promptGuidelines: [
			"Call qa_report with status=done and a self-contained Chinese summary when the quick-agent task is complete.",
			"Call qa_report with status=needs_input, needs_human=true, a one-line question and options, then end your turn, only when a human decision is truly required.",
		],
		parameters: Type.Object({
			status: StringEnum(["done", "needs_input", "blocked", "progress"] as const),
			summary: Type.String({ description: "Self-contained summary or question for the human (Chinese, markdown ok)" }),
			needs_human: Type.Optional(Type.Boolean({ description: "true when you need a human decision before you can continue (explicit attention request)" })),
			question: Type.Optional(Type.String({ description: "With needs_human: the decision you need, one line" })),
			options: Type.Optional(Type.Array(Type.String(), { description: "With needs_human: suggested answers the human can pick" })),
		}),
		async execute(_id, params) {
			if (params.status !== "progress") reportedThisRun = true;
			const status = params.status === "progress" ? "running" : params.status;
			let error: string | undefined;
			try {
				if (!hub) throw new Error("hub client not initialised");
				const needsHuman = params.needs_human === true || (params.status === "needs_input" && !!params.question);
				await hub.report(taskId, {
					status,
					summary: params.summary,
					kind: "report",
					...(needsHuman ? { needsHuman: true, question: params.question ?? params.summary.split("\n")[0], options: params.options } : {}),
				});
			} catch (e) {
				error = (e as Error).message;
			}
			return {
				content: [{ type: "text", text: error ? `Report NOT delivered: ${error}` : `Reported ${params.status} to the human's attention queue.` }],
				details: { status: params.status, error },
			};
		},
	});

	pi.registerTool({
		name: "qa_comment",
		label: "Comment on task",
		description:
			"Post a comment on your quick-agent task, visible to the team. Write @memberid to call a specific person (it lands in their 'needs you' queue), e.g. '@alice 两种方案选哪个？'. Omit text to read the task's comments.",
		promptSnippet: "Comment on your task / @mention a team member",
		parameters: Type.Object({ text: Type.Optional(Type.String({ description: "Comment (Chinese ok); @id mentions a team member" })) }),
		async execute(_id, params) {
			if (!hub) throw new Error("hub client not initialised");
			if (!params.text?.trim()) {
				const list = await hub.comments(taskId, 50);
				return { content: [{ type: "text", text: list.length ? list.map((c) => `${new Date(c.ts).toLocaleString()} ${c.author}: ${c.text}`).join("\n") : "(no comments)" }], details: {} };
			}
			const r = await hub.comment(taskId, params.text, { asWorker: true });
			return { content: [{ type: "text", text: `Commented${r.comment.mentions.length ? `, mentioned ${r.comment.mentions.join(", ")}` : " (no one mentioned)"}.` }], details: {} };
		},
	});

	pi.on("session_start", async (_e, ctx) => {
		current = ctx;
		hub = new HubClient();
		abort?.abort();
		abort = new AbortController();
		void report({ sessionFile: ctx.sessionManager.getSessionFile(), kind: "session", activity: "worker 已连接" });
		if (ctx.hasUI) ctx.ui.setStatus("qa", `■ quick-agent ${taskId}`);
		hub.subscribe(
			(e) => {
				const c = current;
				if (!c || !("taskId" in e) || e.taskId !== taskId) return;
				if (e.type === "task.message") {
					cancelRequested = false;
					const text = `【quick-agent 追加指令】\n${e.text}`;
					if (c.isIdle()) pi.sendUserMessage(text);
					else pi.sendUserMessage(text, { deliverAs: "steer" });
					if (c.hasUI) c.ui.notify("收到追加指令", "info");
				} else if (e.type === "task.cancel") {
					cancelRequested = true;
					if (!c.isIdle()) c.abort();
					if (c.hasUI) c.ui.notify("任务已被取消（再发送指令即可恢复）", "warning");
				}
			},
			abort.signal,
			undefined,
			{ role: "worker", task: taskId },
		);
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.quick_agent_worker = WORKER_RULES;
	});

	pi.on("agent_start", async () => {
		reportedThisRun = false;
		void report({ status: "running", activity: "思考中" });
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "qa_report") return;
		const now = Date.now();
		if (now - lastActivityAt < 1500) return;
		lastActivityAt = now;
		void report({ activity: describeTool(event.toolName, event.args), kind: "activity" });
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (cancelRequested || reportedThisRun) return;
		// Stopped without an explicit report: surface the last answer so the human sees it.
		const last = lastAssistantText(ctx);
		void report({
			status: "idle",
			summary: event.aborted ? `(已中断) ${last ?? ""}`.trim() : (last ?? "(worker 停下了，没有输出)"),
			kind: "report",
		});
	});

	pi.on("session_shutdown", async (event) => {
		abort?.abort();
		if (event.reason === "quit") await report({ status: "exited", activity: "pi 已退出" });
	});
}

function describeTool(name: string, args: any): string {
	const a = args ?? {};
	const s = a.path ?? a.command ?? a.pattern ?? a.query ?? "";
	return `${name}${s ? ` ${String(s).replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e: any = branch[i];
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = e.message.content;
		const text = Array.isArray(content)
			? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
			: String(content ?? "");
		if (text.trim()) return text.trim().slice(0, 4000);
	}
	return undefined;
}
