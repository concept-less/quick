#!/usr/bin/env node
// End-to-end demo of the Web UI "WORKER 默认模型" setting in a fully isolated environment:
//   two hubs (demo-a with the Web UI, demo-b over the mesh) on temp ports and temp QA_HOMEs → a worker already
//   running on demo-a → headless Chromium: header WORKER button → panel lists both machines with their own model
//   list → apply a model demo-b does not have to all machines (partial failure shown, nothing saved on demo-b) →
//   apply tokenjoy/gpt-6.1-sol to all → both config.json changed, front chat model unchanged, the running worker is
//   untouched, the next worker starts with --model tokenjoy/gpt-6.1-sol.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROMIUM=…] node test/e2e-worker-model.mjs [--keep] [--shots DIR]
//
// Needs: tmux, pi (the Web UI hosts a pi SDK session and demo-a lists the real models; no model call is made).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const SHOTS = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : undefined;
const TMP = mkdtempSync(join(tmpdir(), "qa-e2e-wm-"));
const PORT = 23000 + Math.floor(Math.random() * 20000);
const UI_PORT = PORT + 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
const TARGET = "tokenjoy/gpt-6.1-sol";

// ---------------------------------------------------------------- environment
const realPi = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const bins = { a: join(TMP, "bin-a"), b: join(TMP, "bin-b") };
for (const [k, d] of Object.entries(bins)) {
	mkdirSync(d);
	// Workers (QA_TASK_ID set, only ever from a hub's tmux window) record their argv and stay alive; nothing calls a model.
	// demo-a lists the real pi models, demo-b a fixed, smaller list (so a cross-machine validation failure can be shown).
	const list = k === "a" ? `exec ${realPi} "$@"` : `printf 'provider  model  context  max-out  thinking  images\\ntokenjoy  claude-opus-5-5  1M  128K  yes  yes\\ntokenjoy  gpt-6.1-sol  200K  64K  no  yes\\n'; exit 0`;
	writeFileSync(join(d, "pi"), `#!/usr/bin/env bash
if [ -n "$QA_TASK_ID" ]; then echo "$QA_TASK_ID $$ $*" >> "${d}/workers.log"; exec sleep 600; fi
if [ "$1" = "--list-models" ]; then ${list}; fi
exec ${realPi} "$@"
`);
	chmodSync(join(d, "pi"), 0o755);
}
// Isolated pi agent dir: auth + provider models copied so the SDK starts and the real model list is shown.
const agentDir = join(TMP, "pi-agent");
mkdirSync(agentDir);
const realAgent = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
for (const f of ["auth.json", "models.json", "models-store.json", "tokenjoy.json", "tokenjoy-models-cache.json"]) if (existsSync(join(realAgent, f))) cpSync(join(realAgent, f), join(agentDir, f));
if (existsSync(join(realAgent, "extensions"))) cpSync(join(realAgent, "extensions"), join(agentDir, "extensions"), { recursive: true });
const s0 = existsSync(join(realAgent, "settings.json")) ? JSON.parse(readFileSync(join(realAgent, "settings.json"), "utf8")) : {};
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: s0.defaultProvider, defaultModel: s0.defaultModel, packages: [REPO] }));

const H = {
	a: { id: "demo-a", port: PORT, home: join(TMP, "home-a"), session: `qa-e2e-wm-${process.pid}-a` },
	b: { id: "demo-b", port: PORT + 1, home: join(TMP, "home-b"), session: `qa-e2e-wm-${process.pid}-b` },
};
for (const [k, h] of Object.entries(H)) {
	mkdirSync(join(h.home, "work"), { recursive: true });
	writeFileSync(join(h.home, "config.json"), JSON.stringify({
		host: "127.0.0.1", port: h.port, uiPort: UI_PORT, token: `tok-${k}`, model: "tokenjoy/claude-opus-5-5", tmuxSession: h.session, defaultCwd: join(h.home, "work"),
		machine: { id: h.id, priority: k === "a" ? 1 : 50 }, mesh: { secret: "e2e-wm", peers: k === "b" ? [{ url: `http://127.0.0.1:${PORT}` }] : [] }, update: { enabled: false },
	}, null, 2));
}
const envFor = (k) => {
	const env = { ...process.env, QA_HOME: H[k].home, PI_CODING_AGENT_DIR: agentDir, PATH: `${bins[k]}:${process.env.PATH}`, NODE_NO_WARNINGS: "1" };
	for (const v of Object.keys(env)) if ((v.startsWith("QA_") && v !== "QA_HOME") || (v.startsWith("PI_") && v !== "PI_CODING_AGENT_DIR") || v === "TMUX") delete env[v];
	return env;
};
const procs = [];
for (const k of ["a", "b"]) {
	const out = openSync(join(H[k].home, "hub.log"), "a");
	procs.push(spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: envFor(k), stdio: ["ignore", out, out] }));
}
const conf = (k) => JSON.parse(readFileSync(join(H[k].home, "config.json"), "utf8"));
const api = async (k, method, path, body) => {
	const r = await fetch(`http://127.0.0.1:${H[k].port}${path}`, { method, headers: { authorization: `Bearer tok-${k}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return r.json();
};
const workers = () => (existsSync(join(bins.a, "workers.log")) ? readFileSync(join(bins.a, "workers.log"), "utf8").trim().split("\n").filter(Boolean) : []);
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

let browser;
async function cleanup() {
	await browser?.close().catch(() => {});
	for (const p of procs) p.kill();
	for (const h of Object.values(H)) spawnSync("tmux", ["kill-session", "-t", `=${h.session}`]);
	if (!KEEP) rmSync(TMP, { recursive: true, force: true });
	else console.log(`kept ${TMP}`);
}
const fail = async (msg) => {
	console.error(`FAIL: ${msg}\n(logs under ${TMP})`);
	await cleanup();
	process.exit(1);
};

try {
	for (let i = 0; ; i++) {
		await sleep(250);
		const m = await api("b", "GET", "/api/machines").catch(() => undefined);
		if (m?.machines?.find((x) => x.id === "demo-a")?.online) break;
		if (i > 120) await fail("mesh did not converge");
	}
	log("mesh demo-a <-> demo-b up");
	const uiOut = openSync(join(H.a.home, "ui.log"), "a");
	procs.push(spawn(process.execPath, [join(REPO, "ui", "server.ts"), "--cwd", TMP, "--fresh-front"], { env: { ...envFor("a"), QA_UI_PORT: String(UI_PORT) }, stdio: ["ignore", uiOut, uiOut] }));
	for (let i = 0; ; i++) {
		await sleep(250);
		if (await fetch(`http://127.0.0.1:${UI_PORT}/health`).then((r) => r.ok, () => false)) break;
		if (i > 160) await fail("web ui did not start");
	}

	// a worker that is already running before the change
	const t1 = (await api("a", "POST", "/api/tasks", { title: "already running", brief: "keep going", machine: "demo-a", cwd: join(H.a.home, "work") })).task;
	for (let i = 0; i < 100 && !workers().length; i++) await sleep(100);
	const [w1] = workers();
	if (!w1?.includes("--model tokenjoy/claude-opus-5-5")) await fail(`first worker: ${w1}`);
	const w1pid = w1.split(" ")[1];
	log(`worker ${t1.id} running (pid ${w1pid}) with the inherited model`);

	browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
	const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
	await page.goto(`http://127.0.0.1:${UI_PORT}/?token=tok-a`);
	await page.waitForFunction(() => /WORKER\s*claude-opus-5-5/.test(document.getElementById("qaWm")?.textContent ?? ""), null, { timeout: 30_000 });
	const frontSel0 = await page.$eval("#modelSel", (s) => s.value).catch(() => "");
	if (process.env.E2E_DEBUG) log(await page.$$eval("header > *", (els) => els.map((e) => `${e.tagName}#${e.id}:${getComputedStyle(e).display}`).join(" ")));
	log(`header: "${(await page.textContent("#qaWm")).trim()}", front chat model select: "${frontSel0}"`);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true }), await page.screenshot({ path: join(SHOTS, "1-header.png") });

	await page.click("#qaWm");
	await page.waitForSelector('#qaWmP.open .m[data-m="demo-b"] select.mdl', { timeout: 60_000 });
	const nA = await page.$$eval('#qaWmP .m[data-m="demo-a"] select.mdl option', (o) => o.length);
	const nB = await page.$$eval('#qaWmP .m[data-m="demo-b"] select.mdl option', (o) => o.length);
	log(`panel: demo-a ${nA - 1} models, demo-b ${nB - 1} models; both "继承 model"`);
	if (SHOTS) await page.screenshot({ path: join(SHOTS, "2-panel.png") });

	// a model only demo-a has → partial failure
	const other = await page.$$eval('#qaWmP .m[data-m="demo-a"] select.mdl option', (o) => o.map((x) => x.value).find((v) => v && !/^tokenjoy\/(gpt-6\.1-sol|claude-opus-5-5)$/.test(v)));
	if (!other) await fail("demo-a lists no third model");
	await page.selectOption('#qaWmP .m[data-m="demo-a"] select.mdl', other);
	await page.click('#qaWmP button[data-act="all"]');
	await page.waitForSelector('#qaWmP .m[data-m="demo-b"] .sub.err', { timeout: 30_000 });
	const errText = await page.textContent('#qaWmP .m[data-m="demo-b"] .sub.err');
	log(`apply ${other} to all → demo-b: "${errText}"`);
	if (!/保存失败，未改动/.test(errText) || conf("b").workerModel !== undefined || conf("a").workerModel !== other) await fail("partial failure not reported / persisted wrongly");
	if (SHOTS) await page.screenshot({ path: join(SHOTS, "3-partial-failure.png") });

	// the real target, to every machine
	await page.selectOption('#qaWmP .m[data-m="demo-a"] select.mdl', TARGET);
	await page.click('#qaWmP button[data-act="all"]');
	await page.waitForFunction(() => [...document.querySelectorAll("#qaWmP .m .sub.okm")].length === 2, null, { timeout: 30_000 });
	await page.waitForFunction(() => /WORKER\s*gpt-6\.1-sol/.test(document.getElementById("qaWm")?.textContent ?? ""), null, { timeout: 10_000 });
	log(`apply ${TARGET} to all → "${(await page.textContent('#qaWmP .m[data-m="demo-b"] .sub.okm')).trim()}"`);
	if (SHOTS) await page.screenshot({ path: join(SHOTS, "4-saved.png") });

	// the next worker
	const t2 = (await api("a", "POST", "/api/tasks", { title: "after the change", brief: "noop", machine: "demo-a", cwd: join(H.a.home, "work") })).task;
	for (let i = 0; i < 100 && workers().length < 2; i++) await sleep(100);
	const w2 = workers().find((l) => l.startsWith(`${t2.id} `)) ?? "";
	const frontSel1 = await page.$eval("#modelSel", (s) => s.value).catch(() => "");
	const checks = {
		"demo-a config.json workerModel": conf("a").workerModel === TARGET,
		"demo-b config.json workerModel": conf("b").workerModel === TARGET,
		"model (front + fallback) unchanged on both": conf("a").model === "tokenjoy/claude-opus-5-5" && conf("b").model === "tokenjoy/claude-opus-5-5" && !("frontModel" in conf("a")),
		"front chat model select unchanged": frontSel1 === frontSel0,
		"running worker untouched (same pid, alive)": alive(w1pid) && (await api("a", "GET", `/api/tasks/${t1.id}`)).task.status !== "failed",
		"next worker launched with the new model": w2.includes(`--model ${TARGET}`),
	};
	for (const [k, v] of Object.entries(checks)) log(`${v ? "ok  " : "FAIL"} ${k}`);
	if (Object.values(checks).some((v) => !v)) await fail("checks failed");
	log("PASS");
	await cleanup();
} catch (e) {
	await fail(e.stack || String(e));
}
