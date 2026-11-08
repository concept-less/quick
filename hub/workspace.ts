// Workspace snapshot / transfer / apply for task handoff between machines (see handoff.ts).
//
// Two modes:
//   git  cwd is inside a git repo with at least one commit: ship the commit (git bundle, only when the
//        target lacks it), the staged diff, the unstaged diff and the untracked (non-ignored) files.
//   dir  anything else: a tar of the directory (size cap + exclude list), nested .git directories included.
// Both sides compute the same manifest (sha256 of every file, plus HEAD / branch / index tree for git),
// so the target can prove it reproduced the source workspace exactly before the handoff commits.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;

export const DEFAULT_EXCLUDE = ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".cache", ".next", ".turbo", ".DS_Store"];

export type OnConflict = "fail" | "stash" | "backup";

export interface Manifest {
	mode: "git" | "dir";
	head?: string | null;
	branch?: string | null;
	/** `git write-tree` of the index (captures staged vs unstaged). */
	index?: string | null;
	/** path (relative to root) → "f:<sha256>" | "x:<sha256>" (executable) | "l:<sha256 of link target>" | "d" (gitlink / empty dir) */
	files: Record<string, string>;
	count: number;
	bytes: number;
	digest: string;
}

export interface Snapshot {
	mode: "git" | "dir";
	/** Source repo root (git) or cwd (dir). */
	root: string;
	/** cwd relative to root ("" when cwd is the root). */
	sub: string;
	manifest: Manifest;
	head?: string | null;
	branch?: string | null;
	origin?: string;
	/** Package files written into the package dir. */
	files: string[];
	exclude: string[];
}

export interface Plan {
	root: string; // target root
	cwd: string; // target cwd
	action: "none" | "create" | "existing" | "backup";
	stash?: boolean; // stash the target's local changes first
	/** The existing target state is exactly what this task left behind on an earlier handoff away. */
	leftover?: boolean;
	bundle?: "none" | "full" | "thin";
	thinBase?: string;
	branchSha?: string | null;
	forceBranch?: boolean;
	notes: string[];
}

export interface Undo {
	root: string;
	createdDir?: boolean;
	wasEmptyDir?: boolean;
	backup?: string;
	dropBackupOnSuccess?: boolean;
	existingRepo?: boolean;
	origRef?: string;
	branch?: string | null;
	branchOld?: string | null;
	branchCreated?: boolean;
	stashed?: boolean;
	dropStashOnSuccess?: boolean;
	backupRef?: string;
}

export class WorkspaceError extends Error {}

// ---------------------------------------------------------------- helpers

export async function git(cwd: string, ...args: string[]): Promise<string> {
	try {
		const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
		return stdout;
	} catch (e: any) {
		throw new WorkspaceError(`git ${args.join(" ")} (in ${cwd}): ${String(e.stderr || e.message).trim().slice(0, 600)}`);
	}
}
async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
	try {
		await run("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
		return true;
	} catch {
		return false;
	}
}
async function gitTry(cwd: string, ...args: string[]): Promise<string | null> {
	try {
		return (await run("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER })).stdout.trim();
	} catch {
		return null;
	}
}
async function tar(args: string[], cwd?: string) {
	try {
		await run("tar", args, { cwd, maxBuffer: MAX_BUFFER });
	} catch (e: any) {
		throw new WorkspaceError(`tar ${args[0]}: ${String(e.stderr || e.message).trim().slice(0, 600)}`);
	}
}

export function sha256File(f: string) {
	return createHash("sha256").update(readFileSync(f)).digest("hex");
}
function sha(buf: Buffer | string) {
	return createHash("sha256").update(buf).digest("hex");
}
function real(p: string) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
function isDir(p: string) {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}
function isEmptyDir(p: string) {
	return isDir(p) && readdirSync(p).length === 0;
}
function within(p: string, root: string) {
	return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function hashEntry(abs: string): { h: string; size: number } | undefined {
	let st;
	try {
		st = lstatSync(abs);
	} catch {
		return undefined;
	}
	if (st.isSymbolicLink()) return { h: `l:${sha(readlinkSync(abs))}`, size: 0 };
	if (st.isDirectory()) return { h: "d", size: 0 };
	if (!st.isFile()) return undefined;
	return { h: `${st.mode & 0o111 ? "x" : "f"}:${sha256File(abs)}`, size: st.size };
}

function finishManifest(m: Omit<Manifest, "digest" | "count" | "bytes">, bytes: number): Manifest {
	const keys = Object.keys(m.files).sort();
	const h = createHash("sha256");
	h.update(`${m.mode}\n${m.head ?? ""}\n${m.branch ?? ""}\n${m.index ?? ""}\n`);
	for (const k of keys) h.update(`${k}\0${m.files[k]}\n`);
	return { ...m, count: keys.length, bytes, digest: h.digest("hex") };
}

// ---------------------------------------------------------------- manifests

async function gitRoot(cwd: string): Promise<string | null> {
	const top = await gitTry(cwd, "rev-parse", "--show-toplevel");
	return top ? real(top) : null;
}

async function gitManifest(root: string): Promise<Manifest> {
	const head = await gitTry(root, "rev-parse", "--verify", "-q", "HEAD");
	const branch = await gitTry(root, "symbolic-ref", "--short", "-q", "HEAD");
	const index = await gitTry(root, "write-tree");
	const list = (await git(root, "ls-files", "-z", "-co", "--exclude-standard")).split("\0").filter(Boolean);
	const files: Record<string, string> = {};
	let bytes = 0;
	for (const rel of new Set(list)) {
		const e = hashEntry(join(root, rel));
		if (!e) continue; // tracked but deleted in the worktree
		files[rel] = e.h;
		bytes += e.size;
	}
	return finishManifest({ mode: "git", head, branch, index, files }, bytes);
}

/** Walk a plain directory (excludes by basename), collecting files, symlinks and empty dirs. */
function walkDir(root: string, exclude: string[], maxBytes: number): { entries: string[]; files: Record<string, string>; bytes: number } {
	const ex = new Set(exclude);
	const entries: string[] = [];
	const files: Record<string, string> = {};
	let bytes = 0;
	const walk = (rel: string) => {
		const abs = rel ? join(root, rel) : root;
		const names = readdirSync(abs).sort();
		if (rel && !names.some((n) => !ex.has(n))) {
			entries.push(rel);
			files[rel] = "d";
		}
		for (const n of names) {
			if (ex.has(n)) continue;
			const r = rel ? `${rel}/${n}` : n;
			const st = lstatSync(join(root, r));
			if (st.isDirectory()) walk(r);
			else {
				const e = hashEntry(join(root, r));
				if (!e) continue;
				bytes += e.size;
				if (bytes > maxBytes)
					throw new WorkspaceError(`工作目录 ${root} 超过大小上限 ${(maxBytes / 1048576).toFixed(0)} MB（排除 ${exclude.join(", ")} 之后）；用 --no-workspace 跳过工作区同步，或调大 config.json 的 handoff.maxWorkspaceMB`);
				entries.push(r);
				files[r] = e.h;
			}
		}
	};
	walk("");
	return { entries, files, bytes };
}

export async function manifestOf(root: string, mode: "git" | "dir", exclude: string[]): Promise<Manifest> {
	if (mode === "git") return gitManifest(root);
	const w = walkDir(root, exclude, Number.MAX_SAFE_INTEGER);
	return finishManifest({ mode: "dir", files: w.files }, w.bytes);
}

export function diffManifests(a: Manifest, b: Manifest): string[] {
	const out: string[] = [];
	for (const k of ["head", "branch", "index"] as const) if ((a[k] ?? null) !== (b[k] ?? null)) out.push(`${k}: ${a[k] ?? "-"} ≠ ${b[k] ?? "-"}`);
	const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
	for (const k of [...keys].sort()) {
		if (a.files[k] === b.files[k]) continue;
		out.push(!(k in b.files) ? `missing ${k}` : !(k in a.files) ? `extra ${k}` : `differs ${k}`);
		if (out.length > 12) break;
	}
	return out;
}

// ---------------------------------------------------------------- source side

/** Cheap workspace facts (no hashing) for an early conflict check before the worker is stopped. */
export async function quickInfo(cwd: string): Promise<{ mode: "git" | "dir"; root: string; sub: string; head?: string | null; branch?: string | null }> {
	cwd = real(cwd);
	const root = await gitRoot(cwd);
	const head = root ? await gitTry(root, "rev-parse", "--verify", "-q", "HEAD") : null;
	if (root && head) return { mode: "git", root, sub: relative(root, cwd), head, branch: await gitTry(root, "symbolic-ref", "--short", "-q", "HEAD") };
	return { mode: "dir", root: cwd, sub: "" };
}

/** Snapshot the workspace at cwd into pkgDir (patches / tars). The bundle is made later (see makeBundle). */
export async function snapshotWorkspace(cwd: string, pkgDir: string, opts: { maxBytes: number; exclude: string[] }): Promise<Snapshot> {
	mkdirSync(pkgDir, { recursive: true });
	cwd = real(cwd);
	const root = await gitRoot(cwd);
	const head = root ? await gitTry(root, "rev-parse", "--verify", "-q", "HEAD") : null;
	if (root && head) {
		const branch = await gitTry(root, "symbolic-ref", "--short", "-q", "HEAD");
		const origin = (await gitTry(root, "remote", "get-url", "origin")) ?? undefined;
		const state = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].find((f) => existsSync(join(root, ".git", f)));
		if (state) throw new WorkspaceError(`仓库 ${root} 正处于未完成的 git 操作（${state}），请先完成或中止它再交接`);
		const files: string[] = [];
		const staged = await git(root, "diff", "--cached", "--binary", "--full-index", "--no-color", "--no-ext-diff");
		if (staged) writeFileSync(join(pkgDir, "staged.patch"), staged), files.push("staged.patch");
		const unstaged = await git(root, "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff");
		if (unstaged) writeFileSync(join(pkgDir, "unstaged.patch"), unstaged), files.push("unstaged.patch");
		const untracked = (await git(root, "ls-files", "-z", "--others", "--exclude-standard")).split("\0").filter(Boolean);
		if (untracked.length) {
			let size = 0;
			for (const f of untracked) size += hashEntry(join(root, f))?.size ?? 0;
			if (size > opts.maxBytes) throw new WorkspaceError(`untracked 文件共 ${(size / 1048576).toFixed(1)} MB，超过上限 ${(opts.maxBytes / 1048576).toFixed(0)} MB（可以加进 .gitignore，或用 --no-workspace）`);
			const list = join(pkgDir, "untracked.list");
			writeFileSync(list, `${untracked.join("\0")}\0`);
			await tar(["-c", "-f", join(pkgDir, "untracked.tar"), "--null", "--no-recursion", "-T", list], root);
			rmSync(list);
			files.push("untracked.tar");
		}
		const manifest = await gitManifest(root);
		return { mode: "git", root, sub: relative(root, cwd), manifest, head, branch, origin, files, exclude: [] };
	}
	// Plain directory (or a repo without commits: then .git travels inside the tar).
	const w = walkDir(cwd, opts.exclude, opts.maxBytes);
	const list = join(pkgDir, "dir.list");
	writeFileSync(list, w.entries.length ? `${w.entries.join("\0")}\0` : "");
	await tar(["-c", "-f", join(pkgDir, "dir.tar"), "--null", "--no-recursion", "-T", list], cwd);
	rmSync(list);
	const manifest = finishManifest({ mode: "dir", files: w.files }, w.bytes);
	return { mode: "dir", root: cwd, sub: "", manifest, files: ["dir.tar"], exclude: opts.exclude };
}

/** Decide bundle contents now that we know what the target has. Returns the bundle file name or undefined. */
export async function makeBundle(snap: Snapshot, plan: Plan, pkgDir: string): Promise<string | undefined> {
	if (snap.mode !== "git" || plan.bundle === "none" || !snap.head) return undefined;
	const refs = snap.branch ? [`refs/heads/${snap.branch}`] : ["HEAD"];
	const args = ["bundle", "create", "-q", join(pkgDir, "repo.bundle"), ...refs];
	if (plan.bundle === "thin" && plan.thinBase && (await gitOk(snap.root, "cat-file", "-e", `${plan.thinBase}^{commit}`))) args.push(`^${plan.thinBase}`);
	await git(snap.root, ...args);
	snap.files.push("repo.bundle");
	return "repo.bundle";
}

/** Branch relation check that needs the source's object database. */
export async function checkBranch(snap: Snapshot, plan: Plan): Promise<void> {
	if (snap.mode !== "git" || plan.action !== "existing" || !snap.branch || !plan.branchSha || plan.branchSha === snap.head) return;
	const known = await gitOk(snap.root, "cat-file", "-e", `${plan.branchSha}^{commit}`);
	const ancestor = known && (await gitOk(snap.root, "merge-base", "--is-ancestor", plan.branchSha, snap.head!));
	if (ancestor) return;
	if (plan.leftover || plan.stash) {
		plan.forceBranch = true;
		plan.notes.push(`目标分支 ${snap.branch} 与源分支已分叉，旧提交 ${plan.branchSha.slice(0, 10)} 保存在 refs/quick-agent/backup/ 下`);
		return;
	}
	throw new WorkspaceError(
		`目标机器上的分支 ${snap.branch}（${plan.branchSha.slice(0, 10)}）与源分支（${snap.head!.slice(0, 10)}）已分叉。选项：--on-conflict stash（在目标上把旧提交备份到 refs/quick-agent/backup/ 后切到源分支）、--on-conflict backup（整个目录挪开备份）、或用 --cwd 指定另一个目录`,
	);
}

// ---------------------------------------------------------------- target side

export interface ProbeInput {
	taskId: string;
	mode: "git" | "dir" | "none";
	sub: string;
	head?: string | null;
	branch?: string | null;
	candidates: string[]; // candidate target roots, best first
	explicit: boolean;
	onConflict: OnConflict;
	exclude: string[];
	/** Paths (roots) of active tasks on this machine — sharing a workspace with a running worker is a conflict. */
	busy: { id: string; cwd: string }[];
	/** digest recorded when this task left this machine from that root (leftover detection). */
	departed?: (root: string) => string | undefined;
}

export async function planTarget(p: ProbeInput): Promise<Plan> {
	const notes: string[] = [];
	const exists = p.candidates.filter((c) => existsSync(c));
	const root = p.explicit ? p.candidates[0]! : (exists[0] ?? p.candidates[0]!);
	const cwd = p.sub ? join(root, p.sub) : root;
	if (p.mode === "none") {
		if (!isDir(cwd)) throw new WorkspaceError(`目标机器上不存在目录 ${cwd}（--no-workspace 时目标目录必须已存在；用 --cwd 指定）`);
		return { root, cwd, action: "none", notes };
	}
	const busy = p.busy.find((b) => within(real(b.cwd), real(root)) || within(real(root), real(b.cwd)));
	const conflictBusy = () =>
		new WorkspaceError(`目标目录 ${root} 正被运行中的任务 ${busy!.id}（${busy!.cwd}）使用，不能覆盖。选项：等它结束、用 --cwd 指定另一个目录`);
	if (!existsSync(root)) return { root, cwd, action: "create", bundle: "full", notes: [`目标目录 ${root} 原本不存在，已从 git bundle / tar 新建`] };
	if (!isDir(root)) throw new WorkspaceError(`目标路径 ${root} 存在但不是目录`);
	if (isEmptyDir(root)) return { root, cwd, action: "create", bundle: "full", notes };
	if (busy) throw conflictBusy();

	const departed = p.departed?.(real(root));
	const backupPlan = (why: string): Plan => {
		const leftover = departed !== undefined;
		notes.push(leftover ? `目标目录是本任务上次交接离开时留下的状态，已挪开（成功后删除）` : `目标目录 ${root} ${why}，已整体挪到备份目录`);
		return { root, cwd, action: "backup", bundle: "full", leftover, notes };
	};

	if (p.mode === "dir") {
		if (departed && (await manifestOf(root, "dir", p.exclude)).digest === departed) return backupPlan("");
		if (p.onConflict === "backup") return backupPlan("非空");
		throw new WorkspaceError(`目标目录 ${root} 已存在且非空，不能静默覆盖。选项：--on-conflict backup（把现有目录挪到 ${root}.qa-handoff-bak-<时间>）、或用 --cwd 指定另一个（不存在或空的）目录`);
	}

	// git mode
	const top = await gitRoot(root);
	if (top !== real(root)) {
		if (p.onConflict === "backup") return backupPlan(top ? `位于另一个仓库 ${top} 内` : "不是 git 仓库");
		throw new WorkspaceError(`目标目录 ${root} 已存在但${top ? `属于另一个仓库 ${top}` : "不是 git 仓库"}。选项：--on-conflict backup（挪开现有目录）、或用 --cwd 指定其它目录`);
	}
	const plan: Plan = { root, cwd, action: "existing", notes };
	const dirty = (await git(root, "status", "--porcelain", "--untracked-files=all")).trim();
	let leftover = false;
	if (dirty && departed) leftover = (await gitManifest(root)).digest === departed;
	if (dirty) {
		if (leftover) {
			plan.stash = true;
			plan.leftover = true;
			notes.push("目标仓库里的未提交改动正是本任务上次交接离开时留下的，已 stash（成功后丢弃）");
		} else if (p.onConflict === "stash") {
			plan.stash = true;
			notes.push(`目标仓库原有的未提交改动已 git stash（"quick-agent handoff ${p.taskId}"），需要时用 git stash list 找回`);
		} else if (p.onConflict === "backup") return backupPlan("有未提交改动");
		else
			throw new WorkspaceError(
				`目标仓库 ${root} 有未提交的改动或 untracked 文件，不能静默覆盖：\n${dirty.split("\n").slice(0, 8).join("\n")}\n选项：--on-conflict stash（先 git stash -u 保存它们）、--on-conflict backup（挪开整个目录）、或用 --cwd 指定其它目录`,
			);
	} else if (departed) {
		plan.leftover = (await gitManifest(root)).digest === departed;
	}
	const has = p.head ? await gitOk(root, "cat-file", "-e", `${p.head}^{commit}`) : true;
	const targetHead = await gitTry(root, "rev-parse", "--verify", "-q", "HEAD");
	plan.bundle = has ? "none" : "thin";
	plan.thinBase = targetHead ?? undefined;
	plan.branchSha = p.branch ? await gitTry(root, "rev-parse", "--verify", "-q", `refs/heads/${p.branch}`) : null;
	return plan;
}

/** Apply the shipped workspace on the target. On error the caller must run undoWorkspace(undo). */
export async function applyWorkspace(snap: Snapshot, plan: Plan, pkgDir: string, taskId: string, undo: Undo): Promise<void> {
	const { root } = plan;
	undo.root = root;
	if (plan.action === "none") return;
	const has = (f: string) => snap.files.includes(f) && existsSync(join(pkgDir, f));
	const fresh = plan.action === "create" || plan.action === "backup";
	if (plan.action === "backup") {
		const bak = `${root}.qa-handoff-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		renameSync(root, bak);
		undo.backup = bak;
		undo.dropBackupOnSuccess = !!plan.leftover;
	}
	if (fresh) {
		undo.wasEmptyDir = existsSync(root);
		undo.createdDir = true;
		mkdirSync(dirname(root), { recursive: true });
	}
	if (snap.mode === "dir") {
		mkdirSync(root, { recursive: true });
		await tar(["-x", "-k", "-f", join(pkgDir, "dir.tar")], root);
		return;
	}
	const ref = snap.branch ? `refs/heads/${snap.branch}` : "HEAD";
	if (fresh) {
		if (!has("repo.bundle")) throw new WorkspaceError("缺少 repo.bundle");
		mkdirSync(root, { recursive: true });
		await git(root, "init", "-q");
		await git(root, "fetch", "-q", join(pkgDir, "repo.bundle"), ref);
		if (snap.origin) await git(root, "remote", "add", "origin", snap.origin);
		await checkout(root, snap);
	} else {
		undo.existingRepo = true;
		undo.origRef = (await gitTry(root, "symbolic-ref", "-q", "HEAD")) ?? (await gitTry(root, "rev-parse", "HEAD")) ?? undefined;
		if (plan.stash) {
			await git(root, "stash", "push", "-u", "-q", "-m", `quick-agent handoff ${taskId}`);
			undo.stashed = true;
			undo.dropStashOnSuccess = !!plan.leftover;
		}
		if (has("repo.bundle")) await git(root, "fetch", "-q", join(pkgDir, "repo.bundle"), ref);
		if (!(await gitOk(root, "cat-file", "-e", `${snap.head}^{commit}`))) throw new WorkspaceError(`目标仓库缺少提交 ${snap.head}`);
		if (snap.branch) {
			undo.branch = snap.branch;
			undo.branchOld = await gitTry(root, "rev-parse", "--verify", "-q", `refs/heads/${snap.branch}`);
			undo.branchCreated = !undo.branchOld;
			if (undo.branchOld && plan.forceBranch && undo.branchOld !== snap.head) {
				undo.backupRef = `refs/quick-agent/backup/${snap.branch}-${Date.now()}`;
				await git(root, "update-ref", undo.backupRef, undo.branchOld);
			}
		}
		await checkout(root, snap);
	}
	if (has("staged.patch")) await git(root, "apply", "--index", "--binary", "--whitespace=nowarn", join(pkgDir, "staged.patch"));
	if (has("unstaged.patch")) await git(root, "apply", "--binary", "--whitespace=nowarn", join(pkgDir, "unstaged.patch"));
	if (has("untracked.tar")) await tar(["-x", "-k", "-f", join(pkgDir, "untracked.tar")], root);
}

async function checkout(root: string, snap: Snapshot) {
	if (snap.branch) await git(root, "checkout", "-q", "-B", snap.branch, snap.head!);
	else await git(root, "checkout", "-q", "--detach", snap.head!);
}

export async function verifyWorkspace(snap: Snapshot, plan: Plan): Promise<Manifest | undefined> {
	if (plan.action === "none") return undefined;
	let m = await manifestOf(plan.root, snap.mode, snap.exclude);
	if (snap.mode === "git") {
		// Global excludes may differ between machines: also hash shipped paths the target considers ignored.
		const files = { ...m.files };
		let bytes = m.bytes;
		for (const rel of Object.keys(snap.manifest.files)) {
			if (rel in files) continue;
			const e = hashEntry(join(plan.root, rel));
			if (e) (files[rel] = e.h), (bytes += e.size);
		}
		m = finishManifest({ mode: m.mode, head: m.head, branch: m.branch, index: m.index, files }, bytes);
	}
	if (m.digest !== snap.manifest.digest) throw new WorkspaceError(`工作区校验失败（${plan.root}）：\n  ${diffManifests(snap.manifest, m).join("\n  ")}`);
	return m;
}

export async function undoWorkspace(u: Undo): Promise<string[]> {
	const errs: string[] = [];
	const step = async (what: string, fn: () => Promise<unknown> | unknown) => {
		try {
			await fn();
		} catch (e) {
			errs.push(`${what}: ${(e as Error).message}`);
		}
	};
	const root = u.root;
	if (u.createdDir) {
		await step("remove new dir", () => rmSync(root, { recursive: true, force: true }));
		if (u.wasEmptyDir && !u.backup) await step("recreate empty dir", () => mkdirSync(root, { recursive: true }));
	}
	if (u.backup) await step("restore backup", () => renameSync(u.backup!, root));
	if (u.existingRepo) {
		await step("reset", () => git(root, "reset", "-q", "--hard"));
		await step("clean", () => git(root, "clean", "-fdq"));
		const orig = u.origRef;
		const origBranch = orig?.startsWith("refs/heads/") ? orig.slice(11) : undefined;
		if (orig) await step("checkout original", () => (origBranch ? git(root, "checkout", "-q", origBranch) : git(root, "checkout", "-q", "--detach", orig)));
		if (u.branch && u.branch !== origBranch) {
			if (u.branchCreated) await step("delete branch", () => git(root, "branch", "-q", "-D", u.branch!));
			else if (u.branchOld) await step("restore branch", () => git(root, "update-ref", `refs/heads/${u.branch}`, u.branchOld!));
		} else if (u.branch && u.branchOld) await step("restore branch head", () => git(root, "reset", "-q", "--hard", u.branchOld!));
		if (u.backupRef) await step("drop backup ref", () => git(root, "update-ref", "-d", u.backupRef!));
		if (u.stashed) await step("stash pop", () => git(root, "stash", "pop", "-q", "--index"));
	}
	return errs;
}

/** After a successful handoff: drop redundant leftovers (states that already live on in the incoming workspace). */
export async function finalizeWorkspace(u: Undo): Promise<void> {
	if (u.backup && u.dropBackupOnSuccess) rmSync(u.backup, { recursive: true, force: true });
	if (u.stashed && u.dropStashOnSuccess) await git(u.root, "stash", "drop", "-q").catch(() => {});
}

export function describeSnapshot(s: Snapshot): string {
	if (s.mode === "git") {
		const m = s.manifest;
		const parts = [
			`git 仓库，分支 ${s.branch ?? "(detached)"} @ ${s.head?.slice(0, 10)}`,
			s.files.includes("staged.patch") ? "已暂存改动" : "",
			s.files.includes("unstaged.patch") ? "未暂存改动" : "",
			s.files.includes("untracked.tar") ? "untracked 文件" : "",
		].filter(Boolean);
		return `${parts.join("、")}（共 ${m.count} 个文件，hash 已校验一致；.gitignore 忽略的文件不同步）`;
	}
	return `目录整体同步（${s.manifest.count} 个文件，${(s.manifest.bytes / 1048576).toFixed(1)} MB，hash 已校验一致；排除 ${s.exclude.join(", ")}）`;
}
