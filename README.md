# quick-agent

**quick-agent 的核心是注意力管理：替你把事情做完，只在真正需要你时打扰你。**

你只关心两件事：交出去的事，和哪些事需要你。把一件事交给 quick-agent 之后就可以忘掉它；它在后台找一个 worker 从头做到尾，只有在 worker 需要你拍板、受阻或失败时才立即叫你；做完的事安静地进入「待扫」，有空扫一眼、点「知道了」即可。没有会话要管理，也没有时间线要翻，所有界面看到的都是同一个按优先级排好的注意力队列（见下文「注意力模型」）。

它是一个 **pi 包**：装好以后，**你平时打开的 pi 就是 quick-agent 的前台 agent**，不需要额外的启动命令。

- **前台 agent**：你交代事情的地方。终端 pi、Web UI、桌面客户端都是前台。它要求 **快**，只负责理解任务、组装上下文、派单。前台模式下只有 `read/grep/find/ls` 和 `qa_*` 工具，其余工具一律拦截。
- **worker agent**：每个任务都有一个独立的负责人，是一个完整的 pi agent，跑在 tmux 窗口 `qa:<id>` 里，从头到尾把任务做完。它不是 subagent，你随时可以观看或接管。
- **hub**：本地常驻服务，pi 启动时会自动拉起它。负责任务注册表、**注意力模型**（唯一的「什么需要你」来源）、worker 生命周期、入口接入和 SSE 事件流。
- **入口**：pi 本身、浏览器插件（框选元素后写评论）、`quick` CLI，以及任何能发 HTTP 请求的程序。
- **定时任务**：「每天 9 点…」「每周一…」「30 分钟后…」「每 2 小时…」这类计划由 hub 保存，到点自动派一个 worker 任务（见「定时任务（cron）」）。

```
 入口                         前台层                      后台层
 pi (TUI/RPC) ─┐
 浏览器插件 ────┼──► hub ◄────► 你的 pi = 前台 ──qa_dispatch──► worker (pi @ tmux qa:<id>)
 quick CLI ────┘    (任务/收件箱/SSE/面板)                     ├─► worker …
                    ▲                                          │
                    └──── qa_report / 活动 / 需要你 ────────────┘
```

就像中断处理一样：前台是上半部，只做最少的事，马上返回；worker 是下半部，负责把工作完整做完；hub 的注意力模型决定什么时候值得打断你。

## 注意力模型

定义在 `shared/attention.ts`（纯函数），由 hub 计算并下发（`hub/attention.ts`）。Web UI、桌面客户端、终端 pi 前台、浏览器插件和 `quick` CLI 都直接渲染 hub 给出的结果，不再各自解读任务状态，所以各处显示的「需要你」数量永远一致。

### 状态

每个任务在任一时刻只处于一个注意力状态，带「原因」「进入时间」和「你能做的动作」：

| 状态 | 标记 | 什么时候 | 你能做的 |
|---|---|---|---|
| **需要你** | `[ASK]` `[BLOCKED]` `[FAILED]` `[EXITED]` `[STOPPED]` | worker 提问（`qa_report needs_human`）、受阻、失败、意外退出、没汇报就停下了，正在等你决定 | 回答（可直接点 worker 给的选项）、重试、稍后提醒、知道了、接管 |
| **待扫** | `[DONE]` | 已完成但你还没确认 | 知道了、继续追问、稍后提醒 |
| **稍后** | `[LATER]` | 你对「需要你/待扫」点了「稍后提醒」（默认 60 分钟），到点自动回到原来的状态 | 现在处理、知道了、回答 |
| **不用管** | `[RUN]` `[MOVE]` | 已交出去，正在做（含启动中、交接中） | 追加指令、中止、接管 |
| **已归档** | `[ARCHIVED]` | 你点过「知道了」、任务已取消/窗口已关，或完成超过 7 天没确认 | 追加指令（重新激活） |

排序：需要你（等得最久的在前）> 待扫 > 稍后（最先回来的在前）> 不用管 > 已归档。状态一变化（新的问题、重新运行、完成）就是新的注意力，旧的「稍后」随之失效。

worker 需要人类决定时必须显式上报：`qa_report(status="needs_input", needs_human=true, question="一句话的问题", options=["A","B"])`。hub 把问题和选项存进任务（`task.ask`），各个界面直接展示，不靠解析汇报文字。

团队模式下（`docs/team-collaboration.md`），hub 再按人计算（`shared/team.ts` 的 `personalAttention`）：同一个任务对不同的人处在不同层级（被 @、被指派、请你验收进「需要你」；球不在你手里时是「不用管 · 等某人处理」）。`/api/attention` 和 SSE 按请求的 token 返回「你的」队列，打扰也只打扰那个人；`?scope=team` 是不打扰的团队视图。单人使用时就是上表。

### 打扰策略

集中在一处（`interruptFor` + hub 的合批）：

- 只有进入「需要你」（包括「稍后」到点回来、已经在等你时又来了新问题）才 **立即** 打扰：桌面通知、Web UI 提示、终端前台通知，并由一个前台 agent 主动用一两句话转告你。**专注模式下也放行。**
- 进入「待扫」**从不立即打扰**：hub 把它们合批，攒够 `digestMinutes`（默认 30 分钟，从第一件开始计时）后推送一条「N 件事已完成待扫」摘要。专注模式下摘要留到专注结束再发。
- 进度、活动、确认、归档从不通知。
- 专注模式、摘要间隔、待发摘要都持久化在 hub（`~/.quick-agent/attention.json`），所有客户端共享。

### 进度与工作记录（只在你看的时候出现）

「不用管」的任务也能看出做到哪了，但这些信息从不打扰你：不进「需要你」，不发通知，只在你打开任务或看卡片时显示。

- **进度**（`shared/progress.ts`，`task.progress`）：worker 开工时用 `qa_progress` 上报计划（3–8 个步骤，可带每步预计分钟数），每完成一步或切换阶段时更新「正在做第几步」和一句人话说明（例如「正在发布 v0.4.1：已打 tag，等 CI 构建 dmg」），可选百分比 / 预计剩余时间。任务卡片显示「3/6 发布 Release」和一条细进度条；任务详情顶部是步骤清单（`■` 已完成、`▶` 进行中、`□` 未开始）、当前说明、已用时间、最后更新时间和最近几个里程碑，原始命令折在「细节」里。`quick ls` / `quick show` / 前台的 `qa_tasks` / `qa_task_read` 显示同样的内容。
- **兜底**：没有上报计划的 worker（老版本、几分钟就做完的小任务）由 hub 把工具活动翻译成人话（`git push` → 推送代码，`npm test` → 跑测试，编辑文件 → 修改 X，`scripts/release.sh` → 执行发布脚本……），重要动作记为里程碑。注意力原因里的「进行中：…」也是这句人话，不再是原始命令。
- 字段：`progress.steps[]{title, state: done|active|todo, expectedMinutes?}`、`note`、`percent`、`eta`、`now`（活动的人话）、`recent[]`（里程碑）、`startedAt`、`updatedAt`（只在计划/步骤/说明有实质变化时更新，活动不刷新它，可用来判断多久没有进展）、`nowAt`（最近一次活动）。任务完成时步骤全部标为完成；完成后再追加指令开始新一轮时进度重置。
- **工作记录**（`shared/transcript.ts`）：任务详情里「工作记录」区完整展示 worker 做了什么：每轮的输出和思考、每个工具调用（命令、读写了哪个文件）和结果（默认截断，可看全文；edit 显示 diff）、收到的追加指令、汇报和进度上报。连续的同类动作（几次 read、同一条命令反复执行）折叠成一行。只有展开这个区时才拉取（`GET /api/tasks/:id/transcript`，跨机器经 mesh 读取所属机器上的记录）；运行中自动追加新条目、停在底部跟随，往上翻时不会被拉回去，「更早的记录」分页加载。已完成的任务同样能回看。追加指令输入框常驻在详情底部（Enter 发送），发出的指令立即出现在记录里，worker 的回应随后出现；窗口关了也能发，hub 会带着完整上下文恢复 worker。CLI：`quick log <id> [-f] [-n N]`。

### 预期时间与巡检（超时了才看一眼，必要时才找你）

很多任务实际耗时远超预期，却没人发现它在兜圈子。hub 给每个任务一个预期时间，明显超时、长时间没有进展或者出现重复模式时，自动派一个独立的只读检查 agent 审视它；检查本身不打扰你，只有真正需要你拍板时才进「需要你」。设计和理由见 [`docs/watchdog.md`](docs/watchdog.md)。

- **预期时间**（`task.expect`）：前台派单时必须估时（`qa_dispatch` 的 `expected`，如 `"20m"`；`quick new --expected 30m`）。没给就按任务类型取默认值（小改动 15m、普通 30m、发布/调研/新机制等大任务 60m、定时任务 15m，可在配置里改）。worker 看清任务后可以用 `qa_expect` 带理由修正一次。只计 worker 实际在做的时间（starting/running），等你回答的时间不算。卡片上显示「已用 / 预期」（如 `12m / 20m`），超时后加粗、标记变成 `[OVER]`，不发通知。
- **触发巡检**（hub 定时检查，默认每 30 秒）：已用超过预期的 1.5x，之后 3x、6x……（预期被更新后重新从 1.5x 算）；进度（`progress.updatedAt` / 汇报）20 分钟没变；最近的工具调用里出现重复模式：同一条命令得到同样的结果、同一个错误反复出现、等待/轮询结果一直不变、来回改同一处。同一任务两次巡检之间至少隔 10 分钟（冷却），同一次停滞、同一个重复模式只查一次，最多同时跑 2 个检查。
- **检查 agent**：`pi -p` 跑的独立进程，只有 read/grep/find/ls 工具，不能改代码，不能中止任务，环境里不带任何 quick-agent 身份（`QA_*` 全部去掉）。hub 把材料整理给它：简报、预期和已用时间、进度、最新汇报、检测到的重复模式、最近 40 次工具调用和输出、git 状态和 diff 统计、之前的巡检；需要时它可以自己去读 worker 的内部记录。它在标准输出的最后一行给出结论 JSON，hub 解析。结论五选一：`ON_TRACK`（正常，只是比预估难，给新预估）、`DRIFTING`（偏离简报）、`STUCK`（死胡同或循环）、`BAD_APPROACH`（方法有问题，给替代方案）、`NEEDS_HUMAN`（缺信息或要拍板）。
- **处理**：`ON_TRACK` 静默更新预期，只在任务的「巡检」区记一行；`DRIFTING` / `STUCK` / `BAD_APPROACH` 把具体建议作为追加指令（`【巡检纠偏】…`）发给原 worker，冷却后复查一次，仍有问题就升级给你；`NEEDS_HUMAN` 直接升级。升级后任务进「需要你」，标记 `[CHECK]`，带一句问题和选项；你回答（会连同巡检的问题一起转给 worker）、点「知道了」或任务停下后自动消失。是否中止只由你决定。
- **可见性**：任务详情的「巡检」区列出每次巡检的时间、结论、触发原因、依据和建议，进度区和信息区显示「已用 / 预期」和预期来源，可以「关闭巡检」或「现在巡检」。`quick show <id>`、`quick watch <id> [on|off|now|expect 30m]`、前台的 `qa_task_read` 都能看到。
- **按任务关闭**：长时间轮询/等待的任务派单时传 `watch: false`（`qa_dispatch watch=false`、`quick new --no-watchdog`），或者之后 `quick watch <id> off`。

配置（`config.json` 的 `watchdog`，全部可选）：

```json
"watchdog": {
  "enabled": true, "multipliers": [1.5, 3, 6], "cooldownMinutes": 10, "stallMinutes": 20,
  "repeatThreshold": 4, "repeatWindow": 30, "model": "tokenjoy/claude-sonnet-5-5", "thinking": "low",
  "timeoutMinutes": 8, "maxCorrections": 1, "maxConcurrent": 2, "tickSeconds": 30,
  "defaults": { "small": 15, "normal": 30, "large": 60, "cron": 15 }
}
```

`model` 不写时用 `workerModel` / `model`，建议换成便宜快一点的模型。`QA_WATCHDOG=off` 临时关闭整个巡检。测试：`npm test`（`test/watchdog.test.ts` 触发条件、冷却、重复模式、结论处理；`test/watchdog-hub.test.ts` 隔离 hub + 假 worker + 假检查 agent 的完整流程和环境隔离）；`test/watchdog-e2e.mjs` 用真实的检查 agent 跑一遍（兜圈子的假 worker 得到 STUCK → 纠偏 → 再 STUCK → 需要你；正常但慢的假 worker 得到 ON_TRACK，不打扰人），可选 `--shots DIR` 截图。

### 汇报怎么送到前台

汇报按任务和注意力送达，不依赖是哪个前台派的单：

- 每个在线的前台（Web UI、终端 pi）都会把「需要你」「待扫」的汇报作为 `[quick-agent 汇报]` 卡片放进自己的对话（按 `任务:状态:进入时间` 去重），所以派单的那个 pi 关掉了也不会丢。
- 「需要你」只由 **一个** 前台主动开口：派单的前台在线就是它，否则是常驻的 Web UI 前台，再否则是任意在线前台（hub 在事件里用 `front` 字段指定）。其余前台只放卡片、不触发回复。「待扫」从不触发回复。
- 前台（重新）连上 hub 时会补发离线期间漏掉的「需要你/待扫」，合成一条消息。

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/attention?archived=N` | 按优先级排好的队列 `items[]`（`taskId,title,level,mark,reason,since,question,options,snoozedUntil,actions[]`）、`counts{need,skim,snoozed,inflight,archived}`、`focus`、`digestMinutes` |
| POST | `/api/attention/focus` | `{on, minutes?}` 开关专注模式（不带 minutes 表示直到关闭） |
| POST | `/api/attention/settings` | `{digestMinutes}` 待扫摘要间隔 |
| POST | `/api/tasks/:id/ack` | 知道了：移出「需要你/待扫」，进入已归档 |
| POST | `/api/tasks/:id/snooze` | `{minutes}` 稍后提醒（默认 60；0 表示现在就放回来） |
| POST | `/api/tasks/:id/retry` | 让停下/失败的 worker 从中断处重试 |

SSE（`/api/events`）：`attention`（`item, prevLevel, interrupt: now|digest|none, counts, focus, front`）、`attention.digest`（`items, reason: timer|focus_end`）、`attention.state`（专注模式或计数变化）。CLI：`quick attention`（`quick a`）、`quick snooze`、`quick focus`、`quick retry`、`quick ack`。

## 安装

需要 Node ≥ 22.18、[pi](https://github.com/earendil-works/pi)，以及 tmux（worker 跑在 tmux 窗口里）。

**普通用户：安装正式 Release**（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/concept-less/quick/main/install.sh | bash
```

`install.sh` 会下载最新 Release 的 `quick-agent-X.Y.Z.tgz`，按 `SHA256SUMS` 校验，解压到 `~/.quick-agent/app/X.Y.Z/`，把 `~/.quick-agent/app/current` 指向它，把 `quick` 链接到 `~/.local/bin/quick`，再 `pi install ~/.quick-agent/app/current`。如果 hub 正在运行，会顺便平滑重启它。可选参数：`--version 0.4.0`、`--tarball 文件 --sums SHA256SUMS`（离线安装）、`--no-pi`、`--no-link`、`--no-restart`。

**开发者：git 副本（开发模式）**

```bash
git clone git@github.com:concept-less/quick.git ~/quick-agent
pi install ~/quick-agent                # 写入 ~/.pi/agent/settings.json 的 packages（加载本地目录，不拷贝）
ln -sf ~/quick-agent/bin/quick ~/.local/bin/quick   # 命令行工具（确保 ~/.local/bin 在 PATH 中）
```

git 副本是**开发模式**：从不自动更新，只在有新 Release 时提示一行。改了代码以后，在 pi 里执行 `/reload`，或者新开一个 pi，就能生效。卸载用 `pi remove ~/quick-agent`。

## 升级与发布

更新来源是 **GitHub Release**（`concept-less/quick`），不再跟着 main 分支走。

### 用户：怎么升级

- **Web UI / 桌面客户端**：顶栏右侧有一个版本标签（如 `v0.4.0`）。有新版本时它变成红框的「升级 vX.Y.Z」按钮，不弹窗、不通知。点开是版本面板：mesh 里每台机器的运行版本、已安装版本、最新版本和更新说明，每台都有「升级」按钮（Release 安装还有「回滚」）。点升级后显示进度：检查 → 下载 → 校验 → 切换 → 重启。本机的 hub 和 Web UI 服务重启后，页面自动重连并刷新。
- **CLI**：`quick` 每次启动都会检查新版本（结果缓存 10 分钟，超时 1.5 秒，不阻塞命令），有新版本时在输出末尾打印一行 `new version vX.Y.Z available: quick upgrade`（只在终端里打印；`--json` 和 worker 里不打印）。

```bash
quick version                    # 运行版本、已安装版本、hub 版本、最新 Release
quick upgrade --check            # 只检查
quick upgrade                    # 下载 Release → 校验 SHA256SUMS → 原子切换 current → 平滑重启 hub + Web UI
quick upgrade --rollback         # 切回上一个版本（current ↔ previous）
quick upgrade --all              # 通过 mesh 升级所有在线机器（包括本机），汇总每台的 旧版本 → 新版本
quick upgrade cloud mac-laptop   # 只升级指定机器（也可以写 --machine cloud,mac-laptop）
quick upgrade --all --check      # 查看全网版本；... --json 机器可读
quick hub reload                 # 用已安装的版本平滑重启 hub 和 Web UI 服务
```

**安装布局与原子切换**：`~/.quick-agent/app/<版本>/` 是解压好的 Release 包，`current` 和 `previous` 是指向版本目录的软链接。升级时先下载到 `app/.tmp-*`，校验 sha256、包名和版本号，解压成 `app/<新版本>/`，再用「新建软链接 + rename」原子地替换 `current`，旧版本变成 `previous`。任何一步失败，`current` 都不变。保留 current、previous 和再前一个版本，更早的自动删除。

**重启不影响 worker**：worker 跑在 tmux 里，和 hub 进程无关。升级后 hub 立刻执行 `quick hub reload`（新版本的代码）：写入 `~/.quick-agent/hub.restarting` 标记 → 停旧 hub → 起新 hub → 等 Web UI 里的前台 agent 空闲（最多 2 分钟）→ 重启 Web UI 服务。标记存在期间，worker 访问 hub 失败会自动重试，而不是报错；SSE 订阅会自动重连。正在运行的 worker 继续用旧版本跑完，下次启动时用新版本。

**其他组件**：

| 组件 | 升级后 |
|---|---|
| hub、Web UI 服务 | 自动平滑重启（`update.restartHub: "never"` 可关闭，之后手动 `quick hub reload`） |
| 前台 pi（终端） | 检测到磁盘上的版本变了，在空闲时自动 `/reload`（pi 加载的是 `app/current`） |
| worker | 不打断，下次启动用新版本 |
| 浏览器插件 | 插件弹窗发现插件版本比 hub 旧时，提示「重新加载插件」（从 `~/.quick-agent/app/current/browser` 加载的解压插件，重新加载就是新版）或「下载新版 zip」 |
| 桌面客户端（macOS） | 托盘菜单出现「更新客户端到 X.Y.Z」，版本面板里也有按钮：从 Release 下载 `-mac.zip`，校验后解压，退出时替换 `.app` 并重新打开；`.app` 所在目录不可写时改为下载 `.dmg` 并打开。没有用 electron-updater，因为 app 是 ad-hoc 签名，Squirrel.Mac 不接受 |

**多机**：版本面板通过 hub 的 `GET /api/update?all=1` 拿到 mesh 里每台机器的状态（mesh RPC `update.status`），升级按钮调用 `POST /api/update {machine, action: "install"|"rollback"}`（mesh RPC `update.start`），进度由那台机器的 hub 维护。`quick upgrade --all` 走 mesh RPC `update.run`，各机器并行，单台超时 6 分钟。还在运行旧版本的 hub 会显示「对方 hub 版本过旧」，需要在那台机器上手动迁移一次（见下）。

**配置**（`~/.quick-agent/config.json` 的 `update`，都可以省略）：

```jsonc
"update": {
  "enabled": true,          // false：不检查（quick upgrade 仍可用）
  "autoInstall": false,     // true：发现新版本后自动安装（hub 后台检查、quick 启动检查都会触发）
  "cacheMinutes": 10,       // Release 查询结果缓存时间
  "cliTimeoutMs": 1500,     // quick 启动检查的超时
  "restartHub": "auto",     // "never"：升级后不自动重启 hub / Web UI
  "requireChecksum": true,  // Release 没有 SHA256SUMS 时拒绝安装
  "githubRepo": "concept-less/quick"
}
```

环境变量：`QA_UPDATE=off`（或 `QA_NO_UPDATE=1`）关闭检查，`QA_UPDATE_AUTO_INSTALL=1|0`，`QA_UPDATE_CACHE_MINUTES`，`QA_GITHUB_API`、`QA_GITHUB_REPO`（测试用的假 Release 源），`QA_APP_DIR`（安装目录，默认 `~/.quick-agent/app`）。访问 GitHub API 默认不带 token（公开仓库），有 `GITHUB_TOKEN` / `GH_TOKEN` 或 `gh auth token` 时会用上。

npm 安装（`pi install npm:quick-agent` / `npm i -g quick-agent`）也能识别，升级时分别执行 `pi update npm:quick-agent` / `npm install -g quick-agent@版本`；不过目前不默认发布到 npm。

### 从 git 安装迁移到 Release 安装

在每台机器上（开发目录原样保留）：

```bash
curl -fsSL https://raw.githubusercontent.com/concept-less/quick/main/install.sh | bash
# 或者在开发目录里：bash ~/quick-agent/install.sh
quick version        # 应显示「Release 安装，~/.quick-agent/app/X.Y.Z」
```

`install.sh` 会把 pi 里注册的其他 quick-agent 副本（比如 `~/quick-agent`）从 pi 的 packages 里移除（目录本身不动），改为加载 `~/.quick-agent/app/current`；把 `~/.local/bin/quick` 改指向新安装；再平滑重启正在运行的 hub 和 Web UI 服务。前台 pi 需要新开一次（或执行 `/reload`）。之后要切回开发模式：`pi remove ~/.quick-agent/app/current && pi install ~/quick-agent && ln -sfn ~/quick-agent/bin/quick ~/.local/bin/quick && quick hub restart`。

### 维护者：发布新版本

```bash
scripts/release.sh minor --dry-run    # 隔离预览 committed HEAD → dist/release-preview/版本/，不提交/推送/安装
scripts/release.sh minor              # 手动排队：patch | minor | major | X.Y.Z（发布最新 origin/main）
```

**自动发布**：每次 `origin/main` 的新 push 触发 [release Action](https://github.com/concept-less/quick/actions/workflows/release.yml)，不是监视未提交文件。自动默认 patch；手动命令只是 `workflow_dispatch --ref main`，与自动流程共用 `quick-release-main` 全流程锁，不在开发/hub 目录构建。短时间连续 push 合并为最多一个 pending run，锁内重新 fetch 最新 main；被合并的提交随最终 source SHA 一起进入 Release（可从 git ancestry/更新说明追溯，不为每一个中间 SHA 单独发布）。已公开的 source SHA 重跑幂等跳过。

**版本策略**：从仓库版本和全部已保留 `vX.Y.Z` tags 取最大版本，再递增（显式版本必须更大）。cloud 在独立 checkout 先跑 `npm test`，然后同步 package/Electron lock/manifest 版本、生成 CHANGELOG，创建以 source main SHA 为 parent 的 **release-only commit/tag**。只 push tag，**不向 main push bump/changelog commit**，因此不会自触发循环，也不会与人的 main push 冲突。main 的 package 版本可以落后；安装包和 tag 中的版本是权威版本。Release notes、tag trailer 和 `release.json` 记录 source SHA、构建 commit、Action URL 和 cloud runner。

**先 draft，后公开**：cloud 完成 core/插件产物后创建 draft；同一 workflow 的 GitHub macOS runner 从该不可变 tag 构建桌面。收齐下列产物，验证 cloud checksum 和 provenance，生成完整 checksum 并复验后，才将 draft 公开并设为 latest。updater 不会看到半成品。不发 npm，也不升级任何 hub/UI/worker。

| 产物 | 说明 |
|---|---|
| `quick-agent-X.Y.Z.tgz` | `npm pack` 的包，`install.sh` 和 `quick upgrade` 安装的就是它 |
| `quick-agent-extension-X.Y.Z-chrome.zip` / `-firefox.zip` | 浏览器插件 |
| `quick-agent-X.Y.Z-arm64.dmg` / `-arm64-mac.zip` | GitHub macOS runner 构建，ad-hoc 签名、未公证；不在 Linux 构建 dmg |
| `release.json` | version、source SHA、release commit、Action URL、cloud runner、构建时间 |
| `SHA256SUMS` | core、两个插件、两个桌面包、release.json 全部文件的 sha256 |

**cloud 识别与安全边界**：唯一专用 runner `quick-release-cloud`，要求 `[self-hosted, linux, x64, quick-release-cloud]`。部署于 `/home/simon/.local/share/quick-release-runner`，构建只在其 `_work/quick/quick`，不触碰 `/home/simon/quick-agent` 或已安装 app。仓库外 `ops/trust-gate.sh` 作为 `ACTIONS_RUNNER_HOOK_JOB_STARTED` 在 checkout 前 fail-closed 校验本机 `/etc/machine-id` hash、repository、main ref、push/manual 事件、精确 workflow ref；拒绝 PR、fork、tag、非可信分支和其他 workflow。仓库外部贡献者 workflow 设置为 **all_external_contributors 需批准**；不要批准任何将 PR 代码送到 cloud 的 workflow，不要为 PR 添加该标签或开启 pull_request_target。main 写权限就是在 cloud 执行代码的信任边界，请限制维护者并保护 main。runner 无长期 GitHub PAT，job 使用临时 `GITHUB_TOKEN`（cloud/mac 仅 contents:write，失败通知 job 无写权限）；凭证不进入产物/日志。

**服务运维**：user systemd 单元 `~/.config/systemd/user/quick-release-runner.service`（已 enable，用户 linger），`systemctl --user status|stop|start quick-release-runner`，日志 `journalctl --user -u quick-release-runner`。停服务不会停止 hub/worker；临时停用自动发版可禁用 GitHub release workflow。runner 的 ops 门禁/通知脚本源文件在 `scripts/cloud-runner-gate.sh`、`scripts/cloud-release-notify.mjs`，升级部署需维护者将其复制到仓库外 ops 目录；不要用来自 PR 的脚本替换。网络代理取本机 `127.0.0.1:7890`，无外网监听/新入站密钥；注册令牌仅一次性使用。机器更换需重新校验 machine-id、注册标签。runner 支持自身更新，版本也可通过 Actions runner 管理页核查。

**失败/重试**：测试失败不创建 Release；后续失败保留 draft，不改已运行版本。失败通知 job 通过 cloud 本机既有 hub 鉴权接口派一个“只汇报 blocked、不改代码”的通知 worker，进入「需要你」，按 Action run ID 去重；成功不派单、不通知。如果 runner/hub 离线，通知无法送达，仍以 GitHub Actions 红色状态/订阅邮件为兜底。到 Action 页面选择 **Re-run all jobs** 可继续同一 source 的 draft（macOS 产物可重复覆盖）；发布成功后重跑直接跳过。若 cloud 资产缺失/上传中断，脚本 fail-closed，维护者检查草稿后删除不完整 draft 再重跑；孤立 tag 保留占用版本，不覆写 tag、不 force。不要手工提前公开草稿。旧的 `--npm`、`--no-push`、`--notes` 入口已拒绝，避免绕过锁；本地预览用 `--dry-run`。

**用户看到更新的延迟**：先等 cloud 测试、排队、macOS 下载依赖/构建（通常数分钟，受 GitHub runner 排队和网络影响，不保证即时）。公开后 CLI 下次执行会检查，缓存默认 10 分钟（非 TTY/worker 不打印）；hub 后台默认每 10 分钟检查，UI 每 5 分钟刷新版本状态，所以在线 UI 最坏约再等 15 分钟（失败/离线更久）。版本面板手动刷新/`quick upgrade --check` 可主动检查。可将 `update.cacheMinutes` 调低到 1（注意 GitHub API 限流）；没有新增 webhook 入站口或广播安装。**仍必须由用户点击升级**，本流程从不设置 `autoInstall`、从不执行安装/重启；用户自己设置的 autoInstall 属于原有可选配置。

测试：`npm test`（全部在临时目录、临时端口里进行：版本比较、缓存、下载校验、原子切换和回滚的单测；4 个临时 hub 加一个假 GitHub API 模拟多机升级，包括「发现新版本 → 升级 → 重启 → 版本变化」，期间 tmux 里的 worker 一直在向 hub 汇报、一次请求都不失败）。浏览器端到端演示：`PLAYWRIGHT_CORE=…/playwright-core CHROMIUM=…/chrome node test/e2e-ui-upgrade.mjs --shots DIR`（隔离 hub + Web UI，headless 浏览器点「升级」，验证页面自动刷新到新版本、worker 不受影响）。

## pi 如何选择角色（`extensions/quick-agent.ts`）

| 情况 | 角色 |
|---|---|
| 环境变量里有 `QA_TASK_ID`（由 hub 拉起的进程） | **worker**：完整工具集，外加 `qa_report`、`qa_progress`（进度）、`qa_expect`（修正预期）、`qa_comment` |
| 环境变量里有 `QA_WATCH_TASK`（hub 拉起的巡检 agent） | 不加载任何角色（只读检查，结论走标准输出） |
| 交互式 pi（终端 TUI，或 RPC 客户端如桌面端） | **前台**（默认开启） |
| `pi -p …` / `--mode json` | 不受影响，就是普通 pi（即使环境里带着 `QA_TASK_ID` 也不会当 worker 汇报） |
| `pi --qa-off` 或 `QA_ROLE=off pi` | 普通 pi（仍然显示任务状态） |

在 pi 里可以随时切换：`/qa off` 切成普通 pi（恢复 bash/edit/write），`/qa on` 切回前台。

## 在 pi 里使用

直接说要做什么，前台会派单并立即回复任务 ID，然后你就可以忘掉它。之后按注意力模型处理：

- 状态栏和编辑器上方的组件显示「需要你 N · 待扫 M」；
- worker 需要你时立即弹出通知，汇报以 `[quick-agent 汇报]` 卡片进入前台对话，由一个前台用一两句话转告问题和选项；完成的汇报安静地进入对话和「待扫」，不触发回复（见「汇报怎么送到前台」）；
- `/tasks`：注意力队列，可以查看汇报、回答/追加指令、知道了、稍后提醒、实时观看、接管、中止或关闭。在 RPC 客户端里，它会改为输出队列；
- `/peek [id]`：在 pi 里用浮层实时观看 worker 的终端（只在 TUI 中可用），按 Enter 追加指令，按 a 接管；
- `/attach <id>`：如果 pi 跑在 tmux 里，就切换到 worker 窗口；否则效果和 `/peek` 一样；
- `/hub`：显示 hub 地址、面板链接和插件下载地址。在桌面端的内置浏览器里打开面板，就能看到每个 worker 的实时终端。

CLI（任何终端都能用）：

```bash
quick attention                # 注意力队列：需要你 / 待扫 / 稍后 / 不用管，每级内按项目分组（quick a；quick ls 是一行一个的版本）
quick ls --project quick-agent  # 只看一个项目；--by-project 先按项目分组
quick projects                 # 项目列表与识别规则（见「项目」）
quick show <id>                # 查看注意力、进度、汇报、简报
quick log <id> [-f]            # 工作记录：worker 的输出、命令和结果、追加指令（-f 持续跟随）
quick send <id> "回答或追加指令"  # worker 窗口关了也会带着完整上下文重新拉起
quick ack <id>                 # 知道了
quick snooze <id> [分钟]        # 稍后提醒
quick focus [分钟|off]          # 专注模式：只有「需要你」会打扰
quick retry <id>               # 让停下/失败的 worker 重试
quick attach <id>              # 接管：切换到 worker 的 tmux 窗口
quick handoff <id> <机器>       # 把任务（worker 的完整上下文 + 元数据 + 工作区）无损交接到另一台机器继续
quick cancel <id> / quick close <id>
quick new --cwd ~/proj "标题" "完整简报"   # 不经前台直接派单
quick hub start|stop|restart|status|logs
quick upgrade [--check] [--all] [--rollback]  # 升级（见「升级与发布」）
quick ui                       # 浏览器里的注意力队列 + 前台 agent（见下文 Web UI）
quick cron add --cron "0 9 * * *" "日报" "整理昨天的提交…"   # 定时计划（见「定时任务」）
quick dashboard | quick tunnel | quick token
```

## 定时任务（cron）

人类可以设定「每天 9 点…」「每周一…」「30 分钟后…」「每 2 小时…」这样的计划。到点后 hub 走和 `POST /api/tasks` 相同的派单路径（包括按资源和优先级选机器）创建一个 worker 任务，任务的 `source` 是 `{kind: "cron", cronId}`。汇报按注意力机制处理：

- 正常完成的运行只进入「待扫」（桌面端会合批成摘要），前台 pi 不会弹通知，也不会打断你；
- 失败、受阻或需要你决定的运行进入「需要你」。到点时派不出任务（比如指定的机器离线、没有满足 requires 的机器），hub 会留下一个 `failed` 任务，同样进入「需要你」；
- `--silent`（静默）：成功的运行直接归档（确认并归档，不进「待扫」），失败时照样找你。

在 pi 或 Web UI 里直接对前台说「每个工作日早上 9 点半帮我检查…，没问题就别打扰我」，前台会用 `qa_cron` 工具建计划，并复述计划 ID、规则和下次运行时间。也可以用 CLI：

```bash
quick cron add --cron "0 9 * * *" "日报" "整理昨天 ~/proj 的提交，写一段日报"          # 每天 9:00（hub 本地时区）
quick cron add --cron "30 18 * * 1-5" --tz Asia/Shanghai "周报提醒" "…"                # 工作日 18:30，指定时区
quick cron add --every 2h --silent --requires docker "巡检" "检查线上错误日志，有异常再汇报"
quick cron add --at "2026-11-09 09:00" "发布" "…"     # 一次性时间点（按 --tz / 本地时区解释）
quick cron add --in 30m --machine mac-laptop "提醒" "…"   # 30 分钟后执行一次
quick cron ls [-a]             # 列表：[ON]/[OFF]/[RUN]/[DONE]、规则、下次运行时间、最近一次任务
quick cron show <id>           # 详情与最近运行（[DISPATCHED] [SKIPPED] [MISSED] [FAILED] …）
quick cron pause|resume|run|rm <id>
```

其他选项：`--cwd DIR`（默认当前目录；指定了 `--machine`/`--requires` 时用选中机器的默认目录）、`--overlap skip|queue|parallel`、`--catch-up latest|skip`、`--paused`。简报里可以写 `{{date}}`、`{{time}}`、`{{datetime}}`、`{{n}}`（第几次运行），每次运行时替换；hub 还会在简报末尾附上计划 ID、触发时间和上一次运行的任务 ID。Web UI 的侧栏有「定时」视图：列出计划、规则、下次运行时间和最近几次的结果，可以暂停/恢复、立即运行、删除。

**规则与时区**（`shared/cron.ts`，零依赖）：

- 三选一：标准 5 段 cron（分 时 日 月 周，支持 `*` `,` `-` `/`、月份和星期的英文缩写、`@daily`/`@hourly` 等别名；日和周都受限时按标准 cron 取「或」）、固定间隔（`--every`，从创建时刻起算，不受 DST 影响）、一次性时间点（`--at` / `--in`）。
- 每个计划带时区，默认是 hub 所在机器的本地时区。DST 处理：不存在的时刻（春季拨快）在跳变后立即运行，例如 02:30 → 03:30；重复出现的时刻（秋季拨慢）只运行一次，取第一次；每小时都运行的计划按真实时间走，重复的那个小时也会运行。

**重叠与错过**：

- 重叠策略（上一次运行还在 starting/running/handoff 时到点）：`skip`（默认，记一条 [SKIPPED]）、`queue`（最多排队一次，上一次结束后马上运行）、`parallel`（照常再派一个）。
- 错过补跑：hub 停机期间错过的触发，默认（`latest`）在 hub 启动后补跑一次（只跑最近那一次，记录错过了几次）；`skip` 只记录 [MISSED]，等下一个时间点。hub 运行中短暂的延迟（90 秒内）不算错过。暂停期间的时间点不补跑；恢复后从当前时间算下一次。
- 计划会在派单 **之前** 先把这次运行写盘（`lastRunAt`/`nextRunAt`），所以 hub 在派单途中崩溃，最多丢这一次，不会重复派单。

**多机 mesh 下谁来触发**：每个计划只属于一个 hub，就是创建它的那台（`job.hub`）。只有这个 hub 保存权威副本，也只有它的定时器会触发，所以不需要选主，也不依赖各机器时钟一致，不会重复派单。其他 hub 通过 mesh 复制拿到只读副本（和任务一样按 rev 排序，删除用墓碑同步），任何 hub 上的 REST/CLI/工具调用都会被路由到所属 hub 执行。派出的任务可以跑在 mesh 里任何一台机器上（`--machine`/`--requires`/`--cwd` 在触发时才选机器）。所属 hub 离线期间它的计划不会触发，恢复后按补跑策略处理。想让计划在某台常开的机器上触发，就在那台机器的 pi/CLI 上创建，或者在 `POST /api/cron` 里传 `hub`。

团队模式下（见 `docs/team-collaboration.md`），计划记录创建者，每次运行都以他为 requester 派单；普通成员只能修改/删除自己的计划，owner 和机器 token 不受限。

数据存放在 `~/.quick-agent/cron.json`（原子写入），hub 重启后自动恢复。测试：`npm test` 覆盖解析器、下次运行时间（含时区和 DST）、重叠与补跑决策；`test/cron-e2e.sh` 用隔离的 hub（`/tmp/qa-cron`、端口 17795、tmux 会话 `qa-cronT`，worker 是 PATH 里的假 `pi`，不花模型费用）验证 `--in 5s` 派单、`--every 10s` 重叠跳过、静默归档、暂停后不再触发、hub 重启后恢复和补跑。

## 项目

多个项目的任务会自动整理到各自的「项目」下，不用手动归类。项目保存在 hub 的 `~/.quick-agent/projects.json`，在 mesh 里同步；每个任务记录自己的 `project`（没有 = 未归类）。

**自动归类**（创建任务时由执行它的机器判断，按优先级）：

1. 派单时显式指定的项目（`qa_dispatch` / `quick new --project` / API 的 `project`；名字不存在会新建）。
2. cwd 所在的 git 仓库：先按 remote（`git@github.com:o/r.git`、`https://github.com/o/r` 等都归一化成 `github.com/o/r`），所以不同机器、不同目录的同一个仓库属于同一个项目；没有 remote 时按主工作树目录。git worktree 会认回主仓库（如 `~/qa-wt/*` 认回 `~/quick-agent`）。第一次见到的仓库自动建一个以主目录名命名的项目。
3. 路径规则（前缀，最长匹配），以及各机器上已知的项目目录；对还没升级的旧 hub 发来的任务，再按目录名猜（`/Users/me/quick-agent`、`~/quick-agent-t2d42` → quick-agent）。
4. 浏览器评论的页面 URL（子串、host 或 `/正则/`）。
5. 标题和简报的轻量文本匹配：项目名 / id / 关键词在标题里出现一次，或在简报里出现三次以上；两个项目打平就不猜。

都不命中就归到「未归类」。归类时会顺带学习识别规则：git remote、本机的仓库目录、页面的 host（GitHub 之类的公共站点记到 `owner/repo`）。quick-agent 自己的仓库会预置 Web UI 地址（`127.0.0.1:<uiPort>`）。`config.json` 里旧的 `projects`（URL → 工作目录）会合并进对应项目：URL 成为页面规则，`cwd` 成为该机器上的项目目录。

**存量任务**：hub 启动时自动给没归过类的任务归类（只改 `project`，不改更新时间和排序）；`quick projects backfill --all` 重新归类所有不是手动设置的任务。新建项目（包括派单时显式指定的新项目、第一次见到的仓库）、改规则、合并之后，以及 hub 每次启动时，按文本 / 路径 / URL 弱匹配（或未归类）的任务会自动重新判断。

**手动调整会被记住**：手动改过项目的任务（Web UI 任务详情里的「项目」下拉框，或 `quick projects move`）不会再被自动归类覆盖。手动移动也会让目标项目学到这个任务的页面 host（以及还没有归属的 git 仓库），同一页面的其他任务随之归过去；已经属于别的项目的仓库不会被抢走。合并后旧 id 作为别名保留，之后命中旧项目的任务也会进到新项目里。

```bash
quick projects                             # 列表：需要你 / 运行 / 总数，以及 git、目录、页面、关键词规则
quick ls --project quick-agent             # 只看一个项目（none = 未归类）；quick attention 每级内按项目分组
quick projects move t35a9 tokenjoy         # 手动改任务的项目（不存在就新建；none = 未归类）
quick projects rename relay-website 官网    # 改名（id 不变）
quick projects merge tokenjoy relay-website  # 合并：规则和任务都并过去
quick projects create 文档 --path ~/docs --url docs.example.com --keyword 文档
quick projects rule quick-agent add keyword "pi TUI"   # add|rm url|path|remote|keyword
quick projects order tokenjoy quick-agent   # 项目列表的顺序（Web UI 里拖动项目标题也可以；跨设备同步）
quick new --project relay-website "标题" "简报"          # 不传 --cwd 时用该项目在选中机器上的目录
```

**界面**：Web UI（Electron 客户端用同一套页面）的任务列表顶部有「注意力 | 项目」视图切换，默认「项目」，记住上次的选择。

- **项目视图**：每个项目一块，块标题显示项目名和计数（需要你 n / 运行中 n / 待扫 n / 稍后 n），只有一个项目时也显示。列表是**稳定的**：项目按固定顺序排列（默认按项目创建时间，拖动项目标题或在标题上按 Alt+↑/↓ 调整；顺序存在 hub 的项目里，刷新和其他设备上都一样；`quick projects order` 也可以改），「未归类」永远最后；块内任务按创建时间排列（新的在上），活动、进度、状态变化都不移动卡片，只改卡片上的标记（[ASK]、[RUN]、[DONE] …）和计数，确认过的任务离开列表，其余任务顺序不变。卡片高度固定，当前活动单行省略；SSE 更新时就地更新变化的卡片，滚动位置、焦点、折叠状态不变；相对时间每分钟刷新一次。点块标题折叠这个项目，折叠后它的「需要你」任务仍然显示，其余显示为「已折叠 n 件」；列表上方可以全部折叠 / 展开，折叠状态刷新后保留。点「已归档」或搜索时，已归档的任务排在各项目块的最后。
- **注意力视图**：队列按 需要你 / 待扫 / 稍后 / 不用管 分级，每一级里再按项目分小组（项目顺序同上；只有一个项目也显示小标题），同一级里按创建时间排列。队列上方的项目条显示每个项目「需要你」和运行中的数量，点一下只看这个项目。点项目小标题可以折叠这个项目，折叠后它在「需要你」里的任务仍然显示。
- 不论哪个视图，「需要你」的总数都在顶栏，点它跳到并高亮下一件需要你的任务（再点跳到下一件），而不是靠移动卡片来提示。项目标题右侧的「...」可以重命名或合并项目；任务详情里的「项目」下拉框可以手动改项目。前台的 `qa_tasks` 也按「级别 · 项目」分组输出并给出每个项目的计数，系统提示里的项目列表从 hub 获取（hub 不可用时退回 config.json 的映射）。

只传 `project` 不传 `cwd` 派单时，hub 优先选有这个项目目录的机器（在满足 `requires` 的机器里按优先级），并用那台机器上的项目目录。项目可以带 `members`（团队成员）和 `notes`，定时任务等其他入口创建任务时也可以传 `project`。

## Web UI（注意力队列 + 前台 agent）

```bash
quick ui                      # 启动（已在运行则直接复用）并在浏览器打开；前台工作目录 = 当前目录
quick ui --cwd ~/proj         # 指定前台工作目录；--no-open 只打印地址
quick ui status | url | logs | stop | restart
```

`quick ui` 会先确保 hub 在运行，再拉起一个常驻的 Web UI 进程（`ui/server.ts`，日志 `~/.quick-agent/ui.log`），然后打开 `http://127.0.0.1:7790/?token=…`。

- **注意力队列（首屏）**：左侧就是注意力队列，「需要你」排最前，每一级里按项目分组（见「项目」），按任务展示：标记、原因、等了多久，worker 的问题和可选答案（点一下就把答案发给 worker），以及回答/稍后/知道了/接管等动作；「待扫」一键「知道了」；「稍后」「不用管」「已归档」依次在后。顶栏的「需要你 N」和桌面客户端托盘角标、`quick attention` 是同一个数字；「专注」按钮开关专注模式。任务卡片上显示进度（「3/6 发布 Release」+ 细进度条）。点开任务可以看进度（步骤清单 + 人话状态）、最新汇报、工作记录、简报，在底部常驻的输入框里回答或追加指令（见「进度与工作记录」）。
- **前台 agent**：右侧是一个持续的前台，交代新的事、问"有什么需要我的"都在这里。回复流式显示，工具调用显示为卡片，派单卡片带任务 ID 和实时状态，点击任务 ID 打开详情。回复过程中继续发消息会排到本轮之后（Alt+Enter 插入当前轮），可以随时「停止」。支持粘贴图片，`/tasks`、`/qa on|off` 等扩展命令照常可用。顶栏可以切换模型和思考级别。
- **只有一个前台**：没有会话列表，没有新建/切换/重命名；刷新页面或重启 `quick ui` 都接着同一段对话，上下文由自动压缩控制长度。（内部实现：前台通过 pi SDK 托管在 Web UI 进程里，加载同一个 quick-agent 扩展，对话持久化成 `~/.quick-agent/ui-sessions/` 下的 pi 会话文件；这是实现细节，不对人展示。调试时可用隐藏参数 `quick ui restart --fresh-front` 从空对话开始。）
- **汇报与评论**：worker 的汇报按注意力进入前台对话（见「汇报怎么送到前台」）。浏览器插件发来的评论会以「浏览器评论」卡片进入对话（附截图），由前台处理。评论是一次性的，Web UI 不单独列出评论：前台处理后它就变成一个新任务或已有任务的追加指令；来源是浏览器的任务，详情里显示来源页面和截图。
- **安全**：只监听 `127.0.0.1`（端口用 config 的 `uiPort` 或环境变量 `QA_UI_PORT` 设置，默认 7790）。访问需要 hub token：`?token=` 只用一次，换成 HttpOnly、SameSite=Strict 的 cookie 后，就会从地址栏移除。服务端还会拒绝非 localhost 的 Host 头（防 DNS rebinding）和跨源写请求。浏览器对 hub 的调用都由 Web UI 进程代理，token 不会暴露给页面脚本。
- 深色和浅色跟随系统，也可以用右上角 ◐ 手动切换；窄屏时顶栏有「注意力 | 对话」切换，注意力队列始终在前/左。界面样式来自 `shared/tokens.css`（Web UI、登录页和浏览器插件共用同一份设计 token）。
- **快捷键**（Mac 显示 ⌘，其他系统是 Ctrl；顶栏 `?` 按钮或按 `?` 查看）：
  | 操作 | 快捷键 |
  |---|---|
  | 聚焦输入框；在输入框里再按一次跳到任务搜索 | `⌘K` / `Ctrl+K` |
  | 切到注意力队列 / 定时 | `⌘1` / `⌘2`（`Ctrl+1` / `Ctrl+2`） |
  | 发送 / 换行（两种模式，输入框右下角按钮或快捷键面板里切换，存在 localStorage） | 默认 `Enter` 发送、`Shift+Enter` 换行；另一种是 `⌘/Ctrl+Enter` 发送、`Enter` 换行 |
  | 回复中插入当前轮（steer） | `Alt` + 发送键 |
  | 停止回复（输入框为空时）；关闭任务详情、大图、清空搜索 | `Esc` |
  | 队列上下移动 / 打开 | `↑` `↓` / `Enter` |
  | 聚焦输入框 / 显示快捷键 | `/` / `?` |
- 注意：Web UI 和终端里的 pi 都是前台。浏览器评论由先认领的那个处理，认领即消费，不会再投递给其他前台；汇报会送到所有在线前台，只有一个主动开口。

## 桌面客户端（Electron，macOS）

`electron/` 里是 quick-agent 的桌面客户端：把 Web UI 装进原生窗口，按注意力组织。它不自己判断任务状态，直接使用 hub 的注意力模型：托盘和 Dock 角标就是 hub 的「需要你」数量；hub 判定要立即打扰（`interrupt: "now"`）时发系统通知，点通知直达那个任务；hub 推送的待扫摘要显示为一条汇总通知；专注模式和摘要间隔读写 hub 的设置；全局快捷键 `⌘⇧Space` 随时"把一件事交出去"。客户端会复用或拉起 hub 和 Web UI 服务，关掉窗口或退出客户端，worker 都照常工作。

```bash
cd electron && npm install && npm run dev     # 本地运行
npm run dist                                   # 打包 .app / .dmg（ad-hoc 签名，正式签名和公证见 electron/README.md）
```

详见 [electron/README.md](electron/README.md)。设计依据见 [docs/management-philosophy.md](docs/management-philosophy.md) 和 [docs/attention.md](docs/attention.md)。

## 多机互联（mesh）

quick-agent 自带原生的多机互联，不依赖 codexhost。每台机器跑一个 hub，hub 之间组成网状网络：

- **随处派单**：前台的 `qa_dispatch` 可以带上 `machine`，任务和 worker 就跑在那台机器上；不带时按资源和优先级自动选机器（见下文「机器资源与调度」）。附件（截图等）会随请求一起传过去，简报里的路径也会自动改写。
- **全局视图**：每个 hub 都能看到全网的任务。`quick ls`、面板、前台的任务组件都会标出 `@机器`。
- **统一控制**：追加指令、中止、关闭、已读、实时终端（`/peek`、面板）都会自动路由到任务所在的机器。
- **远程只读浏览**：前台用 `qa_remote_fs`（ls/read/grep）在派单前查看别的机器上的代码。
- **评论跨机流转**：任何机器上的浏览器评论，都能被任何一台机器上的前台认领，截图会自动拉到认领方本地。

### 组网

```bash
# 机器 A（例如你的笔记本或主力服务器）
quick mesh init --id laptop --desc "MacBook，前端项目在 ~/code"

# 方式一：A 能 ssh 到 B（B 上已经装好 quick-agent）。一条命令完成：
quick mesh add simon@server-b            # 会在 B 上设置密钥、启动 hub，A 自动维护 ssh 隧道

# 方式二：邀请码
quick mesh invite                        # 在 A 上运行，打印加入命令
quick mesh join <code> --ssh simon@A     # 在 B 上运行（B 能 ssh 到 A）
quick mesh join <code> --url http://A:7788   # 或者 A 的端口可以直接访问

quick machines                           # 查看机器、资源、优先级、路由、链路状态
```

### 机器资源与调度

每台机器在**自己的** `~/.quick-agent/config.json` 里声明资源标签和优先级，hub 会把它们随 mesh 公布出去：

```jsonc
"machine": {
  "id": "mac-laptop",
  "description": "人类本人的 Mac",
  "resources": ["browser:chrome-gui", "codex", "-docker"],  // 与自动探测结果合并："x" 添加，"-x" 去掉探测到的 x，"-*" 清空探测结果
  "resourceNotes": "可以操作人类的 Chrome；本地文件在 /Users/tianyu",
  "priority": 50                                              // 越小越优先；不写为 100
}
```

- **自动探测**（`shared/schedule.ts` 的 `detectResources`）：系统（`linux` / `macos` / `windows`）、`gui`（macOS/Windows，或有 `DISPLAY`/`WAYLAND_DISPLAY`）、`browser:chrome-gui` / `browser:chrome-headless` / `browser:safari-gui`、已安装的 `codex`、`claude`、`docker`、`gh`，以及 `gpu`（`nvidia-smi -L` 能运行）。还没升级的旧 hub 不公布资源，按它的平台推断（`darwin` → `macos, gui`）。
- **匹配**：需要 `browser` 时，`browser:chrome-gui` 也算满足；需要 `browser:chrome`，`browser:chrome-gui` 同样满足（按 `:` / `-` 前缀匹配）。
- **选机器**（`POST /api/tasks`、`qa_dispatch`、`quick new`）：
  1. 传了 `machine`：只用这台；离线或缺资源时直接报错，并列出它有哪些资源。
  2. 没传 `machine`、没传 `cwd`，但页面 URL 命中某台机器的 `projects`：用那台机器（满足 `requires` 的前提下）。
  3. 其他情况：在满足全部 `requires` 的在线机器里，按 优先级 → 本机 → 运行中任务更少 → id 排序选第一台。
  4. 传了 `cwd` 但没传 `machine`：按上面的顺序找第一台**存在这个路径**的机器（远程机器用 `fs.ls` 探测）。路径不会被搬到别的机器上用；没传 `cwd` 时用选中机器自己的 `projects` / `defaultCwd`。
  5. 没有机器满足时返回 400，说明缺什么、哪些离线机器本来满足。
- 前台系统提示和 `qa_machines` 会列出每台机器的资源、优先级和「默认首选」，并要求：需要人类本机的 GUI、浏览器或本地文件时必须派到那台机器；拿不准先问人类。

```bash
quick machine                                  # 本机：生效的资源、优先级、配置值和探测值
quick machine show mac-laptop                  # 其他机器
quick machine set --priority 10                # 设置本机优先级（none 清除）
quick machine set --add gpu --remove docker --notes "A100 x1"
quick machine set --machine mac-laptop --priority 50 --add browser:chrome-gui   # 经 mesh 改另一台（写入它自己的 config.json）
quick machine detect                           # 只看自动探测结果
quick new --requires browser:chrome-gui "标题" "简报"   # 按资源派单
```

`quick machine set` 通过 hub 修改并立即重新公布，不需要重启 hub；hub 没运行时直接写本机配置文件。

### 原理（`hub/mesh.ts`）

| 方面 | 做法 |
|---|---|
| 链路 | 由一方主动往外拨：`GET /mesh/link`（SSE，对端 → 我）加 `POST /mesh/send`（我 → 对端）。只需要一个方向能连通，处在 NAT 后面的笔记本也能加入。链路建立后是双向的。 |
| SSH | peer 写成 `{"ssh": "user@host"}` 时，hub 会自己拉起并维护 `ssh -N -L <空闲端口>:127.0.0.1:<对端 hub 端口>`（BatchMode、断线重连），还会顺带尝试在远端执行 `quick hub start`。 |
| 鉴权 | 全网共享一个 mesh secret（`Authorization: Mesh <secret>`，用 timingSafeEqual 比较），和本地 API token 分开。 |
| 路由 | 距离向量加水平分割，最多 8 跳。比如 A→B←C 的拓扑里，A 会经 B 访问 C；存在直连时优先直连，某条路断了会自动绕行。 |
| 复制 | 任务和评论各有一台归属机器，每次更新带递增的 `rev`，并广播给全网；任务每交接一次 `epoch` 加一，副本按 `(epoch, rev)` 比新旧。收到的版本只有比本地新才会应用并继续转发，所以广播一定会结束。新链路建立时会互发一份快照。 |
| RPC | 请求按目标机器 ID 一跳一跳转发，响应沿路由表返回，超时 30 秒。远程方法包括 `task.create/get/message/cancel/close/ack/screen/handoff`、`handoff.probe/begin/chunk/apply/start/abort`、`intake.claim/update`、`fs.ls/read/grep`。 |

安全提示：mesh secret 相当于能在全网所有机器上执行 worker（也就是任意代码），请妥善保管。hub 默认只监听 `127.0.0.1`，跨机连接推荐走 ssh 隧道；如果要把 `host` 设成 `0.0.0.0` 直连，一定要配好防火墙或者用 Tailscale 这类内网。

### 本地电脑 + 浏览器的推荐用法

在本地电脑上也装一份 quick-agent，然后运行 `quick mesh join … --ssh <服务器>` 或 `quick mesh add <服务器>`，这样浏览器插件直接连本机的 `http://127.0.0.1:7788`，不用再手动开 ssh 端口转发。评论会进到 mesh，由服务器上的前台认领，再派给对应机器上的 worker。

## 任务跨机器交接（handoff）

已有任务可以随时迁移到 mesh 里另一台在线机器继续执行，也可以来回反复迁移。任务 id 不变，worker 在目标机器上带着完整上下文继续，注意力状态（需要你/待扫/稍后）跟着任务走。

> 下文讲交接的内部实现。这里的「会话」指 worker 的 pi 会话文件（`*.jsonl`，worker 的完整上下文），是内部细节，不出现在面向人的界面里。

```bash
quick handoff <id> <机器> [--cwd 目标目录] [--no-workspace] [--abort] [--wait 秒] [--on-conflict fail|stash|backup] [--no-follow]
```

- 前台 agent：直接说"把 t1234 挪到 cloud 上继续"，前台会调用 `qa_handoff` 工具。
- 面板：任务详情里点「交接到其他机器…」。
- API：`POST /api/tasks/:id/handoff {to, cwd?, noWorkspace?, abort?, waitSec?, onConflict?}`。这个调用是异步的，任务状态先变成 `handoff`，进度显示在 activity 里，结果记录在事件里。`quick handoff` 默认会一直跟踪到结束。

### 保证哪些东西不丢

| 内容 | 做法 | 校验 |
|---|---|---|
| 会话 | worker 的 pi 会话 jsonl 整份传过去，放进目标机器的 `<agentDir>/sessions/--<目标 cwd 编码>--/`，文件名不变。只改写第一行 header 的 `cwd`，否则 pi 打开会话时会因为原 cwd 不存在而停下来；其余每一行逐字节保留。 | 传输用 sha256 校验；写入后再读回来，比对除 header 以外的全部字节 |
| 任务元数据 | 保留 id、标题、brief、summary、来源（含 intake_id）、owner、`events.jsonl` 全部事件、附件（附件路径和 brief 里的引用会改写成目标机器上的路径）。只更新 `machine/cwd/tmuxTarget/sessionFile`。`handoffs[]` 记录每一次 from/to/cwd/时间，事件里也会写 `handoff` 记录。 | 每个文件都做 sha256 校验 |
| 工作区：git | cwd 在 git 仓库里时：只有目标缺少的那部分提交才打进 `git bundle`（目标已有该提交就不传）；另外传分支名、`git diff --cached`（已暂存）、`git diff`（未暂存）、untracked 且未被忽略的文件（tar 打包，保留权限和符号链接）。目标上会切到同名分支，依次 `git apply --index`、`git apply`，再解出 untracked 文件。 | 两边都算一份 manifest：每个文件的 sha256 和可执行位、符号链接、HEAD、分支、`git write-tree`（index）。必须完全一致 |
| 工作区：非 git | 把整个 cwd 打成 tar（排除 `node_modules .venv venv __pycache__ .cache .next …`，嵌套的 `.git` 会一起带上），默认上限 200 MB | 同样比对 manifest |

目标目录按以下顺序确定：`--cwd` 指定的目录 → 这个任务以前在目标机器上用过的目录（交接回去时自动用原来的目录）→ 项目映射（两台机器的 `projects` 里 `match` 相同的规则，例如 `{match:"myapp", cwd:"/Users/me/myapp", machine:"laptop"}` 和 `{match:"myapp", cwd:"/home/me/myapp", machine:"cloud"}`）→ 家目录相对路径（`/Users/me/x` 映射为 `/home/me/x`）→ 相同路径。如果 cwd 是仓库的子目录，会映射到目标仓库里的同一个子目录。

### 过程与安全

1. **安全点**：worker 正在运行时，默认等它这一轮结束（最多 `--wait` 秒，默认 600 秒，可以在 `config.json` 的 `handoff.waitSeconds` 里改），超时就失败、什么都不改。加 `--abort` 会像 `quick cancel` 一样立即中止当前这一轮，正在执行的工具调用会被打断，等会话文件写稳后再打包；到了目标机器，worker 会收到一条说明，提示它上一个工具调用可能没有完成。交接过程中，worker 的状态汇报只会被记下来，任务状态保持 `handoff`。
2. **先做冲突检查**：在停 worker 之前，先问一次目标机器，目录明显冲突时直接失败，不会白白打断 worker。
3. 打包 → 通过 mesh RPC 分块传输（4 MB 一块，可以多跳转发，不需要额外的 ssh/rsync）→ 目标机器校验 sha256，应用工作区，比对 manifest，放置会话 → 在目标机器上登记任务（`epoch+1`）并拉起 worker → **之后**才关闭源机器的窗口。
4. **回滚**：第 3 步中任何一环失败（包括目标端校验失败、目标机器拉起 worker 失败、传输中断），目标机器都会撤销自己做过的改动：删掉新建的目录或恢复备份，`reset`/`clean` 后切回原分支并 `stash pop`，恢复原来的会话文件和任务目录。源任务恢复交接前的状态，源窗口一直没动过，可以继续用。如果交接时用了 `--abort`，会自动发一条消息让 worker 在本机继续。
5. 交接期间发给这个任务的追加指令会先排队，交接完成后转给新机器上的 worker；失败的话就在本机投递。交接期间不能执行中止或关闭（返回 409）。
6. worker 在目标机器上怎么启动：交接前正在运行，就带着一条交接说明恢复会话，让它接着做；交接前已经停下（done、idle、needs_input 等），就只恢复会话、不触发新一轮，交接说明会附在下一条追加指令的前面；交接前窗口已经关闭，就不拉起 worker，下次 `quick send` 时再恢复会话。

### 目标目录冲突：不会静默覆盖

目标目录满足以下任一条件时，交接会直接失败，并给出可选的处理方式：

- 有未提交的改动或 untracked 文件；
- 不是同一个仓库；
- 非 git 模式下目录非空；
- 同名分支和源分支已经分叉；
- 被目标机器上正在运行的任务占用。

可选的处理方式：

- `--on-conflict stash`：把目标仓库里原有的改动 `git stash -u` 保存起来，stash 名为 "quick-agent handoff <id>"。如果分支已经分叉，旧提交会保存在 `refs/quick-agent/backup/` 下。
- `--on-conflict backup`：把整个目录挪到 `<目录>.qa-handoff-bak-<时间>`。
- `--cwd`：换一个目录。

例外是交接回去的情况。源机器在任务离开时会在 `~/.quick-agent/handoff/departed.json` 里记下离开时工作区和会话的 manifest 摘要。之后任务交接回来，如果那份旧状态没有被动过，说明它的内容已经包含在传回来的状态里，可以安全替换，这时会自动 stash 或挪开，成功后丢弃。所以 A→B→A 的来回迁移不需要任何选项。

### 已知限制

- 源机器和目标机器必须同时在线：交接由源机器的 hub 编排，源机器离线时无法交接，这时只能在目标机器上新建任务。
- 被 `.gitignore` 忽略的文件不同步（`node_modules`、`.env`、构建产物等），会话说明里会提醒 worker 重新确认环境。另外这些内容也不迁移：stash、其他分支、未推送的其他本地分支、git 配置和 hooks、子模块内容、正在进行中的 merge/rebase（这种情况会直接拒绝交接）。目标仓库是新建的话，只包含当前分支的历史，`origin` 设为源仓库的 origin URL。
- 会话历史逐字保留，不会改写历史里出现的绝对路径。worker 收到的交接说明里会写明路径映射（`源 cwd → 目标 cwd`）。
- 运行中的进程、端口、终端里的状态都不会迁移。用 `--abort` 中止时，正在执行的工具调用会被打断，到了目标机器，由 worker 自己检查后继续。
- 传输走 mesh RPC，适合几百 MB 以内的数据。工作区大小上限在 `config.json` 的 `handoff.maxWorkspaceMB` 里设置（默认 200），排除列表是 `handoff.exclude`。
- 如果目标机器的 hub 在"应用之后、启动之前"崩溃，源机器会回滚，但目标机器上已经应用的工作区改动无法自动撤销（暂存目录会在重启时清掉）。源机器的 hub 在交接中途重启时，任务会恢复为交接前的状态并留在源机器。如果交接其实已经在目标机器完成，源机器收到更高 epoch 的副本后，会自动让出任务并关闭本地窗口。
- 两台机器上的 pi 都要能用同一个 worker 模型。会话放在 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）下。

### 测试

`test/handoff-e2e.sh` 会在 `/tmp/qa-ho` 下起两个互相隔离的 hub：`ma` 用端口 17791、tmux 会话 `qa-hoA`，`mb` 用端口 17792、tmux 会话 `qa-hoB`，各自有独立的 `QA_HOME` 和 `PI_CODING_AGENT_DIR`。脚本用便宜的模型跑真实的 worker，依次验证：

- A→B 交接，带已暂存、未暂存、删除、untracked、符号链接等改动；
- 会话逐字节一致，恢复后的 worker 记得之前的暗号；
- B→A 交接回去；
- 目标端校验失败时回滚，任务仍然可用。

`test/handoff-env.sh up|restart|down` 可以单独搭建这套环境，用 `source test/handoff-env.sh vars` 之后就能用 `A quick …`、`B quick …`。

## 团队协作

几个人加几台机器上的 agent，共用一个工作区（一个 mesh 就是一个团队）。设计和取舍见 [`docs/team-collaboration.md`](docs/team-collaboration.md)。原则不变：**每个人只看到需要自己的事**，没有信息流，没有会话。

**成员和身份**

```bash
quick team init simon --name Simon      # 第一位 owner；本机归 simon 所有，本机 token 即代表 simon
quick team invite                       # 一次性邀请码（默认 member，7 天过期）
# 队友在自己电脑上（hub 地址要能访问到，例如 ssh -L 转发）：
quick team join http://127.0.0.1:7788 <邀请码> alice --name Alice
#   个人 token 保存到 config.json 的 client 段；之后 pi 前台、quick、quick ui 都以 alice 的身份连这个 hub
quick team                              # 成员、角色、各自的机器，以及你是谁
quick team add bob --name Bob           # owner 直接加人（打印给对方的 quick team connect 命令）
quick team role bob owner | quick team remove bob | quick team token --reset | quick team leave
quick machine set --owner alice         # 自己也在 mesh 里跑 hub 的成员：把机器标给自己，机器 token 即代表她
```

- 角色只有 `owner` 和 `member`。日常协作（派单、评论、转交、请人验收）对所有成员开放；邀请、改角色、移除成员、配置机器、全网升级需要 owner。最后一名 owner 不能被降级或移除。
- user token（`qau_…`）只在创建时显示一次，hub 只存哈希。名册经 mesh 复制，所以成员的 token 在团队里任何一台 hub 上都有效。
- 没有建团队时，一切和单人版一样（机器 token = 你）。

**任务上的人**

| | 含义 |
|---|---|
| 发起人 requester | 派单的人（由 token 决定，不能冒充别人） |
| 负责人 assignee | 默认是任务的 agent worker；可以转给一个人，worker 的提问和汇报就交给他 |
| 验收人 reviewer | 被请来验收、拍板的人：worker 交回时进他的「需要你」，不进发起人的 |
| 关注者 watchers | 只在团队视图里看，永不打扰；评论过的人自动关注 |

```bash
quick new --reviewer alice "登录页修复" "…"      # 派单时就定好验收人（也有 --assignee、--watch a,b）
quick assign t1a2b --reviewer alice              # 让 Alice 验收 / 拍板
quick assign t1a2b --to bob                      # 转给 Bob 负责；--to agent 交回 worker
quick comment t1a2b "@alice 接口要兼容旧版吗？"   # @id 点名（进她的「需要你」），@all 全体，@worker 转给 worker
quick comment t1a2b                               # 看评论
quick ls                                         # 你自己的注意力队列
quick team board                                 # 团队视图：所有进行中的事，按「球在谁手里」分组
```

- **球在谁手里**：worker 在做时谁都不用管；交回时，完成的给验收人（没有就给负责人、发起人），提问和受阻给负责人（没有就给验收人、发起人）。
- **确认按人算**：只有球在自己手里的人点「知道了」才算数；验收人对完成的任务点「知道了」= 验收通过，发起人收到一条安静的「待扫」（`[VERDICT]`）。别人点「知道了」只清掉自己的点名。
- **@提及**：被 @ 的人这件事进「需要你」（`[@]`），回复、评论或「知道了」后清除；自己的操作不会打扰自己。不带 @ 的评论只是留言，不打扰任何人，也不打扰 worker。worker 也能用 `qa_comment` 在任务下 @人。
- **按人的注意力**：`/api/attention` 和 SSE 的 `attention` 事件按 token 的身份逐人计算（打断判定也按人）；Web UI、Electron、pi 前台只显示自己的队列。`?scope=team` 是团队视图，`?user=<id>` 供 owner 排查。

**前台和 Web UI**：前台知道团队名册和机器所有者，能理解「让 Alice 验收」「转给 Bob」「交给 Bob 的机器做」「问问 Carol」（工具 `qa_task_assign`、`qa_comment`、`qa_team`，`qa_dispatch` 的 `reviewer/assignee/watchers`，`qa_tasks scope=team`）。Web UI 顶栏显示你是谁，「团队」按钮打开团队视图；Electron 连团队 hub 时也用个人 token，托盘只数你的「需要你」。任务详情里有「人」（可改负责人、验收人、关注）和评论区。

## 浏览器插件（在本地电脑上用）

1. 在本地电脑上开端口转发，保持开启：`ssh -N -L 7788:127.0.0.1:7788 <user>@<server>`（完整命令和 token 可以在服务器上运行 `quick tunnel` 查看）。
2. 下载插件：<http://127.0.0.1:7788/extension.zip>，解压。
3. 打开 `chrome://extensions`，开启开发者模式，点「加载已解压的扩展程序」，选择解压后的目录。
4. 点插件图标，填 Hub 地址 `http://127.0.0.1:7788` 和 Token（服务器上运行 `quick token` 获取），然后点「保存并测试」。

使用方法：按快捷键 **Mac `⌘⇧E`（Command+Shift+E）/ Windows·Linux `Ctrl+Shift+E`**，或点插件图标里的「在当前页面框选评论」。`⌘⇧Y` / `Ctrl+Shift+Y` 打开插件弹窗。快捷键可以在 `chrome://extensions/shortcuts` 修改（弹窗里会显示当前生效的快捷键；从旧版本升级的用户可能仍是旧快捷键 `Alt+Shift+C`，需要在那里手动改）。

- **点击 = 选元素，拖动 = 框选区域**，不用切换模式：鼠标悬停会高亮元素，按下后基本不动就松开（位移 < 5px）就选中鼠标下的元素；按住 Shift 点击可以多选，选好后按 Enter 写评论。按下后拖动超过 5px 就画出矩形，松开后附上区域坐标和区域里的元素。拖动时不会选中页面文字，也不会触发页面的拖拽。工具条在页面底部居中。
- **Esc** 一层层退出：先取消正在拖的矩形，再清掉选择或关掉评论框，最后退出框选。
- **发送键**：评论框默认 `Enter` 发送、`Shift+Enter` 换行；可以在弹窗里（或评论框里的「切换」）改成 `⌘/Ctrl+Enter` 发送、`Enter` 换行，设置存在 `chrome.storage`。
- **弹窗快捷键**：`E` 开始框选，`D` 打开任务面板，`,` 展开连接设置，`M` 切换发送键。
- **草稿跟着页面走**：框选到一半或评论写到一半时离开页面（普通跳转、SPA 换路由、hash 路由变化、后退），选择和评论框会立刻淡出，草稿按页面存起来（最多 30 个页面，保存 24 小时）；回到该页面会自动恢复选择和草稿，元素找不到时会提示。各页面的草稿互不影响，发送或取消后清除。
- 插件界面（工具条、高亮、评论框、提示）都在 closed shadow DOM 里，不受网页样式影响，也不会污染网页；配色和 Web UI 一样跟随系统深浅色。
- 写完评论后发送。插件会附带以下内容：URL、选择器和 XPath、outerHTML 片段、可见文本、视口截图（选区用红框标出）、选区裁剪图、页面控制台错误。
- 评论会先交给 **前台 agent**。前台根据项目映射确定工作目录，快速定位源码后派单（`qa_dispatch`）；如果评论属于某个已有任务，就追加给对应的 worker（`qa_task_send`）。两种方式都带上 `intake_id`，评论和截图会关联到任务上（截图复制进任务的 `attachments/`）。
- **评论是一次性的**：发送成功后，选中框、框选区域和评论框立刻消失，页面上不留任何标记，刷新或以后再访问也不会出现。发送失败时评论框、选择和文字都保留，修好连接后再发送即可。之后的进展在 Web UI 的注意力队列里看（任务详情里有来源页面和截图）。
- 评论投递给前台并被认领就算消费掉了：hub 不会再投递第二次（hub 重启后也不会）。已消费的评论在 `~/.quick-agent/intake/<id>/` 里只保留一段时间方便排错，默认 72 小时，之后自动清理（config 的 `intakeRetentionHours` 或环境变量 `QA_INTAKE_RETENTION_HOURS`）；任务用到的截图已经复制到任务目录，不受影响。
- 插件代码更新后，需要在 `chrome://extensions` 里点一下重新加载。
- **权限**：默认只在你按快捷键/点按钮后才访问当前标签页（`activeTab`），所以控制台错误从你第一次在该页面启动框选后才开始记录，未发送的草稿也要到那时才恢复。想从页面加载起记录错误、自动恢复草稿，可在弹窗「连接设置」里勾选「在所有网站自动恢复…」（会额外申请"所有网站"权限，可随时关掉）。
- hub 没启动、Token 不对时，弹窗会给出明确提示；用快捷键在不能运行的页面（如 `chrome://`、扩展商店）触发时，工具栏图标会显示红色 `!`，悬停可看原因。

### 上架 Chrome Web Store / Edge / Firefox

材料都在 [`docs/browser-extension/`](docs/browser-extension/)：[`STORE.md`](docs/browser-extension/STORE.md)（可行性评估、商店文案、权限 justification、隐私表单填写、测试说明、图片尺寸清单）和 [`PRIVACY.md`](docs/browser-extension/PRIVACY.md)（隐私政策）。

打包：`scripts/pack-extension.sh` → `dist/quick-agent-extension-<版本>-chrome.zip`（Chrome / Edge 共用）和 `…-firefox.zip`。脚本只打包运行所需文件，并会检查 manifest 合法性、`<all_urls>`、`eval`/远程脚本等会被拒审的写法。每次提交新版本前先改 `browser/manifest.json` 的 `version`。

**以下步骤必须由你本人手动完成**（涉及付费、身份与账号，agent 不会代做）：

1. [ ] 确认仓库 `concept-less/quick` 公开（隐私政策 URL 与 `homepage_url` 指向它）；否则把 PRIVACY.md 放到 GitHub Pages / Gist 等公开地址，并同步修改 manifest 的 `homepage_url` 和 STORE.md 里的链接。
2. [ ] 注册 Chrome Web Store 开发者账号：<https://chrome.google.com/webstore/devconsole>，支付一次性 **US$5** 注册费，完成邮箱验证（发布者需开启两步验证）。
3. [ ] 准备图片：至少 1 张 1280×800 截图、1 张 440×280 小宣传图（清单见 STORE.md §5）。
4. [ ] 运行 `scripts/pack-extension.sh`，在开发者后台「New item」上传 `dist/…-chrome.zip`。
5. [ ] 填写 Store listing（文案复制 STORE.md §2，类别 Developer Tools，语言中文/英文）。
6. [ ] 填写 Privacy 标签：单一用途、各权限 justification、数据使用勾选、隐私政策 URL（STORE.md §3）。
7. [ ] 在 Test instructions 里粘贴 STORE.md §4（审核员需要 hub 才能测功能）。
8. [ ] Distribution 选 Public 或 Unlisted（只给自己/团队用建议 Unlisted），提交审核；通常几天内出结果，被拒时按邮件里的条款修改后重新提交。
9. [ ] （可选）Edge：在 <https://partner.microsoft.com/dashboard/microsoftedge> 免费注册，上传同一个 chrome zip，补一张 300×300 logo。
10. [ ] （可选）Firefox：先在 `about:debugging` 临时载入 `…-firefox.zip` 自测，再到 <https://addons.mozilla.org/developers/> 免费提交。

## 配置 `~/.quick-agent/config.json`

```jsonc
{
  "host": "127.0.0.1",
  "port": 7788,
  "uiPort": 7790,                         // Web UI（quick ui），只监听 127.0.0.1
  "token": "…自动生成…",
  "model": "tokenjoy/claude-opus-5-5",   // 前台和 worker 共用；也可以用 frontModel / workerModel 分开设置
  // "workerModel": "tokenjoy/gpt-6.1-sol",   // worker 默认模型；Web UI 顶栏「WORKER」按钮可按机器设置（见下）
  "tmuxSession": "qa",
  "machine": { "id": "cloud", "description": "主力服务器，项目在 ~/work", "priority": 10, "resources": ["claude"], "resourceNotes": "无 GUI，网络稳定" },   // 见「机器资源与调度」
  //   machine.owner: 团队成员 id，机器 token 即代表他（见「团队协作」）
  // "client": { "hub": "http://127.0.0.1:7788", "token": "qau_…", "user": "alice" },   // quick team join 写入：用别人的 hub（worker 不受影响）
  "mesh": { "secret": "…quick mesh init 生成…", "peers": [ { "ssh": "simon@laptop", "port": 7788 }, { "url": "http://10.0.0.5:7788" } ] },
  "update": { "enabled": true, "autoInstall": false, "cacheMinutes": 10 },   // 见「升级与发布」
  "defaultCwd": "/home/simon",
  // "intakeRetentionHours": 72,   // 已消费的浏览器评论保留多久（小时）后自动清理
  "projects": [
    // 浏览器评论按 URL 匹配工作目录（子串，或 /正则/）；hub 启动时合并进 ~/.quick-agent/projects.json 的项目（见「项目」）
    { "match": "localhost:5173", "cwd": "/home/simon/my-app", "notes": "Vite + React，组件在 src/components", "machine": "cloud" }
  ]
}
```

**worker 默认模型**：Web UI 顶栏的「WORKER <模型>」按钮（和右侧「前台」对话模型分开）打开设置面板，列出 mesh 里每台在线机器：生效的模型、来源（`workerModel` 设置 / 继承 `model`）、这台机器自己 `pi --list-models` 的可用模型（有思考能力的模型可选思考级别）。可以单台保存、恢复继承，或「应用到所有机器」（每台按自己的模型列表校验，部分失败会逐台列出，失败的机器不改）。保存由目标机器的 hub 校验后写入它的 config.json 并立即生效：之后新派发和恢复的 worker 用新模型，运行中的 worker 不受影响，前台模型不变。修改需要 owner 权限（`machine.configure`）。API：`GET /api/worker-model[?all=1|machine=id][&refresh=1]`，`POST /api/worker-model {"model": "provider/id[:thinking]" | null, "machine"?: id, "machines"?: [id…] | "all"}`。巡检 reviewer 没有设置 `watchdog.model` 时也跟随 worker 默认模型。

**模型列表从哪来**：前台下拉框和 WORKER 面板都只列出这台机器的 pi 当前可用的模型（有可用认证的 provider；前台用进程内的 pi SDK，worker 面板用 `pi --list-models`，同一台机器的配置一致），按 provider 分组，悬停可看上下文、输出上限、是否可思考、是否支持图片；WORKER 面板每台机器有搜索框。`models.json` 里手写的模型列表是静态的，网关新增的模型不会自动出现：要动态发现，给 provider 配一个用 `pi.registerProvider` + `refreshModels` 的扩展（pi 官方方式，见 pi 文档 custom-provider.md）。前台的「↻」和 WORKER 面板的「刷新列表」会触发 pi 的目录刷新（重新读取 models.json、调用各 provider 的 refreshModels）；某个 provider 刷新失败时保留上次的列表并提示失败原因，不会清空，也不会切换正在用的模型。

修改配置后需要运行 `quick hub restart`，并在 pi 里执行 `/reload` 或新开一个 pi，才会生效。

## 目录结构

```
bin/quick                       CLI 入口
cli/quick.ts                    CLI
cli/team.ts                     CLI：quick team / assign / comment
hub/server.ts                hub（零依赖 Node HTTP + SSE + tmux）
hub/mesh.ts                  多机互联：链路、ssh 隧道、路由、复制、RPC
hub/handoff.ts               任务跨机器交接：编排、分块传输、目标端应用/回滚
hub/cron.ts                  定时任务：持久化、触发定时器、mesh 复制、cron.* 方法（只由所属 hub 触发）
hub/watchdog.ts              巡检：活动时钟、定时检查、拉起只读检查 agent（pi -p，read/grep/find/ls）、按结论纠偏或升级
hub/projects.ts              项目：持久化、任务自动归类与回填、手动改名/合并/移动、mesh 同步
shared/projects.ts           项目归类逻辑（git remote/worktree、路径、URL、文本）与分组排序
cli/projects.ts              quick projects / 按项目分组的 quick ls
hub/workspace.ts             交接用的工作区快照（git bundle/diff/untracked 或 tar）、manifest 校验、撤销
hub/attention.ts             注意力：计算变化、决定打扰、合批待扫摘要、持久化专注模式（团队模式下按人）
hub/team.ts                  团队：成员名册（mesh 复制）、身份、邀请、任务上的人、评论、点名
hub/dashboard.ts             网页面板（任务视图）
ui/server.ts                 Web UI：用 pi SDK 托管唯一的前台 agent + 代理 hub API + SSE（quick ui）
ui/app.html                  Web UI 前端（注意力队列、前台对话、定时）
ui/team.js                   Web UI 团队部分（身份、团队视图、任务的人和评论）
shared/                      配置、数据类型、hub 客户端（hub / CLI / 扩展共用）
shared/attention.ts          注意力模型：状态、原因、动作、排序、打扰策略（纯函数，所有前端共用）
shared/update.ts             升级：GitHub Release 查询与缓存、安装方式识别、下载校验、原子切换与回滚、锁
ui/upgrade.js                Web UI 顶栏的版本标签 / 升级按钮 / 版本面板
install.sh                   Release 安装脚本（也用于从 git 安装迁移）
scripts/release.sh           维护者发布脚本；.github/workflows/release.yml 构建 macOS 客户端
shared/schedule.ts           机器资源探测与派单选机器（资源 + 优先级）
shared/team.ts               团队规则：角色权限、@提及解析、球在谁手里、按人的注意力（纯函数）
shared/cron.ts               定时规则：5 段 cron 解析、下次运行时间（时区/DST）、间隔/一次性、重叠与补跑决策
shared/watchdog.ts           预期时间与巡检的纯逻辑：默认预期、活动时钟、触发条件与冷却、重复模式检测、结论解析与处理
test/                        npm test（团队协作端到端、升级逻辑、多机升级模拟、调度选择、两机派单、定时规则、项目归类与回填）；*-e2e.sh 端到端测试
extensions/quick-agent.ts    pi 扩展入口（package.json 的 pi.extensions），按角色分流
extensions/front.ts          前台角色
extensions/worker.ts         worker 角色
extensions/team-tools.ts     前台的团队工具与提示（qa_task_assign / qa_comment / qa_team）
browser/                     Chrome MV3 插件
docs/browser-extension/      插件隐私政策与上架材料
scripts/pack-extension.sh    打包上架用 zip（dist/）
```

运行时数据放在 `~/.quick-agent/`：`update.json`（升级检查缓存）、`projects.json`（项目）、`tasks/<id>/{task.json,events.jsonl,brief.md,run.sh}`、`intake/<id>/{intake.json,*.png}`（浏览器评论，消费后短期保留）、`cron.json`（本机 hub 所属的定时计划）、`hub.log`、`attention.json`（专注模式、摘要间隔、待发摘要）。内部细节：worker 的上下文是标准的 pi 会话文件，保存在 `~/.pi/agent/sessions/`（`quick show <id> --debug` 显示路径），Web UI 前台的对话保存在 `ui-sessions/`；正常使用不需要关心它们，接管 worker 用 `quick attach`。

## Hub API（Bearer token）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks`、`/api/tasks/:id?events=N` | 任务列表 / 任务详情 |
| POST | `/api/tasks` | `{title, brief, cwd?, machine?, requires?, project?, attachments?, source?, reviewer?, assignee?, watchers?, expected?, watch?}` 创建任务并拉起 worker；不传 machine 时按 requires + 优先级选机器；发起人取自 token |
| POST | `/api/tasks/:id/message` | `{text}` 回答或追加指令（worker 窗口关了会带着完整上下文重新拉起） |
| POST | `/api/tasks/:id/cancel`、`/close`、`/ack` | 中止 / 关闭窗口 / 知道了 |
| POST | `/api/tasks/:id/snooze`、`/retry` | 稍后提醒 `{minutes}` / 重试 |
| GET | `/api/attention` | 注意力队列与计数（见「注意力模型」），**按 token 的身份计算**；`?scope=team` 团队视图，`?user=<id>`（owner）看某人的队列；`POST /api/attention/focus`、`/api/attention/settings` |
| POST | `/api/tasks/:id/assign` | `{assignee?, reviewer?, watchersAdd?, watchersRemove?, note?}` 转交 / 请人验收 / 关注（null 清除） |
| GET/POST | `/api/tasks/:id/comments` | 评论列表 / `{text, toWorker?}` 发评论（@id 点名，@all，@worker 转给 worker） |
| GET | `/api/me`、`/api/team` | 你是谁；成员名册（含各自的机器，owner 还能看到未用的邀请） |
| POST | `/api/team/members`、`/api/team/members/:id` | 加人（返回一次性 token）/ `{role, name, resetToken, remove}` |
| POST | `/api/team/invites`、`/api/team/join` | 生成邀请码（owner）/ 用邀请码加入（不需要 token） |
| POST | `/api/tasks/:id/project` | `{project}` 手动改任务的项目（`""` = 未归类），之后不再自动归类 |
| GET/POST | `/api/projects` | 项目列表 / `{name, urls?, paths?, remotes?, keywords?, notes?}` 新建 |
| POST | `/api/projects/:id/rename`、`/merge`、`/rules` | `{name}` 改名 / `{into}` 合并 / `{add?, remove?, notes?, members?}` 改识别规则 |
| POST | `/api/projects/backfill` | `{all?}` 给本机任务归类（all：重新归类所有非手动设置的） |
| POST | `/api/tasks/:id/handoff` | `{to, cwd?, noWorkspace?, abort?, waitSec?, onConflict?}` 把任务交接到另一台机器（异步） |
| POST | `/api/tasks/:id/report` | worker 上报状态、汇报、活动；`{needsHuman, question, options}` 显式请求人类决定；`{kind:"progress", progress:{plan?, current?, done?, note?, percent?, eta?}}` 更新进度；`{expect:{expected, reason}}` worker 修正一次预期 |
| POST | `/api/tasks/:id/watch` | 巡检：`{off: true\|false}` 按任务开关，`{expected: "30m"}` 改预期，`{now: true}` 立即巡检一次 |
| GET | `/api/tasks/:id/transcript` | 工作记录：`?after=N` 增量（N 之后的条目），`?before=N&limit=M` 往前翻页，都不带 = 最新一页，`?full=N` 某条不截断的全文；返回 `{entries[], total, pendingFrom?, available}` |
| GET | `/api/tasks/:id/screen` | worker 终端的实时画面（tmux capture） |
| GET | `/api/machines` | mesh 中的机器、路由与链路状态（含各机器版本、resources、priority） |
| POST | `/api/machine` | `{machine?, priority?, resources?, addResources?, removeResources?, resourceNotes?, description?}` 修改某台机器的资源/优先级（null 清除），即时生效 |
| POST | `/api/upgrade` | `{all?, machines?, check?}` 升级或检查指定机器（同步），返回每台的结果 |
| GET | `/api/update` | `?machine=M` / `?all=1`，`&refresh=1` 跳过缓存：运行版本、已安装版本、最新 Release（含更新说明）、能否升级、进行中的升级任务 |
| POST | `/api/update` | `{machine?, action: "install"\|"rollback"}` 异步升级 / 回滚，进度用 GET 查询 |
| POST | `/api/fs` | `{machine, op: ls/read/grep, path, pattern?}` 远程只读文件访问 |
| GET/POST | `/mesh/link`、`/mesh/send` | hub 之间的链路（mesh secret） |
| GET | `/api/cron`、`/api/cron/:id` | 定时计划列表（整个 mesh）/ 详情，含规则描述、下次运行、最近任务及其状态 |
| POST | `/api/cron` | `{title, brief, cron? \| every? \| at? \| in?, tz?, machine?, requires?, cwd?, overlap?, catchUp?, silent?, enabled?, hub?}` 创建计划（四选一） |
| POST | `/api/cron/:id` | 修改（同上字段，`null` 清除 machine/requires/cwd） |
| POST | `/api/cron/:id/run`、`/pause`、`/resume`、`/delete`（或 `DELETE /api/cron/:id`） | 立即运行一次 / 暂停 / 恢复 / 删除；会路由到计划所属的 hub |
| GET | `/api/events` | SSE 事件流（`?task=<id>` 用于 worker 接收指令；`?role=front&front=<id>` 用于前台；含 `attention*` 事件） |
| POST/GET | `/api/intake` | 入口提交（浏览器评论等）/ 列表 |
| POST | `/api/intake/:id/claim` | 前台认领评论（认领即消费，只能成功一次） |
| POST | `/api/tasks/:id/message` | `{text, intakeId?}` 追加指令；带 `intakeId` 时把这条浏览器评论关联到任务，截图复制进任务 |
| GET | `/api/tasks/:id/attachment?n=` | 任务附件（Web UI 显示截图用） |
| GET | `/`、`/extension.zip`、`/health` | 面板 / 插件包 / 健康检查 |

新入口只需要 `POST /api/intake`（交给前台组装上下文）或 `POST /api/tasks`（直接派单）。

## 后续可以做的

- 更多入口：IM 机器人、Git 评论、CI 失败。
- 收件箱优先级、汇报摘要推送。
