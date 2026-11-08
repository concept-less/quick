// quick-agent Web UI: hosts the one continuous front agent in-process (pi SDK) and serves a browser GUI
// whose first screen is the attention queue, next to the front agent and browser comments.
// Listens on 127.0.0.1 only; protected by the hub token.
//
// There are no "sessions" for the human: the front is a single, continuous conversation. Internally it is
// persisted as a pi session file under ~/.quick-agent/ui-sessions/ (resumed on every start, kept short by
// pi's automatic compaction); that file is an implementation detail and never shown.
//
// Run: node ui/server.ts [--cwd DIR]   (normally via `quick ui`; --fresh-front starts an empty front, debug only)
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hubUrl, loadConfig, paths, REPO_ROOT } from "../shared/config.ts";
import { HubClient } from "../shared/hub-client.ts";
import { ensureHub } from "../shared/hub-process.ts";

// This process is a front agent, never a worker (it may be launched from inside a worker's shell).
delete process.env.QA_TASK_ID;
delete process.env.QA_ROLE;

const cfg = loadConfig();
const hub = new HubClient(cfg);
const HOST = "127.0.0.1";
const PORT = cfg.uiPort;
const argv = process.argv.slice(2);
const argVal = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const CWD = argVal("--cwd") ?? process.env.QA_UI_CWD ?? process.cwd();
const SESSION_DIR = paths.uiSessions;
mkdirSync(SESSION_DIR, { recursive: true });
// Stable front id: tasks dispatched from the Web UI stay "its" tasks across restarts (proactive delivery).
process.env.QA_FRONT_ID = `webui@${cfg.machine.id}`;

function log(msg: string) {
	console.log(`${new Date().toISOString()} ${msg}`);
}

// ---------------------------------------------------------------- pi SDK

/** Locate the installed pi package (global npm install) so plain Node can import the SDK. */
function piPackageRoot(): string {
	const candidates: string[] = [];
	if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
	try {
		let d = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
		for (let i = 0; i < 5; i++, d = dirname(d)) candidates.push(d);
	} catch {}
	try {
		candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"));
	} catch {}
	for (const c of candidates) {
		try {
			const pkg = JSON.parse(readFileSync(join(c, "package.json"), "utf8"));
			if (pkg.name === "@earendil-works/pi-coding-agent") return c;
		} catch {}
	}
	throw new Error("cannot find the @earendil-works/pi-coding-agent package (set PI_PACKAGE_DIR)");
}

const PI_ROOT = piPackageRoot();
const sdk: any = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")).href);

// ---------------------------------------------------------------- browser clients (SSE)

const clients = new Set<ServerResponse>();
function broadcast(e: unknown) {
	const frame = `data: ${JSON.stringify(e)}\n\n`;
	for (const c of clients) c.write(frame);
}

// ---------------------------------------------------------------- extension UI bridge

interface Dialog {
	id: string;
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	resolve: (v: any) => void;
}
const dialogs = new Map<string, Dialog>();
const statuses = new Map<string, string>();
const widgets = new Map<string, string[]>();
let dialogSeq = 0;
let title = "";

function openDialog(d: Omit<Dialog, "id" | "resolve">, cancelValue: any, opts?: { signal?: AbortSignal; timeout?: number }): Promise<any> {
	return new Promise((resolve) => {
		const id = `d${++dialogSeq}`;
		let timer: NodeJS.Timeout | undefined;
		const finish = (v: any) => {
			if (!dialogs.delete(id)) return;
			if (timer) clearTimeout(timer);
			broadcast({ type: "ui.dialog.close", id });
			resolve(v);
		};
		dialogs.set(id, { ...d, id, resolve: finish });
		if (opts?.timeout) timer = setTimeout(() => finish(cancelValue), opts.timeout);
		opts?.signal?.addEventListener("abort", () => finish(cancelValue), { once: true });
		broadcast({ type: "ui.dialog", dialog: { ...d, id } });
	});
}
const publicDialogs = () => [...dialogs.values()].map(({ resolve: _r, ...d }) => d);

const uiImpl: Record<string, any> = {
	select: (t: string, options: string[], o?: any) => openDialog({ kind: "select", title: t, options }, undefined, o),
	confirm: (t: string, message: string, o?: any) => openDialog({ kind: "confirm", title: t, message }, false, o),
	input: (t: string, placeholder?: string, o?: any) => openDialog({ kind: "input", title: t, placeholder }, undefined, o),
	editor: (t: string, prefill?: string) => openDialog({ kind: "editor", title: t, prefill }, undefined),
	notify: (message: string, level = "info") => broadcast({ type: "ui.notify", message, level }),
	setStatus: (key: string, text: string | undefined) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
		broadcast({ type: "ui.status", statuses: Object.fromEntries(statuses) });
	},
	setWidget: (key: string, content: unknown) => {
		if (Array.isArray(content)) widgets.set(key, content.map(String));
		else widgets.delete(key);
		broadcast({ type: "ui.widgets", widgets: Object.fromEntries(widgets) });
	},
	setTitle: (t: string) => {
		title = t;
		broadcast({ type: "ui.title", title });
	},
	onTerminalInput: () => () => {},
	custom: async () => undefined, // TUI components are not available in the browser
	getEditorText: () => "",
	getToolsExpanded: () => false,
};
// Everything else (footer, header, editor, working indicator, …) is a no-op in the browser.
const uiContext = new Proxy(uiImpl, { get: (o, k: string) => (k in o ? o[k] : () => undefined) });

// ---------------------------------------------------------------- front agent runtime

const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
	const services = await sdk.createAgentSessionServices({ cwd, agentDir });
	let model: any;
	if (cfg.frontModel) {
		const [provider, ...rest] = cfg.frontModel.split(":")[0]!.split("/");
		model = services.modelRuntime.getModel(provider, rest.join("/"));
	}
	return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })), services, diagnostics: services.diagnostics };
};

// Always continue the one front conversation; --fresh-front (hidden, debugging only) starts an empty one.
// The conversation is the same whatever --cwd is (cwd only sets the front's working directory).
function latestFrontFile(): string | undefined {
	try {
		return readdirSync(SESSION_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(SESSION_DIR, f))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	} catch {
		return undefined;
	}
}
const resumeFile = argv.includes("--fresh-front") ? undefined : latestFrontFile();
const initialManager = resumeFile ? sdk.SessionManager.open(resumeFile, SESSION_DIR, CWD) : sdk.SessionManager.create(CWD, SESSION_DIR);
const runtime: any = await sdk.createAgentSessionRuntime(createRuntime, { cwd: CWD, agentDir: sdk.getAgentDir(), sessionManager: initialManager });
let unsubscribe: (() => void) | undefined;
let lastError: string | undefined;
let hubConnected = false;

/** Strip SDK-only cumulative snapshots from streaming events (the browser reconstructs from deltas). */
function wireEvent(e: any): any | undefined {
	switch (e.type) {
		case "message_update": {
			const a = e.assistantMessageEvent ?? {};
			const { partial, message: _m, ...rest } = a;
			if (rest.type === "toolcall_start") {
				const b = partial?.content?.[rest.contentIndex];
				rest.id ??= b?.id;
				rest.toolName ??= b?.name;
			}
			return { type: e.type, assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			// System messages (prompt sections, tool declarations) are not shown and can be large.
			return e.message?.role === "system" ? undefined : { type: e.type, message: e.message };
		case "tool_execution_start":
			return { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
		case "tool_execution_update":
			return undefined;
		case "tool_execution_end":
			return { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, result: e.result, isError: e.isError };
		case "agent_end":
			return { type: e.type };
		case "turn_start":
		case "turn_end":
			return undefined;
		default:
			return e;
	}
}

async function bind(session: any) {
	unsubscribe?.();
	statuses.clear();
	widgets.clear();
	await session.bindExtensions({
		uiContext,
		mode: "rpc", // the quick-agent front extension activates for interactive (TUI/RPC) hosts
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (o?: any) => runtime.newSession(o),
			fork: (id: string, o?: any) => runtime.fork(id, o),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: (p: string, o?: any) => runtime.switchSession(p, o),
			reload: () => runtime.session.reload(),
		},
		onError: (err: any) => broadcast({ type: "ui.notify", level: "error", message: `扩展错误 ${err?.extensionPath ?? ""}: ${err?.error ?? err}` }),
	});
	unsubscribe = session.subscribe((e: any) => {
		const w = wireEvent(e);
		if (w) broadcast({ type: "agent", event: w });
	});
	broadcast({ type: "front", state: state() });
}
runtime.setRebindSession(bind);
await bind(runtime.session);

function state() {
	const s = runtime.session;
	return {
		cwd: runtime.cwd,
		model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name } : undefined,
		thinkingLevel: s.thinkingLevel,
		isStreaming: s.isStreaming,
		messages: s.messages.filter((m: any) => m.role !== "system"),
		queue: { steering: s.getSteeringMessages(), followUp: s.getFollowUpMessages() },
		statuses: Object.fromEntries(statuses),
		widgets: Object.fromEntries(widgets),
		dialogs: publicDialogs(),
		title,
		lastError,
		hub: hubUrl(cfg),
		hubConnected,
		dashboard: `${hubUrl(cfg)}/?token=${cfg.token}`,
	};
}

async function prompt(body: any) {
	const text = String(body.text ?? "").trim();
	const images = Array.isArray(body.images)
		? body.images.filter((i: any) => typeof i?.data === "string" && /^image\//.test(i?.mimeType)).map((i: any) => ({ type: "image", data: i.data, mimeType: i.mimeType }))
		: [];
	if (!text && !images.length) throw new HttpError(400, "text is required");
	const s = runtime.session;
	// The front is one continuous conversation: there is nothing to create, switch or name.
	if (/^\/(new|resume|name|fork|tree|session)\b/.test(text)) {
		throw new HttpError(400, "前台是一段持续的对话，不需要新建或切换；上下文会自动压缩。要交出一件新的事，直接说就行。");
	}
	lastError = undefined;
	const opts: any = { images: images.length ? images : undefined, source: "rpc" };
	if (s.isStreaming) opts.streamingBehavior = body.mode === "steer" ? "steer" : "followUp";
	// prompt() resolves when the run finishes; report errors asynchronously.
	s.prompt(text, opts).catch((err: Error) => {
		lastError = err.message;
		broadcast({ type: "ui.notify", level: "error", message: err.message });
	});
}

// ---------------------------------------------------------------- hub event relay

const hubAbort = new AbortController();
ensureHub(cfg, hub)
	.catch((e) => log(`hub: ${(e as Error).message}`))
	.finally(() =>
		hub.subscribe(
			(e) => broadcast({ type: "hub", event: e }),
			hubAbort.signal,
			(ok) => {
				hubConnected = ok;
				broadcast({ type: "hub.state", connected: ok });
			},
			{ role: "webui" },
		),
	);

// ---------------------------------------------------------------- HTTP

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function send(res: ServerResponse, status: number, data: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(data));
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += (c as Buffer).length;
		if (size > 40 * 1024 * 1024) throw new HttpError(413, "body too large");
		chunks.push(c as Buffer);
	}
	return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage): Promise<any> {
	const b = await readBody(req);
	if (!b.length) return {};
	try {
		return JSON.parse(b.toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}
function cookie(req: IncomingMessage, name: string) {
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return decodeURIComponent(v.join("="));
	}
	return undefined;
}
const COOKIE = `qa_ui_${PORT}`;
function authorized(req: IncomingMessage) {
	return req.headers.authorization === `Bearer ${cfg.token}` || cookie(req, COOKIE) === cfg.token;
}
/** Reject DNS-rebinding (foreign Host) and cross-origin writes. */
function sameOrigin(req: IncomingMessage) {
	const host = String(req.headers.host ?? "");
	if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
	const origin = req.headers.origin;
	return !origin || origin === `http://${host}`;
}

const APP_HTML = join(REPO_ROOT, "ui", "app.html");
const TOKENS_CSS = join(REPO_ROOT, "shared", "tokens.css");
/** Design tokens are kept in shared/tokens.css (also shipped with the browser extension) and inlined here. */
const tokens = () => {
	try {
		return readFileSync(TOKENS_CSS, "utf8");
	} catch {
		return "";
	}
};
const appHtml = () => readFileSync(APP_HTML, "utf8").replace("/*@tokens*/", () => tokens());

async function proxyHub(req: IncomingMessage, res: ServerResponse, path: string) {
	const method = req.method ?? "GET";
	const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
	let r: Response;
	try {
		r = await fetch(hub.base + path, {
			method,
			headers: { authorization: `Bearer ${hub.token}`, ...(body?.length ? { "content-type": "application/json" } : {}) },
			body: body?.length ? body : undefined,
		});
	} catch (e) {
		throw new HttpError(502, `hub unreachable at ${hub.base}: ${(e as Error).message}`);
	}
	res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(Buffer.from(await r.arrayBuffer()));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const p = url.pathname;
	const m = req.method ?? "GET";
	if (!sameOrigin(req)) throw new HttpError(403, "forbidden origin");
	if (p === "/health") return send(res, 200, { ok: true, pid: process.pid, cwd: runtime.cwd });

	if (p === "/" || p === "/index.html") {
		const t = url.searchParams.get("token");
		if (t !== null) {
			// Exchange ?token= for an HttpOnly cookie and drop it from the address bar.
			if (t !== cfg.token) {
				res.writeHead(302, { location: "/?bad=1" });
				return res.end();
			}
			res.writeHead(302, { location: `/${url.hash}`, "set-cookie": `${COOKIE}=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
			return res.end();
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		return res.end(authorized(req) ? appHtml() : loginPage(url.searchParams.has("bad")));
	}

	if (!authorized(req)) throw new HttpError(401, "unauthorized");

	if (p === "/api/stream" && m === "GET") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		clients.add(res);
		res.write(`data: ${JSON.stringify({ type: "front", state: state() })}\n\n`);
		const ping = setInterval(() => res.write(": ping\n\n"), 15000);
		req.on("close", () => {
			clearInterval(ping);
			clients.delete(res);
		});
		return;
	}
	if (p === "/team.js" && m === "GET") {
		res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
		return res.end(readFileSync(join(REPO_ROOT, "ui", "team.js"), "utf8"));
	}
	if (p === "/api/state" && m === "GET") return send(res, 200, state());
	if (p.startsWith("/api/hub/")) return proxyHub(req, res, `/api/${p.slice("/api/hub/".length)}${url.search}`);

	if (m === "GET" && p === "/api/models") {
		const list = await runtime.session.modelRuntime.getAvailable();
		return send(res, 200, { models: list.map((x: any) => ({ provider: x.provider, id: x.id, name: x.name })), levels: runtime.session.getAvailableThinkingLevels() });
	}
	if (m !== "POST") throw new HttpError(404, "not found");
	const body = await readJson(req);
	switch (p) {
		case "/api/prompt":
			await prompt(body);
			return send(res, 200, { ok: true });
		case "/api/abort":
			await runtime.session.abort();
			return send(res, 200, { ok: true });
		case "/api/model": {
			const s = runtime.session;
			if (body.provider && body.id) {
				const model = s.modelRuntime.getModel(String(body.provider), String(body.id));
				if (!model) throw new HttpError(400, "unknown model");
				await s.setModel(model);
			}
			if (body.thinkingLevel) s.setThinkingLevel(body.thinkingLevel);
			broadcast({ type: "front", state: state() });
			return send(res, 200, { ok: true });
		}
		case "/api/dialog": {
			const d = dialogs.get(String(body.id ?? ""));
			if (!d) throw new HttpError(404, "dialog closed");
			d.resolve(body.value);
			return send(res, 200, { ok: true });
		}
	}
	throw new HttpError(404, "not found");
}

function loginPage(bad: boolean) {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>quick-agent</title>
<style>${tokens()}
:root{--fg2:var(--fg-2);--inv:var(--inv-fg);--hard:var(--hard-c)}
*{box-sizing:border-box}body{font:14px/1.65 "Inter","Helvetica Neue",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:var(--bg);color:var(--fg);padding:20px}
form{width:min(420px,100%);border:1px solid var(--fg);box-shadow:8px 8px 0 var(--hard)}
h2{margin:0;padding:14px 18px;border-bottom:1px solid var(--fg);font:800 14px/1 "Inter","Helvetica Neue",ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;display:flex;align-items:center;gap:10px}h2::before{content:"";width:12px;height:12px;background:var(--acc)}
.b{padding:16px 18px 18px}p{margin:0 0 14px;color:var(--fg2)}code{font:12.5px "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:var(--fg)}
input{width:100%;height:38px;padding:0 12px;border:1px solid var(--fg);border-radius:0;background:transparent;color:inherit;font:13px "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;outline:0}input:focus{box-shadow:3px 3px 0 var(--hard)}
button{margin-top:12px;width:100%;height:38px;border:1px solid var(--fg);border-radius:0;background:var(--fg);color:var(--inv);font:inherit;font-weight:600;cursor:pointer}button:hover{background:var(--acc);border-color:var(--acc);color:#fff}
.e{color:var(--acc);border-left:3px solid var(--acc);padding-left:10px}</style></head>
<body><form method="get" action="/"><h2>quick-agent</h2><div class="b"><p>请输入访问 token（终端运行 <code>quick token</code>，或直接用 <code>quick ui</code> 打开）。</p>${bad ? '<p class="e">token 不正确</p>' : ""}<input name="token" autofocus placeholder="token" aria-label="token"><button>进入</button></div></form></body></html>`;
}

const server = createServer((req, res) => {
	handle(req, res).catch((err) => {
		const status = err instanceof HttpError ? err.status : 500;
		if (status === 500) console.error(err);
		if (!res.headersSent) send(res, status, { error: (err as Error).message });
		else res.end();
	});
});
server.on("error", (e) => {
	console.error(`[quick-agent ui] ${(e as Error).message}`);
	process.exit(1);
});
server.listen(PORT, HOST, () => {
	writeFileSync(paths.uiPid, String(process.pid));
	log(`[quick-agent ui] http://${HOST}:${PORT}/?token=${cfg.token}  (cwd ${runtime.cwd}, pi ${PI_ROOT})`);
});

async function shutdown() {
	hubAbort.abort();
	for (const c of clients) c.end();
	server.close();
	try {
		await runtime.dispose();
	} catch {}
	try {
		if (readFileSync(paths.uiPid, "utf8") === String(process.pid)) unlinkSync(paths.uiPid);
	} catch {}
	process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown());
