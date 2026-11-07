# quick-agent

一个 **pi 包**：装好以后，**你平时打开的 pi 就是 quick-agent 的前台 agent**，不需要额外的启动命令。

- **前台 agent**：打开 pi 时默认就是它，终端 TUI 和桌面端等 RPC 客户端都算。它要求 **快**，只负责理解任务、组装上下文、派单。前台模式下只有 `read/grep/find/ls` 和 `qa_*` 工具，其余工具一律拦截。
- **worker agent**：每个任务都有一个独立的负责人，是一个完整的 pi 会话，跑在 tmux 窗口 `qa:<id>` 里，从头到尾把任务做完。它不是 subagent，你随时可以观看或接管。
- **hub**：本地常驻服务，pi 启动时会自动拉起它。负责任务注册表、注意力收件箱、worker 生命周期、入口接入、SSE 事件流，还有一个网页面板（能看 worker 的实时终端）。
- **入口**：pi 本身、浏览器插件（框选元素后写评论）、`qa` CLI，以及任何能发 HTTP 请求的程序。

```
 入口                         前台层                      后台层
 pi (TUI/RPC) ─┐
 浏览器插件 ────┼──► hub ◄────► 你的 pi = 前台 ──qa_dispatch──► worker (pi @ tmux qa:<id>)
 qa CLI ───────┘    (任务/收件箱/SSE/面板)                     ├─► worker …
                    ▲                                          │
                    └──── qa_report / 活动 / 会话 ──────────────┘
```

就像中断处理一样：前台是上半部，只做最少的事，马上返回；worker 是下半部，负责把工作完整做完。

## 安装

```bash
pi install /home/simon/quick-agent     # 写入 ~/.pi/agent/settings.json 的 packages（加载本地目录，不拷贝）
ln -sf /home/simon/quick-agent/bin/qa ~/.local/bin/qa   # 可选：命令行工具
```

卸载用 `pi remove /home/simon/quick-agent`。改了代码以后，在 pi 里执行 `/reload`，或者新开一个 pi，就能生效。

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
qa ls                       # 任务列表（• 表示有未读汇报）
qa show <id>                # 查看汇报、事件、简报
qa send <id> "追加指令"      # worker 窗口关了也会自动用原会话恢复
qa attach <id>              # 切换到 worker 的 tmux 窗口
qa cancel <id> / qa close <id>
qa new --cwd ~/proj "标题" "完整简报"   # 不经前台直接派单
qa hub start|stop|restart|status|logs
qa dashboard | qa tunnel | qa token
```

## 多机互联（mesh）

quick-agent 自带原生的多机互联，不依赖 codexhost。每台机器跑一个 hub，hub 之间组成网状网络：

- **随处派单**：前台的 `qa_dispatch` 可以带上 `machine`，任务和 worker 就跑在那台机器上。附件（截图等）会随请求一起传过去，简报里的路径也会自动改写。
- **全局视图**：每个 hub 都能看到全网的任务。`qa ls`、面板、前台的任务组件都会标出 `@机器`。
- **统一控制**：追加指令、中止、关闭、已读、实时终端（`/peek`、面板）都会自动路由到任务所在的机器。
- **远程只读浏览**：前台用 `qa_remote_fs`（ls/read/grep）在派单前查看别的机器上的代码。
- **评论跨机流转**：任何机器上的浏览器评论，都能被任何一台机器上的前台认领，截图会自动拉到认领方本地。

### 组网

```bash
# 机器 A（例如你的笔记本或主力服务器）
qa mesh init --id laptop --desc "MacBook，前端项目在 ~/code"

# 方式一：A 能 ssh 到 B（B 上已经装好 quick-agent）。一条命令完成：
qa mesh add simon@server-b            # 会在 B 上设置密钥、启动 hub，A 自动维护 ssh 隧道

# 方式二：邀请码
qa mesh invite                        # 在 A 上运行，打印加入命令
qa mesh join <code> --ssh simon@A     # 在 B 上运行（B 能 ssh 到 A）
qa mesh join <code> --url http://A:7788   # 或者 A 的端口可以直接访问

qa machines                           # 查看机器、路由、链路状态
```

### 原理（`hub/mesh.ts`）

| 方面 | 做法 |
|---|---|
| 链路 | 由一方主动往外拨：`GET /mesh/link`（SSE，对端 → 我）加 `POST /mesh/send`（我 → 对端）。只需要一个方向能连通，处在 NAT 后面的笔记本也能加入。链路建立后是双向的。 |
| SSH | peer 写成 `{"ssh": "user@host"}` 时，hub 会自己拉起并维护 `ssh -N -L <空闲端口>:127.0.0.1:<对端 hub 端口>`（BatchMode、断线重连），还会顺带尝试在远端执行 `qa hub start`。 |
| 鉴权 | 全网共享一个 mesh secret（`Authorization: Mesh <secret>`，用 timingSafeEqual 比较），和本地 API token 分开。 |
| 路由 | 距离向量加水平分割，最多 8 跳。比如 A→B←C 的拓扑里，A 会经 B 访问 C；存在直连时优先直连，某条路断了会自动绕行。 |
| 复制 | 任务和评论各有一台归属机器，每次更新带递增的 `rev`，并广播给全网；收到的版本只有比本地新才会应用并继续转发，所以广播一定会结束。新链路建立时会互发一份快照。 |
| RPC | 请求按目标机器 ID 一跳一跳转发，响应沿路由表返回，超时 30 秒。远程方法包括 `task.create/get/message/cancel/close/ack/screen`、`intake.claim/update`、`fs.ls/read/grep`。 |

安全提示：mesh secret 相当于能在全网所有机器上执行 worker（也就是任意代码），请妥善保管。hub 默认只监听 `127.0.0.1`，跨机连接推荐走 ssh 隧道；如果要把 `host` 设成 `0.0.0.0` 直连，一定要配好防火墙或者用 Tailscale 这类内网。

### 本地电脑 + 浏览器的推荐用法

在本地电脑上也装一份 quick-agent，然后运行 `qa mesh join … --ssh <服务器>` 或 `qa mesh add <服务器>`，这样浏览器插件直接连本机的 `http://127.0.0.1:7788`，不用再手动开 ssh 端口转发。评论会进到 mesh，由服务器上的前台认领，再派给对应机器上的 worker。

## 浏览器插件（在本地电脑上用）

1. 在本地电脑上开端口转发，保持开启：`ssh -N -L 7788:127.0.0.1:7788 <user>@<server>`（完整命令和 token 可以在服务器上运行 `qa tunnel` 查看）。
2. 下载插件：<http://127.0.0.1:7788/extension.zip>，解压。
3. 打开 `chrome://extensions`，开启开发者模式，点「加载已解压的扩展程序」，选择解压后的目录。
4. 点插件图标，填 Hub 地址 `http://127.0.0.1:7788` 和 Token（服务器上运行 `qa token` 获取），然后点「保存并测试」。

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
  "mesh": { "secret": "…qa mesh init 生成…", "peers": [ { "ssh": "simon@laptop", "port": 7788 }, { "url": "http://10.0.0.5:7788" } ] },
  "defaultCwd": "/home/simon",
  "projects": [
    // 浏览器评论按 URL 匹配工作目录（子串，或 /正则/）
    { "match": "localhost:5173", "cwd": "/home/simon/my-app", "notes": "Vite + React，组件在 src/components", "machine": "cloud" }
  ]
}
```

修改配置后需要运行 `qa hub restart`，并在 pi 里执行 `/reload` 或新开一个 pi，才会生效。

## 目录结构

```
bin/qa                       CLI 入口
cli/qa.ts                    CLI
hub/server.ts                hub（零依赖 Node HTTP + SSE + tmux）
hub/mesh.ts                  多机互联：链路、ssh 隧道、路由、复制、RPC
hub/dashboard.ts             网页面板
shared/                      配置、数据类型、hub 客户端（hub / CLI / 扩展共用）
extensions/quick-agent.ts    pi 扩展入口（package.json 的 pi.extensions），按角色分流
extensions/front.ts          前台角色
extensions/worker.ts         worker 角色
browser/                     Chrome MV3 插件
```

运行时数据放在 `~/.quick-agent/`：`tasks/<id>/{task.json,events.jsonl,brief.md,run.sh}`、`intake/<id>/{intake.json,*.png}`、`hub.log`。worker 的会话是标准的 pi 会话文件，保存在 `~/.pi/agent/sessions/`，可以用 `pi --session <file>` 打开。

## Hub API（Bearer token）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks`、`/api/tasks/:id?events=N` | 任务列表 / 任务详情 |
| POST | `/api/tasks` | `{title, brief, cwd, machine?, attachments?, source?}` 在指定机器上创建任务并拉起 worker |
| POST | `/api/tasks/:id/message` | `{text}` 追加指令（必要时恢复会话） |
| POST | `/api/tasks/:id/cancel`、`/close`、`/ack` | 中止 / 关闭窗口 / 标记已读 |
| POST | `/api/tasks/:id/report` | worker 上报状态、汇报、活动 |
| GET | `/api/tasks/:id/screen` | worker 终端的实时画面（tmux capture） |
| GET | `/api/machines` | mesh 中的机器、路由与链路状态 |
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
