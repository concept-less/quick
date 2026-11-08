// quick — quick-agent command line.
import { progressLine, progressText } from "../shared/progress.ts";
import { entryText } from "../shared/transcript.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { hubUrl, loadConfig, paths, REPO_ROOT, sanitizeId, saveConfigPatch, type PeerConfig } from "../shared/config.ts";
import { ensureHub, hubAlive as alive } from "../shared/hub-process.ts";
import { HubClient } from "../shared/hub-client.ts";
import { ACTIVE_STATUSES, type MachineView, type Task } from "../shared/types.ts";
import { attentionOf, LEVEL_LABEL, type AttentionCounts, type AttentionItem, type FocusState } from "../shared/attention.ts";
import { applyResourceEdits, detectResources, mergeResources, normalizeRequires, priorityOf, rankMachines, resourcesOf } from "../shared/schedule.ts";
import { activeRoot, compareVersions, hintLine, KIND_LABEL, readVersion, runUpgrade, spawnReload, updateStatus, type UpgradeResult } from "../shared/update.ts";
import { ensureUi, stopUi, uiHealth, uiLoginUrl } from "../shared/ui-process.ts";
import { openAttach, planAttach, runForeground } from "../shared/attach.ts";
import { assignCmd, commentCmd, TEAM_HELP, teamCmd } from "./team.ts";
import { formatDuration, formatWall } from "../shared/cron.ts";
import type { CronView } from "../hub/cron.ts";
import { printAttention, projectsCmd } from "./projects.ts";
import { EXPECT_SOURCE_LABEL, reviewLine, timingOf } from "../shared/watchdog.ts";

const cfg = loadConfig();
const hub = new HubClient(cfg);
let [cmd = "help", ...rest] = process.argv.slice(2);


function die(msg: string): never {
	console.error(`quick: ${msg}`);
	process.exit(1);
}

async function hubAlive() {
	return alive(hub);
}

async function hubStart(quiet = false) {
	const r = await ensureHub(cfg, hub).catch((e) => die((e as Error).message));
	if (!quiet) console.log(`${r === "running" ? `hub already running at ${hubUrl(cfg)}` : `hub started at ${hubUrl(cfg)} (log ${paths.log})`}\nWeb UI: quick ui  →  ${uiLoginUrl(cfg)}`);
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

function attnLine(i: AttentionItem, t?: Task) {
	const ago = Math.round((Date.now() - i.since) / 60000);
	const where = i.machine && i.machine !== cfg.machine.id ? `@${i.machine}` : "";
	const when = i.snoozedUntil ? `至 ${new Date(i.snoozedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `${ago}m`;
	return `${i.mark.padEnd(10)} ${(i.taskId + where).padEnd(6)} ${i.title}  \x1b[2m${when}${i.timing ? ` · ${i.timing}` : ""} · ${i.reason.slice(0, 90)}${t && i.options?.length ? ` · 选项: ${i.options.join(" / ")}` : ""}\x1b[0m`;
}
function countsLine(c: AttentionCounts, f: FocusState) {
	return `需要你 ${c.need} · 待扫 ${c.skim} · 稍后 ${c.snoozed} · 不用管 ${c.inflight}${f.on ? ` · 专注中${f.until ? ` 至 ${new Date(f.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}` : ""}`;
}


/** quick-agent lives inside pi now: `quick front` is just `pi`. */
async function front(args: string[]) {
	await hubStart(true);
	const r = spawnSync("pi", args, { stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	process.exit(r.status ?? 0);
}

async function attach(id: string) {
	try {
		const plan = await planAttach(cfg, hub, id);
		// From a shell, run remote attaches in the foreground (nested tmux) rather than opening a window.
		const r = openAttach(plan, { remoteWindow: false });
		console.error(`quick: ${r.message}`);
		if (r.kind === "foreground") process.exit((await runForeground(r)) ?? 1);
	} catch (e) {
		die((e as Error).message);
	}
}

const HELP = `quick — quick-agent

  pi                        直接打开 pi 就是前台 agent（quick front 是它的别名）；pi --qa-off 为普通 pi
  quick ui [--cwd DIR] [--no-open]   在浏览器里打开 Web UI（首屏是注意力队列，旁边是前台 agent）
  quick ui stop|restart|status|url|logs
  quick hub start|stop|restart|reload|status|logs
                            reload = 用当前安装的版本平滑重启 hub 和 Web UI 服务（worker 不受影响）
  quick attention [-a] [--project P]   注意力队列：需要你 / 待扫 / 稍后 / 不用管，每级内按项目分组（别名 quick a；-a 含已归档）
  quick ls [-a] [--project P] [--by-project]   同上，按任务一行一个并标出项目；--project 只看一个项目（none = 未归类），--by-project 先按项目分组
  quick show <id>           查看任务的注意力、进度、用时/预期、巡检、汇报、简报
  quick log <id> [-f] [-n N] 工作记录：worker 的输出、命令和结果、追加指令（-f 持续跟随）
  quick new [--machine M] [--requires a,b] [--cwd DIR] [--reviewer 人] [--assignee 人] [--watch a,b] [--project P] [--expected 30m] [--no-watchdog] <title> <brief...>
  quick watch <id> [on|off|now|expect 30m]   巡检：开/关（如长时间轮询的任务）、立即巡检一次、改预期用时
                            不经前台直接派单（不指定机器时按资源+优先级自动选机器）
  quick send <id> <message> 回答 worker 的问题或追加指令（不代表批准集成；窗口已关会带着完整上下文重新拉起）
  quick approve <id> --sha SHA   明确批准指定的完整 head SHA 集成（仅等待人工批准时）
  quick changes <id> <message>   要求修改并重新审查，旧批准失效
  quick retry <id>          让停下/失败的 worker 从中断处重试
  quick attach <id>         进入 worker 的 tmux 窗口（远程任务经 ssh；C-b d 返回）
  quick handoff <id> <machine> [--cwd 路径] [--no-workspace] [--abort] [--wait 秒] [--on-conflict fail|stash|backup] [--no-follow]
                            把任务（worker 的完整上下文 + 元数据 + 工作区）无损交接到 mesh 里另一台在线机器继续
  quick cancel <id>         中止 worker 当前运行
  quick close <id>          关闭 worker 窗口
  quick ack <id>            知道了：确认这件事，移出「需要你 / 待扫」
  quick snooze <id> [分钟]  稍后提醒（默认 60 分钟；0 = 现在就放回来）
  quick focus [分钟|off]    专注模式：只有「需要你」会打扰，完成汇总留到结束（不带分钟 = 直到关闭）
  quick cron add (--cron "0 9 * * *" | --every 2h | --at "2026-11-09 09:00" | --in 30m) [--tz 时区]
                [--machine M] [--requires a,b] [--cwd DIR] [--project P] [--overlap skip|queue|parallel] [--catch-up latest|skip]
                [--silent] [--paused] <标题> <简报...>
                            定时计划：到点后 hub 自动派一个 worker 任务（简报里可用 {{date}} {{time}} {{n}}）
  quick cron ls [-a]        列出定时计划（-a 含已结束的一次性计划）
  quick cron show <id>      计划详情与最近运行
  quick cron rm|pause|resume|run <id>   删除 / 暂停 / 恢复 / 立即运行一次
  quick projects            项目列表（需要你 / 运行中 / 全部计数、识别规则）
  quick projects rename <项目> <新名字> | merge <项目> <并入项目> | move <任务> <项目|none>
  quick projects create <名字> [--url U] [--path P] [--remote R] [--keyword K]
  quick projects rule <项目> add|rm url|path|remote|keyword <值>
  quick projects order <项目> [<项目> …]   项目列表顺序（列出的排最前；Web UI 里可拖动）
  quick projects backfill [--all]   给未归类过的任务归类（--all 重新归类所有非手动设置的任务）
  quick machines            mesh 中的机器、资源、优先级与链路状态
  quick machine [show] [M]  查看机器的资源标签（探测 + 配置）与优先级
  quick machine set [--machine M] [--priority N] [--resources a,b] [--add t]... [--remove t]... [--notes 文本] [--desc 描述] [--owner 成员id|none]
                            设置资源/优先级/所有者（数字越小越优先；--priority none / --resources none 清除），即时生效
  quick machine detect      只打印本机自动探测到的资源
  quick upgrade [--check] [--all | --machine M ... | M ...] [--json]
                            从 GitHub Release 升级 quick-agent（update 是别名）：下载、校验、原子切换、平滑重启；
                            默认只升级本机；--all 所有在线机器；--check 只检查不安装
  quick upgrade --rollback  切回上一个版本

  多机互联（mesh）:
  quick mesh init [--id NAME] [--desc 描述]   初始化本机身份与 mesh 密钥
  quick mesh add <ssh目标> [--port P] [--ssh-arg A]...
                            一条命令把一台能 ssh 过去的机器拉进 mesh（远端需已安装 quick-agent）
  quick mesh invite         打印给其他机器用的加入命令
  quick mesh join <code> (--ssh 目标 | --url URL)   用邀请码加入并连接到邀请方
  quick mesh accept <secret>   （由 mesh add 远程调用）设置密钥并重启 hub
  quick mesh peers | remove <序号>   查看/删除本机主动连接的 peer

  quick version             当前版本、已安装版本、hub 版本与最新 Release
${TEAM_HELP}

  quick token               打印 hub token
  quick dashboard           打印网页面板地址
  quick tunnel              打印本地浏览器连接所需的 ssh 端口转发命令

  配置: ${join(paths.home, "config.json")}`;

// ---------------------------------------------------------------- upgrade

const STEP_LABEL: Record<string, string> = { check: "检查", download: "下载", verify: "校验", switch: "切换", restart: "重启", done: "完成", error: "失败" };

function printUpgrade(r: UpgradeResult, verbose: boolean) {
	const name = (r.machine ?? cfg.machine.id).padEnd(16);
	let state: string;
	if (!r.ok) state = `✕ ${r.error}`;
	else if (r.installed) state = `✓ ${compareVersions(r.to, r.from) < 0 ? "已回滚" : "已升级"} ${r.from} → ${r.to}`;
	else if (r.available) state = r.blocker ? `! 有新版本，但不能自动安装：${r.blocker}` : "↑ 有新版本（quick upgrade 安装）";
	else state = "✓ 已是最新";
	console.log(`${name} 当前 ${r.from.padEnd(8)} 最新 ${(r.latest ?? "?").padEnd(8)} ${state}`);
	if (verbose) {
		if (r.root) console.log(`${"".padEnd(16)} \x1b[2m${KIND_LABEL[r.kind] ?? r.kind} · ${r.root}\x1b[0m`);
		if (r.url && r.available) console.log(`${"".padEnd(16)} \x1b[2m更新说明: ${r.url}\x1b[0m`);
		if (r.note) console.log(`${"".padEnd(16)} ${r.note}`);
	}
}

/** Restart hub + Web UI with the new code (`quick hub reload` of the active version), if the hub runs. */
async function reloadAfterUpgrade(quiet = false) {
	if (!(await hubAlive())) return;
	if (cfg.update.restartHub === "never") return void (quiet || console.log("运行 quick hub reload 让 hub 和 Web UI 使用新版本"));
	if (!quiet) console.log("重启 hub 和 Web UI 服务（worker 不受影响）…");
	const child = spawnReload({ wait: true });
	await new Promise((r) => child.on("exit", r));
	if (!quiet) {
		const h = await hub.health().catch(() => undefined);
		console.log(h ? `hub 已重启，运行 ${h.version}` : `hub 重启失败，见 ${paths.log}`);
	}
}

async function upgrade(args: string[]) {
	if (args.includes("--auto")) {
		// Internal: auto-install (update.autoInstall) spawned in the background by other commands.
		const r = await runUpgrade({ machine: cfg.machine.id });
		if (r.installed) await reloadAfterUpgrade(true);
		return;
	}
	const check = args.includes("--check");
	const json = args.includes("--json");
	const all = args.includes("--all");
	const rollback = args.includes("--rollback");
	const machines = [...flags(args, "--machine"), ...args.filter((a) => !a.startsWith("-"))].flatMap((m) => m.split(",")).filter(Boolean);
	const remote = all || machines.some((m) => m !== cfg.machine.id);
	if (remote) {
		if (rollback) die("--rollback 只能在本机执行（其他机器可以在 Web UI 的版本面板里回滚）");
		await hubStart(true);
		if (!json) console.log(check ? "检查各机器版本 …" : "升级中（各机器并行，可能需要一两分钟）…");
		const results = await hub.upgrade({ all, machines, check });
		if (json) return console.log(JSON.stringify(results, null, 2));
		for (const r of results) printUpgrade(r, results.length === 1);
		const failed = results.filter((r) => !r.ok).length;
		const done = results.filter((r) => r.installed).length;
		console.log(`\n${results.length} 台机器：${done} 台已升级，${failed} 台失败${done ? "。各机器的 hub 和 Web UI 会马上平滑重启（worker 不受影响）" : ""}`);
		if (failed) process.exitCode = 1;
		return;
	}
	let lastStep = "";
	const r = await runUpgrade({
		check,
		rollback,
		machine: cfg.machine.id,
		onProgress: json
			? undefined
			: (p) => {
					const pct = p.step === "download" && p.total ? ` ${Math.round(((p.received ?? 0) / p.total) * 100)}%` : "";
					const label = `${STEP_LABEL[p.step] ?? p.step}${pct}`;
					if (label !== lastStep && (p.step !== "download" || /(0|00)%$/.test(pct) || !pct)) process.stderr.write(`  ${(lastStep = label)}\n`);
				},
	});
	if (json) return console.log(JSON.stringify(r, null, 2));
	printUpgrade(r, true);
	if (!r.ok) process.exitCode = 1;
	if (!r.installed) return;
	await reloadAfterUpgrade();
	console.log(`${rollback ? "已回滚" : "已升级"}；前台 pi 会在空闲时自动 /reload，worker 继续用旧版本跑完${rollback ? "" : "（回滚：quick upgrade --rollback）"}`);
}

/** `quick hub reload`: restart the hub (and the Web UI server if it runs) from the active version. */
async function hubReload() {
	writeFileSync(paths.restarting, String(Date.now()));
	try {
		const ui = await uiHealth(cfg);
		await hubStop();
		await hubStart(true);
		const h = await hub.health().catch(() => undefined);
		console.log(`${new Date().toISOString()} [reload] hub restarted (pid ${h?.pid}, ${h?.version})`);
		if (ui) {
			// Do not cut off a running front-agent turn in the Web UI: wait (bounded) until it is idle.
			for (let i = 0; i < 240; i++) {
				const u = await uiHealth(cfg);
				if (!u || !(u as { busy?: boolean }).busy) break;
				await new Promise((r) => setTimeout(r, 500));
			}
			await stopUi();
			await ensureUi(cfg, { cwd: ui.cwd });
			console.log(`${new Date().toISOString()} [reload] web ui restarted (cwd ${ui.cwd})`);
		}
	} finally {
		rmSync(paths.restarting, { force: true });
	}
}

/**
 * Release check on every start: cached (update.cacheMinutes), short timeout, never delays the command
 * itself; the hint is printed after the command's output.
 */
function startupUpdateCheck(): Promise<string | undefined> {
	if (!cfg.update.enabled || process.env.QA_TASK_ID || rest.includes("--json")) return Promise.resolve(undefined);
	if (["upgrade", "update", "help", "--help", "-h", "token", "version", "--version", "-v"].includes(cmd) || (cmd === "hub" && rest[0] === "reload")) return Promise.resolve(undefined);
	return updateStatus({ quick: true, timeoutMs: cfg.update.cliTimeoutMs })
		.then((st) => {
			const line = hintLine(st);
			if (!line) return undefined;
			if (st.canInstall && st.autoInstall) {
				const root = activeRoot();
				spawn(process.execPath, ["--import", join(root, "bin", "ts-hooks.mjs"), join(root, "cli", "quick.ts"), "upgrade", "--auto"], { detached: true, stdio: "ignore", env: { ...process.env, NODE_NO_WARNINGS: "1" } }).unref();
				return `installing v${st.latest!.version} in the background (update.autoInstall)`;
			}
			return line;
		})
		.catch(() => undefined);
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

function printMachine(m: MachineView | undefined, extra?: string) {
	if (!m) return;
	console.log(`${m.id}${m.self ? "（本机）" : ""}${m.online === false ? " 离线" : ""}${m.description ? ` — ${m.description}` : ""}`);
	console.log(`  优先级: ${priorityOf(m)}${m.priority === undefined ? "（默认）" : ""}`);
	console.log(`  资源:   ${resourcesOf(m).join(", ") || "（无）"}`);
	if (m.resourceNotes) console.log(`  说明:   ${m.resourceNotes}`);
	if (m.owner) console.log(`  所有者: ${m.owner}`);
	if (extra) console.log(extra);
}

async function machineCmd(args: string[]) {
	const sub = ["show", "set", "detect"].includes(args[0] ?? "") ? args.shift()! : args[0]?.startsWith("-") ? "set" : "show";
	if (sub === "detect") return console.log(detectResources().join("\n"));
	if (sub === "show") {
		const id = args[0] ?? cfg.machine.id;
		const local = `  配置:   resources ${JSON.stringify(cfg.machine.resources ?? [])}, priority ${cfg.machine.priority ?? "-"}（${join(paths.home, "config.json")}）\n  探测:   ${detectResources().join(", ")}`;
		const list = await hub.machines().then((r) => r.machines).catch(() => undefined);
		const m = list?.find((x) => x.id === id);
		if (m) return printMachine(m, m.self ? local : undefined);
		if (id !== cfg.machine.id) die(`unknown machine ${id}`);
		return printMachine(
			{ id, self: true, online: true, hops: 0, description: cfg.machine.description, priority: cfg.machine.priority, resourceNotes: cfg.machine.resourceNotes, resources: mergeResources(detectResources(), cfg.machine.resources) },
			`${local}\n  （hub 未运行）`,
		);
	}
	// set
	const machine = flag(args, "--machine");
	const pr = flag(args, "--priority");
	const res = flag(args, "--resources");
	const add = flags(args, "--add").flatMap((x) => normalizeRequires(x));
	const remove = flags(args, "--remove").flatMap((x) => normalizeRequires(x));
	const notes = flag(args, "--notes");
	const desc = flag(args, "--desc");
	const owner = flag(args, "--owner");
	if (args.length) die(`unknown arguments: ${args.join(" ")}`);
	const input: Parameters<typeof hub.configureMachine>[0] & { addResources?: string[]; removeResources?: string[] } = { machine };
	if (pr !== undefined) input.priority = /^(none|null|default|)$/i.test(pr) ? null : Number(pr);
	if (typeof input.priority === "number" && !Number.isFinite(input.priority)) die(`invalid --priority ${pr}`);
	if (res !== undefined) input.resources = /^(none|null|)$/i.test(res) ? null : normalizeRequires(res);
	if (add.length) input.addResources = add;
	if (remove.length) input.removeResources = remove;
	if (notes !== undefined) input.resourceNotes = notes || null;
	if (desc !== undefined) input.description = desc;
	if (owner !== undefined) input.owner = /^(none|null|)$/i.test(owner) ? null : owner;
	if (Object.keys(input).length === 1) die("usage: quick machine set [--machine M] [--priority N] [--resources a,b] [--add t] [--remove t] [--notes 文本] [--desc 描述]");
	if (await hubAlive()) return printMachine({ ...(await hub.configureMachine(input)), self: !machine || machine === cfg.machine.id, online: true, hops: 0 } as MachineView);
	if (machine && machine !== cfg.machine.id) die("hub 未运行，无法设置其他机器（quick hub start）");
	saveConfigPatch((raw) => {
		raw.machine = { ...(raw.machine ?? {}), id: raw.machine?.id ?? cfg.machine.id };
		if (input.priority === null) delete raw.machine.priority;
		else if (input.priority !== undefined) raw.machine.priority = input.priority;
		if (input.resources === null) delete raw.machine.resources;
		else if (input.resources) raw.machine.resources = input.resources;
		raw.machine.resources = applyResourceEdits(raw.machine.resources, add, remove);
		if (!raw.machine.resources) delete raw.machine.resources;
		if (input.resourceNotes === null) delete raw.machine.resourceNotes;
		else if (input.resourceNotes !== undefined) raw.machine.resourceNotes = input.resourceNotes;
		if (desc !== undefined) raw.machine.description = desc;
		if (input.owner === null) delete raw.machine.owner;
		else if (input.owner) raw.machine.owner = input.owner;
	});
	const c = loadConfig();
	printMachine({ id: c.machine.id, self: true, online: true, hops: 0, description: c.machine.description, priority: c.machine.priority, resourceNotes: c.machine.resourceNotes, resources: mergeResources(detectResources(), c.machine.resources) });
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

function openBrowser(url: string) {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	return spawnSync(opener, [url], { stdio: "ignore" }).status === 0;
}

/** Web UI: chat with a front agent hosted in ui/server.ts plus a live task panel. */
async function ui(args: string[]) {
	const sub = args[0] && !args[0].startsWith("-") ? args[0] : "open";
	const flag = (n: string) => args.includes(n);
	const ci = args.indexOf("--cwd");
	const cwd = ci >= 0 ? (args[ci + 1] ?? die("--cwd needs a value")) : process.env.PWD || process.cwd();
	if (sub === "stop") return console.log((await stopUi()) ? "web ui stopped" : "web ui not running");
	if (sub === "url") return console.log(uiLoginUrl(cfg));
	if (sub === "logs") return void spawnSync("tail", ["-n", "80", "-f", paths.uiLog], { stdio: "inherit" });
	if (sub === "status") {
		const h = await uiHealth(cfg);
		return console.log(h ? `web ui running at ${uiLoginUrl(cfg)} (pid ${h.pid}, cwd ${h.cwd})` : "web ui not running (quick ui)");
	}
	if (sub === "restart") await stopUi();
	else if (sub !== "open") die(`unknown: quick ui ${sub}`);
	await hubStart(true);
	const r = await ensureUi(cfg, { cwd, freshFront: flag("--fresh-front") }).catch((e) => die((e as Error).message));
	const h = await uiHealth(cfg);
	console.log(`${r === "started" ? "web ui started" : "web ui already running"} (cwd ${h?.cwd ?? cwd}, log ${paths.uiLog})\n${uiLoginUrl(cfg)}`);
	if (r === "running" && h && h.cwd !== cwd && ci >= 0) console.log(`注意：已有 Web UI 在 ${h.cwd} 运行；要换目录请 quick ui restart --cwd ${cwd}`);
	if (!flag("--no-open") && !openBrowser(uiLoginUrl(cfg))) console.log("(无法自动打开浏览器，请手动打开上面的地址)");
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
			if (sub === "reload") return hubReload();
			if (sub === "logs") return void spawnSync("tail", ["-n", "80", "-f", paths.log], { stdio: "inherit" });
			if (await hubAlive()) {
				const h = await hub.health();
				return console.log(`hub running at ${hubUrl(cfg)} (pid ${h.pid}, ${h.tasks} tasks)`);
			}
			return console.log("hub not running (quick hub start)");
		}
		case "attention":
		case "a":
		case "inbox":
		case "ls":
		case "tasks": {
			const all = rest.includes("-a");
			const q = await hub.attention(all ? 200 : 0);
			const grouped = cmd === "attention" || cmd === "a" || cmd === "inbox";
			console.log(countsLine(q.counts, q.focus));
			const items = q.items.filter((i) => all || i.level !== "archived");
			if (!items.length) return console.log("没有需要你的事，也没有进行中的任务");
			// Attention level first, project second (cli/projects.ts).
			return printAttention(hub, items, attnLine, { grouped, project: flag(rest, "--project"), byProject: rest.includes("--by-project") });
		}
		case "snooze": {
			const id = rest[0] ?? die("usage: quick snooze <id> [minutes]");
			const t = await hub.snooze(id, rest[1] === undefined ? 60 : Number(rest[1]));
			return console.log(attnLine(attentionOf(t)));
		}
		case "retry":
			return console.log(attnLine(attentionOf(await hub.retry(rest[0] ?? die("usage: quick retry <id>")))));
		case "focus": {
			const arg = rest[0];
			if (arg === "status") {
				const q = await hub.attention(0);
				return console.log(countsLine(q.counts, q.focus));
			}
			const f = await hub.setFocus(arg !== "off", arg && arg !== "off" ? Number(arg) : undefined);
			return console.log(f.on ? `专注模式开启${f.until ? `，至 ${new Date(f.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "（quick focus off 关闭）"}：只有「需要你」会打扰` : "专注模式已关闭");
		}
		case "log": {
			const id = rest.find((x) => !x.startsWith("-") && !/^\d+$/.test(x)) ?? die("usage: quick log <id> [-f] [-n N]");
			const n = Number(flag(rest, "-n") ?? 40);
			let page = await hub.transcript(id, { limit: n });
			if (!page.available) console.log("(还没有工作记录：worker 尚未开始)");
			for (const e of page.entries) console.log(entryText(e));
			if (!rest.includes("-f")) return;
			let last = page.total - 1;
			const shown = new Set(page.entries.filter((e) => !(e.kind === "tool" && e.running)).map((e) => e.i));
			for (;;) {
				await new Promise((r) => setTimeout(r, 2000));
				const from = Math.min(last, page.pendingFrom !== undefined ? page.pendingFrom - 1 : last);
				page = await hub.transcript(id, { after: from, limit: 200 }).catch(() => page);
				for (const e of page.entries) {
					if (shown.has(e.i) || (e.kind === "tool" && e.running)) continue;
					shown.add(e.i);
					console.log(entryText(e));
				}
				last = Math.max(last, page.total - 1);
			}
		}
		case "show": {
			const id = rest[0] ?? die("usage: quick show <id>");
			const { task: t, events } = await hub.getTask(id, 30);
			const a = attentionOf(t);
			if (t.lifecycle?.phase === "human_approval") {
				a.options = undefined;
				a.actions = a.actions.filter((x) => x.id !== "reply");
			}
			console.log(`${a.mark} ${t.id} [${LEVEL_LABEL[a.level]}] ${t.title}\n  注意力: ${a.reason}${a.options?.length ? `\n  选项: ${a.options.join(" / ")}` : ""}\n  可以: ${a.actions.map((x) => x.label).join(" / ") || "-"}\n  cwd: ${t.cwd}\n  接管: quick attach ${t.id}${ACTIVE_STATUSES.includes(t.status) ? `\n  当前: ${progressLine(t) || "-"}` : ""}${rest.includes("--debug") ? `\n  [debug] activity ${t.activity ?? "-"}` : ""}${rest.includes("--debug") ? `\n  [debug] tmux ${t.tmuxTarget ?? "-"} · resume file ${t.sessionFile ?? "-"}` : ""}`);
			if (t.lifecycle) {
				const l = t.lifecycle;
				console.log(`\n── 生命周期 ──\n  阶段: ${l.phase}\n  策略: 模板 ${l.policy.template} · workspace=${l.policy.workspace} · review=${l.policy.review}\n  原因: ${l.policy.reason}\n  head: ${l.head ?? "(尚无提交)"}`);
				if (l.workspace) console.log(`  工作区: ${l.workspace.cwd}\n  分支: ${l.workspace.branch} → ${l.workspace.baseBranch}\n  基线: ${l.workspace.baseSha}\n  diff: ${l.head ? `${l.workspace.baseSha}..${l.head}` : "(等待 head)"}`);
				if (l.review) console.log(`  审查: ${l.review.verdict} · ${l.review.sha}${l.review.sha !== l.head ? "（与当前 head 不一致）" : ""}\n${l.review.summary}`);
				if (l.approval) console.log(`  人工批准: ${l.approval.sha} · ${l.approval.by}${l.approval.sha !== l.head ? "（与当前 head 不一致）" : ""}`);
				if (l.error) console.log(`  错误: ${l.error}`);
				if (l.devUpdated !== undefined) console.log(`  dev 工作区: ${l.devUpdated ? "已更新" : "未更新，保留现有工作区"}`);
				console.log(`  Release: ${l.release || "未报告（与代码集成分开追踪）"}`);
				if (l.phase === "human_approval") {
					console.log(l.head ? `  批准此 SHA: quick approve ${t.id} --sha ${l.head}` : "  尚无 head SHA，不能批准");
					console.log(`  要求修改: quick changes ${t.id} <修改意见>\n  普通消息 / 回答不代表批准。`);
				}
			}
			if (t.expect) {
				const tm = timingOf(t);
				console.log(`  用时: ${tm.label}（已用 / 预期，${EXPECT_SOURCE_LABEL[t.expect.source]}${t.expect.reason ? `：${t.expect.reason}` : ""}）${tm.mark ? ` ${tm.mark}` : ""}${t.watch?.off ? " · 巡检已关闭" : ""}`);
			}
			if (ACTIVE_STATUSES.includes(t.status) || t.progress?.steps?.length) console.log(`\n── 进度 ──\n${progressText(t)}`);
			if (t.watch?.reviews?.length) console.log(`\n── 巡检 ──\n${t.watch.reviews.slice(-5).map((r) => `${new Date(r.at).toLocaleTimeString()} ${reviewLine(r)}${r.evidence ? `\n  依据: ${r.evidence}` : ""}${r.advice ? `\n  建议: ${r.advice}` : ""}${r.error ? `\n  错误: ${r.error}` : ""}`).join("\n")}`);
			console.log(`\n── 汇报 ──\n${t.summary ?? "(暂无)"}`);
			console.log(`\n── 事件 ──\n${events.map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.kind}${e.status ? `→${e.status}` : ""} ${(e.text ?? "").split("\n")[0]?.slice(0, 120)}`).join("\n")}`);
			console.log(`\n── 简报 ──\n${t.brief}`);
			// Reading a finished task settles 待扫; a question still waits for an answer.
			if (a.level === "skim") await hub.ack(id);
			return;
		}
		case "watch": {
			const [id, op = "show", val] = rest;
			if (!id) die("usage: quick watch <id> [on|off|now|expect 30m]");
			const body = op === "on" ? { off: false } : op === "off" ? { off: true } : op === "now" ? { now: true } : op === "expect" ? { expected: val ?? die("usage: quick watch <id> expect 30m") } : op === "show" ? undefined : die(`unknown: ${op} (on|off|now|expect)`);
			const t = body ? await hub.watch(id, body) : (await hub.getTask(id, 0)).task;
			const tm = timingOf(t);
			console.log(`${t.id} 用时 ${tm.label}${tm.mark ? ` ${tm.mark}` : ""} · 巡检${t.watch?.off ? "已关闭" : "开启"}${op === "now" ? " · 已发起一次巡检" : ""}`);
			for (const r of t.watch?.reviews?.slice(-5) ?? []) console.log(`  ${new Date(r.at).toLocaleTimeString()} ${reviewLine(r)}`);
			return;
		}
		case "new": {
			await hubStart(true);
			let cwd = process.cwd();
			const args = [...rest];
			const expected = flag(args, "--expected");
			const noWatchdog = args.includes("--no-watchdog");
			if (noWatchdog) args.splice(args.indexOf("--no-watchdog"), 1);
			const i = args.indexOf("--cwd");
			if (i >= 0) {
				cwd = args[i + 1] ?? die("--cwd needs a value");
				args.splice(i, 2);
			}
			const pi = args.indexOf("--project");
			let project: string | undefined;
			if (pi >= 0) {
				project = args[pi + 1] ?? die("--project needs a value");
				args.splice(pi, 2);
				if (i < 0) cwd = ""; // the project's checkout on the chosen machine
			}
			const requires = normalizeRequires(flags(args, "--requires").join(","));
			if (requires.length && i < 0) cwd = ""; // resource-based pick: use the chosen machine's default cwd unless --cwd is given
			let machine: string | undefined;
			const mi = args.indexOf("--machine");
			if (mi >= 0) {
				machine = args[mi + 1] ?? die("--machine needs a value");
				args.splice(mi, 2);
				if (i < 0) cwd = ""; // remote: use that machine's default cwd unless --cwd is given
			}
			// team: --reviewer 验收人, --assignee 负责人, --watch a,b 关注者
			const reviewer = flag(args, "--reviewer");
			const assignee = flag(args, "--assignee");
			const watchers = flags(args, "--watch").flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
			const [title, ...brief] = args;
			if (!title || !brief.length) die("usage: quick new [--machine M] [--requires a,b] [--cwd DIR] [--reviewer 人] [--assignee 人] [--watch a,b] <title> <brief...>");
			// cwd defaults to the current directory: the hub picks the best machine on which it exists.
			const t = await hub.createTask({ title, brief: brief.join(" "), cwd: cwd || undefined, machine, requires: requires.length ? requires : undefined, reviewer, assignee, watchers: watchers.length ? watchers : undefined, source: { kind: "cli" }, project, expected, ...(noWatchdog ? { watch: false } : {}) });
			return console.log(attnLine(attentionOf(t)));
		}
		case "send": {
			const [id, ...msg] = rest;
			if (!id || !msg.length) die("usage: quick send <id> <message>");
			return console.log(attnLine(attentionOf(await hub.sendMessage(id, msg.join(" ")))));
		}
		case "approve": {
			const args = [...rest];
			const sha = flag(args, "--sha");
			const [id] = args;
			if (!id || id.startsWith("-") || args.length !== 1 || !sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) die("usage: quick approve <id> --sha <完整 commit SHA>");
			const { task } = await hub.request<{ task: Task }>("POST", `/api/tasks/${encodeURIComponent(id)}/approve`, { sha });
			return console.log(attnLine(attentionOf(task)));
		}
		case "changes": {
			const [id, ...msg] = rest;
			const text = msg.join(" ").trim();
			if (!id || id.startsWith("-") || !text) die("usage: quick changes <id> <message>");
			const { task } = await hub.request<{ task: Task }>("POST", `/api/tasks/${encodeURIComponent(id)}/changes`, { text });
			return console.log(attnLine(attentionOf(task)));
		}
		case "cancel":
			return console.log(attnLine(attentionOf(await hub.cancel(rest[0] ?? die("usage: quick cancel <id>")))));
		case "close":
			return console.log(attnLine(attentionOf(await hub.close(rest[0] ?? die("usage: quick close <id>")))));
		case "ack":
			return console.log(attnLine(attentionOf(await hub.ack(rest[0] ?? die("usage: quick ack <id>")))));
		case "handoff":
			return handoffCmd(rest);
		case "attach":
			return attach(rest[0] ?? die("usage: quick attach <id>"));
		case "projects":
		case "project":
			return projectsCmd(hub, rest);
		case "machines": {
			const r = await hub.machines();
			const first = rankMachines(r.machines.filter((m) => m.online))[0]?.id;
			for (const m of r.machines) {
				console.log(
					`${m.online ? "●" : "○"} ${m.id.padEnd(16)} ${(m.self ? "self" : m.hops === -1 ? "offline" : m.hops === 1 ? "direct" : `via ${m.via} (${m.hops} hops)`).padEnd(8)} P${String(priorityOf(m)).padEnd(4)}${m.id === first ? "★ " : "  "}\x1b[2m${m.description ?? ""}${m.activeTasks ? ` · ${m.activeTasks} running` : ""}\x1b[0m`,
				);
				console.log(`  \x1b[2m资源: ${resourcesOf(m).join(", ") || "（未声明）"}${m.resources ? "" : "（由系统推断）"}${m.resourceNotes ? ` — ${m.resourceNotes}` : ""}\x1b[0m`);
			}
			console.log("\x1b[2mP = 优先级（越小越优先），★ = 不指定机器时的默认派单目标\x1b[0m");
			if (r.machines.some((m) => m.version)) console.log(`\x1b[2m版本: ${r.machines.map((m) => `${m.id} ${m.version ?? "?"}`).join(" · ")}\x1b[0m`);
			if (!r.links.enabled) console.log("\n(mesh 未启用：运行 quick mesh init)");
			for (const d of r.links.dialed) console.log(`  → ${d.label}: ${d.state}${d.peer ? ` (${d.peer})` : ""}${d.error ? ` — ${d.error}` : ""}`);
			for (const l of r.links.inbound) console.log(`  ← ${l.peer} from ${l.label}`);
			return;
		}
		case "machine":
			return machineCmd(rest);
		case "team":
			return teamCmd(rest, hub, cfg);
		case "assign":
			return assignCmd(rest, hub);
		case "comment":
			return commentCmd(rest, hub);
		case "cron":
			return cronCmd(rest);
		case "mesh":
			return mesh(rest);
		case "upgrade":
		case "update":
			return upgrade(rest);
		case "ui":
			return ui(rest);
		case "version":
		case "--version":
		case "-v": {
			const st = await updateStatus({ timeoutMs: 4000 });
			const h = await hub.health().catch(() => undefined);
			console.log(`quick-agent ${readVersion()}（${KIND_LABEL[st.kind]}，${st.root}）`);
			if (st.installed !== readVersion()) console.log(`已安装 ${st.installed}（新进程使用）`);
			if (h?.version) console.log(`hub 运行 ${h.version}`);
			console.log(`最新 Release ${st.latest ? `${st.latest.version}  ${st.latest.url ?? ""}` : `?（${st.error ?? "未知"}）`}`);
			if (st.available) console.log(hintLine(st));
			return;
		}
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

async function handoffCmd(args: string[]) {
	const a = [...args];
	const cwd = flag(a, "--cwd");
	const wait = flag(a, "--wait");
	const onConflict = flag(a, "--on-conflict") as "fail" | "stash" | "backup" | undefined;
	const testFail = flag(a, "--test-fail");
	const bool = (n: string) => {
		const i = a.indexOf(n);
		if (i >= 0) a.splice(i, 1);
		return i >= 0;
	};
	const noWorkspace = bool("--no-workspace");
	const abort = bool("--abort");
	const noFollow = bool("--no-follow");
	const [id, to] = a;
	if (!id || !to) die("usage: quick handoff <id> <machine> [--cwd DIR] [--no-workspace] [--abort] [--wait SEC] [--on-conflict fail|stash|backup] [--no-follow]");
	if (onConflict && !["fail", "stash", "backup"].includes(onConflict)) die("--on-conflict must be fail, stash or backup");
	const before = (await hub.getTask(id, 0)).task;
	const t = await hub.handoff(id, { to, cwd, noWorkspace, abort, waitSec: wait ? Number(wait) : undefined, onConflict, testFail });
	console.log(`⇄ ${t.id} ${before.machine} → ${to}: started`);
	if (noFollow) return;
	let last = "";
	for (;;) {
		await new Promise((r) => setTimeout(r, 700));
		let cur: Task;
		let events: { kind: string; text?: string }[];
		try {
			({ task: cur, events } = await hub.getTask(id, 5));
		} catch {
			continue; // ownership moving between hubs
		}
		if (cur.status === "handoff") {
			if (cur.activity && cur.activity !== last) console.log(`  ${(last = cur.activity)}`);
			continue;
		}
		const ev = [...events].reverse().find((e) => e.kind === "handoff");
		if (cur.machine === to) {
			console.log(`✓ ${cur.id} 现在在 ${cur.machine} 上（${cur.cwd}，状态 ${cur.status}）${ev?.text ? `\n  ${ev.text}` : ""}`);
			return;
		}
		if (cur.machine === before.machine) die(ev?.text ?? `handoff did not complete (status ${cur.status})`);
	}
}

// ---------------------------------------------------------------- cron

function rel(ms: number) {
	const d = ms - Date.now();
	// two most significant units are enough: "1d6h", "2h5m", "45s"
	const short = (x: number) => formatDuration(x > 3600_000 ? Math.round(x / 60_000) * 60_000 : Math.round(x / 1000) * 1000).match(/^\d+[dhms](\d+[dhms])?/)![0];
	return d >= 0 ? `in ${short(Math.max(1000, d))}` : `${short(-d)} ago`;
}
function cronState(j: CronView) {
	if (j.finished) return "[DONE]";
	if (!j.enabled) return "[OFF] ";
	return j.running ? "[RUN] " : "[ON]  ";
}
function cronLine(j: CronView) {
	const where = j.hub !== cfg.machine.id ? `@${j.hub}` : "";
	const next = j.nextRunAt ? `next ${formatWall(j.nextRunAt, j.tz)} (${rel(j.nextRunAt)})` : j.finished ? "finished" : j.enabled ? "next -" : "paused";
	const last = j.tasks[0] ? `last ${j.tasks[0].id} ${j.tasks[0].status ?? "?"}` : "";
	const lastRun = j.runs[j.runs.length - 1];
	const lastNote = lastRun && lastRun.result !== "dispatched" ? ` [${lastRun.result.toUpperCase()}]` : "";
	return `${cronState(j)} ${(j.id + where).padEnd(6)} ${j.title}  \x1b[2m${j.describe} · ${next}${last ? ` · ${last}` : ""}${lastNote}\x1b[0m`;
}

async function cronCmd(args: string[]) {
	const sub = args.shift() ?? "ls";
	if (sub === "add" || sub === "new") {
		const a = [...args];
		const bool = (n: string) => {
			const i = a.indexOf(n);
			if (i >= 0) a.splice(i, 1);
			return i >= 0;
		};
		const input: Parameters<typeof hub.createCron>[0] = { title: "", brief: "", createdBy: "cli" };
		for (const [f, k] of [["--cron", "cron"], ["--every", "every"], ["--at", "at"], ["--in", "in"], ["--tz", "tz"], ["--machine", "machine"], ["--cwd", "cwd"], ["--hub", "hub"], ["--project", "project"]] as const) {
			const v = flag(a, f);
			if (v !== undefined) (input as any)[k] = v;
		}
		const req = normalizeRequires(flags(a, "--requires").join(","));
		if (req.length) input.requires = req;
		const overlap = flag(a, "--overlap");
		if (overlap) input.overlap = overlap as any;
		const cu = flag(a, "--catch-up");
		if (cu) input.catchUp = cu as any;
		if (bool("--silent")) input.silent = true;
		if (bool("--paused")) input.enabled = false;
		// Like `quick new`: default cwd is the current directory unless a machine/resources are given.
		if (!input.cwd && !input.machine && !req.length && !input.hub && !(input as any).project) input.cwd = process.cwd();
		const unknown = a.find((x) => x.startsWith("--"));
		if (unknown) die(`unknown option ${unknown}`);
		const [title, ...brief] = a;
		if (!title || !brief.length) die('usage: quick cron add (--cron "0 9 * * *" | --every 2h | --at "YYYY-MM-DD HH:MM" | --in 30m) [options] <title> <brief...>');
		input.title = title;
		input.brief = brief.join(" ");
		await hubStart(true);
		const j = await hub.createCron(input);
		console.log(cronLine(j));
		return;
	}
	if (sub === "ls" || sub === "list") {
		const r = await hub.listCron();
		const list = r.jobs.filter((j) => args.includes("-a") || !j.finished);
		if (!list.length) return console.log(r.jobs.length ? "no active scheduled jobs (quick cron ls -a)" : "no scheduled jobs (quick cron add)");
		console.log(list.map(cronLine).join("\n"));
		return;
	}
	const id = args[0] ?? die(`usage: quick cron ${sub} <id>`);
	switch (sub) {
		case "show": {
			const j = await hub.getCron(id);
			console.log(cronLine(j));
			console.log(`  hub: ${j.hub}   tz: ${j.tz}   overlap: ${j.overlap}   catch-up: ${j.catchUp}${j.silent ? "   silent" : ""}`);
			console.log(`  dispatch: machine ${j.machine ?? "(auto)"} · requires ${j.requires?.join(",") || "-"} · cwd ${j.cwd ?? "(machine default)"}`);
			console.log(`  runs: ${j.runCount}${j.lastRunAt ? ` · last ${formatWall(j.lastRunAt, j.tz, true)}` : ""}${j.queued ? " · 1 queued" : ""}`);
			console.log(`\n-- recent --`);
			for (const r of [...j.runs].reverse().slice(0, 10)) {
				const t = r.taskId ? j.tasks.find((x) => x.id === r.taskId) : undefined;
				console.log(`  ${formatWall(r.at, j.tz, true)}  ${r.trigger.padEnd(8)} ${`[${r.result.toUpperCase()}]`.padEnd(13)} ${r.taskId ?? ""}${t?.status ? ` ${t.status}` : ""}${r.reason ? `  \x1b[2m${r.reason}\x1b[0m` : ""}`);
			}
			console.log(`\n-- brief --\n${j.brief}`);
			return;
		}
		case "rm":
		case "delete":
			await hub.cronAction(id, "delete");
			return console.log(`deleted ${id}`);
		case "pause":
		case "resume":
			return console.log(cronLine(await hub.cronAction(id, sub)));
		case "run": {
			const r = await hub.runCron(id);
			console.log(r.run.result === "dispatched" ? `-> ${r.run.taskId} dispatched on ${r.run.machine}` : `[FAILED] ${r.run.reason}${r.run.taskId ? ` (task ${r.run.taskId})` : ""}`);
			if (r.run.result !== "dispatched") process.exitCode = 1;
			return;
		}
		default:
			die(`unknown: quick cron ${sub} (add | ls | show | rm | pause | resume | run)`);
	}
}

function main2(args: string[]) {
	[cmd = "help", ...rest] = args;
	return main();
}

const updateHint = startupUpdateCheck();
main()
	.then(async () => {
		const hint = await updateHint;
		if (hint && (process.stderr.isTTY || process.env.QA_UPDATE_HINT === "1")) console.error(`\x1b[2m${hint}\x1b[0m`);
	})
	.catch((e) => die((e as Error).message));
