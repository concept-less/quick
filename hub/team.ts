// Team collaboration, hub part (docs/team-collaboration.md):
//  - roster: members and invites in ~/.quick-agent/team.json, replicated over the mesh (kind "member" / "invite",
//    per-record last writer wins), so any hub of the team can verify any member's token;
//  - identity: which person a request's token belongs to (machine token = machine owner / root);
//  - task people: requester, assignee, reviewer, watchers, pings, comments — mutated on the hub that owns the task
//    (methods task.assign / task.comment / task.people.ack), replicated with the task like every other field.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskEvent } from "../shared/types.ts";
import {
	AGENT,
	isHolderFor,
	memberId,
	newer,
	parseMentions,
	publicMember,
	RESERVED_IDS,
	type Invite,
	type Member,
	type Ping,
	type PingKind,
	type PublicMember,
	type Role,
	type TaskComment,
	type Viewer,
} from "../shared/team.ts";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVITE_TTL_MS = 7 * 86400_000;
const MAX_PINGS = 50;

export interface TeamDeps {
	file: string;
	log(msg: string): void;
	/** Flood a record to the mesh. */
	flood(kind: "member" | "invite", data: any): void;
	/** Roster changed (tell local clients). */
	onChange(): void;
	/** Machine token of this hub. */
	rootToken(): string;
	/** Member id that owns this machine (machine.owner), if any. */
	machineOwner(): string | undefined;
	// task plumbing (hub/server.ts)
	ownTask(id: string): Task;
	taskDir(id: string): string;
	update(t: Task, patch: Partial<Task>, ev?: Omit<TaskEvent, "ts" | "taskId">): Task;
	deliverMessage(t: Task, text: string): Promise<void>;
	httpError(status: number, msg: string): Error;
}

interface Persisted {
	members: Member[];
	invites: Invite[];
}

export function createTeam(d: TeamDeps) {
	const members = new Map<string, Member>();
	const invites = new Map<string, Invite>();
	try {
		if (existsSync(d.file)) {
			const st = JSON.parse(readFileSync(d.file, "utf8")) as Persisted;
			for (const m of st.members ?? []) members.set(m.id, m);
			for (const i of st.invites ?? []) invites.set(i.id, i);
		}
	} catch (e) {
		d.log(`[team] cannot read ${d.file}: ${(e as Error).message}`);
	}
	const save = () => writeFileSync(d.file, `${JSON.stringify({ members: [...members.values()], invites: [...invites.values()] }, null, 2)}\n`, { mode: 0o600 });
	const err = (status: number, msg: string) => d.httpError(status, msg);

	const active = () => [...members.values()].filter((m) => !m.removed);
	const roster = (): PublicMember[] => active().map(publicMember).sort((a, b) => a.createdAt - b.createdAt);
	const enabled = () => active().length > 0;

	const putMember = (m: Member) => {
		members.set(m.id, m);
		save();
		d.flood("member", { member: m });
		d.onChange();
		return m;
	};
	const putInvite = (i: Invite) => {
		invites.set(i.id, i);
		save();
		d.flood("invite", { invite: i });
		return i;
	};
	const bump = <T extends { updatedAt: number; rev: number }>(x: T, patch: Partial<T>): T => ({ ...x, ...patch, updatedAt: Math.max(Date.now(), x.updatedAt + 1), rev: x.rev + 1 });
	const newToken = () => `qau_${randomBytes(24).toString("base64url")}`;

	// ------------------------------------------------------------ identity

	/** Viewer for a bearer token, or undefined when the token is not valid on this hub. */
	const identify = (token: string | undefined | null): Viewer | undefined => {
		if (!token) return undefined;
		if (token === d.rootToken()) {
			const owner = d.machineOwner();
			const m = owner ? members.get(owner) : undefined;
			return m && !m.removed ? { user: m.id, role: m.role, root: true } : { role: "owner", root: true };
		}
		if (!token.startsWith("qau_")) return undefined;
		const h = sha256(token);
		for (const m of members.values()) if (!m.removed && m.tokenHash === h) return { user: m.id, role: m.role };
		return undefined;
	};

	const lastOwnerGuard = (id: string) => {
		const owners = active().filter((m) => m.role === "owner");
		if (owners.length === 1 && owners[0]!.id === id) throw err(400, `${id} 是最后一名 owner：先把另一位成员设为 owner`);
	};

	// ------------------------------------------------------------ roster management

	const addMember = (p: { id?: string; name?: string; role?: Role }) => {
		const id = memberId(p.id ?? p.name ?? "");
		if (!id) throw err(400, "member id is required (letters, digits, - _)");
		if (RESERVED_IDS.includes(id)) throw err(400, `"${id}" is reserved`);
		const cur = members.get(id);
		if (cur && !cur.removed) throw err(409, `member ${id} already exists`);
		const role: Role = p.role === "owner" ? "owner" : enabled() ? "member" : "owner"; // the first member is the owner
		const token = newToken();
		const now = Date.now();
		const m: Member = { id, name: String(p.name ?? "").trim() || id, role, tokenHash: sha256(token), tokenHint: token.slice(0, 8), createdAt: cur?.createdAt ?? now, updatedAt: Math.max(now, (cur?.updatedAt ?? 0) + 1), rev: (cur?.rev ?? 0) + 1 };
		putMember(m);
		d.log(`[team] member ${id} (${role}) added`);
		return { member: publicMember(m), token };
	};
	const getMember = (id: string) => {
		const m = members.get(memberId(id));
		if (!m || m.removed) throw err(404, `no such member: ${id}`);
		return m;
	};
	const setRole = (id: string, role: Role) => {
		const m = getMember(id);
		if (role !== "owner" && role !== "member") throw err(400, "role must be owner or member");
		if (m.role === "owner" && role !== "owner") lastOwnerGuard(m.id);
		return publicMember(putMember(bump(m, { role })));
	};
	const remove = (id: string) => {
		const m = getMember(id);
		if (m.role === "owner") lastOwnerGuard(m.id);
		putMember(bump(m, { removed: true, tokenHash: "" }));
		return { removed: m.id };
	};
	const resetToken = (id: string) => {
		const m = getMember(id);
		const token = newToken();
		putMember(bump(m, { tokenHash: sha256(token), tokenHint: token.slice(0, 8) }));
		return { member: publicMember(members.get(m.id)!), token };
	};
	const rename = (id: string, name: string) => publicMember(putMember(bump(getMember(id), { name: String(name).trim() || id })));

	const createInvite = (p: { role?: Role; hours?: number }, by: string) => {
		const code = `qai_${randomBytes(18).toString("base64url")}`;
		const now = Date.now();
		const ttl = Number(p.hours) > 0 ? Number(p.hours) * 3600_000 : INVITE_TTL_MS;
		const inv: Invite = { id: `i${randomBytes(3).toString("hex")}`, codeHash: sha256(code), role: p.role === "owner" ? "owner" : "member", by, createdAt: now, expiresAt: now + ttl, updatedAt: now, rev: 0 };
		putInvite(inv);
		return { code, invite: inv };
	};
	/** Redeem an invite code (no other credential needed): creates the member and returns their token once. */
	const redeem = (p: { code?: string; id?: string; name?: string }) => {
		const h = sha256(String(p.code ?? ""));
		const inv = [...invites.values()].find((i) => i.codeHash === h);
		if (!inv || inv.revoked) throw err(403, "invalid invite code");
		if (inv.usedBy) throw err(403, `invite already used by ${inv.usedBy}`);
		if (inv.expiresAt < Date.now()) throw err(403, "invite expired");
		const r = addMember({ id: p.id ?? p.name, name: p.name, role: inv.role });
		putInvite(bump(inv, { usedBy: r.member.id }));
		return r;
	};
	const listInvites = () => [...invites.values()].filter((i) => !i.usedBy && !i.revoked && i.expiresAt > Date.now()).map(({ codeHash: _c, ...rest }) => rest);
	const revokeInvite = (id: string) => {
		const i = invites.get(id);
		if (!i) throw err(404, `no such invite: ${id}`);
		putInvite(bump(i, { revoked: true }));
		return { revoked: id };
	};

	// ------------------------------------------------------------ mesh replication

	const applyRemote = (kind: string, data: any): boolean => {
		if (kind === "member") {
			const m = data?.member as Member | undefined;
			if (!m?.id || !newer(members.get(m.id), m)) return false;
			members.set(m.id, m);
			save();
			d.onChange();
			return true;
		}
		if (kind === "invite") {
			const i = data?.invite as Invite | undefined;
			if (!i?.id || !newer(invites.get(i.id), i)) return false;
			invites.set(i.id, i);
			save();
			return true;
		}
		return false;
	};
	const snapshot = () => [...[...members.values()].map((member) => ({ kind: "member", data: { member } })), ...[...invites.values()].filter((i) => i.expiresAt > Date.now() - 86400_000).map((invite) => ({ kind: "invite", data: { invite } }))];

	// ------------------------------------------------------------ task people (run on the hub that owns the task)

	const requireMember = (id: unknown, what: string): string => {
		const mid = memberId(String(id ?? ""));
		const m = members.get(mid);
		if (!m || m.removed) throw err(400, `${what}: no such team member "${id}" (quick team ls)`);
		return m.id;
	};
	const name = (id?: string) => (id === AGENT ? "worker" : (id && members.get(id)?.name) || id || "?");
	const pingId = () => `p${randomBytes(3).toString("hex")}`;

	/** New pings for users (never for the actor), replacing older pings of the same kind for that user. */
	const withPings = (t: Task, users: string[], kind: PingKind, by: string, extra: Partial<Ping> = {}): Ping[] => {
		let pings = [...(t.pings ?? [])];
		for (const u of new Set(users)) {
			if (!u || u === by || u === AGENT) continue;
			pings = pings.filter((p) => !(p.user === u && p.kind === kind));
			pings.push({ id: pingId(), user: u, kind, by, at: Date.now(), ...extra });
		}
		return pings.slice(-MAX_PINGS);
	};
	const clearPings = (t: Task, user: string | undefined) => (user ? (t.pings ?? []).filter((p) => p.user !== user) : t.pings);

	/** Fields of a new task (task.create on the owning hub). */
	const newTaskPeople = (body: any): Partial<Task> => {
		const requester = typeof body.requester === "string" && body.requester ? body.requester : undefined;
		const out: Partial<Task> = {};
		if (requester) out.requester = requester;
		if (body.assignee) out.assignee = requireMember(body.assignee, "assignee");
		if (body.reviewer) out.reviewer = requireMember(body.reviewer, "reviewer");
		const w = (Array.isArray(body.watchers) ? body.watchers : []).map((x: unknown) => requireMember(x, "watcher"));
		if (w.length) out.watchers = [...new Set<string>(w)];
		const pseudo = { pings: [] } as unknown as Task;
		if (out.assignee) out.pings = withPings(pseudo, [out.assignee], "assign", requester ?? AGENT);
		return out;
	};

	/** Brief lines describing who is who (written into the worker's brief). */
	const briefLines = (t: Task): string[] =>
		[t.requester ? `- 发起人: ${t.requester}（${name(t.requester)}）` : "", t.assignee ? `- 负责人: ${t.assignee}（${name(t.assignee)}）` : "", t.reviewer ? `- 验收人: ${t.reviewer}（${name(t.reviewer)}）` : ""].filter(Boolean);

	const assign = (p: any): Task => {
		const t = d.ownTask(p.id);
		const by: string = p.by || AGENT;
		const patch: Partial<Task> = {};
		const notes: string[] = [];
		let pings = clearPings(t, p.by) ?? [];
		const base = { ...t, pings } as Task;
		if (p.assignee !== undefined) {
			if (p.assignee === null || p.assignee === "" || p.assignee === AGENT) {
				patch.assignee = undefined;
				notes.push("负责人 → worker");
			} else {
				patch.assignee = requireMember(p.assignee, "assignee");
				notes.push(`负责人 → ${patch.assignee}`);
				pings = withPings({ ...base, pings } as Task, [patch.assignee], "assign", by, p.note ? { text: String(p.note) } : {});
			}
		}
		if (p.reviewer !== undefined) {
			if (p.reviewer === null || p.reviewer === "") {
				patch.reviewer = undefined;
				pings = pings.filter((x) => x.kind !== "review");
				notes.push("取消验收人");
			} else {
				patch.reviewer = requireMember(p.reviewer, "reviewer");
				notes.push(`验收人 → ${patch.reviewer}`);
				// Already handed back: the reviewer is needed now. Still running: the hand-back reaches them.
				const running = ["starting", "running", "handoff"].includes(t.status);
				if (!running) pings = withPings({ ...base, pings } as Task, [patch.reviewer], "review", by, p.note ? { text: String(p.note) } : {});
			}
		}
		let watchers = [...(t.watchers ?? [])];
		for (const w of Array.isArray(p.watchersAdd) ? p.watchersAdd : []) {
			const id = requireMember(w, "watcher");
			if (!watchers.includes(id)) watchers.push(id);
		}
		for (const w of Array.isArray(p.watchersRemove) ? p.watchersRemove : []) watchers = watchers.filter((x) => x !== memberId(String(w)));
		if (p.watchersAdd || p.watchersRemove) {
			patch.watchers = watchers.length ? watchers : undefined;
			notes.push(`关注者: ${watchers.join(", ") || "无"}`);
		}
		patch.pings = pings.length ? pings : undefined;
		return d.update(t, patch, { kind: "assign" as TaskEvent["kind"], text: `${name(by)}: ${notes.join("；") || "无变化"}`, by } as any);
	};

	const readComments = (id: string, limit = 100): TaskComment[] => {
		const f = join(d.taskDir(id), "comments.jsonl");
		if (!existsSync(f)) return [];
		return readFileSync(f, "utf8")
			.split("\n")
			.filter(Boolean)
			.slice(-limit)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as TaskComment];
				} catch {
					return [];
				}
			});
	};

	const comment = async (p: any): Promise<{ task: Task; comment: TaskComment }> => {
		const t = d.ownTask(p.id);
		const text = String(p.text ?? "").trim();
		if (!text) throw err(400, "text is required");
		const author: string = p.by || AGENT;
		const m = parseMentions(text, active());
		const users = m.all ? active().map((x) => x.id) : m.users;
		const toWorker = author !== AGENT && (m.worker || !!p.toWorker);
		const c: TaskComment = { id: `m${randomBytes(3).toString("hex")}`, taskId: t.id, ts: Date.now(), author, text, mentions: users.filter((u) => u !== author), ...(toWorker ? { toWorker: true } : {}) };
		appendFileSync(join(d.taskDir(t.id), "comments.jsonl"), `${JSON.stringify(c)}\n`);
		let pings = clearPings(t, author === AGENT ? undefined : author) ?? [];
		pings = withPings({ ...t, pings } as Task, c.mentions, "mention", author, { text, commentId: c.id });
		const watchers = author !== AGENT && !(t.watchers ?? []).includes(author) && author !== t.requester ? [...(t.watchers ?? []), author] : t.watchers;
		const task = d.update(
			t,
			{ pings: pings.length ? pings : undefined, watchers, comments: (t.comments ?? 0) + 1, lastComment: { id: c.id, author, text: text.slice(0, 300), ts: c.ts } },
			{ kind: "comment" as TaskEvent["kind"], text: `${name(author)}: ${text.slice(0, 200)}`, by: author } as any,
		);
		if (toWorker) await d.deliverMessage(task, `【团队评论 ${name(author)}（${author}）】\n${text}`);
		return { task, comment: c };
	};

	/** Per-person acknowledgement: clears that person's pings; only the holder's ack marks the task read. */
	const ack = (t: Task, viewer: Viewer | undefined): { patch: Partial<Task>; holder: boolean } => {
		if (!viewer?.user) return { patch: {}, holder: true };
		const holder = isHolderFor(t, viewer);
		let pings = clearPings(t, viewer.user) ?? [];
		// The reviewer accepting a finished task tells the requester (quietly: skim).
		if (holder && t.status === "done" && t.unread && t.reviewer === viewer.user && t.requester && t.requester !== viewer.user) {
			pings = withPings({ ...t, pings } as Task, [t.requester], "verdict", viewer.user, {});
		}
		return { patch: { pings: pings.length ? pings : undefined }, holder };
	};

	/** The actor did something on the task (reply, retry, …): their own pings are handled. */
	const touched = (t: Task, user: string | undefined): Partial<Task> => {
		if (!user || !(t.pings ?? []).some((p) => p.user === user)) return {};
		const pings = clearPings(t, user) ?? [];
		return { pings: pings.length ? pings : undefined };
	};

	const methods: Record<string, (p: any, from: string) => Promise<any>> = {
		"task.assign": async (p) => assign(p),
		"task.comment": async (p) => comment(p),
		"task.comments": async (p) => ({ comments: readComments(p.id, Math.min(Number(p.limit ?? 100) || 100, 1000)) }),
	};

	return {
		identify,
		enabled,
		roster,
		member: (id: string) => {
			const m = members.get(id);
			return m && !m.removed ? publicMember(m) : undefined;
		},
		addMember,
		setRole,
		remove,
		resetToken,
		rename,
		createInvite,
		join: redeem,
		listInvites,
		revokeInvite,
		applyRemote,
		snapshot,
		newTaskPeople,
		briefLines,
		readComments,
		ack,
		touched,
		methods,
		name,
	};
}
export type Team = ReturnType<typeof createTeam>;
