// Projects: group tasks by the code base / product they belong to, automatically.
// Pure classification logic (no hub state) so it can be unit tested and reused by CLI/front/UI.
//
// A task is classified, in priority order, by
//   1. an explicit project (dispatch `project`, or a manual change: never overridden),
//   2. the git repository of its cwd: remote URL (same project across machines and clones),
//      else the main worktree root (git worktrees resolve to their main repository),
//   3. path rules (prefixes) and known project directories, then the directory name,
//   4. the browser page URL of the intake,
//   5. a light text match of the project name / keywords in the title and brief.
// Nothing matched → unsorted (no project).
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export interface ProjectDir {
	machine: string;
	path: string;
}

export interface Project {
	/** Stable id (slug); never changes on rename. */
	id: string;
	name: string;
	/** Normalized git remotes, e.g. "github.com/concept-less/quick". */
	remotes: string[];
	/** Path prefixes (any machine). */
	paths: string[];
	/** Known checkouts of the project, per machine (learned from git, or from config.json projects). */
	dirs: ProjectDir[];
	/** Browser page URL rules: substring, host, or /regex/. */
	urls: string[];
	/** Extra words for the text match (the name and id always count). */
	keywords: string[];
	/** Position in the human's project list (manual drag order; lower first). Unset = after ordered ones, by creation. */
	order?: number;
	/** Free-text notes for front agents. */
	notes?: string;
	/** Team members of the project (member ids). */
	members?: string[];
	/** Set when merged into another project: the id is kept as an alias. */
	mergedInto?: string;
	/** Created automatically (from a git repository / config.json). */
	auto?: boolean;
	/** When each rule ("kind\0value") was last added (a) / removed (r): rules replicate as a last-writer-wins set. */
	ruleTimes?: Record<string, { a?: number; r?: number }>;
	createdAt: number;
	updatedAt: number;
}

/** How a task got its project. "manual" and "explicit" are never reclassified automatically. */
export type ProjectVia = "manual" | "explicit" | "git-remote" | "git-root" | "path" | "dirname" | "url" | "text" | "none";

export const UNSORTED_LABEL = "未归类";

export interface GitInfo {
	/** Top level of the working tree that contains cwd (a worktree path for worktrees). */
	top: string;
	/** Root of the main working tree (same as top unless cwd is in a linked worktree). */
	root: string;
	/** Normalized remote (origin, else the first remote). */
	remote?: string;
}

export interface ClassifyInput {
	cwd?: string;
	machine?: string;
	git?: GitInfo | null;
	url?: string;
	title?: string;
	brief?: string;
	/** Explicit project id or name. */
	project?: string;
}

export interface Classification {
	project?: string;
	via: ProjectVia;
	/** Set when the git repository has no project yet: the caller may create it. */
	create?: Project;
}

// ---------------------------------------------------------------- helpers

export function slug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/\.git$/, "")
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "project"
	);
}

/** "git@github.com:Org/Repo.git", "https://user@github.com/org/repo", "ssh://git@host:22/org/repo.git" → "github.com/org/repo". */
export function normalizeRemote(url: string | undefined): string | undefined {
	if (!url) return undefined;
	let s = url.trim();
	if (!s) return undefined;
	s = s.replace(/^git\+/, "");
	let host = "";
	let path = "";
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(s);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
		try {
			const u = new URL(s);
			if (u.protocol === "file:") return `file:${u.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
			host = u.hostname;
			path = u.pathname;
		} catch {
			return undefined;
		}
	} else if (scp && !s.startsWith("/")) {
		host = scp[1]!;
		path = scp[2]!;
	} else if (s.startsWith("/")) {
		return `file:${s.replace(/\/+$/, "").replace(/\.git$/, "")}`;
	} else return undefined;
	path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
	if (!host || !path) return undefined;
	return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

/** Git repository of a directory (local machine only). null when not a git repo / git missing. */
export function gitInfo(cwd: string): GitInfo | null {
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
	try {
		const [top, common] = git("rev-parse", "--show-toplevel", "--git-common-dir").split("\n");
		if (!top) return null;
		const commonAbs = common ? (isAbsolute(common) ? common : resolve(cwd, common)) : "";
		// Linked worktrees share the main repository's .git dir: its parent is the main worktree.
		const root = commonAbs && basename(commonAbs) === ".git" ? dirname(commonAbs) : top;
		let remote: string | undefined;
		try {
			remote = git("config", "--get", "remote.origin.url");
		} catch {
			try {
				const first = git("remote").split("\n")[0];
				if (first) remote = git("config", "--get", `remote.${first}.url`);
			} catch {}
		}
		return { top, root, remote: normalizeRemote(remote) };
	} catch {
		return null;
	}
}

function underPath(p: string, prefix: string): boolean {
	const a = p.replace(/\/+$/, "");
	const b = prefix.replace(/\/+$/, "");
	if (!b) return false;
	return a === b || a.startsWith(b.endsWith(sep) || b.endsWith("/") ? b : `${b}/`);
}

function urlMatches(rule: string, url: string): boolean {
	if (rule.length > 2 && rule.startsWith("/") && rule.endsWith("/")) {
		try {
			return new RegExp(rule.slice(1, -1)).test(url);
		} catch {
			return false;
		}
	}
	return url.includes(rule);
}

/** Hosts shared by many projects: a learned rule needs the first two path segments (owner/repo, space/doc…). */
const SHARED_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|google\.com|feishu\.cn|larksuite\.com|larkoffice\.com|notion\.so|stackoverflow\.com|npmjs\.com|vercel\.app|netlify\.app)$/i;

/** URL rule learned from a page URL: host (+port for local hosts; +owner/repo for shared hosts). */
export function urlRuleFor(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		if (!/^https?:$/.test(u.protocol) || !u.hostname) return undefined;
		if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname) && !u.port) return undefined;
		if (SHARED_HOSTS.test(u.hostname)) {
			const segs = u.pathname.split("/").filter(Boolean);
			return segs.length >= 2 ? `${u.hostname}/${segs[0]}/${segs[1]}` : undefined;
		}
		return u.port ? `${u.hostname}:${u.port}` : u.hostname;
	} catch {
		return undefined;
	}
}

/** Live (not merged) project for an id, following merge aliases. */
export function resolveProject(projects: Project[], id: string | undefined): Project | undefined {
	if (!id) return undefined;
	const byId = new Map(projects.map((p) => [p.id, p]));
	let p = byId.get(id);
	for (let i = 0; p?.mergedInto && i < 10; i++) p = byId.get(p.mergedInto);
	return p && !p.mergedInto ? p : undefined;
}

/** Find a project by id or (case-insensitive) name. */
export function findProject(projects: Project[], key: string | undefined): Project | undefined {
	const k = key?.trim();
	if (!k) return undefined;
	const lower = k.toLowerCase();
	return (
		resolveProject(projects, k) ??
		resolveProject(projects, projects.find((p) => p.name.toLowerCase() === lower)?.id) ??
		resolveProject(projects, projects.find((p) => p.id === slug(k))?.id)
	);
}

export function newProject(name: string, id: string, now = Date.now()): Project {
	return { id, name, remotes: [], paths: [], dirs: [], urls: [], keywords: [], createdAt: now, updatedAt: now };
}

/** A fresh id derived from the name that does not collide with existing projects. */
export function uniqueId(projects: Project[], name: string): string {
	const base = slug(name);
	const ids = new Set(projects.map((p) => p.id));
	if (!ids.has(base) && base !== "unsorted") return base;
	for (let n = 2; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Fill missing fields of a project read from disk / the mesh. */
export function normalizeProject(p: any): Project | undefined {
	if (!p || typeof p.id !== "string" || !p.id) return undefined;
	const arr = (x: any) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
	return {
		...p,
		id: p.id,
		name: typeof p.name === "string" && p.name ? p.name : p.id,
		remotes: arr(p.remotes),
		paths: arr(p.paths),
		dirs: Array.isArray(p.dirs) ? p.dirs.filter((d: any) => d && typeof d.path === "string").map((d: any) => ({ machine: String(d.machine ?? ""), path: d.path })) : [],
		urls: arr(p.urls),
		keywords: arr(p.keywords),
		order: Number.isFinite(p.order) ? Number(p.order) : undefined,
		createdAt: Number(p.createdAt) || 0,
		updatedAt: Number(p.updatedAt) || 0,
	};
}

/** Stable display order of projects: manual order first, then creation time, then name. Never depends on activity. */
export function compareProjects(a: Project, b: Project): number {
	const ao = a.order ?? Number.POSITIVE_INFINITY;
	const bo = b.order ?? Number.POSITIVE_INFINITY;
	if (ao !== bo) return ao < bo ? -1 : 1;
	return (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Assign `order` to the listed live projects (in that order); the rest keep theirs after them. Returns the changed ones. */
export function reorderProjects(projects: Project[], ids: string[], now = Date.now()): Project[] {
	const live = projects.filter((p) => !p.mergedInto);
	const listed = ids.map((id) => resolveProject(projects, id)).filter((p, i, a): p is Project => !!p && a.indexOf(p) === i);
	const rest = live.filter((p) => !listed.includes(p)).sort(compareProjects);
	const changed: Project[] = [];
	[...listed, ...rest].forEach((p, i) => {
		if (p.order === i) return;
		p.order = i;
		p.updatedAt = now;
		changed.push(p);
	});
	return changed;
}

// ---------------------------------------------------------------- classification

/** Minimum text score: one title mention, or three mentions in the brief. */
const TEXT_MIN_SCORE = 3;
const TEXT_STOP = new Set(["project", "app", "web", "src", "test", "tmp", "home", "code", "repo"]);

/** Directory names that identify a project in a path: "quick-agent" also matches "quick-agent-t2d42". */
function dirNameMatch(cwd: string, names: string[]): boolean {
	const segs = cwd.split(/[\\/]+/).filter(Boolean);
	return segs.some((s) => names.some((n) => s === n || (s.startsWith(`${n}-`) && n.length >= 4)));
}

export function classify(projects: Project[], input: ClassifyInput): Classification {
	const live = projects.filter((p) => !p.mergedInto);
	if (input.project) {
		const p = findProject(projects, input.project);
		if (p) return { project: p.id, via: "explicit" };
		const name = input.project.trim();
		const created = newProject(name, uniqueId(projects, name));
		return { project: created.id, via: "explicit", create: created };
	}
	const git = input.git;
	const cwd = input.cwd?.trim();
	if (git && cwd) {
		// An explicit path rule deeper than the repository root (a sub-project of a monorepo) is more specific.
		const deep = live.find((p) => p.paths.some((r) => underPath(cwd, r) && r.replace(/\/+$/, "").length > git.top.length && underPath(r, git.top)));
		if (deep) return { project: deep.id, via: "path" };
	}
	if (git?.remote) {
		const p = live.find((x) => x.remotes.includes(git.remote!));
		if (p) return { project: p.id, via: "git-remote" };
	}
	if (git) {
		const roots = [git.root, git.top];
		const p = live.find((x) => x.dirs.some((d) => roots.includes(d.path)) || x.paths.some((r) => roots.some((root) => underPath(root, r))));
		if (p) return { project: p.id, via: "git-root" };
		// A repository nobody has seen yet becomes a project of its own, named after its main directory.
		const name = basename(git.root) || basename(git.top) || "repo";
		const created: Project = { ...newProject(name, uniqueId(projects, name)), auto: true, remotes: git.remote ? [git.remote] : [], dirs: [] };
		if (input.machine) created.dirs.push({ machine: input.machine, path: git.root });
		else created.paths.push(git.root);
		return { project: created.id, via: git.remote ? "git-remote" : "git-root", create: created };
	}
	if (cwd) {
		// Longest matching prefix wins (a sub-project inside a monorepo beats the monorepo).
		let best: { p: Project; len: number } | undefined;
		for (const p of live) {
			for (const r of [...p.paths, ...p.dirs.map((d) => d.path)]) {
				if (underPath(cwd, r) && (!best || r.length > best.len)) best = { p, len: r.length };
			}
		}
		if (best) return { project: best.p.id, via: "path" };
		const hit = live.filter((p) => {
			const names = [...new Set([...p.dirs.map((d) => basename(d.path)), ...p.paths.map((x) => basename(x))])].filter((n) => n && !TEXT_STOP.has(n));
			return names.length && dirNameMatch(cwd, names);
		});
		if (hit.length === 1) return { project: hit[0]!.id, via: "dirname" };
	}
	if (input.url) {
		const p = live.find((x) => x.urls.some((r) => urlMatches(r, input.url!)));
		if (p) return { project: p.id, via: "url" };
	}
	// Text: a mention in the title counts 3, each mention in the brief 1; a passing mention is not enough.
	const title = (input.title ?? "").toLowerCase();
	const brief = (input.brief ?? "").slice(0, 6000).toLowerCase();
	if (title.trim() || brief.trim()) {
		let best: { id: string; n: number } | undefined;
		let tie = false;
		for (const p of live) {
			const words = [...new Set([p.name, p.id, ...p.keywords].map((w) => w.toLowerCase().trim()).filter((w) => w.length >= 3 && !TEXT_STOP.has(w)))];
			let n = 0;
			for (const w of words) n += 3 * countWord(title, w) + countWord(brief, w);
			if (n < TEXT_MIN_SCORE) continue;
			if (!best || n > best.n) {
				best = { id: p.id, n };
				tie = false;
			} else if (n === best.n) tie = true;
		}
		if (best && !tie) return { project: best.id, via: "text" };
	}
	return { via: "none" };
}

/** Occurrences of w in text, not glued to other word characters (so "quick" ≠ "quickly", but "quick-agent" counts once). */
function countWord(text: string, w: string): number {
	const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(^|[^a-z0-9_-])${esc}(?![a-z0-9_])`, "g");
	return text.match(re)?.length ?? 0;
}

// ---------------------------------------------------------------- learning / merging

export type RuleKind = "remotes" | "paths" | "urls" | "keywords";
export const RULE_KINDS: RuleKind[] = ["remotes", "paths", "urls", "keywords"];
const ruleKey = (kind: RuleKind, value: string) => `${kind}\u0000${value}`;

/** Add an identification rule (returns false when it was already there). */
export function addRule(p: Project, kind: RuleKind, value: string, now = Date.now()): boolean {
	const key = ruleKey(kind, value);
	const t = p.ruleTimes?.[key];
	if (p[kind].includes(value) && !(t?.r && t.r >= (t.a ?? 0))) return false;
	p.ruleTimes ??= {};
	p.ruleTimes[key] = { ...t, a: Math.max(now, (t?.r ?? 0) + 1) };
	if (!p[kind].includes(value)) p[kind].push(value);
	return true;
}

/** Remove an identification rule; the removal replicates (a peer still having it does not bring it back). */
export function removeRule(p: Project, kind: RuleKind, value: string, now = Date.now()): boolean {
	const key = ruleKey(kind, value);
	const had = p[kind].includes(value);
	p.ruleTimes ??= {};
	const t = p.ruleTimes[key];
	p.ruleTimes[key] = { ...t, r: Math.max(now, (t?.a ?? 0) + 1) };
	p[kind] = p[kind].filter((x) => x !== value);
	return had;
}

const uniq = <T>(a: T[]) => [...new Set(a)];

/**
 * Learn identifying rules from a classified task (returns true when the project changed):
 * the git remote and the checkout directory on this machine, and the host of the page URL.
 */
export function learn(p: Project, input: ClassifyInput, others: Project[]): boolean {
	let changed = false;
	const git = input.git;
	if (git?.remote && !p.remotes.includes(git.remote) && !others.some((o) => o.id !== p.id && !o.mergedInto && o.remotes.includes(git.remote!))) {
		changed = addRule(p, "remotes", git.remote) || changed;
	}
	if (git && input.machine && !p.dirs.some((d) => d.machine === input.machine && d.path === git.root)) {
		p.dirs.push({ machine: input.machine, path: git.root });
		changed = true;
	}
	const rule = urlRuleFor(input.url);
	// A rule removed by hand is not learned again.
	const removed = rule ? p.ruleTimes?.[ruleKey("urls", rule)]?.r : undefined;
	if (rule && !removed && !p.urls.some((r) => urlMatches(r, input.url!)) && !others.some((o) => !o.mergedInto && o.urls.some((r) => urlMatches(r, input.url!)))) {
		changed = addRule(p, "urls", rule) || changed;
	}
	return changed;
}

/** Move all rules of `from` into `into` and mark `from` as an alias. */
export function mergeInto(from: Project, into: Project, now = Date.now()): void {
	for (const k of RULE_KINDS) for (const v of from[k]) addRule(into, k, v, now);
	if (from.name !== into.name) addRule(into, "keywords", from.name, now);
	into.members = from.members?.length || into.members?.length ? uniq([...(into.members ?? []), ...(from.members ?? [])]) : into.members;
	const seen = new Set(into.dirs.map((d) => `${d.machine}\0${d.path}`));
	for (const d of from.dirs) if (!seen.has(`${d.machine}\0${d.path}`)) into.dirs.push(d);
	into.updatedAt = now;
	from.mergedInto = into.id;
	from.updatedAt = now;
}

/**
 * Merge a replica of a project received from another hub into the local copy.
 * Learned identification (remotes, dirs) is unioned; everything else takes the newer side.
 * Returns the merged project and whether the local copy changed.
 */
export function mergeReplica(local: Project | undefined, remote: Project): { project: Project; changed: boolean } {
	if (!local) return { project: remote, changed: true };
	// Newer edit wins; identical timestamps resolve deterministically so every hub converges.
	const newer = remote.updatedAt > local.updatedAt || (remote.updatedAt === local.updatedAt && canonical(remote) > canonical(local)) ? remote : local;
	const merged: Project = {
		...newer,
		dirs: [...local.dirs],
		createdAt: Math.min(local.createdAt || remote.createdAt, remote.createdAt || local.createdAt),
	};
	// Rules: last-writer-wins set over both sides (learned rules from every machine survive, removals win when newer).
	const times: Record<string, { a?: number; r?: number }> = {};
	for (const src of [local.ruleTimes, remote.ruleTimes]) {
		for (const [k, t] of Object.entries(src ?? {})) {
			const cur = (times[k] ??= {});
			if (t.a !== undefined) cur.a = Math.max(cur.a ?? 0, t.a);
			if (t.r !== undefined) cur.r = Math.max(cur.r ?? 0, t.r);
		}
	}
	if (Object.keys(times).length) merged.ruleTimes = times;
	else delete merged.ruleTimes;
	for (const kind of RULE_KINDS) {
		const fromTimes = Object.keys(times).filter((k) => k.startsWith(`${kind}\u0000`) && times[k]!.a !== undefined).map((k) => k.slice(kind.length + 1));
		merged[kind] = uniq([...local[kind], ...remote[kind], ...fromTimes]).filter((v) => {
			const t = times[ruleKey(kind, v)];
			return !(t?.r !== undefined && t.r >= (t.a ?? 0));
		});
	}
	const seen = new Set(merged.dirs.map((d) => `${d.machine}\0${d.path}`));
	for (const d of remote.dirs) if (!seen.has(`${d.machine}\0${d.path}`)) merged.dirs.push(d);
	const changed = canonical(merged) !== canonical(local);
	return { project: merged, changed };
}

/** Key-order independent JSON (so replicas compare equal regardless of how they were built). */
export function canonical(v: unknown): string {
	return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

/**
 * Two hubs can independently create a project for the same repository (different directory names).
 * Pick a deterministic winner (oldest, then smallest id) for live projects sharing a remote and
 * merge the others into it. Returns the ids that were merged away.
 */
export function dedupeByRemote(projects: Project[], now = Date.now()): string[] {
	const merged: string[] = [];
	const live = () => projects.filter((p) => !p.mergedInto);
	for (let again = true; again; ) {
		again = false;
		for (const a of live()) {
			const dup = live().filter((b) => b.id !== a.id && b.remotes.some((r) => a.remotes.includes(r)));
			if (!dup.length) continue;
			const group = [a, ...dup].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
			const [win, ...lose] = group;
			for (const l of lose) {
				mergeInto(l, win!, now);
				merged.push(l.id);
			}
			again = true;
			break;
		}
	}
	return merged;
}

// ---------------------------------------------------------------- views

export interface ProjectGroup<T> {
	id: string; // "" = unsorted
	name: string;
	tasks: T[];
}

/** Group tasks by (resolved) project; unsorted last, other groups in first-seen order of `tasks`. */
export function groupByProject<T extends { project?: string }>(projects: Project[], tasks: T[]): ProjectGroup<T>[] {
	const groups = new Map<string, ProjectGroup<T>>();
	for (const t of tasks) {
		const p = resolveProject(projects, t.project);
		const id = p?.id ?? "";
		let g = groups.get(id);
		if (!g) groups.set(id, (g = { id, name: p?.name ?? UNSORTED_LABEL, tasks: [] }));
		g.tasks.push(t);
	}
	const list = [...groups.values()];
	return [...list.filter((g) => g.id), ...list.filter((g) => !g.id)];
}

