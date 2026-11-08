// Bootstrap helper run by the *system* Node (>= 22.18, type stripping) from the Electron main process.
// Reuses quick-agent's own process management (shared/hub-process.ts, shared/ui-process.ts) so the desktop
// client starts / reuses exactly the same hub and Web UI server as `quick ui`.
//
//   node bootstrap.mjs <repoRoot> ensure [--cwd DIR]   → ensure hub + ui, print JSON connection info
//   node bootstrap.mjs <repoRoot> info                 → print JSON connection info only
//   node bootstrap.mjs <repoRoot> stop-ui              → stop the Web UI server
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [repo, cmd = "info", ...rest] = process.argv.slice(2);
if (!repo) {
	console.error("usage: bootstrap.mjs <repoRoot> ensure|info|stop-ui [--cwd DIR]");
	process.exit(2);
}
delete process.env.QA_TASK_ID; // the desktop client is a front agent, never a worker
delete process.env.QA_ROLE;

const imp = (p) => import(pathToFileURL(join(repo, p)).href);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

try {
	const { loadConfig, hubUrl, paths } = await imp("shared/config.ts");
	const cfg = loadConfig();
	const info = (extra = {}) => ({
		ok: true,
		repo,
		token: cfg.token,
		uiPort: cfg.uiPort,
		uiUrl: `http://127.0.0.1:${cfg.uiPort}`,
		hubUrl: hubUrl(cfg),
		machine: cfg.machine?.id,
		defaultCwd: cfg.defaultCwd,
		uiLog: paths.uiLog,
		hubLog: paths.log,
		...extra,
	});
	if (cmd === "info") out(info());
	else if (cmd === "stop-ui") {
		const { stopUi } = await imp("shared/ui-process.ts");
		out(info({ stopped: await stopUi() }));
	} else if (cmd === "ensure") {
		const i = rest.indexOf("--cwd");
		const cwd = i >= 0 ? rest[i + 1] : cfg.defaultCwd;
		const { ensureHub } = await imp("shared/hub-process.ts");
		const { ensureUi, uiHealth } = await imp("shared/ui-process.ts");
		const hub = await ensureHub(cfg).catch((e) => `error: ${e.message}`);
		const ui = await ensureUi(cfg, { cwd });
		const h = await uiHealth(cfg);
		out(info({ hub, ui, cwd: h?.cwd ?? cwd, uiPid: h?.pid }));
	} else throw new Error(`unknown command ${cmd}`);
	process.exit(0);
} catch (e) {
	out({ ok: false, error: e?.message ?? String(e) });
	process.exit(1);
}
