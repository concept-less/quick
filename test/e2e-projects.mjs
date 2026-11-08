#!/usr/bin/env node
// End-to-end demo of the 按项目 list view in a fully isolated environment:
//   hub + Web UI from this checkout on temp ports, tasks of several projects (git remote, sub-directory of a
//   repo, page URL, text, config.json URL rule, unsorted) → headless Chromium: default 项目 view, block order
//   (需要你 first, 未归类 last), header counts, collapsing keeps 需要你 visible, the view choice and collapsed
//   blocks survive a reload, 注意力 view still works and shows project headers even with a single project.
// Stability: projects keep a fixed (creation / manual) order, tasks keep creation order; while workers keep
//   reporting activity and progress, a task turns into 需要你, another finishes and one is acknowledged, no card
//   moves, cards keep a fixed height, unchanged cards are not re-created (in-place DOM update) and the scroll
//   position stays. Dragging a project title reorders projects; the order is stored on the hub and survives a reload.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROMIUM=/path/to/chrome] node test/e2e-projects.mjs [--keep] [--shots DIR]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const SHOTS = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : undefined;
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "qa-e2e-projects-")));
const PORT = 21000 + Math.floor(Math.random() * 20000);
const UI_PORT = PORT + 1;
const HOME = join(TMP, "home");
const TOKEN = "e2e-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");

// ---------------------------------------------------------------- fixtures
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: gitEnv });
function repo(dir, remote) {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	if (remote) git(dir, "remote", "add", "origin", remote);
	return dir;
}
const qa = repo(join(TMP, "quick-agent"), "git@github.com:concept-less/quick.git");
const tj = repo(join(TMP, "tokenjoy"), "git@github.com:concept-less/tokenjoy.git");
mkdirSync(join(tj, "web"), { recursive: true });
const relay = join(TMP, "relay-website");
const plain = join(TMP, "work");
for (const d of [relay, plain, join(HOME, "tasks")]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME, "config.json"), JSON.stringify({ host: "127.0.0.1", port: PORT, uiPort: UI_PORT, token: TOKEN, tmuxSession: `qa-e2epj-${process.pid}`, defaultCwd: plain, machine: { id: "demo" }, projects: [{ match: "admin.tokenjoy.org", cwd: relay }], update: { enabled: false } }));
const env = { ...process.env, QA_HOME: HOME, QA_PORT: String(PORT), QA_UI_PORT: String(UI_PORT), QA_UPDATE: "off", NODE_NO_WARNINGS: "1" };
for (const k of ["QA_TASK_ID", "QA_ROLE", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE", "TMUX"]) delete env[k];
const api = async (method, path, body) => {
	const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const j = await r.json();
	if (!r.ok) throw new Error(`${path}: ${j.error}`);
	return j;
};
const report = (id, body) => api("POST", `/api/tasks/${id}/report`, body);
const quick = (...args) => execFileSync(process.execPath, [join(REPO, "cli", "quick.ts"), ...args], { env, encoding: "utf8", timeout: 120_000 });

const now = Date.now();
let n = 0;
const fixture = (id, title, cwd, status, extra = {}) => {
	n++;
	mkdirSync(join(HOME, "tasks", id), { recursive: true });
	const t = { id, machine: "demo", rev: 1, title, brief: title, cwd, status, statusSince: now - n * 60_000, createdAt: now - 3_600_000 - n * 60_000, updatedAt: now - n * 60_000, source: { kind: "cli" }, attachments: [], unread: status !== "running", messages: 0, ...extra };
	writeFileSync(join(HOME, "tasks", id, "task.json"), JSON.stringify(t));
};
const ask = (q) => ({ ask: { question: q, options: ["好", "先不要"] } });
// quick-agent: git remote
fixture("tq001", "Web UI 左侧按项目归类", qa, "needs_input", ask("默认用「按项目」视图？"));
fixture("tq002", "巡检 agent", qa, "idle");
fixture("tq003", "发布 v0.4.2", qa, "done", { summary: "已推送。" });
fixture("tq005", "预期时间 + 超时巡检", qa, "running");
fixture("tk004", "账单导出", tj, "running");
fixture("tu003", "跑一遍基准测试", plain, "running");
fixture("tq004", "整理提交", qa, "done", { unread: false, ackedAt: now - 1000, closed: true });
// tokenjoy: sub-directory of the repo, page URL (learned from tk001), title text
fixture("tk001", "控制台共享页去掉说明小字", join(tj, "web"), "done", { summary: "已删除说明小字。", source: { kind: "browser", url: "http://10.144.144.2:5173/console/accounts" } });
fixture("tk002", "积分页标题对齐", plain, "needs_input", { ...ask("按钮放右边？"), source: { kind: "browser", url: "http://10.144.144.2:5173/console/credits" } });
fixture("tk003", "诊断 tokenjoy API 请求超时", "/tmp", "done", { summary: "上游 502。" });
// relay-website: config.json URL rule
fixture("tr001", "控制台用户列表分页", plain, "done", { unread: false, ackedAt: now - 1000, closed: true, source: { kind: "browser", url: "https://admin.tokenjoy.org/console/users" } });
fixture("tr002", "用户列表行显示问题", plain, "done", { summary: "已修复。", source: { kind: "browser", url: "https://admin.tokenjoy.org/console/users" } });
// unsorted
fixture("tu001", "调度验收：默认派单", plain, "needs_input", ask("继续？"));
fixture("tu002", "测试：创建 /tmp/x.txt", "/tmp", "done", { summary: "已创建。" });

// ---------------------------------------------------------------- run
let browser;
async function cleanup() {
	await browser?.close().catch(() => {});
	for (const f of ["ui.pid", "hub.pid"]) {
		try {
			process.kill(Number(readFileSync(join(HOME, f), "utf8")), "SIGTERM");
		} catch {}
	}
	spawnSync("tmux", ["kill-session", "-t", `=qa-e2epj-${process.pid}`]);
	if (!KEEP) rmSync(TMP, { recursive: true, force: true });
}
const checks = {};
const check = (name, ok) => ((checks[name] = !!ok), log(`${ok ? "ok  " : "FAIL"} ${name}`));
const shot = async (page, name) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, name) });
};
const blocks = (page) =>
	page.$$eval("#tlist .pblk", (els) => els.map((e) => ({ name: e.querySelector(".pname").textContent, counts: e.querySelector(".pcs").textContent, closed: e.classList.contains("closed") })));
const cardsOf = (page, key) =>
	page.evaluate((key) => {
		const out = [];
		let el = document.querySelector(`#tlist .pblk[data-pb="${key}"]`)?.nextElementSibling;
		for (; el && !el.classList.contains("pblk"); el = el.nextElementSibling) if (el.classList.contains("titem")) out.push(el.dataset.id);
		return out;
	}, key);

try {
	log("quick ui --no-open");
	process.stdout.write(quick("ui", "--no-open", "--cwd", plain).replace(/^/gm, "    "));
	await sleep(1500);
	process.stdout.write(quick("projects").replace(/^/gm, "    "));

	browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`http://127.0.0.1:${UI_PORT}/?token=${TOKEN}`);
	await page.waitForSelector("#tlist .pblk", { timeout: 20_000 });
	await sleep(500);
	check("default view is 项目", (await page.getAttribute('#vbar [data-view="proj"]', "class"))?.includes("on"));
	let b = await blocks(page);
	log(JSON.stringify(b));
	const names = b.map((x) => x.name);
	check(`block order: fixed by project creation, 未归类 last (${names.join(" > ")})`, names.join() === "quick-agent,relay-website,tokenjoy,未归类");
	const bq = b.find((x) => x.name === "quick-agent"), bt = b.find((x) => x.name === "tokenjoy"), br = b.find((x) => x.name === "relay-website");
	check(`quick-agent counts (${bq?.counts})`, /需要你 2/.test(bq?.counts) && /待扫 1/.test(bq?.counts));
	check(`tokenjoy counts (${bt?.counts}): sub-directory, page URL and title all classified`, /需要你 1/.test(bt?.counts) && /运行中 1/.test(bt?.counts) && /待扫 2/.test(bt?.counts));
	check(`relay-website counts (${br?.counts})`, br?.counts === "待扫 1");
	const tk = await cardsOf(page, "tokenjoy");
	check(`tokenjoy block: creation order, newest first, whatever the status (${tk.join(",")})`, tk.join() === "tk004,tk001,tk002,tk003");
	check("top bar 需要你 = 4", (await page.textContent("#needN")) === "4");
	await shot(page, "1-projects.png");

	// collapse tokenjoy + quick-agent: their 需要你 cards stay
	await page.click('#tlist .pblk[data-pb="tokenjoy"] .pname');
	await page.click('#tlist .pblk[data-pb="quick-agent"] .pname');
	await sleep(200);
	const tkc = await cardsOf(page, "tokenjoy");
	check(`collapsed tokenjoy still shows its 需要你 card (${tkc.join(",")})`, tkc.join() === "tk002");
	check("collapsed block shows folded count", /已折叠 3 件/.test((await page.textContent("#tlist")) ?? ""));
	await shot(page, "2-collapsed.png");

	await page.reload();
	await page.waitForSelector("#tlist .pblk", { timeout: 20_000 });
	await sleep(400);
	b = await blocks(page);
	check("after reload: still 项目 view, collapsed blocks remembered", (await page.getAttribute('#vbar [data-view="proj"]', "class"))?.includes("on") && b.find((x) => x.name === "tokenjoy")?.closed && !b.find((x) => x.name === "relay-website")?.closed);

	// switch to 注意力, reload, still 注意力
	await page.click('#vbar [data-view="attn"]');
	await page.reload();
	await page.waitForSelector("#tlist .lvh", { timeout: 20_000 });
	await sleep(400);
	check("after reload: 注意力 view remembered", (await page.getAttribute('#vbar [data-view="attn"]', "class"))?.includes("on") && !(await page.$("#tlist .pblk")));
	await shot(page, "3-attention.png");
	// a single project (search) still shows its project header
	await page.fill("#tsearch", "tokenjoy");
	await sleep(300);
	const heads = await page.$$eval("#tlist .phead .pname", (els) => els.map((e) => e.textContent));
	check(`注意力 view, one project: header still shown (${heads.join(",")})`, heads.length >= 1 && heads.every((h) => h === "tokenjoy"));
	await page.fill("#tsearch", "");
	await page.click('#vbar [data-view="proj"]');
	await page.waitForSelector("#tlist .pblk");
	// 需要你 button jumps to a 需要你 card in the project view
	await page.click("#needBtn");
	await sleep(600);
	check("需要你 button focuses a 需要你 card", await page.evaluate(() => document.activeElement?.classList.contains("need")));

	// ---------------------------------------------------------------- stability under live updates
	await page.click("#needBtn"); // focus moves; reset collapsed state for a full list
	await page.evaluate(() => {
		localStorage.qaProjBlkCollapsed = "[]";
	});
	await page.reload();
	await page.waitForSelector("#tlist .pblk", { timeout: 20_000 });
	await page.setViewportSize({ width: 1400, height: 1500 });
	await sleep(500);
	const layout = () =>
		page.evaluate(() => {
			const cards = [...document.querySelectorAll("#tlist .titem")];
			return {
				ids: cards.map((e) => e.dataset.id),
				tops: Object.fromEntries(cards.map((e) => [e.dataset.id, Math.round(e.getBoundingClientRect().top)])),
				heights: [...new Set(cards.map((e) => e.offsetHeight))],
				blocks: [...document.querySelectorAll("#tlist .pblk")].map((e) => e.dataset.pb),
				kept: cards.filter((e) => e.__mark).map((e) => e.dataset.id),
				marks: Object.fromEntries(cards.map((e) => [e.dataset.id, e.querySelector(".mark").textContent])),
				scroll: document.querySelector("#tlist").scrollTop,
			};
		});
	// tag every card node: nodes of cards whose content did not change must survive the updates
	await page.evaluate(() => document.querySelectorAll("#tlist .titem").forEach((e) => (e.__mark = 1)));
	const before = await layout();
	log("before:", before.ids.join(","));
	const notes = ["读 web/src/console/Credits.tsx", "跑测试", "修改 web/src/styles/personal.css 里的 .pa-head 对齐以及移动端的 align-items，顺带检查积分页 header 在 640px 以下的表现", "推送代码", "x"];
	const frames = [];
	let stop = false;
	const pump = (async () => {
		for (let k = 0; !stop; k++) {
			for (const id of ["tq005", "tk004", "tu003"]) {
				await report(id, { activity: `bash ${notes[(k + id.length) % notes.length]}`, kind: "activity" }).catch(() => {});
				if (k % 3 === 0) await report(id, { kind: "progress", progress: k === 0 ? { plan: ["读代码", "改样式", "跑测试", "推送"], current: 1, note: "开始" } : { current: 1 + (k % 4), note: notes[k % notes.length] } }).catch(() => {});
			}
			await sleep(250);
		}
	})();
	for (let f = 0; f < 12; f++) {
		await sleep(600);
		if (f === 3) await report("tu003", { needsHuman: true, question: "基准要跑全量吗？", options: ["全量", "抽样"] });
		if (f === 6) await report("tk004", { status: "done", summary: "账单已导出。" });
		const l = await layout();
		frames.push(l);
		if (SHOTS) {
			mkdirSync(join(SHOTS, "frames"), { recursive: true });
			await page.locator("#side").screenshot({ path: join(SHOTS, "frames", `f${String(f).padStart(2, "0")}.png`) });
		}
	}
	const afterUpdates = frames.at(-1);
	check(`order unchanged through ${frames.length} frames of live activity/progress/status changes`, frames.every((l) => l.ids.join() === before.ids.join() && l.blocks.join() === before.blocks.join()));
	check("no card moved (same top in every frame)", frames.every((l) => before.ids.every((id) => l.tops[id] === before.tops[id])));
	check(`cards have one fixed height (${[...new Set(frames.flatMap((l) => l.heights))].join(",")}px)`, new Set(frames.flatMap((l) => l.heights)).size === 1);
	check(`status changes only change the mark (tu003 ${before.marks.tu003} → ${afterUpdates.marks.tu003}, tk004 ${before.marks.tk004} → ${afterUpdates.marks.tk004})`, afterUpdates.marks.tu003 === "[ASK]" && afterUpdates.marks.tk004 === "[DONE]");
	check(`in-place update: untouched cards keep their DOM node (${afterUpdates.kept.length}/${afterUpdates.ids.length} kept)`, ["tq001", "tq003", "tk001", "tk002", "tk003", "tr002", "tu001", "tu002"].every((id) => afterUpdates.kept.includes(id)));
	check("top bar 需要你 counts the new question (5)", (await page.textContent("#needN")) === "5");
	// acknowledging a finished task removes only that card; the others keep their relative order
	await api("POST", "/api/tasks/tq003/ack");
	await sleep(800);
	const acked = await layout();
	check(`acknowledged card leaves, the rest keep their order (${acked.ids.join(",")})`, acked.ids.join() === before.ids.filter((x) => x !== "tq003").join());
	stop = true;
	await pump;
	// scroll position survives updates (small viewport, scrolled down)
	await page.setViewportSize({ width: 1400, height: 700 });
	await page.evaluate(() => (document.querySelector("#tlist").scrollTop = 240));
	await report("tq005", { activity: "bash 跑测试", kind: "activity" });
	await report("tu002", { summary: "已创建，并补了一句。" });
	await sleep(800);
	check("scroll position kept across updates", (await page.evaluate(() => document.querySelector("#tlist").scrollTop)) === 240);
	await page.setViewportSize({ width: 1400, height: 900 });
	await page.evaluate(() => (document.querySelector("#tlist").scrollTop = 0));
	await shot(page, "4-after-updates.png");

	// ---------------------------------------------------------------- manual project order (drag), stored on the hub
	await page.dragAndDrop('#tlist .pblk[data-pb="tokenjoy"] .pname', '#tlist .pblk[data-pb="quick-agent"] .pname', { targetPosition: { x: 5, y: 2 } });
	await sleep(800);
	let order = (await blocks(page)).map((x) => x.name);
	check(`drag tokenjoy above quick-agent (${order.join(" > ")})`, order.join() === "tokenjoy,quick-agent,relay-website,未归类");
	const hubOrder = (await api("GET", "/api/projects")).projects.filter((p) => !p.mergedInto).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map((p) => p.id);
	check(`order stored on the hub (${hubOrder.join(",")})`, hubOrder.slice(0, 3).join() === "tokenjoy,quick-agent,relay-website");
	await page.reload();
	await page.waitForSelector("#tlist .pblk", { timeout: 20_000 });
	await sleep(400);
	order = (await blocks(page)).map((x) => x.name);
	check(`after reload the manual order stays (${order.join(" > ")})`, order.join() === "tokenjoy,quick-agent,relay-website,未归类");
	// keyboard: Alt+↓ moves the focused project down
	await page.focus('#tlist .pblk[data-pb="tokenjoy"]');
	await page.keyboard.press("Alt+ArrowDown");
	await sleep(600);
	order = (await blocks(page)).map((x) => x.name);
	check(`Alt+↓ moves a project down (${order.join(" > ")})`, order.join() === "quick-agent,tokenjoy,relay-website,未归类");
	await shot(page, "5-reordered.png");

	const failed = Object.entries(checks).filter(([, ok]) => !ok);
	log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(" | ")}` : `all ${Object.keys(checks).length} checks passed`);
	if (SHOTS) log(`screenshots in ${SHOTS}`);
	await cleanup();
	process.exit(failed.length ? 1 : 0);
} catch (e) {
	log("error:", e);
	await cleanup();
	process.exit(1);
}
