// Jump into a worker's tmux window — shared by `quick attach` (CLI) and `/qa-attach` (pi TUI).
//
//   local task,  inside tmux   → tmux switch-client (pi keeps running in its own window)
//   local task,  outside tmux  → foreground `tmux attach-session` (caller hands over the terminal)
//   remote task, inside tmux   → new tmux window running `ssh -t <peer> tmux attach …` (or foreground, CLI)
//   remote task, outside tmux  → foreground `ssh -t <peer> tmux attach …`
//
// The ssh destination of a remote machine comes from the mesh peer this hub dialed to reach it.
import { spawn, spawnSync } from "node:child_process";
import type { QaConfig } from "./config.ts";
import type { HubClient } from "./hub-client.ts";
import type { Task } from "./types.ts";

export interface AttachPlan {
	id: string;
	/** Machine id when the task runs on another machine. */
	machine?: string;
	/** tmux target on the machine that runs the worker, e.g. "qa:t1a2b". */
	target: string;
	/** ssh destination + extra args (remote tasks). */
	ssh?: { dest: string; args: string[] };
}

export type AttachResult =
	| { kind: "switched"; message: string } // done; nothing else to do
	| { kind: "foreground"; cmd: string; args: string[]; message: string }; // caller must hand the terminal to this command

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function tmuxOk(...args: string[]): boolean {
	return spawnSync("tmux", args, { stdio: "ignore" }).status === 0;
}

/** Resolve where a task's window lives and how to reach it. Throws a user-facing Error. */
export async function planAttach(cfg: QaConfig, hub: HubClient, id: string, opts: { task?: Task; selfId?: string } = {}): Promise<AttachPlan> {
	let task = opts.task;
	if (!task) {
		try {
			task = (await hub.getTask(id, 0)).task;
		} catch (e) {
			if ((e as { status?: number }).status === 404) throw new Error(`没有任务 ${id}`);
			// Hub unreachable: still allow attaching to a local window by convention.
		}
	}
	const self = opts.selfId ?? cfg.machine.id;
	const target = task?.tmuxTarget ?? `${cfg.tmuxSession}:${id}`;
	const resume = `窗口已关闭，可以用 quick send ${id} "<消息>" 恢复 worker（TUI 里在 /tasks 中「追加指令」）`;
	if (!task?.machine || task.machine === self) {
		if (task?.closed || !tmuxOk("list-panes", "-t", target)) throw new Error(`${id}: ${resume}`);
		return { id, target };
	}
	const machine = task.machine;
	if (task.closed) throw new Error(`${id}@${machine}: ${resume}`);
	const ssh = await sshFor(cfg, hub, machine);
	const screen = await hub.request<{ alive: boolean }>("GET", `/api/tasks/${encodeURIComponent(id)}/screen`).catch(() => undefined);
	if (screen && !screen.alive) throw new Error(`${id}@${machine}: ${resume}`);
	return { id, machine, target, ssh };
}

async function sshFor(cfg: QaConfig, hub: HubClient, machine: string): Promise<{ dest: string; args: string[] }> {
	const r = await hub.machines().catch(() => undefined);
	const dialed: { label: string; peer?: string }[] = r?.links?.dialed ?? [];
	const link = dialed.find((d) => d.peer === machine);
	const peer = link && cfg.mesh.peers.find((p) => (p.url ?? `ssh:${p.ssh}`) === link.label);
	if (peer?.ssh) return { dest: peer.ssh, args: peer.sshArgs ?? [] };
	const m = r?.machines?.find((x) => x.id === machine);
	const why = peer?.url
		? `本机通过 URL（${peer.url}）连接 ${machine}，没有 ssh 目标`
		: m && m.hops > 1
			? `${machine} 经由 ${m.via} 中转（${m.hops} 跳），本机没有直连它的 ssh 目标`
			: r?.links?.inbound?.some((l: { peer: string }) => l.peer === machine)
				? `${machine} 是主动连到本机的（入站链路），本机没有它的 ssh 目标`
				: `找不到连到 ${machine} 的 ssh peer${r ? "" : "（hub 不可达）"}`;
	throw new Error(`${why}。可以在 ${machine} 上运行 quick attach，或用 quick mesh add <ssh目标> 把它加为 ssh peer`);
}

/** The ssh command (argv) that attaches to a remote worker window. */
function sshArgv(plan: AttachPlan): string[] {
	const ssh = plan.ssh!;
	// Login shell so tmux is found even when it lives outside the default non-interactive PATH.
	return ["-t", ...ssh.args, ssh.dest, "bash", "-lc", shq(`tmux attach-session -t ${shq(plan.target)}`)];
}

const label = (p: AttachPlan) => (p.machine ? `${p.id}@${p.machine}` : p.id);

/**
 * Perform the parts of an attach that do not need the terminal.
 * `remoteWindow`: inside tmux, run remote attaches in a new tmux window instead of the foreground.
 */
export function openAttach(plan: AttachPlan, opts: { inTmux?: boolean; remoteWindow?: boolean } = {}): AttachResult {
	const inTmux = opts.inTmux ?? Boolean(process.env.TMUX);
	if (!plan.ssh) {
		if (inTmux) {
			const r = spawnSync("tmux", ["switch-client", "-t", plan.target], { encoding: "utf8" });
			if (r.status !== 0) throw new Error(`tmux switch-client 失败: ${(r.stderr || "").trim()}`);
			return { kind: "switched", message: `已切换到 ${plan.target}（C-b l 回到上一个窗口，跨 session 用 C-b L）` };
		}
		return { kind: "foreground", cmd: "tmux", args: ["attach-session", "-t", plan.target], message: `进入 ${plan.target}，按 C-b d 返回` };
	}
	const argv = sshArgv(plan);
	if (inTmux && opts.remoteWindow !== false) {
		const name = label(plan);
		const existing = spawnSync("tmux", ["list-windows", "-F", "#{window_id}\t#{window_name}"], { encoding: "utf8" })
			.stdout?.split("\n")
			.find((l) => l.split("\t")[1] === name)
			?.split("\t")[0];
		const shellCmd = `ssh ${argv.map(shq).join(" ")} || { echo; echo "ssh 退出（$?），按回车关闭窗口"; read _; }`;
		const r = existing ? spawnSync("tmux", ["select-window", "-t", existing], { encoding: "utf8" }) : spawnSync("tmux", ["new-window", "-n", name, shellCmd], { encoding: "utf8" });
		if (r.status !== 0) throw new Error(`tmux ${existing ? "select-window" : "new-window"} 失败: ${(r.stderr || "").trim()}`);
		return {
			kind: "switched",
			message: `已在 tmux 窗口「${name}」中打开 ${plan.ssh.dest}:${plan.target}（嵌套 tmux：C-b l 回到 pi，C-b C-b d 断开远程）`,
		};
	}
	return { kind: "foreground", cmd: "ssh", args: argv, message: `经 ssh ${plan.ssh.dest} 进入 ${plan.target}，按 C-b d 返回${inTmux ? "（嵌套 tmux 用 C-b C-b d）" : ""}` };
}

/** Run a foreground attach with the terminal handed over; resolves with the exit code. */
export function runForeground(r: Extract<AttachResult, { kind: "foreground" }>): Promise<number | null> {
	// Async spawn (not spawnSync) so the caller's event loop keeps running, as pi does for its external editor.
	return new Promise((resolve) => {
		const child = spawn(r.cmd, r.args, { stdio: "inherit" });
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code));
	});
}
