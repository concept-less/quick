# 预期时间与巡检（watchdog）

> 代码：`shared/watchdog.ts`（纯逻辑）、`hub/watchdog.ts`（hub 侧调度和检查 agent）、`shared/attention.ts`（升级后的注意力）、`extensions/worker.ts`（`qa_expect`）、`extensions/front.ts`（`qa_dispatch expected/watch`）、`ui/app.html`（卡片、详情）。
> 测试：`test/watchdog.test.ts`、`test/watchdog-hub.test.ts`、`test/watchdog-e2e.mjs`。

## 1. 要解决的问题

quick-agent 的理念是替人管理注意力：交出去的事人可以忘掉，只有需要他时才找他。但「不用管」不等于「没人管」。人类观察到：很多任务实际耗时远超预期，worker 却在兜圈子（同一条失败命令重试十几次、来回改同一处、无限等一个不会来的结果），没有任何人发现，直到人自己去看。

所以需要一个替人「偶尔看一眼」的机制，它必须满足两个约束：

1. **它本身不能变成噪音**。正常的慢任务不应该打扰人，巡检的过程和结果默认只记在任务里，人主动看才看得到。
2. **它不能越权**。检查者只能看、只能建议；代码由 worker 改，任务是否中止由人决定。

## 2. 总体设计

```
派单 expected="20m" ──► task.expect ──┐
worker qa_expect（一次，带理由）──────┤
                                      ▼
hub 活动时钟 task.clock ──► 定时检查 triggerFor()  ◄── 重复模式 detectRepeats()（读 worker 的内部记录尾部）
                                      │                 ◄── 进度 progress.updatedAt（t8f4a）
                                      ▼ 超时 1.5x/3x/6x · 无进展 · 重复模式 · 纠偏后复查（冷却 + 去重）
                       只读检查 agent（pi -p，read/grep/find/ls，无 QA_* 身份）
                                      │ 标准输出最后一行 JSON
                                      ▼
            ON_TRACK ──► 静默更新预期，记一行
            DRIFTING / STUCK / BAD_APPROACH ──► 【巡检纠偏】追加指令发给 worker ──► 冷却后复查 ──► 仍有问题 ──► 升级
            NEEDS_HUMAN ──► 升级
                                      │
                       升级 = task.watch.pending ──► 注意力「需要你」[CHECK]（问题 + 选项）
```

## 3. 预期时间

- **来源与优先级**：`dispatch`（前台派单时估的）→ `worker`（worker 修正，一次）→ `watchdog`（ON_TRACK 时检查 agent 给的新预估）。没有派单预估时取 `default`。人也可以用 `quick watch <id> expect 45m` 改。
- **前台必须估时**：系统提示给出量级参考（小改动 10–20m、普通功能 30–60m、跨模块机制/发布/调研 1–3h）。估不准没关系，巡检会在超时时重新评估；不估就失去了判断「明显超出」的基准。
- **默认值按任务类型**：定时任务 15m；标题或简报里有发布、部署、迁移、重构、调研、端到端、新增机制等字样，或简报超过 2500 字，按大任务 60m；简报很短且像小改动（typo、改文案、查一下）15m；其余 30m。都可以在 `config.json` 的 `watchdog.defaults` 里改。理由：派单没有估时多半来自 CLI/API/定时任务，按类型取一个保守的量级，比统一一个值少很多误触发。
- **worker 只能修正一次，必须给理由**：worker 最了解任务的真实规模，但如果允许反复改预期，超时就失去意义（一直往后推）。一次修正 + 理由记录在任务里，人能看到它为什么改。
- **步骤预估**：t8f4a 的进度计划里每个步骤可以带 `expectedMinutes`。巡检把合计值交给检查 agent 作参考，但不自动覆盖总预期：步骤预估往往不含排查和返工，把它当总预期会让超时来得太早。
- **只计活动时间**（`task.clock`）：hub 在状态变化时累计 starting/running 的时间，`needs_input`、`idle`、`done` 等等人的时间不算。否则一个等了人一夜的任务第二天一恢复就「超时」，这不是 worker 的问题。

## 4. 巡检触发

由 hub 的定时器调度（和 cron 一样是 hub 内的 `setInterval`，默认 30 秒一次；只检查本机拥有的任务，所以多机 mesh 下每个任务只有一个 hub 会巡检它，检查 agent 也跑在 worker 所在的机器上，能直接读工作区和内部记录）。只对 `running` 的任务、巡检没有被关闭、没有正在进行的巡检、没有等人回答的升级时才检查。

| 触发 | 条件 | 去重 |
|---|---|---|
| 超时 | 已用 ≥ 预期 × 倍数；倍数依次 1.5、3、6，之后继续翻倍 | 每触发一次倍数前进一级；预期被更新（ON_TRACK / worker 修正 / 人设置）后从 1.5x 重新算 |
| 无进展 | `max(progress.updatedAt, 最近汇报/状态变化/追加指令)` 超过 `stallMinutes`（默认 20） | 同一个「最近进展时间点」只查一次 |
| 重复模式 | 最近 30 次工具调用里，见下 | 同一个模式签名只查一次 |
| 纠偏后复查 | 发出纠偏建议后，过了冷却时间 | 每次纠偏一次 |
| 手动 | `quick watch <id> now`、详情里的「现在巡检」 | — |

**冷却**：同一个任务两次巡检之间至少 `cooldownMinutes`（默认 10 分钟），全局最多 `maxConcurrent`（默认 2）个检查同时进行。巡检失败（超时、没给出可解析的结论）也会记一行并进入冷却，不会立刻重试。

**进度依据**：活动 ping（worker 每执行一个工具都会上报）不算进展，否则一个在死循环里不停执行命令的 worker 永远不会「无进展」。t8f4a 的 `progress.updatedAt` 只在计划、步骤、说明变化时更新，正好可以直接用。

**重复模式**（`detectRepeats`，hub 读 worker 内部记录文件的尾部 768KB，文件没变就用缓存）：

- `same_call`：同一个调用（工具 + 参数）得到同样的结果 ≥ 4 次。只看调用不看结果会误报：`npm test` 在修改之间反复跑、结果不同，是正常的修复循环。
- `same_error`：同一个错误文本 ≥ 4 次，不管是什么命令触发的（换着法子撞同一堵墙）。
- `polling`：含 sleep/wait/until/watch 的命令（忽略其中的数字）结果一直不变 ≥ 4 次（无限轮询或等待）。
- `flip_flop`：一个 edit 把之前某个 edit 的改动改回去（来回改同一处）。

比较输出前先去掉数字、哈希和临时路径（耗时、行号、PID 不同不代表情况变了）。这些只是「值得看一眼」的信号，不是结论：结论由检查 agent 给，检测到的模式会写进它的材料里。

## 5. 检查 agent

- **独立、只读**：hub 用 `pi -p --no-session --tools read,grep,find,ls --no-mcp --no-skills --no-prompt-templates --no-context-files` 拉起一个一次性进程，工作目录是任务的 cwd，stdin 关闭，超时（默认 8 分钟）强制结束。它不能写文件、不能执行命令，hub 也不给它任何能改变任务的通道：它唯一的输出是标准输出，由 hub 解析。
- **没有 quick-agent 身份**：环境里所有 `QA_*` 变量都被去掉（`QA_TASK_ID`、`QA_HUB_URL`、`QA_TOKEN`、`QA_HOME`、`QA_PORT`……），只加一个 `QA_WATCH_TASK` 标记；`extensions/quick-agent.ts` 看到这个标记不加载任何角色。另外 worker 角色只在交互式 pi（hub 在 tmux 里拉起的那个）里生效，任何非交互的 pi 即使继承了 `QA_TASK_ID` 也不会向 hub 汇报。这两条一起保证检查 agent 和它的系统提示一致：提示里只说它有 read/grep/find/ls、结论写在标准输出，不出现 `qa_report` 之类它没有的工具。（开发时出现过一次：自测的检查进程继承了外层 worker 的 `QA_TASK_ID`，加载了 worker 角色，把它的输出汇报成了真实任务的「需要你」。上面的两条和 `test/watchdog.test.ts`、`test/watchdog-hub.test.ts` 里的隔离断言就是为此加的。）
- **模型可配置**：`watchdog.model` / `watchdog.thinking`，默认用 worker 的模型。判断「是否在兜圈子」不需要最强的模型，建议配一个便宜快一点的（实测 `claude-sonnet-5-5` + `thinking low` 每次 10 秒左右）。
- **材料**（hub 整理成一个文件交给它）：触发原因；已用 / 预期及来源、步骤预估合计、距上次进展；任务简报；进度（t8f4a 的 `task.progress`）、最新汇报、当前活动；检测到的重复模式；最近 40 次工具调用和输出（时间、命令、结果尾部、是否出错）；工作区状态（分支、最近提交、`git status --short`、`git diff --stat HEAD`）；之前的巡检和当时的建议；worker 内部记录文件的路径（需要更多细节时它可以用 read 去读）。worker 的内部记录只作为内部实现细节交给检查 agent，不展示给人。
- **结论**：最后一行 JSON：`verdict`（ON_TRACK / DRIFTING / STUCK / BAD_APPROACH / NEEDS_HUMAN）、`evidence`（依据，要引用具体的命令、错误、文件）、`advice`（给 worker 的建议，BAD_APPROACH 必须给替代方案）、`expected`（ON_TRACK 时的新总预估）、`question` / `options`（NEEDS_HUMAN）。提示要求「宁可 ON_TRACK 也不误报」，NEEDS_HUMAN 只在缺只有人才有的信息、权限或必须由人做取舍时用。

## 6. 结论的处理

| 结论 | 处理 | 打扰人吗 |
|---|---|---|
| ON_TRACK | 预期更新为新预估（不会短于已用时间；没给就取已用 × 1.5 和原预期 × 1.5 的较大者），倍数级别清零，纠偏计数清零，记一行 | 不打扰 |
| DRIFTING / STUCK / BAD_APPROACH（第一次） | 把依据和建议作为追加指令发给原 worker（走现有的 send 路径，worker 看到的是「【quick-agent 追加指令】【巡检纠偏】…」），记一行，冷却后安排一次复查 | 不打扰 |
| 同上（纠偏后复查仍有问题） | 升级：`task.watch.pending`，任务进「需要你」，标记 `[CHECK]`，一句问题 + 选项（按巡检建议换个方法继续 / 放宽预期，让它继续 / 中止任务） | 立即（和 worker 提问一样） |
| NEEDS_HUMAN | 直接升级，用检查 agent 的问题和选项 | 立即 |
| 巡检失败 | 记一行错误，进入冷却 | 不打扰 |

- 升级不改任务状态（worker 可能仍在运行），所以用 `task.watch.pending` 表达，注意力模型把「运行中 + 有升级」算作「需要你」。人回答时，hub 把巡检的问题和建议附在回答前面一起发给 worker，并清掉升级和纠偏计数；点「知道了」也清掉；任务停下（完成、失败、取消）时升级自动失效，以 worker 自己的汇报为准。升级期间不再巡检。
- 「中止任务」只是一个回答选项，hub 不会因为它中止任务；人需要中止时用「中止」按钮或 `quick cancel`。
- 巡检结果到达时如果任务已经不在运行（例如巡检期间 worker 完成了），结论只记录，不发纠偏、不升级。
- 纠偏次数 `maxCorrections` 默认 1：纠偏一次给 worker 自救的机会；第二次还在兜圈子，说明它自己走不出来，该人看了。

## 7. 可见性

- **卡片**：运行中的任务显示「已用 / 预期」（`12m / 20m`），超时后加粗、标记从 `[RUN]` 变成 `[OVER]`。单色，不发通知，不改变注意力级别。
- **详情**：进度区的时间行变成「已用 2m14s / 预期 1m [OVER]」；信息区有「用时」（来源和理由）和「巡检」（开启 / 关闭 / 现在巡检）；「巡检」区列出最近几次巡检：时间、结论、触发原因、依据、建议、处理结果。不是事件流，只有巡检本身。
- **CLI / 前台**：`quick show`、`quick watch <id>`、`quick ls`（每行带已用 / 预期）、前台 `qa_task_read`（`time:` 行、升级问题、`--- 巡检 ---`）和 `qa_tasks`。

## 8. 配置

`config.json`：

```json
"watchdog": {
  "enabled": true,
  "multipliers": [1.5, 3, 6],
  "cooldownMinutes": 10,
  "stallMinutes": 20,
  "repeatThreshold": 4,
  "repeatWindow": 30,
  "model": "tokenjoy/claude-sonnet-5-5",
  "thinking": "low",
  "timeoutMinutes": 8,
  "maxCorrections": 1,
  "maxConcurrent": 2,
  "tickSeconds": 30,
  "defaults": { "small": 15, "normal": 30, "large": 60, "cron": 15 }
}
```

另有 `piBin`（检查 agent 用的 pi 可执行文件）和 `command`（测试用：完全替换检查 agent 的命令，提示文件路径作为最后一个参数）。`QA_WATCHDOG=off` 临时全局关闭。按任务关闭：派单时 `watch: false`（`qa_dispatch watch=false`、`quick new --no-watchdog`），或 `quick watch <id> off`、详情里的「关闭」。适合长时间轮询或等待外部事件的任务。

## 9. 与进度（t8f4a）的关系

预期时间和巡检建立在 `task.progress` 之上，不另起一套：无进展判断用 `progress.updatedAt`（活动只更新 `now/nowAt`，不算进展），步骤预估读 `progress.steps[].expectedMinutes`，检查 agent 的材料里包含完整的进度记录。预期和巡检放在独立的 `task.expect` / `task.clock` / `task.watch` 字段里，不改 progress 的结构。

## 10. 验证

- `npm test`：`test/watchdog.test.ts`（预期解析与默认值、活动时钟、超时倍数、冷却 / 关闭 / 升级中 / 非运行时不触发、无进展去重、重复模式（同调用同结果、同错误、轮询、来回改，以及修复循环不算）、内部记录解析、结论解析、四类结论的处理分支、升级的注意力和打扰、检查 agent 的环境隔离和提示一致性）；`test/watchdog-hub.test.ts`（隔离 hub + tmux 里的假 worker + 假检查 agent：兜圈子 → STUCK → 纠偏送达 → 复查 STUCK → 需要你 [CHECK] → 人回答后清除；正常但慢 → ON_TRACK 静默；按任务关闭；worker 修正一次；worker 和检查 agent 只认识临时 hub，真实的 `~/.quick-agent` 不变）。
- `test/watchdog-e2e.mjs`：真实的检查 agent。两个假 worker 都预期 1m：兜圈子的那个每 10 秒执行一次同一条失败的构建命令，正常的那个每 10 秒完成一个文件并汇报进度。1m30s 时两个都触发超时巡检；前者得到 STUCK，建议送达 worker，冷却后复查仍是 STUCK，进「需要你」并发出 interrupt=now；后者得到 ON_TRACK，预期更新为新预估，没有任何打扰。`--shots DIR` 输出 Web UI 截图。
