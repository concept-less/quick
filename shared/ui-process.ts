// Start / stop the Web UI server (ui/server.ts) as a detached background process.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths, REPO_ROOT, type QaConfig } from "./config.ts";

export const uiUrl = (cfg: QaConfig) => `http://127.0.0.1:${cfg.uiPort}`;
/** URL that logs the browser in (the token is exchanged for an HttpOnly cookie and removed from the address bar). */
export const uiLoginUrl = (cfg: QaConfig) => `${uiUrl(cfg)}/?token=${encodeURIComponent(cfg.token)}`;

export async function uiHealth(cfg: QaConfig): Promise<{ ok: boolean; pid: number; cwd: string } | undefined> {
	try {
		const r = await fetch(`${uiUrl(cfg)}/health`, { signal: AbortSignal.timeout(1500) });
		return r.ok ? ((await r.json()) as any) : undefined;
	} catch {
		return undefined;
	}
}

/** Ensure the UI server is running. Returns "running" or "started". */
export async function ensureUi(cfg: QaConfig, opts: { cwd: string; /** Debug only: start an empty front conversation. */ freshFront?: boolean }): Promise<"running" | "started"> {
	if (await uiHealth(cfg)) return "running";
	const out = openSync(paths.uiLog, "a");
	const env = { ...process.env, NODE_NO_WARNINGS: "1" };
	delete env.QA_TASK_ID; // never a worker, even when launched from a worker's shell
	const child = spawn(process.execPath, [join(REPO_ROOT, "ui", "server.ts"), "--cwd", opts.cwd, ...(opts.freshFront ? ["--fresh-front"] : [])], {
		detached: true,
		stdio: ["ignore", out, out],
		cwd: opts.cwd,
		env,
	});
	child.unref();
	closeSync(out);
	for (let i = 0; i < 100; i++) {
		await new Promise((r) => setTimeout(r, 200));
		if (await uiHealth(cfg)) return "started";
		if (child.exitCode !== null) break;
	}
	throw new Error(`quick-agent web ui failed to start, see ${paths.uiLog}`);
}

export async function stopUi(): Promise<boolean> {
	if (!existsSync(paths.uiPid)) return false;
	const pid = Number(readFileSync(paths.uiPid, "utf8"));
	let stopped = false;
	try {
		process.kill(pid, "SIGTERM");
		stopped = true;
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				process.kill(pid, 0);
			} catch {
				break;
			}
		}
	} catch {}
	try {
		unlinkSync(paths.uiPid);
	} catch {}
	return stopped;
}
