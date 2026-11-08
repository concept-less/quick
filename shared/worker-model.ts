// Worker default model (config.json workerModel): the model list of this machine's pi and validation of a
// "provider/id[:thinking]" spec against it. Used by the hub (GET/POST /api/worker-model, mesh workerModel.*).
// Zero dependencies (plain Node type stripping).
import { execFile } from "node:child_process";

export interface PiModel {
	provider: string;
	id: string;
	/** Supports a thinking level suffix (":high" …). */
	thinking: boolean;
	context?: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Parse the table printed by `pi --list-models` (provider model context max-out thinking images). */
export function parseModelList(out: string): PiModel[] {
	const models: PiModel[] = [];
	const seen = new Set<string>();
	let header = false;
	for (const line of out.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 2 || !cols[0]) continue;
		if (cols[0] === "provider" && cols[1] === "model") {
			header = true;
			continue;
		}
		if (!header || cols.length < 5) continue;
		const [provider, id, context, , thinking] = cols;
		const key = `${provider}/${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		models.push({ provider: provider!, id: id!, thinking: thinking === "yes", context });
	}
	return models;
}

/** Environment for pi subprocesses: never inherit a task / hub identity (a QA_TASK_ID would load the worker role). */
export function cleanPiEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!k.startsWith("QA_") && !k.startsWith("PI_") || k === "PI_CODING_AGENT_DIR" || k === "PI_PACKAGE_DIR") out[k] = v;
	out.NODE_NO_WARNINGS = "1";
	return out;
}

/** Run `pi --list-models` (QA_PI_BIN overrides the binary, for tests). Rejects with a readable message. */
export function listPiModels(timeoutMs = 45_000): Promise<PiModel[]> {
	const bin = process.env.QA_PI_BIN || "pi";
	return new Promise((resolve, reject) => {
		execFile(bin, ["--list-models"], { env: cleanPiEnv(), timeout: timeoutMs, maxBuffer: 8 << 20, cwd: process.env.HOME || "/" }, (err, stdout, stderr) => {
			if (err) return reject(new Error(`pi --list-models 失败：${(err as any).killed ? "超时" : String(stderr || err.message).trim().split("\n").slice(-2).join(" ")}`));
			const list = parseModelList(String(stdout));
			if (!list.length) return reject(new Error("pi --list-models 没有返回任何可用模型（检查 provider 配置或 API key）"));
			resolve(list);
		});
	});
}

export type ModelCheck = { ok: true; model: string } | { ok: false; error: string };

/** Validate "provider/id[:thinking]" against the models of a machine. */
export function checkModelSpec(spec: unknown, models: PiModel[]): ModelCheck {
	if (typeof spec !== "string" || !spec.trim()) return { ok: false, error: "模型不能为空（要继承 model 请清除设置）" };
	let s = spec.trim();
	if (/\s/.test(s)) return { ok: false, error: `模型标识不能含空白：${s}` };
	let level: string | undefined;
	const colon = s.lastIndexOf(":");
	if (colon > 0) {
		level = s.slice(colon + 1);
		s = s.slice(0, colon);
	}
	const slash = s.indexOf("/");
	if (slash <= 0 || slash === s.length - 1) return { ok: false, error: `模型要写成 provider/id：${spec}` };
	const provider = s.slice(0, slash);
	const id = s.slice(slash + 1);
	const m = models.find((x) => x.provider === provider && x.id === id);
	if (!m) {
		const near = models.filter((x) => x.id === id || x.id.endsWith(`/${id}`)).map((x) => `${x.provider}/${x.id}`);
		return { ok: false, error: `这台机器的 pi 里没有模型 ${provider}/${id}${near.length ? `（相近：${near.join(", ")}）` : ""}` };
	}
	if (level !== undefined) {
		if (!(THINKING_LEVELS as readonly string[]).includes(level)) return { ok: false, error: `未知思考级别 ${level}（可选 ${THINKING_LEVELS.join(" / ")}）` };
		if (!m.thinking) return { ok: false, error: `${provider}/${id} 不支持思考级别，去掉 :${level}` };
	}
	return { ok: true, model: level !== undefined ? `${provider}/${id}:${level}` : `${provider}/${id}` };
}
