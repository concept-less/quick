#!/usr/bin/env node
// End-to-end demo of the Web UI upgrade button in a fully isolated environment:
//   install.sh (local tarball 0.8.0 built from this checkout) → hub + Web UI on temp ports →
//   fake GitHub Releases API offering 0.9.0 → a (fake) worker running in tmux →
//   headless Chromium: header shows "升级 v0.9.0" → open panel → click 升级 → progress →
//   hub + Web UI restart → page reloads by itself → header shows v0.9.0; worker untouched.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROMIUM=/path/to/chrome] node test/e2e-ui-upgrade.mjs [--keep] [--shots DIR]
//
// Needs: tmux, pi (the Web UI hosts a pi SDK session; no model call is made), Chromium for Playwright.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const SHOTS = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : undefined;
const TMP = mkdtempSync(join(tmpdir(), "qa-ui-upgrade-"));
const PORT = 21000 + Math.floor(Math.random() * 20000);
const UI_PORT = PORT + 1;
const GH_PORT = PORT + 2;
const HOME = join(TMP, "home");
const APP = join(HOME, "app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");

// ---------------------------------------------------------------- release tarballs
function tarball(version) {
	const stage = join(TMP, `stage-${version}`);
	const pkg = join(stage, "package");
	mkdirSync(pkg, { recursive: true });
	for (const d of ["bin", "cli", "hub", "shared", "extensions", "browser", "ui"]) cpSync(join(REPO, d), join(pkg, d), { recursive: true });
	cpSync(join(REPO, "install.sh"), join(pkg, "install.sh"));
	const j = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...j, version }, null, 2));
	const file = join(TMP, `quick-agent-${version}.tgz`);
	execFileSync("tar", ["-czf", file, "-C", stage, "package"]);
	writeFileSync(join(TMP, `SHA256SUMS-${version}`), `${createHash("sha256").update(readFileSync(file)).digest("hex")}  quick-agent-${version}.tgz\n`);
	return file;
}
const t080 = tarball("0.8.0");
const t090 = tarball("0.9.0");

// ---------------------------------------------------------------- fake GitHub API (separate process)
const gh = `http://127.0.0.1:${GH_PORT}`;
const ghDir = join(TMP, "gh");
mkdirSync(ghDir);
cpSync(t090, join(ghDir, "quick-agent-0.9.0.tgz"));
cpSync(join(TMP, "SHA256SUMS-0.9.0"), join(ghDir, "SHA256SUMS"));
writeFileSync(
	join(ghDir, "latest.json"),
	JSON.stringify({
		tag_name: "v0.9.0",
		name: "quick-agent v0.9.0",
		body: "## v0.9.0\n\n- Release-based upgrades with an upgrade button\n- quick checks for new versions on every start",
		html_url: "https://github.com/concept-less/quick/releases/tag/v0.9.0",
		assets: [
			{ name: "quick-agent-0.9.0.tgz", browser_download_url: `${gh}/dl/quick-agent-0.9.0.tgz`, size: readFileSync(t090).length },
			{ name: "SHA256SUMS", browser_download_url: `${gh}/dl/SHA256SUMS` },
		],
	}),
);
const ghProc = spawn(process.execPath, ["-e", `
const http = require("http"), fs = require("fs"), p = require("path"); const dir = ${JSON.stringify(ghDir)};
http.createServer((req, res) => {
	if (req.url === "/gh/repos/concept-less/quick/releases/latest") return res.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(p.join(dir, "latest.json")));
	const f = req.url.startsWith("/dl/") && p.join(dir, p.basename(req.url));
	if (f && fs.existsSync(f)) { const b = fs.readFileSync(f); res.writeHead(200, { "content-length": b.length }); let i = 0; const t = setInterval(() => { res.write(b.subarray(i, i += 8192)); if (i >= b.length) { clearInterval(t); res.end(); } }, 60); return; }
	res.writeHead(404).end();
}).listen(${GH_PORT}, "127.0.0.1");`], { stdio: "inherit" });

// ---------------------------------------------------------------- environment
const fakeBin = join(TMP, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "pi-real"), `#!/usr/bin/env bash\nexec ${execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim()} "$@"\n`);
// Workers (tmux) get a fake pi that keeps reporting to the hub; everything else uses the real pi.
writeFileSync(join(fakeBin, "pi"), `#!/usr/bin/env bash
if [ -z "$QA_TASK_ID" ]; then exec "${fakeBin}/pi-real" "$@"; fi
exec node --import ${REPO}/bin/ts-hooks.mjs --input-type=module -e '
const { HubClient } = await import("${REPO}/shared/hub-client.ts");
const { writeFileSync } = await import("node:fs");
const hub = new HubClient(); const id = process.env.QA_TASK_ID;
const st = { pid: process.pid, ok: 0, fail: 0, hubs: {} };
for (let n = 0; ; n++) {
	try { await hub.report(id, n ? { activity: "tick " + n } : { status: "running", activity: "fake worker" }); const h = await hub.health(); st.ok++; st.hubs[h.pid] = (st.hubs[h.pid] ?? 0) + 1; }
	catch (e) { st.fail++; st.err = String(e.message); }
	writeFileSync(process.env.QA_HOME + "/worker.json", JSON.stringify(st));
	await new Promise((r) => setTimeout(r, 200));
}'
`);
chmodSync(join(fakeBin, "pi"), 0o755);
chmodSync(join(fakeBin, "pi-real"), 0o755);
// Isolated pi agent dir: only the installed quick-agent (app/current), auth copied so the SDK starts.
const agentDir = join(TMP, "pi-agent");
mkdirSync(agentDir);
const realAgent = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
for (const f of ["auth.json", "models-store.json"]) if (existsSync(join(realAgent, f))) cpSync(join(realAgent, f), join(agentDir, f));
const s0 = existsSync(join(realAgent, "settings.json")) ? JSON.parse(readFileSync(join(realAgent, "settings.json"), "utf8")) : {};
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: s0.defaultProvider, defaultModel: s0.defaultModel, packages: [join(APP, "current")] }));

mkdirSync(HOME, { recursive: true });
writeFileSync(join(HOME, "config.json"), JSON.stringify({ host: "127.0.0.1", port: PORT, uiPort: UI_PORT, token: "e2e-token", tmuxSession: `qa-e2e-${process.pid}`, defaultCwd: TMP, machine: { id: "demo" } }));
const env = { ...process.env, QA_HOME: HOME, QA_PORT: String(PORT), QA_UI_PORT: String(UI_PORT), QA_GITHUB_API: `${gh}/gh`, PI_CODING_AGENT_DIR: agentDir, PATH: `${fakeBin}:${process.env.PATH}`, NODE_NO_WARNINGS: "1" };
for (const k of ["QA_TASK_ID", "QA_ROLE", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "QA_UPDATE_ROOT", "QA_INSTALL_KIND", "QA_APP_DIR", "TMUX", "GITHUB_TOKEN", "GH_TOKEN"]) delete env[k];
const quick = (...args) => execFileSync(join(APP, "current", "bin", "quick"), args, { env, encoding: "utf8", timeout: 120_000 });

let browser;
async function cleanup() {
	await browser?.close().catch(() => {});
	ghProc.kill();
	for (const f of ["ui.pid", "hub.pid"]) {
		try {
			process.kill(Number(readFileSync(join(HOME, f), "utf8")), "SIGTERM");
		} catch {}
	}
	spawnSync("tmux", ["kill-session", "-t", `=qa-e2e-${process.pid}`]);
	if (!KEEP) rmSync(TMP, { recursive: true, force: true });
}
const fail = async (msg) => {
	console.error(`FAIL: ${msg}\n(logs: ${HOME}/hub.log, ${HOME}/ui.log)`);
	await cleanup();
	process.exit(1);
};

try {
	// 1. install 0.8.0 with install.sh (local tarball + checksum), like a user would
	log("install.sh --tarball quick-agent-0.8.0.tgz");
	const out = execFileSync("bash", [join(REPO, "install.sh"), "--tarball", t080, "--sums", join(TMP, "SHA256SUMS-0.8.0"), "--no-pi", "--no-restart"], { env: { ...env, QA_BIN_DIR: join(TMP, "localbin") }, encoding: "utf8" });
	process.stdout.write(out.replace(/^/gm, "    "));
	if (readlinkSync(join(APP, "current")) !== "0.8.0") await fail("install.sh did not switch current");

	// 2. hub + Web UI from the installed version
	log("quick ui --no-open");
	process.stdout.write(quick("ui", "--no-open", "--cwd", TMP).replace(/^/gm, "    "));
	log("hint on CLI start:", spawnSync(join(APP, "current", "bin", "quick"), ["ls"], { env: { ...env, QA_UPDATE_HINT: "1" }, encoding: "utf8" }).stderr.trim());

	// 3. a worker in tmux
	const task = JSON.parse(execFileSync("curl", ["-fsS", "-H", "authorization: Bearer e2e-token", "-H", "content-type: application/json", "-d", JSON.stringify({ title: "long job", brief: "keep going", cwd: TMP }), `http://127.0.0.1:${PORT}/api/tasks`], { encoding: "utf8" })).task;
	const worker = () => (existsSync(join(HOME, "worker.json")) ? JSON.parse(readFileSync(join(HOME, "worker.json"), "utf8")) : { ok: 0 });
	for (let i = 0; i < 100 && worker().ok < 3; i++) await sleep(100);
	const w0 = worker();
	if (w0.ok < 3) await fail("worker did not start");
	log(`worker ${task.id} running in tmux (pid ${w0.pid})`);
	const hubPid0 = JSON.parse(execFileSync("curl", ["-fsS", `http://127.0.0.1:${PORT}/health`], { encoding: "utf8" })).pid;

	// 4. the browser
	browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	let loads = 0;
	page.on("load", () => loads++);
	await page.goto(`http://127.0.0.1:${UI_PORT}/?token=e2e-token`);
	await page.waitForFunction(() => /升级 v0\.9\.0/.test(document.getElementById("qaVer")?.textContent ?? ""), null, { timeout: 20_000 });
	log(`header: "${await page.textContent("#qaVer")}"`);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true }), await page.screenshot({ path: join(SHOTS, "1-available.png") });
	await page.click("#qaVer");
	await page.waitForSelector('#qaUpd.open button[data-act="install"]');
	if (SHOTS) await page.screenshot({ path: join(SHOTS, "2-panel.png") });
	const loadsBefore = loads;
	await page.click('#qaUpd button[data-act="install"]');
	const seen = new Set();
	const t0 = Date.now();
	while (loads === loadsBefore && Date.now() - t0 < 90_000) {
		const s = await page.$$eval("#qaUpd .steps span", (els) => els.map((e) => `${e.className}:${e.textContent}`)).catch(() => []);
		const on = s.find((x) => x.startsWith("on:"));
		if (on && !seen.has(on)) {
			seen.add(on);
			log(`progress: ${on.slice(3)}`);
			if (SHOTS && /下载|重启/.test(on)) await page.screenshot({ path: join(SHOTS, `3-progress-${seen.size}.png`) }).catch(() => {});
		}
		await sleep(100);
	}
	if (loads === loadsBefore) await fail("page did not reload after the upgrade");
	await page.waitForFunction(() => /^v0\.9\.0$/.test(document.getElementById("qaVer")?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
	const after = await page.textContent("#qaVer");
	log(`page reloaded, header: "${after}"`);
	if (SHOTS) {
		await page.click("#qaVer");
		await sleep(500);
		await page.screenshot({ path: join(SHOTS, "4-upgraded.png") });
	}
	if (after !== "v0.9.0") await fail(`header shows ${after}`);

	// 5. verify
	const h = JSON.parse(execFileSync("curl", ["-fsS", `http://127.0.0.1:${PORT}/health`], { encoding: "utf8" }));
	const ui = JSON.parse(execFileSync("curl", ["-fsS", `http://127.0.0.1:${UI_PORT}/health`], { encoding: "utf8" }));
	await sleep(1000);
	const w1 = worker();
	const checks = {
		"current → 0.9.0": readlinkSync(join(APP, "current")) === "0.9.0",
		"previous → 0.8.0": readlinkSync(join(APP, "previous")) === "0.8.0",
		"hub restarted on 0.9.0": h.version === "0.9.0" && h.pid !== hubPid0,
		"web ui restarted on 0.9.0": ui.version === "0.9.0",
		"worker: same process": w1.pid === w0.pid,
		"worker: no failed hub request": w1.fail === 0,
		"worker: talks to the new hub": (w1.hubs[h.pid] ?? 0) > 0,
	};
	for (const [k, v] of Object.entries(checks)) log(`${v ? "ok  " : "FAIL"} ${k}`);
	if (Object.values(checks).some((v) => !v)) await fail("checks failed");
	log(`progress steps seen: ${[...seen].map((s) => s.slice(3)).join(" → ")}`);
	log("PASS");
	await cleanup();
} catch (e) {
	await fail(e.stack || e.message);
}
