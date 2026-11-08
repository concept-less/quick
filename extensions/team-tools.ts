// Team tools of the front agent (docs/team-collaboration.md): who is on the team, hand tasks to people,
// ask someone to verify/decide, comment with @mentions. Registered by extensions/front.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HubClient } from "../shared/hub-client.ts";
import { displayName, holderOf, participants, type PublicMember } from "../shared/team.ts";
import { ACTIVE_STATUSES, type MachineView, type Task } from "../shared/types.ts";

export const TEAM_TOOLS = ["qa_task_assign", "qa_comment", "qa_team"];

interface TeamState {
	me?: PublicMember;
	root: boolean;
	members: (PublicMember & { machines: string[] })[];
	at: number;
}

export function createTeamFront(pi: ExtensionAPI, hub: HubClient, onTask: (t: Task) => void) {
	let st: TeamState = { root: true, members: [], at: 0 };
	const load = async (maxAgeMs = 30_000) => {
		if (Date.now() - st.at < maxAgeMs) return st;
		try {
			const r = await hub.team();
			st = { me: r.me, root: r.root, members: r.members, at: Date.now() };
		} catch {}
		return st;
	};
	const name = (id?: string) => displayName(id, st.members);
	const people = (t: Task) => {
		if (!st.members.length) return "";
		const h = ACTIVE_STATUSES.includes(t.status) ? `worker${t.assignee ? `（负责 ${name(t.assignee)}）` : ""}` : name(holderOf(t)) === "-" ? "owner" : name(holderOf(t));
		return ` 发起 ${name(t.requester)} · 球在 ${h}${t.reviewer ? ` · 验收 ${name(t.reviewer)}` : ""}${t.watchers?.length ? ` · 关注 ${t.watchers.join(",")}` : ""}${t.comments ? ` · 评论 ${t.comments}` : ""}`;
	};
	const mine = (t: Task) => {
		const me = st.me?.id;
		if (!me) return true;
		return participants(t).includes(me) || (t.pings ?? []).some((p) => p.user === me) || (!holderOf(t) && st.me?.role === "owner");
	};

	/** System prompt section; empty when there is no team. */
	const prompt = async (machines: MachineView[]) => {
		const s = await load();
		if (!s.members.length) return "";
		const roster = s.members
			.map((m) => {
				const owned = machines.filter((x) => x.owner === m.id).map((x) => x.id);
				return `- ${m.id}（${m.name}，${m.role}）${owned.length ? `；机器 ${owned.join(", ")}` : ""}${m.id === s.me?.id ? " ← 你正在为他工作" : ""}`;
			})
			.join("\n");
		return `团队（多人协作，每个人只看到需要自己的事）：
你在为 ${s.me ? `${s.me.id}（${s.me.name}）` : "本机 root"} 工作；他就是你派出任务的发起人。成员名册：
${roster}
规则：
- 「让 X 验收/拍板/review」→ 新任务在 qa_dispatch 里传 reviewer；已有任务用 qa_task_assign(reviewer)。worker 交回时，球就到 X 手里，进 X 的「需要你」，不进发起人的。
- 「转给 X / 交给 X 负责」→ qa_task_assign(assignee=X)：X 成为负责人，worker 的提问和汇报交给 X。
- 「交给 X 的机器做」→ 只是选机器：qa_dispatch 的 machine 填 X 拥有的机器（见上面和 qa_machines 的所有者），人不变。
- 「问问 X」「告诉 X」「让 X 看一下」→ qa_comment，正文里写 @X；@worker 会把评论转给任务的 worker；@all 点名全体。
- 「抄送 X / 让 X 关注」→ watchers。关注者不会被打扰。
- 成员只能用上面名册里的 id；名字对不上或有歧义时先问人类，不要猜。`;
	};

	pi.registerTool({
		name: "qa_team",
		label: "Team",
		defaultActive: false,
		description: "List team members (id, name, role, owned machines) and who you are working for.",
		parameters: Type.Object({}),
		async execute() {
			const s = await load(0);
			const text = s.members.length
				? `${s.members.map((m) => `${m.id} (${m.name}, ${m.role})${m.machines.length ? ` machines: ${m.machines.join(", ")}` : ""}`).join("\n")}\nyou work for: ${s.me?.id ?? "root"}`
				: "No team configured (single user).";
			return { content: [{ type: "text", text }], details: { members: s.members } };
		},
	});

	pi.registerTool({
		name: "qa_task_assign",
		label: "Assign task",
		defaultActive: false,
		description:
			"Team: change who is involved in a task. assignee = a team member who becomes responsible (gets the worker's questions and reports; 'agent' hands it back to the worker), reviewer = a member asked to verify/decide (the hand-back goes into their 'needs you' queue), watchers = members who follow it quietly. Use member ids from the team roster; null/'' clears.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			assignee: Type.Optional(Type.String({ description: "Member id, or 'agent' to hand back to the worker" })),
			reviewer: Type.Optional(Type.String({ description: "Member id asked to verify / decide; 'none' clears" })),
			watchers_add: Type.Optional(Type.Array(Type.String())),
			watchers_remove: Type.Optional(Type.Array(Type.String())),
			note: Type.Optional(Type.String({ description: "One line for the person, e.g. what to check" })),
		}),
		async execute(_id, p) {
			const body: Parameters<HubClient["assign"]>[1] = {};
			if (p.assignee !== undefined) body.assignee = ["agent", "worker", "none", ""].includes(p.assignee) ? null : p.assignee;
			if (p.reviewer !== undefined) body.reviewer = ["none", ""].includes(p.reviewer) ? null : p.reviewer;
			if (p.watchers_add?.length) body.watchersAdd = p.watchers_add;
			if (p.watchers_remove?.length) body.watchersRemove = p.watchers_remove;
			if (p.note) body.note = p.note;
			const t = await hub.assign(p.id, body);
			onTask(t);
			await load();
			return { content: [{ type: "text", text: `${t.id} "${t.title}":${people(t)}` }], details: { task: t } };
		},
	});

	pi.registerTool({
		name: "qa_comment",
		label: "Comment on task",
		defaultActive: false,
		description:
			"Team: post a comment on a task. @id mentions a member (it lands in their 'needs you'), @all mentions everyone, @worker forwards the comment to the task's worker as an instruction. Without mentions it is just a note on the task (nobody is interrupted). Omit text to read the comments.",
		parameters: Type.Object({ id: Type.String(), text: Type.Optional(Type.String()) }),
		async execute(_id, p) {
			if (!p.text?.trim()) {
				const list = await hub.comments(p.id, 50);
				await load();
				const text = list.length ? list.map((c) => `${new Date(c.ts).toLocaleString()} ${name(c.author)}: ${c.text}`).join("\n") : "(no comments)";
				return { content: [{ type: "text", text }], details: { comments: list } };
			}
			const r = await hub.comment(p.id, p.text);
			onTask(r.task);
			return {
				content: [{ type: "text", text: `Commented on ${r.task.id}${r.comment.mentions.length ? `, mentioned ${r.comment.mentions.join(", ")}` : " (no one mentioned)"}${r.comment.toWorker ? ", forwarded to the worker" : ""}.` }],
				details: { comment: r.comment },
			};
		},
	});

	return { load, prompt, people, mine, state: () => st };
}
