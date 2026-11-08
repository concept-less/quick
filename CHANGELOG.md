# Changelog

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


