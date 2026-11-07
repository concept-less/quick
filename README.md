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
  "defaultCwd": "/home/simon",
  "projects": [
    // 浏览器评论按 URL 匹配工作目录（子串，或 /正则/）
    { "match": "localhost:5173", "cwd": "/home/simon/my-app", "notes": "Vite + React，组件在 src/components" }
  ]
}
```

修改配置后需要运行 `qa hub restart`，并在 pi 里执行 `/reload` 或新开一个 pi，才会生效。

## 目录结构

```
bin/qa                       CLI 入口
cli/qa.ts                    CLI
hub/server.ts                hub（零依赖 Node HTTP + SSE + tmux）
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
| POST | `/api/tasks` | `{title, brief, cwd, attachments?, source?}` 创建任务并拉起 worker |
| POST | `/api/tasks/:id/message` | `{text}` 追加指令（必要时恢复会话） |
| POST | `/api/tasks/:id/cancel`、`/close`、`/ack` | 中止 / 关闭窗口 / 标记已读 |
| POST | `/api/tasks/:id/report` | worker 上报状态、汇报、活动 |
| GET | `/api/tasks/:id/screen` | worker 终端的实时画面（tmux capture） |
| GET | `/api/events` | SSE 事件流（`?task=<id>` 用于 worker 接收指令） |
| POST/GET | `/api/intake` | 入口提交（浏览器评论等）/ 列表 |
| GET | `/api/pages?url=` | 某个页面上的评论及其任务状态（插件角标用） |
| GET | `/`、`/extension.zip`、`/health` | 面板 / 插件包 / 健康检查 |

新入口只需要 `POST /api/intake`（交给前台组装上下文）或 `POST /api/tasks`（直接派单）。

## 后续可以做的

- 跨机器：hub 之间互联，按机器路由 worker（参考 codexhost）。
- 更多入口：IM 机器人、Git 评论、CI 失败。
- 收件箱优先级、按项目分组、汇报摘要推送。
