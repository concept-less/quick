# quick-agent

基于 [pi](https://github.com/earendil-works/pi) 的「前台 / worker」agent 工作流：

- **前台 agent（quick-front）**：唯一和你交互的 agent。它要求 **快**，只负责理解任务、组装上下文、派单。它没有 `bash`、`edit`、`write`，从机制上做不了实际工作。
- **worker agent（quick-worker）**：每个任务都有一个独立的负责人，是一个完整的 pi 会话，跑在自己的 tmux 窗口里，从头到尾把任务做完。它不是 subagent，你随时可以切进去看或者直接接管。
- **hub**：本地常驻服务，负责任务注册表、注意力收件箱、worker 生命周期、入口接入、实时事件流（SSE），还有一个网页面板。
- **入口**：终端里的前台 agent、`qa` CLI、浏览器插件（框选元素后写评论），以及任何能发 HTTP 请求的程序。

```
 入口                         前台层                      后台层
 pi TUI ─────┐
 浏览器插件 ──┼──► hub ◄────► quick-front ──qa_dispatch──► worker (pi @ tmux qa:<id>)
 qa CLI ─────┘    (任务/收件箱/SSE/面板)                    ├─► worker …
                  ▲                                         │
                  └──── qa_report / 活动 / 会话 ─────────────┘
```

就像中断处理一样：前台是上半部，只做最少的事，马上返回；worker 是下半部，负责把工作完整做完。

## 快速开始

```bash
qa front            # 启动 hub，在 tmux 会话 "qa" 里打开前台 agent
```

在前台里直接说要做什么，它会派单并立即回复任务 ID。worker 完成、提问或受阻时：

- 前台编辑器上方的任务组件会更新，并弹出通知；
- 汇报会以 `[quick-agent 汇报]` 消息的形式进入前台对话，但不会打断你，也不会触发新一轮回复；
- `/tasks` 打开任务面板，可以查看汇报、接管（切换到 tmux 窗口）、追加指令、中止或关闭；
- `/attach <id>` 直接跳到某个 worker 的窗口，tmux 里按 `Ctrl-b w` 也能选窗口。

也可以在任何终端里用 CLI：

```bash
qa ls                       # 任务列表（• 表示有未读汇报）
qa show <id>                # 查看汇报、事件、简报
qa send <id> "追加指令"      # worker 窗口关了也会自动用原会话恢复
qa attach <id>              # 切换到 worker 窗口
qa cancel <id> / qa close <id>
qa new --cwd ~/proj "标题" "完整简报"   # 不经前台直接派单
qa hub start|stop|restart|status|logs
qa dashboard                # 网页面板地址
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

修改配置后需要运行 `qa hub restart` 并重新打开前台，才会生效。

## 目录结构

```
bin/qa                       CLI 入口
cli/qa.ts                    CLI
hub/server.ts                hub（零依赖 Node HTTP + SSE + tmux）
hub/dashboard.ts             网页面板
shared/                      配置、数据类型、hub 客户端（hub / CLI / 扩展共用）
extensions/quick-front/      前台 agent 的 pi 扩展（QA_ROLE=front 时生效）
extensions/quick-worker/     worker 的 pi 扩展（QA_TASK_ID 存在时生效）
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
| GET | `/api/events` | SSE 事件流（`?task=<id>` 用于 worker 接收指令） |
| POST/GET | `/api/intake` | 入口提交（浏览器评论等）/ 列表 |
| GET | `/api/pages?url=` | 某个页面上的评论及其任务状态（插件角标用） |
| GET | `/`、`/extension.zip`、`/health` | 面板 / 插件包 / 健康检查 |

新入口只需要 `POST /api/intake`（交给前台组装上下文）或 `POST /api/tasks`（直接派单）。

## 后续可以做的

- 跨机器：hub 之间互联，按机器路由 worker（参考 codexhost）。
- 更多入口：IM 机器人、Git 评论、CI 失败。
- 收件箱优先级、按项目分组、汇报摘要推送。
