# quick-agent 桌面客户端（Electron，macOS 优先）

把 quick-agent 的 Web UI 装进一个原生窗口，并按**注意力**来组织：托盘和 Dock 只显示"需要你"的数量；只有需要你的事才会立即通知，完成的汇报合批成汇总；支持专注模式；全局快捷键随时"把一件事交出去"。设计依据见 [`docs/management-philosophy.md`](../docs/management-philosophy.md) 和 [`docs/attention.md`](../docs/attention.md)。

客户端里**没有会话**，也没有任何会话相关的菜单。

## 运行（开发）

前置条件：本机已安装 quick-agent（`quick` 在 PATH 中）、Node ≥ 22.18、pi。

```bash
cd electron
npm install          # 国内网络可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev          # 启动客户端
npm run dev -- --hidden   # 只在菜单栏启动，不弹窗口
npm run check        # 语法检查 + 单元测试
```

启动时，客户端用系统 Node 运行 `src/bootstrap.mjs`，复用 `shared/hub-process.ts` 和 `shared/ui-process.ts`：hub 和 Web UI 服务（`ui/server.ts`，127.0.0.1:7790）已在运行就直接复用，没在运行就在后台拉起。行为和 `quick ui --no-open` 一致，启动前会删掉 `QA_TASK_ID`。退出客户端不会停止 hub、Web UI 服务和 worker。

## 功能

| | |
|---|---|
| **菜单栏托盘** | 标题 `■2` = 2 件事需要你；没有需要你的事时只显示 `□`；专注中显示 `☾`。菜单列出"需要你"的任务（点击直达），以及"已托付/进行中 · N""已完成待扫 · N" |
| **Dock 角标** | 只显示"需要你"的数量 |
| **系统通知** | 只有 worker 提问、受阻、失败、停下时才立即通知，点通知打开对应任务；完成的汇报合批为一条"N 件事已完成待扫"（默认 30 分钟一次，托盘 → 通知设置可改）；进度不通知；窗口在前台时不弹；不出声 |
| **专注模式** | 托盘 → 专注模式（30 分钟 / 1 小时 / 2 小时 / 直到关闭），或 `⌘⇧F` 专注 1 小时。专注时不弹任何通知，结束后汇总一次 |
| **把一件事交出去** | 全局 `⌘⇧Space`：Enter 交给前台 agent，`⌘Enter` 交出去并打开窗口，`Tab` 切换为"直接交给 worker"（第一行作标题），Esc 关闭。交出后焦点回到原来的应用 |
| **注意力导航** | 菜单"注意力"：需要你 `⌘1`、已托付/进行中 `⌘2`、已完成待扫 `⌘3` |
| **深链** | `quick-agent://task/<id>`、`quick-agent://view/need\|inflight\|skim`、`quick-agent://quick`；也可以用 `open -a quick-agent --args --quick` 绑定到 Raycast 或 Alfred |
| **窗口** | 记住位置、大小和最大化状态；关窗口只是隐藏（worker 照常工作）；背景色跟随系统深浅色 |

设置保存在 `~/Library/Application Support/quick-agent/settings.json`（帮助 → 打开客户端设置文件）：`shortcut`、`notifications`、`digestMinutes`、`quiet`、`quickMode`，以及高级选项 `repo`（quick-agent 仓库路径）、`node`（Node 路径）、`cwd`（前台进程的工作目录）。也可以用环境变量 `QA_REPO`、`QA_NODE` 指定。

## 安全

- 窗口开启 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`。只能导航到本地 Web UI 的 origin，外部链接用系统浏览器打开；`webview` 和弹窗一律拒绝；权限请求只放行剪贴板写入。
- **token 不经过页面**：主进程把 hub token 写成 HttpOnly、SameSite=Strict 的 cookie，只对 `http://127.0.0.1:<uiPort>` 生效（cookie 名和 `ui/server.ts` 用 `?token=` 换出来的一样）。URL 里没有 token，页面 JS 也读不到。快速输入窗口只把文字交给主进程，由主进程带 token 去请求 API。
- preload 只在受信页面上暴露 `window.quickDesktop`（本地 Web UI 和客户端自己的状态页），只有几个回调和"重试"；不暴露 `ipcRenderer` 和 Node API。

## 与 Web UI 的约定（需要 Web UI 配合的地方）

客户端不修改 `ui/`。它通过 `window.quickDesktop` 把事件交给页面：

```js
window.quickDesktop.onOpenTask((id) => …)    // 点通知、托盘条目或深链时：打开任务详情
window.quickDesktop.onView((v) => …)         // v = "need" | "inflight" | "skim"：切到对应的注意力分区
window.quickDesktop.onAction((a) => …)       // a = "focus-input"：聚焦"交出去"输入框
```

页面注册之前，客户端会注入兜底处理：调用全局的 `openTask(id)`（Web UI 已有），没有的话改写 `location.hash`（`#task=<id>`、`#view=need|inflight|skim`）；切换分区时优先调用全局的 `qaShowView(v)`。希望 Web UI 做到：

1. 支持 `#task=<id>` 和 `#view=need|inflight|skim`，或者直接调用 `quickDesktop.onView` 和 `onOpenTask` 注册处理函数；
2. 提供全局的 `qaShowView(v)`，或在三个分区上加上可定位的锚点；
3. 三个分区的分类和客户端一致（`electron/src/lib.cjs` 的 `bucket()`）。需要你：`needs_input` / `blocked` / `failed` / `exited` / `idle`；进行中：`starting` / `running`；待扫：`done` 且未读。
4. 可选：把专注模式和"稍后"状态存到 hub，让客户端托盘和 Web UI 保持一致。

## 打包

```bash
npm run icons        # 重新生成图标（需要 Pillow），产物已提交在 assets/
npm run pack         # 只出 .app：dist/mac-arm64/quick-agent.app
npm run dist         # .dmg + .zip：dist/quick-agent-<版本>-arm64.dmg
```

国内网络打包时可加：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

产物是 **ad-hoc 签名**（`mac.identity: "-"`），没有用开发者证书签名，也没有公证。本机可以直接运行；拷到别的 Mac 上，首次打开时需要右键 → 打开，或者执行 `xattr -dr com.apple.quarantine /Applications/quick-agent.app`。

.app 里附带一份 quick-agent 源码（`Contents/Resources/quick-agent`）作为兜底。运行时会优先使用本机安装的 quick-agent（`quick` 所在的仓库），保证与 pi 里安装的扩展版本一致。

### 正式签名与公证

1. 加入 Apple Developer Program，在钥匙串里安装 **Developer ID Application** 证书。
2. 把 `package.json` → `build.mac.identity` 改成证书名（或删除这个字段让 electron-builder 自动查找），并开启 `"hardenedRuntime": true`。Electron 需要的 entitlements 至少包括 `com.apple.security.cs.allow-jit` 和 `com.apple.security.cs.allow-unsigned-executable-memory`，通过 `build.mac.entitlements` 指定 plist 文件。
3. 公证：设置环境变量 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`（或者用 App Store Connect API key：`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`），并在 `build.mac` 里加上 `"notarize": true`，然后运行 `npm run dist`。electron-builder 会签名，用 `notarytool` 提交公证，再把票据 staple 到产物上。
4. 验证：`spctl -a -vv dist/mac-arm64/quick-agent.app`、`xcrun stapler validate dist/*.dmg`。

## 目录

```
electron/
  src/main.cjs          主进程：启动/复用后端、窗口、托盘、通知、专注模式、快捷键、菜单、深链
  src/lib.cjs           纯逻辑：注意力分桶、通知分级与合批、专注模式、窗口位置校验（有单元测试）
  src/bootstrap.mjs     由系统 Node 运行，复用 shared/hub-process.ts、shared/ui-process.ts
  src/preload.cjs       主窗口 preload（window.quickDesktop）
  src/quick.html        "把一件事交出去"输入框；quick-preload.cjs 是它的 preload
  src/status.html       启动中 / 出错页
  assets/               图标（scripts/make-icons.py 生成）
  test/lib.test.cjs     node --test
```
