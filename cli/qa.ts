// qa — quick-agent command line.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hubUrl, loadConfig, paths } from "../shared/config.ts";
import { ensureHub, hubAlive as alive } from "../shared/hub-process.ts";
import { HubClient } from "../shared/hub-client.ts";
import type { Task } from "../shared/types.ts";

const cfg = loadConfig();
const hub = new HubClient(cfg);
const [cmd = "help", ...rest] = process.argv.slice(2);

const ICON: Record<string, string> = { starting: "◌", running: "●", idle: "◐", needs_input: "?", blocked: "■", done: "✓", failed: "✗", cancelled: "⊘", exited: "⏏" };

function die(msg: string): never {
	console.error(`qa: ${msg}`);
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
	return `${t.unread ? "•" : " "} ${ICON[t.status] ?? "·"} ${t.id}  ${t.status.padEnd(11)} ${t.title}  \x1b[2m${ago}m · ${detail}\x1b[0m`;
}

/** quick-agent lives inside pi now: `qa front` is just `pi`. */
async function front(args: string[]) {
	await hubStart(true);
	const r = spawnSync("pi", args, { stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	process.exit(r.status ?? 0);
}

function attach(id: string) {
	const target = `${cfg.tmuxSession}:${id}`;
	if (!tmuxOk("list-panes", "-t", target)) die(`no tmux window for ${id} (resume it with: qa send ${id} "<message>")`);
	const args = process.env.TMUX ? ["switch-client", "-t", target] : ["attach-session", "-t", target];
	const r = spawnSync("tmux", args, { stdio: "inherit" });
	process.exit(r.status ?? 0);
}

const HELP = `qa — quick-agent

  pi                        直接打开 pi 就是前台 agent（qa front 是它的别名）；pi --qa-off 为普通 pi
  qa hub start|stop|restart|status|logs
  qa ls [-a]                列出任务（-a 包含已关闭）
  qa show <id>              查看任务汇报、事件、简报
  qa new [--cwd DIR] <title> <brief...>   不经前台直接派单
  qa send <id> <message>    给 worker 追加指令（窗口已关会自动恢复会话）
  qa attach <id>            切换到 worker 的 tmux 窗口
  qa cancel <id>            中止 worker 当前运行
  qa close <id>             关闭 worker 窗口
  qa ack <id>               标记已读
  qa token                  打印 hub token
  qa dashboard              打印网页面板地址
  qa tunnel                 打印本地浏览器连接所需的 ssh 端口转发命令

  配置: ${join(paths.home, "config.json")}`;

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
			return console.log("hub not running (qa hub start)");
		}
		case "ls":
		case "tasks": {
			const all = rest.includes("-a");
			const list = (await hub.listTasks()).filter((t) => all || !t.closed || t.unread);
			if (!list.length) return console.log("no tasks");
			return console.log(list.map(line).join("\n"));
		}
		case "show": {
			const id = rest[0] ?? die("usage: qa show <id>");
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
			const [title, ...brief] = args;
			if (!title || !brief.length) die("usage: qa new [--cwd DIR] <title> <brief...>");
			const t = await hub.createTask({ title, brief: brief.join(" "), cwd, source: { kind: "cli" } });
			return console.log(line(t));
		}
		case "send": {
			const [id, ...msg] = rest;
			if (!id || !msg.length) die("usage: qa send <id> <message>");
			return console.log(line(await hub.sendMessage(id, msg.join(" "))));
		}
		case "cancel":
			return console.log(line(await hub.cancel(rest[0] ?? die("usage: qa cancel <id>"))));
		case "close":
			return console.log(line(await hub.close(rest[0] ?? die("usage: qa close <id>"))));
		case "ack":
			return console.log(line(await hub.ack(rest[0] ?? die("usage: qa ack <id>"))));
		case "attach":
			return attach(rest[0] ?? die("usage: qa attach <id>"));
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

main().catch((e) => die((e as Error).message));
