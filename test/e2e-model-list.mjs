#!/usr/bin/env node
// End-to-end check of the Web UI model lists (front chat model select + WORKER default model panel) in a fully isolated
// environment, with a large dynamic catalog:
//   isolated pi agent dir with a provider extension "fakeprov" (pi.registerProvider + refreshModels, the official
//   discovery mechanism) serving 35 models from a file → hub demo-a (real pi, same agent dir) with the Web UI, hub
//   demo-b over the mesh with a fake pi listing 31 different models → headless Chromium:
//   1. front select and WORKER panel both show all 35 fakeprov models, grouped by provider, same set (front = worker)
//   2. demo-b shows its own 31 models (cross-machine difference)
//   3. the catalog grows to 37 → front ↻ and panel 刷新列表 pick it up without restarting anything
//   4. discovery fails → both keep the 37-model list and say so (toast / stale note); the front model never changes
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROMIUM=…] node test/e2e-model-list.mjs [--keep] [--shots DIR]
//
// Needs: tmux, pi. No model is called.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const SHOTS = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : undefined;
const TMP = mkdtempSync(join(tmpdir(), "qa-e2e-models-"));
const PORT = 24000 + Math.floor(Math.random() * 20000);
const UI_PORT = PORT + 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
const realPi = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();

// ---------------------------------------------------------------- isolated pi agent dir with a dynamic provider
const agentDir = join(TMP, "pi-agent");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
const catalog = join(agentDir, "fake-catalog.json");
const failFlag = join(agentDir, "fake-catalog.fail");
const model = (i) => ({ id: `fake-model-${String(i).padStart(2, "0")}`, name: `Fake ${i}`, reasoning: i % 3 === 0, input: i % 4 === 0 ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000 + i * 1000, maxTokens: 32000 });
const writeCatalog = (n) => writeFileSync(catalog, JSON.stringify(Array.from({ length: n }, (_, i) => model(i + 1))));
writeCatalog(35);
writeFileSync(join(agentDir, "extensions", "fakeprov.ts"), `
import { existsSync, readFileSync } from "node:fs";
const load = () => { if (existsSync(${JSON.stringify(failFlag)})) throw new Error("catalog endpoint down (HTTP 503)"); return JSON.parse(readFileSync(${JSON.stringify(catalog)}, "utf8")); };
export default function (pi) {
	let first = [];
	try { first = load(); } catch (e) { console.error("[fakeprov] " + e.message); }
	// Same contract as a real discovery extension: no network → current list; success → update the registered array in
	// place (pi rebuilds providers from the registration before every refresh); failure → throw (pi reports it).
	pi.registerProvider("fakeprov", { name: "Fake", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", api: "openai-completions", models: first,
		refreshModels: async (ctx) => { if (!ctx?.allowNetwork) return [...first]; const next = load(); first.splice(0, first.length, ...next); return next; } });
}
`);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fakeprov", defaultModel: "fake-model-01", packages: [REPO] }));

// demo-a: real pi (workers would get a recorder); demo-b: fixed table of 31 other models
const bins = { a: join(TMP, "bin-a"), b: join(TMP, "bin-b") };
const tableB = ["provider  model  context  max-out  thinking  images", ...Array.from({ length: 31 }, (_, i) => `otherprov  other-${i + 1}  128K  16K  ${i % 2 ? "yes" : "no"}  no`)].join("\\n");
for (const [k, d] of Object.entries(bins)) {
	mkdirSync(d);
	writeFileSync(join(d, "pi"), `#!/usr/bin/env bash
if [ -n "$QA_TASK_ID" ]; then exec sleep 600; fi
${k === "b" ? `if [ "$1" = "--list-models" ]; then printf '${tableB}\\n'; exit 0; fi\n` : ""}exec ${realPi} "$@"
`);
	chmodSync(join(d, "pi"), 0o755);
}

const H = {
	a: { id: "demo-a", port: PORT, home: join(TMP, "home-a"), session: `qa-e2e-ml-${process.pid}-a` },
	b: { id: "demo-b", port: PORT + 1, home: join(TMP, "home-b"), session: `qa-e2e-ml-${process.pid}-b` },
};
for (const [k, h] of Object.entries(H)) {
	mkdirSync(join(h.home, "work"), { recursive: true });
	writeFileSync(join(h.home, "config.json"), JSON.stringify({
		host: "127.0.0.1", port: h.port, uiPort: UI_PORT, token: `tok-${k}`, model: "fakeprov/fake-model-01", tmuxSession: h.session, defaultCwd: join(h.home, "work"),
		machine: { id: h.id, priority: k === "a" ? 1 : 50 }, mesh: { secret: "e2e-ml", peers: k === "b" ? [{ url: `http://127.0.0.1:${PORT}` }] : [] }, update: { enabled: false },
	}, null, 2));
}
const envFor = (k) => {
	const env = { ...process.env, QA_HOME: H[k].home, PI_CODING_AGENT_DIR: agentDir, PATH: `${bins[k]}:${process.env.PATH}`, NODE_NO_WARNINGS: "1" };
	// No identity, no real provider credentials: only fakeprov is available.
	for (const v of Object.keys(env)) if ((v.startsWith("QA_") && v !== "QA_HOME") || (v.startsWith("PI_") && v !== "PI_CODING_AGENT_DIR") || v === "TMUX" || /API_KEY|AUTH_TOKEN|ANTHROPIC|OPENAI|TOKENJOY|GEMINI|ASTERGATE/.test(v)) delete env[v];
	return env;
};
const procs = [];
for (const k of ["a", "b"]) {
	const out = openSync(join(H[k].home, "hub.log"), "a");
	procs.push(spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: envFor(k), stdio: ["ignore", out, out] }));
}
const api = async (k, path) => (await fetch(`http://127.0.0.1:${H[k].port}${path}`, { headers: { authorization: `Bearer tok-${k}` } })).json();

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
const checks = {};
const check = (name, ok, detail = "") => {
	checks[name] = ok;
	log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
	for (let i = 0; ; i++) {
		await sleep(250);
		const m = await api("b", "/api/machines").catch(() => undefined);
		if (m?.machines?.find((x) => x.id === "demo-a")?.online) break;
		if (i > 120) await fail("mesh did not converge");
	}
	const uiOut = openSync(join(H.a.home, "ui.log"), "a");
	procs.push(spawn(process.execPath, [join(REPO, "ui", "server.ts"), "--cwd", TMP, "--fresh-front"], { env: { ...envFor("a"), QA_UI_PORT: String(UI_PORT) }, stdio: ["ignore", uiOut, uiOut] }));
	for (let i = 0; ; i++) {
		await sleep(250);
		if (await fetch(`http://127.0.0.1:${UI_PORT}/health`).then((r) => r.ok, () => false)) break;
		if (i > 160) await fail("web ui did not start");
	}
	browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	await page.goto(`http://127.0.0.1:${UI_PORT}/?token=tok-a`);
	const front = () => page.$$eval("#modelSel optgroup", (gs) => Object.fromEntries(gs.map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.value)])));
	const frontIds = async () => Object.values(await front()).flat().sort();
	const frontValue = () => page.$eval("#modelSel", (s) => s.value);
	await page.waitForFunction(() => document.querySelectorAll("#modelSel optgroup option").length >= 35, null, { timeout: 30_000 });
	const f1 = await front();
	check("front: 35 models grouped by provider", JSON.stringify(Object.keys(f1)) === JSON.stringify(["fakeprov · 35"]), Object.keys(f1).join(", "));
	const meta = await page.$eval('#modelSel option[value="fakeprov/fake-model-03"]', (o) => o.title);
	check("front: capability metadata kept", /可思考/.test(meta) && /203K 上下文/.test(meta), meta);
	const value0 = await frontValue();

	await page.click("#qaWm");
	await page.waitForSelector('#qaWmP.open .m[data-m="demo-b"] select.mdl', { timeout: 60_000 });
	const panel = (m) => page.$$eval(`#qaWmP .m[data-m="${m}"] select.mdl option`, (os) => os.map((o) => o.value).filter(Boolean).sort());
	const wa = await panel("demo-a");
	check("worker panel demo-a: same 35 models as the front (same pi config)", JSON.stringify(wa) === JSON.stringify(await frontIds()), `${wa.length} vs front`);
	const wb = await panel("demo-b");
	check("worker panel demo-b: its own 31 models", wb.length === 31 && wb.every((v) => v.startsWith("otherprov/")), `${wb.length}`);
	await page.fill('#qaWmP input.flt[data-m="demo-a"]', "model-1");
	const visible = await page.$$eval('#qaWmP .m[data-m="demo-a"] select.mdl option', (os) => os.filter((o) => o.value && !o.hidden).length);
	check("worker panel search filters the picker", visible === 10, `${visible} visible for "model-1"`);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true }), await page.screenshot({ path: join(SHOTS, "1-panel-35.png") });
	await page.fill('#qaWmP input.flt[data-m="demo-a"]', "");
	await page.keyboard.press("Escape");

	// catalog grows: refresh picks it up (no restart)
	writeCatalog(37);
	await page.click("#modelRefresh");
	await page.waitForFunction(() => document.querySelectorAll("#modelSel optgroup option").length === 37, null, { timeout: 30_000 }).catch(() => {});
	check("front ↻: 37 models after the catalog grew", (await frontIds()).length === 37);
	await page.click("#qaWm");
	await page.click('#qaWmP button[data-act="refresh"]');
	await page.waitForFunction(() => document.querySelectorAll('#qaWmP .m[data-m="demo-a"] select.mdl option').length === 38, null, { timeout: 60_000 }).catch(() => {});
	const wa2 = await panel("demo-a");
	check("worker 刷新列表: demo-a 37 models, equal to the front", wa2.length === 37 && JSON.stringify(wa2) === JSON.stringify(await frontIds()));
	if (SHOTS) await page.screenshot({ path: join(SHOTS, "2-refreshed-37.png") });
	await page.keyboard.press("Escape");

	// discovery fails: keep the old list and say so
	writeFileSync(failFlag, "");
	await page.click("#modelRefresh");
	const toast = await page.waitForSelector(".toast.error", { timeout: 30_000 }).then((t) => t.textContent()).catch(() => "");
	check("front ↻ failure: error shown", /fakeprov/.test(toast) && /上次的列表/.test(toast), toast.trim());
	check("front ↻ failure: old 37-model list kept", (await frontIds()).length === 37);
	const hubInfo = await api("a", "/api/worker-model?refresh=1");
	// a pi start with a failing extension still lists what the extension registered (empty here) → listing fails → stale list
	await page.click("#qaWm");
	await page.click('#qaWmP button[data-act="refresh"]');
	await page.waitForSelector('#qaWmP .m[data-m="demo-a"] .sub.err', { timeout: 60_000 }).catch(() => {});
	const note = (await page.textContent('#qaWmP .m[data-m="demo-a"]').catch(() => "")) ?? "";
	const wa3 = await panel("demo-a");
	check("worker 刷新列表 failure: stale note + old list kept", (hubInfo.stale === true && /上次列表/.test(note) && wa3.length === 37) || (!hubInfo.listError && wa3.length === 37), hubInfo.listError ? `hub: ${hubInfo.listError}` : "listing still succeeded");
	if (SHOTS) await page.screenshot({ path: join(SHOTS, "3-refresh-failed.png") });
	check("front model never changed", (await frontValue()) === value0, value0);
	rmSync(failFlag);

	if (Object.values(checks).some((v) => !v)) await fail("checks failed");
	log("PASS");
	await cleanup();
} catch (e) {
	await fail(e.stack || String(e));
}
