import { after, before, mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { GitHubLifecycle } from "../hub/github-lifecycle.ts";

const SHA = "a".repeat(40), OTHER = "b".repeat(40), MERGE = "c".repeat(40);
const ensure = { repo: "acme/project", head: "task/tb711", base: "main", sha: SHA, taskId: "tb711" };
const ref = { repo: ensure.repo, number: 7, sha: SHA };
const realFetch = globalThis.fetch;
before(() => {
	// This suite cannot contact GitHub or any other non-loopback service, even on a regression.
	mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		assert.equal(url.hostname, "127.0.0.1", "Tests must never access non-localhost services");
		return realFetch(input, init);
	});
});
after(() => mock.restoreAll());

function pull() {
	return { number: 7, html_url: "https://github.com/acme/project/pull/7", state: "open", merged: false,
		head: { sha: SHA, ref: ensure.head, label: `acme:${ensure.head}`, repo: { full_name: ensure.repo } },
		base: { ref: "main", repo: { full_name: ensure.repo } }, draft: false, mergeable: true,
		mergeable_state: "clean", merge_commit_sha: null as string | null };
}
function run(overrides = {}) { return { id: 1, name: "test", head_sha: SHA, status: "completed", conclusion: "success", ...overrides }; }
function json(res: ServerResponse, data: unknown, status = 200, headers = {}) {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(data));
}
interface RequestLog { method: string; url: URL; body: any; authorization?: string }
async function fixture(t: TestContext, exists = true) {
	const errors: unknown[] = [];
	const f = {
		pr: pull(), exists, visible: true, requests: [] as RequestLog[],
		status: { sha: SHA, state: "success", total_count: 1, statuses: [{ context: "ci/status", state: "success" }] },
		checks: { total_count: 1, check_runs: [run()] },
		statusLink: "", checkLink: "", lostCreate: false, lostMerge: false,
		handle: undefined as undefined | ((r: RequestLog, res: ServerResponse) => boolean | Promise<boolean>),
	};
	const server = createServer(async (req, res) => {
		try {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const r: RequestLog = { method: req.method!, url: new URL(req.url!, "http://127.0.0.1"), body: raw ? JSON.parse(raw) : undefined, authorization: req.headers.authorization };
			f.requests.push(r);
			if (await f.handle?.(r, res)) return;
			const path = r.url.pathname;
			assert.ok(path.startsWith("/api/v3/repos/acme/project/"), `Unexpected API path: ${path}`);
			if (path.endsWith("/pulls") && r.method === "GET") {
				assert.equal(r.url.searchParams.get("state"), "open");
				assert.equal(r.url.searchParams.get("head"), `acme:${ensure.head}`);
				assert.equal(r.url.searchParams.get("base"), "main");
				assert.equal(r.url.searchParams.get("per_page"), "100");
				return json(res, f.exists && f.visible && f.pr.state === "open" ? [f.pr] : []);
			}
			if (path.endsWith("/pulls") && r.method === "POST") {
				if (f.exists) return json(res, { message: "PR already exists" }, 422);
				f.exists = true;
				if (f.lostCreate) return res.destroy();
				return json(res, f.pr, 201);
			}
			if (path.endsWith("/pulls/7") && r.method === "GET") return json(res, f.exists ? f.pr : {}, f.exists ? 200 : 404);
			if (path.endsWith(`/commits/${SHA}/status`) && r.method === "GET") {
				assert.equal(r.url.searchParams.get("per_page"), "100");
				return json(res, f.status, 200, { Link: f.statusLink });
			}
			if (path.endsWith(`/commits/${SHA}/check-runs`) && r.method === "GET") {
				assert.equal(r.url.searchParams.get("per_page"), "100");
				assert.equal(r.url.searchParams.get("filter"), "latest");
				return json(res, f.checks, 200, { Link: f.checkLink });
			}
			if (path.endsWith("/pulls/7/merge") && r.method === "PUT") {
				assert.deepEqual(r.body, { sha: SHA, merge_method: "merge" });
				f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = MERGE;
				if (f.lostMerge) return res.destroy();
				return json(res, { merged: true, sha: MERGE });
			}
			throw new Error(`Unexpected request: ${r.method} ${r.url.pathname}`);
		} catch (error) { errors.push(error); if (!res.destroyed) json(res, {}, 500); }
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
		assert.deepEqual(errors, [], "Mock server assertions");
	});
	const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3`;
	const adapter = new GitHubLifecycle({ api, token: "test-secret" });
	const count = (method: string, suffix: string) => f.requests.filter(r => r.method === method && r.url.pathname.endsWith(suffix)).length;
	return Object.assign(f, { api, adapter, count });
}

test("ensure looks up head/base, creates a task-labelled PR, and reuses it after restart", async t => {
	const f = await fixture(t, false);
	const created = await f.adapter.ensure(ensure);
	assert.deepEqual(created, { number: 7, url: f.pr.html_url, head: ensure.head, sha: SHA });
	assert.equal(f.requests[0].method, "GET");
	const post = f.requests.find(r => r.method === "POST")!;
	assert.equal(post.body.head, ensure.head);
	assert.equal(post.body.base, ensure.base);
	assert.ok(post.body.title.includes(ensure.taskId));
	assert.ok(post.body.body.includes(ensure.taskId));
	assert.ok(post.body.body.includes(SHA));
	assert.equal(post.body.draft, false);
	assert.deepEqual(await new GitHubLifecycle({ api: f.api, token: "test-secret" }).ensure(ensure), created);
	assert.equal(f.count("POST", "/pulls"), 1);
	assert.ok(f.requests.every(r => r.authorization === "Bearer test-secret"));
	assert.equal(JSON.stringify(created).includes("test-secret"), false);
	assert.equal(JSON.stringify(f.adapter).includes("test-secret"), false);
});

test("ensure serializes concurrent calls and creates once", async t => {
	const f = await fixture(t, false);
	const results = await Promise.all(Array.from({ length: 8 }, () => f.adapter.ensure(ensure)));
	assert.ok(results.every(p => p.number === 7 && p.sha === SHA));
	assert.equal(f.count("POST", "/pulls"), 1);
});

test("ensure reports existing head SHA mismatch and never creates a replacement", async t => {
	const f = await fixture(t);
	f.pr.head.sha = OTHER;
	await assert.rejects(f.adapter.ensure(ensure), /head SHA changed/);
	assert.equal(f.count("POST", "/pulls"), 0);
});

test("concurrent ensure with a different approved SHA cannot reuse an in-flight result", async t => {
	const f = await fixture(t, false);
	const results = await Promise.allSettled([f.adapter.ensure(ensure), f.adapter.ensure({ ...ensure, sha: OTHER })]);
	assert.equal(results[0].status, "fulfilled");
	assert.equal(results[1].status, "rejected");
	assert.match((results[1] as PromiseRejectedResult).reason.message, /head SHA changed/);
	assert.equal(f.count("POST", "/pulls"), 1);
});

test("lost successful create response is recovered by lookup, never a second POST", async t => {
	const f = await fixture(t, false);
	f.lostCreate = true;
	assert.equal((await f.adapter.ensure(ensure)).number, 7);
	assert.equal((await f.adapter.ensure(ensure)).number, 7);
	assert.equal(f.count("POST", "/pulls"), 1);
	assert.ok(f.count("GET", "/pulls") >= 3);
});

test("ambiguous creation with delayed visibility refuses further POSTs until found", async t => {
	const f = await fixture(t, false);
	f.lostCreate = true; f.visible = false;
	await assert.rejects(f.adapter.ensure(ensure), /outcome may be unknown/);
	await assert.rejects(f.adapter.ensure(ensure), /refusing another POST/);
	assert.equal(f.count("POST", "/pulls"), 1);
	f.visible = true;
	assert.equal((await f.adapter.ensure(ensure)).number, 7);
});

test("another creator wins the POST race; 422 is reconciled by lookup", async t => {
	const f = await fixture(t, false);
	f.handle = (r, res) => {
		if (r.method !== "POST") return false;
		f.exists = true; json(res, {}, 422); return true;
	};
	assert.equal((await f.adapter.ensure(ensure)).number, 7);
	assert.equal(f.count("POST", "/pulls"), 1);
});

test("successful POST followed by a 404 cannot authorize duplicate creation", async t => {
	const f = await fixture(t, false);
	f.visible = false;
	f.handle = (r, res) => {
		if (!r.url.pathname.endsWith("/pulls/7")) return false;
		json(res, {}, 404); return true;
	};
	await assert.rejects(f.adapter.ensure(ensure), /HTTP 404/);
	await assert.rejects(f.adapter.ensure(ensure), /refusing another POST/);
	assert.equal(f.count("POST", "/pulls"), 1);
	f.handle = undefined; f.visible = true;
	assert.equal((await f.adapter.ensure(ensure)).number, 7);
});

test("a definitive create rejection allows a later attempt after another lookup", async t => {
	const f = await fixture(t, false);
	f.handle = (r, res) => { if (r.method !== "POST") return false; json(res, {}, 422); return true; };
	await assert.rejects(f.adapter.ensure(ensure), /HTTP 422/);
	f.handle = undefined;
	assert.equal((await f.adapter.ensure(ensure)).number, 7);
	assert.equal(f.count("POST", "/pulls"), 2);
});

test("create recovery cannot silently accept a changed head", async t => {
	const f = await fixture(t, false);
	f.handle = (r, res) => {
		if (r.method !== "POST") return false;
		f.exists = true; f.pr.head.sha = OTHER; res.destroy(); return true;
	};
	await assert.rejects(f.adapter.ensure(ensure), /head SHA changed/);
	assert.equal(f.count("POST", "/pulls"), 1);
});

for (const kind of ["duplicate", "pagination", "wrong base", "wrong repository"] as const) {
	test(`ensure fails closed on ${kind} lookup`, async t => {
		const f = await fixture(t);
		if (kind === "wrong base") f.pr.base.ref = "develop";
		if (kind === "wrong repository") f.pr.head.repo.full_name = "other/project";
		f.handle = (r, res) => {
			if (!r.url.pathname.endsWith("/pulls") || r.method !== "GET") return false;
			json(res, kind === "duplicate" ? [f.pr, { ...f.pr, number: 8 }] : [f.pr], 200,
				kind === "pagination" ? { Link: '<http://127.0.0.1/next>; rel="next"' } : {});
			return true;
		};
		await assert.rejects(f.adapter.ensure(ensure), /Ambiguous|Incomplete|identity/);
		assert.equal(f.count("POST", "/pulls"), 0);
	});
}

test("inspect is ready only after successful combined statuses and check runs", async t => {
	const f = await fixture(t);
	assert.equal((await f.adapter.inspect(ref)).state, "ready");
	assert.equal(f.count("PUT", "/merge"), 0);
});

for (const kind of ["status pending", "check queued", "check in progress", "neutral", "skipped", "missing conclusion"] as const) {
	test(`CI waits for ${kind}`, async t => {
		const f = await fixture(t);
		if (kind === "status pending") { f.status.state = "pending"; f.status.statuses[0].state = "pending"; }
		else if (kind === "check queued") f.checks.check_runs = [run({ status: "queued", conclusion: null })];
		else if (kind === "check in progress") f.checks.check_runs = [run({ status: "in_progress", conclusion: null })];
		else f.checks.check_runs = [run({ conclusion: kind === "missing conclusion" ? null : kind })];
		assert.equal((await f.adapter.inspect(ref)).state, "waiting");
		assert.equal((await f.adapter.merge(ref)).state, "waiting");
		assert.equal(f.count("PUT", "/merge"), 0);
	});
}

for (const kind of ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale", "status error"] as const) {
	test(`CI reports failure for ${kind}, even with another pending signal`, async t => {
		const f = await fixture(t);
		if (kind === "status error") { f.status.state = "error"; f.status.statuses[0].state = "error"; f.checks.check_runs = [run({ status: "queued", conclusion: null })]; }
		else { f.checks.check_runs = [run({ conclusion: kind })]; f.status.state = "pending"; f.status.statuses[0].state = "pending"; }
		assert.equal((await f.adapter.inspect(ref)).state, "failed");
		assert.equal((await f.adapter.merge(ref)).state, "waiting");
		assert.equal(f.count("PUT", "/merge"), 0);
	});
}

test("no CI is waiting even when GitHub says clean; statuses-only/checks-only success is sufficient", async t => {
	const f = await fixture(t);
	f.status = { sha: SHA, state: "pending", total_count: 0, statuses: [] };
	f.checks = { total_count: 0, check_runs: [] };
	assert.match((await f.adapter.inspect(ref)).summary, /No successful CI/);
	f.checks = { total_count: 1, check_runs: [run()] };
	assert.equal((await f.adapter.inspect(ref)).state, "ready");
	f.checks = { total_count: 0, check_runs: [] };
	f.status = { sha: SHA, state: "success", total_count: 1, statuses: [{ context: "ci", state: "success" }] };
	assert.equal((await f.adapter.inspect(ref)).state, "ready");
});

for (const state of ["blocked", "behind", "unknown", "dirty", "unstable", "has_hooks", undefined]) {
	test(`GitHub approval/required-status gate ${state} waits despite successful CI`, async t => {
		const f = await fixture(t);
		(f.pr as any).mergeable_state = state;
		assert.equal((await f.adapter.inspect(ref)).state, "waiting");
		assert.equal((await f.adapter.merge(ref)).state, "waiting");
		assert.equal(f.count("PUT", "/merge"), 0);
	});
}

test("draft and unknown mergeability fail closed", async t => {
	const f = await fixture(t);
	f.pr.draft = true;
	assert.match((await f.adapter.inspect(ref)).summary, /draft/);
	f.pr.draft = false; (f.pr as any).mergeable = null;
	assert.equal((await f.adapter.inspect(ref)).state, "waiting");
	delete (f.pr as any).draft; f.pr.mergeable = true;
	assert.equal((await f.adapter.inspect(ref)).state, "waiting");
});

test("head changes fail before CI or merge; a second PR read catches a change during CI", async t => {
	const f = await fixture(t);
	f.pr.head.sha = OTHER;
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
	assert.equal(f.count("GET", "/status"), 0);
	assert.equal((await f.adapter.merge(ref)).state, "waiting");
	f.pr.head.sha = SHA;
	f.handle = r => { if (r.url.pathname.endsWith("/check-runs")) f.pr.head.sha = OTHER; return false; };
	assert.match((await f.adapter.inspect(ref)).summary, /head SHA changed/);
	assert.equal(f.count("PUT", "/merge"), 0);
});

test("merge re-inspects approvals even if an earlier inspect was ready", async t => {
	const f = await fixture(t);
	assert.equal((await f.adapter.inspect(ref)).state, "ready");
	f.pr.mergeable_state = "blocked";
	assert.equal((await f.adapter.merge(ref)).state, "waiting");
	assert.equal(f.count("PUT", "/merge"), 0);
});

test("CI evidence for a different SHA cannot authorize a merge", async t => {
	const f = await fixture(t);
	f.status.sha = OTHER;
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
	f.status.sha = SHA; f.checks.check_runs[0].head_sha = OTHER;
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
});

for (const kind of ["statuses count", "checks count", "statuses link", "checks link", "truncated statuses", "truncated checks"] as const) {
	test(`CI fails closed on ${kind}, without following server pagination URLs`, async t => {
		const f = await fixture(t);
		if (kind === "statuses count") f.status.total_count = 101;
		if (kind === "checks count") f.checks.total_count = 101;
		if (kind === "statuses link") f.statusLink = '<https://untrusted.invalid/status?page=2>; rel="next"';
		if (kind === "checks link") f.checkLink = '<https://untrusted.invalid/checks?page=2>; rel="next"';
		if (kind === "truncated statuses") f.status.total_count = 2;
		if (kind === "truncated checks") f.checks.total_count = 2;
		const result = await f.adapter.inspect(ref);
		assert.equal(result.state, "waiting");
		assert.match(result.summary, /Incomplete CI/);
		assert.equal((await f.adapter.merge(ref)).state, "waiting");
		assert.equal(f.count("PUT", "/merge"), 0);
	});
}

test("exactly 100 complete signals are supported and the last failing check is examined", async t => {
	const f = await fixture(t);
	f.status = { sha: SHA, state: "success", total_count: 100, statuses: Array.from({ length: 100 }, (_, i) => ({ context: `ci/${i}`, state: "success" })) };
	f.checks = { total_count: 100, check_runs: Array.from({ length: 100 }, (_, i) => run({ id: i })) };
	assert.equal((await f.adapter.inspect(ref)).state, "ready");
	f.checks.check_runs[99].conclusion = "failure";
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
});

test("closed unmerged PR is terminal and cannot be merged", async t => {
	const f = await fixture(t);
	f.pr.state = "closed";
	assert.equal((await f.adapter.inspect(ref)).state, "closed");
	assert.equal((await f.adapter.merge(ref)).state, "waiting");
	assert.equal(f.count("GET", "/status"), 0);
	assert.equal(f.count("PUT", "/merge"), 0);
});

test("already merged requires the approved head and a valid merge_commit_sha, without new writes", async t => {
	const f = await fixture(t);
	f.pr.state = "closed"; f.pr.merged = true; f.pr.merge_commit_sha = MERGE;
	const result = await f.adapter.inspect(ref);
	assert.equal(result.state, "merged"); assert.equal(result.mergeSha, MERGE);
	assert.equal((await f.adapter.merge(ref)).state, "merged");
	f.pr.merge_commit_sha = null;
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
	f.pr.merge_commit_sha = "not-a-sha";
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
	f.pr.merge_commit_sha = MERGE; f.pr.state = "open";
	assert.equal((await f.adapter.inspect(ref)).state, "waiting");
	f.pr.state = "closed";
	f.pr.merge_commit_sha = MERGE; f.pr.head.sha = OTHER;
	assert.equal((await f.adapter.inspect(ref)).state, "failed");
	assert.equal(f.count("PUT", "/merge"), 0);
});

for (const lost of [false, true]) {
	test(`merge uses SHA precondition and merge commits; ${lost ? "lost" : "successful"} response is confirmed by GET`, async t => {
		const f = await fixture(t);
		f.lostMerge = lost;
		const result = await f.adapter.merge(ref);
		assert.equal(result.state, "merged"); assert.equal(result.mergeSha, MERGE);
		assert.equal(f.requests.at(-1)!.url.pathname.endsWith("/pulls/7"), true);
		assert.equal((await new GitHubLifecycle({ api: f.api, token: "" }).merge(ref)).state, "merged");
		assert.equal(f.count("PUT", "/merge"), 1);
	});
}

for (const status of [405, 409]) {
	test(`merge race HTTP ${status} waits and does not retry a mutation`, async t => {
		const f = await fixture(t);
		f.handle = (r, res) => { if (r.method !== "PUT") return false; json(res, {}, status); return true; };
		const result = await f.adapter.merge(ref);
		assert.equal(result.state, "waiting"); assert.match(result.summary, new RegExp(String(status)));
		assert.equal(f.count("PUT", "/merge"), 1);
	});
}

test("a merge race already won elsewhere is recovered before reporting waiting", async t => {
	const f = await fixture(t);
	f.handle = (r, res) => {
		if (r.method !== "PUT") return false;
		f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = MERGE;
		json(res, {}, 405); return true;
	};
	assert.equal((await f.adapter.merge(ref)).state, "merged");
	assert.equal(f.count("PUT", "/merge"), 1);
});

test("lost merge response plus unavailable confirmation recovers on next call without another PUT", async t => {
	const f = await fixture(t);
	f.lostMerge = true;
	let unavailable = true;
	f.handle = (r, res) => {
		if (unavailable && f.pr.merged && r.url.pathname.endsWith("/pulls/7")) { unavailable = false; res.destroy(); return true; }
		return false;
	};
	assert.equal((await f.adapter.merge(ref)).state, "waiting");
	assert.equal((await f.adapter.merge(ref)).state, "merged");
	assert.equal(f.count("PUT", "/merge"), 1);
});

test("a successful merge receipt alone is not remote confirmation", async t => {
	const f = await fixture(t);
	f.handle = (r, res) => { if (r.method !== "PUT") return false; json(res, { merged: true, sha: MERGE }); return true; };
	const result = await f.adapter.merge(ref);
	assert.equal(result.state, "waiting"); assert.equal(result.mergeSha, undefined);
});

test("merge receipt and queried merge_commit_sha must agree", async t => {
	const f = await fixture(t);
	f.handle = (r, res) => {
		if (r.method !== "PUT") return false;
		f.pr.merged = true; f.pr.state = "closed"; f.pr.merge_commit_sha = MERGE;
		json(res, { merged: true, sha: OTHER }); return true;
	};
	const result = await f.adapter.merge(ref);
	assert.equal(result.state, "waiting"); assert.match(result.summary, /receipt SHA differs/);
});

test("unavailable or malformed CI remains waiting and does not leak server error text", async t => {
	const f = await fixture(t);
	for (const mode of ["forbidden", "malformed", "missing total"]) {
		f.handle = (r, res) => {
			if (!r.url.pathname.endsWith("/check-runs")) return false;
			if (mode === "forbidden") json(res, { message: "test-secret" }, 403);
			else if (mode === "malformed") res.end("invalid json test-secret");
			else json(res, { check_runs: [run()] });
			return true;
		};
		const result = await f.adapter.merge(ref);
		assert.equal(result.state, "waiting"); assert.equal(result.summary.includes("test-secret"), false);
	}
	assert.equal(f.count("PUT", "/merge"), 0);
});

test("auth is sent only to configured API; redirects are never followed", async t => {
	const target = await fixture(t);
	const f = await fixture(t);
	f.handle = (_r, res) => { res.writeHead(307, { Location: `${target.api}/repos/acme/project/pulls/7` }); res.end(); return true; };
	assert.equal((await f.adapter.inspect(ref)).state, "waiting");
	await assert.rejects(f.adapter.ensure(ensure), /HTTP 307/);
	assert.equal(target.requests.length, 0);
	assert.ok(f.requests.every(r => r.authorization === "Bearer test-secret"));
});

test("GH_TOKEN is optional, private, and an explicit empty token suppresses it", async t => {
	const f = await fixture(t);
	const previous = process.env.GH_TOKEN;
	t.after(() => { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; });
	process.env.GH_TOKEN = "mock-env-token";
	const adapter = new GitHubLifecycle({ api: f.api });
	assert.equal((await adapter.inspect(ref)).state, "ready");
	assert.ok(f.requests.every(r => r.authorization === "Bearer mock-env-token"));
	assert.equal(JSON.stringify(adapter).includes("mock-env-token"), false);
	f.requests.length = 0;
	assert.equal((await new GitHubLifecycle({ api: f.api, token: "" }).inspect(ref)).state, "ready");
	assert.ok(f.requests.every(r => r.authorization === undefined));
	delete process.env.GH_TOKEN; f.requests.length = 0;
	assert.equal((await new GitHubLifecycle({ api: f.api }).inspect(ref)).state, "ready");
	assert.ok(f.requests.every(r => r.authorization === undefined));
});

test("invalid identities are rejected before any HTTP call", async t => {
	const f = await fixture(t);
	await assert.rejects(f.adapter.ensure({ ...ensure, repo: "../elsewhere" }), /repo/);
	await assert.rejects(f.adapter.ensure({ ...ensure, head: "../../escape" }), /branch/);
	await assert.rejects(f.adapter.ensure({ ...ensure, taskId: "injected\ntitle" }), /taskId/);
	await assert.rejects(f.adapter.inspect({ ...ref, sha: "short" }), /SHA/);
	await assert.rejects(f.adapter.merge({ ...ref, number: -1 }), /number/);
	assert.throws(() => new GitHubLifecycle({ api: "http://user:password@127.0.0.1" }), /API URL/);
	assert.equal(f.requests.length, 0);
});
