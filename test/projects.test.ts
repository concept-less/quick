// Project classification (shared/projects.ts): git remote / worktree / cross-machine, path, URL, text, merges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classify,
	dedupeByRemote,
	findProject,
	gitInfo,
	groupByProject,
	learn,
	mergeInto,
	mergeReplica,
	newProject,
	normalizeRemote,
	resolveProject,
	urlRuleFor,
	type Project,
} from "../shared/projects.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "qa-projects-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();

function repo(dir: string, remote?: string) {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	if (remote) git(dir, "remote", "add", "origin", remote);
	return dir;
}

function proj(id: string, extra: Partial<Project> = {}): Project {
	return { ...newProject(extra.name ?? id, id, 1), ...extra };
}

test("normalizeRemote: ssh, https, scp-like and file remotes", () => {
	assert.equal(normalizeRemote("git@github.com:concept-less/quick.git"), "github.com/concept-less/quick");
	assert.equal(normalizeRemote("https://github.com/Concept-Less/quick"), "github.com/concept-less/quick");
	assert.equal(normalizeRemote("https://user:tok@github.com/concept-less/quick.git/"), "github.com/concept-less/quick");
	assert.equal(normalizeRemote("ssh://git@github.com:22/concept-less/quick.git"), "github.com/concept-less/quick");
	assert.equal(normalizeRemote("git+ssh://git@github.com/concept-less/quick.git"), "github.com/concept-less/quick");
	assert.equal(normalizeRemote("/srv/git/quick.git"), "file:/srv/git/quick");
	assert.equal(normalizeRemote(""), undefined);
});

test("gitInfo: worktrees resolve to the main repository root", () => {
	const main = repo(join(TMP, "quick-agent"), "git@github.com:concept-less/quick.git");
	const wt = join(TMP, "qa-wt", "projects");
	git(main, "worktree", "add", "-q", wt, "-b", "wt/projects");
	mkdirSync(join(wt, "ui"), { recursive: true });
	const info = gitInfo(join(wt, "ui"))!;
	assert.equal(info.top, wt);
	assert.equal(info.root, main);
	assert.equal(info.remote, "github.com/concept-less/quick");
	assert.equal(gitInfo(main)!.root, main);
	const plain = join(TMP, "plain");
	mkdirSync(plain);
	assert.equal(gitInfo(plain), null);
});

test("classify: an unknown repository creates a project named after the main checkout", () => {
	const main = join(TMP, "quick-agent");
	const c = classify([], { cwd: main, machine: "cloud", git: gitInfo(main) });
	assert.equal(c.via, "git-remote");
	assert.equal(c.project, "quick-agent");
	assert.equal(c.create?.name, "quick-agent");
	assert.deepEqual(c.create?.remotes, ["github.com/concept-less/quick"]);
	assert.deepEqual(c.create?.dirs, [{ machine: "cloud", path: main }]);
});

test("classify: worktree, separate clone and another machine's checkout share one project via the remote", () => {
	const projects = [proj("quick-agent", { remotes: ["github.com/concept-less/quick"], dirs: [{ machine: "cloud", path: join(TMP, "quick-agent") }] })];
	// git worktree under a different directory
	assert.deepEqual(classify(projects, { cwd: join(TMP, "qa-wt", "projects"), machine: "cloud", git: gitInfo(join(TMP, "qa-wt", "projects")) }), { project: "quick-agent", via: "git-remote" });
	// independent clone with an https remote (like /home/simon/quick-agent-t2d42)
	const clone = repo(join(TMP, "quick-agent-t2d42"), "https://github.com/concept-less/quick.git");
	assert.equal(classify(projects, { cwd: clone, machine: "cloud", git: gitInfo(clone) }).project, "quick-agent");
	// the mac checkout, classified by the mac hub
	const mac = { top: "/Users/tianyu/quick-agent", root: "/Users/tianyu/quick-agent", remote: "github.com/concept-less/quick" };
	assert.deepEqual(classify(projects, { cwd: mac.top, machine: "mac-laptop", git: mac }), { project: "quick-agent", via: "git-remote" });
	// learning records the mac checkout so path-based guesses work everywhere afterwards
	assert.equal(learn(projects[0]!, { cwd: mac.top, machine: "mac-laptop", git: mac }, projects), true);
	assert.deepEqual(projects[0]!.dirs.map((d) => d.machine), ["cloud", "mac-laptop"]);
	assert.equal(learn(projects[0]!, { cwd: mac.top, machine: "mac-laptop", git: mac }, projects), false);
});

test("classify: a repository without a remote matches by its main root", () => {
	const local = repo(join(TMP, "notes"));
	const projects = [proj("notes", { dirs: [{ machine: "cloud", path: local }] })];
	assert.deepEqual(classify(projects, { cwd: local, machine: "cloud", git: gitInfo(local) }), { project: "notes", via: "git-root" });
});

test("classify: replicas without git info use path prefixes, then the directory name", () => {
	const projects = [
		proj("quick-agent", { dirs: [{ machine: "cloud", path: "/home/simon/quick-agent" }] }),
		proj("relay-website", { paths: ["/home/simon/relay-website"] }),
	];
	assert.deepEqual(classify(projects, { cwd: "/home/simon/relay-website/src" }), { project: "relay-website", via: "path" });
	assert.deepEqual(classify(projects, { cwd: "/home/simon/quick-agent" }), { project: "quick-agent", via: "path" });
	assert.deepEqual(classify(projects, { cwd: "/home/simon/relay-websites" }), { via: "none" });
	// mac checkout of quick-agent, unknown to this hub: matched by its directory name
	assert.deepEqual(classify(projects, { cwd: "/Users/tianyu/quick-agent" }), { project: "quick-agent", via: "dirname" });
	assert.deepEqual(classify(projects, { cwd: "/home/simon/quick-agent-te450" }), { project: "quick-agent", via: "dirname" });
	assert.deepEqual(classify(projects, { cwd: "/tmp" }), { via: "none" });
});

test("classify: deeper path rule inside a repository wins (monorepo sub-project)", () => {
	const main = join(TMP, "quick-agent");
	const projects = [proj("quick-agent", { remotes: ["github.com/concept-less/quick"] }), proj("electron", { paths: [join(main, "electron")] })];
	mkdirSync(join(main, "electron", "src"), { recursive: true });
	assert.equal(classify(projects, { cwd: join(main, "electron", "src"), git: gitInfo(join(main, "electron", "src")) }).project, "electron");
	assert.equal(classify(projects, { cwd: main, git: gitInfo(main) }).project, "quick-agent");
});

test("classify: browser page URL rules (substring, host, regex)", () => {
	const projects = [
		proj("quick-agent", { urls: ["127.0.0.1:7790"] }),
		proj("relay-website", { urls: ["admin.tokenjoy.org", "/ops\\.tokenjoy\\.org\\/\\?tab=/"] }),
	];
	assert.deepEqual(classify(projects, { cwd: "/home/simon", url: "http://127.0.0.1:7790/" }), { project: "quick-agent", via: "url" });
	assert.deepEqual(classify(projects, { url: "https://admin.tokenjoy.org/console/users" }), { project: "relay-website", via: "url" });
	assert.deepEqual(classify(projects, { url: "https://ops.tokenjoy.org/?tab=revenue&view=config" }), { project: "relay-website", via: "url" });
	assert.deepEqual(classify(projects, { url: "https://example.com/" }), { via: "none" });
	assert.equal(urlRuleFor("https://admin.tokenjoy.org/console/users?x=1"), "admin.tokenjoy.org");
	assert.equal(urlRuleFor("http://127.0.0.1:7790/#t1"), "127.0.0.1:7790");
	assert.equal(urlRuleFor("file:///tmp/x.html"), undefined);
	assert.equal(urlRuleFor("http://localhost/"), undefined);
	assert.equal(urlRuleFor("https://github.com/concept-less/quick/pull/3"), "github.com/concept-less/quick");
	assert.equal(urlRuleFor("https://github.com/"), undefined);
});

test("classify: light text inference from title and brief; ambiguous → unsorted", () => {
	const projects = [proj("quick-agent", { keywords: ["pi TUI"] }), proj("relay-website")];
	assert.deepEqual(classify(projects, { cwd: "/home/simon", title: "更新 quick-agent（cloud）" }), { project: "quick-agent", via: "text" });
	assert.deepEqual(classify(projects, { cwd: "/home/simon", title: "pi TUI 一键跳转 worker" }), { project: "quick-agent", via: "text" });
	assert.deepEqual(classify(projects, { cwd: "/tmp", title: "诊断 tokenjoy API 请求超时" }), { via: "none" });
	assert.deepEqual(classify(projects, { title: "x", brief: "quick-agent and relay-website" }), { via: "none" });
	// a passing mention in a long brief is not enough (a tokenjoy diagnosis that mentions quick-agent once)
	assert.deepEqual(classify(projects, { title: "诊断 API 请求超时", brief: "通过 quick-agent 派单，对照 mac 的结果" }), { via: "none" });
	assert.deepEqual(classify(projects, { title: "任务跨机器无损交接", brief: "quick-agent hub … quick-agent worker … quick-agent mesh" }), { project: "quick-agent", via: "text" });
	assert.deepEqual(classify(projects, { title: "relay-website 首页", brief: "参考 quick-agent 的样式, relay-website 改版" }), { project: "relay-website", via: "text" });
	// "quick-agentx" is not "quick-agent"
	assert.deepEqual(classify(projects, { title: "quick-agentx" }), { via: "none" });
});

test("classify: explicit project wins and unknown names are created", () => {
	const projects = [proj("quick-agent", { name: "Quick Agent" })];
	assert.deepEqual(classify(projects, { project: "quick agent", cwd: "/tmp" }), { project: "quick-agent", via: "explicit" });
	assert.deepEqual(classify(projects, { project: "Quick Agent" }), { project: "quick-agent", via: "explicit" });
	const c = classify(projects, { project: "tokenjoy 诊断" });
	assert.equal(c.via, "explicit");
	assert.equal(c.create?.name, "tokenjoy 诊断");
	assert.equal(c.project, "tokenjoy-诊断");
});

test("merge: rules move to the target, the old id stays an alias", () => {
	const a = proj("qa", { remotes: ["github.com/x/qa"], urls: ["127.0.0.1:7790"] });
	const b = proj("quick-agent", { remotes: ["github.com/concept-less/quick"] });
	const all = [a, b];
	mergeInto(a, b, 5);
	assert.equal(a.mergedInto, "quick-agent");
	assert.deepEqual(b.remotes.sort(), ["github.com/concept-less/quick", "github.com/x/qa"]);
	assert.ok(b.keywords.includes("qa"));
	assert.equal(resolveProject(all, "qa")?.id, "quick-agent");
	assert.equal(findProject(all, "qa")?.id, "quick-agent");
	assert.equal(classify(all, { url: "http://127.0.0.1:7790/" }).project, "quick-agent");
	const groups = groupByProject(all, [{ id: 1, project: "qa" }, { id: 2 }, { id: 3, project: "quick-agent" }]);
	assert.deepEqual(groups.map((g) => [g.id, g.tasks.length]), [["quick-agent", 2], ["", 1]]);
	assert.equal(groups[1]!.name, "未归类");
});

test("mesh: replicas union learned dirs; projects created twice for one repo are deduplicated deterministically", () => {
	const local = proj("quick-agent", { dirs: [{ machine: "cloud", path: "/home/simon/quick-agent" }], remotes: ["github.com/concept-less/quick"] });
	const remote = { ...proj("quick-agent", { name: "QA", dirs: [{ machine: "mac", path: "/Users/t/quick-agent" }], remotes: ["github.com/concept-less/quick"] }), updatedAt: 10 };
	const m = mergeReplica(local, remote);
	assert.equal(m.changed, true);
	assert.equal(m.project.name, "QA");
	assert.equal(m.project.dirs.length, 2);
	assert.equal(mergeReplica(m.project, remote).changed, false);
	// mac named its checkout "quick" and created its own project for the same remote
	const older = { ...proj("quick-agent", { remotes: ["github.com/concept-less/quick"] }), createdAt: 1 };
	const newer = { ...proj("quick", { remotes: ["github.com/concept-less/quick"] }), createdAt: 2 };
	const list1 = [structuredClone(newer), structuredClone(older)];
	const list2 = [structuredClone(older), structuredClone(newer)];
	assert.deepEqual(dedupeByRemote(list1), ["quick"]);
	assert.deepEqual(dedupeByRemote(list2), ["quick"]);
	assert.equal(list1.find((p) => p.id === "quick")!.mergedInto, "quick-agent");
});

test("mesh: replica comparison ignores key order and converges on equal timestamps", async () => {
	const { canonical } = await import("../shared/projects.ts");
	const a = proj("x", { urls: ["a"] });
	const b = Object.fromEntries(Object.entries(structuredClone(a)).reverse()) as Project;
	assert.equal(canonical(a), canonical(b));
	assert.equal(mergeReplica(a, b).changed, false);
	const l = { ...proj("x", { name: "L" }), updatedAt: 7 };
	const r = { ...proj("x", { name: "R" }), updatedAt: 7 };
	assert.equal(mergeReplica(l, r).project.name, mergeReplica(r, l).project.name);
});

test("mesh: rules replicate as a last-writer-wins set (learned rules from every hub survive, removals propagate)", async () => {
	const { addRule, removeRule } = await import("../shared/projects.ts");
	const cloud = proj("quick-agent");
	addRule(cloud, "urls", "127.0.0.1:7790", 10);
	const mac = { ...structuredClone(cloud), updatedAt: 20 };
	addRule(mac, "urls", "127.0.0.1:7791", 20);
	let m = mergeReplica(cloud, mac).project;
	assert.deepEqual(m.urls.sort(), ["127.0.0.1:7790", "127.0.0.1:7791"]);
	// cloud's view merged back into mac keeps both too
	assert.deepEqual(mergeReplica(mac, cloud).project.urls.sort(), ["127.0.0.1:7790", "127.0.0.1:7791"]);
	// removal on one hub wins over the stale copy on the other
	const removed = structuredClone(m);
	removeRule(removed, "urls", "127.0.0.1:7790", 30);
	m = mergeReplica(mac, removed).project;
	assert.deepEqual(m.urls, ["127.0.0.1:7791"]);
	// … and a later re-add wins over the removal
	addRule(m, "urls", "127.0.0.1:7790", 40);
	assert.deepEqual(mergeReplica(removed, m).project.urls.sort(), ["127.0.0.1:7790", "127.0.0.1:7791"]);
	// a learned URL that was removed by hand is not learned again
	const p = structuredClone(removed);
	assert.equal(learn(p, { url: "http://127.0.0.1:7790/x" }, [p]), false);
});

test("project order is stable (manual order, then creation) and reorder keeps the rest in place", async () => {
	const { compareProjects, reorderProjects, newProject } = await import("../shared/projects.ts");
	const a = newProject("a", "a", 3);
	const b = newProject("b", "b", 1);
	const c = newProject("c", "c", 2);
	const gone = { ...newProject("d", "d", 0), mergedInto: "a" };
	const all = [a, b, c, gone];
	assert.deepEqual([a, b, c].sort(compareProjects).map((p) => p.id), ["b", "c", "a"]);
	const changed = reorderProjects(all, ["a"], 10);
	assert.deepEqual([a, b, c].sort(compareProjects).map((p) => p.id), ["a", "b", "c"]);
	assert.deepEqual(changed.map((p) => p.id).sort(), ["a", "b", "c"]);
	assert.equal(gone.order, undefined);
	// an alias resolves to its live project; unchanged positions are not touched
	assert.deepEqual(reorderProjects(all, ["d", "b"], 20).map((p) => p.id), []);
	assert.deepEqual(reorderProjects(all, ["c"], 30).map((p) => [p.id, p.order]), [["c", 0], ["a", 1], ["b", 2]]);
	assert.equal(b.updatedAt, 30);
});
