# 管理哲学：把 coding agent 当队友，把注意力当稀缺资源

> 本文是 quick-agent 桌面客户端（`electron/`）和任务管理体验的设计依据。
> 主线是**注意力管理**：quick-agent 没有"会话"，只有"注意力"。注意力研究和 Web UI 的界面原则见 [`docs/attention.md`](attention.md)，本文从两个参考产品出发，说明这条主线为什么成立，以及它在客户端里怎么落地。

---

## 0. 结论先行

有了 worker 之后，人手里稀缺的不再是执行力，而是**注意力**。前台 agent 和客户端只做一件事：替你管理注意力。所有任务只落在三个桶里：

| 桶 | 含义 | 任务状态 | 客户端怎么对待 |
|---|---|---|---|
| **需要你** | worker 在等人：提问、受阻、失败、停下 | `needs_input` `blocked` `failed` `exited` `idle` | **唯一可以打断你的东西**：立即发系统通知；托盘标题和 Dock 角标只显示这个数 |
| **已托付 / 进行中** | 交出去了，有人在做 | `starting` `running` | 外围信息：只在托盘菜单里显示一个数，不通知 |
| **已完成待扫** | 做完了，还没看过 | `done` 且未读 | 不打断：合批成一条安静的汇总通知（默认 30 分钟一次），专注时暂存 |

（`cancelled`、已读的 `done` 不占注意力，不在任何桶里。）

和前台的交互只剩一个动作：**把一件事交出去**。没有新建、切换、命名会话。

---

## 1. 调研

### 1.1 multica：智能体也在看板上

- 项目：[github.com/multica-ai/multica](https://github.com/multica-ai/multica)（源码阅读自 cloud 机器 `/home/simon/multica`：`VISION.zh.md`、`README.zh.md`、`apps/docs/content/docs/*.zh.mdx`、`apps/desktop/src/main/*`）。
- 定位：源码公开的团队工作区，"像给同事派活一样，把任务交给 AI 编码智能体——它自己接手、边做边汇报、卡住了主动说，做完交回来给你审"。名字致敬 Multics 的分时：多个"用户"（人和 agent）共享同一个系统。

可借鉴的管理思想：

| multica 的做法 | 背后的思想 |
|---|---|
| **任务（issue）是一等公民**：目标、讨论、负责人、状态、每次运行（run）、产物都挂在同一条任务下；一个任务可以有多次运行 | 上下文不留在某个人脑子里或某个聊天窗口里，换人、换 agent 不用重讲 |
| **agent 是队友**：有名字、能被分配、能被 @，开始工作把状态改为 `in_progress`，交付后改为 `in_review` | 用人类团队熟悉的协作语义管理 agent |
| **人来验收**：活先进入"审核中"，不直接进 main，上不上线由人决定 | 人负责方向、标准和最终结果 |
| **四类生命周期**：`unstarted`（backlog/todo）、`started`（in_progress/in_review/blocked）、`done`、`closed`；`blocked` 交回给人，但"工作还卡着" | 状态要表达"球在谁手里"，而不只是"做到哪了" |
| **收件箱只在 agent 需要你拍板时提醒你**；同一任务的多条通知合并；可以按类型关闭通知；任务交回给人后，"运行失败"通知自动归档 | 收件箱是注意力的过滤器，不是活动日志 |
| **桌面端 `NotificationGate`**：主进程统一判断"是否有窗口在前台"，同一事件只弹一次，窗口在前台不弹 | 原生通知要去重、要知道用户此刻在看什么 |
| **Skills / Autopilots**：解决过一次的问题沉淀成 skill 复用；周期性工作按 cron 自己跑 | 让重复性的协调工作不再占用人的注意力 |
| **运行中插话、执行日志可回放、失败自动重试或停下说明原因** | 随时能纠偏，回到一件事的成本最低 |

### 1.2 "hedr"：确认为 herdr

简报里的 "hedr" 没有找到同名的产品或方法论。搜索 "hedr agent" 和 "hedr coding agent management" 时，排在前面的都是 **herdr**（[herdr.dev](https://herdr.dev)，[github.com/herdrdev/herdr](https://github.com/herdrdev/herdr)，约 4.9 万 star），是一个管理 coding agent 的工具，与简报语境吻合，所以按 herdr 理解。其他候选：Hedra（AI 视频生成）、hedron（React 栅格库 / 微内核），都和 agent 管理无关。

herdr 的口号是 "the runtime your coding agents live on"：一个 Rust 写的终端多路复用器（"为 AI 时代重写的 tmux"），每个 agent 跑在真实终端 pane 里。以下内容读自其仓库的 README 和 `docs/next/website/src/content/docs/*.mdx`。

| herdr 的做法 | 背后的思想 |
|---|---|
| **"never hunt for the stuck one"**：每个 pane 标成 `working` / `blocked` / `idle`，agent 停下来要答案时 herdr 会告诉你；状态向上汇总到 tab 和 workspace，侧栏一眼看出哪个项目需要注意 | 人不该轮询终端，系统要把"谁卡住了"推到你面前 |
| **`done` 和 `idle` 分开**：`done` = 完成了但还没被看过，`idle` = 完成且已确认 | "已完成待扫"是一个独立的注意力状态 |
| **`blocked` 判定刻意严格**：只有屏幕匹配已知的审批、提问 UI 才标 blocked；`idle` 不等于授权 | 打断人的信号必须可靠，宁可少报不可误报 |
| **通知**：后台 agent 完成或需要输入时通知（应用内、终端、系统三种投递方式），**当前正在看的 tab 不弹** | 用户已经在看的东西不用再提醒 |
| **detach without stopping work**：关掉客户端、断开 SSH，agent 继续工作；重连后恢复 | 客户端只是"窗口"，关掉它不影响托付出去的事 |
| **several machines, one window**：本地和多台 SSH 机器的 agent 合在一个列表里 | 注意力视图跨机器统一 |
| **agent-native**：agent 通过 CLI 和 socket 驱动 herdr，可以开 pane、互相发 prompt、等另一个 agent 真正阻塞 | 编排能力也开放给 agent 自己 |

### 1.3 两者的共同点，以及 quick-agent 已经有的

| 共同原则 | quick-agent 现状 |
|---|---|
| 任务是一等公民，上下文挂在任务上 | [OK] hub 里的 `Task`（brief、summary、events、session），`quick show` / Web UI 任务详情 |
| agent 主动汇报，阻塞时主动说 | [OK] worker 的 `qa_report(done/needs_input/blocked/progress)` |
| 人是验收者和决策者 | [OK] 汇报回到派单的前台；`unread` 标记 |
| 只有"需要你"才打扰 | [!] 原先任何状态变化都会出现在聊天流和面板里 → **本次改成三桶 + 克制通知** |
| 关掉窗口工作不停 | [OK] worker 在 tmux 里；本次客户端关窗口只是隐藏，退出也不停 hub 和 worker |
| 多机器一个视图 | [OK] mesh |

---

## 2. 设计原则（客户端视角）

与 [`docs/attention.md`](attention.md) 的 P1–P11 一一对应，这里只列客户端相关的部分：

1. **只有"需要你"能打断**（attention.md P5；herdr 的 blocked、multica 的收件箱）。系统通知只为 `needs_input` / `blocked` / `failed` / `exited` / `idle` 立即弹出；进度汇报、活动变化永远不弹。
2. **数字只回答"有几件事在等我"**（P11）。托盘标题 `■2`、Dock 角标 `2` 只数"需要你"，不显示任务总数、运行数或未读总数；没有需要你的事时只显示 `□`。
3. **待扫合批**（P6；Fitz 等关于批量通知的研究）。完成的汇报攒成一条汇总通知（"3 件事已完成待扫：A、B、C"），默认 30 分钟一次，可调为 5/10/30/60 分钟；在汇总发出前已经被扫过的会自动剔除。
4. **专注模式**（P6；Newport 的深度工作）。开启后不弹任何通知（"需要你"的数量仍在托盘上安静地更新），结束时只发一条汇总："专注结束 · N 件事需要你"，再补发待扫汇总。可以选 30 分钟、1 小时、2 小时或手动关闭；托盘标题带 `☾` 表示专注中。系统自带的"专注模式/勿扰"也照常生效。
5. **用户在看的就不提醒**（herdr 的"当前 tab 不弹"、multica 的 `NotificationGate`）。窗口在前台时不弹系统通知，界面本身已经展示；同一事件（任务 + 状态 + 更新时间）只通知一次，断线重连后不会重复。
6. **交出去就放得下**（P3、P9；Masicampo & Baumeister）。全局快捷键 `⌘⇧Space` 唤出"把一件事交出去"输入框：说完按 Enter，回执是"已交给前台，可以忘掉它了"，焦点还给你原来的应用（像 Spotlight）。默认交给前台 agent（由它理解、补上下文、决定交给谁），`Tab` 可切到"直接交给 worker"。
7. **没有会话**（P9）。客户端不提供任何会话菜单或功能：没有新建、切换、重命名，也没有"切换前台工作目录"这类按会话组织的入口。
8. **恢复线索就在手边**（P10；multica 的执行日志）。点通知或托盘里的"需要你"条目，直接打开那个任务的详情（最新汇报、实时终端、简报、追加指令）。
9. **关掉窗口不等于停工**（herdr 的 detach）。关窗口只是隐藏；退出客户端也不会停 hub、Web UI 服务和 worker。`--hidden` 可以只在菜单栏启动（适合开机启动）。

> 更新：注意力模型已经集中到 hub（`shared/attention.ts` + `hub/attention.ts`，见根目录 README「注意力模型」）。分类、计数、打扰决策（需要你立即、待扫合批）、专注模式（现在专注时仍放行"需要你"）、稍后提醒都由 hub 计算和保存，客户端、Web UI、CLI、终端前台只负责渲染。下表是最初在客户端里的实现，现已迁到 hub；第 4 节的第 2、3 条已经完成。

---

## 3. 本次落地（`electron/`）

| 功能 | 实现 |
|---|---|
| 三桶分类 | `electron/src/lib.cjs`：`bucket()` / `summarize()`，有单元测试 |
| 托盘 / Dock 只数"需要你" | `trayTitle()` / `badge()`；托盘菜单列出"需要你"的任务（点击直达），另有"已托付/进行中 · N"、"已完成待扫 · N"两行 |
| 立即通知 vs 合批 | `notificationFor()` 返回 `urgent` 或 `digest`；`Digest` 合批；`NotificationGate` 去重 |
| 专注模式 | `quietMode()`；托盘"专注模式"子菜单，菜单栏"注意力 → 专注 1 小时"（`⌘⇧F`） |
| 把一件事交出去 | `src/quick.html` + `quick-preload.cjs`；主进程带 token 调用 Web UI `/api/prompt` 或 hub `/api/tasks`，页面拿不到 token |
| 注意力导航 | 菜单"注意力"：需要你 `⌘1` / 已托付 `⌘2` / 已完成待扫 `⌘3`；深链 `quick-agent://view/need`、`quick-agent://task/<id>`、`quick-agent://quick` |

需要 Web UI 配合的接口，见 `electron/README.md` 的"与 Web UI 的约定"一节。

---

## 4. 后续建议（未在本次实现）

1. **验收语义**：把 `done` 拆成"已交付待验收"和"已验收"（对应 multica 的 `in_review` → `done`）。"扫过"等于验收；"返工"直接把追加指令发回同一个 worker。
2. **稍后（snooze）进入 hub**：Web UI 的"稍后"目前只在页面本地，可以存到 hub，让托盘、Dock、TUI 也一致。
3. **专注模式全局同步**：Web UI、客户端、pi TUI 共用一个由 hub 保存的专注状态，在任何地方开启都全局生效。
4. **通知分级可配置**：按类别开关（参考 multica 的"设置 → 通知"），例如 `idle` 只进托盘不弹通知。
5. **Skills / 经验沉淀**：worker 完成后把可复用的做法沉淀成 pi skill，前台派单时自动附上（multica Skills）。
6. **周期性任务（autopilot）**：按 cron 让 hub 自动派单（日报、巡检），结果只进"已完成待扫"。
7. **运行记录**：一个任务的多次"运行"（每次追加指令、恢复会话）单独记录用时和花费（multica 的 run）。
8. **blocked 判定更严格**：worker 没调用 `qa_report` 就停下时，现在记为 `idle`。可以借鉴 herdr 读屏幕判断是否真的在等输入，减少误打断。
9. **agent 之间互相等待**：worker 可以等另一个 worker 完成或阻塞后再继续（herdr 的 `agent wait`），用于拆分子任务。
