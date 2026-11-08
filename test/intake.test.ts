// Browser comments are one-shot (isolated hub): delivered + claimed = consumed, never delivered again
// (also not after a hub restart); appending to an existing task with intakeId links it and copies the
// screenshots into the task; consumed comments are pruned after the retention period.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "qa-intake-")));
const HOME = join(TMP, "qa-home");
const PORT = 20000 + Math.floor(Math.random() * 20000);
// A no-op tmux first on PATH: dispatching never starts a real worker.
const BIN = join(TMP, "bin");
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, "tmux"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BIN, "tmux"), 0o755);
const baseEnv = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, NODE_NO_WARNINGS: "1", QA_HOME: HOME, QA_PORT: String(PORT), QA_MACHINE: "cloud", QA_UPDATE: "off" };
for (const k of ["QA_TASK_ID", "QA_HUB_URL", "QA_TOKEN", "QA_MACHINE_PRIORITY", "QA_INTAKE_RETENTION_HOURS"]) delete (baseEnv as any)[k];
// 1x1 png
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let hub: ChildProcess | undefined;
async function raw(method: string, path: string, body?: any) {
	return fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
async function api(method: string, path: string, body?: any) {
	const r = await raw(method, path, body);
	const json = (await r.json()) as any;
	if (!r.ok) throw Object.assign(new Error(`${path}: ${json.error}`), { status: r.status });
	return json;
}
async function start(env: Record<string, string> = {}) {
	hub = spawn(process.execPath, [join(REPO, "hub", "server.ts")], { env: { ...baseEnv, ...env }, stdio: "ignore" });
	for (let i = 0; i < 60; i++) {
		await new Promise((r) => setTimeout(r, 150));
		try {
			await api("GET", "/health");
			return;
		} catch {}
	}
	throw new Error("hub did not start");
}
async function stop() {
	if (!hub) return;
	const h = hub;
	hub = undefined;
	await new Promise((r) => {
		h.once("exit", r);
		h.kill("SIGTERM");
	});
}

/** A fake worker for task `id` subscribed to the hub: collects the follow-up messages it receives. */
function fakeWorker(id: string) {
	const ac = new AbortController();
	const messages: string[] = [];
	const ready = (async () => {
		const r = await fetch(`http://127.0.0.1:${PORT}/api/events?role=worker&task=${id}`, { headers: { authorization: "Bearer tok" }, signal: ac.signal });
		const reader = r.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let hello: () => void;
		const helloP = new Promise<void>((res) => (hello = res));
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let k: number;
					while ((k = buf.indexOf("\n\n")) >= 0) {
						const chunk = buf.slice(0, k);
						buf = buf.slice(k + 2);
						const line = chunk.split("\n").find((l) => l.startsWith("data: "));
						if (!line) continue;
						const e = JSON.parse(line.slice(6));
						if (e.type === "hello") hello();
						if (e.type === "task.message" && e.taskId === id) messages.push(e.text);
					}
				}
			} catch {}
		})();
		await helloP;
	})();
	return { ready, messages, close: () => ac.abort() };
}

const comment = (text: string) => api("POST", "/api/intake", { comment: text, url: "https://app.example.org/page", title: "Page", mode: "element", elements: [{ tag: "button", selector: "#go" }], screenshots: [{ name: "selection", dataUrl: PNG }] });
const pending = async () => ((await api("GET", "/api/intake?status=pending")).intake as any[]).map((i) => i.id);

before(async () => {
	const cwd = join(TMP, "work");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(HOME, "tasks", "tz001"), { recursive: true });
	writeFileSync(join(HOME, "config.json"), JSON.stringify({ host: "127.0.0.1", port: PORT, token: "tok", tmuxSession: `qa-intaketest-${process.pid}`, defaultCwd: cwd, update: { enabled: false } }));
	const now = Date.now();
	const task = { id: "tz001", machine: "cloud", rev: 1, title: "existing", brief: "existing", cwd, status: "running", createdAt: now, updatedAt: now, source: { kind: "tui" }, attachments: [], unread: false, messages: 0 };
	writeFileSync(join(HOME, "tasks", "tz001", "task.json"), JSON.stringify(task));
	await start();
});
after(async () => {
	await stop();
	rmSync(TMP, { recursive: true, force: true });
});

let first = "";
let shot = "";
let dispatched = "";

test("a comment is delivered once: claiming consumes it, a second claim fails", async () => {
	const { intake } = await comment("按钮颜色不对");
	first = intake.id;
	shot = intake.screenshots[0];
	assert.equal(intake.status, "pending");
	assert.ok(existsSync(shot));
	assert.deepEqual(await pending(), [first]);
	const c = await api("POST", `/api/intake/${first}/claim`, { by: "front-a" });
	assert.equal(c.intake.status, "consumed");
	assert.ok(c.intake.consumedAt > 0);
	assert.deepEqual(await pending(), []);
	await assert.rejects(api("POST", `/api/intake/${first}/claim`, { by: "front-b" }), (e: any) => e.status === 409);
	// nobody can put it back into the delivery queue
	await assert.rejects(api("POST", `/api/intake/${first}`, { status: "pending" }), (e: any) => e.status === 400);
	// pages show no marks for sent comments (older extensions poll this)
	assert.deepEqual((await api("GET", `/api/pages?url=${encodeURIComponent("https://app.example.org/page")}`)).comments, []);
});

test("a consumed comment is not delivered again after a hub restart", async () => {
	await stop();
	await start();
	assert.deepEqual(await pending(), []);
	assert.equal((await api("GET", `/api/intake/${first}`)).intake.status, "consumed");
	await assert.rejects(api("POST", `/api/intake/${first}/claim`, { by: "front-a" }), (e: any) => e.status === 409);
});

test("qa_task_send with intake_id links the comment to an existing task and copies its screenshots", async () => {
	const w = fakeWorker("tz001");
	await w.ready;
	await api("POST", `/api/tasks/tz001/message`, { text: `追加：按钮颜色不对\n截图: ${shot}`, intakeId: first });
	for (let i = 0; i < 40 && !w.messages.length; i++) await new Promise((r) => setTimeout(r, 50));
	w.close();
	const { intake } = await api("GET", `/api/intake/${first}`);
	assert.equal(intake.status, "dispatched");
	assert.equal(intake.taskId, "tz001");
	const { task } = await api("GET", "/api/tasks/tz001");
	const copied = task.attachments.find((a: string) => a.startsWith(join(HOME, "tasks", "tz001", "attachments")));
	assert.ok(copied && existsSync(copied), `copied screenshot in ${JSON.stringify(task.attachments)}`);
	assert.equal(w.messages.length, 1);
	assert.ok(w.messages[0]!.includes(copied), "message points at the task's copy");
	const img = await raw("GET", `/api/tasks/tz001/attachment?n=${task.attachments.indexOf(copied)}`);
	assert.equal(img.headers.get("content-type"), "image/png");
	assert.deepEqual(Buffer.from(await img.arrayBuffer()), readFileSync(copied));
	// still never delivered again
	assert.deepEqual(await pending(), []);
	await stop();
	await start();
	assert.deepEqual(await pending(), []);
});

test("qa_dispatch with intake_id: the new task gets its own copy of the screenshots", async () => {
	const { intake } = await comment("新需求");
	dispatched = intake.id;
	const { intake: c } = await api("POST", `/api/intake/${intake.id}/claim`, { by: "front-a" });
	const { task } = await api("POST", "/api/tasks", { title: "新需求", brief: `看截图 ${c.screenshots[0]}`, attachments: c.screenshots, source: { kind: "browser", intakeId: intake.id, url: c.url } });
	assert.equal(task.source.kind, "browser");
	assert.ok(task.attachments.every((a: string) => a.startsWith(join(HOME, "tasks", task.id, "attachments"))), JSON.stringify(task.attachments));
	assert.ok(task.brief.includes(task.attachments[0]));
	const { intake: linked } = await api("GET", `/api/intake/${intake.id}`);
	assert.deepEqual([linked.status, linked.taskId], ["dispatched", task.id]);
	assert.deepEqual(await pending(), []);
});

test("consumed comments are pruned after the retention period; pending ones and task copies stay", async () => {
	const { intake: open } = await comment("还没人处理");
	await stop();
	// a task from before this change that points straight into the intake directory
	mkdirSync(join(HOME, "tasks", "tz002"), { recursive: true });
	const now = Date.now();
	writeFileSync(join(HOME, "tasks", "tz002", "task.json"), JSON.stringify({ id: "tz002", machine: "cloud", rev: 1, title: "old", brief: `截图 ${shot}`, cwd: TMP, status: "done", createdAt: now, updatedAt: now, source: { kind: "browser", intakeId: first }, attachments: [shot], unread: false, messages: 0, closed: true }));
	await start({ QA_INTAKE_RETENTION_HOURS: "0" });
	assert.ok(!existsSync(join(HOME, "intake", first)), "consumed intake directory removed");
	assert.ok(!existsSync(join(HOME, "intake", dispatched)), "dispatched intake directory removed");
	const { task: old } = await api("GET", "/api/tasks/tz002");
	assert.ok(old.attachments[0].startsWith(join(HOME, "tasks", "tz002", "attachments")) && existsSync(old.attachments[0]), "old task's screenshot rescued");
	assert.ok(old.brief.includes(old.attachments[0]));
	await assert.rejects(api("GET", `/api/intake/${first}`), (e: any) => e.status === 404);
	assert.ok(existsSync(join(HOME, "intake", open.id)), "pending intake kept");
	assert.deepEqual(await pending(), [open.id]);
	const { task } = await api("GET", "/api/tasks/tz001");
	for (const a of task.attachments) assert.ok(existsSync(a), `task attachment ${a} survives`);
});

test("legacy files: a 'claimed' comment from an older hub counts as consumed", async () => {
	await stop();
	const id = "cold1";
	mkdirSync(join(HOME, "intake", id), { recursive: true });
	writeFileSync(join(HOME, "intake", id, "intake.json"), JSON.stringify({ id, machine: "cloud", rev: 2, createdAt: Date.now(), status: "claimed", kind: "browser-comment", comment: "old", elements: [], screenshots: [] }));
	await start();
	assert.ok(!(await pending()).includes(id));
	assert.equal((await api("GET", `/api/intake/${id}`)).intake.status, "consumed");
});
