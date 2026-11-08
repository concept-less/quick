# quick-agent

一个 **pi 包**：装好以后，**你平时打开的 pi 就是 quick-agent 的前台 agent**，不需要额外的启动命令。

- **前台 agent**：打开 pi 时默认就是它，终端 TUI 和桌面端等 RPC 客户端都算。它要求 **快**，只负责理解任务、组装上下文、派单。前台模式下只有 `read/grep/find/ls` 和 `qa_*` 工具，其余工具一律拦截。
- **worker agent**：每个任务都有一个独立的负责人，是一个完整的 pi 会话，跑在 tmux 窗口 `qa:<id>` 里，从头到尾把任务做完。它不是 subagent，你随时可以观看或接管。
- **hub**：本地常驻服务，pi 启动时会自动拉起它。负责任务注册表、注意力收件箱、worker 生命周期、入口接入、SSE 事件流，还有一个网页面板（能看 worker 的实时终端）。
- **入口**：pi 本身、浏览器插件（框选元素后写评论）、`quick` CLI，以及任何能发 HTTP 请求的程序。

```
 入口                         前台层                      后台层
 pi (TUI/RPC) ─┐
 浏览器插件 ────┼──► hub ◄────► 你的 pi = 前台 ──qa_dispatch──► worker (pi @ tmux qa:<id>)
 quick CLI ────┘    (任务/收件箱/SSE/面板)                     ├─► worker …
                    ▲                                          │
                    └──── qa_report / 活动 / 会话 ──────────────┘
```

就像中断处理一样：前台是上半部，只做最少的事，马上返回；worker 是下半部，负责把工作完整做完。

## 安装

需要 Node ≥ 22.18、[pi](https://github.com/earendil-works/pi)，以及 tmux（worker 跑在 tmux 窗口里）。

```bash
git clone git@github.com:concept-less/quick.git ~/quick-agent
pi install ~/quick-agent                # 写入 ~/.pi/agent/settings.json 的 packages（加载本地目录，不拷贝）
ln -sf ~/quick-agent/bin/quick ~/.local/bin/quick   # 命令行工具（确保 ~/.local/bin 在 PATH 中）
```

升级见下面的「升级」一节（默认自动升级，也可以 `quick upgrade`）。卸载用 `pi remove ~/quick-agent`。改了代码以后，在 pi 里执行 `/reload`，或者新开一个 pi，就能生效。

## 升级

quick-agent 会自己检查新版本并自动安装：

- **启动时后台检查**：hub 启动约 10 秒后（之后每小时一次）、前台 pi 启动 5 秒后、以及每次运行 `quick` 命令时（另起一个分离的后台进程）都会触发检查。检查不阻塞启动，每个请求有超时，失败时静默；结果缓存在 `~/.quick-agent/update.json`，两次检查至少间隔 `intervalHours`（默认 6 小时），多个进程之间用 `update.lock` 互斥。
- **发现新版本后**：自动安装。安装后 hub 会在本机没有 starting/running 的 worker 时自动重启（`restartHub: "never"` 可关闭）；前台 pi 会弹出提示，执行 `/reload` 或新开 pi 后生效。正在运行的 worker 不受影响，下次启动时用新版本。
- **版本来源（按优先级）**：npm 包 → GitHub Release → git 仓库。前一个不可用（未发布、404、超时、没有权限）就用下一个。npm 上同名但 `repository` 不是本仓库的包会被忽略，防止被抢注。GitHub 私有仓库会用 `GITHUB_TOKEN` / `GH_TOKEN` 或 `gh auth token`。
- **安装方式自动识别**：

| 安装方式 | 识别 | 升级做法 |
|---|---|---|
| git 克隆（`git clone` + `pi install ~/quick-agent`） | 目录里有 `.git` | `git fetch` 后快进到上游分支（`merge --ff-only`）；HEAD 是分离状态时 checkout 最新的版本 tag。有未提交改动、本地分支与上游分叉、没有上游分支时不自动升级，只提示原因 |
| pi 管理的 npm 包（`pi install npm:quick-agent`） | 位于 `~/.pi/agent/npm/…/node_modules` | `pi update npm:<包名>` |
| npm 全局安装（`npm i -g quick-agent`） | 位于其他 `node_modules` | `npm install -g <包名>@<版本>` |
| 解压的发布包 | 以上都不是 | 下载 GitHub Release 的 `*.tgz` 附件（没有就用源码包），校验包名和版本后整体替换目录，旧版本保留为 `<目录>.prev` |

手动升级与多机升级：

```bash
quick upgrade --check            # 只检查：当前版本、最新版本、来源，以及各来源的结果
quick upgrade                    # 升级本机（quick update 是别名）；没有运行中的 worker 时会顺便重启 hub
quick upgrade --all              # 通过 mesh 升级所有在线机器（包括本机），汇总每台的 旧版本 → 新版本 和成功/失败
quick upgrade cloud mac-laptop   # 只升级指定机器（也可以写 --machine cloud,mac-laptop）
quick upgrade --all --check      # 查看全网版本
quick upgrade ... --json         # 机器可读的结果
quick machines                   # 也会列出每台机器的 hub 版本
```

多机升级走 mesh RPC `update.run`：请求逐跳转发到每台机器，由那台机器的 hub 在本地执行升级并返回结果，各机器并行执行，单台超时 6 分钟。那台机器的 hub 会等转发中的请求都返回后再重启。还在运行旧版本（不支持 `update.run`）的 hub 会报「对方 hub 版本过旧」，需要在那台机器上手动升级一次（`git pull` 并 `quick hub restart`）。

关闭或调整（`~/.quick-agent/config.json` 的 `update`，都可以省略）：

```jsonc
"update": {
  "enabled": true,          // false：不做后台检查（quick upgrade 仍然可用）
  "autoInstall": true,      // false：只检查并提示，不自动安装
  "intervalHours": 6,
  "restartHub": "idle",     // "never"：升级后不自动重启 hub
  "sources": ["npm", "github", "git"],
  "npmPackage": "quick-agent",            // 默认取 package.json 的 name
  "githubRepo": "concept-less/quick",     // 默认取 package.json 的 repository
  "gitUrl": "git@github.com:concept-less/quick.git"   // 非 git 安装时用来查 tag
}
```

环境变量：`QA_UPDATE=off`（或 `QA_NO_UPDATE=1`）关闭后台检查，`QA_UPDATE_AUTO_INSTALL=0` 只检查不安装，`QA_UPDATE_INTERVAL_HOURS`、`QA_UPDATE_SOURCES=github,git`、`QA_NPM_REGISTRY`、`QA_GITHUB_API` 用于覆盖对应配置。

### 发布新版本（维护者）

1. 改 `package.json` 的 `version`，提交并打 tag：`git tag v0.4.0 && git push origin main --tags`（git 安装的机器这样就能升级了）。
2. 可选：GitHub Release：`npm pack` 后 `gh release create v0.4.0 quick-agent-0.4.0.tgz`（发布包安装的机器用它）。
3. 可选：npm：`npm publish`（`files` 字段已经限定了发布内容）。

测试：`npm test`（全部在临时目录、临时端口里进行，会起 4 个临时 hub 模拟多机升级，不碰正在运行的 hub）。

## pi 如何选择角色（`extensions/quick-agent.ts`）

| 情况 | 角色 |
|---|---|
| 环境变量里有 `QA_TASK_ID`（由 hub 拉起的进程） | **worker**：完整工具集，外加 `qa_report` |
| 交互式 pi（终端 TUI，或 RPC 客户端如桌面端） | **前台**（默认开启） |
| `pi -p …` / `--mode json` | 不受影响，就是普通 pi |
| `pi --qa-off` 或 `QA_ROLE=off pi` | 普通 pi（仍然显示任务状态） |

在会话中可以随时切换：`/qa off` 切成普通 pi（恢复 bash/edit/write），`/qa on` 切回前台。

## 在 pi 里使用

直接说要做什么，前台会派单并立即回复任务 ID。worker 完成、提问或受阻时：

- 编辑器上方的任务组件会更新，并弹出通知；
- 汇报会以 `[quick-agent 汇报]` 消息进入 **派出这个任务的那个 pi** 的对话，但不会打断你，也不会触发新一轮回复；
- `/tasks`：任务面板，可以查看汇报、实时观看、接管、追加指令、中止或关闭。在 RPC 客户端里，它会改为输出任务列表和面板链接；
- `/peek [id]`：在 pi 里用浮层实时观看 worker 的终端（只在 TUI 中可用），按 Enter 追加指令，按 a 接管；
- `/attach <id>`：如果 pi 跑在 tmux 里，就切换到 worker 窗口；否则效果和 `/peek` 一样；
- `/hub`：显示 hub 地址、面板链接和插件下载地址。在桌面端的内置浏览器里打开面板，就能看到每个 worker 的实时终端。

CLI（任何终端都能用）：

```bash
quick ls                       # 任务列表（• 表示有未读汇报）
quick show <id>                # 查看汇报、事件、简报
quick send <id> "追加指令"      # worker 窗口关了也会自动用原会话恢复
quick attach <id>              # 切换到 worker 的 tmux 窗口
quick cancel <id> / quick close <id>
quick new --cwd ~/proj "标题" "完整简报"   # 不经前台直接派单
quick hub start|stop|restart|status|logs
quick upgrade [--check] [--all]  # 升级（见「升级」）
quick dashboard | quick tunnel | quick token
```

## 多机互联（mesh）

quick-agent 自带原生的多机互联，不依赖 codexhost。每台机器跑一个 hub，hub 之间组成网状网络：

- **随处派单**：前台的 `qa_dispatch` 可以带上 `machine`，任务和 worker 就跑在那台机器上。附件（截图等）会随请求一起传过去，简报里的路径也会自动改写。
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

quick machines                           # 查看机器、路由、链路状态
```

### 原理（`hub/mesh.ts`）

| 方面 | 做法 |
|---|---|
| 链路 | 由一方主动往外拨：`GET /mesh/link`（SSE，对端 → 我）加 `POST /mesh/send`（我 → 对端）。只需要一个方向能连通，处在 NAT 后面的笔记本也能加入。链路建立后是双向的。 |
| SSH | peer 写成 `{"ssh": "user@host"}` 时，hub 会自己拉起并维护 `ssh -N -L <空闲端口>:127.0.0.1:<对端 hub 端口>`（BatchMode、断线重连），还会顺带尝试在远端执行 `quick hub start`。 |
| 鉴权 | 全网共享一个 mesh secret（`Authorization: Mesh <secret>`，用 timingSafeEqual 比较），和本地 API token 分开。 |
| 路由 | 距离向量加水平分割，最多 8 跳。比如 A→B←C 的拓扑里，A 会经 B 访问 C；存在直连时优先直连，某条路断了会自动绕行。 |
| 复制 | 任务和评论各有一台归属机器，每次更新带递增的 `rev`，并广播给全网；收到的版本只有比本地新才会应用并继续转发，所以广播一定会结束。新链路建立时会互发一份快照。 |
| RPC | 请求按目标机器 ID 一跳一跳转发，响应沿路由表返回，超时 30 秒。远程方法包括 `task.create/get/message/cancel/close/ack/screen`、`intake.claim/update`、`fs.ls/read/grep`。 |

安全提示：mesh secret 相当于能在全网所有机器上执行 worker（也就是任意代码），请妥善保管。hub 默认只监听 `127.0.0.1`，跨机连接推荐走 ssh 隧道；如果要把 `host` 设成 `0.0.0.0` 直连，一定要配好防火墙或者用 Tailscale 这类内网。

### 本地电脑 + 浏览器的推荐用法

在本地电脑上也装一份 quick-agent，然后运行 `quick mesh join … --ssh <服务器>` 或 `quick mesh add <服务器>`，这样浏览器插件直接连本机的 `http://127.0.0.1:7788`，不用再手动开 ssh 端口转发。评论会进到 mesh，由服务器上的前台认领，再派给对应机器上的 worker。

## 浏览器插件（在本地电脑上用）

1. 在本地电脑上开端口转发，保持开启：`ssh -N -L 7788:127.0.0.1:7788 <user>@<server>`（完整命令和 token 可以在服务器上运行 `quick tunnel` 查看）。
2. 下载插件：<http://127.0.0.1:7788/extension.zip>，解压。
3. 打开 `chrome://extensions`，开启开发者模式，点「加载已解压的扩展程序」，选择解压后的目录。
4. 点插件图标，填 Hub 地址 `http://127.0.0.1:7788` 和 Token（服务器上运行 `quick token` 获取），然后点「保存并测试」。

使用方法：按 `Alt+Shift+C`，或点插件图标里的「在当前页面框选评论」。

- **元素模式**：鼠标悬停会高亮元素，点击即可评论；按住 Shift 点击可以多选，选好后按 Enter 写评论。
- **框选区域**：拖出一个矩形，矩形里的元素会自动收集。
- 写完评论后按 Ctrl/⌘+Enter 发送。插件会附带以下内容：URL、选择器和 XPath、outerHTML 片段、可见文本、视口截图（选区用红框标出）、选区裁剪图、页面控制台错误。
- 评论会先交给 **前台 agent**。前台根据项目映射确定工作目录，快速定位源码后派单；如果评论属于某个已有任务，就追加给对应的 worker。
- 发出评论的元素旁边会出现编号角标，颜色表示任务状态：灰色＝等待处理，蓝色＝进行中，黄色＝需要你处理，绿色＝完成。点击角标可以查看 worker 的汇报。
- 插件代码更新后，需要在 `chrome://extensions` 里点一下重新加载。

## 配置 `~/.quick-agent/config.json`

```jsonc
{
  "host": "127.0.0.1",
  "port": 7788,
  "token": "…自动生成…",
  "model": "tokenjoy/claude-opus-5-5",   // 前台和 worker 共用；也可以用 frontModel / workerModel 分开设置
  "tmuxSession": "qa",
  "machine": { "id": "cloud", "description": "主力服务器，项目在 ~/work" },
  "mesh": { "secret": "…quick mesh init 生成…", "peers": [ { "ssh": "simon@laptop", "port": 7788 }, { "url": "http://10.0.0.5:7788" } ] },
  "update": { "enabled": true, "autoInstall": true, "intervalHours": 6 },   // 见「升级」
  "defaultCwd": "/home/simon",
  "projects": [
    // 浏览器评论按 URL 匹配工作目录（子串，或 /正则/）
    { "match": "localhost:5173", "cwd": "/home/simon/my-app", "notes": "Vite + React，组件在 src/components", "machine": "cloud" }
  ]
}
```

修改配置后需要运行 `quick hub restart`，并在 pi 里执行 `/reload` 或新开一个 pi，才会生效。

## 目录结构

```
bin/quick                       CLI 入口
cli/quick.ts                    CLI
hub/server.ts                hub（零依赖 Node HTTP + SSE + tmux）
hub/mesh.ts                  多机互联：链路、ssh 隧道、路由、复制、RPC
hub/dashboard.ts             网页面板
shared/                      配置、数据类型、hub 客户端（hub / CLI / 扩展共用）
shared/update.ts             自动升级：版本来源、安装方式识别、安装、节流与锁
test/                        npm test（升级逻辑 + 多机升级模拟）
extensions/quick-agent.ts    pi 扩展入口（package.json 的 pi.extensions），按角色分流
extensions/front.ts          前台角色
extensions/worker.ts         worker 角色
browser/                     Chrome MV3 插件
```

运行时数据放在 `~/.quick-agent/`：`update.json`（升级检查缓存）、`tasks/<id>/{task.json,events.jsonl,brief.md,run.sh}`、`intake/<id>/{intake.json,*.png}`、`hub.log`。worker 的会话是标准的 pi 会话文件，保存在 `~/.pi/agent/sessions/`，可以用 `pi --session <file>` 打开。

## Hub API（Bearer token）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks`、`/api/tasks/:id?events=N` | 任务列表 / 任务详情 |
| POST | `/api/tasks` | `{title, brief, cwd, machine?, attachments?, source?}` 在指定机器上创建任务并拉起 worker |
| POST | `/api/tasks/:id/message` | `{text}` 追加指令（必要时恢复会话） |
| POST | `/api/tasks/:id/cancel`、`/close`、`/ack` | 中止 / 关闭窗口 / 标记已读 |
| POST | `/api/tasks/:id/report` | worker 上报状态、汇报、活动 |
| GET | `/api/tasks/:id/screen` | worker 终端的实时画面（tmux capture） |
| GET | `/api/machines` | mesh 中的机器、路由与链路状态（含各机器版本） |
| POST | `/api/upgrade` | `{all?, machines?, check?}` 升级或检查指定机器，返回每台的结果 |
| POST | `/api/fs` | `{machine, op: ls/read/grep, path, pattern?}` 远程只读文件访问 |
| GET/POST | `/mesh/link`、`/mesh/send` | hub 之间的链路（mesh secret） |
| GET | `/api/events` | SSE 事件流（`?task=<id>` 用于 worker 接收指令） |
| POST/GET | `/api/intake` | 入口提交（浏览器评论等）/ 列表 |
| GET | `/api/pages?url=` | 某个页面上的评论及其任务状态（插件角标用） |
| GET | `/`、`/extension.zip`、`/health` | 面板 / 插件包 / 健康检查 |

新入口只需要 `POST /api/intake`（交给前台组装上下文）或 `POST /api/tasks`（直接派单）。

## 后续可以做的

- 更多入口：IM 机器人、Git 评论、CI 失败。
- 收件箱优先级、按项目分组、汇报摘要推送。
