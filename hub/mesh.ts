// quick-agent mesh: native multi-machine networking between hubs.
//
// Links. A hub dials its configured peers (outbound only, so NAT'd laptops can join):
//   GET  <peer>/mesh/link   SSE stream  peer → us   (frames as `data: <json>`)
//   POST <peer>/mesh/send   JSON batch  us → peer
// Both directions are authenticated with the shared mesh secret. Once up, a link is symmetric.
// SSH peers: the hub runs and supervises `ssh -N -L <free port>:127.0.0.1:<hub port> <target>` itself.
//
// Routing. Distance-vector with split horizon: every hub advertises the machines it can reach;
// the next hop for machine M is the link with the smallest hop count. Max 8 hops.
//
// Replication. Objects (tasks, intakes) are owned by one machine and carry a monotonic `rev`.
// Updates are flooded to all links; a receiver applies and forwards an update only if it is newer
// than what it has, so floods terminate without message ids. New links exchange a snapshot.
//
// RPC. Requests are addressed to a machine id and forwarded hop by hop; responses travel back the same way.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerConfig } from "../shared/config.ts";
import type { MachineInfo, MachineView } from "../shared/types.ts";

const MAX_HOPS = 8;
const RPC_TIMEOUT_MS = 30_000;

type Frame =
	| { t: "hello"; machine: string; info: MachineInfo }
	| { t: "routes"; list: { id: string; hops: number; info: MachineInfo }[] }
	| { t: "ev"; kind: string; data: any }
	| { t: "req"; id: string; to: string; from: string; method: string; params: any; ttl: number }
	| { t: "res"; id: string; to: string; ok: boolean; result?: any; error?: string; ttl: number }
	| { t: "ping" };

interface Link {
	peer: string; // remote machine id
	dir: "in" | "out";
	label: string; // url / ssh target, for status
	send(frame: Frame): void;
	close(): void;
	routes: Map<string, { hops: number; info: MachineInfo }>;
	lastRoutesSent?: string;
	connectedAt: number;
}

export interface MeshOptions {
	selfId: string;
	secret?: string;
	peers: PeerConfig[];
	info(): MachineInfo;
	/** Apply a replicated object. Return true if it was new (then it is forwarded). */
	onEvent(kind: string, data: any, from: string): boolean;
	/** Objects to send to a freshly connected peer. */
	snapshot(): { kind: string; data: any }[];
	/** Handle an RPC addressed to this machine. */
	onRequest(method: string, params: any, from: string): Promise<any>;
	onTopologyChange(): void;
	log(msg: string): void;
}

export class Mesh {
	private links = new Map<string, Link>();
	private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private dialers: Dialer[] = [];
	private table = new Map<string, { hops: number; via: string; info: MachineInfo }>();
	private offline = new Map<string, MachineInfo>(); // machines seen before but currently unreachable
	private timer?: NodeJS.Timeout;
	private o: MeshOptions;

	constructor(o: MeshOptions) {
		this.o = o;
	}

	get enabled() {
		return !!this.o.secret;
	}

	start() {
		if (!this.enabled) return;
		for (const p of this.o.peers) this.dialers.push(new Dialer(this, p, this.o.secret!, this.o.selfId, this.o.log));
		for (const d of this.dialers) d.start();
		this.timer = setInterval(() => {
			for (const l of this.links.values()) l.send({ t: "ping" });
			this.advertise(true);
		}, 20_000);
	}

	stop() {
		clearInterval(this.timer);
		for (const d of this.dialers) d.stop();
		for (const l of this.links.values()) l.close();
	}

	// ------------------------------------------------------------ auth

	checkSecret(req: IncomingMessage): boolean {
		if (!this.o.secret) return false;
		const h = String(req.headers.authorization ?? "");
		const want = Buffer.from(`Mesh ${this.o.secret}`);
		const got = Buffer.from(h);
		return got.length === want.length && timingSafeEqual(got, want);
	}

	// ------------------------------------------------------------ inbound link (we are the listener)

	handleLinkRequest(req: IncomingMessage, res: ServerResponse) {
		const peer = String(req.headers["x-qa-machine"] ?? "");
		if (!peer || peer === this.o.selfId) {
			res.writeHead(400).end(JSON.stringify({ error: "bad or duplicate machine id" }));
			return;
		}
		if (this.links.has(peer)) {
			res.writeHead(409).end(JSON.stringify({ error: `already linked with ${peer}` }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const link: Link = {
			peer,
			dir: "in",
			label: `${req.socket.remoteAddress ?? "?"}`,
			send: (f) => res.write(`data: ${JSON.stringify(f)}\n\n`),
			close: () => res.end(),
			routes: new Map(),
			connectedAt: Date.now(),
		};
		req.on("close", () => this.linkDown(link));
		this.linkUp(link);
	}

	/** POST /mesh/send from a peer that holds an inbound link to us. */
	handleSend(from: string, frames: Frame[]) {
		const link = this.links.get(from);
		if (!link || link.dir !== "in") throw new Error(`no inbound link from ${from}`);
		for (const f of frames) this.onFrame(link, f);
	}

	// ------------------------------------------------------------ link lifecycle

	linkUp(link: Link) {
		const existing = this.links.get(link.peer);
		if (existing) {
			link.close();
			return false;
		}
		this.links.set(link.peer, link);
		this.o.log(`link up: ${link.peer} (${link.dir}, ${link.label})`);
		link.send({ t: "hello", machine: this.o.selfId, info: this.o.info() });
		this.advertise(true);
		for (const ev of this.o.snapshot()) link.send({ t: "ev", kind: ev.kind, data: ev.data });
		return true;
	}

	linkDown(link: Link) {
		if (this.links.get(link.peer) !== link) return;
		this.links.delete(link.peer);
		this.o.log(`link down: ${link.peer}`);
		this.recompute();
	}

	// ------------------------------------------------------------ frames

	onFrame(link: Link, f: Frame) {
		switch (f.t) {
			case "hello":
				link.routes.set(f.machine, { hops: 0, info: f.info });
				this.recompute();
				return;
			case "routes":
				link.routes = new Map(f.list.filter((r) => r.id !== this.o.selfId).map((r) => [r.id, { hops: r.hops, info: r.info }]));
				this.recompute();
				return;
			case "ev":
				if (this.o.onEvent(f.kind, f.data, link.peer)) this.flood(f.kind, f.data, link.peer);
				return;
			case "req":
				return void this.routeRequest(f, link.peer);
			case "res":
				return this.routeResponse(f);
			case "ping":
				return;
		}
	}

	// ------------------------------------------------------------ routing

	private recompute() {
		const next = new Map<string, { hops: number; via: string; info: MachineInfo }>();
		for (const link of this.links.values()) {
			for (const [id, r] of link.routes) {
				if (id === this.o.selfId) continue;
				const hops = r.hops + 1;
				if (hops > MAX_HOPS) continue;
				const cur = next.get(id);
				if (!cur || hops < cur.hops) next.set(id, { hops, via: link.peer, info: r.info });
			}
		}
		for (const [id, r] of this.table) if (!next.has(id)) this.offline.set(id, r.info);
		for (const id of next.keys()) this.offline.delete(id);
		const changed = JSON.stringify([...this.table].map(([k, v]) => [k, v.hops, v.via])) !== JSON.stringify([...next].map(([k, v]) => [k, v.hops, v.via]));
		this.table = next;
		this.advertise(false);
		if (changed) this.o.onTopologyChange();
	}

	/** Send our routing table to every link (split horizon: never advertise a route back to its next hop). */
	advertise(force: boolean) {
		const self = { id: this.o.selfId, hops: 0, info: this.o.info() };
		for (const link of this.links.values()) {
			const list = [self, ...[...this.table].filter(([, r]) => r.via !== link.peer).map(([id, r]) => ({ id, hops: r.hops, info: r.info }))];
			const key = JSON.stringify(list.map((r) => [r.id, r.hops]));
			if (!force && key === link.lastRoutesSent) continue;
			link.lastRoutesSent = key;
			link.send({ t: "routes", list });
		}
	}

	machines(): MachineView[] {
		const out: MachineView[] = [{ ...this.o.info(), self: true, online: true, hops: 0 }];
		for (const [id, r] of this.table) out.push({ ...r.info, id, self: false, online: true, hops: r.hops, via: r.hops > 1 ? r.via : undefined });
		for (const [id, info] of this.offline) out.push({ ...info, id, self: false, online: false, hops: -1 });
		return out;
	}

	linkStatus() {
		const dialed = this.dialers.map((d) => d.status());
		const inbound = [...this.links.values()].filter((l) => l.dir === "in").map((l) => ({ peer: l.peer, dir: "in", label: l.label, since: l.connectedAt }));
		return { enabled: this.enabled, self: this.o.selfId, dialed, inbound };
	}

	reachable(machine: string) {
		return machine === this.o.selfId || this.table.has(machine);
	}

	// ------------------------------------------------------------ replication

	/** Send an object update to all links except `except`. */
	flood(kind: string, data: any, except?: string) {
		for (const link of this.links.values()) if (link.peer !== except) link.send({ t: "ev", kind, data });
	}

	// ------------------------------------------------------------ RPC

	request<T = any>(to: string, method: string, params: any, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
		if (to === this.o.selfId) return this.o.onRequest(method, params, this.o.selfId);
		const route = this.table.get(to);
		if (!route) return Promise.reject(new Error(`machine ${to} is not reachable`));
		const id = randomBytes(8).toString("hex");
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`request ${method} to ${to} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.links.get(route.via)!.send({ t: "req", id, to, from: this.o.selfId, method, params, ttl: MAX_HOPS });
		});
	}

	private sendTowards(machine: string, f: Frame) {
		const route = this.table.get(machine);
		const link = route ? this.links.get(route.via) : undefined;
		if (link) link.send(f);
		else this.o.log(`drop ${f.t} for unreachable ${machine}`);
	}

	private async routeRequest(f: Extract<Frame, { t: "req" }>, fromLink: string) {
		if (f.to !== this.o.selfId) {
			if (f.ttl <= 0) return;
			const route = this.table.get(f.to);
			if (!route) {
				const back = this.links.get(fromLink);
				back?.send({ t: "res", id: f.id, to: f.from, ok: false, error: `machine ${f.to} is not reachable from ${this.o.selfId}`, ttl: MAX_HOPS });
				return;
			}
			return this.sendTowards(f.to, { ...f, ttl: f.ttl - 1 });
		}
		let res: Frame;
		try {
			res = { t: "res", id: f.id, to: f.from, ok: true, result: await this.o.onRequest(f.method, f.params, f.from), ttl: MAX_HOPS };
		} catch (e) {
			res = { t: "res", id: f.id, to: f.from, ok: false, error: (e as Error).message, ttl: MAX_HOPS };
		}
		// Reply along the routing table; fall back to the link it arrived on.
		if (this.table.has(f.from)) this.sendTowards(f.from, res);
		else this.links.get(fromLink)?.send(res);
	}

	private routeResponse(f: Extract<Frame, { t: "res" }>) {
		if (f.to !== this.o.selfId) {
			if (f.ttl > 0) this.sendTowards(f.to, { ...f, ttl: f.ttl - 1 });
			return;
		}
		const p = this.pending.get(f.id);
		if (!p) return;
		this.pending.delete(f.id);
		clearTimeout(p.timer);
		if (f.ok) p.resolve(f.result);
		else p.reject(new Error(f.error ?? "remote error"));
	}
}

// ---------------------------------------------------------------- outbound dialer

class Dialer {
	private abort?: AbortController;
	private stopped = false;
	private ssh?: ChildProcess;
	private sshPort?: number;
	private state = "idle";
	private lastError?: string;
	private peerId?: string;
	private since?: number;
	private mesh: Mesh;
	private peer: PeerConfig;
	private secret: string;
	private selfId: string;
	private log: (m: string) => void;

	constructor(mesh: Mesh, peer: PeerConfig, secret: string, selfId: string, log: (m: string) => void) {
		this.mesh = mesh;
		this.peer = peer;
		this.secret = secret;
		this.selfId = selfId;
		this.log = log;
	}

	get label() {
		return this.peer.url ?? `ssh:${this.peer.ssh}`;
	}

	status() {
		return { label: this.label, state: this.state, peer: this.peerId, since: this.since, error: this.lastError, localPort: this.sshPort };
	}

	start() {
		void this.loop();
	}

	stop() {
		this.stopped = true;
		this.abort?.abort();
		this.ssh?.kill();
	}

	private async baseUrl(): Promise<string> {
		if (this.peer.url) return this.peer.url.replace(/\/+$/, "");
		if (!this.peer.ssh) throw new Error("peer needs url or ssh");
		if (this.ssh && this.ssh.exitCode === null && this.sshPort) return `http://127.0.0.1:${this.sshPort}`;
		// Best effort: make sure the remote hub is running (needs `quick` on the remote PATH).
		this.state = "starting remote hub";
		await runSsh(this.peer, ["bash", "-lc", "'command -v quick >/dev/null && quick hub start >/dev/null 2>&1; true'"], 20_000).catch(() => {});
		this.sshPort = await freePort();
		const args = [
			"-N",
			"-o", "ExitOnForwardFailure=yes",
			"-o", "ServerAliveInterval=15",
			"-o", "ServerAliveCountMax=3",
			"-o", "BatchMode=yes",
			"-o", "StrictHostKeyChecking=accept-new",
			"-L", `127.0.0.1:${this.sshPort}:127.0.0.1:${this.peer.port ?? 7788}`,
			...(this.peer.sshArgs ?? []),
			this.peer.ssh,
		];
		this.state = "opening ssh tunnel";
		const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-500)));
		child.on("exit", (code) => {
			if (this.ssh === child) {
				this.ssh = undefined;
				this.lastError = `ssh exited (${code}) ${stderr.trim()}`;
				this.abort?.abort();
			}
		});
		this.ssh = child;
		// Wait for the forward to accept connections.
		for (let i = 0; i < 50; i++) {
			await sleep(200);
			if (child.exitCode !== null) throw new Error(`ssh failed: ${stderr.trim() || `exit ${child.exitCode}`}`);
			try {
				const r = await fetch(`http://127.0.0.1:${this.sshPort}/health`, { signal: AbortSignal.timeout(1500) });
				if (r.ok) return `http://127.0.0.1:${this.sshPort}`;
			} catch {}
		}
		throw new Error("ssh tunnel up but remote hub not answering");
	}

	private async loop() {
		let delay = 1000;
		while (!this.stopped) {
			let link: Link | undefined;
			try {
				const base = await this.baseUrl();
				this.state = "connecting";
				this.abort = new AbortController();
				const res = await fetch(`${base}/mesh/link`, {
					headers: { authorization: `Mesh ${this.secret}`, "x-qa-machine": this.selfId, accept: "text/event-stream" },
					signal: this.abort.signal,
				});
				if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
				// Outgoing frames are POSTed in order, batched while a POST is in flight.
				let queue: Frame[] = [];
				let flushing = false;
				const flush = async () => {
					if (flushing) return;
					flushing = true;
					while (queue.length) {
						const frames = queue;
						queue = [];
						try {
							const r = await fetch(`${base}/mesh/send`, {
								method: "POST",
								headers: { authorization: `Mesh ${this.secret}`, "x-qa-machine": this.selfId, "content-type": "application/json" },
								body: JSON.stringify({ frames }),
							});
							if (!r.ok) throw new Error(`send ${r.status}`);
						} catch (e) {
							this.log(`send to ${this.label} failed: ${(e as Error).message}`);
							this.abort?.abort();
							break;
						}
					}
					flushing = false;
				};
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const raw = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
						if (!data) continue;
						const f = JSON.parse(data) as Frame;
						if (!link) {
							if (f.t !== "hello") continue;
							this.peerId = f.machine;
							link = {
								peer: f.machine,
								dir: "out",
								label: this.label,
								send: (fr) => {
									queue.push(fr);
									void flush();
								},
								close: () => this.abort?.abort(),
								routes: new Map(),
								connectedAt: Date.now(),
							};
							if (!this.mesh.linkUp(link)) throw new Error(`already linked with ${f.machine}`);
							this.state = "connected";
							this.since = Date.now();
							this.lastError = undefined;
							delay = 1000;
						}
						this.mesh.onFrame(link, f);
					}
				}
				throw new Error("stream closed");
			} catch (e) {
				if (!this.stopped) {
					this.lastError = (e as Error).message;
					this.state = "retrying";
				}
			} finally {
				if (link) this.mesh.linkDown(link);
			}
			if (this.stopped) break;
			await sleep(delay);
			delay = Math.min(delay * 2, 30_000);
		}
	}
}

export function runSsh(peer: PeerConfig, remoteCmd: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", ...(peer.sshArgs ?? []), peer.ssh!, ...remoteCmd], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout!.on("data", (d) => (out += d));
		child.stderr!.on("data", (d) => (err += d));
		const t = setTimeout(() => child.kill(), timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(t);
			code === 0 ? resolve(out) : reject(new Error(err.trim() || `ssh exit ${code}`));
		});
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
		s.on("error", reject);
	});
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
