// A PR provider's "clean" alone is insufficient: base can race the tested head.
// Require GitHub's server-enforced strict/up-to-date required-CI gate before automatic merge.
export async function requireStrictPRProtection(config: import("../shared/lifecycle.ts").LifecycleConfig): Promise<void> {
 const repo = config.githubRepo;
 if (!repo || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !config.baseBranch) throw new Error("PR 自动合并需要明确 githubRepo/baseBranch 和严格分支保护");
 const api = new URL(config.githubApi ?? "https://api.github.com");
 if (!["https:","http:"].includes(api.protocol) || api.username || api.password || api.search || api.hash) throw new Error("非法 GitHub API 地址");
 const response = await fetch(`${api.href.replace(/\/+$/,"")}/repos/${repo}/branches/${encodeURIComponent(config.baseBranch)}/protection/required_status_checks`,{headers:{accept:"application/vnd.github+json",...(process.env.GH_TOKEN ? {authorization:`Bearer ${process.env.GH_TOKEN}`} : {})},redirect:"manual",signal:AbortSignal.timeout(15000)});
 if (!response.ok) throw new Error("无法确认 GitHub 严格 required-CI 分支保护；禁止自动合并");
 const protection = await response.json() as any;
 if (protection.strict !== true || !((Array.isArray(protection.contexts) && protection.contexts.length) || (Array.isArray(protection.checks) && protection.checks.length))) throw new Error("GitHub 必须启用 strict/up-to-date required-CI 后才能自动合并 PR");
}
