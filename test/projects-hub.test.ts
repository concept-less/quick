// Projects on a real (isolated) hub: backfill of existing tasks, config.json compatibility,
// manual move / rename / merge remembered across reclassification and restarts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "qa-projhub-")));
const HOME = join(TMP, "qa-home");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, NODE_NO_WARNINGS: "1", QA_HOME: HOME, QA_PORT: String(PORT), QA_MACHINE: "cloud", QA_UPDATE: "off" };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE_PRIORITY"]) delete (env as any)[k];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: gitEnv });
function repo(dir: string, remote?: string) {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	if (remote) git(dir, "remote", "add", "origin", remote);
	return dir;
}

const qa = repo(join(TMP, "quick-agent"), "git@github.com:concept-less/quick.git");
// Run the hub from the named fixture, not the developer/Actions checkout. The hub
// seeds its own repository as a project; CI clones this repo as "quick", while a
// maintainer may call it anything. Neither name may leak into these fixtures.
for (const dir of ["hub", "shared"]) cpSync(join(REPO, dir), join(qa, dir), { recursive: true });
cpSync(join(REPO, "package.json"), join(qa, "package.json"));
const wt = join(TMP, "qa-wt", "projects");
git(qa, "worktree", "add", "-q", wt, "-b", "wt/projects");
const clone = repo(join(TMP, "quick-agent-t2d42"), "https://github.com/concept-less/quick");
const relay = repo(join(TMP, "relay-website"), "git@github.com:concept-less/tokenjoy.git");
const plain = join(TMP, "home");
mkdirSync(plain, { recursive: true });

const fixtures: [string, string, string, string?][] = [
	// id, cwd, title, page url
	["ta001", qa, "整理并推送 quick-agent 所有提交"],
	["ta002", wt, "任务自动按项目整理"],
	["ta003", clone, "整体 UI 优化（极简粗野派）"],
	["tb001", relay, "控制台用户列表分页"],
	["tb002", plain, "优化运营大盘套餐表格显示", "https://admin.example.org/console/users"],
	["td001", plain, "更新 quick-agent（cloud）"],
	["te001", plain, "诊断 tokenjoy API 请求超时"],
	["tf001", plain, "tokenjoy 账单对账"],
	["tg001", plain, "共享页去掉说明小字", "http://10.144.144.2:5173/console/accounts"],
	["tg002", plain, "积分页对齐", "http://10.144.144.2:5173/console/credits"],
];

let hub: ChildProcess | undefined;
async function api(method: string, path: string, body?: any) {
	const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const json = (await r.json()) as any;
	if (!r.ok) throw new Error(`${path}: ${json.error}`);
	return json;
}
async function start() {
	hub = spawn(process.execPath, [join(qa, "hub", "server.ts")], { env, stdio: "ignore" });
	for (let i = 0; i < 60; i++) {
		await new Promise((r) => setTimeout(r, 150));
		try {
			await api("GET", "/health");
			return;
		} catch {}
	}
	throw new Error("hub did not start");
}
async function stop() {
	if (!hub) return;
	const h = hub;
	hub = undefined;
	await new Promise((r) => {
		h.once("exit", r);
		h.kill("SIGTERM");
	});
}
const byId = async () => Object.fromEntries(((await api("GET", "/api/tasks")).tasks as any[]).map((t) => [t.id, t]));

before(async () => {
	mkdirSync(join(HOME, "tasks"), { recursive: true });
	writeFileSync(
		join(HOME, "config.json"),
		JSON.stringify({
			host: "127.0.0.1",
			port: PORT,
			token: "tok",
			tmuxSession: `qa-projtest-${process.pid}`,
			defaultCwd: plain,
			// legacy URL → cwd mapping: merged into the relay-website project
			projects: [{ match: "admin.example.org", cwd: relay, notes: "官网后台" }],
			update: { enabled: false },
		}),
	);
	const now = Date.now();
	fixtures.forEach(([id, cwd, title, url], i) => {
		mkdirSync(join(HOME, "tasks", id), { recursive: true });
		const task = { id, machine: "cloud", rev: 1, title, brief: title, cwd, status: "done", createdAt: now - 1e6, updatedAt: now - 100_000 - i * 1000, source: url ? { kind: "browser", url } : { kind: "tui" }, attachments: [], unread: false, messages: 0, closed: true };
		writeFileSync(join(HOME, "tasks", id, "task.json"), JSON.stringify(task));
	});
	await start();
});
after(async () => {
	await stop();
	rmSync(TMP, { recursive: true, force: true });
});

test("existing tasks are backfilled into projects on startup", async () => {
	const t = await byId();
	const got = Object.fromEntries(Object.values(t).map((x: any) => [x.id, [x.project ?? null, x.projectVia]]));
	assert.deepEqual(got, {
		ta001: ["quick-agent", "git-remote"],
		ta002: ["quick-agent", "git-remote"], // git worktree
		ta003: ["quick-agent", "git-remote"], // separate clone, same remote
		tb001: ["relay-website", "git-remote"],
		tb002: ["relay-website", "url"], // config.json URL rule
		td001: ["quick-agent", "text"],
		te001: [null, "none"], // unsorted
		tf001: [null, "none"],
		tg001: [null, "none"],
		tg002: [null, "none"],
	});
	// updatedAt is not bumped by classification (list order stays)
	assert.ok(t.ta001.updatedAt < Date.now() - 50_000);
	const { projects } = await api("GET", "/api/projects");
	const relayP = projects.find((p: any) => p.id === "relay-website");
	assert.deepEqual(relayP.remotes, ["github.com/concept-less/tokenjoy"]);
	assert.ok(relayP.urls.includes("admin.example.org"));
	assert.equal(relayP.notes, "官网后台");
	assert.ok(projects.find((p: any) => p.id === "quick-agent").remotes.includes("github.com/concept-less/quick"));
	assert.ok(existsSync(join(HOME, "projects.json")));
});

test("manual move, rename and merge are remembered across reclassification and restarts", async () => {
	await api("POST", "/api/tasks/te001/project", { project: "tokenjoy 诊断" });
	await api("POST", "/api/tasks/td001/project", { project: "" }); // manual unsorted
	await api("POST", "/api/projects/relay-website/rename", { name: "官网" });
	await api("POST", "/api/projects/tokenjoy-诊断/merge", { into: "官网" });
	const r = await api("POST", "/api/projects/backfill", { all: true });
	assert.equal(r.changed, 0);
	await stop();
	await start();
	const t = await byId();
	assert.deepEqual([t.te001.project, t.te001.projectVia], ["relay-website", "manual"]);
	assert.deepEqual([t.td001.project ?? null, t.td001.projectVia], [null, "manual"]);
	const { projects } = await api("GET", "/api/projects");
	assert.equal(projects.find((p: any) => p.id === "relay-website").name, "官网");
	assert.equal(projects.find((p: any) => p.id === "tokenjoy-诊断").mergedInto, "relay-website");
	const stored = JSON.parse(readFileSync(join(HOME, "tasks", "te001", "task.json"), "utf8"));
	assert.equal(stored.project, "relay-website");
});

test("a new project picks up weakly classified tasks (text rules)", async () => {
	await api("POST", "/api/projects", { name: "tokenjoy", keywords: ["tokenjoy"] });
	await new Promise((r) => setTimeout(r, 700));
	const t = await byId();
	assert.deepEqual([t.tf001.project, t.tf001.projectVia], ["tokenjoy", "text"]);
	// te001 was moved by hand: it stays where the human put it
	assert.equal(t.te001.project, "relay-website");
	await assert.rejects(api("POST", "/api/projects", { name: "tokenjoy" }), /already exists/);
});

test("a manual move teaches the project the page URL, but never steals another project's repository", async () => {
	await api("POST", "/api/tasks/tg001/project", { project: "tokenjoy" });
	await new Promise((r) => setTimeout(r, 700));
	let t = await byId();
	assert.deepEqual([t.tg001.project, t.tg001.projectVia], ["tokenjoy", "manual"]);
	assert.deepEqual([t.tg002.project, t.tg002.projectVia], ["tokenjoy", "url"]);
	await api("POST", "/api/tasks/ta003/project", { project: "tokenjoy" });
	await new Promise((r) => setTimeout(r, 700));
	const { projects } = await api("GET", "/api/projects");
	const tj = projects.find((p: any) => p.id === "tokenjoy");
	assert.ok(tj.urls.includes("10.144.144.2:5173"));
	assert.ok(!tj.remotes.length && !tj.dirs.length, JSON.stringify(tj));
	t = await byId();
	assert.equal(t.ta001.project, "quick-agent");
});

test("manual project order is stored and survives a restart", async () => {
	const r = await api("POST", "/api/projects/order", { ids: ["tokenjoy", "relay-website"] });
	const order = (ps: any[]) => ps.filter((p) => !p.mergedInto).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map((p) => p.id);
	assert.deepEqual(order(r.projects).slice(0, 3), ["tokenjoy", "relay-website", "quick-agent"]);
	await stop();
	await start();
	assert.deepEqual(order((await api("GET", "/api/projects")).projects).slice(0, 3), ["tokenjoy", "relay-website", "quick-agent"]);
	await assert.rejects(api("POST", "/api/projects/order", { ids: "x" }), /array/);
});
