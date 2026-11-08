// quick — quick-agent command line.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { hubUrl, loadConfig, paths, REPO_ROOT, sanitizeId, saveConfigPatch, type PeerConfig } from "../shared/config.ts";
import { ensureHub, hubAlive as alive } from "../shared/hub-process.ts";
import { HubClient } from "../shared/hub-client.ts";
import { ACTIVE_STATUSES, type Task } from "../shared/types.ts";
import { autoUpdate, describeSources, dueForCheck, patchState, readState, runUpgrade, type UpgradeResult } from "../shared/update.ts";

const cfg = loadConfig();
const hub = new HubClient(cfg);
let [cmd = "help", ...rest] = process.argv.slice(2);

const ICON: Record<string, string> = { starting: "◌", running: "●", idle: "◐", needs_input: "?", blocked: "■", done: "✓", failed: "✗", cancelled: "⊘", exited: "⏏" };

function die(msg: string): never {
	console.error(`quick: ${msg}`);
	process.exit(1);
}

async function hubAlive() {
	return alive(hub);
}

async function hubStart(quiet = false) {
	const r = await ensureHub(cfg, hub).catch((e) => die((e as Error).message));
	if (!quiet) console.log(r === "running" ? `hub already running at ${hubUrl(cfg)}` : `hub started at ${hubUrl(cfg)} (log ${paths.log})`);
}

async function hubStop() {
	if (!existsSync(paths.pid)) return console.log("hub not running");
	const pid = Number(readFileSync(paths.pid, "utf8"));
	try {
		process.kill(pid, "SIGTERM");
		// Wait until the process is gone so a following start does not see the old hub.
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				process.kill(pid, 0);
			} catch {
				break;
			}
		}
		console.log(`stopped hub (pid ${pid})`);
	} catch {
		console.log("hub not running");
	}
	try {
		unlinkSync(paths.pid);
	} catch {}
}

function tmuxOk(...args: string[]) {
	return spawnSync("tmux", args, { stdio: "ignore" }).status === 0;
}

function line(t: Task) {
	const detail = (["starting", "running"].includes(t.status) ? t.activity : t.summary)?.split("\n")[0]?.slice(0, 90) ?? "";
	const ago = Math.round((Date.now() - t.updatedAt) / 60000);
	const where = t.machine && t.machine !== cfg.machine.id ? `@${t.machine}` : "";
	return `${t.unread ? "•" : " "} ${ICON[t.status] ?? "·"} ${(t.id + where).padEnd(5)}  ${t.status.padEnd(11)} ${t.title}  \x1b[2m${ago}m · ${detail}\x1b[0m`;
}

/** quick-agent lives inside pi now: `quick front` is just `pi`. */
async function front(args: string[]) {
	await hubStart(true);
	const r = spawnSync("pi", args, { stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	process.exit(r.status ?? 0);
}

function attach(id: string) {
	const target = `${cfg.tmuxSession}:${id}`;
	if (!tmuxOk("list-panes", "-t", target)) die(`no tmux window for ${id} (resume it with: quick send ${id} "<message>")`);
	const args = process.env.TMUX ? ["switch-client", "-t", target] : ["attach-session", "-t", target];
	const r = spawnSync("tmux", args, { stdio: "inherit" });
	process.exit(r.status ?? 0);
}

const HELP = `quick — quick-agent

  pi                        直接打开 pi 就是前台 agent（quick front 是它的别名）；pi --qa-off 为普通 pi
  quick hub start|stop|restart|status|logs
  quick ls [-a]             列出任务（-a 包含已关闭）
  quick show <id>           查看任务汇报、事件、简报
  quick new [--machine M] [--cwd DIR] <title> <brief...>   不经前台直接派单
  quick send <id> <message> 给 worker 追加指令（窗口已关会自动恢复会话）
  quick attach <id>         切换到 worker 的 tmux 窗口
  quick cancel <id>         中止 worker 当前运行
  quick close <id>          关闭 worker 窗口
  quick ack <id>            标记已读
  quick machines            mesh 中的机器与链路状态
  quick upgrade [--check] [--all | --machine M ... | M ...] [--json]
                            升级 quick-agent（update 是别名）：默认只升级本机；--all 所有在线机器；--check 只检查不安装

  多机互联（mesh）:
  quick mesh init [--id NAME] [--desc 描述]   初始化本机身份与 mesh 密钥
  quick mesh add <ssh目标> [--port P] [--ssh-arg A]...
                            一条命令把一台能 ssh 过去的机器拉进 mesh（远端需已安装 quick-agent）
  quick mesh invite         打印给其他机器用的加入命令
  quick mesh join <code> (--ssh 目标 | --url URL)   用邀请码加入并连接到邀请方
  quick mesh accept <secret>   （由 mesh add 远程调用）设置密钥并重启 hub
  quick mesh peers | remove <序号>   查看/删除本机主动连接的 peer

  quick token               打印 hub token
  quick dashboard           打印网页面板地址
  quick tunnel              打印本地浏览器连接所需的 ssh 端口转发命令

  配置: ${join(paths.home, "config.json")}`;

// ---------------------------------------------------------------- upgrade

const KIND_LABEL: Record<string, string> = { git: "git 安装", "npm-pi": "pi npm 包", "npm-global": "npm 全局安装", release: "发布包" };

function printUpgrade(r: UpgradeResult, verbose: boolean) {
	const name = (r.machine ?? cfg.machine.id).padEnd(16);
	let state: string;
	if (!r.ok) state = `✗ ${r.error}`;
	else if (r.installed) state = `✓ 已升级 ${r.from} → ${r.to}`;
	else if (r.available) state = r.blocker ? `! 有更新，但无法自动安装：${r.blocker}` : `↑ 有更新（quick upgrade 安装）`;
	else state = "✓ 已是最新";
	const latest = r.latest ? `${r.latest.version} (${r.latest.source})` : "?";
	const behind = r.git?.behind && !r.installed ? `，上游领先 ${r.git.behind} 个提交` : "";
	console.log(`${name} 当前 ${r.from.padEnd(8)} 最新 ${latest.padEnd(16)} ${state}${behind}`);
	if (verbose) {
		if (r.root) console.log(`${"".padEnd(16)} \x1b[2m${KIND_LABEL[r.kind] ?? r.kind} · ${r.root}${r.git ? ` · ${r.git.branch ?? "detached"}${r.git.upstream ? `→${r.git.upstream}` : ""}${r.git.dirty ? " · 有未提交改动" : ""}` : ""}\x1b[0m`);
		if (r.tried?.length) console.log(`${"".padEnd(16)} \x1b[2m来源: ${describeSources(r.tried)}\x1b[0m`);
		if (r.note) console.log(`${"".padEnd(16)} ${r.note}`);
	}
}

async function upgrade(args: string[]) {
	if (args.includes("--auto")) {
		// Internal: background check spawned by other commands.
		await autoUpdate({ trigger: "cli" });
		return;
	}
	const check = args.includes("--check");
	const json = args.includes("--json");
	const all = args.includes("--all");
	const machines = [...flags(args, "--machine"), ...args.filter((a) => !a.startsWith("-"))].flatMap((m) => m.split(",")).filter(Boolean);
	const remote = all || machines.some((m) => m !== cfg.machine.id);
	if (remote) {
		await hubStart(true);
		if (!json) console.log(check ? "检查各机器版本 …" : "升级中（各机器并行，可能需要一两分钟）…");
		const results = await hub.upgrade({ all, machines, check });
		if (json) return console.log(JSON.stringify(results, null, 2));
		for (const r of results) printUpgrade(r, results.length === 1);
		const failed = results.filter((r) => !r.ok).length;
		const done = results.filter((r) => r.installed).length;
		console.log(`\n${results.length} 台机器：${done} 台已升级，${failed} 台失败${done ? "。各机器的 hub 会在没有运行中的 worker 时自动重启；pi 里 /reload 生效" : ""}`);
		if (failed) process.exitCode = 1;
		return;
	}
	const r = await runUpgrade({ check, machine: cfg.machine.id });
	if (json) return console.log(JSON.stringify(r, null, 2));
	printUpgrade(r, true);
	if (!r.ok) process.exitCode = 1;
	if (!r.installed) return;
	// Load the new code into the hub: restart it now unless a local worker is busy.
	if (await hubAlive()) {
		const busy = (await hub.listTasks().catch(() => [] as Task[])).filter((t) => t.machine === cfg.machine.id && !t.closed && ACTIVE_STATUSES.includes(t.status));
		if (cfg.update.restartHub === "never") console.log("运行 quick hub restart 让 hub 使用新版本");
		else if (busy.length) console.log(`本机有 ${busy.length} 个运行中的 worker，暂不重启 hub（新版 hub 会在空闲时自动重启；也可以手动 quick hub restart）`);
		else {
			await hubStop();
			await hubStart();
		}
	}
	console.log("pi 里运行 /reload（或新开 pi）加载新版扩展");
}

/** Kick a throttled background check (detached, never slows the command) and hint at pending updates. */
function backgroundUpdateCheck() {
	if (!cfg.update.enabled) return;
	try {
		if (dueForCheck(cfg.update)) {
			spawn(process.execPath, ["--import", join(REPO_ROOT, "bin", "ts-hooks.mjs"), join(REPO_ROOT, "cli", "quick.ts"), "upgrade", "--auto"], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, NODE_NO_WARNINGS: "1" },
			}).unref();
		}
		const st = readState();
		if (st.available && st.latest && process.stderr.isTTY && Date.now() - (st.hintedAt ?? 0) > 86400_000) {
			console.error(`\x1b[2mquick-agent ${st.latest} 可用（当前 ${st.current}），运行 quick upgrade 升级\x1b[0m`);
			patchState({ hintedAt: Date.now() });
		}
	} catch {}
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
}
function flags(args: string[], name: string): string[] {
	const out: string[] = [];
	for (let v = flag(args, name); v !== undefined; v = flag(args, name)) out.push(v);
	return out;
}

async function restartHubIfRunning() {
	if (await hubAlive()) {
		await hubStop();
		await hubStart();
	}
}

function ensureSecret(): string {
	const c = loadConfig();
	if (c.mesh.secret) return c.mesh.secret;
	const secret = randomBytes(24).toString("base64url");
	saveConfigPatch((raw) => {
		raw.mesh = { ...(raw.mesh ?? {}), secret, peers: raw.mesh?.peers ?? [] };
		raw.machine = { ...(raw.machine ?? {}), id: raw.machine?.id ?? c.machine.id };
	});
	return secret;
}

function addPeer(peer: PeerConfig) {
	saveConfigPatch((raw) => {
		raw.mesh ??= { peers: [] };
		raw.mesh.peers ??= [];
		const key = (p: PeerConfig) => p.url ?? `ssh:${p.ssh}`;
		raw.mesh.peers = raw.mesh.peers.filter((p: PeerConfig) => key(p) !== key(peer));
		raw.mesh.peers.push(peer);
	});
}

async function mesh(args: string[]) {
	const sub = args.shift() ?? "status";
	switch (sub) {
		case "init": {
			const id = flag(args, "--id");
			const desc = flag(args, "--desc");
			const secret = ensureSecret();
			saveConfigPatch((raw) => {
				raw.machine = { ...(raw.machine ?? {}), id: id ? sanitizeId(id) : (raw.machine?.id ?? cfg.machine.id) };
				if (desc !== undefined) raw.machine.description = desc;
			});
			const c = loadConfig();
			console.log(`machine: ${c.machine.id}${c.machine.description ? ` (${c.machine.description})` : ""}\nmesh secret: ${secret.slice(0, 6)}…（完整内容见 ${paths.home}/config.json）`);
			await restartHubIfRunning();
			return;
		}
		case "invite": {
			const secret = ensureSecret();
			const code = Buffer.from(JSON.stringify({ v: 1, secret, machine: cfg.machine.id, port: cfg.port })).toString("base64url");
			const me = `${userInfo().username}@${hostname()}`;
			console.log(`在另一台机器上运行（二选一）：\n\n  # 那台机器能 ssh 到这里（推荐，hub 会自己维护隧道）：\n  quick mesh join ${code} --ssh ${me}\n\n  # 或者这里的 hub 端口可以直接访问（需把 config.json 的 host 设为 0.0.0.0，并做好防火墙）：\n  quick mesh join ${code} --url http://<本机地址>:${cfg.port}\n`);
			await restartHubIfRunning();
			return;
		}
		case "join": {
			const code = args.shift() ?? die("usage: quick mesh join <code> (--ssh TARGET | --url URL)");
			let inv: { secret: string; port?: number; machine?: string };
			try {
				inv = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
			} catch {
				die("invalid invite code");
			}
			const ssh = flag(args, "--ssh");
			const url = flag(args, "--url");
			if (!ssh && !url) die("need --ssh TARGET or --url URL");
			saveConfigPatch((raw) => {
				raw.mesh = { ...(raw.mesh ?? {}), secret: inv.secret, peers: raw.mesh?.peers ?? [] };
				raw.machine = { ...(raw.machine ?? {}), id: raw.machine?.id ?? cfg.machine.id };
			});
			addPeer(ssh ? { ssh, port: inv.port ?? 7788 } : { url: url! });
			console.log(`已加入 mesh，连接到 ${inv.machine ?? "邀请方"}（${ssh ? `ssh ${ssh}` : url}）`);
			await hubStop();
			await hubStart();
			await new Promise((r) => setTimeout(r, 3000));
			return main2(["machines"]);
		}
		case "add": {
			const target = args.shift() ?? die("usage: quick mesh add <ssh-target> [--port P] [--ssh-arg A]...");
			const port = Number(flag(args, "--port") ?? 7788);
			const sshArgs = flags(args, "--ssh-arg");
			const secret = ensureSecret();
			console.log(`→ 在 ${target} 上设置 mesh 密钥并启动 hub …`);
			const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", ...sshArgs, target, "bash", "-lc", `'quick mesh accept ${secret}'`], { stdio: "inherit" });
			if (r.status !== 0) {
				die(`远端设置失败。请确认 ${target} 上已安装 quick-agent（quick 在 PATH 中），或在那台机器上手动运行:\n  quick mesh accept ${secret}`);
			}
			addPeer({ ssh: target, port, ...(sshArgs.length ? { sshArgs } : {}) });
			await hubStop();
			await hubStart();
			await new Promise((r2) => setTimeout(r2, 4000));
			return main2(["machines"]);
		}
		case "accept": {
			const secret = args.shift() ?? die("usage: quick mesh accept <secret>");
			saveConfigPatch((raw) => {
				raw.mesh = { ...(raw.mesh ?? {}), secret, peers: raw.mesh?.peers ?? [] };
				raw.machine = { ...(raw.machine ?? {}), id: raw.machine?.id ?? cfg.machine.id };
			});
			await hubStop();
			await hubStart(true);
			console.log(`${cfg.machine.id}: mesh secret set, hub running on port ${cfg.port}`);
			return;
		}
		case "peers": {
			loadConfig().mesh.peers.forEach((p, i) => console.log(`${i + 1}. ${p.url ?? `ssh ${p.ssh} (port ${p.port ?? 7788})`}`));
			return;
		}
		case "remove": {
			const n = Number(args.shift());
			saveConfigPatch((raw) => {
				const peers = raw.mesh?.peers ?? [];
				if (!(n >= 1 && n <= peers.length)) die("usage: quick mesh remove <序号>（见 quick mesh peers）");
				peers.splice(n - 1, 1);
			});
			return restartHubIfRunning();
		}
		default:
			return main2(["machines"]);
	}
}

async function main() {
	switch (cmd) {
		case "front":
			return front(rest);
		case "hub": {
			const sub = rest[0] ?? "status";
			if (sub === "start") return hubStart();
			if (sub === "stop") return hubStop();
			if (sub === "restart") {
				await hubStop();
				return hubStart();
			}
			if (sub === "logs") return void spawnSync("tail", ["-n", "80", "-f", paths.log], { stdio: "inherit" });
			if (await hubAlive()) {
				const h = await hub.health();
				return console.log(`hub running at ${hubUrl(cfg)} (pid ${h.pid}, ${h.tasks} tasks)`);
			}
			return console.log("hub not running (quick hub start)");
		}
		case "ls":
		case "tasks": {
			const all = rest.includes("-a");
			const list = (await hub.listTasks()).filter((t) => all || !t.closed || t.unread);
			if (!list.length) return console.log("no tasks");
			return console.log(list.map(line).join("\n"));
		}
		case "show": {
			const id = rest[0] ?? die("usage: quick show <id>");
			const { task: t, events } = await hub.getTask(id, 30);
			console.log(`${ICON[t.status]} ${t.id} [${t.status}] ${t.title}\n  cwd: ${t.cwd}\n  tmux: ${t.tmuxTarget ?? "-"}\n  session: ${t.sessionFile ?? "-"}\n  activity: ${t.activity ?? "-"}`);
			console.log(`\n── 汇报 ──\n${t.summary ?? "(暂无)"}`);
			console.log(`\n── 事件 ──\n${events.map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.kind}${e.status ? `→${e.status}` : ""} ${(e.text ?? "").split("\n")[0]?.slice(0, 120)}`).join("\n")}`);
			console.log(`\n── 简报 ──\n${t.brief}`);
			if (t.unread) await hub.ack(id);
			return;
		}
		case "new": {
			await hubStart(true);
			let cwd = process.cwd();
			const args = [...rest];
			const i = args.indexOf("--cwd");
			if (i >= 0) {
				cwd = args[i + 1] ?? die("--cwd needs a value");
				args.splice(i, 2);
			}
			let machine: string | undefined;
			const mi = args.indexOf("--machine");
			if (mi >= 0) {
				machine = args[mi + 1] ?? die("--machine needs a value");
				args.splice(mi, 2);
				if (i < 0) cwd = ""; // remote: use that machine's default cwd unless --cwd is given
			}
			const [title, ...brief] = args;
			if (!title || !brief.length) die("usage: quick new [--machine M] [--cwd DIR] <title> <brief...>");
			const t = await hub.createTask({ title, brief: brief.join(" "), cwd: cwd || undefined, machine, source: { kind: "cli" } });
			return console.log(line(t));
		}
		case "send": {
			const [id, ...msg] = rest;
			if (!id || !msg.length) die("usage: quick send <id> <message>");
			return console.log(line(await hub.sendMessage(id, msg.join(" "))));
		}
		case "cancel":
			return console.log(line(await hub.cancel(rest[0] ?? die("usage: quick cancel <id>"))));
		case "close":
			return console.log(line(await hub.close(rest[0] ?? die("usage: quick close <id>"))));
		case "ack":
			return console.log(line(await hub.ack(rest[0] ?? die("usage: quick ack <id>"))));
		case "attach":
			return attach(rest[0] ?? die("usage: quick attach <id>"));
		case "machines": {
			const r = await hub.machines();
			for (const m of r.machines)
				console.log(
					`${m.online ? "●" : "○"} ${m.id.padEnd(16)} ${m.self ? "self" : m.hops === -1 ? "offline" : m.hops === 1 ? "direct" : `via ${m.via} (${m.hops} hops)`}  \x1b[2m${m.description ?? ""}${m.activeTasks ? ` · ${m.activeTasks} running` : ""}\x1b[0m`,
				);
			if (r.machines.some((m) => m.version)) console.log(`\x1b[2m版本: ${r.machines.map((m) => `${m.id} ${m.version ?? "?"}`).join(" · ")}\x1b[0m`);
			if (!r.links.enabled) console.log("\n(mesh 未启用：运行 quick mesh init)");
			for (const d of r.links.dialed) console.log(`  → ${d.label}: ${d.state}${d.peer ? ` (${d.peer})` : ""}${d.error ? ` — ${d.error}` : ""}`);
			for (const l of r.links.inbound) console.log(`  ← ${l.peer} from ${l.label}`);
			return;
		}
		case "mesh":
			return mesh(rest);
		case "upgrade":
		case "update":
			return upgrade(rest);
		case "token":
			return console.log(cfg.token);
		case "dashboard":
			return console.log(`${hubUrl(cfg)}/?token=${cfg.token}`);
		case "tunnel":
			return console.log(
				`在你本地电脑上运行（保持开启）：\n  ssh -N -L ${cfg.port}:127.0.0.1:${cfg.port} ${process.env.USER}@<这台服务器>\n插件安装包：http://127.0.0.1:${cfg.port}/extension.zip（解压后在 chrome://extensions 打开开发者模式 →「加载已解压的扩展程序」）
浏览器插件 Hub 地址填 http://127.0.0.1:${cfg.port}，Token 填：\n  ${cfg.token}\n面板：http://127.0.0.1:${cfg.port}/?token=${cfg.token}`,
			);
		default:
			return console.log(HELP);
	}
}

function main2(args: string[]) {
	[cmd = "help", ...rest] = args;
	return main();
}

if (!["upgrade", "update", "help", "--help", "-h"].includes(cmd)) backgroundUpdateCheck();
main().catch((e) => die((e as Error).message));
