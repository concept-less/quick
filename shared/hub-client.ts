// Minimal HTTP + SSE client for the quick-agent hub (uses global fetch).
import { hubUrl, loadConfig, type QaConfig } from "./config.ts";
import type { HubEvent, Intake, MachineView, Task, TaskEvent } from "./types.ts";

export class HubError extends Error {
	status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export class HubClient {
	readonly base: string;
	readonly token: string;

	constructor(cfg: QaConfig = loadConfig()) {
		this.base = hubUrl(cfg);
		this.token = process.env.QA_TOKEN ?? cfg.token;
	}

	async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		let res: Response;
		try {
			res = await fetch(this.base + path, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		} catch (err) {
			throw new HubError(`quick-agent hub unreachable at ${this.base} (${(err as Error).message}). Start it with: qa hub start`);
		}
		const text = await res.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { error: text };
		}
		if (!res.ok) throw new HubError(data?.error ?? `HTTP ${res.status}`, res.status);
		return data as T;
	}

	health() {
		return this.request<{ ok: boolean; pid: number; tasks: number }>("GET", "/health");
	}
	listTasks() {
		return this.request<{ tasks: Task[] }>("GET", "/api/tasks").then((r) => r.tasks);
	}
	getTask(id: string, events = 30) {
		return this.request<{ task: Task; events: TaskEvent[] }>("GET", `/api/tasks/${enc(id)}?events=${events}`);
	}
	createTask(input: {
		title: string;
		brief: string;
		cwd?: string;
		attachments?: string[];
		source?: Task["source"];
		model?: string;
		owner?: string;
		/** Machine to run the worker on (default: this hub's machine). */
		machine?: string;
	}) {
		return this.request<{ task: Task }>("POST", "/api/tasks", input).then((r) => r.task);
	}
	sendMessage(id: string, text: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/message`, { text }).then((r) => r.task);
	}
	cancel(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/cancel`, {}).then((r) => r.task);
	}
	close(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/close`, {}).then((r) => r.task);
	}
	ack(id: string) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/ack`, {}).then((r) => r.task);
	}
	/** Worker → hub state report. */
	report(id: string, body: { status?: Task["status"]; summary?: string; activity?: string; sessionFile?: string; kind?: TaskEvent["kind"] }) {
		return this.request<{ task: Task }>("POST", `/api/tasks/${enc(id)}/report`, body).then((r) => r.task);
	}
	machines() {
		return this.request<{ self: string; machines: MachineView[]; links: any }>("GET", "/api/machines");
	}
	fs(body: { machine?: string; op: "ls" | "read" | "grep"; path: string; pattern?: string; offset?: number; limit?: number }) {
		return this.request<any>("POST", "/api/fs", body);
	}
	pendingIntake() {
		return this.request<{ intake: Intake[] }>("GET", "/api/intake?status=pending").then((r) => r.intake);
	}
	claimIntake(id: string, by: string) {
		return this.request<{ intake: Intake }>("POST", `/api/intake/${enc(id)}/claim`, { by }).then((r) => r.intake);
	}
	updateIntake(id: string, body: { status?: Intake["status"]; taskId?: string }) {
		return this.request<{ intake: Intake }>("POST", `/api/intake/${enc(id)}`, body).then((r) => r.intake);
	}

	/**
	 * Subscribe to the hub event stream. Reconnects with backoff until `signal` aborts.
	 * `onState` reports connection changes.
	 */
	subscribe(
		onEvent: (e: HubEvent) => void,
		signal: AbortSignal,
		onState?: (connected: boolean) => void,
		query: Record<string, string> = {},
	): void {
		const qs = new URLSearchParams(query).toString();
		const loop = async () => {
			let delay = 500;
			while (!signal.aborted) {
				try {
					const res = await fetch(`${this.base}/api/events${qs ? `?${qs}` : ""}`, {
						headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
						signal,
					});
					if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
					onState?.(true);
					delay = 500;
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buf += decoder.decode(value, { stream: true });
						let idx: number;
						while ((idx = buf.indexOf("\n\n")) >= 0) {
							const frame = buf.slice(0, idx);
							buf = buf.slice(idx + 2);
							const data = frame
								.split("\n")
								.filter((l) => l.startsWith("data:"))
								.map((l) => l.slice(5).trimStart())
								.join("\n");
							if (!data) continue;
							try {
								onEvent(JSON.parse(data) as HubEvent);
							} catch {
								/* ignore malformed frame */
							}
						}
					}
				} catch {
					/* fall through to reconnect */
				}
				if (signal.aborted) break;
				onState?.(false);
				await new Promise((r) => setTimeout(r, delay));
				delay = Math.min(delay * 2, 10_000);
			}
		};
		void loop();
	}
}

function enc(s: string) {
	return encodeURIComponent(s);
}
