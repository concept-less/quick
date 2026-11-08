export interface PRState { number: number; url: string; head: string; sha: string }
export interface EnsurePR { repo: string; head: string; base: string; sha: string; taskId: string }
export interface PRRef { repo: string; number: number; sha: string; base?: string; head?: string }
export interface PRInspection {
	state: "waiting" | "failed" | "ready" | "merged" | "closed";
	summary: string;
	mergeSha?: string;
}
export interface PRMerge { state: "waiting" | "merged"; summary: string; mergeSha?: string }

// REST payloads are checked before they can authorize a write or report a merge.
type Json = Record<string, any>;
interface Reply { data: any; more: boolean }
const fullSha = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const waiting = (summary: string): PRInspection => ({ state: "waiting", summary });
class APIError extends Error {
	status: number;
	constructor(status: number) { super(`GitHub API HTTP ${status}`); this.status = status; }
}
function repoPath(repo: string): string {
	if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || [".", ".."].includes(repo.split("/")[1])) throw new Error("repo must be owner/name");
	return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
}
function validateRef(ref: PRRef): string {
	const path = repoPath(ref.repo);
	if (!Number.isSafeInteger(ref.number) || ref.number <= 0 || !fullSha(ref.sha)) throw new Error("Require a positive PR number and full head SHA");
	return path;
}
function branch(value: string): boolean {
	return typeof value === "string" && !!value && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) &&
		!value.startsWith("-") && !value.startsWith("refs/") && !value.includes("..") && !value.includes("@{") &&
		value !== "@" && !value.endsWith(".") && value.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".lock"));
}
function headParts(options: EnsurePR): { owner: string; ref: string } {
	const parts = options.head.split(":");
	const owner = parts.length === 1 ? options.repo.split("/")[0] : parts[0];
	const ref = parts.at(-1)!;
	if (parts.length > 2 || !/^[A-Za-z0-9_-]+$/.test(owner) || !branch(ref) || !branch(options.base)) throw new Error("Invalid PR head/base branch");
	return { owner, ref };
}
function complete(reply: Reply, field: string): boolean {
	const data = reply.data;
	return data && Array.isArray(data[field]) && Number.isSafeInteger(data.total_count) && data.total_count >= 0 &&
		data.total_count <= 100 && data[field].length === data.total_count && !reply.more;
}

/** GitHub facts only: the owner must fetch the target and verify ancestry before cleanup/done.
 * ensure throws on identity/transport ambiguity; inspect/merge wait on unavailable evidence.
 * GitHub's clean mergeability enforces required reviews/status rules; CI needs a real success.
 */
export class GitHubLifecycle {
	#api: string;
	#token?: string;
	#locks = new Map<string, Promise<void>>();
	#uncertainCreates = new Set<string>();

	constructor({ api = "https://api.github.com", token = process.env.GH_TOKEN }: { api?: string; token?: string } = {}) {
		const url = new URL(api);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid GitHub API URL");
		this.#api = url.href.replace(/\/+$/, "");
		this.#token = token;
	}

	private async request(path: string, method = "GET", body?: unknown): Promise<Reply> {
		// Never follow redirects or server-supplied URLs (including pagination Links).
		const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
		if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		let response: Response;
		try {
			response = await fetch(`${this.#api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15_000) });
		} catch { throw new Error("GitHub API transport unavailable; outcome may be unknown"); }
		if (!response.ok) {
			await response.body?.cancel();
			throw new APIError(response.status); // Do not persist echoed credentials/response bodies.
		}
		try { return { data: await response.json(), more: /\brel\s*=\s*"?next\b/i.test(response.headers.get("link") ?? "") }; }
		catch { throw new Error("Invalid GitHub API JSON; outcome may be unknown"); }
	}

	private prState(pr: Json, options: EnsurePR): PRState {
		const { owner, ref } = headParts(options);
		if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.state !== "open" || pr.merged === true ||
			pr.head?.ref !== ref || pr.base?.ref !== options.base ||
			pr.head?.label?.toLowerCase() !== `${owner}:${ref}`.toLowerCase() ||
			pr.base?.repo?.full_name?.toLowerCase() !== options.repo.toLowerCase() ||
			(!options.head.includes(":") && pr.head?.repo?.full_name?.toLowerCase() !== options.repo.toLowerCase())) {
			throw new Error("GitHub PR identity/head/base does not match requested PR");
		}
		if (pr.head.sha !== options.sha) throw new Error(`PR head SHA changed: expected ${options.sha}, found ${pr.head.sha}`);
		let url: URL;
		try { url = new URL(pr.html_url); } catch { throw new Error("Invalid GitHub PR URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid GitHub PR URL");
		return { number: pr.number, url: url.href, head: options.head, sha: options.sha };
	}

	private async findOpen(options: EnsurePR): Promise<PRState | undefined> {
		const { owner, ref } = headParts(options);
		const query = new URLSearchParams({ state: "open", head: `${owner}:${ref}`, base: options.base, per_page: "100" });
		const reply = await this.request(`${repoPath(options.repo)}/pulls?${query}`);
		if (!Array.isArray(reply.data) || reply.more || reply.data.length >= 100) throw new Error("Incomplete GitHub PR lookup; refusing creation");
		if (reply.data.length > 1) throw new Error("Ambiguous existing GitHub PRs; refusing creation");
		if (!reply.data.length) return;
		const found = this.prState(reply.data[0], options);
		const { data } = await this.request(`${repoPath(options.repo)}/pulls/${found.number}`);
		const current = this.prState(data, options);
		if (current.number !== found.number) throw new Error("GitHub PR number changed");
		return current;
	}

	/** Idempotent by repo/head/base, including lost POST replies. Returns an open PR, never completion. */
	async ensure(options: EnsurePR): Promise<PRState> {
		const path = repoPath(options.repo);
		const { owner, ref } = headParts(options);
		if (!fullSha(options.sha) || typeof options.taskId !== "string" || !options.taskId.trim() || /[\r\n\x00]/.test(options.taskId)) throw new Error("Require a full head SHA and single-line taskId");
		const key = JSON.stringify([options.repo.toLowerCase(), owner.toLowerCase(), ref, options.base]);
		// Instance-local serialization; GitHub's unique open head/base pair arbitrates other writers.
		const previous = this.#locks.get(key);
		let release!: () => void;
		const lock = new Promise<void>(resolve => { release = resolve; });
		this.#locks.set(key, lock);
		await previous;
		try {
			const existing = await this.findOpen(options);
			if (existing) { this.#uncertainCreates.delete(key); return existing; }
			if (this.#uncertainCreates.has(key)) throw new Error("PR creation outcome unknown; refusing another POST until the PR is visible");
			this.#uncertainCreates.add(key);
			let postResponded = false;
			try {
				const { data } = await this.request(`${path}/pulls`, "POST", {
					head: options.head, base: options.base, title: `Task ${options.taskId}`,
					body: `Task: ${options.taskId}\n\nApproved head SHA: ${options.sha}`, draft: false,
				});
				postResponded = true;
				const created = this.prState(data, options);
				const confirmed = this.prState((await this.request(`${path}/pulls/${created.number}`)).data, options);
				if (confirmed.number !== created.number) throw new Error("GitHub PR number changed");
				this.#uncertainCreates.delete(key);
				return confirmed;
			} catch (error) {
				// Only the POST's 4xx is definitive; a later GET failure cannot undo its success.
				if (!postResponded && error instanceof APIError && error.status >= 400 && error.status < 500 && error.status !== 408) this.#uncertainCreates.delete(key);
				const recovered = await this.findOpen(options);
				if (recovered) { this.#uncertainCreates.delete(key); return recovered; }
				throw error;
			}
		} finally {
			release();
			if (this.#locks.get(key) === lock) this.#locks.delete(key);
		}
	}

	private terminal(pr: Json, ref: PRRef): PRInspection | undefined {
		if (!pr || pr.number !== ref.number) return waiting("GitHub PR identity is unavailable");
		if (ref.base && (pr.base?.ref !== ref.base || pr.base?.repo?.full_name?.toLowerCase() !== ref.repo.toLowerCase())) return {state:"failed",summary:"PR target/base repository changed; refusing to merge"};
		if (ref.head && (pr.head?.ref !== ref.head || pr.head?.repo?.full_name?.toLowerCase() !== ref.repo.toLowerCase())) return {state:"failed",summary:"PR head repository/branch changed; refusing to merge"};
		if (pr.head?.sha !== ref.sha) return { state: "failed", summary: `PR head SHA changed: expected ${ref.sha}, found ${pr.head?.sha ?? "missing"}` };
		if (pr.merged === true) {
			if (pr.state !== "closed") return waiting("GitHub merged/closed state is inconsistent; merge is unverified");
			if (!fullSha(pr.merge_commit_sha)) return { state: "failed", summary: "Merged PR has no valid merge_commit_sha; merge is unverified" };
			return { state: "merged", summary: "GitHub confirms the PR merged; target ancestry still requires owner verification", mergeSha: pr.merge_commit_sha };
		}
		if (pr.merged !== false) return waiting("GitHub merged state is unavailable");
		if (pr.state === "closed") return { state: "closed", summary: "PR was closed without merging" };
		if (pr.state !== "open") return waiting("GitHub PR state is unavailable");
	}

	private ci(status: Reply, checks: Reply, sha: string): PRInspection | undefined {
		if (!complete(status, "statuses") || !complete(checks, "check_runs")) return waiting("Incomplete CI evidence (pagination or more than 100 records); refusing to merge");
		if (status.data.sha !== sha || checks.data.check_runs.some((run: Json) => !run || run.head_sha !== sha)) return { state: "failed", summary: "CI evidence does not match the exact PR head SHA" };
		const states = status.data.statuses;
		const runs = checks.data.check_runs;
		if (["failure", "error"].includes(status.data.state) || states.some((s: Json) => s && ["failure", "error"].includes(s.state)) ||
			runs.some((r: Json) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(r.conclusion))) {
			return { state: "failed", summary: "GitHub CI reported a failed status or check run" };
		}
		if (!["success", "pending"].includes(status.data.state) || (states.length && status.data.state !== "success") ||
			states.some((s: Json) => !s || s.state !== "success") || runs.some((r: Json) => r.status !== "completed" || r.conclusion !== "success")) {
			return waiting("CI statuses/check runs are pending or lack an explicit successful conclusion");
		}
		if (!states.length && !runs.length) return waiting("No successful CI signal exists for this head SHA");
	}

	/** Fail closed on missing/truncated CI, draft, and every mergeable_state except clean. */
	async inspect(ref: PRRef): Promise<PRInspection> {
		const path = validateRef(ref);
		try {
			const first = (await this.request(`${path}/pulls/${ref.number}`)).data;
			const terminal = this.terminal(first, ref);
			if (terminal) return terminal;
			const [status, checks] = await Promise.all([
				this.request(`${path}/commits/${ref.sha}/status?per_page=100`),
				this.request(`${path}/commits/${ref.sha}/check-runs?per_page=100&filter=latest`),
			]);
			// Re-read after CI to catch head/review/mergeability changes during the inspection.
			const pr = (await this.request(`${path}/pulls/${ref.number}`)).data;
			const final = this.terminal(pr, ref);
			if (final) return final;
			const ci = this.ci(status, checks, ref.sha);
			if (ci) return ci;
			if (pr.draft !== false) return waiting("PR is draft or draft state is unknown");
			if (pr.mergeable !== true || pr.mergeable_state !== "clean") return waiting(`GitHub mergeability is ${pr.mergeable_state ?? "unknown"}; required approvals/statuses or base update may be outstanding`);
			return { state: "ready", summary: "Exact head SHA passed CI and GitHub required review/status gates" };
		} catch (error) { return waiting(error instanceof APIError ? error.message : "GitHub inspection unavailable; no merge authorized"); }
	}

	/** Re-inspects on every call. A merge receipt is accepted only after GET confirms merge_commit_sha. */
	async merge(ref: PRRef): Promise<PRMerge> {
		const path = validateRef(ref);
		const inspected = await this.inspect(ref);
		if (inspected.state === "merged") return { ...inspected, state: "merged" };
		if (inspected.state !== "ready") return { state: "waiting", summary: inspected.summary };
		let receipt: Json | undefined;
		let problem = "Merge is not yet confirmed by GitHub";
		try {
			receipt = (await this.request(`${path}/pulls/${ref.number}/merge`, "PUT", { sha: ref.sha, merge_method: "merge" })).data;
		} catch (error) {
			problem = error instanceof APIError && [405, 409].includes(error.status) ? `Merge race (${error.status}); waiting for GitHub gates/head to settle` : "Merge response unavailable; awaiting GitHub confirmation";
		}
		// Never retry a mutation here, including when its response was lost.
		try {
			const confirmed = this.terminal((await this.request(`${path}/pulls/${ref.number}`)).data, ref);
			if (confirmed?.state === "merged") {
				if (receipt?.merged === true && receipt.sha !== confirmed.mergeSha) return { state: "waiting", summary: "Merge receipt SHA differs from GitHub merge_commit_sha; merge is unverified" };
				return { ...confirmed, state: "merged" };
			}
			if (confirmed) problem = confirmed.summary;
		} catch { /* A later call re-queries GitHub before considering another merge. */ }
		return { state: "waiting", summary: problem };
	}
}
