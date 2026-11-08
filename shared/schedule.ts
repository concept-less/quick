// Machine resources and dispatch scheduling (pure logic, unit-tested in test/schedule.test.ts).
//
// Every hub publishes `resources` (capability tags such as "macos", "gui", "browser:chrome-gui", "codex")
// and a `priority` (lower = preferred) in its MachineInfo. A dispatch picks, among the online machines that
// have every required resource, the one with the best priority.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";

/** Priority of machines that do not declare one (lower = preferred). */
export const DEFAULT_PRIORITY = 100;

/** Commands whose presence becomes a resource tag of the same name. */
const COMMAND_TAGS = ["codex", "claude", "docker", "gh"];

export interface MachineResourceView {
	id: string;
	self?: boolean;
	online?: boolean;
	platform?: string;
	resources?: string[];
	priority?: number;
	activeTasks?: number;
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
	const home = homedir();
	const dirs = [
		...(env.PATH ?? "").split(delimiter),
		// hubs started by launchd/systemd often have a minimal PATH
		join(home, ".local", "bin"),
		join(home, ".local", "node", "bin"),
		join(home, ".npm-global", "bin"),
		join(home, ".bun", "bin"),
		join(home, ".volta", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
	].filter(Boolean);
	return dirs.some((d) => existsSync(join(d, cmd)));
}

/** Base tags implied by an OS platform string (used for machines that publish no resources, e.g. old hubs). */
export function platformTags(platform: string | undefined): string[] {
	if (platform === "darwin") return ["macos", "gui"];
	if (platform === "linux") return ["linux"];
	if (platform === "win32") return ["windows", "gui"];
	return [];
}

/** Auto-detect resource tags of this machine: OS, GUI, browsers and installed CLIs. */
export function detectResources(env: NodeJS.ProcessEnv = process.env, platform = osPlatform()): string[] {
	const tags = new Set<string>();
	const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
	tags.add(os);
	const gui = platform === "darwin" || platform === "win32" || !!env.DISPLAY || !!env.WAYLAND_DISPLAY;
	if (gui) tags.add("gui");
	let chrome = false;
	if (platform === "darwin") {
		chrome = ["/Applications/Google Chrome.app", join(homedir(), "Applications", "Google Chrome.app")].some((p) => existsSync(p));
		if (existsSync("/Applications/Safari.app")) tags.add("browser:safari-gui");
	} else {
		chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].some((c) => onPath(c, env));
	}
	if (chrome) tags.add(gui ? "browser:chrome-gui" : "browser:chrome-headless");
	for (const c of COMMAND_TAGS) if (onPath(c, env)) tags.add(c);
	if (onPath("nvidia-smi", env)) {
		try {
			execFileSync("nvidia-smi", ["-L"], { stdio: "pipe", timeout: 3000 });
			tags.add("gpu");
		} catch {}
	}
	return [...tags];
}

/**
 * Effective resources: detected tags merged with the configured list.
 * Config entries add tags; "-tag" removes one; "-*" drops everything detected (use only the explicit list).
 */
export function mergeResources(detected: string[], configured: string[] | undefined): string[] {
	let out = [...detected];
	for (const raw of configured ?? []) {
		const t = String(raw).trim();
		if (!t) continue;
		if (t === "-*") out = [];
		else if (t.startsWith("-")) out = out.filter((x) => x !== t.slice(1));
		else if (!out.includes(t.replace(/^\+/, ""))) out.push(t.replace(/^\+/, ""));
	}
	return out;
}

/** Edit a configured resource list: add tags, and remove tags (removing also records "-tag" so a detected tag is suppressed). */
export function applyResourceEdits(configured: string[] | undefined, add?: string[], remove?: string[]): string[] | undefined {
	if (!add?.length && !remove?.length) return configured;
	let out = [...(configured ?? [])];
	for (const t of add ?? []) {
		out = out.filter((x) => x !== t && x !== `-${t}`);
		out.push(t);
	}
	for (const t of remove ?? []) {
		out = out.filter((x) => x !== t && x !== `-${t}`);
		out.push(`-${t}`);
	}
	return out;
}

/** Resources of a machine as seen in the mesh (falls back to platform tags for hubs without resource support). */
export function resourcesOf(m: MachineResourceView): string[] {
	return m.resources ?? platformTags(m.platform);
}
export function priorityOf(m: MachineResourceView): number {
	return typeof m.priority === "number" && Number.isFinite(m.priority) ? m.priority : DEFAULT_PRIORITY;
}

/** A requirement "browser" is met by "browser:chrome-gui"; "browser:chrome" by "browser:chrome-gui" too. */
export function hasResource(tags: string[], req: string): boolean {
	const r = req.trim().toLowerCase();
	if (!r) return true;
	return tags.some((t0) => {
		const t = t0.toLowerCase();
		return t === r || t.startsWith(`${r}:`) || t.startsWith(`${r}-`);
	});
}
export function missingResources(m: MachineResourceView, requires: string[] | undefined): string[] {
	const tags = resourcesOf(m);
	return (requires ?? []).filter((r) => r.trim() && !hasResource(tags, r));
}

export function normalizeRequires(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
	return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

/** Order by preference: priority, then this machine, then fewer active tasks, then id. */
export function rankMachines<T extends MachineResourceView>(list: T[]): T[] {
	return [...list].sort((a, b) => priorityOf(a) - priorityOf(b) || Number(!!b.self) - Number(!!a.self) || (a.activeTasks ?? 0) - (b.activeTasks ?? 0) || a.id.localeCompare(b.id));
}

export class ScheduleError extends Error {}

/**
 * Candidate machines for a dispatch, best first.
 * - `machine` given: just that machine (must be known, online and have the resources).
 * - otherwise: every online machine with all `requires`, ranked by rankMachines.
 * Throws ScheduleError with a human-readable reason when nothing fits.
 */
export function candidateMachines<T extends MachineResourceView>(machines: T[], opts: { machine?: string; requires?: string[] }): T[] {
	const requires = normalizeRequires(opts.requires);
	const want = opts.requires && requires.length ? `（需要 ${requires.join(", ")}）` : "";
	if (opts.machine) {
		const m = machines.find((x) => x.id === opts.machine);
		if (!m) throw new ScheduleError(`machine ${opts.machine} is unknown; known: ${machines.map((x) => x.id).join(", ") || "-"}`);
		if (m.online === false) throw new ScheduleError(`machine ${m.id} is offline${want}`);
		const miss = missingResources(m, requires);
		if (miss.length) throw new ScheduleError(`machine ${m.id} lacks required resources: ${miss.join(", ")} (it has: ${resourcesOf(m).join(", ") || "none"})`);
		return [m];
	}
	const fits = machines.filter((m) => !missingResources(m, requires).length);
	const online = fits.filter((m) => m.online !== false);
	if (!online.length) {
		const offline = fits.filter((m) => m.online === false).map((m) => m.id);
		const detail = machines
			.filter((m) => m.online !== false)
			.map((m) => `${m.id} lacks ${missingResources(m, requires).join(", ")}`)
			.join("; ");
		throw new ScheduleError(
			`no online machine has the required resources ${requires.join(", ")}${offline.length ? `; offline machines that would fit: ${offline.join(", ")}` : ""}${detail ? ` (${detail})` : ""}`,
		);
	}
	return rankMachines(online);
}

/** Convenience: the single best machine. */
export function pickMachine<T extends MachineResourceView>(machines: T[], opts: { machine?: string; requires?: string[] }): T {
	return candidateMachines(machines, opts)[0]!;
}

/** Async pick that also honours a given cwd: the first candidate on which `cwdExists` resolves true. */
export async function pickMachineForCwd<T extends MachineResourceView>(
	machines: T[],
	opts: { machine?: string; requires?: string[]; cwd?: string },
	cwdExists: (m: T, cwd: string) => Promise<boolean>,
): Promise<T> {
	const list = candidateMachines(machines, opts);
	if (!opts.cwd || opts.machine) return list[0]!;
	for (const m of list) if (await cwdExists(m, opts.cwd).catch(() => false)) return m;
	throw new ScheduleError(
		`cwd ${opts.cwd} does not exist on any candidate machine (${list.map((m) => m.id).join(", ")}); omit cwd to use the chosen machine's default directory, or pass machine explicitly`,
	);
}
