import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitLifecycle, type GitWorkspace } from "../hub/git-lifecycle.ts";

// Every Git remote is a newly created local bare repository. Never inherit live QA routing.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QA_") && !k.startsWith("GIT_")));
const GIT = execFileSync("which", ["git"], { env, encoding: "utf8" }).trim();
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "git-lifecycle-suite-")));
const gitEnv = { ...env, HOME: TMP, XDG_CONFIG_HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync(GIT, ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lifecycle = new GitLifecycle();
let serial = 0;
after(() => rmSync(TMP, { recursive: true, force: true }));

function fixture(base = "main") {
	const root = join(TMP, String(++serial));
	const dev = join(root, "dev repo");
	const remote = join(root, "origin.git");
	const worktreeRoot = join(root, "task trees");
	mkdirSync(dev, { recursive: true });
	git(root, "init", "--bare", "-b", base, remote);
	git(dev, "init", "-b", base);
	git(dev, "config", "commit.gpgsign", "false");
	git(dev, "config", "core.autocrlf", "false");
	git(dev, "config", "user.name", "Test");
	git(dev, "config", "user.email", "test@example.invalid");
	writeFileSync(join(dev, "tracked.txt"), "base\n");
	writeFileSync(join(dev, "unrelated.txt"), "original\n");
	writeFileSync(join(dev, ".gitignore"), "ignored/\n*.artifact\n");
	mkdirSync(join(dev, "sub"));
	writeFileSync(join(dev, "sub", "file"), "base\n");
	git(dev, "add", ".");
	git(dev, "commit", "-m", "initial");
	git(dev, "remote", "add", "origin", remote);
	git(dev, "push", "-u", "origin", base);
	const initial = git(dev, "rev-parse", "HEAD");
	const prepare = (id = "task", workspace: "direct" | "worktree" = "worktree") => lifecycle.prepare({ id, cwd: dev, workspace, worktreeRoot });
	return { root, dev, remote, worktreeRoot, initial, prepare };
}
function change(cwd: string, path = "tracked.txt", contents = "changed\n"): string {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), contents);
	git(cwd, "add", "--", path);
	git(cwd, "commit", "-m", `change ${path}`);
	return git(cwd, "rev-parse", "HEAD");
}
function remoteSha(f: ReturnType<typeof fixture>, base = "main") { return git(f.remote, "rev-parse", `refs/heads/${base}`); }
function assertTreePresent(s: GitWorkspace) { assert.ok(existsSync(s.cwd)); assert.equal(git(s.cwd, "branch", "--show-current"), s.branch); }
async function withGitWrapper(f: ReturnType<typeof fixture>, code: string, action: () => Promise<void>) {
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	const wrapper = join(bin, "git");
	writeFileSync(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\n${code}\nconst r=spawnSync(${JSON.stringify(GIT)},args,{stdio:'inherit'});process.exit(r.status??1);\n`);
	chmodSync(wrapper, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;
	try { await action(); } finally { process.env.PATH = previous; }
}

test("prepare is serializable, durable/idempotent, and finds the main worktree from a linked subdirectory", async () => {
	const f = fixture("trunk");
	const linked = join(f.root, "linked");
	git(f.dev, "worktree", "add", "-b", "feature", linked);
	const options = { id: "owned", cwd: join(linked, "sub"), workspace: "worktree" as const, worktreeRoot: f.worktreeRoot };
	const s = await lifecycle.prepare(options);
	assert.equal(s.repo, f.dev);
	assert.equal(s.devCwd, f.dev);
	assert.equal(s.baseBranch, "trunk");
	assert.equal(s.baseSha, f.initial);
	assert.equal(s.branch, "task/owned");
	assert.equal(s.remote, "origin");
	assert.deepEqual(s.initialDirty, []);
	assert.equal(await new GitLifecycle().head(JSON.parse(JSON.stringify(s))), f.initial);
	writeFileSync(join(s.cwd, "cancellation-note"), "keep");
	assert.deepEqual(await new GitLifecycle().prepare(options), s);
	assert.equal(readFileSync(join(s.cwd, "cancellation-note"), "utf8"), "keep");
});

test("require origin and an existing valid target; use main only when remote HEAD is unavailable", async () => {
	const f = fixture();
	git(f.dev, "remote", "remove", "origin");
	await assert.rejects(f.prepare(), /origin/);
	git(f.dev, "remote", "add", "origin", f.remote);
	for (const baseBranch of ["--upload-pack=bad", "../main", "HEAD", "refs/heads/main", "missing"]) {
		await assert.rejects(lifecycle.prepare({ id: "invalid", cwd: f.dev, workspace: "worktree", worktreeRoot: f.worktreeRoot, baseBranch }));
	}
	git(f.remote, "symbolic-ref", "HEAD", "refs/heads/nonexistent");
	assert.equal((await f.prepare()).baseBranch, "main");
	const other = fixture("production");
	git(other.remote, "symbolic-ref", "HEAD", "refs/heads/nonexistent");
	await assert.rejects(other.prepare(), /main/);
});

test("refuse unrecognized directories, dangling symlinks, existing branches and reused IDs with different destinations", async () => {
	const f = fixture();
	mkdirSync(join(f.worktreeRoot, "existing"), { recursive: true });
	await assert.rejects(f.prepare("existing"), /unrecognized/);
	symlinkSync(join(f.root, "missing"), join(f.worktreeRoot, "symlink"));
	await assert.rejects(f.prepare("symlink"), /unrecognized/);
	git(f.dev, "branch", "task/branch");
	await assert.rejects(f.prepare("branch"), /existing branch/);
	const s = await f.prepare();
	await assert.rejects(lifecycle.prepare({ id: "task", cwd: f.dev, workspace: "worktree", worktreeRoot: join(f.root, "different") }), /ownership/);
	await assert.rejects(f.prepare("../escape"), /Invalid workspace id/);
	assertTreePresent(s);
});

test("bare main worktree is rejected instead of guessing a developer directory", async () => {
	const f = fixture();
	const linked = join(f.root, "bare-linked");
	git(f.remote, "worktree", "add", "-b", "linked", linked, "main");
	git(f.remote, "remote", "add", "origin", f.remote);
	await assert.rejects(lifecycle.prepare({ id: "ambiguous", cwd: linked, workspace: "worktree" }), /Ambiguous dev path/);
});

test("same-path recreation cannot impersonate an owned worktree, and detached source can prepare isolation", async () => {
	const f = fixture();
	const s = await f.prepare();
	git(f.dev, "worktree", "remove", s.cwd);
	git(f.dev, "worktree", "add", s.cwd, s.branch);
	await assert.rejects(f.prepare());
	await assert.rejects(lifecycle.cleanup(s, { sha: f.initial, workerActive: false }));
	assertTreePresent(s);
	git(f.dev, "switch", "--detach");
	const detached = await f.prepare("from-detached");
	assert.equal(await lifecycle.head(detached), f.initial);
	await assert.rejects(f.prepare("direct-detached", "direct"));
});

test("hidden index flags and in-progress Git operations cannot disguise dirty worktrees", async () => {
	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		const f = fixture();
		const s = await f.prepare();
		await lifecycle.integrate(s, { approvedSha: f.initial });
		git(s.cwd, "update-index", flag, "tracked.txt");
		writeFileSync(join(s.cwd, "tracked.txt"), "hidden user edit");
		assert.equal(git(s.cwd, "status", "--porcelain"), "");
		await assert.rejects(lifecycle.integrate(s, { approvedSha: f.initial }), /Hidden index flags/);
		await assert.rejects(lifecycle.cleanup(s, { sha: f.initial, workerActive: false }), /Hidden index flags/);
		assert.equal(readFileSync(join(s.cwd, "tracked.txt"), "utf8"), "hidden user edit");
	}
	const f = fixture();
	const s = await f.prepare("direct", "direct");
	writeFileSync(join(f.dev, ".git", "CHERRY_PICK_HEAD"), f.initial);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: f.initial }), /Unfinished Git operation/);
});

test("integrate exact approval, fast-forward clean dev, and safely remove only the owned worktree/branch", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	const result = await lifecycle.integrate(s, { approvedSha: sha });
	assert.deepEqual(result, { status: "pushed", sha, devUpdated: true });
	assert.equal(remoteSha(f), sha);
	assert.equal(git(f.dev, "rev-parse", "HEAD"), sha);
	await lifecycle.cleanup(s, { sha, workerActive: false });
	assert.equal(existsSync(s.cwd), false);
	assert.equal(git(f.dev, "for-each-ref", `refs/heads/${s.branch}`), "");
	assert.ok(existsSync(f.dev));
});

test("reject stale approval, symbolic revisions, active worker, switched branch and modified state", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: f.initial }), /HEAD/);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: "HEAD" }), /full commit SHA/);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha, workerActive: true }), /Worker/);
	await assert.rejects(lifecycle.head({ ...s, initialDirty: ["forged"] }));
	git(s.cwd, "switch", "-c", "switched");
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /identity or branch/);
	assert.equal(remoteSha(f), f.initial);
});

test("all kinds of isolated dirt block integrate and cleanup without committing or losing files", async () => {
	for (const kind of ["unstaged", "staged", "untracked", "ignored", "newline"]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		await lifecycle.integrate(s, { approvedSha: sha });
		const name = kind === "ignored" ? "ignored/keep" : kind === "newline" ? "new\nfile" : kind === "untracked" ? "extra" : "tracked.txt";
		mkdirSync(dirname(join(s.cwd, name)), { recursive: true });
		writeFileSync(join(s.cwd, name), `preserve ${kind}`);
		if (kind === "staged") git(s.cwd, "add", name);
		await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /Dirty worktree/);
		await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: false }), /Dirty worktree/);
		assert.equal(readFileSync(join(s.cwd, name), "utf8"), `preserve ${kind}`);
		assert.equal(await lifecycle.head(s), sha);
	}
});

test("direct permits preexisting unrelated staged, ignored, renamed and newline paths and never deletes them", async () => {
	const f = fixture();
	writeFileSync(join(f.dev, "unrelated.txt"), "user staged content");
	git(f.dev, "add", "unrelated.txt");
	git(f.dev, "mv", "sub/file", "sub/renamed\nfile");
	writeFileSync(join(f.dev, "user\nnotes"), "notes");
	mkdirSync(join(f.dev, "ignored"));
	writeFileSync(join(f.dev, "ignored", "secret"), "keep");
	const s = await f.prepare("direct", "direct");
	for (const path of ["unrelated.txt", "sub/file", "sub/renamed\nfile", "user\nnotes", "ignored/"]) assert.ok(s.initialDirty.includes(path), path);
	writeFileSync(join(f.dev, "tracked.txt"), "approved change");
	git(f.dev, "commit", "--only", "-m", "worker only", "--", "tracked.txt");
	const sha = await lifecycle.head(s);
	assert.deepEqual(await lifecycle.integrate(s, { approvedSha: sha }), { status: "pushed", sha, devUpdated: false });
	await lifecycle.cleanup(s, { sha, workerActive: false });
	assert.equal(readFileSync(join(f.dev, "unrelated.txt"), "utf8"), "user staged content");
	assert.equal(readFileSync(join(f.dev, "ignored", "secret"), "utf8"), "keep");
	assert.equal(git(f.dev, "show", `${sha}:unrelated.txt`), "original");
	assert.ok(git(f.dev, "diff", "--cached", "--name-only").includes("unrelated.txt"));
});

test("direct rejects commits touching initialDirty even if reverted, and rejects newly dirty paths", async () => {
	const f = fixture();
	writeFileSync(join(f.dev, "unrelated.txt"), "user edit");
	const s = await f.prepare("direct", "direct");
	change(f.dev, "unrelated.txt", "temporarily included");
	const sha = change(f.dev, "unrelated.txt", "original\n");
	assert.equal(git(f.dev, "diff", `${s.baseSha}..${sha}`, "--", "unrelated.txt"), "");
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /initialDirty/);
	assert.equal(remoteSha(f), f.initial);
	const g = fixture();
	const direct = await g.prepare("direct", "direct");
	const head = change(g.dev);
	writeFileSync(join(g.dev, "new-uncommitted"), "keep");
	await assert.rejects(lifecycle.integrate(direct, { approvedSha: head }), /New uncommitted/);
});

test("direct prepare retains baseline ownership across IDs and interrupted task-record publication", async () => {
	const f = fixture();
	writeFileSync(join(f.dev, "unrelated.txt"), "original dirt");
	const state = await f.prepare("first", "direct");
	assert.deepEqual(await f.prepare("second", "direct"), state);
	assert.deepEqual(await f.prepare("second", "direct"), state);
	const tasks = join(f.dev, ".git", "git-lifecycle", "tasks");
	rmSync(join(tasks, `${createHash("sha256").update("first").digest("hex")}.json`));
	assert.deepEqual(await f.prepare("first", "direct"), state);
	rmSync(join(tasks, `${createHash("sha256").update("first").digest("hex")}.json`));
	writeFileSync(join(f.dev, "unrelated.txt"), "changed dirt");
	await assert.rejects(f.prepare("first", "direct"), /initialDirty/);
	assert.equal(readdirSync(join(f.dev, ".git", "git-lifecycle", "recovery")).length, 1);
	assert.equal(remoteSha(f), f.initial);
});

test("direct immutable backups reject overwritten/deleted dirty files, modes and symlinks after a disjoint commit", async () => {
	for (const mode of ["tracked", "untracked", "ignored", "deleted", "mode", "symlink"]) {
		const f = fixture();
		const path = mode === "tracked" ? "unrelated.txt" : mode === "ignored" ? "ignored/secret" : "user-note";
		const file = join(f.dev, path);
		mkdirSync(dirname(file), { recursive: true });
		if (mode === "symlink") symlinkSync("original-target", file);
		else writeFileSync(file, "original private bytes\0\xff");
		const options = { id: "direct", cwd: f.dev, workspace: "direct" as const };
		const state = await lifecycle.prepare(options);
		const recovery = join(f.dev, ".git", "git-lifecycle", "recovery");
		const backup = join(recovery, readdirSync(recovery)[0]);
		const manifest = readFileSync(join(backup, "manifest.json"), "utf8");
		assert.equal(statSync(backup).mode & 0o777, 0o700);
		assert.equal(JSON.stringify(state).includes("original private"), false);
		assert.equal("baseline" in state, false);
		if (mode === "deleted" || mode === "symlink") rmSync(file);
		if (mode === "symlink") symlinkSync("changed-target", file);
		else if (mode === "mode") chmodSync(file, 0o755);
		else if (mode !== "deleted") writeFileSync(file, "replacement user content");
		// Retry must retain the established ownership and baseline, even after edits.
		assert.deepEqual(await new GitLifecycle().prepare(options), state);
		assert.deepEqual(readdirSync(recovery), [backup.slice(recovery.length + 1)]);
		const sha = change(f.dev);
		await assert.rejects(new GitLifecycle().integrate(JSON.parse(JSON.stringify(state)), { approvedSha: sha }), /initialDirty/);
		assert.equal(remoteSha(f), f.initial);
		assert.equal(readFileSync(join(backup, "manifest.json"), "utf8"), manifest);
		const saved = join(backup, `file-${createHash("sha256").update(path).digest("hex")}`);
		assert.equal(readFileSync(saved, "utf8"), mode === "symlink" ? "original-target" : "original private bytes\0\xff");
		assert.equal(statSync(saved).mode & 0o777, 0o600);
		if (mode === "symlink") assert.equal(readlinkSync(file), "changed-target");
		else if (mode === "deleted") assert.equal(existsSync(file), false);
		else if (mode !== "mode") assert.equal(readFileSync(file, "utf8"), "replacement user content");
	}
});

test("direct rejects index-only blob, mode and intent-to-add changes and preserves original staged bytes", async () => {
	for (const mode of ["blob", "mode", "intent"]) {
		const f = fixture();
		const path = mode === "intent" ? "empty-new" : "unrelated.txt";
		const file = join(f.dev, path);
		writeFileSync(file, mode === "intent" ? "" : "original staged bytes");
		git(f.dev, "add", ...(mode === "intent" ? ["-N"] : []), "--", path);
		const originalOid = git(f.dev, "rev-parse", `:${path}`);
		if (mode !== "intent") writeFileSync(file, "separate worktree bytes");
		const state = await f.prepare("direct", "direct");
		const unchanged = readFileSync(file);
		writeFileSync(join(f.dev, "tracked.txt"), "approved disjoint commit");
		git(f.dev, "commit", "--only", "-m", "disjoint", "--", "tracked.txt");
		const sha = await lifecycle.head(state);
		if (mode === "blob") git(f.dev, "update-index", "--cacheinfo", `100644,${git(f.dev, "rev-parse", "HEAD:tracked.txt")},${path}`);
		else if (mode === "mode") git(f.dev, "update-index", "--chmod=+x", path);
		else git(f.dev, "add", "--", path);
		assert.deepEqual(readFileSync(file), unchanged);
		await assert.rejects(lifecycle.integrate(state, { approvedSha: sha }), /initialDirty/);
		assert.equal(remoteSha(f), f.initial);
		const recovery = join(f.dev, ".git", "git-lifecycle", "recovery");
		const backup = join(recovery, readdirSync(recovery)[0]);
		assert.equal(readFileSync(join(backup, `blob-${originalOid}`), "utf8"), mode === "intent" ? "" : "original staged bytes");
		assert.ok(existsSync(join(backup, "index")));
	}
});

test("direct always uses the canonical dev root, even when prepared from a linked subdirectory", async () => {
	const f = fixture();
	const linked = join(f.root, "manual");
	git(f.dev, "worktree", "add", "-b", "manual", linked);
	writeFileSync(join(f.dev, "dev-notes"), "keep dev");
	writeFileSync(join(linked, "linked-notes"), "keep linked");
	const s = await lifecycle.prepare({ id: "direct", cwd: join(linked, "sub"), workspace: "direct" });
	assert.equal(s.repo, f.dev);
	assert.equal(s.devCwd, f.dev);
	assert.equal(s.cwd, f.dev);
	assert.equal(s.branch, "main");
	assert.deepEqual(s.initialDirty, ["dev-notes"]);
	const sha = change(s.cwd);
	await lifecycle.integrate(s, { approvedSha: sha });
	await lifecycle.cleanup(s, { sha, workerActive: false });
	assertTreePresent(s);
	assert.equal(readFileSync(join(f.dev, "dev-notes"), "utf8"), "keep dev");
	assert.equal(readFileSync(join(linked, "linked-notes"), "utf8"), "keep linked");
	assert.equal(git(linked, "rev-parse", "HEAD"), f.initial);
});

test("direct refuses wrong branches and local commits even with a clean working tree", async () => {
	for (const mode of ["wrong-branch", "local-commits", "behind", "diverged"]) {
		const f = fixture();
		if (mode === "wrong-branch") git(f.dev, "switch", "-c", "unrelated");
		if (mode === "local-commits" || mode === "diverged") change(f.dev, "local-only");
		if (mode === "behind" || mode === "diverged") {
			const linked = join(f.root, "remote-writer");
			git(f.dev, "worktree", "add", "-b", "remote-writer", linked, f.initial);
			const advanced = change(linked, "remote-only");
			git(linked, "push", "origin", `${advanced}:refs/heads/main`);
		}
		const head = git(f.dev, "rev-parse", "HEAD");
		const remote = remoteSha(f);
		assert.equal(git(f.dev, "status", "--porcelain"), "");
		await assert.rejects(f.prepare("direct", "direct"), mode === "wrong-branch" ? /baseBranch/ : /HEAD.*baseSha/);
		assert.equal(git(f.dev, "rev-parse", "HEAD"), head);
		assert.equal(remoteSha(f), remote);
		// The owner can upgrade to an isolated workspace without changing dev.
		const isolated = await f.prepare("direct", "worktree");
		assert.equal(isolated.branch, "task/direct");
		assert.equal(await lifecycle.head(isolated), remote);
		assert.equal(git(f.dev, "rev-parse", "HEAD"), head);
	}
});

test("remote advance returns needs_update without rebasing, then accepts freshly reviewed worker rebase", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	const advanced = change(f.dev, "remote-only");
	git(f.dev, "push", "origin", "main");
	assert.deepEqual(await lifecycle.integrate(s, { approvedSha: sha }), { status: "needs_update", sha });
	assert.equal(await lifecycle.head(s), sha);
	assert.equal(remoteSha(f), advanced);
	git(s.cwd, "rebase", "origin/main");
	const rebased = await lifecycle.head(s);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /HEAD/);
	assert.equal((await lifecycle.integrate(s, { approvedSha: rebased })).status, "pushed");
});

test("tests run argv without a shell, detached at exact SHA, in a separate clean tree with no QA environment", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	const output = join(f.root, "test-result.json");
	const marker = join(f.root, "shell-injection");
	const arg = `; touch ${marker}; $(false)`;
	const old = process.env.QA_LIFECYCLE_SENTINEL;
	process.env.QA_LIFECYCLE_SENTINEL = "real-routing-must-not-leak";
	try {
		const code = `const {execFileSync}=require('node:child_process');const {writeFileSync}=require('node:fs');const g=(...a)=>execFileSync(${JSON.stringify(GIT)},a,{encoding:'utf8'}).trim();writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),sha:g('rev-parse','HEAD'),branch:g('branch','--show-current'),status:g('status','--porcelain'),qa:Object.keys(process.env).filter(k=>k.startsWith('QA_')),arg:process.argv[2]}));`;
		await lifecycle.integrate(s, { approvedSha: sha, test: [process.execPath, "-e", code, output, arg] });
	} finally { if (old === undefined) delete process.env.QA_LIFECYCLE_SENTINEL; else process.env.QA_LIFECYCLE_SENTINEL = old; }
	const result = JSON.parse(readFileSync(output, "utf8"));
	assert.notEqual(result.cwd, s.cwd);
	assert.notEqual(result.cwd, s.devCwd);
	assert.deepEqual({ ...result, cwd: undefined }, { cwd: undefined, sha, branch: "", status: "", qa: [], arg });
	assert.equal(existsSync(marker), false);
	assert.equal(existsSync(result.cwd), false);
});

test("failing tests never push; their dirty artifacts survive and no worker state is changed", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	const output = join(f.root, "test-cwd");
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha, test: [process.execPath, "-e", "const f=require('node:fs');f.writeFileSync(process.argv[1],process.cwd());f.writeFileSync('failed.artifact','keep');process.exit(7)", output] }));
	const testCwd = readFileSync(output, "utf8");
	assert.equal(readFileSync(join(testCwd, "failed.artifact"), "utf8"), "keep");
	assert.equal(remoteSha(f), f.initial);
	assert.equal(await lifecycle.head(s), sha);
	// Fixture teardown owns these test-only directories, unlike production cleanup.
	rmSync(dirname(testCwd), { recursive: true, force: true });
});

test("replacement refs cannot substitute different contents for the approved test SHA", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	git(f.dev, "replace", sha, f.initial);
	assert.equal(git(f.dev, "show", `${sha}:tracked.txt`), "base");
	await lifecycle.integrate(s, { approvedSha: sha, test: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('tracked.txt','utf8'),'changed\\n')"] });
	assert.equal(remoteSha(f), sha);
	assert.equal(git(f.remote, "show", `${sha}:tracked.txt`), "changed");
});

test("detect new worker commits or cancellation edits made during tests before pushing", async () => {
	for (const commitEdit of [false, true]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		const code = `const f=require('node:fs'),{execFileSync:g}=require('node:child_process');f.writeFileSync(process.argv[1]+'/cancelled','keep');${commitEdit ? `g(${JSON.stringify(GIT)},['-C',process.argv[1],'add','cancelled']);g(${JSON.stringify(GIT)},['-c','core.hooksPath=/dev/null','-C',process.argv[1],'commit','-m','late']);` : ""}`;
		await assert.rejects(lifecycle.integrate(s, { approvedSha: sha, test: [process.execPath, "-e", code, s.cwd] }), commitEdit ? /HEAD/ : /Dirty/);
		assert.equal(remoteSha(f), f.initial);
		assert.equal(readFileSync(join(s.cwd, "cancelled"), "utf8"), "keep");
	}
});

test("lost push success response is recovered by verifying the remote SHA", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	await withGitWrapper(f, `if(args.includes('push')){const r=spawnSync(${JSON.stringify(GIT)},args,{stdio:'inherit'});if(r.status===0){process.stderr.write('lost success response');process.exit(1);}process.exit(r.status??1);}`, async () => {
		assert.equal((await lifecycle.integrate(s, { approvedSha: sha })).status, "pushed");
	});
	assert.equal(remoteSha(f), sha);
});

test("retry after an accepted push skips tests and push when remote equals or descends from approval", async () => {
	for (const advance of [false, true]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		const pushed = join(f.root, "pushed");
		const recovered = join(f.root, "connection-restored");
		const tested = join(f.root, "tested");
		const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'once',{flag:'wx'})", tested];
		const wrapper = `const fs=require('node:fs');
if(args.includes('push')){if(fs.existsSync(${JSON.stringify(pushed)})){process.stderr.write('unexpected repeated push');process.exit(1);}const r=spawnSync(${JSON.stringify(GIT)},args,{stdio:'inherit'});if(r.status===0)fs.writeFileSync(${JSON.stringify(pushed)},'yes');process.exit(r.status??1);}
if(args.includes('fetch')&&fs.existsSync(${JSON.stringify(pushed)})&&!fs.existsSync(${JSON.stringify(recovered)})){process.stderr.write('confirmation connection lost');process.exit(1);}`;
		await withGitWrapper(f, wrapper, async () => {
			await assert.rejects(lifecycle.integrate(s, { approvedSha: sha, test: command }), /confirmation connection lost/);
			assert.equal(remoteSha(f), sha);
			assert.equal(git(f.dev, "rev-parse", "HEAD"), f.initial);
			let remote = sha;
			if (advance) {
				git(f.dev, "merge", "--ff-only", sha);
				remote = change(f.dev, "later-remote-change");
				git(f.dev, "push", "origin", "main");
			}
			writeFileSync(recovered, "yes");
			const restored = JSON.parse(JSON.stringify(s));
			assert.deepEqual(await new GitLifecycle().integrate(restored, { approvedSha: sha, test: command }), { status: "pushed", sha, devUpdated: !advance });
			assert.equal(readFileSync(tested, "utf8"), "once");
			assert.equal(remoteSha(f), remote);
			await new GitLifecycle().cleanup(restored, { sha, workerActive: false });
			assert.equal(existsSync(s.cwd), false);
		});
	}
});

test("push rejection does not masquerade as success and a racing remote advance requests update", async () => {
	for (const race of [false, true]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		const advanced = change(f.dev, "remote-change");
		const code = race
			? `if(args.includes('push'))spawnSync(${JSON.stringify(GIT)},['--git-dir',${JSON.stringify(f.remote)},'update-ref','refs/heads/main',${JSON.stringify(advanced)}],{stdio:'inherit'});`
			: "if(args.includes('push')){process.stderr.write('permission denied');process.exit(1);}";
		// The other commit must exist in the bare repository for the simulated race.
		if (race) git(f.dev, "push", "origin", `${advanced}:refs/heads/other`);
		await withGitWrapper(f, code, async () => {
			if (race) assert.deepEqual(await lifecycle.integrate(s, { approvedSha: sha }), { status: "needs_update", sha });
			else await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /permission denied/);
		});
		assert.equal(remoteSha(f), race ? advanced : f.initial);
		assert.equal(await lifecycle.head(s), sha);
	}
});

test("dirty, wrong-branch, or divergent developer trees are not updated; remote-verified cleanup still works", async () => {
	for (const mode of ["dirty", "ignored", "wrong-branch", "divergent"]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		if (mode === "dirty") writeFileSync(join(f.dev, "unrelated.txt"), "keep");
		if (mode === "ignored") writeFileSync(join(f.dev, "local.artifact"), "keep");
		if (mode === "wrong-branch") git(f.dev, "switch", "-c", "other");
		if (mode === "divergent") change(f.dev, "local-only");
		const devHead = git(f.dev, "rev-parse", "HEAD");
		assert.deepEqual(await lifecycle.integrate(s, { approvedSha: sha }), { status: "pushed", sha, devUpdated: false });
		assert.equal(git(f.dev, "rev-parse", "HEAD"), devHead);
		await lifecycle.cleanup(s, { sha, workerActive: false });
		assert.equal(existsSync(s.cwd), false);
	}
});

test("cleanup requires stopped worker, exact current SHA and live remote confirmation", async () => {
	const f = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: true }), /Worker/);
	await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: undefined as any }), /Worker/);
	await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: false }), /not verified on remote/);
	await lifecycle.integrate(s, { approvedSha: sha });
	const later = change(s.cwd, "late-commit");
	await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: false }), /preserving new commits/);
	await assert.rejects(lifecycle.cleanup(s, { sha: later, workerActive: false }), /not verified on remote/);
	assertTreePresent(s);
	assert.equal(await lifecycle.head(s), later);
	git(f.remote, "update-ref", "refs/heads/main", f.initial);
	await assert.rejects(lifecycle.cleanup(s, { sha: later, workerActive: false }), /not verified on remote/);
	assertTreePresent(s);
});

test("cleanup receipts recover interrupted removal and branch deletion across instances", async () => {
	for (const step of ["before-remove", "files-removed", "after-remove", "after-branch"]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		await lifecycle.integrate(s, { approvedSha: sha });
		const remove = "args.includes('worktree')&&args.includes('remove')";
		const deletion = step === "after-branch" ? "args.includes('branch')&&args.includes('-d')" : remove;
		const mutation = step === "before-remove" ? ""
			: step === "files-removed" ? `require('node:fs').rmSync(${JSON.stringify(s.cwd)},{recursive:true});`
				: `const r=spawnSync(${JSON.stringify(GIT)},args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);`;
		await withGitWrapper(f, `if(${deletion}){${mutation}process.stderr.write('cleanup interrupted');process.exit(1);}`, async () => {
			await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: false }), /cleanup interrupted/);
		});
		assert.equal(existsSync(s.cwd), step === "before-remove");
		assert.equal(git(f.dev, "for-each-ref", `refs/heads/${s.branch}`) === "", step === "after-branch");
		const receipts = join(f.dev, ".git", "git-lifecycle", "cleanups");
		const files = readdirSync(receipts);
		assert.equal(files.length, 1);
		assert.equal(JSON.parse(readFileSync(join(receipts, files[0]), "utf8")).sha, sha);
		const restored = JSON.parse(JSON.stringify(s));
		await new GitLifecycle().cleanup(restored, { sha, workerActive: false });
		await new GitLifecycle().cleanup(restored, { sha, workerActive: false });
		assert.equal(existsSync(s.cwd), false);
		assert.equal(git(f.dev, "for-each-ref", `refs/heads/${s.branch}`), "");
		assert.equal(remoteSha(f), sha);
		assert.equal(existsSync(f.dev), true);
	}
});

test("cleanup recovery requires its receipt, matching identity and fresh remote confirmation", async () => {
	for (const mode of ["no-receipt", "remote-rewind", "origin-change", "wrong-sha", "forged-state", "branch-moved", "replacement-tree"]) {
		const f = fixture();
		const s = await f.prepare();
		const sha = change(s.cwd);
		await lifecycle.integrate(s, { approvedSha: sha });
		if (mode === "no-receipt") git(f.dev, "worktree", "remove", s.cwd);
		else {
			await withGitWrapper(f, "if(args.includes('branch')&&args.includes('-d')){process.stderr.write('stop before branch deletion');process.exit(1);}", async () => {
				await assert.rejects(lifecycle.cleanup(s, { sha, workerActive: false }), /stop before branch deletion/);
			});
		}
		assert.equal(existsSync(s.cwd), false);
		let expected = /cleanup receipt/;
		let state = s;
		let approved = sha;
		let branchHead = sha;
		if (mode === "remote-rewind") { git(f.remote, "update-ref", "refs/heads/main", f.initial); expected = /not verified on remote/; }
		if (mode === "origin-change") { git(f.dev, "remote", "set-url", "origin", fixture().remote); expected = /identity/; }
		if (mode === "wrong-sha") { approved = f.initial; expected = /receipt.*SHA/; }
		if (mode === "forged-state") { state = { ...s, initialDirty: ["forged"] }; expected = /ENOENT|identity/; }
		if (mode === "branch-moved") {
			branchHead = change(f.dev, "new-local-work");
			git(f.dev, "branch", "-f", s.branch, branchHead);
			expected = /Branch changed/;
		}
		if (mode === "replacement-tree") {
			git(f.dev, "worktree", "add", s.cwd, s.branch);
			expected = /ENOENT|ownership/;
		}
		await assert.rejects(new GitLifecycle().cleanup(state, { sha: approved, workerActive: false }), expected);
		assert.equal(git(f.dev, "rev-parse", `refs/heads/${s.branch}`), branchHead);
		if (mode === "replacement-tree") assertTreePresent(s);
	}
});

test("remote URL changes and different push destinations fail closed", async () => {
	const f = fixture();
	const g = fixture();
	const s = await f.prepare();
	const sha = change(s.cwd);
	git(f.dev, "remote", "set-url", "origin", g.remote);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /identity/);
	git(f.dev, "remote", "set-url", "origin", f.remote);
	git(f.dev, "remote", "set-url", "--push", "origin", g.remote);
	await assert.rejects(lifecycle.integrate(s, { approvedSha: sha }), /fetch and push/);
	await assert.rejects(f.prepare("another"), /fetch and push/);
	assert.equal(remoteSha(f), f.initial);
	assert.equal(remoteSha(g), g.initial);
});

test("common-dir target lock serializes different instances and preserves malformed locks", async () => {
	const f = fixture();
	const a = await f.prepare("one");
	const b = await f.prepare("two");
	const first = change(a.cwd, "one");
	const second = change(b.cwd, "two");
	const entered = join(f.root, "test-entered");
	const pending = lifecycle.integrate(a, { approvedSha: first, test: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'yes');setTimeout(()=>{},250)", entered] });
	while (!existsSync(entered)) await new Promise((resolve) => setTimeout(resolve, 10));
	const concurrent = new GitLifecycle().integrate(b, { approvedSha: second });
	assert.equal((await pending).status, "pushed");
	assert.deepEqual(await concurrent, { status: "needs_update", sha: second });
	const lock = join(f.dev, ".git", "git-lifecycle", "locks", `${createHash("sha256").update("main").digest("hex")}.lock`);
	mkdirSync(lock);
	writeFileSync(join(lock, "owner"), "do not steal");
	await assert.rejects(lifecycle.integrate(b, { approvedSha: second }), /locked.*never stolen/);
	assert.equal(readFileSync(join(lock, "owner"), "utf8"), "do not steal");
});

test("killed local owner recovers atomically only after its orphaned command group is dead", { skip: process.platform !== "linux", timeout: 45_000 }, async () => {
	const f = fixture();
	const state = await f.prepare();
	const sha = change(state.cwd);
	const entered = join(f.root, "child-entered");
	const release = join(f.root, "release-grandchild");
	const grandchildReady = join(f.root, "grandchild-ready");
	const lock = join(f.dev, ".git", "git-lifecycle", "locks", `${createHash("sha256").update("main").digest("hex")}.lock`);
	const grandchild = `process.on('SIGHUP',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(grandchildReady)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},20)`;
	const command = `const fs=require('node:fs'),cp=require('node:child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(entered)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));setInterval(()=>{},1000)`;
	const source = `import {GitLifecycle} from ${JSON.stringify(new URL("../hub/git-lifecycle.ts", import.meta.url).href)};await new GitLifecycle().integrate(${JSON.stringify(state)},${JSON.stringify({ approvedSha: sha, test: [process.execPath, "-e", command] })});`;
	const hub = spawn(process.execPath, ["--input-type=module", "-e", source], { env: gitEnv, stdio: "ignore" });
	const exited = once(hub, "exit");
	const waitFor = async (predicate: () => boolean) => {
		const deadline = Date.now() + 10_000;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture child");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	let group: number | undefined;
	let child: { pid: number; cwd: string } | undefined;
	try {
		await waitFor(() => existsSync(entered) && existsSync(grandchildReady));
		child = JSON.parse(readFileSync(entered, "utf8"));
		const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
		assert.equal(owner.process.pid, hub.pid);
		assert.match(owner.process.start, /^\d+$/);
		assert.match(owner.process.boot, /^[a-f0-9-]{36}$/);
		const childStat = readFileSync(`/proc/${child!.pid}/stat`, "utf8");
		group = Number(childStat.slice(childStat.lastIndexOf(")") + 2).trim().split(/\s+/)[2]);
		assert.ok(readdirSync(lock).filter(name => name.startsWith("child-") && name.endsWith(".json")).some(name => {
			try { return JSON.parse(readFileSync(join(lock, name), "utf8")).pid === group; } catch { return false; }
		}), "active command group has a registered guardian (not an older exited helper marker)");
		// Live holder is never reclaimed, even though a contender waited its deadline.
		await assert.rejects(lifecycle.integrate(state, { approvedSha: sha }), /locked/);
		assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, owner.token);
		hub.kill("SIGKILL");
		await exited;
		// Kill both command parent and guardian, leaving ONLY the grandchild alive.
		process.kill(child!.pid, "SIGKILL");
		process.kill(group!, "SIGKILL");
		const grandchildPid = Number(readFileSync(grandchildReady, "utf8"));
			const stat = readFileSync(`/proc/${grandchildPid}/stat`, "utf8");
			assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2], String(group));
		await assert.rejects(lifecycle.integrate(state, { approvedSha: sha }), /locked/);
		assert.equal(remoteSha(f), f.initial);
		assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, owner.token);
		writeFileSync(release, "exit");
		const results = await Promise.all([new GitLifecycle().integrate(state, { approvedSha: sha }), new GitLifecycle().integrate(state, { approvedSha: sha })]);
		assert.deepEqual(results.map((r) => r.status), ["pushed", "pushed"]);
		assert.equal(remoteSha(f), sha);
		assert.equal(existsSync(lock), false);
		const retired = join(f.dev, ".git", "git-lifecycle", "retired-locks", owner.token);
		assert.equal(JSON.parse(readFileSync(join(retired, "owner.json"), "utf8")).token, owner.token);
	} finally {
		if (hub.exitCode === null && hub.signalCode === null) { hub.kill("SIGKILL"); await exited; }
		if (group) { try { process.kill(-group, "SIGKILL"); } catch {} }
		if (child) rmSync(dirname(child.cwd), { recursive: true, force: true });
	}
});

test("lifecycle never runs repository hooks or guesses test/deployment commands", async () => {
	const f = fixture();
	const marker = join(f.root, "hook-ran");
	const hooks = join(f.root, "hooks");
	mkdirSync(hooks);
	for (const name of ["post-checkout", "pre-push", "post-merge"]) {
		const hook = join(hooks, name);
		writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe');\n`);
		chmodSync(hook, 0o755);
	}
	git(f.dev, "config", "core.hooksPath", hooks);
	const s = await f.prepare();
	const sha = change(s.cwd);
	await lifecycle.integrate(s, { approvedSha: sha });
	await lifecycle.cleanup(s, { sha, workerActive: false });
	assert.equal(existsSync(marker), false);
	assert.deepEqual(readdirSync(join(f.dev, ".git", "git-lifecycle", "locks")), []);
});
