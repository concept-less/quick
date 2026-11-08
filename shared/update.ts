// quick-agent self-upgrade, based on GitHub Releases.
//
// Install kinds (detected from where the running code lives, override with QA_INSTALL_KIND):
//   release     ~/.quick-agent/app/<version>/ with `current` → active version (install.sh, `quick upgrade`)
//               → download the release tarball, verify SHA256SUMS, unpack next to it, swap `current` atomically,
//                 keep `previous` for `quick upgrade --rollback`.
//   dev         a git checkout (has .git): development mode, never upgraded automatically — only a hint.
//   npm-pi      `pi install npm:<pkg>` → pi update npm:<pkg>          (optional; only if published to npm)
//   npm-global  `npm install -g <pkg>` → npm install -g <pkg>@<version>
//   unmanaged   anything else (e.g. a copy inside the desktop app): hint only.
//
// Lookups are cached in ~/.quick-agent/update.json (update.cacheMinutes), time-limited and silent on failure.
// Installs are serialised across processes with ~/.quick-agent/update.lock. Zero dependencies (Node + tar).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { loadConfig, paths, REPO_ROOT, type UpdateConfig } from "./config.ts";

const run = promisify(execFile);
const FETCH_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;
/** Versions kept in the app directory besides current/previous. */
const KEEP_EXTRA = 1;

export const STATE_PATH = join(paths.home, "update.json");
const LOCK_PATH = join(paths.home, "update.lock");

export type InstallKind = "release" | "dev" | "npm-pi" | "npm-global" | "unmanaged";
export const KIND_LABEL: Record<InstallKind, string> = { release: "Release 安装", dev: "开发模式（git 副本）", "npm-pi": "pi npm 包", "npm-global": "npm 全局安装", unmanaged: "未托管的副本" };

export interface ReleaseAsset {
	name: string;
	/** Direct download URL (browser_download_url). */
	download: string;
	/** API URL (works for private repos with a token). */
	api?: string;
	size?: number;
}

export interface ReleaseInfo {
	source: "github" | "npm";
	version: string;
	tag?: string;
	name?: string;
	/** Release notes (markdown). */
	notes?: string;
	url?: string;
	publishedAt?: string;
	assets: ReleaseAsset[];
	/** npm: tarball URL. */
	tarball?: string;
}

export interface UpdateStatus {
	machine?: string;
	kind: InstallKind;
	/** Directory of the running code. */
	root: string;
	/** Version on disk that a restart would run (release: app/current). */
	installed: string;
	latest?: ReleaseInfo;
	/** latest > installed. */
	available: boolean;
	/** An available update can be installed by `quick upgrade` / the UI button. */
	canInstall: boolean;
	/** Why it cannot be installed (dev checkout, …). */
	blocker?: string;
	/** Rollback target (release installs). */
	previous?: string;
	checkedAt?: number;
	error?: string;
	autoInstall: boolean;
}

export type Step = "check" | "download" | "verify" | "switch" | "restart" | "done" | "error";
export interface Progress {
	step: Step;
	received?: number;
	total?: number;
	message?: string;
}

export interface UpgradeResult {
	machine?: string;
	kind: InstallKind;
	root: string;
	checkOnly: boolean;
	available: boolean;
	installed: boolean;
	ok: boolean;
	from: string;
	to: string;
	latest?: string;
	notes?: string;
	url?: string;
	blocker?: string;
	error?: string;
	/** What happens next (hub restart, …). */
	note?: string;
}

export interface UpdateState {
	checkedAt?: number;
	latest?: ReleaseInfo;
	error?: string;
	installed?: { from: string; to: string; at: number; kind: InstallKind };
}

// ---------------------------------------------------------------- versions

/** Directory of the running code (QA_UPDATE_ROOT overrides it – tests). */
export function updateRoot(): string {
	return process.env.QA_UPDATE_ROOT ?? REPO_ROOT;
}

export function readVersion(root = updateRoot()): string {
	try {
		return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0");
	} catch {
		return "0.0.0";
	}
}

function readPkgName(root: string): string | undefined {
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

// ---------------------------------------------------------------- install layout

/** realpath that also works for paths that no longer exist (resolves the nearest existing parent),
 *  so e.g. /var/… vs /private/var/… on macOS still compare equal after a version dir was pruned. */
const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		const d = dirname(p);
		return d === p ? p : join(real(d), basename(p));
	}
};

export function appDir(): string {
	return paths.app;
}

export function detectInstall(root = updateRoot()): InstallKind {
	const forced = process.env.QA_INSTALL_KIND as InstallKind | undefined;
	if (forced && forced in KIND_LABEL) return forced;
	const r = real(root);
	if (existsSync(appDir()) && r.startsWith(real(appDir()) + sep)) return "release";
	if (existsSync(join(root, ".git"))) return "dev";
	const pi = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	if (r.includes(`${sep}node_modules${sep}`)) return r.startsWith(real(pi) + sep) ? "npm-pi" : "npm-global";
	return "unmanaged";
}

function linkTarget(name: "current" | "previous"): string | undefined {
	try {
		return readlinkSync(join(appDir(), name));
	} catch {
		return undefined;
	}
}

/** Root of the code a restart would launch: app/current for release installs, else the running code. */
export function activeRoot(root = updateRoot()): string {
	if (detectInstall(root) === "release" && linkTarget("current")) return real(join(appDir(), "current"));
	return root;
}

/** Versions unpacked in the app directory. */
export function listVersions(): string[] {
	try {
		return readdirSync(appDir()).filter(isSemver).sort(compareVersions);
	} catch {
		return [];
	}
}

/** Atomically point `<app>/<name>` at `<app>/<version>` (symlink + rename). */
function setLink(name: "current" | "previous", version: string) {
	const tmp = join(appDir(), `.${name}-${process.pid}-${Date.now()}`);
	symlinkSync(version, tmp);
	renameSync(tmp, join(appDir(), name));
}

/** Make `version` current; the version that was current becomes `previous`. Returns the old current. */
export function switchTo(version: string): string | undefined {
	if (!existsSync(join(appDir(), version, "package.json"))) throw new Error(`version ${version} is not installed in ${appDir()}`);
	const old = linkTarget("current");
	setLink("current", version);
	if (old && old !== version) setLink("previous", old);
	return old;
}

/** Switch back to `previous`. Returns [from, to]. */
export function rollback(): [string, string] {
	const prev = linkTarget("previous");
	const cur = linkTarget("current");
	if (!prev || !existsSync(join(appDir(), prev, "package.json"))) throw new Error("没有可回滚的上一个版本");
	switchTo(prev);
	return [cur ?? "?", prev];
}

/** Delete old unpacked versions, keeping current, previous and KEEP_EXTRA more. */
function prune() {
	const keep = new Set([linkTarget("current"), linkTarget("previous")]);
	const rest = listVersions().filter((v) => !keep.has(v));
	for (const v of rest.slice(0, Math.max(0, rest.length - KEEP_EXTRA))) rmSync(join(appDir(), v), { recursive: true, force: true });
}

// ---------------------------------------------------------------- release lookup

let ghTokenCache: string | undefined | null = null;
async function githubToken(allowGh: boolean): Promise<string | undefined> {
	if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!allowGh) return undefined;
	if (ghTokenCache !== null) return ghTokenCache;
	try {
		ghTokenCache = (await run("gh", ["auth", "token"], { timeout: 4000 })).stdout.trim() || undefined;
	} catch {
		ghTokenCache = undefined;
	}
	return ghTokenCache;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<any> {
	const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

/** Latest (non-prerelease) GitHub release of `update.githubRepo`. */
export async function fetchLatestRelease(s: UpdateConfig, opts: { timeoutMs?: number; quick?: boolean } = {}): Promise<ReleaseInfo> {
	if (!s.githubRepo) throw new Error("update.githubRepo not configured");
	// Unauthenticated works for public repos; a token raises the rate limit / opens private repos.
	const token = await githubToken(!opts.quick);
	const rel = await getJson(
		`${s.githubApi}/repos/${s.githubRepo}/releases/latest`,
		{ accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		opts.timeoutMs ?? FETCH_TIMEOUT_MS,
	);
	const tag = String(rel?.tag_name ?? "");
	if (!isSemver(tag)) throw new Error(`latest release tag "${tag}" is not a version`);
	return {
		source: "github",
		version: tag.replace(/^v/i, ""),
		tag,
		name: rel.name || tag,
		notes: typeof rel.body === "string" ? rel.body.slice(0, 20_000) : undefined,
		url: rel.html_url,
		publishedAt: rel.published_at,
		assets: (rel.assets ?? []).map((a: any) => ({ name: String(a.name), download: String(a.browser_download_url ?? a.url), api: a.url, size: a.size })),
	};
}

async function fetchLatestNpm(s: UpdateConfig, timeoutMs = FETCH_TIMEOUT_MS): Promise<ReleaseInfo> {
	const doc = await getJson(`${s.npmRegistry}/${s.npmPackage.replace("/", "%2F")}/latest`, {}, timeoutMs);
	if (!doc?.version) throw new Error("no version in registry response");
	return { source: "npm", version: String(doc.version), tarball: doc.dist?.tarball, assets: [] };
}

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
		const tmp = `${STATE_PATH}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
		renameSync(tmp, STATE_PATH);
	} catch {}
	return next;
}

/**
 * Latest release, served from the shared cache when it is younger than `maxAgeMs`
 * (default update.cacheMinutes). Falls back to the stale cache when the lookup fails.
 */
export async function getLatest(
	s: UpdateConfig = loadConfig().update,
	opts: { maxAgeMs?: number; timeoutMs?: number; quick?: boolean; kind?: InstallKind } = {},
): Promise<{ latest?: ReleaseInfo; checkedAt?: number; error?: string; cached: boolean }> {
	const st = readState();
	const maxAge = opts.maxAgeMs ?? s.cacheMinutes * 60_000;
	if (st.checkedAt && Date.now() - st.checkedAt < maxAge && (st.latest || st.error)) return { latest: st.latest, checkedAt: st.checkedAt, error: st.error, cached: true };
	const kind = opts.kind ?? detectInstall();
	try {
		const latest = kind === "npm-pi" || kind === "npm-global" ? await fetchLatestNpm(s, opts.timeoutMs) : await fetchLatestRelease(s, opts);
		const checkedAt = Date.now();
		patchState({ checkedAt, latest, error: undefined });
		return { latest, checkedAt, cached: false };
	} catch (e) {
		const error = shortErr(e);
		// Keep the last good answer; remember the failure so we do not hammer the API.
		patchState({ checkedAt: Date.now(), error });
		return { latest: st.latest, checkedAt: st.checkedAt, error, cached: false };
	}
}

function blockerFor(kind: InstallKind, latest: ReleaseInfo | undefined, s: UpdateConfig): string | undefined {
	if (kind === "dev") return "开发模式（git 副本）不自动更新：git pull，或运行 install.sh 切换到 Release 安装";
	if (kind === "unmanaged") return "这份代码不是 Release 安装：运行 install.sh 切换到 Release 安装";
	if (kind === "release" && latest) {
		if (!findTarball(latest)) return `Release ${latest.tag ?? latest.version} 没有安装包（quick-agent-${latest.version}.tgz）`;
		if (s.requireChecksum && !latest.assets.some((a) => a.name === "SHA256SUMS")) return `Release ${latest.tag ?? latest.version} 没有 SHA256SUMS`;
	}
	return undefined;
}

/** Update status of this machine (network only when the cache is stale or `refresh`). Never throws. */
export async function updateStatus(opts: { refresh?: boolean; quick?: boolean; timeoutMs?: number; machine?: string } = {}): Promise<UpdateStatus> {
	const s = loadConfig().update;
	const root = updateRoot();
	const kind = detectInstall(root);
	const installed = readVersion(activeRoot(root));
	const r = await getLatest(s, { maxAgeMs: opts.refresh ? 0 : undefined, quick: opts.quick, timeoutMs: opts.timeoutMs, kind });
	const available = !!r.latest && compareVersions(r.latest.version, installed) > 0;
	const blocker = available ? blockerFor(kind, r.latest, s) : undefined;
	const prev = kind === "release" ? linkTarget("previous") : undefined;
	return {
		machine: opts.machine,
		kind,
		root,
		installed,
		latest: r.latest,
		available,
		canInstall: available && !blocker,
		blocker,
		previous: prev && existsSync(join(appDir(), prev, "package.json")) ? prev : undefined,
		checkedAt: r.checkedAt,
		error: r.error,
		autoInstall: s.autoInstall,
	};
}

/** One-line hint for the CLI, or undefined. */
export function hintLine(st: UpdateStatus): string | undefined {
	if (!st.available || !st.latest) return undefined;
	const v = `v${st.latest.version}`;
	if (st.kind === "dev") return `new version ${v} available (dev checkout: git pull, or install.sh for a release install)`;
	if (st.kind === "unmanaged") return `new version ${v} available (install.sh)`;
	return `new version ${v} available: quick upgrade`;
}

// ---------------------------------------------------------------- install

export function findTarball(rel: ReleaseInfo): ReleaseAsset | undefined {
	return rel.assets.find((a) => a.name === `quick-agent-${rel.version}.tgz`) ?? rel.assets.find((a) => /^quick-agent-[\d.]+.*\.tgz$/.test(a.name));
}

async function fetchAsset(a: ReleaseAsset, timeoutMs = INSTALL_TIMEOUT_MS): Promise<Response> {
	const token = /github\.com/.test(a.download) || /api\.github\.com/.test(a.api ?? "") ? await githubToken(true) : undefined;
	// Public repos: the browser URL needs no token. With a token, the API URL also works for private repos.
	const useApi = !!token && !!a.api && /\/releases\/assets\/\d+/.test(a.api);
	const res = await fetch(useApi ? a.api! : a.download, {
		headers: { ...(useApi ? { accept: "application/octet-stream" } : {}), ...(token && useApi ? { authorization: `Bearer ${token}` } : {}) },
		redirect: "follow",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${a.name}`);
	return res;
}

/** Stream an asset to `file`, reporting progress; returns its sha256 (hex). */
async function download(a: ReleaseAsset, file: string, onProgress?: (p: Progress) => void): Promise<string> {
	const res = await fetchAsset(a);
	const total = Number(res.headers.get("content-length")) || a.size || undefined;
	const hash = createHash("sha256");
	const out = createWriteStream(file);
	let received = 0;
	let last = 0;
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			hash.update(chunk);
			received += chunk.length;
			if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
			if (Date.now() - last > 200) {
				last = Date.now();
				onProgress?.({ step: "download", received, total });
			}
		}
	} finally {
		await new Promise((r) => out.end(r));
	}
	onProgress?.({ step: "download", received, total: total ?? received });
	return hash.digest("hex");
}

/** Parse `sha256sum` output ("<hex>  <name>" or "<hex> *<name>"). */
export function parseSums(text: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const line of text.split("\n")) {
		const x = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
		if (x) m.set(x[2]!, x[1]!.toLowerCase());
	}
	return m;
}

/**
 * Release install: download quick-agent-<v>.tgz, verify it against SHA256SUMS, unpack to <app>/<v>,
 * then swap `current` atomically (old version → `previous`). Returns the installed version.
 */
export async function installRelease(rel: ReleaseInfo, opts: { onProgress?: (p: Progress) => void; requireChecksum?: boolean } = {}): Promise<string> {
	const p = opts.onProgress ?? (() => {});
	const asset = findTarball(rel);
	if (!asset) throw new Error(`release ${rel.tag ?? rel.version} has no quick-agent-*.tgz asset`);
	mkdirSync(appDir(), { recursive: true });
	const tmp = mkdtempSync(join(appDir(), ".tmp-"));
	try {
		const tgz = join(tmp, asset.name);
		p({ step: "download", received: 0, total: asset.size });
		const sha = await download(asset, tgz, p);
		p({ step: "verify" });
		const sumsAsset = rel.assets.find((a) => a.name === "SHA256SUMS");
		if (sumsAsset) {
			const expected = parseSums(await (await fetchAsset(sumsAsset, FETCH_TIMEOUT_MS)).text()).get(asset.name);
			if (!expected) throw new Error(`SHA256SUMS does not list ${asset.name}`);
			if (expected !== sha) throw new Error(`checksum mismatch for ${asset.name}: expected ${expected.slice(0, 12)}…, got ${sha.slice(0, 12)}…`);
		} else if (opts.requireChecksum ?? true) throw new Error(`release ${rel.tag ?? rel.version} has no SHA256SUMS`);
		const out = join(tmp, "x");
		mkdirSync(out);
		await run("tar", ["-xzf", tgz, "-C", out], { timeout: INSTALL_TIMEOUT_MS });
		const pkgDir = existsSync(join(out, "package", "package.json")) ? join(out, "package") : out;
		const name = readPkgName(pkgDir);
		if (name !== "quick-agent") throw new Error(`release archive contains ${name ?? "no package.json"}, expected quick-agent`);
		const version = readVersion(pkgDir);
		if (version !== rel.version) throw new Error(`release archive is version ${version}, expected ${rel.version}`);
		p({ step: "switch" });
		const dest = join(appDir(), version);
		if (existsSync(dest)) {
			// Reinstall of the same version: move the old copy aside first (it may be `previous`).
			if (linkTarget("current") === version) throw new Error(`${version} is already the current version`);
			rmSync(dest, { recursive: true, force: true });
		}
		renameSync(pkgDir, dest);
		switchTo(version);
		try {
			prune();
		} catch {}
		return version;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function installNpm(kind: InstallKind, s: UpdateConfig, version: string): Promise<void> {
	if (kind === "npm-pi") await run("pi", ["update", `npm:${s.npmPackage}`], { timeout: INSTALL_TIMEOUT_MS, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	else await run("npm", ["install", "-g", `${s.npmPackage}@${version}`], { timeout: INSTALL_TIMEOUT_MS });
}

// ---------------------------------------------------------------- lock

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

export function shortErr(e: unknown): string {
	const err = e as { stderr?: string; message?: string };
	return (String(err.stderr ?? "").trim() || String(err.message ?? e)).split("\n")[0]!.slice(0, 300);
}

/**
 * Explicit upgrade (`quick upgrade`, hub button, mesh `update.run`). Never throws.
 * `rollback` switches back to the previous release instead.
 */
export async function runUpgrade(opts: { check?: boolean; rollback?: boolean; machine?: string; onProgress?: (p: Progress) => void } = {}): Promise<UpgradeResult> {
	const s = loadConfig().update;
	const root = updateRoot();
	const kind = detectInstall(root);
	const from = readVersion(activeRoot(root));
	const res: UpgradeResult = { machine: opts.machine, kind, root, checkOnly: !!opts.check, available: false, installed: false, ok: true, from, to: from };
	const fail = (error: string) => Object.assign(res, { ok: false, error });
	let release = acquireLock();
	for (let i = 0; !release && i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		release = acquireLock();
	}
	if (!release) return fail("另一个升级正在进行中");
	try {
		if (opts.rollback) {
			if (kind !== "release") return fail(`${KIND_LABEL[kind]}不支持回滚（只有 Release 安装可以）`);
			try {
				opts.onProgress?.({ step: "switch" });
				const [, to] = rollback();
				Object.assign(res, { installed: true, to });
				patchState({ installed: { from, to, at: Date.now(), kind } });
			} catch (e) {
				fail(shortErr(e));
			}
			return res;
		}
		opts.onProgress?.({ step: "check" });
		const st = await updateStatus({ refresh: true, machine: opts.machine });
		Object.assign(res, { available: st.available, latest: st.latest?.version, notes: st.latest?.notes, url: st.latest?.url, blocker: st.blocker });
		if (!st.latest) return fail(`查不到最新版本: ${st.error ?? "unknown error"}`);
		if (opts.check || !st.available) return res;
		if (st.blocker) return fail(st.blocker);
		try {
			if (kind === "release") res.to = await installRelease(st.latest, { onProgress: opts.onProgress, requireChecksum: s.requireChecksum });
			else {
				await installNpm(kind, s, st.latest.version);
				res.to = readVersion(root);
				if (res.to === from) throw new Error(`安装命令已执行，但版本仍为 ${from}`);
			}
			res.installed = true;
			patchState({ installed: { from, to: res.to, at: Date.now(), kind } });
		} catch (e) {
			fail(shortErr(e));
		}
		return res;
	} finally {
		release();
	}
}

/**
 * Spawn `quick hub reload` from the active (new) code, detached: restarts the hub and, if it runs,
 * the Web UI server. Workers live in tmux and are not touched.
 */
export function spawnReload(opts: { wait?: boolean; log?: string } = {}): ReturnType<typeof spawn> {
	const root = activeRoot();
	const logFile = opts.log ?? paths.log;
	const out = openSync(logFile, "a");
	const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
	delete env.QA_TASK_ID;
	if (env.QA_UPDATE_ROOT) env.QA_UPDATE_ROOT = root; // tests: the new copy becomes the running code
	const child = spawn(process.execPath, ["--import", join(root, "bin", "ts-hooks.mjs"), join(root, "cli", "quick.ts"), "hub", "reload"], {
		detached: !opts.wait,
		stdio: ["ignore", out, out],
		env,
	});
	if (!opts.wait) child.unref();
	closeSync(out);
	return child;
}

/** Remember an upgrade job across the hub restart (so the UI can see how it ended). */
export const JOB_PATH = join(paths.home, "update-job.json");
export function writeJob(job: unknown) {
	try {
		writeFileSync(JOB_PATH, `${JSON.stringify(job)}\n`);
	} catch {}
}
export function readJob<T>(): T | undefined {
	try {
		return JSON.parse(readFileSync(JOB_PATH, "utf8"));
	} catch {
		return undefined;
	}
}

export function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
