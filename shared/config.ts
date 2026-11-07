// Shared configuration for quick-agent (hub, CLI, pi extensions).
// Zero dependencies: runs under plain Node (type stripping) and under pi's jiti loader.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectRule {
	/** Substring or /regex/ matched against a page URL (browser intake). */
	match: string;
	/** Absolute working directory for workers on this project. */
	cwd: string;
	/** Optional notes passed to the front agent. */
	notes?: string;
}

export interface QaConfig {
	host: string;
	port: number;
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
	log: join(QA_HOME, "hub.log"),
	pid: join(QA_HOME, "hub.pid"),
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
		token: raw.token ?? randomBytes(18).toString("base64url"),
		model: raw.model ?? "tokenjoy/claude-opus-5-5",
		frontModel: raw.frontModel,
		workerModel: raw.workerModel,
		tmuxSession: raw.tmuxSession ?? "qa",
		defaultCwd: raw.defaultCwd ?? homedir(),
		projects: raw.projects ?? [],
	};
	if (!existsSync(CONFIG_PATH) || raw.token === undefined) {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
	}
	return cfg;
}

export function hubUrl(cfg: QaConfig): string {
	return process.env.QA_HUB_URL ?? `http://${cfg.host}:${cfg.port}`;
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
