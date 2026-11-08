// Team collaboration (docs/team-collaboration.md): pure rules + two isolated hubs in a mesh with three people.
// Workers are a fake `pi` (sleeps in its tmux window); the test reports on their behalf like a real worker would.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { holderOf, parseMentions, personalAttention, type BaseItem } from "../shared/team.ts";
import type { Task } from "../shared/types.ts";

// ---------------------------------------------------------------- pure rules

const roster = [
	{ id: "alice", name: "Alice" },
	{ id: "bob", name: "Bob Li" },
	{ id: "zhang", name: "张三" },
];

test("mentions: ids, names, @all, @worker, boundaries", () => {
	assert.deepEqual(parseMentions("@alice 看一下 @Bob 和 @BobLi", roster).users, ["alice", "bob"]);
	assert.deepEqual(parseMentions("@alice这里不对", roster).users, ["alice"]);
	assert.deepEqual(parseMentions("@张三看看", roster).users, ["zhang"]);
	assert.deepEqual(parseMentions("@alicex @nobody mail a@alice.com", roster).users, []);
	const m = parseMentions("@all 请注意，@worker 继续", roster);
	assert.equal(m.all, true);
	assert.equal(m.worker, true);
});

const task = (p: Partial<Task>): Task => ({ id: "t1", machine: "m", rev: 1, title: "x", brief: "b", cwd: "/", status: "done", createdAt: 1, updatedAt: 1, source: { kind: "api" }, attachments: [], unread: true, messages: 0, ...p }) as Task;
const base = (level: BaseItem["level"]): BaseItem => ({ taskId: "t1", level, mark: "[X]", reason: "r", since: 1, actions: [{ id: "ack", label: "知道了" }] });

test("holder: done goes to the reviewer, questions to the assignee", () => {
	assert.equal(holderOf(task({ requester: "a", reviewer: "b" })), "b");
	assert.equal(holderOf(task({ requester: "a", reviewer: "b", assignee: "c" })), "b");
	assert.equal(holderOf(task({ status: "needs_input", requester: "a", reviewer: "b", assignee: "c" })), "c");
	assert.equal(holderOf(task({ status: "needs_input", requester: "a" })), "a");
	assert.equal(holderOf(task({})), undefined);
});

test("personal attention: reviewer needs it, requester waits, others do not see it", () => {
	const t = task({ requester: "alice", reviewer: "bob", watchers: ["zhang"] });
	assert.equal(personalAttention(t, base("skim"), { user: "bob", role: "member" })?.level, "need");
	assert.equal(personalAttention(t, base("skim"), { user: "bob", role: "member" })?.mark, "[REVIEW]");
	assert.equal(personalAttention(t, base("skim"), { user: "alice", role: "member" })?.level, "inflight");
	assert.equal(personalAttention(t, base("skim"), { user: "zhang", role: "member" })?.level, "inflight");
	assert.equal(personalAttention(t, base("skim"), { user: "carol", role: "member" }), undefined);
	// single-user mode (root without owner): unchanged
	assert.equal(personalAttention(t, base("skim"), { role: "owner", root: true })?.level, "skim");
	// a mention puts it into need for the mentioned person even when it is not their ball
	const m = task({ requester: "alice", pings: [{ id: "p", user: "zhang", kind: "mention", by: "alice", at: 5, text: "看一下" }] });
	const z = personalAttention(m, base("inflight"), { user: "zhang", role: "member" }, roster);
	assert.equal(z?.level, "need");
	assert.match(z!.reason, /Alice @你：看一下/);
	// tasks nobody owns go to owners
	assert.equal(personalAttention(task({}), base("need"), { user: "alice", role: "owner" })?.level, "need");
	assert.equal(personalAttention(task({}), base("need"), { user: "bob", role: "member" }), undefined);
});

// ---------------------------------------------------------------- two hubs, three people

const REPO = resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "qa-team-"));
const PORT = 21000 + Math.floor(Math.random() * 20000);
const BIN = join(TMP, "bin");
mkdirSync(BIN);
writeFileSync(join(BIN, "pi"), "#!/usr/bin/env bash\nsleep 600\n");
chmodSync(join(BIN, "pi"), 0o755);
const env0: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", PATH: `${BIN}:${process.env.PATH}` };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "QA_MACHINE_OWNER", "QA_MACHINE_PRIORITY"]) delete env0[k];

interface H {
	id: string;
	port: number;
	home: string;
	session: string;
	proc?: ChildProcess;
}
const hubs: H[] = ["ha", "hb"].map((id, i) => ({ id, port: PORT + i, home: join(TMP, id), session: `qa-team-${process.pid}-${id}` }));
for (const h of hubs) {
	mkdirSync(join(h.home, "work"), { recursive: true });
	writeFileSync(
		join(h.home, "config.json"),
		JSON.stringify({
			host: "127.0.0.1",
			port: h.port,
			token: `root-${h.id}`,
			tmuxSession: h.session,
			defaultCwd: join(h.home, "work"),
			machine: { id: h.id, priority: h.id === "ha" ? 1 : 50 },
			mesh: { secret: "team-secret", peers: h.id === "hb" ? [{ url: `http://127.0.0.1:${hubs[0]!.port}` }] : [] },
			update: { enabled: false },
		}),
	);
}
const [A, B] = hubs as [H, H];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok: Record<string, string> = {};

async function api(h: H, token: string, method: string, path: string, body?: any) {
	const r = await fetch(`http://127.0.0.1:${h.port}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await r.json()) as any;
	return { status: r.status, json };
}
async function ok(h: H, token: string, method: string, path: string, body?: any) {
	const r = await api(h, token, method, path, body);
	assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.json)}`);
	return r.json;
}
async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 8000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn().catch(() => undefined);
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(100);
	}
}
/** Collect SSE events of one person (their own attention stream). */
function listen(h: H, token: string) {
	const events: any[] = [];
	const ac = new AbortController();
	void (async () => {
		try {
			const r = await fetch(`http://127.0.0.1:${h.port}/api/events?role=front&front=test-${token.slice(4, 10)}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
			const reader = r.body!.getReader();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += new TextDecoder().decode(value);
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
					buf = buf.slice(i + 2);
					if (line) events.push(JSON.parse(line.slice(5)));
				}
			}
		} catch {}
	})();
	return { events, stop: () => ac.abort(), attention: (id: string) => events.filter((e) => e.type === "attention" && e.item.taskId === id) };
}
const queue = async (h: H, token: string) => (await ok(h, token, "GET", "/api/attention?archived=0")) as { items: any[]; counts: any; viewer?: string };
const getTask = async (h: H, token: string, id: string) => (await ok(h, token, "GET", `/api/tasks/${id}`)).task as Task;

before(async () => {
	for (const h of hubs) h.proc = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: { ...env0, QA_HOME: h.home }, stdio: ["ignore", openSync(join(h.home, "hub.log"), "a"), openSync(join(h.home, "hub.log"), "a")] });
	await until(async () => (await api(B, "root-hb", "GET", "/api/machines")).json.machines?.find((m: any) => m.id === "ha")?.online, "mesh", 20_000);
});

after(() => {
	for (const h of hubs) {
		h.proc?.kill();
		spawnSync("tmux", ["kill-session", "-t", `=${h.session}`]);
	}
	if (!process.env.QA_TEST_KEEP) rmSync(TMP, { recursive: true, force: true });
	else console.log(`kept ${TMP}`);
});

test("team bootstrap: first owner, invites, roster replicated to the other hub", async () => {
	const init = await ok(A, "root-ha", "POST", "/api/team/members", { id: "simon", name: "Simon", machineOwner: true });
	assert.equal(init.member.role, "owner");
	tok.simon = init.token;
	assert.equal(JSON.parse(readFileSync(join(A.home, "config.json"), "utf8")).machine.owner, "simon");
	for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]] as const) {
		const inv = await ok(A, "root-ha", "POST", "/api/team/invites", {});
		const j = await ok(A, "nobody", "POST", "/api/team/join", { code: inv.code, id, name });
		assert.equal(j.member.role, "member");
		tok[id] = j.token;
		// the code is single-use
		assert.equal((await api(A, "nobody", "POST", "/api/team/join", { code: inv.code, id: `${id}2` })).status, 403);
	}
	// the machine token of ha now acts as simon; members can use any hub of the mesh
	assert.equal((await ok(A, "root-ha", "GET", "/api/me")).me.id, "simon");
	await until(async () => (await api(B, tok.alice!, "GET", "/api/me")).json.me?.id === "alice", "alice's token valid on hb");
	const team = await ok(B, tok.bob!, "GET", "/api/team");
	assert.deepEqual(team.members.map((m: any) => m.id), ["simon", "alice", "bob"]);
	assert.deepEqual(team.members.find((m: any) => m.id === "simon").machines, ["ha"]);
	assert.equal(team.invites, undefined); // members do not see invites
	assert.equal((await api(A, "garbage", "GET", "/api/tasks")).status, 401);
});

test("permissions: members collaborate, only owners manage the team and machines", async () => {
	assert.equal((await api(A, tok.alice!, "POST", "/api/team/members", { id: "eve" })).status, 403);
	assert.equal((await api(A, tok.alice!, "POST", "/api/team/invites", {})).status, 403);
	assert.equal((await api(A, tok.alice!, "POST", "/api/machine", { priority: 3 })).status, 403);
	assert.equal((await api(A, tok.alice!, "POST", "/api/team/members/bob", { remove: true })).status, 403);
	assert.equal((await api(A, tok.simon!, "POST", "/api/team/members/simon", { role: "member" })).status, 400); // last owner
	const r = await ok(B, tok.simon!, "POST", "/api/machine", { machine: "hb", owner: "bob" });
	assert.equal(r.machine.owner, "bob");
});

let tid = "";

test("a task records who asked, who verifies, and the hand-back reaches the reviewer", async () => {
	const { task } = await ok(B, tok.alice!, "POST", "/api/tasks", { title: "登录页修复", brief: "修一下", reviewer: "bob", watchers: ["simon"], requester: "simon" });
	tid = task.id;
	assert.equal(task.machine, "ha");
	assert.equal(task.requester, "alice"); // members cannot dispatch on someone else's behalf
	assert.equal(task.reviewer, "bob");
	assert.deepEqual(task.watchers, ["simon"]);
	assert.match(readFileSync(join(A.home, "tasks", tid, "brief.md"), "utf8"), /发起人: alice（Alice）[\s\S]*验收人: bob（Bob）/);
	assert.equal((await api(A, tok.alice!, "POST", "/api/tasks", { title: "x", brief: "y", reviewer: "nobody" })).status, 400);
	await until(async () => (await getTask(A, "root-ha", tid)).status === "starting", "spawned");
	// while the worker runs, nobody needs to look at it
	for (const who of ["alice", "bob", "simon"]) {
		const q = await queue(A, tok[who]!);
		assert.equal(q.counts.need, 0, who);
	}
	// alice and bob are connected (bob to the other hub)
	const sa = listen(A, tok.alice!);
	const sb = listen(B, tok.bob!);
	await sleep(300);
	// the worker finishes (reports with the machine token, like extensions/worker.ts)
	await ok(A, "root-ha", "POST", `/api/tasks/${tid}/report`, { status: "done", summary: "改好了，加了测试", kind: "report" });
	const t = await until(async () => {
		const x = await getTask(B, tok.bob!, tid);
		return x.status === "done" && x.unread && x;
	}, "replicated done");
	assert.equal(holderOf(t), "bob");
	// bob: needs him (review), interrupt now; alice: waits, never interrupted
	const qb = await queue(B, tok.bob!);
	const ib = qb.items.find((i) => i.taskId === tid);
	assert.equal(ib.level, "need");
	assert.equal(ib.mark, "[REVIEW]");
	assert.equal(qb.viewer, "bob");
	const qa = await queue(A, tok.alice!);
	const ia = qa.items.find((i) => i.taskId === tid);
	assert.equal(ia.level, "inflight");
	assert.match(ia.reason, /等 Bob 验收/);
	assert.equal(qa.counts.need, 0);
	const eb = await until(async () => sb.attention(tid).find((e) => e.item.level === "need"), "bob's attention event");
	assert.equal(eb.interrupt, "now");
	assert.equal(eb.counts.need, 1);
	await sleep(300);
	assert.ok(!sa.attention(tid).some((e) => e.item.level === "need" || e.interrupt === "now"), JSON.stringify(sa.attention(tid)));
	sa.stop();
	sb.stop();
	// owners may look at someone's queue; members may not
	assert.equal((await ok(A, tok.simon!, "GET", "/api/attention?user=bob")).items.find((i: any) => i.taskId === tid).level, "need");
	assert.equal((await api(A, tok.alice!, "GET", "/api/attention?user=bob")).status, 403);
	// team view: everything open, by whose ball it is, no interrupts
	const board = await ok(A, tok.alice!, "GET", "/api/attention?scope=team");
	const row = board.items.find((i: any) => i.taskId === tid);
	assert.equal(row.ball, "bob");
	assert.equal(row.people.requester, "alice");
	assert.equal(board.items.filter((i: any) => i.ball === "bob").length, 1);
	// root of a machine without owner = single user: sees the base queue (unchanged behaviour)
	assert.equal((await queue(B, "root-hb")).viewer, "bob"); // hb belongs to bob (set above)
	await ok(A, tok.simon!, "POST", "/api/machine", { machine: "hb", owner: null });
	assert.equal((await queue(B, "root-hb")).items.find((i) => i.taskId === tid).level, "skim");
});

test("acks are per person: only the holder's ack counts, and the requester learns the verdict", async () => {
	// alice (requester, not the holder) acknowledging does not accept the work for bob
	let t = (await ok(A, tok.alice!, "POST", `/api/tasks/${tid}/ack`, {})).task as Task;
	assert.equal(t.unread, true);
	t = (await ok(B, tok.bob!, "POST", `/api/tasks/${tid}/ack`, {})).task as Task;
	assert.equal(t.unread, false);
	assert.deepEqual(t.pings?.map((p) => [p.user, p.kind, p.by]), [["alice", "verdict", "bob"]]);
	assert.equal((await queue(A, tok.alice!)).items.find((i) => i.taskId === tid).mark, "[VERDICT]");
	assert.equal((await queue(A, tok.alice!)).items.find((i) => i.taskId === tid).level, "skim");
	assert.equal((await queue(B, tok.bob!)).counts.need, 0);
	t = (await ok(A, tok.alice!, "POST", `/api/tasks/${tid}/ack`, {})).task as Task;
	assert.equal(t.pings, undefined);
	assert.equal((await queue(A, tok.alice!)).items.find((i) => i.taskId === tid)?.level ?? "archived", "archived");
});

test("comments: @mentions ping people, plain comments ping nobody, workers can @ the requester", async () => {
	let r = await ok(B, tok.bob!, "POST", `/api/tasks/${tid}/comments`, { text: "@alice 这里的接口要不要兼容旧版？" });
	assert.deepEqual(r.comment.mentions, ["alice"]);
	assert.equal(r.comment.author, "bob");
	assert.deepEqual(r.task.watchers, ["simon", "bob"]); // commenters follow the task
	assert.deepEqual(r.task.pings.map((p: any) => [p.user, p.kind]), [["alice", "mention"]]);
	const ma = await until(async () => (await queue(A, tok.alice!)).items.find((i) => i.taskId === tid && i.level === "need"), "mention in alice's need");
	assert.equal(ma.mark, "[@]");
	assert.match(ma.reason, /Bob @你：@alice 这里的接口要不要兼容旧版/);
	assert.equal((await queue(B, tok.bob!)).counts.need, 0); // the author is not pinged
	r = await ok(A, tok.alice!, "POST", `/api/tasks/${tid}/comments`, { text: "不用兼容" });
	assert.deepEqual(r.comment.mentions, []);
	assert.equal(r.task.pings, undefined); // alice replying handled her mention
	r = await ok(A, "root-ha", "POST", `/api/tasks/${tid}/comments`, { text: "@alice 两种方案选哪个？", asWorker: true });
	assert.equal(r.comment.author, "agent");
	assert.deepEqual(r.task.pings.map((p: any) => [p.user, p.kind, p.by]), [["alice", "mention", "agent"]]);
	r = await ok(A, tok.simon!, "POST", `/api/tasks/${tid}/comments`, { text: "@all 周五发布" });
	assert.deepEqual(r.comment.mentions.sort(), ["alice", "bob"]);
	const { comments, task } = await ok(B, tok.bob!, "GET", `/api/tasks/${tid}`);
	assert.equal(comments.length, 4);
	assert.equal(task.comments, 4);
	assert.equal(task.lastComment.author, "simon");
});

test("assign: hand to a person, ask for a review, watchers; CLI", async () => {
	let t = (await ok(B, tok.alice!, "POST", `/api/tasks/${tid}/assign`, { assignee: "bob", note: "你来跟进" })).task as Task;
	assert.equal(t.assignee, "bob");
	assert.ok(t.pings?.some((p) => p.user === "bob" && p.kind === "assign" && p.by === "alice"));
	t = (await ok(B, tok.alice!, "POST", `/api/tasks/${tid}/assign`, { assignee: null, reviewer: null, watchersRemove: ["simon"] })).task as Task;
	assert.equal(t.assignee, undefined);
	assert.equal(t.reviewer, undefined);
	assert.deepEqual(t.watchers, ["bob"]);
	const q = (token: string, ...args: string[]) =>
		spawnSync(process.execPath, [join(REPO, "cli", "quick.ts"), ...args], { env: { ...env0, QA_HOME: B.home, QA_TOKEN: token, QA_UPDATE: "off" }, encoding: "utf8", timeout: 60_000 });
	let c = q(tok.alice!, "assign", tid, "--reviewer", "bob");
	assert.equal(c.status, 0, c.stderr);
	assert.match(c.stdout, /验收 bob/);
	c = q(tok.bob!, "team", "board"); // a settled task with a review request is open again: bob's ball
	assert.equal(c.status, 0, c.stderr);
	assert.match(c.stdout, new RegExp(`球在 Bob（1）  ← 你\\n\\s+\\[(REVIEW|@)\\]\\s+${tid}`));
	c = q(tok.bob!, "comment", tid, "@alice", "收到");
	assert.equal(c.status, 0, c.stderr);
	assert.match(c.stdout, /点名 alice/);
	c = q(tok.bob!, "team");
	assert.equal(c.status, 0, c.stderr);
	assert.match(c.stdout, /\* bob/);
	assert.match(c.stdout, /simon\s+owner\s+Simon\s+.*机器: ha/);
});
