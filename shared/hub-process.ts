// Start the hub as a detached background process if it is not running.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths, REPO_ROOT, type QaConfig } from "./config.ts";
import { HubClient } from "./hub-client.ts";

export async function hubAlive(hub: HubClient): Promise<boolean> {
	try {
		await hub.health();
		return true;
	} catch {
		return false;
	}
}

/** Node arguments to run the hub (the hook lets Node load our .ts files from node_modules when installed from npm). */
export function hubArgs(): string[] {
	return ["--import", join(REPO_ROOT, "bin", "ts-hooks.mjs"), join(REPO_ROOT, "hub", "server.ts")];
}

/** Ensure the hub is running. Returns "running" if it already was, "started" if we launched it. */
export async function ensureHub(cfg: QaConfig = loadConfig(), hub = new HubClient(cfg)): Promise<"running" | "started"> {
	if (await hubAlive(hub)) return "running";
	const out = openSync(paths.log, "a");
	const child = spawn(process.execPath, hubArgs(), {
		detached: true,
		stdio: ["ignore", out, out],
		// Strip pi-specific env so the hub is a clean process.
		env: { ...process.env, NODE_NO_WARNINGS: "1", QA_TASK_ID: "" },
	});
	child.unref();
	closeSync(out);
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 150));
		if (await hubAlive(hub)) return "started";
	}
	throw new Error(`quick-agent hub failed to start, see ${paths.log}`);
}
