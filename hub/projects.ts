// Hub-side project registry: persistence (~/.quick-agent/projects.json), automatic classification of
// tasks, backfill of existing tasks, manual changes (move / rename / merge / rules), mesh replication.
// Pure classification logic lives in shared/projects.ts.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ProjectRule } from "../shared/config.ts";
import {
	classify,
	dedupeByRemote,
	findProject,
	gitInfo,
	learn,
	mergeInto,
	mergeReplica,
	newProject,
	normalizeProject,
	normalizeRemote,
	addRule,
	removeRule,
	RULE_KINDS,
	resolveProject,
	uniqueId,
	type ClassifyInput,
	type GitInfo,
	type Project,
	type ProjectVia,
} from "../shared/projects.ts";
import type { HubEvent, Task } from "../shared/types.ts";

export interface ProjectDeps {
	self: string;
	file: string;
	log(msg: string): void;
	/** Tasks owned by this hub. */
	tasks: Map<string, Task>;
	/** Persist + replicate a project change of an own task without bumping updatedAt (keeps list order). */
	patchTask(t: Task, patch: Partial<Task>, note?: string): void;
	broadcast(e: HubEvent): void;
	flood(kind: string, data: any): void;
	/** config.json projects (URL → cwd), merged into the registry. */
	configRules(): ProjectRule[];
	/** quick-agent's own checkout and Web UI port: its project knows the UI URL. */
	repoRoot: string;
	uiPort: number;
	httpError(status: number, msg: string): Error;
}

interface Stored {
	projects: Project[];
	/** Manual project of tasks owned by hubs that cannot store it themselves (older versions). */
	overrides: Record<string, string>;
}

export function createProjects(d: ProjectDeps) {
	let state: Stored = { projects: [], overrides: {} };
	const gitCache = new Map<string, { at: number; info: GitInfo | null }>();

	const git = (cwd: string): GitInfo | null => {
		const c = gitCache.get(cwd);
		if (c && Date.now() - c.at < 60_000) return c.info;
		const info = existsSync(cwd) ? gitInfo(cwd) : null;
		gitCache.set(cwd, { at: Date.now(), info });
		return info;
	};

	function load() {
		try {
			const raw = JSON.parse(readFileSync(d.file, "utf8"));
			state = {
				projects: (Array.isArray(raw.projects) ? raw.projects : []).map(normalizeProject).filter(Boolean) as Project[],
				overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {},
			};
		} catch {}
	}
	function save() {
		const tmp = `${d.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(tmp, d.file);
	}
	const list = () => state.projects;
	const get = (id: string) => state.projects.find((p) => p.id === id);
	function announce(changed: Project[]) {
		if (!changed.length) return;
		save();
		for (const p of changed) d.flood("project", { project: p });
		d.broadcast({ type: "projects", projects: state.projects } as HubEvent);
	}
	function add(p: Project) {
		state.projects.push(p);
		return p;
	}

	/** Seed: quick-agent's own repository and the URL → cwd rules of config.json. */
	function seed() {
		const changed: Project[] = [];
		const ensure = (cwd: string, extra: { url?: string; notes?: string; machine?: string }) => {
			const machine = extra.machine ?? d.self;
			const local = machine === d.self;
			const info = local ? git(cwd) : null;
			const input: ClassifyInput = { cwd, machine, git: info };
			let c = classify(state.projects, input);
			let p = c.create ? add({ ...c.create, auto: true }) : resolveProject(state.projects, c.project);
			if (!p) {
				// Not a git repository: a project named after the directory, identified by the path.
				const name = basename(cwd) || cwd;
				p = add({ ...newProject(name, uniqueId(state.projects, name)), auto: true });
				c = { project: p.id, via: "path" };
			}
			let dirty = !!c.create || c.via === "path";
			if (info) dirty = learn(p, input, state.projects) || dirty;
			else if (!p.dirs.some((x) => x.machine === machine && x.path === cwd)) {
				p.dirs.push({ machine, path: cwd });
				dirty = true;
			}
			if (extra.url && !p.ruleTimes?.[`urls\u0000${extra.url}`]?.r && addRule(p, "urls", extra.url)) dirty = true;
			if (extra.notes && !p.notes) {
				p.notes = extra.notes;
				dirty = true;
			}
			if (dirty) {
				p.updatedAt = Date.now();
				if (!changed.includes(p)) changed.push(p);
			}
			return p;
		};
		if (git(d.repoRoot)) ensure(d.repoRoot, { url: `127.0.0.1:${d.uiPort}` });
		for (const r of d.configRules()) {
			if (!r?.cwd) continue;
			ensure(r.cwd, { url: r.match, notes: r.notes, machine: r.machine });
		}
		announce(changed);
	}

	/** Classify a task (owned by this hub, so its cwd can be inspected with git). */
	function classifyOwn(t: Pick<Task, "cwd" | "title" | "brief" | "source">, explicit?: string): { project?: string; projectVia: ProjectVia } {
		const input: ClassifyInput = { cwd: t.cwd, machine: d.self, git: t.cwd ? git(t.cwd) : null, url: t.source?.url, title: t.title, brief: t.brief, project: explicit };
		const c = classify(state.projects, input);
		const changed: Project[] = [];
		let p: Project | undefined;
		if (c.create) {
			p = add(c.create);
			changed.push(p);
		} else p = resolveProject(state.projects, c.project);
		// Learn identifying rules only from strong evidence (git / explicit choice).
		if (p && ["git-remote", "git-root", "explicit"].includes(c.via) && learn(p, input, state.projects)) {
			p.updatedAt = Date.now();
			if (!changed.includes(p)) changed.push(p);
		}
		announce(changed);
		return { project: p?.id, projectVia: c.via };
	}

	/** Best guess for a replica without project info (owned by an older hub): no git access. */
	function guess(t: Task): { project?: string; projectVia: ProjectVia } {
		const c = classify(state.projects, { cwd: t.cwd, machine: t.machine, git: null, url: t.source?.url, title: t.title, brief: t.brief });
		return { project: c.create ? undefined : c.project, projectVia: c.create ? "none" : c.via };
	}

	/** Task as shown to clients: manual overrides, merge aliases resolved, guesses for old replicas. */
	function view(t: Task): Task {
		const o = state.overrides[t.id];
		if (o !== undefined && t.projectVia !== "manual") return { ...t, project: o || undefined, projectVia: "manual" };
		if (t.projectVia === undefined) return { ...t, ...guess(t) };
		const p = resolveProject(state.projects, t.project);
		return p?.id === t.project ? t : { ...t, project: p?.id };
	}

	const sticky = (t: Task) => t.projectVia === "manual" || t.projectVia === "explicit";

	/** Classify own tasks: those never classified, or (all=true) every task that was not set by hand. */
	function backfill(all = false): { checked: number; changed: number } {
		let checked = 0;
		let changed = 0;
		for (const t of d.tasks.values()) {
			if (t.projectVia !== undefined && (!all || sticky(t))) continue;
			checked++;
			const r = classifyOwn(t);
			if (r.project !== t.project || r.projectVia !== t.projectVia) {
				d.patchTask(t, { project: r.project, projectVia: r.projectVia });
				changed++;
			}
		}
		if (changed) d.log(`[projects] classified ${changed}/${checked} task(s)`);
		return { checked, changed };
	}

	/** Weakly classified tasks (no git evidence, not chosen by hand) are revisited when projects change. */
	const WEAK = new Set(["none", "text", "dirname", "url", "path"]);
	let reTimer: ReturnType<typeof setTimeout> | undefined;
	function reclassifySoon() {
		clearTimeout(reTimer);
		reTimer = setTimeout(() => {
			for (const t of d.tasks.values()) {
				if (t.projectVia !== undefined && !WEAK.has(t.projectVia)) continue;
				const r = classifyOwn(t);
				if (r.project !== t.project || r.projectVia !== t.projectVia) d.patchTask(t, { project: r.project, projectVia: r.projectVia });
			}
		}, 300);
		reTimer.unref?.();
	}

	/** Re-tag own tasks that point at projects merged away. */
	function retag() {
		for (const t of d.tasks.values()) {
			if (!t.project) continue;
			const p = resolveProject(state.projects, t.project);
			if (p && p.id !== t.project) d.patchTask(t, { project: p.id });
		}
	}

	function require(key: string): Project {
		const p = findProject(state.projects, key);
		if (!p) throw d.httpError(404, `no such project: ${key}`);
		return p;
	}

	// ---- manual operations (any hub; replicated over the mesh)

	function create(body: any): Project {
		const name = String(body.name ?? "").trim();
		if (!name) throw d.httpError(400, "name is required");
		if (findProject(state.projects, name)) throw d.httpError(409, `project already exists: ${name}`);
		const p = add(newProject(name, uniqueId(state.projects, String(body.id ?? name))));
		applyRules(p, body);
		announce([p]);
		reclassifySoon();
		return p;
	}

	function rename(key: string, name: string): Project {
		const p = require(key);
		name = name.trim();
		if (!name) throw d.httpError(400, "name is required");
		const other = findProject(state.projects, name);
		if (other && other.id !== p.id) throw d.httpError(409, `another project is called ${name} (merge instead)`);
		p.name = name;
		p.auto = false;
		p.updatedAt = Date.now();
		announce([p]);
		reclassifySoon();
		return p;
	}

	function merge(fromKey: string, intoKey: string): Project {
		const from = require(fromKey);
		const into = require(intoKey);
		if (from.id === into.id) throw d.httpError(400, "cannot merge a project into itself");
		mergeInto(from, into);
		// Projects merged earlier into `from` now point at `into` directly.
		for (const p of state.projects) if (p.mergedInto === from.id) p.mergedInto = into.id;
		for (const [id, v] of Object.entries(state.overrides)) if (v === from.id) state.overrides[id] = into.id;
		announce([from, into]);
		retag();
		reclassifySoon();
		return into;
	}

	function applyRules(p: Project, body: any) {
		const arr = (x: any) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]).map((s: any) => String(s).trim()).filter(Boolean);
		const plus0 = body.add ?? body;
		const rm = body.remove ?? {};
		for (const k of RULE_KINDS) {
			const norm = (s: string) => (k === "remotes" ? (normalizeRemoteLoose(s) ?? s) : s);
			for (const v of arr(plus0[k]).map(norm)) addRule(p, k, v);
			for (const v of arr(rm[k]).map(norm)) removeRule(p, k, v);
		}
		if (typeof body.notes === "string") p.notes = body.notes || undefined;
		if (Array.isArray(body.members)) p.members = body.members.map(String);
	}

	function setRules(key: string, body: any): Project {
		const p = require(key);
		applyRules(p, body);
		p.updatedAt = Date.now();
		announce([p]);
		reclassifySoon();
		return p;
	}

	/** Resolve a project key for a manual move ("" / null / "unsorted" / 未归类 = unsorted); unknown names are created. */
	function resolveForMove(key: unknown): string {
		const k = String(key ?? "").trim();
		if (!k || k === "unsorted" || k === "none" || k === "未归类") return "";
		const p = findProject(state.projects, k);
		if (p) return p.id;
		return create({ name: k }).id;
	}

	/** Manual move of an own task. */
	function move(t: Task, key: unknown): Task {
		const id = resolveForMove(key);
		delete state.overrides[t.id];
		d.patchTask(t, { project: id || undefined, projectVia: "manual" }, `project → ${id || "unsorted"}`);
		save();
		return t;
	}

	/** Manual move remembered here, for tasks whose owner hub is too old to store it. */
	function override(taskId: string, key: unknown) {
		state.overrides[taskId] = resolveForMove(key);
		save();
		d.broadcast({ type: "projects", projects: state.projects } as HubEvent);
	}

	// ---- mesh

	function onReplica(raw: any): boolean {
		const incoming = normalizeProject(raw);
		if (!incoming) return false;
		const local = get(incoming.id);
		const { project, changed } = mergeReplica(local, incoming);
		if (!changed) return false;
		if (local) state.projects[state.projects.indexOf(local)] = project;
		else add(project);
		const gone = dedupeByRemote(state.projects);
		save();
		d.broadcast({ type: "projects", projects: state.projects } as HubEvent);
		for (const id of gone) d.flood("project", { project: get(id) });
		for (const id of gone) {
			const into = get(get(id)!.mergedInto!);
			if (into) d.flood("project", { project: into });
		}
		retag();
		reclassifySoon();
		return true;
	}

	function snapshot() {
		return state.projects.map((project) => ({ kind: "project", data: { project } }));
	}

	function start() {
		load();
		seed();
		if (dedupeByRemote(state.projects).length) save();
		backfill(false);
		retag();
	}

	/** Project whose URL rules match a page URL (no git / text inference). */
	function classifyUrl(url: string | undefined): string | undefined {
		if (!url) return undefined;
		const c = classify(state.projects, { url });
		return c.via === "url" ? c.project : undefined;
	}

	return { start, list, get, classifyOwn, classifyUrl, view, backfill, create, rename, merge, setRules, move, override, onReplica, snapshot, find: (k: string) => findProject(state.projects, k) };
}

function normalizeRemoteLoose(s: string): string | undefined {
	// Accept "github.com/org/repo" as-is, full URLs normalized.
	if (/^[\w.-]+\/[\w.-]+\/[\w.-]+/.test(s) && !s.includes(":")) return s.toLowerCase().replace(/\.git$/, "");
	return normalizeRemote(s);
}
