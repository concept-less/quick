// Shared configuration for quick-agent (hub, CLI, pi extensions).
// Zero dependencies: runs under plain Node (type stripping) and under pi's jiti loader.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectRule {
	/** Substring or /regex/ matched against a page URL (browser intake). */
	match: string;
	/** Absolute working directory for workers on this project. */
	cwd: string;
	/** Optional notes passed to the front agent. */
	notes?: string;
	/** Machine that hosts `cwd` (default: this machine). */
	machine?: string;
}

export interface PeerConfig {
	/** Direct hub URL of the peer, e.g. http://10.0.0.5:7788 or a manually forwarded port. */
	url?: string;
	/** SSH destination (user@host or ~/.ssh/config alias): the hub manages an `ssh -L` tunnel itself. */
	ssh?: string;
	/** Hub port on the remote machine (ssh peers, default 7788). */
	port?: number;
	/** Extra ssh arguments, e.g. ["-p", "2222"]. */
	sshArgs?: string[];
}

export interface MeshConfig {
	/** Shared secret of the mesh; every member must use the same one. */
	secret?: string;
	/** Hubs this hub dials out to (links are bidirectional once established). */
	peers: PeerConfig[];
}

export interface QaConfig {
	host: string;
	port: number;
	/** Port of the Web UI (`quick ui`), always bound to 127.0.0.1. */
	uiPort: number;
	token: string;
	/** Model for both front and worker agents ("provider/id[:thinking]"). */
	model: string;
	frontModel?: string;
	workerModel?: string;
	/** tmux session that hosts the front agent and all workers. */
	tmuxSession: string;
	/** Fallback cwd for tasks when nothing else is known. */
	defaultCwd: string;
	projects: ProjectRule[];
	/** Identity, resources and scheduling preference of this machine in the mesh. */
	machine: MachineConfig;
	mesh: MeshConfig;
	/** Self-upgrade settings (see shared/update.ts). */
	update: UpdateConfig;
	/** Use a (remote) team hub with a personal token instead of the local hub. */
	client?: ClientConfig;
}

export interface MachineConfig {
	id: string;
	description?: string;
	/**
	 * Resource/capability tags merged with auto-detection (shared/schedule.ts detectResources):
	 * "tag" adds, "-tag" removes a detected tag, "-*" drops all detected tags.
	 * e.g. ["browser:chrome-gui", "codex", "-docker"].
	 */
	resources?: string[];
	/** Free-text notes about this machine's resources, shown to front agents. */
	resourceNotes?: string;
	/** Dispatch preference, lower = preferred (default 100). */
	priority?: number;
	/** Team member who owns this machine; the machine token then acts as that member (docs/team-collaboration.md). */
	owner?: string;
}

/** Connection profile of a team member who uses someone else's hub (`quick team join`). Ignored by workers. */
export interface ClientConfig {
	/** Hub URL, e.g. http://10.0.0.5:7788 or a forwarded port. */
	hub: string;
	/** Personal user token (qau_…). */
	token: string;
	user?: string;
}

export interface UpdateConfig {
	/** Master switch for automatic checks (env QA_UPDATE=off / QA_NO_UPDATE=1 disables). `quick upgrade` always works. */
	enabled: boolean;
	/** Install a newer release automatically after a check (default off: the UI / CLI only offer it). Env QA_UPDATE_AUTO_INSTALL=1|0. */
	autoInstall: boolean;
	/** How long a release lookup is cached in ~/.quick-agent/update.json (minutes, env QA_UPDATE_CACHE_MINUTES). */
	cacheMinutes: number;
	/** Timeout of the check `quick` runs on every start (ms); the command itself never waits for it longer. */
	cliTimeoutMs: number;
	/** After an upgrade: "auto" restarts hub + Web UI right away (workers keep running in tmux); "never" leaves it to you. */
	restartHub: "auto" | "never";
	/** Refuse release archives that are not listed in the release's SHA256SUMS (default true). */
	requireChecksum: boolean;
	/** npm package name, used only by npm installs (default: package.json name). */
	npmPackage: string;
	npmRegistry: string;
	/** GitHub repository "owner/name" of the releases (default: from package.json repository). */
	githubRepo?: string;
	githubApi: string;
}

export const QA_HOME = process.env.QA_HOME ?? join(homedir(), ".quick-agent");
export const CONFIG_PATH = join(QA_HOME, "config.json");
/** Repository root (…/quick-agent). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The pi extension entry point (installed into pi as a package). */
export const PI_EXTENSION = join(REPO_ROOT, "extensions", "quick-agent.ts");

export const paths = {
	home: QA_HOME,
	tasks: join(QA_HOME, "tasks"),
	intake: join(QA_HOME, "intake"),
	/** Scheduled jobs owned by this hub (hub/cron.ts). */
	cron: join(QA_HOME, "cron.json"),
	log: join(QA_HOME, "hub.log"),
	pid: join(QA_HOME, "hub.pid"),
	uiLog: join(QA_HOME, "ui.log"),
	uiPid: join(QA_HOME, "ui.pid"),
	/** Internal: pi session files that persist the one continuous Web UI front agent (never shown to the human). */
	uiSessions: join(QA_HOME, "ui-sessions"),
	/** Team roster (members, invites), replicated over the mesh. */
	team: join(QA_HOME, "team.json"),
	/** Hub-side attention state: focus mode, digest interval, pending digest. */
	attention: join(QA_HOME, "attention.json"),
	/** Release installs: <app>/<version>/, <app>/current → active version, <app>/previous → rollback target. */
	app: process.env.QA_APP_DIR ?? join(QA_HOME, "app"),
	/** Present (with a timestamp) while `quick hub reload` restarts the hub: clients retry instead of failing. */
	restarting: join(QA_HOME, "hub.restarting"),
};

export function ensureDirs(): void {
	for (const p of [paths.home, paths.tasks, paths.intake]) mkdirSync(p, { recursive: true });
}

export function loadConfig(): QaConfig {
	ensureDirs();
	let raw: Partial<QaConfig> = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		} catch (err) {
			throw new Error(`Invalid ${CONFIG_PATH}: ${(err as Error).message}`);
		}
	}
	const cfg: QaConfig = {
		host: raw.host ?? "127.0.0.1",
		port: Number(process.env.QA_PORT ?? raw.port ?? 7788),
		uiPort: Number(process.env.QA_UI_PORT ?? raw.uiPort ?? 7790),
		token: raw.token ?? randomBytes(18).toString("base64url"),
		model: raw.model ?? "tokenjoy/claude-opus-5-5",
		frontModel: raw.frontModel,
		workerModel: raw.workerModel,
		tmuxSession: raw.tmuxSession ?? "qa",
		defaultCwd: raw.defaultCwd ?? homedir(),
		projects: raw.projects ?? [],
		machine: machineConfig(raw.machine),
		mesh: { secret: raw.mesh?.secret, peers: raw.mesh?.peers ?? [] },
		update: updateConfig(raw.update),
		client: raw.client?.hub && raw.client?.token ? { hub: String(raw.client.hub).replace(/\/+$/, ""), token: String(raw.client.token), user: raw.client.user } : undefined,
	};
	if (!existsSync(CONFIG_PATH) || raw.token === undefined) {
		// `update` is derived (env overrides, package.json defaults): only persist what the user sets.
		const { update: _update, ...persist } = cfg;
		writeFileSync(CONFIG_PATH, `${JSON.stringify(raw.update ? { ...persist, update: raw.update } : persist, null, 2)}\n`, { mode: 0o600 });
	}
	return cfg;
}

function machineConfig(raw: Partial<MachineConfig> | undefined): MachineConfig {
	const env = process.env;
	const priority = Number(env.QA_MACHINE_PRIORITY ?? raw?.priority);
	return {
		id: env.QA_MACHINE ?? raw?.id ?? sanitizeId(hostname()),
		description: raw?.description,
		resources: Array.isArray(raw?.resources) ? raw.resources.map(String) : undefined,
		resourceNotes: typeof raw?.resourceNotes === "string" ? raw.resourceNotes : undefined,
		priority: Number.isFinite(priority) && (env.QA_MACHINE_PRIORITY ?? raw?.priority) !== undefined ? priority : undefined,
		owner: (env.QA_MACHINE_OWNER ?? raw?.owner) || undefined,
	};
}

function packageJson(): any {
	try {
		return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	} catch {
		return {};
	}
}

/** "owner/name" from a GitHub URL (git@github.com:o/n.git, https://github.com/o/n, git+https://…, github:o/n). */
export function githubSlug(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const m = /github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(url) ?? /^github:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url);
	return m ? `${m[1]}/${m[2]}` : undefined;
}

function updateConfig(raw: Partial<UpdateConfig> & Record<string, unknown> = {}): UpdateConfig {
	const pkg = packageJson();
	const repoUrl: string | undefined = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
	const off = (v: string | undefined) => v !== undefined && /^(0|off|false|no)$/i.test(v);
	const on = (v: string | undefined) => v !== undefined && /^(1|on|true|yes)$/i.test(v);
	const env = process.env;
	return {
		enabled: raw.enabled !== false && !off(env.QA_UPDATE) && env.QA_NO_UPDATE !== "1",
		autoInstall: env.QA_UPDATE_AUTO_INSTALL !== undefined ? on(env.QA_UPDATE_AUTO_INSTALL) : raw.autoInstall === true,
		cacheMinutes: Number(env.QA_UPDATE_CACHE_MINUTES ?? raw.cacheMinutes ?? 10) || 10,
		cliTimeoutMs: Number(env.QA_UPDATE_CLI_TIMEOUT_MS ?? raw.cliTimeoutMs ?? 1500) || 1500,
		restartHub: raw.restartHub === "never" ? "never" : "auto",
		requireChecksum: raw.requireChecksum !== false,
		npmPackage: raw.npmPackage ?? pkg.quickAgent?.npmPackage ?? pkg.name ?? "quick-agent",
		npmRegistry: (env.QA_NPM_REGISTRY ?? raw.npmRegistry ?? "https://registry.npmjs.org").replace(/\/+$/, ""),
		githubRepo: env.QA_GITHUB_REPO ?? raw.githubRepo ?? githubSlug(repoUrl),
		githubApi: (env.QA_GITHUB_API ?? raw.githubApi ?? "https://api.github.com").replace(/\/+$/, ""),
	};
}

export function sanitizeId(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "machine";
}

/** Merge a patch into config.json on disk (keeps unknown keys). */
export function saveConfigPatch(patch: (raw: any) => void): void {
	ensureDirs();
	const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
	patch(raw);
	writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

/** Is this process a worker (spawned by a hub for a task)? Workers always talk to their own machine's hub. */
const isWorker = () => !!process.env.QA_TASK_ID;

export function hubUrl(cfg: QaConfig): string {
	return process.env.QA_HUB_URL ?? (!isWorker() && cfg.client ? cfg.client.hub : `http://${cfg.host}:${cfg.port}`);
}
/** Token for hub requests: QA_TOKEN, the team client token, or this machine's token. */
export function hubToken(cfg: QaConfig): string {
	return process.env.QA_TOKEN ?? (!isWorker() && cfg.client && !process.env.QA_HUB_URL ? cfg.client.token : cfg.token);
}
/** True when clients talk to a hub that this machine does not run (so it must not be auto-started here). */
export function remoteHub(cfg: QaConfig): boolean {
	const u = hubUrl(cfg);
	return u !== `http://${cfg.host}:${cfg.port}` && !!(process.env.QA_HUB_URL || (!isWorker() && cfg.client));
}

export function matchProject(cfg: QaConfig, url: string | undefined): ProjectRule | undefined {
	if (!url) return undefined;
	return cfg.projects.find((p) => {
		if (p.match.startsWith("/") && p.match.endsWith("/") && p.match.length > 2) {
			try {
				return new RegExp(p.match.slice(1, -1)).test(url);
			} catch {
				return false;
			}
		}
		return url.includes(p.match);
	});
}
