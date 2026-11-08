import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

export interface GitWorkspace {
	/** Canonical main worktree; cwd is the canonical worker worktree root. */
	repo: string;
	devCwd: string;
	cwd: string;
	branch: string;
	baseBranch: string;
	baseSha: string;
	remote: string;
	initialDirty: string[];
}

export interface PrepareOptions {
	id: string;
	cwd: string;
	workspace: "direct" | "worktree";
	baseBranch?: string;
	worktreeRoot?: string;
}
export interface IntegrateOptions {
	approvedSha: string;
	test?: string[];
	workerActive?: boolean;
}
export interface IntegrationResult {
	status: "pushed" | "needs_update";
	sha: string;
	devUpdated?: boolean;
}

interface RecordState {
	version: 1;
	id: string;
	workspace: "direct" | "worktree";
	originUrl: string;
	gitDir: string;
	ownership?: string;
	/** Private recovery data; never serialized into GitWorkspace / Task state. */
	baseline?: { directory: string; hash: string };
	state: GitWorkspace;
}
interface Worktree { path: string; branch?: string; bare: boolean }
interface CleanupReceipt {
	version: 1;
	state: GitWorkspace;
	sha: string;
	ownership: string;
}

const rawRun = promisify(execFile);
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const metadata = (common: string) => join(common, "git-lifecycle");
const stateKey = (s: GitWorkspace) => JSON.stringify([s.repo, s.devCwd, s.cwd, s.branch, s.baseBranch, s.baseSha, s.remote, s.initialDirty]);
const stateFile = (common: string, s: GitWorkspace) => join(metadata(common), "states", `${hash(stateKey(s))}.json`);
const cleanupFile = (common: string, s: GitWorkspace) => join(metadata(common), "cleanups", `${hash(stateKey(s))}.json`);

/** Child processes must not inherit a live hub's routing or Git directory overrides. */
function childEnv(): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QA_") && !k.startsWith("GIT_")));
	return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	// Lifecycle operations must not run repository hooks (including production deploy hooks).
	const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
		env: childEnv(), maxBuffer: 32 * 1024 * 1024,
	});
	return stdout.toString("utf8");
}
async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
}
async function commonDir(cwd: string): Promise<string> {
	return realpath((await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim());
}
async function gitDir(cwd: string): Promise<string> {
	return realpath((await git(cwd, "rev-parse", "--absolute-git-dir")).trim());
}
async function top(cwd: string): Promise<string> {
	return realpath((await git(cwd, "rev-parse", "--show-toplevel")).trim());
}
async function branch(cwd: string): Promise<string> {
	return (await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")).trim();
}
async function commit(cwd: string, ref = "HEAD"): Promise<string> {
	return (await git(cwd, "rev-parse", "--verify", `${ref}^{commit}`)).trim();
}
async function ancestor(cwd: string, a: string, b: string): Promise<boolean> {
	try { await git(cwd, "merge-base", "--is-ancestor", a, b); return true; }
	catch (e: any) { if (e.code === 1) return false; throw e; }
}
async function validBranch(cwd: string, name: string): Promise<void> {
	if (!name || name.startsWith("-") || name.startsWith("refs/") || name === "HEAD") throw new Error("Invalid target branch");
	await git(cwd, "check-ref-format", `refs/heads/${name}`);
}
async function origin(cwd: string): Promise<string> {
	const urls = (await git(cwd, "remote", "get-url", "--all", "origin")).trim().split("\n");
	const pushes = (await git(cwd, "remote", "get-url", "--push", "--all", "origin")).trim().split("\n");
	if (!urls[0] || urls.length !== 1 || pushes.length !== 1 || pushes[0] !== urls[0]) {
		throw new Error("Require one origin URL with the same fetch and push destination");
	}
	return urls[0];
}
async function worktrees(cwd: string): Promise<Worktree[]> {
	return (await git(cwd, "worktree", "list", "--porcelain", "-z")).split("\0\0").filter(Boolean).map((record) => {
		const fields = record.split("\0");
		const path = fields.find((f) => f.startsWith("worktree "))?.slice(9);
		if (!path) throw new Error("Invalid worktree listing");
		return { path, branch: fields.find((f) => f.startsWith("branch "))?.slice(7), bare: fields.includes("bare") };
	});
}
async function discover(cwd: string): Promise<{ repo: string; common: string; root: string }> {
	const root = await top(cwd);
	const common = await commonDir(root);
	const list = await worktrees(root);
	// Git lists the main worktree first, even when called from a linked worktree.
	const main = list[0];
	if (!main || main.bare) throw new Error("Ambiguous dev path: a non-bare main worktree is required");
	const repo = await realpath(main.path);
	if (await top(repo) !== repo || await gitDir(repo) !== common || await commonDir(repo) !== common ||
		list.filter((w) => w.path === root).length !== 1 || list.filter((w) => w.path === repo).length !== 1) {
		throw new Error("Ambiguous dev path or unregistered worktree");
	}
	return { repo, common, root };
}

async function dirty(cwd: string): Promise<string[]> {
	const entries = (await git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none")).split("\0");
	const paths = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		paths.add(entry.slice(3));
		if (/[RC]/.test(entry.slice(0, 2))) paths.add(entries[++i]);
	}
	return [...paths].sort();
}
async function inspectIndex(cwd: string): Promise<void> {
	// status deliberately omits these entries, so it cannot establish their safety.
	if ((await git(cwd, "ls-files", "-v", "-z")).split("\0").some((entry) => /^[a-zS] /.test(entry))) {
		throw new Error(`Hidden index flags (assume-unchanged/skip-worktree): ${cwd}`);
	}
	const dir = await gitDir(cwd);
	for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"]) {
		if (await exists(join(dir, name))) throw new Error(`Unfinished Git operation: ${name}`);
	}
}
async function clean(cwd: string): Promise<void> {
	await inspectIndex(cwd);
	if ((await dirty(cwd)).length) throw new Error(`Dirty worktree (including untracked/ignored files): ${cwd}`);
}
const overlaps = (a: string, b: string) => {
	a = a.replace(/\/$/, ""); b = b.replace(/\/$/, "");
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

interface BaselineEntry { path: string; kind: "missing" | "file" | "symlink" | "directory"; mode?: number; content?: string }
interface IndexEntry { path: string; mode: string; oid: string; stage: string; flags: string }
interface DirtyBaseline { version: 1; entries: BaselineEntry[]; index: IndexEntry[] }

async function dirtyIndex(cwd: string, paths: string[]): Promise<IndexEntry[]> {
	// Include semantic flags (not volatile index stat-cache times), stages, modes and
	// blob identities. --debug preserves intent-to-add, which --stage alone omits.
	let output = await git(cwd, "ls-files", "--stage", "--debug", "-z");
	const entries: IndexEntry[] = [];
	while (output) {
		const nul = output.indexOf("\0");
		const header = output.slice(0, nul).match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]*)$/);
		const flags = output.slice(nul + 1).match(/^[\s\S]*?flags: ([a-f0-9]+)\n/);
		if (nul < 0 || !header || !flags) throw new Error("Cannot inspect initialDirty index metadata");
		const [, mode, oid, stage, path] = header;
		if (paths.some((initial) => overlaps(path, initial))) entries.push({ path, mode, oid, stage, flags: flags[1] });
		output = output.slice(nul + 1 + flags[0].length);
	}
	return entries;
}
async function captureDirty(cwd: string, paths: string[], backup?: string): Promise<DirtyBaseline> {
	const entries = new Map<string, BaselineEntry>();
	const visit = async (path: string) => {
		path = path.replace(/\/$/, "");
		if (entries.has(path)) return;
		const full = join(cwd, path);
		let stat;
		try { stat = await lstat(full); }
		catch (e: any) {
			if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
			entries.set(path, { path, kind: "missing" }); return;
		}
		const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
		if (!kind) throw new Error(`Unsupported initialDirty file type: ${path}`);
		const entry: BaselineEntry = { path, kind, mode: stat.mode & 0o7777 };
		entries.set(path, entry);
		if (kind === "directory") {
			for (const name of (await readdir(full)).sort()) await visit(`${path}/${name}`);
		} else {
			const bytes = kind === "symlink" ? await readlink(full, { encoding: "buffer" }) : await readFile(full);
			entry.content = hash(bytes);
			// Flat, private files retain exact bytes (symlinks retain their target bytes).
			// The manifest retains names/types/modes; nothing is restored automatically.
			if (backup) await writeFile(join(backup, `file-${hash(path)}`), bytes, { flag: "wx", mode: 0o600 });
		}
	};
	for (const path of paths) await visit(path);
	return { version: 1, entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), index: await dirtyIndex(cwd, paths) };
}
async function backupDirty(common: string, record: RecordState): Promise<void> {
	const directory = join(metadata(common), "recovery", randomUUID());
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const snapshot = await captureDirty(record.state.cwd, record.state.initialDirty, directory);
	// Save both the complete original index and every referenced dirty index blob:
	// staged content can differ from the worktree and otherwise be garbage collected.
	if (await exists(join(record.gitDir, "index"))) {
		await writeFile(join(directory, "index"), await readFile(join(record.gitDir, "index")), { flag: "wx", mode: 0o600 });
	}
	for (const oid of new Set(snapshot.index.filter((e) => e.mode !== "160000" && !/^0+$/.test(e.oid)).map((e) => e.oid))) {
		const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-C", record.state.cwd, "cat-file", "blob", oid], { env: childEnv(), maxBuffer: 32 * 1024 * 1024 });
		await writeFile(join(directory, `blob-${oid}`), stdout, { flag: "wx", mode: 0o600 });
	}
	const manifest = JSON.stringify(snapshot);
	await writeFile(join(directory, "manifest.json"), manifest, { flag: "wx", mode: 0o600 });
	record.baseline = { directory, hash: hash(manifest) };
	if (JSON.stringify(await dirty(record.state.cwd)) !== JSON.stringify(record.state.initialDirty)) throw new Error("initialDirty changed during backup");
	await verifyDirty(record);
}
async function verifyDirty(record: RecordState): Promise<void> {
	if (!record.baseline) {
		if (record.state.initialDirty.length) throw new Error("initialDirty baseline missing; manual recovery required");
		return;
	}
	const manifest = await readFile(join(record.baseline.directory, "manifest.json"), "utf8");
	if (hash(manifest) !== record.baseline.hash ||
		JSON.stringify(await captureDirty(record.state.cwd, record.state.initialDirty)) !== manifest) {
		throw new Error(`initialDirty content, index, mode or symlink changed; original backup: ${record.baseline.directory}`);
	}
}

interface ProcessIdentity {
	pid: number;
	host: string;
	platform: string;
	boot?: string;
	start?: string;
	namespace?: string;
}
interface LockOwner { version: 1; token: string; process: ProcessIdentity }
const lockContext = new AsyncLocalStorage<string>();
const procFields = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
async function processIdentity(): Promise<ProcessIdentity> {
	const identity: ProcessIdentity = { pid: process.pid, host: hostname(), platform: process.platform };
	if (process.platform === "linux") {
		identity.boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		identity.start = procFields(await readFile("/proc/self/stat", "utf8"))[19];
		identity.namespace = await readlink("/proc/self/ns/pid");
	}
	return identity;
}
const validIdentity = (p: ProcessIdentity) => p && Number.isSafeInteger(p.pid) && p.pid > 0 &&
	typeof p.host === "string" && p.host.length > 0 && typeof p.platform === "string" &&
	(p.platform !== "linux" || (typeof p.boot === "string" && /^[a-f0-9-]{36}$/.test(p.boot) &&
		typeof p.start === "string" && /^\d+$/.test(p.start) && typeof p.namespace === "string" && /^pid:\[\d+\]$/.test(p.namespace)));

/** Unknown identity, permissions, namespaces and reused portable PIDs all fail closed. */
async function dead(p: ProcessIdentity, group = false): Promise<boolean> {
	if (!validIdentity(p) || p.host !== hostname() || p.platform !== process.platform) return false;
	try {
		if (p.platform === "linux") {
			if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== p.boot) return true;
			if (await readlink("/proc/self/ns/pid") !== p.namespace) return false;
			if (group) {
				try { process.kill(-p.pid, 0); }
				catch (e: any) { return e.code === "ESRCH"; }
				const listed = new Set(await readdir("/proc"));
				// The leader can exit before grandchildren. Inspect the entire process group,
				// including reparented children; zombies cannot perform further writes.
				for (const pid of listed) {
					if (!/^\d+$/.test(pid)) continue;
					try {
						const fields = procFields(await readFile(`/proc/${pid}/stat`, "utf8"));
						if (fields.length < 20) return false;
						if (fields[2] === String(p.pid) && !["Z", "X"].includes(fields[0])) return false;
					} catch (e: any) { if (e.code !== "ENOENT" && e.code !== "ESRCH") return false; }
				}
				// A member may have forked and exited during enumeration. Any newly
				// visible PID makes this pass inconclusive; retry on the next attempt.
				return (await readdir("/proc")).every((pid) => !/^\d+$/.test(pid) || listed.has(pid));
			}
			try {
				const fields = procFields(await readFile(`/proc/${p.pid}/stat`, "utf8"));
				return fields.length >= 20 && (fields[19] !== p.start || ["Z", "X"].includes(fields[0]));
			} catch (e: any) { return e.code === "ENOENT" || e.code === "ESRCH"; }
		}
		// No portable start identity: an existing PID (even a reused one) is preserved.
		// Windows has no POSIX process-group proof, so child markers stay conservative.
		if (group && process.platform === "win32") return false;
		try { process.kill(group ? -p.pid : p.pid, 0); return false; }
		catch (e: any) { return e.code === "ESRCH"; }
	} catch { return false; }
}

// The helper registers itself BEFORE spawning Git/tests. A pending marker is written
// BEFORE execFile, closing the spawn-to-record crash window (unknown => keep lock).
// It is a detached group leader; its command and ordinary descendants share the group.
// Commands that intentionally daemonize/setsid are outside this cooperative protocol.
const commandHelper = String.raw`
const fs = require('node:fs'), os = require('node:os'), cp = require('node:child_process');
const [marker, file, encoded] = process.argv.slice(1);
const p = {pid:process.pid,host:os.hostname(),platform:process.platform};
if (process.platform === 'linux') {
 p.boot = fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 const stat = fs.readFileSync('/proc/self/stat','utf8');
 p.start = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
 p.namespace = fs.readlinkSync('/proc/self/ns/pid');
}
fs.writeFileSync(marker+'.registered', JSON.stringify(p), {flag:'wx',mode:0o600});
fs.renameSync(marker+'.registered', marker);
const child = cp.spawn(file, JSON.parse(encoded), {stdio:'inherit'});
child.on('error', e => { console.error(e.message); process.exitCode=1; });
child.on('exit', (code, signal) => { if(signal) process.kill(process.pid,signal); else process.exitCode=code??1; });
`;
async function run(file: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; maxBuffer: number }) {
	const lock = lockContext.getStore();
	if (!lock) return rawRun(file, args, { ...options, encoding: "buffer" });
	const marker = join(lock, `child-${randomUUID()}.json`);
	await writeFile(marker, "pending", { flag: "wx", mode: 0o600 });
	try {
		// execFile silently ignores detached; use spawn to actually create the
		// guardian process group before it records its PID as the group ID.
		return await new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
			const child = spawn(process.execPath, ["-e", commandHelper, marker, file, JSON.stringify(args)], {
				cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [], stderr: Buffer[] = [];
			let size = 0, overflow = false;
			for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on("data", (data: Buffer) => {
				size += data.length;
				if (size <= options.maxBuffer) chunks.push(data);
				else if (!overflow) { overflow = true; child.kill("SIGTERM"); }
			});
			child.on("error", reject);
			child.on("close", (code, signal) => {
				const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
				if (code === 0 && !overflow) resolve(result);
				else reject(Object.assign(new Error(`Command failed: ${file} (${overflow ? "maxBuffer" : signal ?? code})\n${result.stderr.toString()}`), result, { code, signal }));
			});
		});
	} finally {
		try {
			if (await dead(JSON.parse(await readFile(marker, "utf8")), true)) await unlink(marker);
		} catch { /* An unregistered or still-running child keeps its lock. */ }
	}
}
async function childrenDead(path: string): Promise<boolean> {
	try {
		for (const name of await readdir(path)) {
			if (name === "owner.json") continue;
			if (!/^child-[a-f0-9-]+\.json$/.test(name) || !await dead(JSON.parse(await readFile(join(path, name), "utf8")), true)) return false;
		}
		return true;
	} catch { return false; }
}
async function lockOwner(path: string): Promise<LockOwner | undefined> {
	try {
		const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
		if (owner.version === 1 && typeof owner.token === "string" && /^[a-f0-9-]{36}$/.test(owner.token) && validIdentity(owner.process)) return owner;
	} catch { /* Incomplete/legacy/foreign locks require manual inspection. */ }
}

/** Cooperative local coordination, with permanent nonempty generation tombstones.
 * Every release/recovery renames to the SAME destination for that generation. A
 * second stale claimant cannot rename a successor over this nonempty directory.
 * No recovery guard can itself be stranded, and no successor directory is deleted.
 */
async function locked<T>(common: string, target: string, action: () => Promise<T>): Promise<T> {
	const parent = join(metadata(common), "locks");
	const retired = join(metadata(common), "retired-locks");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	await mkdir(retired, { recursive: true, mode: 0o700 });
	const path = join(parent, `${hash(target)}.lock`);
	const owner: LockOwner = { version: 1, token: randomUUID(), process: await processIdentity() };
	const retire = async (old: LockOwner) => {
		try { await rename(path, join(retired, old.token)); }
		catch (e: any) { if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(e.code)) throw e; }
	};
	const deadline = Date.now() + 5_000;
	for (;;) {
		try { await mkdir(path, { mode: 0o700 }); break; }
		catch (e: any) {
			if (e.code !== "EEXIST") throw e;
			const previous = await lockOwner(path);
			if (previous && await dead(previous.process) && await childrenDead(path)) {
				await retire(previous);
				if (Date.now() < deadline) continue;
			}
			if (Date.now() >= deadline) throw new Error(`Git lifecycle target is locked; live or unknown locks are never stolen: ${path}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	await writeFile(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
	try { return await lockContext.run(path, action); }
	finally {
		if ((await lockOwner(path))?.token === owner.token && await childrenDead(path)) await retire(owner);
	}
}
async function fetchTarget(s: GitWorkspace): Promise<string> {
	await git(s.repo, "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin",
		`+refs/heads/${s.baseBranch}:refs/remotes/origin/${s.baseBranch}`);
	return commit(s.repo, `refs/remotes/origin/${s.baseBranch}`);
}
async function saveState(common: string, record: RecordState): Promise<RecordState> {
	await mkdir(join(metadata(common), "states"), { recursive: true });
	try { await writeFile(stateFile(common, record.state), JSON.stringify(record), { flag: "wx" }); }
	catch (e: any) {
		if (e.code !== "EEXIST") throw e;
		const old = JSON.parse(await readFile(stateFile(common, record.state), "utf8")) as RecordState;
		if (old.version !== 1 || (record.workspace === "worktree" && old.id !== record.id) || old.workspace !== record.workspace || old.originUrl !== record.originUrl || old.gitDir !== record.gitDir ||
			stateKey(old.state) !== stateKey(record.state) || old.ownership !== record.ownership) throw new Error("Workspace ownership collision");
		return old; // Never replace an established baseline on a prepare retry.
	}
	return record;
}
export { git as lifecycleGit };

export class GitLifecycle {

	async prepare(options: PrepareOptions): Promise<GitWorkspace> {
		const { id, workspace } = options;
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid workspace id");
		if (workspace !== "direct" && workspace !== "worktree") throw new Error("Invalid workspace mode");
		const { repo, common } = await discover(options.cwd);
		const originUrl = await origin(repo);
		const advertised = options.baseBranch === undefined ? await git(repo, "ls-remote", "--symref", "origin", "HEAD") : "";
		const baseBranch = options.baseBranch ?? advertised.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1] ?? "main";
		await validBranch(repo, baseBranch);
		return locked(common, baseBranch, async () => {
			const tasks = join(metadata(common), "tasks");
			const taskFile = join(tasks, `${hash(id)}.json`);
			let cwd = repo;
			const taskBranch = workspace === "direct" ? await branch(repo) : `task/${id}`;
			if (workspace === "worktree") {
				const parent = options.worktreeRoot ?? join(dirname(repo), `${basename(repo)}-worktrees`);
				await mkdir(parent, { recursive: true });
				cwd = join(await realpath(parent), id);
			}
			if (await exists(taskFile)) {
				const record = JSON.parse(await readFile(taskFile, "utf8")) as RecordState;
				const s = record.state;
				if (record.version !== 1 || record.workspace !== workspace || record.id !== id || record.originUrl !== originUrl ||
					s.repo !== repo || s.cwd !== cwd || s.branch !== taskBranch || s.baseBranch !== baseBranch) throw new Error("Workspace ownership collision");
				await this.validate(s);
				return s;
			}
			if (workspace === "worktree") {
				if (await exists(cwd)) throw new Error(`Refusing unrecognized existing directory: ${cwd}`);
				if ((await git(repo, "for-each-ref", "--format=%(refname)", `refs/heads/${taskBranch}`)).trim()) throw new Error(`Refusing existing branch: ${taskBranch}`);
			}
			const state: GitWorkspace = { repo, devCwd: repo, cwd, branch: taskBranch, baseBranch, baseSha: "", remote: "origin", initialDirty: [] };
			state.baseSha = await fetchTarget(state);
			if (workspace === "worktree") {
				// No rollback deletion on failure: an interrupted preparation leaves evidence for inspection.
				await git(repo, "worktree", "add", "-b", taskBranch, "--", cwd, state.baseSha);
				await git(repo, "branch", `--set-upstream-to=origin/${baseBranch}`, "--", taskBranch);
				await clean(cwd);
			} else {
				if (taskBranch !== baseBranch || await branch(cwd) !== baseBranch) throw new Error("Direct workspace must be on baseBranch");
				if (await commit(cwd) !== state.baseSha) throw new Error("Direct workspace HEAD must equal fetched baseSha; preserving local commits");
				await inspectIndex(cwd);
				state.initialDirty = await dirty(cwd);
			}
			let record: RecordState = { version: 1, id, workspace, originUrl, gitDir: await gitDir(cwd), state };
			if (workspace === "worktree") {
				record.ownership = randomUUID();
				await writeFile(join(record.gitDir, "git-lifecycle-owner"), record.ownership, { flag: "wx" });
			}
			if (workspace === "direct") {
				if (await exists(stateFile(common, state))) {
					record = await saveState(common, record);
					await verifyDirty(record);
				} else await backupDirty(common, record);
			}
			record = await saveState(common, record);
			await mkdir(tasks, { recursive: true });
			await writeFile(taskFile, JSON.stringify({ ...record, id }), { flag: "wx" });
			return record.state;
		});
	}

	/** Ownership survives worktree removal, so recovery starts from the main repository. */
	private async stored(state: GitWorkspace): Promise<{ common: string; record: RecordState }> {
		const { repo, root, common } = await discover(state.repo);
		if (state.repo !== repo || root !== repo || state.devCwd !== repo || state.remote !== "origin" || !shaPattern.test(state.baseSha)) throw new Error("Workspace identity changed");
		const record = JSON.parse(await readFile(stateFile(common, state), "utf8")) as RecordState;
		if (record.version !== 1 || stateKey(record.state) !== stateKey(state) || await origin(repo) !== record.originUrl) throw new Error("Workspace identity changed");
		return { common, record };
	}

	private async validate(state: GitWorkspace): Promise<{ common: string; record: RecordState }> {
		const stored = await this.stored(state);
		const { repo, root, common } = await discover(state.cwd);
		const { record } = stored;
		if (state.repo !== repo || state.cwd !== root || common !== stored.common ||
			await gitDir(root) !== record.gitDir || await branch(root) !== state.branch) throw new Error("Workspace identity or branch changed");
		if (record.workspace === "worktree" && (!record.ownership ||
			await readFile(join(record.gitDir, "git-lifecycle-owner"), "utf8") !== record.ownership)) throw new Error("Workspace ownership changed");
		return { common, record };
	}

	async head(state: GitWorkspace): Promise<string> {
		await this.validate(state);
		return commit(state.cwd);
	}

	private async ready(state: GitWorkspace, record: RecordState, sha: string): Promise<void> {
		if (await this.head(state) !== sha) throw new Error("approvedSha must equal current HEAD");
		if (record.workspace === "worktree") return clean(state.cwd);
		await inspectIndex(state.cwd);
		await verifyDirty(record);
		const current = await dirty(state.cwd);
		if (current.some((path) => !state.initialDirty.some((initial) => overlaps(path, initial)))) throw new Error("New uncommitted changes in direct workspace");
		// Inspect every commit, including merge parents and reverted edits, not just the net diff.
		if (state.initialDirty.length) {
			const commits = (await git(state.cwd, "rev-list", `${state.baseSha}..${sha}`)).trim().split("\n").filter(Boolean);
			for (const change of commits) {
				const paths = (await git(state.cwd, "diff-tree", "--root", "-m", "-r", "--no-commit-id", "--no-renames", "--name-only", "-z", change)).split("\0").filter(Boolean);
				if (paths.some((path) => state.initialDirty.some((initial) => overlaps(path, initial)))) throw new Error("Changed commits touch initialDirty paths");
			}
		}
	}

	private async test(state: GitWorkspace, sha: string, argv: string[]): Promise<void> {
		if (!argv.length || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !argv[0]) throw new Error("test must be a nonempty argv array");
		const { common } = await discover(state.repo);
		// A stable, owned test directory prevents a retry/new SHA from forgetting
		// retained build artifacts. Never silently report done with leaked trees.
		const parent = join(metadata(common), "test-worktrees", hash(stateKey(state)));
		const cwd = join(parent, "worktree");
		await mkdir(parent, {recursive:true,mode:0o700});
		const ownerFile = join(parent,"owner.json"), identity = stateKey(state);
		if (await exists(ownerFile)) {
			if (await readFile(ownerFile,"utf8") !== identity) throw new Error(`Unknown test workspace ownership: ${parent}`);
		} else {
			if (await exists(cwd)) throw new Error(`Unknown test workspace: ${cwd}`);
			await writeFile(ownerFile,identity,{flag:"wx",mode:0o600});
		}
		if (await exists(cwd)) { await clean(cwd); await git(state.repo,"worktree","remove","--",cwd); }
		await git(state.repo, "worktree", "add", "--detach", "--", cwd, sha);
		try {
			if (await commit(cwd) !== sha) throw new Error("Test worktree SHA mismatch");
			await run(argv[0], argv.slice(1), { cwd, env: childEnv(), maxBuffer: 32 * 1024 * 1024 });
			if (await commit(cwd) !== sha) throw new Error("Tests changed the approved SHA");
		} finally {
			// Preserve test artifacts and cancellation edits too; never force-remove a dirty tree.
			try { await clean(cwd); await git(state.repo, "worktree", "remove", "--", cwd); await unlink(ownerFile); await rmdir(parent); }
			catch (error) { throw new Error(`Integration test worktree retained at ${cwd}; clean its artifacts explicitly before retry: ${String(error)}`); }
		}
	}

	private async updateDev(state: GitWorkspace, sha: string): Promise<boolean> {
		try {
			if (await branch(state.devCwd) !== state.baseBranch) return false;
			await clean(state.devCwd);
			if (!(await ancestor(state.repo, await commit(state.devCwd), sha))) return false;
			// Explicit --no-autostash and overwrite-ignore protection preserve local files.
			await git(state.devCwd, "-c", "merge.autostash=false", "merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", sha);
			return await commit(state.devCwd) === sha;
		} catch { return false; } // Push remains successful even if the dev worktree cannot be updated.
	}

	async integrate(state: GitWorkspace, options: IntegrateOptions): Promise<IntegrationResult> {
		if (options.workerActive) throw new Error("Worker is active");
		if (!shaPattern.test(options.approvedSha)) throw new Error("approvedSha must be a full commit SHA");
		const { common } = await this.validate(state);
		return locked(common, state.baseBranch, async () => {
			const { record } = await this.validate(state);
			const sha = options.approvedSha;
			await this.ready(state, record, sha);
			const baseline = await fetchTarget(state);
			// A previous push may have succeeded before its result was persisted. Remote
			// descendants count too: recovery must not rerun tests or push an older SHA.
			if (await ancestor(state.repo, sha, baseline)) return { status: "pushed", sha, devUpdated: await this.updateDev(state, sha) };
			if (!(await ancestor(state.repo, baseline, sha))) return { status: "needs_update", sha };
			if (options.test !== undefined) await this.test(state, sha, options.test);
			await this.ready(state, record, sha);
			let pushError: unknown;
			try {
				await git(state.repo, "-c", "remote.origin.mirror=false", "push", "--no-force", "--no-follow-tags", "--recurse-submodules=no", "origin", `${sha}:refs/heads/${state.baseBranch}`);
			} catch (e) { pushError = e; }
			// Also verify after errors: the server may have accepted a push before a lost response.
			if (await origin(state.repo) !== record.originUrl) throw new Error("Origin changed during push");
			const remoteHead = await fetchTarget(state);
			if (!(await ancestor(state.repo, sha, remoteHead))) {
				if (pushError && !(await ancestor(state.repo, remoteHead, sha))) return { status: "needs_update", sha };
				throw pushError ?? new Error("Remote does not include the approved SHA");
			}
			return { status: "pushed", sha, devUpdated: await this.updateDev(state, sha) };
		});
	}

	/** Materialize the exact object tree seen by integration; no replacement refs, grafts or worktree dirt. */
	async review<T>(state:GitWorkspace,sha:string,reviewer:(cwd:string)=>Promise<T>):Promise<T> {
		const {record}=await this.validate(state);
		await this.ready(state,record,sha);
		const parent=await mkdtemp(join(tmpdir(),"git-lifecycle-review-"));
		const cwd=join(parent,"worktree");
		await git(state.repo,"worktree","add","--detach","--",cwd,sha);
		try {return await reviewer(cwd);}
		finally {try{await clean(cwd);await git(state.repo,"worktree","remove","--",cwd);await rmdir(parent);}catch{/* Preserve unexpected artifacts, never force-remove. */}}
	}

	/** Publish the reviewed branch for PR CI, never update the target branch. */
	async publish(state: GitWorkspace, options: IntegrateOptions): Promise<IntegrationResult> {
		if (options.workerActive !== false) throw new Error("Worker must be stopped before PR publication");
		const { common } = await this.validate(state);
		return locked(common, state.baseBranch, async () => {
			const { record } = await this.validate(state);
			const sha = options.approvedSha;
			await this.ready(state,record,sha);
			if (record.workspace !== "worktree") throw new Error("PR requires an isolated task branch");
			const target = await fetchTarget(state);
			if (!(await ancestor(state.repo,target,sha))) return {status:"needs_update",sha};
			if (options.test) await this.test(state,sha,options.test);
			await this.ready(state,record,sha);
			const ref = `refs/heads/${state.branch}`;
			let error: unknown;
			try { await git(state.repo,"push","--no-force","--no-follow-tags","origin",`${sha}:${ref}`); } catch(e) { error=e; }
			const remote = (await git(state.repo,"ls-remote","--refs","origin",ref)).trim().split(/\s+/)[0];
			if (remote !== sha) throw error ?? new Error("PR branch publication is unconfirmed");
			return {status:"pushed",sha};
		});
	}

	/** No target mutation: verify externally merged PR and fast-forward only a safe dev tree. */
	async confirmMerged(state: GitWorkspace, options: {sha:string;workerActive:boolean}): Promise<IntegrationResult> {
		if (options.workerActive !== false) throw new Error("Worker is active");
		const {common} = await this.validate(state);
		return locked(common,state.baseBranch,async()=>{
			const {record} = await this.validate(state);
			await this.ready(state,record,options.sha);
			const target = await fetchTarget(state);
			if (!(await ancestor(state.repo,options.sha,target))) throw new Error("Remote target does not contain the reviewed SHA");
			return {status:"pushed",sha:options.sha,devUpdated:await this.updateDev(state,target)};
		});
	}

	async cleanup(state: GitWorkspace, options: { sha: string; workerActive: boolean }): Promise<void> {
		if (options.workerActive !== false) throw new Error("Worker must be stopped before cleanup");
		if (!shaPattern.test(options.sha)) throw new Error("Cleanup requires a full commit SHA");
		const { common } = await this.stored(state);
		await locked(common, state.baseBranch, async () => {
			const { record } = await this.stored(state);
			const receiptPath = cleanupFile(common, state);
			const hasReceipt = await exists(receiptPath);
			if (hasReceipt) {
				const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as CleanupReceipt;
				if (receipt.version !== 1 || stateKey(receipt.state) !== stateKey(state) || receipt.sha !== options.sha ||
					receipt.ownership !== record.ownership) throw new Error("Cleanup receipt identity or SHA changed");
			}
			const present = await exists(state.cwd);
			if (present) {
				await this.validate(state);
				if (await commit(state.cwd) !== options.sha) throw new Error("Cleanup SHA must equal HEAD; preserving new commits");
				if (record.workspace === "worktree") await clean(state.cwd);
			} else if (record.workspace !== "worktree" || !hasReceipt) {
				throw new Error("Missing workspace without cleanup receipt");
			}
			if (!(await ancestor(state.repo, options.sha, await fetchTarget(state)))) throw new Error("Cleanup SHA is not verified on remote");
			if (record.workspace === "direct") return; // Direct workspaces are never deleted or reset.
			if (present) {
				await clean(state.cwd);
				if (await this.head(state) !== options.sha) throw new Error("HEAD changed during cleanup");
				if (!hasReceipt) {
					// Publish the authorization atomically before either destructive step.
					await mkdir(dirname(receiptPath), { recursive: true });
					const receipt: CleanupReceipt = { version: 1, state, sha: options.sha, ownership: record.ownership! };
					const temporary = `${receiptPath}.${randomUUID()}.tmp`;
					await writeFile(temporary, JSON.stringify(receipt), { flag: "wx" });
					await rename(temporary, receiptPath);
				}
				await git(state.repo, "worktree", "remove", "--", state.cwd);
			} else {
				// Removal may have stopped after deleting files but before unregistering.
				const registered = (await worktrees(state.repo)).filter((w) => w.path === state.cwd);
				if (registered.length) {
					if (registered.length !== 1 || registered[0].branch !== `refs/heads/${state.branch}` || !record.ownership ||
						await readFile(join(record.gitDir, "git-lifecycle-owner"), "utf8") !== record.ownership ||
						await commit(state.repo, `refs/heads/${state.branch}`) !== options.sha) throw new Error("Workspace ownership or branch changed during cleanup");
					await git(state.repo, "worktree", "remove", "--", state.cwd);
				} else if (await exists(record.gitDir)) throw new Error("Unrecognized worktree metadata during cleanup");
			}
			// Both remove and branch -d may have succeeded before their responses were
			// lost. Only an unchanged surviving branch is eligible for deletion.
			try { await git(state.repo, "show-ref", "--verify", "--quiet", `refs/heads/${state.branch}`); }
			catch (e: any) { if (e.code === 1) return; throw e; }
			const branchSha = await commit(state.repo, `refs/heads/${state.branch}`);
			if (branchSha !== options.sha) throw new Error("Branch changed during cleanup; preserving branch");
			await git(state.repo, "branch", "-d", "--", state.branch);
		});
	}
}
