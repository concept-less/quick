# Changelog

## v0.4.4

- Show readable task titles for chat references without rewriting history
- Web UI model lists: complete, grouped, refreshable. Front chat model select grouped by provider (provider · count), option = model id with capability metadata (context, max output, thinking, images), ↻ runs pi's official catalog refresh (ModelRuntime.refresh: reload models.json + provider refreshModels) and reports per-provider failures while keeping the previous list; GET /api/models returns metadata, current model, refresh result. WORKER panel: per-machine search, provider counts, metadata, 刷新列表 also refreshes the front list; hub keeps the last good pi --list-models list when a listing fails (stale + listError + listedAt) and passes pi's stderr warnings (listWarnings). Tests: unit (parse metadata, stderr warnings, stale list) + Playwright e2e test/e2e-model-list.mjs (35-37 models from a refreshModels provider extension, front = worker list, cross-machine difference, refresh, discovery failure keeps the list, front model unchanged); README
- Retry transient GitHub transport errors and test full checksum publication gate
- Handle inherited build stdout and pin draft source across retries; exercise successful prepare
- Test project backfill in named fixture instead of relying on developer checkout name
- Release main pushes on pinned cloud runner; stage cross-platform assets before publishing
- Web UI worker default model (worker 默认模型), separate from the front chat model: header button WORKER <model> (front select now labeled 前台) opens a panel with every mesh machine: effective model, source (workerModel / inherited model), that machine's own pi --list-models list, thinking level where supported; save per machine, clear to inherit, or apply to all (per-machine validation, partial failures listed per machine, failed machines unchanged). Hub: GET/POST /api/worker-model, mesh RPC workerModel.info / workerModel.set, owner permission (machine.configure), validated against the target machine's pi, persisted to its config.json (other keys kept), live for new and resumed workers without a hub reload, running workers untouched; listing runs pi without any QA_* / PI_* identity. Tests: unit + two-hub mesh with fake pi (test/worker-model.test.ts), Playwright e2e test/e2e-worker-model.mjs; README
- Browser extension: comment on top of modal <dialog>, popovers, fullscreen and z-index overlays
- Web UI 按项目 view, stable list: left task list grouped by project as the first dimension (default; 注意力 | 项目 switch remembered), block per project with counts (需要你 / 运行中 / 待扫 / 稍后), collapsible (需要你 cards stay visible, 已折叠 n 件), shown even with one project; fixed project order (manual order, then creation; drag a title or Alt+↑/↓, stored on the hub as project.order, replicated, POST /api/projects/order, quick projects order), 未归类 last; tasks in creation order (newest first) in both views, status/activity never move a card; fixed-height compact cards with single-line activity; in-place DOM patching of #tlist (keyed nodes, keeps scroll/focus/animations), relative times refreshed once a minute with fixed width; 需要你 button cycles + highlights 需要你 cards. Classification: a project created on dispatch (explicit / new repo) and hub start re-check weakly classified tasks; a manual move teaches the page URL (never steals another project's repository). Tests: unit + hub e2e + test/e2e-projects.mjs (Playwright: grouping, counts, collapse, persistence, 12 frames of live updates without movement, drag reorder)
- Expected time + watchdog reviews (预期时间与巡检): every task carries an expectation (qa_dispatch expected / quick new --expected, default by kind of task, one worker revision via qa_expect with a reason, ON_TRACK updates) and an active-time clock (starting/running only); the hub checks own running tasks on a timer and, when one is over its expectation (1.5x, 3x, 6x…, configurable), has made no progress for N minutes (progress.updatedAt from t8f4a, reports), shows a repeated pattern in its recent tool calls (same call + same result, same error, unchanged polling, edit flip-flop) or was corrected before, runs an independent read-only reviewer (pi -p, read/grep/find/ls, no QA_* identity, verdict JSON on stdout) with cooldown + dedupe; ON_TRACK silently updates the expectation, DRIFTING/STUCK/BAD_APPROACH send a 【巡检纠偏】 follow-up to the worker and escalate to 需要你 [CHECK] when it happens again, NEEDS_HUMAN escalates; the reviewer never edits code or stops a task. Web UI card 已用/预期 + [OVER], detail 巡检 section and on/off/now, quick watch, quick show/ls and front qa_task_read show it; config.json watchdog (multipliers, cooldown, stall, repeat, model, per-task off). Isolation: worker role only in interactive pi, QA_WATCH_TASK loads no role. docs/watchdog.md, README, tests (unit, isolated hub, real-reviewer e2e with screenshots)
- Browser comments are one-shot: no page marks after sending, consumed on claim
- Task progress + 工作记录: worker qa_progress (plan 3-8 steps, current step, plain-language note, percent/eta, expectedMinutes per step) → task.progress (shared/progress.ts: steps done/active/todo, note, now, recent milestones, startedAt, updatedAt only on real changes), persisted + SSE, never interrupts; fallback for workers without a plan: raw tool activity translated into plain words (git push → 推送代码, npm test → 跑测试, edit → 修改 X …) with milestones, also used for the attention reason; Web UI: step list (■ ▶ □), now line, elapsed / last update, raw command folded into 细节, card shows n/m step + thin bar; 工作记录 in the task detail (shared/transcript.ts, GET /api/tasks/:id/transcript, mesh task.transcript): text, thinking, tool calls with results/diffs, follow-up instructions, reports; incremental tail only while open, follows the bottom unless you scroll up, pages back, folds runs of reads/repeated commands; follow-up composer pinned under the detail with instant echo; quick log <id> [-f], quick show/ls and front qa_tasks/qa_task_read show progress; worker prompt asks for progress at milestones; tests (unit, hub e2e) + test/e2e-progress.mjs (Playwright demo)
- install.sh: work on macOS /bin/bash 3.2 (empty auth array under set -u; brace $VAR before full-width punctuation)
- update: ignore a legacy 0.3.x update.json (latest as a string) instead of crashing quick version / /api/update

Source SHA: 420ea78e0a152224214e8de880b3fb88f794cab1
Build: https://github.com/concept-less/quick/actions/runs/42494513138
Cloud: quick-release-cloud (dedicated trusted runner)

<!-- quick-source:420ea78e0a152224214e8de880b3fb88f794cab1 -->

## v0.4.1 — 2026-11-08

- release.sh: BSD/macOS-compatible sed in the CHANGELOG step
- update: realpath fallback for missing paths (pruned version dir under a symlinked tmp, e.g. macOS /var → /private/var, was misdetected as unmanaged; fixes update.test on macOS)
- release workflow: give electron-builder a publish config (update metadata needs it; nothing is published); electron/package.json repository
- Projects: tasks auto-organized by project. hub/projects.ts + shared/projects.ts: ~/.quick-agent/projects.json registry (id, name, git remotes, per-machine dirs, path/URL/keyword rules, members, LWW-replicated over the mesh, dedupe by remote), classification on create (explicit > git remote/worktre


Full diff: https://github.com/concept-less/quick/compare/v0.4.0...v0.4.1

## v0.4.0 — 2026-11-08

第一个正式 Release。从这个版本开始，quick-agent 基于 GitHub Release 发布和升级，不再跟着 main 分支同步。

**安装 / 从 git 安装迁移**

```bash
curl -fsSL https://raw.githubusercontent.com/concept-less/quick/main/install.sh | bash
```

安装到 `~/.quick-agent/app/<版本>`，`current` 软链接指向当前版本；开发目录（git 副本）原样保留，进入开发模式（不自动更新，只提示）。

**升级**：Web UI / 桌面客户端顶栏的「升级」按钮（下载 → 校验 → 切换 → 重启，worker 不受影响），或 `quick upgrade`；`quick upgrade --rollback` 回滚。`quick` 每次启动都会检查新版本。

**产物**：`quick-agent-0.4.0.tgz`（install.sh / quick upgrade 安装的包）、浏览器插件 zip、macOS 客户端 dmg/zip（GitHub Actions 构建）、`SHA256SUMS`。

### 提交记录

- Release-based upgrades: GitHub Release as the update source (cached check on every quick start, one-line hint), release installs in ~/.quick-agent/app/<v> with atomic current/previous switch + rollback, SHA256SUMS verification; Web UI header version label / 升级 button with per-machine panel, re
- Team collaboration phase 2 on the attention model: Web UI team view (header 团队 button) + task people/assign controls + comment thread (ui/team.js), quick team board, quick new --reviewer/--assignee/--watch, front /tasks + widget per person and team view shows whose ball, team view surfaces set
- Attention-first: hub-owned attention model (need/skim/snoozed/inflight/archived) with central interrupt policy, digests, focus & snooze in hub; /api/attention + SSE; explicit worker needs_human ask; Web UI queue-first screen without sessions (one continuous front); attention-routed reports to all 
- README: cron plans in team mode (requester, permissions)
- Scheduled tasks (cron): shared/cron.ts (5-field cron parser, next-run with time zones + DST, every/at/in, overlap + catch-up decisions), hub/cron.ts (persisted ~/.quick-agent/cron.json, 1s timer dispatching via the POST /api/tasks path, single owner hub per job + mesh replicas/routing, failed disp
- README: gesture picking
- Extension: gesture-based picking (click = element, drag ≥5px = region; no mode buttons), toolbar at bottom, pins ignore the pointer while picking and fan out on one element; popup layout fixes; v2 screenshots + docs/ui-redesign notes; extension e2e test (test/browser)
- README: Web UI layout + shortcuts, extension shortcuts/send key/drafts/pins
- Remove emoji across the project (minimal brutalism): ⚡→■/□ (brand, TUI status, tray), ⚠/⏳/⌨/⏏/✅/⚠️ → [ERR]/■/?/○/[OK]/[!], ✗→✕; monochrome geometric marks only
- Web UI: task view on the left, front-agent chat on the right (all widths; narrow screens get a [任务|对话] switch, tasks first); fix tokens.css header comment that broke inlining
- UI v2: single-source design tokens (shared/tokens.css → Web UI, login, popup, in-page shadow DOM), extension in-page UI restyled in the shadow root; comment pins bound to the page (pageKey on hub+extension, SPA/hash/back/bfcache aware, stale polls dropped), pins re-measured on scroll/resize/DOM 
- Team collaboration phase 1: members (owner/member, user tokens, one-time invites, roster replicated over the mesh), machine owners, task requester/assignee/reviewer/watchers, per-person pings and acks, task comments with @mentions (@all, @worker), quick team/assign/comment, front qa_task_assign/qa
- Lossless task handoff between machines: quick handoff / qa_handoff / dashboard button
- UI: remove 实时终端 and 事件 from task detail entirely (drop 调试信息 section, screen polling, event rendering) (comments c4846, c8fdd)
- Machine resources + priority scheduling: machine.resources/resourceNotes/priority (auto-detected OS/GUI/browser/codex/claude/docker/gpu, config overrides), published via mesh; dispatch picks best-priority online machine with all requires, cwd follows the chosen machine, clear errors; qa_dispatch r
- Web UI: one-click 知道了 on finished task cards — one-line conclusion (first sentence of the report), full report folded, ack collapses the card and persists via task.ack; acked finished tasks move to a new 回顾 filter (failed/blocked/needs-input stay prominent)
- UI: hide 实时终端/事件 in task detail; move into collapsed 调试信息 and only poll screen while it is open (comment c8f6a)
- Electron desktop client (attention-first): reuses hub + Web UI via shared/*-process, token as HttpOnly cookie, sandboxed window; tray/Dock count only 需要你, immediate notifications only for need-you, digest for 待扫, focus mode, global ⌘⇧Space 把一件事交出去, deep links, window st
- UI: minimal-brutalist redesign — shared design tokens (paper/ink + one red accent, square corners, mono labels), compact tool-call log, code copy, composer busy state, keyboard nav (/ Esc ↑↓ Enter), task loading/empty/offline states, responsive tweaks; matching extension popup, picker overla
- test: portable sed -i (BSD/macOS) in npm-global install test
- Attach to worker windows locally or remotely: shared/attach.ts (tmux switch/attach, ssh -t to mesh peers), /qa-attach + Ctrl+Alt+A picker in pi, quick attach via ssh
- Web UI: chat with the front agent in the browser (pi SDK session), live task panel, reports & browser comments; quick ui
- Browser extension: activeTab + on-demand injection, Cmd/Ctrl+Shift+E shortcut, clearer hub errors, store packaging & listing/privacy docs
- Self-upgrade: background version checks (npm → GitHub Release → git), auto-install per install kind, quick upgrade [--check] [--all|machines] over the mesh, npm-ready package.json, tests
- Rename CLI from qa to quick
- README: install from GitHub
- Native multi-machine mesh: hub links (SSE+POST, ssh tunnels), distance-vector routing, rev-based replication, routed RPC, remote fs, mesh CLI, machine-aware front/dashboard
- Install quick-agent into pi as a package: plain pi is the front agent; /qa toggle, /peek, dashboard live terminal
- quick-agent: front/worker agent workflow on pi (hub, extensions, CLI, browser extension)


