// 工作记录: the worker's full work log (text, thinking, tool calls + results, follow-up instructions, reports),
// read from the worker's pi session file and flattened into compact entries for the Web UI / `quick log`.
// The session file is append-only, so parsing is incremental (cached per file by byte offset); entry indexes
// are stable. A tool call entry is completed in place when its result arrives (`running` until then).
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export type EntryKind = "brief" | "instruction" | "user" | "text" | "thinking" | "tool" | "report" | "progress" | "note";
export interface TranscriptEntry {
	i: number;
	ts: number;
	kind: EntryKind;
	/** text / thinking / user message / report summary / note */
	text?: string;
	/** tool entries */
	tool?: string;
	args?: any;
	result?: string;
	diff?: string;
	isError?: boolean;
	running?: boolean;
	/** report status (done / progress / …) */
	status?: string;
	/** Some text field was cut; ask again with full=<i>. */
	truncated?: boolean;
}
export interface TranscriptPage {
	entries: TranscriptEntry[];
	/** Total number of entries so far. */
	total: number;
	/** Index of the first entry still running (re-read from there to get its result), if any. */
	pendingFrom?: number;
	/** The session file was found. */
	available: boolean;
}

interface Parsed {
	offset: number;
	size: number;
	entries: TranscriptEntry[];
	calls: Map<string, number>;
	users: number;
}
const cache = new Map<string, Parsed>();
const MAX_CACHE = 24;

const tsOf = (e: any) => {
	const n = Date.parse(e?.timestamp ?? "");
	return Number.isFinite(n) ? n : Date.now();
};
const textOf = (content: any): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[图片]" : ""))
					.filter(Boolean)
					.join("\n")
			: "";

function push(p: Parsed, e: Omit<TranscriptEntry, "i">) {
	const entry = { i: p.entries.length, ...e } as TranscriptEntry;
	p.entries.push(entry);
	return entry;
}

function ingest(p: Parsed, raw: any) {
	if (raw?.type === "compaction") return void push(p, { ts: tsOf(raw), kind: "note", text: "（较早的上下文已压缩，记录保留完整）" });
	if (raw?.type === "custom_message" && raw.display !== false) return void push(p, { ts: tsOf(raw), kind: "user", text: textOf(raw.content) });
	if (raw?.type !== "message") return;
	const m = raw.message ?? {};
	const ts = tsOf(raw);
	if (m.role === "user") {
		// A new prompt: tool calls that never got a result (aborted) are over.
		for (const k of p.calls.values()) p.entries[k]!.running = false;
		p.calls.clear();
		const text = textOf(m.content).trim();
		if (!text) return;
		p.users++;
		if (text.startsWith("【quick-agent 追加指令】")) return void push(p, { ts, kind: "instruction", text: text.replace(/^【quick-agent 追加指令】\s*/, "") });
		if (p.users === 1) return void push(p, { ts, kind: "brief", text });
		// Resumed workers get the instruction as a plain prompt; other 【…】 messages (team comments, notes) stay "user".
		return void push(p, { ts, kind: text.startsWith("【") ? "user" : "instruction", text });
	}
	if (m.role === "custom" && m.display !== false) {
		const text = textOf(m.content).trim();
		if (text) push(p, { ts, kind: "user", text });
		return;
	}
	if (m.role === "assistant") {
		for (const b of Array.isArray(m.content) ? m.content : []) {
			if (b?.type === "text" && b.text?.trim()) push(p, { ts, kind: "text", text: b.text.trim() });
			else if (b?.type === "thinking" && b.thinking?.trim()) push(p, { ts, kind: "thinking", text: b.thinking.trim() });
			else if (b?.type === "toolCall") {
				const args = b.arguments ?? {};
				if (b.name === "qa_report") push(p, { ts, kind: "report", status: args.status, text: String(args.summary ?? "") });
				else if (b.name === "qa_progress") push(p, { ts, kind: "progress", args });
				else {
					const e = push(p, { ts, kind: "tool", tool: b.name, args, running: true });
					if (b.id) p.calls.set(b.id, e.i);
				}
			}
		}
		if (m.stopReason === "error" && m.errorMessage) push(p, { ts, kind: "note", text: `出错：${m.errorMessage}` });
		if (m.stopReason === "aborted") push(p, { ts, kind: "note", text: "（已中断）" });
		return;
	}
	if (m.role === "toolResult") {
		const k = p.calls.get(m.toolCallId);
		if (k === undefined) return;
		p.calls.delete(m.toolCallId);
		const e = p.entries[k]!;
		e.running = false;
		e.result = textOf(m.content);
		e.isError = !!m.isError;
		if (typeof m.details?.diff === "string") e.diff = m.details.diff;
		return;
	}
	if (m.role === "bashExecution") push(p, { ts, kind: "tool", tool: "bash", args: { command: m.command }, result: m.output, running: false });
}

function parse(file: string): Parsed | undefined {
	if (!file || !existsSync(file)) return undefined;
	const size = statSync(file).size;
	let p = cache.get(file);
	if (!p || size < p.size) p = { offset: 0, size: 0, entries: [], calls: new Map(), users: 0 };
	if (size > p.offset) {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(size - p.offset);
			readSync(fd, buf, 0, buf.length, p.offset);
			// Only complete lines; a partially written last line is read next time.
			const end = buf.lastIndexOf(10);
			if (end >= 0) {
				for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					try {
						ingest(p, JSON.parse(line));
					} catch {}
				}
				p.offset += end + 1;
			}
		} finally {
			closeSync(fd);
		}
	}
	p.size = size;
	cache.delete(file);
	cache.set(file, p);
	while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
	return p;
}

const CUT = 1500;
function clipEntry(e: TranscriptEntry): TranscriptEntry {
	const out: TranscriptEntry = { ...e };
	for (const k of ["text", "result", "diff"] as const) {
		const v = out[k];
		if (typeof v === "string" && v.length > CUT) {
			out[k] = `${v.slice(0, CUT)}`;
			out.truncated = true;
		}
	}
	if (out.args && JSON.stringify(out.args).length > CUT * 2) {
		// Big write/edit payloads: keep the shape, cut long strings.
		out.args = JSON.parse(JSON.stringify(out.args, (_k, v) => (typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}` : v)));
		out.truncated = true;
	}
	return out;
}

/**
 * Page through the work log. after=N → entries with index > N (live tail); before=N → the `limit` entries
 * just before N (scroll back); neither → the last `limit` entries. full=N → that one entry, uncut.
 */
export function readTranscript(file: string | undefined, q: { after?: number; before?: number; limit?: number; full?: number } = {}): TranscriptPage {
	const p = file ? parse(file) : undefined;
	if (!p) return { entries: [], total: 0, available: false };
	const total = p.entries.length;
	const limit = Math.max(1, Math.min(Number(q.limit) || 80, 500));
	let list: TranscriptEntry[];
	if (q.full !== undefined && Number.isFinite(Number(q.full))) list = p.entries.slice(Number(q.full), Number(q.full) + 1).map((e) => ({ ...e }));
	else if (q.after !== undefined && Number.isFinite(Number(q.after))) list = p.entries.slice(Number(q.after) + 1, Number(q.after) + 1 + limit).map(clipEntry);
	else {
		const end = q.before !== undefined && Number.isFinite(Number(q.before)) ? Math.max(0, Number(q.before)) : total;
		list = p.entries.slice(Math.max(0, end - limit), end).map(clipEntry);
	}
	const pending = p.calls.size ? Math.min(...p.calls.values()) : undefined;
	return { entries: list, total, available: true, ...(pending !== undefined ? { pendingFrom: pending } : {}) };
}

/** Plain-text rendering of entries (quick log). */
export function entryText(e: TranscriptEntry): string {
	const time = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const ind = (s: string) => s.replace(/\n/g, "\n    ");
	switch (e.kind) {
		case "brief":
			return `${time} 简报  ${ind((e.text ?? "").split("\n").slice(0, 6).join("\n"))}`;
		case "instruction":
			return `${time} 追加指令  ${ind(e.text ?? "")}`;
		case "user":
			return `${time} 消息  ${ind(e.text ?? "")}`;
		case "text":
			return `${time} 输出  ${ind(e.text ?? "")}`;
		case "thinking":
			return `${time} 思考  ${ind((e.text ?? "").slice(0, 400))}`;
		case "report":
			return `${time} 汇报[${e.status ?? ""}]  ${ind(e.text ?? "")}`;
		case "progress":
			return `${time} 进度  ${JSON.stringify(e.args ?? {})}`;
		case "note":
			return `${time} ${e.text ?? ""}`;
		case "tool": {
			const a = e.args ?? {};
			const arg = a.command ?? a.path ?? a.pattern ?? a.query ?? (Object.keys(a).length ? JSON.stringify(a).slice(0, 200) : "");
			const res = e.running ? "  (运行中)" : e.result ? `\n    ${ind(e.result.split("\n").slice(-8).join("\n"))}` : "";
			return `${time} ${e.isError ? "x" : "$"} ${e.tool} ${String(arg).replace(/\s+/g, " ").slice(0, 200)}${res}`;
		}
	}
}
