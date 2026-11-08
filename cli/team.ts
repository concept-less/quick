// `quick team …`, `quick assign`, `quick comment`: team collaboration from the command line
// (docs/team-collaboration.md).
import { hubUrl, saveConfigPatch, type QaConfig } from "../shared/config.ts";
import { HubClient } from "../shared/hub-client.ts";
import { displayName, type Role } from "../shared/team.ts";

function die(msg: string): never {
	console.error(`quick: ${msg}`);
	process.exit(1);
}
function take(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
}
function bool(args: string[], name: string): boolean {
	const i = args.indexOf(name);
	if (i >= 0) args.splice(i, 1);
	return i >= 0;
}
const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export const TEAM_HELP = `团队（docs/team-collaboration.md）:
  quick team                              成员、角色、各自的机器；你是谁
  quick team init <id> [--name 名字]       第一位 owner，并把本机设为他的机器（机器 token 即代表他）
  quick team invite [--role member|owner] [--hours 168]   一次性邀请码
  quick team join <hub-url> <邀请码> <id> [--name 名字]     加入别人的 hub：保存个人 token，之后 pi/quick/Web UI 都以你的身份连它
  quick team add <id> [--name 名字] [--role owner]          owner 直接加人（打印 token，转交给对方）
  quick team role <id> owner|member · quick team remove <id> · quick team token [<id>] --reset · quick team rename <id> <名字>
  quick team leave                        删除本机保存的团队连接（回到本机 hub）
  quick assign <task> [--to <人|agent>] [--reviewer <人|none>] [--watch a,b] [--unwatch a] [--note 说明]
  quick comment <task> <内容…>            评论；@id 点名，@all 全体，@worker 转给 worker`;

export async function teamCmd(args: string[], hub: HubClient, cfg: QaConfig) {
	const sub = args.shift() ?? "ls";
	switch (sub) {
		case "ls":
		case "status": {
			const r = await hub.team();
			if (!r.members.length) {
				console.log(`还没有团队成员（hub ${hubUrl(cfg)}）。运行 quick team init <你的id> 开始。`);
				return;
			}
			for (const m of r.members) console.log(`${m.id === r.me?.id ? "*" : " "} ${m.id.padEnd(14)} ${m.role.padEnd(7)} ${m.name}${m.machines.length ? `  \x1b[2m机器: ${m.machines.join(", ")}\x1b[0m` : ""}`);
			console.log(`\x1b[2m你: ${r.me ? `${r.me.id}（${r.me.role}）` : r.root ? "本机 root（机器没有设置所有者）" : "?"} · hub ${hubUrl(cfg)}${cfg.client ? "（团队连接）" : ""}\x1b[0m`);
			if (r.invites?.length) console.log(`\x1b[2m未用的邀请: ${r.invites.map((i) => `${i.id}(${i.role}, ${new Date(i.expiresAt).toLocaleDateString()} 过期)`).join(" ")}\x1b[0m`);
			return;
		}
		case "init": {
			const name = take(args, "--name");
			const id = args.shift() ?? die("usage: quick team init <id> [--name 名字]");
			const r = await hub.addMember({ id, name, role: "owner", machineOwner: true });
			console.log(`团队已建立：${r.member.id}（${r.member.role}），本机 ${cfg.machine.id} 归 ${r.member.id} 所有，本机 token 即代表 ${r.member.id}。\n${r.member.id} 在其他电脑上使用的个人 token（只显示这一次）：\n  ${r.token}\n下一步：quick team invite 邀请队友。`);
			return;
		}
		case "add": {
			const name = take(args, "--name");
			const role = take(args, "--role") as Role | undefined;
			const id = args.shift() ?? die("usage: quick team add <id> [--name 名字] [--role owner|member]");
			const r = await hub.addMember({ id, name, role });
			console.log(`已添加 ${r.member.id}（${r.member.role}）。把下面这行发给对方（token 只显示这一次）：\n  quick team connect ${hubUrl(cfg)} ${r.token}`);
			return;
		}
		case "invite": {
			const role = take(args, "--role") as Role | undefined;
			const hours = take(args, "--hours");
			const revoke = take(args, "--revoke");
			if (revoke) return console.log(JSON.stringify(await hub.invite({ revoke })));
			const r = await hub.invite({ role, hours: hours ? Number(hours) : undefined });
			console.log(`邀请码（${r.invite.role}，一次性，${new Date(r.invite.expiresAt).toLocaleString()} 过期）：\n  ${r.code}\n对方运行（hub 地址换成对方能访问到的地址，例如 ssh -L 转发后的端口）：\n  quick team join ${hubUrl(cfg)} ${r.code} <他的id> --name <名字>`);
			return;
		}
		case "join": {
			const name = take(args, "--name");
			const [url, code, id] = args;
			if (!url || !code || !id) die("usage: quick team join <hub-url> <邀请码> <id> [--name 名字]");
			const remote = new HubClient({ ...cfg, client: { hub: url.replace(/\/+$/, ""), token: "-" } });
			const r = await remote.join({ code, id, name });
			saveClient(url, r.token, r.member.id);
			console.log(`已加入，你是 ${r.member.id}（${r.member.role}）。个人 token 已保存到 config.json 的 client 段；pi 前台、quick、quick ui 都会以你的身份连 ${url}。`);
			return;
		}
		case "connect": {
			const [url, token] = args;
			if (!url || !token) die("usage: quick team connect <hub-url> <token>");
			const remote = new HubClient({ ...cfg, client: { hub: url.replace(/\/+$/, ""), token } });
			const me = await remote.me();
			saveClient(url, token, me.me?.id);
			console.log(`已连接 ${url}，你是 ${me.me?.id ?? "?"}。`);
			return;
		}
		case "leave": {
			saveConfigPatch((raw) => void delete raw.client);
			console.log("已删除团队连接，之后连本机 hub。");
			return;
		}
		case "role": {
			const [id, role] = args;
			if (!id || !role) die("usage: quick team role <id> owner|member");
			console.log(JSON.stringify((await hub.updateMember(id, { role: role as Role })).member));
			return;
		}
		case "rename": {
			const [id, ...name] = args;
			if (!id || !name.length) die("usage: quick team rename <id> <名字>");
			console.log(JSON.stringify((await hub.updateMember(id, { name: name.join(" ") })).member));
			return;
		}
		case "remove": {
			const id = args.shift() ?? die("usage: quick team remove <id>");
			console.log(JSON.stringify(await hub.updateMember(id, { remove: true })));
			return;
		}
		case "token": {
			if (!bool(args, "--reset")) die("usage: quick team token [<id>] --reset   （重置个人 token，旧的立即失效）");
			const id = args.shift() ?? (await hub.me()).me?.id ?? die("你不是团队成员");
			const r = await hub.updateMember(id, { resetToken: true });
			if (cfg.client && cfg.client.user === id) saveClient(cfg.client.hub, r.token, id);
			console.log(`${id} 的新 token（只显示这一次）：\n  ${r.token}`);
			return;
		}
		default:
			console.log(TEAM_HELP);
	}
}

function saveClient(url: string, token: string, user?: string) {
	saveConfigPatch((raw) => {
		raw.client = { hub: url.replace(/\/+$/, ""), token, ...(user ? { user } : {}) };
	});
}

export async function assignCmd(args: string[], hub: HubClient) {
	const to = take(args, "--to");
	const reviewer = take(args, "--reviewer");
	const watch = list(take(args, "--watch"));
	const unwatch = list(take(args, "--unwatch"));
	const note = take(args, "--note");
	const id = args.shift() ?? die("usage: quick assign <task> [--to <人|agent>] [--reviewer <人|none>] [--watch a,b] [--unwatch a] [--note 说明]");
	const none = (x: string) => /^(none|null|-)$/i.test(x);
	const body: Parameters<HubClient["assign"]>[1] = {};
	if (to !== undefined) body.assignee = none(to) || to === "agent" || to === "worker" ? null : to;
	if (reviewer !== undefined) body.reviewer = none(reviewer) ? null : reviewer;
	if (watch.length) body.watchersAdd = watch;
	if (unwatch.length) body.watchersRemove = unwatch;
	if (note) body.note = note;
	if (!Object.keys(body).length) die("nothing to change (--to / --reviewer / --watch / --unwatch)");
	const t = await hub.assign(id, body);
	console.log(`${t.id} ${t.title}\n  发起 ${t.requester ?? "-"} · 负责 ${t.assignee ?? "worker"} · 验收 ${t.reviewer ?? "-"} · 关注 ${(t.watchers ?? []).join(", ") || "-"}`);
}

export async function commentCmd(args: string[], hub: HubClient) {
	const toWorker = bool(args, "--to-worker");
	const [id, ...text] = args;
	if (!id) die("usage: quick comment <task> <内容…>   (不带内容：列出评论)");
	if (!text.length) {
		const [{ members }, comments] = await Promise.all([hub.team().catch(() => ({ members: [] as any[] })), hub.comments(id)]);
		if (!comments.length) return console.log("（没有评论）");
		for (const c of comments) console.log(`${new Date(c.ts).toLocaleString()}  ${displayName(c.author, members)}${c.toWorker ? " → worker" : ""}\n  ${c.text.replace(/\n/g, "\n  ")}`);
		return;
	}
	const r = await hub.comment(id, text.join(" "), { toWorker });
	console.log(`已评论 ${r.task.id}${r.comment.mentions.length ? `，点名 ${r.comment.mentions.join(", ")}` : ""}${r.comment.toWorker ? "，已转给 worker" : ""}`);
}
