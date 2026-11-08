// quick-agent self-upgrade: version check (npm → GitHub Release → git), install, throttled background checks.
//
// Install kinds (detected from where the code lives, override with QA_INSTALL_KIND):
//   git         a git checkout (has .git)        → git fetch + fast-forward to upstream (or checkout the newest tag when detached)
//   npm-pi      `pi install npm:<pkg>` (~/.pi/agent/npm/…) → pi update npm:<pkg>
//   npm-global  `npm install -g <pkg>`            → npm install -g <pkg>@<version>
//   release     unpacked release tarball          → download the GitHub release, swap the directory (previous copy kept as <dir>.prev)
//
// Background checks are non-blocking, time-limited, silent on failure, throttled through
// ~/.quick-agent/update.json and serialised across processes with ~/.quick-agent/update.lock.
// Zero dependencies (plain Node + git/npm/tar on PATH).
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { githubSlug, loadConfig, paths, REPO_ROOT, type UpdateConfig } from "./config.ts";

const run = promisify(execFile);
const FETCH_TIMEOUT_MS = 8_000;
const GIT_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;

export const STATE_PATH = join(paths.home, "update.json");
const LOCK_PATH = join(paths.home, "update.lock");

/** Directory being upgraded (the running code, unless QA_UPDATE_ROOT points elsewhere – used by tests). */
export function updateRoot(): string {
	return process.env.QA_UPDATE_ROOT ?? REPO_ROOT;
}

export type InstallKind = "git" | "npm-pi" | "npm-global" | "release";
export type SourceName = "npm" | "github" | "git";

export interface Latest {
	source: SourceName;
	version: string;
	/** git: tag to check out (detached installs). */
	tag?: string;
	/** github/npm: tarball to download (release installs). */
	tarball?: string;
	url?: string;
}

export interface GitInfo {
	head: string;
	branch?: string;
	upstream?: string;
	behind: number;
	ahead: number;
	dirty: boolean;
	upstreamVersion?: string;
	latestTag?: string;
	fetchError?: string;
}

export interface CheckResult {
	root: string;
	kind: InstallKind;
	current: string;
	latest?: Latest;
	tried: { source: SourceName; ok: boolean; version?: string; error?: string }[];
	git?: GitInfo;
	/** A newer version (or newer upstream commits for git installs) exists. */
	available: boolean;
	/** Why it cannot be installed automatically (dirty tree, local commits, …). */
	blocker?: string;
}

export interface UpgradeResult extends CheckResult {
	machine?: string;
	checkOnly: boolean;
	installed: boolean;
	ok: boolean;
	from: string;
	to: string;
	error?: string;
	/** What happens next (hub restart, /reload, …). */
	note?: string;
}

export interface UpdateState {
	checkedAt?: number;
	current?: string;
	latest?: string;
	source?: SourceName;
	available?: boolean;
	error?: string;
	installed?: { from: string; to: string; at: number; kind: InstallKind; head?: string };
	hintedAt?: number;
}

// ---------------------------------------------------------------- versions

export function readVersion(root = updateRoot()): string {
	try {
		return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0");
	} catch {
		return "0.0.0";
	}
}

function readPkgName(root = updateRoot()): string | undefined {
	try {
		return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
	} catch {
		return undefined;
	}
}

/** Compare semver strings (leading "v" allowed). Pre-releases sort before the release. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core = "", pre] = v.trim().replace(/^v/i, "").split("+")[0]!.split(/-(.*)/s);
		return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d) return Math.sign(d);
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	const xs = x.pre.split(".");
	const ys = y.pre.split(".");
	for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
		const p = xs[i];
		const q = ys[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
		if (pn !== qn) return pn ? -1 : 1;
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

export function isSemver(v: string): boolean {
	return /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v.trim());
}

function maxVersion(list: string[]): string | undefined {
	return list.filter(isSemver).sort(compareVersions).at(-1);
}

// ---------------------------------------------------------------- install detection

function piAgentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function detectInstall(root = updateRoot()): InstallKind {
	const forced = process.env.QA_INSTALL_KIND as InstallKind | undefined;
	if (forced && ["git", "npm-pi", "npm-global", "release"].includes(forced)) return forced;
	if (existsSync(join(root, ".git"))) return "git";
	if (root.includes(`${sep}node_modules${sep}`)) return root.startsWith(piAgentDir() + sep) ? "npm-pi" : "npm-global";
	return "release";
}

// ---------------------------------------------------------------- helpers

const gitEnv = () => ({
	...process.env,
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new",
});

async function git(root: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
	const { stdout } = await run("git", args, { cwd: root, timeout, env: gitEnv(), maxBuffer: 8 * 1024 * 1024 });
	return stdout.trim();
}

let ghTokenCache: string | undefined | null = null;
async function githubToken(): Promise<string | undefined> {
	if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (ghTokenCache !== null) return ghTokenCache;
	try {
		ghTokenCache = (await run("gh", ["auth", "token"], { timeout: 4000 })).stdout.trim() || undefined;
	} catch {
		ghTokenCache = undefined;
	}
	return ghTokenCache;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
	const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

// ---------------------------------------------------------------- sources

async function fromNpm(s: UpdateConfig): Promise<Latest> {
	const name = s.npmPackage.replace("/", "%2F");
	const doc = await getJson(`${s.npmRegistry}/${name}/latest`);
	if (!doc?.version) throw new Error("no version in registry response");
	// Do not trust a same-named package from someone else: its repository must be ours.
	const repo = githubSlug(typeof doc.repository === "string" ? doc.repository : doc.repository?.url);
	if (s.githubRepo && repo?.toLowerCase() !== s.githubRepo.toLowerCase()) {
		throw new Error(`npm package ${s.npmPackage} belongs to ${repo ?? "an unknown repository"}, not ${s.githubRepo}; ignored`);
	}
	return { source: "npm", version: String(doc.version), tarball: doc.dist?.tarball };
}

async function fromGithub(s: UpdateConfig): Promise<Latest> {
	if (!s.githubRepo) throw new Error("update.githubRepo not configured");
	const token = await githubToken();
	const rel = await getJson(`${s.githubApi}/repos/${s.githubRepo}/releases/latest`, {
		accept: "application/vnd.github+json",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	});
	const tag = String(rel?.tag_name ?? "");
	if (!isSemver(tag)) throw new Error(`latest release tag "${tag}" is not a version`);
	// Prefer an `npm pack` asset (*.tgz), fall back to GitHub's source tarball.
	const asset = (rel.assets ?? []).find((a: any) => /\.tgz$/.test(String(a?.name)));
	return { source: "github", version: tag.replace(/^v/i, ""), tag, tarball: asset ? (asset.url ?? asset.browser_download_url) : rel.tarball_url, url: rel.html_url };
}

export async function gitInfo(root: string): Promise<GitInfo> {
	let fetchError: string | undefined;
	try {
		await git(root, ["fetch", "--quiet", "--tags", "--prune"]);
	} catch (e) {
		fetchError = shortErr(e);
	}
	const head = await git(root, ["rev-parse", "HEAD"]);
	const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined);
	const upstream = branch ? await git(root, ["rev-parse", "--abbrev-ref", "@{u}"]).catch(() => undefined) : undefined;
	let behind = 0;
	let ahead = 0;
	let upstreamVersion: string | undefined;
	if (upstream) {
		const [a, b] = (await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).split(/\s+/).map(Number);
		ahead = a ?? 0;
		behind = b ?? 0;
		upstreamVersion = await git(root, ["show", "@{u}:package.json"]).then((t) => JSON.parse(t).version as string).catch(() => undefined);
	}
	const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
	const latestTag = maxVersion((await git(root, ["tag", "-l"]).catch(() => "")).split("\n"));
	return { head, branch, upstream, behind, ahead, dirty, upstreamVersion, latestTag, fetchError };
}

async function fromGit(s: UpdateConfig, root: string, kind: InstallKind, info?: GitInfo): Promise<Latest> {
	if (kind === "git" && info) {
		if (info.fetchError) throw new Error(`git fetch failed: ${info.fetchError}`);
		const candidates = [info.upstreamVersion, info.latestTag].filter((v): v is string => !!v && isSemver(v));
		const version = maxVersion(candidates);
		if (!version) throw new Error("no upstream branch or version tags");
		return { source: "git", version: version.replace(/^v/i, ""), tag: info.latestTag && compareVersions(info.latestTag, version) === 0 ? info.latestTag : undefined };
	}
	if (!s.gitUrl) throw new Error("update.gitUrl not configured");
	const out = await git(root, ["ls-remote", "--tags", "--refs", s.gitUrl]);
	const tags = out.split("\n").map((l) => l.split("refs/tags/")[1] ?? "");
	const tag = maxVersion(tags);
	if (!tag) throw new Error(`no version tags in ${s.gitUrl}`);
	return { source: "git", version: tag.replace(/^v/i, ""), tag };
}

function shortErr(e: unknown): string {
	const err = e as { stderr?: string; message?: string };
	return (String(err.stderr ?? "").trim() || String(err.message ?? e)).split("\n")[0]!.slice(0, 200);
}

// ---------------------------------------------------------------- check

export async function checkForUpdate(s: UpdateConfig = loadConfig().update, root = updateRoot()): Promise<CheckResult> {
	const kind = detectInstall(root);
	const current = readVersion(root);
	const tried: CheckResult["tried"] = [];
	const git = kind === "git" ? await gitInfo(root).catch((e) => ({ error: shortErr(e) })) : undefined;
	const gi = git && "head" in git ? git : undefined;
	let latest: Latest | undefined;
	for (const source of s.sources) {
		try {
			const l = source === "npm" ? await fromNpm(s) : source === "github" ? await fromGithub(s) : await fromGit(s, root, kind, gi);
			tried.push({ source, ok: true, version: l.version });
			latest = l;
			break;
		} catch (e) {
			tried.push({ source, ok: false, error: shortErr(e) });
		}
	}
	const newer = !!latest && compareVersions(latest.version, current) > 0;
	let available = newer;
	let blocker: string | undefined;
	if (kind === "git") {
		if (!gi) blocker = `git error: ${(git as { error: string }).error}`;
		else {
			if (gi.behind > 0) available = true;
			if (gi.dirty) blocker = "工作区有未提交的改动";
			else if (gi.branch && !gi.upstream) blocker = `分支 ${gi.branch} 没有上游分支`;
			else if (gi.upstream && gi.ahead > 0 && gi.behind > 0) blocker = `本地分支与 ${gi.upstream} 已分叉（领先 ${gi.ahead}，落后 ${gi.behind}）`;
			else if (gi.upstream && newer && gi.behind === 0) blocker = `上游 ${gi.upstream} 尚无 ${latest!.version}（git 安装按上游分支升级）`;
			else if (!gi.branch && newer && !(gi.latestTag && compareVersions(gi.latestTag, current) > 0)) blocker = "HEAD 处于分离状态，且没有更新的版本 tag";
		}
	} else if (newer && kind === "release" && !latest?.tarball) blocker = `来源 ${latest?.source} 没有可下载的发布包`;
	return { root, kind, current, latest, tried, git: gi, available, blocker: available ? blocker : undefined };
}

// ---------------------------------------------------------------- install

async function installGit(root: string, c: CheckResult): Promise<void> {
	const gi = c.git!;
	if (gi.branch) {
		await git(root, ["merge", "--ff-only", "--quiet", "@{u}"], INSTALL_TIMEOUT_MS);
		return;
	}
	await git(root, ["checkout", "--quiet", gi.latestTag!], INSTALL_TIMEOUT_MS);
}

async function download(url: string, file: string) {
	const token = /api\.github\.com|github\.com/.test(url) ? await githubToken() : undefined;
	const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
	if (/\/releases\/assets\/\d+/.test(url)) headers.accept = "application/octet-stream";
	const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Release install: unpack the new version next to the current directory, then swap them. */
async function installRelease(root: string, c: CheckResult): Promise<void> {
	const tmp = mkdtempSync(join(dirname(root), `.${basename(root)}-upgrade-`));
	try {
		const tgz = join(tmp, "pkg.tgz");
		await download(c.latest!.tarball!, tgz);
		const out = join(tmp, "x");
		mkdirSync(out);
		await run("tar", ["-xzf", tgz, "-C", out], { timeout: INSTALL_TIMEOUT_MS });
		const dirs = readdirSync(out).map((d) => join(out, d)).filter((d) => statSync(d).isDirectory());
		const pkgDir = dirs.find((d) => existsSync(join(d, "package.json")));
		if (!pkgDir) throw new Error("release archive has no package.json");
		const name = readPkgName(pkgDir);
		if (name !== readPkgName(root)) throw new Error(`release archive contains ${name}, expected ${readPkgName(root)}`);
		const version = readVersion(pkgDir);
		if (compareVersions(version, c.current) <= 0) throw new Error(`release archive is version ${version}, not newer than ${c.current}`);
		const prev = `${root}.prev`;
		rmSync(prev, { recursive: true, force: true });
		renameSync(root, prev);
		try {
			renameSync(pkgDir, root);
		} catch (e) {
			renameSync(prev, root);
			throw e;
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function installNpm(kind: InstallKind, s: UpdateConfig, c: CheckResult): Promise<void> {
	if (kind === "npm-pi") await run("pi", ["update", `npm:${s.npmPackage}`], { timeout: INSTALL_TIMEOUT_MS, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	else await run("npm", ["install", "-g", `${s.npmPackage}@${c.latest?.source === "npm" ? c.latest.version : "latest"}`], { timeout: INSTALL_TIMEOUT_MS });
}

/** Install the update found by `checkForUpdate`. Throws on failure. Returns the new version. */
export async function installUpdate(c: CheckResult, s: UpdateConfig = loadConfig().update): Promise<string> {
	if (!c.available) return c.current;
	if (c.blocker) throw new Error(c.blocker);
	if (c.kind === "git") await installGit(c.root, c);
	else if (c.kind === "release") await installRelease(c.root, c);
	else await installNpm(c.kind, s, c);
	const to = readVersion(c.root);
	const head = c.kind === "git" ? await git(c.root, ["rev-parse", "HEAD"]).catch(() => undefined) : undefined;
	if (to === c.current && (c.kind !== "git" || head === c.git?.head)) throw new Error(`安装命令已执行，但版本仍为 ${to}（npm 安装是否锁定了版本？）`);
	patchState({ installed: { from: c.current, to, at: Date.now(), kind: c.kind, head } });
	return to;
}

// ---------------------------------------------------------------- state + lock

export function readState(): UpdateState {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8"));
	} catch {
		return {};
	}
}

export function patchState(patch: Partial<UpdateState>): UpdateState {
	const next = { ...readState(), ...patch };
	try {
		mkdirSync(paths.home, { recursive: true });
		writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
	} catch {}
	return next;
}

function pidAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Cross-process lock. Returns a release function, or undefined when someone else holds it. */
export function acquireLock(): (() => void) | undefined {
	mkdirSync(paths.home, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(LOCK_PATH, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
			closeSync(fd);
			return () => rmSync(LOCK_PATH, { force: true });
		} catch {
			try {
				const l = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
				if (Date.now() - l.at < LOCK_STALE_MS && pidAlive(l.pid)) return undefined;
			} catch {}
			rmSync(LOCK_PATH, { force: true }); // stale
		}
	}
	return undefined;
}

// ---------------------------------------------------------------- entry points

/** Explicit upgrade (`quick upgrade`, mesh `update.run`). Never throws. */
export async function runUpgrade(opts: { check?: boolean; machine?: string } = {}): Promise<UpgradeResult> {
	const s = loadConfig().update;
	const root = updateRoot();
	const base = { root, kind: detectInstall(root), current: readVersion(root), tried: [], available: false };
	const fail = (error: string, c: CheckResult = base): UpgradeResult => ({ ...c, machine: opts.machine, checkOnly: !!opts.check, installed: false, ok: false, from: c.current, to: c.current, error });
	let release = acquireLock();
	for (let i = 0; !release && i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		release = acquireLock();
	}
	if (!release) return fail("另一个升级正在进行中");
	try {
		const c = await checkForUpdate(s, root);
		patchState({ checkedAt: Date.now(), current: c.current, latest: c.latest?.version, source: c.latest?.source, available: c.available, error: c.latest ? undefined : c.tried.map((t) => `${t.source}: ${t.error}`).join("; ") });
		if (!c.latest && !c.available) return fail(`所有版本来源都不可用: ${c.tried.map((t) => `${t.source}: ${t.error}`).join("; ")}`, c);
		const out: UpgradeResult = { ...c, machine: opts.machine, checkOnly: !!opts.check, installed: false, ok: true, from: c.current, to: c.current };
		if (opts.check || !c.available) return out;
		try {
			out.to = await installUpdate(c, s);
			out.installed = true;
			patchState({ current: out.to, available: false });
		} catch (e) {
			out.ok = false;
			out.error = shortErr(e);
		}
		return out;
	} finally {
		release();
	}
}

/**
 * Background check at startup (hub / pi / CLI). Throttled by `intervalHours`, time-limited, silent on failure.
 * Returns the upgrade result only when something was installed.
 */
export async function autoUpdate(opts: { trigger: string; log?: (m: string) => void } = { trigger: "?" }): Promise<UpgradeResult | undefined> {
	try {
		const s = loadConfig().update;
		if (!s.enabled || !dueForCheck(s)) return undefined;
		const release = acquireLock();
		if (!release) return undefined;
		let c: CheckResult;
		try {
			c = await checkForUpdate(s);
			patchState({ checkedAt: Date.now(), current: c.current, latest: c.latest?.version, source: c.latest?.source, available: c.available, error: c.latest ? undefined : c.tried.map((t) => `${t.source}: ${t.error}`).join("; ") });
			if (!c.available || !s.autoInstall || c.blocker) {
				if (c.available) opts.log?.(`[update] ${c.current} → ${c.latest?.version ?? "upstream"} available${c.blocker ? ` (not installed: ${c.blocker})` : ""}`);
				return undefined;
			}
			const to = await installUpdate(c, s);
			patchState({ current: to, available: false });
			opts.log?.(`[update] upgraded quick-agent ${c.current} → ${to} (${c.kind}, via ${opts.trigger})`);
			return { ...c, checkOnly: false, installed: true, ok: true, from: c.current, to };
		} finally {
			release();
		}
	} catch (e) {
		patchState({ checkedAt: Date.now(), error: shortErr(e) });
		opts.log?.(`[update] check failed: ${shortErr(e)}`);
		return undefined;
	}
}

export function dueForCheck(s: UpdateConfig = loadConfig().update): boolean {
	const st = readState();
	return !st.checkedAt || Date.now() - st.checkedAt >= s.intervalHours * 3600_000;
}

export function describeSources(tried: CheckResult["tried"]): string {
	return tried.map((t) => (t.ok ? `${t.source} ✓ ${t.version}` : `${t.source} ✕ ${t.error}`)).join(" · ");
}
