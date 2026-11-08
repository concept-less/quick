// Workspace and review are orthogonal; missing lifecycle means legacy/non-managed.
export type WorkspaceMode = "none" | "direct" | "worktree";
export type ReviewMode = "none" | "agent" | "human";
export interface LifecyclePolicy {
 workspace: WorkspaceMode;
 review: ReviewMode;
 reason: string;
 template: "A" | "B" | "C" | "none";
}
export interface LifecycleInput {
 kind?: "code" | "read_only";
 risk?: "low" | "normal" | "critical";
 complexity?: "small_frontend" | "complex";
 reason?: string;
}
export interface LifecycleConfig {
 /** Trusted project configuration, never supplied by a worker. */
 cwd: string;
 baseBranch?: string;
 forceHuman?: boolean;
 defaultReview?: "agent" | "human";
 integration?: "direct" | "pr";
 /** GitHub owner/name for PR strategy (explicit, never inferred from arbitrary URLs). */
 githubRepo?: string;
 /** Optional GitHub Enterprise API. Credentials come from GH_TOKEN, not task data. */
 githubApi?: string;
 /** All machines sharing this repository must name the same reachable coordinator hub. */
 integrationCoordinator?: string;
 /** PR auto-merge is enabled only with an independently verified strict branch protection rule. */
 requireStrictCI?: boolean;
 test?: string[];
}
export interface TaskLifecycle {
 policy: LifecyclePolicy;
 input?: LifecycleInput;
 originalCwd?: string;
 iteration?: number;
 lease?: {coordinator:string;key:string};
 phase: "preparing" | "developing" | "quiescing" | "reviewing" | "changes_requested" | "human_approval" | "integrating" | "cleanup" | "ci" | "complete" | "blocked";
 config?: LifecycleConfig;
 workspace?: import("../hub/git-lifecycle.ts").GitWorkspace;
 head?: string;
 review?: { sha: string; verdict: "approve" | "changes_requested"; summary: string; at: number };
 approval?: { sha: string; by: string; at: number };
 error?: string;
 /** Monotonic until an explicitly owned safe migration, independent of transient errors. */
 migrationRequired?: boolean;
 retryPhase?: TaskLifecycle["phase"];
 workerSettled?: boolean;
 devUpdated?: boolean;
 pr?: {number:number;url:string;head:string;sha:string;state?:string;summary?:string};
 /** Integration and Release are separate; no automatic client upgrade. */
 release?: string;
}
export const CRITICAL_RISK = /支付|账务|资金|金额|密钥|重要权限|权限边界|不可逆|删库|payment|billing|ledger|secret|credential|authorization|permission boundary|irreversible/i;
export function chooseLifecycle(input: LifecycleInput | undefined, text: string, config?: LifecycleConfig): LifecyclePolicy {
 const critical = config?.forceHuman || config?.defaultReview === "human" || input?.risk === "critical" || CRITICAL_RISK.test(text);
 // Read-only investigation/reminders do not execute changes, even when discussing risky systems.
 if (input?.kind === "read_only") return {workspace:"none",review:"none",template:"none",reason:input.reason || "只读/非编码任务"};
 if (critical) return {workspace:"worktree",review:"human",template:"C",reason:config?.forceHuman ? "项目强制人工批准" : "涉及资金、数据或重要权限风险"};
 // Never infer read-only solely from the absence of code keywords.
 if (input?.risk === "low" && input.complexity === "small_frontend" && config?.defaultReview !== "agent") return {workspace:"direct",review:"none",template:"A",reason:input.reason || "低风险小型前端需求；hub 仍检查工作区并发安全"};
 return {workspace:"worktree",review:"agent",template:"B",reason:input?.reason || "编码任务默认隔离并独立审查"};
}
