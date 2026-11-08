# 上架材料：Chrome Web Store / Edge Add-ons / Firefox AMO

本目录是浏览器插件 `browser/` 的上架材料。打包：`scripts/pack-extension.sh`（产物在 `dist/`，已加入 .gitignore）。

## 1. 能否上架：评估结论

**可以上架 Chrome Web Store。** 理由与风险点：

| 审核关注点 | 现状 |
|---|---|
| 单一用途（Single purpose） | 唯一用途：把网页评论发到用户自己的 quick-agent hub。[OK] |
| 权限最小化 | 必需权限只有 `activeTab`、`scripting`、`storage` + `http://127.0.0.1/*`、`http://localhost/*`。不再常驻注入所有网页，不要 `<all_urls>`、不要 `tabs`。"所有网站"改为 `optional_host_permissions`，默认关闭、用户在弹窗主动开启。[OK] |
| 远程代码 | 无 `eval` / `new Function` / 远程脚本，全部代码打包在 zip 内。打包脚本会自动检查。[OK] |
| 连接 localhost | 允许。需在描述与隐私政策中说明数据只发往用户本机 / 用户配置的 hub。[OK]（见下文与 PRIVACY.md） |
| 用户数据（截图、URL、页面内容） | 属于"网站内容 / 网页浏览活动"，需在 Privacy practices 中如实勾选并提供隐私政策 URL。[OK] |
| 可测试性 | 审核员没有 hub 时插件只能显示"连不上 hub"。**建议**在"测试说明（Test instructions）"中写清安装 hub 的方法（见 §4），否则可能因"功能无法使用"被拒。[!] |
| 隐私政策需公网可访问 | `docs/browser-extension/PRIVACY.md` 需要放在公开 URL（GitHub 仓库必须是 public，或用 GitHub Pages / Gist）。[!] 人类确认 |

**Edge Add-ons**：同一个 Chrome zip 可直接提交，注册免费（Partner Center），审核通常 ≤7 个工作日。快捷键 Ctrl+Shift+E 在 Edge 中若与内置快捷键冲突，用户可在 `edge://extensions/shortcuts` 修改。容易，推荐一起上。

**Firefox (AMO)**：打包脚本额外生成 `*-firefox.zip`（background 改为 event page `scripts`、加 `browser_specific_settings.gecko.id`，最低 Firefox 128，用于 `scripting.executeScript` 的 `world: "MAIN"`）。注意：Firefox MV3 中 host 权限默认需用户手动授予（包括 localhost），首次需在 about:addons 里允许；AMO 会人工审核源码（本插件未压缩/未混淆，直接通过）；免费。**中等难度：未在 Firefox 中实测，建议先自测（about:debugging → 临时载入附加组件）再提交。**

## 2. 商店文案

### 名称
`quick-agent comments`

### 简介（Summary，≤132 字符，与 manifest description 一致）
在网页上框选元素、写评论，发送到你自己运行的 quick-agent hub，交给 AI 编程助手处理。数据只发往你配置的 hub。

English: Select elements on any page, write a comment, and send it to your own self-hosted quick-agent hub for your AI coding agent. Data stays with your hub.

### 类别
Developer Tools（开发者工具）

### 详细描述（中文）

```
quick-agent comments 是开源项目 quick-agent（https://github.com/concept-less/quick）的配套浏览器插件。

在开发网页时，看到哪里不对，直接在页面上指出来：
• 按快捷键（Mac：⌘⇧E，Windows/Linux：Ctrl+Shift+E）或点击工具栏图标进入框选模式；
• 点击元素即可评论，Shift+点击多选，或拖出一个矩形框选区域；
• 写下评论，⌘/Ctrl+Enter 发送。

插件会把评论连同上下文——页面 URL、元素选择器和 XPath、HTML 片段、可见文本、带红框标注的截图、页面控制台错误——发送到你自己运行的 quick-agent hub，由你的 AI 编程助手定位源码并修改。评论是一次性的：发送后页面上不留任何标记，进展在 quick-agent 里查看。

隐私：
• 数据只发送到你在插件中配置的 hub（默认是本机 127.0.0.1），开发者没有任何服务器，不收集任何数据；
• 无统计、无广告、无远程代码；
• 默认只在你主动触发时访问当前标签页；"在所有网站自动恢复草稿"是可选功能，默认关闭。

使用前需要先安装并启动 quick-agent hub，详见项目主页。快捷键可在 chrome://extensions/shortcuts 修改。
```

### Detailed description (English)

```
quick-agent comments is the companion extension of the open-source quick-agent project (https://github.com/concept-less/quick).

Point at what's wrong, right on the page:
• Press ⌘⇧E (Mac) / Ctrl+Shift+E (Windows/Linux) or click the toolbar icon to start picking;
• Click an element to comment, Shift+click to select several, or drag a rectangle to select a region;
• Write your comment and press ⌘/Ctrl+Enter.

The comment is sent with its context — page URL, selector and XPath, HTML snippet, visible text, an annotated screenshot and the page's console errors — to the quick-agent hub that YOU run, where your AI coding agent locates the source and fixes it. Comments are one-shot: once sent, nothing stays on the page; follow the progress in quick-agent.

Privacy:
• Data goes only to the hub address you configure (default: 127.0.0.1 on your own machine). The developer runs no server and collects nothing.
• No analytics, no ads, no remote code.
• By default the extension only accesses the current tab after you invoke it. "Restore drafts on all sites" is optional and off by default.

Requires a running quick-agent hub — see the homepage. Change the shortcut at chrome://extensions/shortcuts.
```

## 3. Privacy practices 表单（Chrome 开发者后台 → Privacy 标签）

**Single purpose description**
> Send the user's comments about elements on a web page, with page context and a screenshot, to the user's own self-hosted quick-agent hub so the user's AI coding agent can act on them.
> 把用户对网页元素的评论（附页面上下文与截图）发送到用户自己部署的 quick-agent hub，交给用户的 AI 编程助手处理。

**Permission justifications**

| 权限 | Justification（可直接粘贴） |
|---|---|
| `activeTab` | Used only after the user presses the shortcut or clicks the toolbar button: injects the element-picker UI into the current tab and captures a screenshot of the visible tab to attach to the comment. |
| `scripting` | Injects the bundled picker script (content.js) and the console-error recorder (console-hook.js) into the current tab on demand; and, only if the user opts in to "all sites" mode, registers them as content scripts. No remote code. |
| `storage` | Stores the user's hub URL and access token locally. |
| Host permission `http://127.0.0.1/*`, `http://localhost/*` | Sends comments to, and reads comment status from, the quick-agent hub running on the user's own computer (default http://127.0.0.1:7788). |
| Optional host permission `http://*/*`, `https://*/*` | Off by default; requested only when the user enables the "all sites" option in the popup. Lets the extension restore unsent comment drafts on pages the user revisits and record console errors from page load. Can be revoked at any time. |
| Remote code | No — all JavaScript is included in the package. |

**Data usage（勾选）**
- 勾选：**Website content**（页面文本、HTML、截图）、**Web history**（页面 URL 会随评论发送）。
- 若审核要求也可勾选 **Authentication information**（用户填写的 hub token，仅本地保存并只发往用户的 hub）。
- 其余（个人身份、健康、金融、位置、通信、用户活动）不勾选。
- 三项声明全部勾选：不出售给第三方 / 不用于与单一用途无关的目的 / 不用于信用评估。

**Privacy policy URL**：`https://github.com/concept-less/quick/blob/main/docs/browser-extension/PRIVACY.md`（仓库需公开）

## 4. 测试说明（Test instructions，给审核员）

```
This extension talks to a self-hosted local server (quick-agent hub). To test:
1. Install Node.js >= 22.18 and pi, then follow https://github.com/concept-less/quick#readme to install quick-agent and run `quick hub start` (listens on http://127.0.0.1:7788).
2. Run `quick token` to print the access token.
3. Click the extension icon → "连接设置" (Connection settings), keep hub URL http://127.0.0.1:7788, paste the token, click "保存并测试" (Save & test). It shows "已连接 hub" (connected).
4. Open any web page, press Ctrl+Shift+E (⌘⇧E on Mac) or click "在当前页面框选评论", click an element, type a comment and press Ctrl+Enter. The comment appears in the hub dashboard (button "打开任务面板").
Without a hub the popup shows a "cannot reach hub" message; that is expected.
```

（如果嫌审核员装 hub 太麻烦，可以录一个 30 秒演示视频上传到 YouTube（不公开）并把链接附在测试说明里。）

## 5. 图片素材清单

| 素材 | 尺寸 | 是否必需 | 状态 |
|---|---|---|---|
| 商店图标 | 128×128 PNG（建议图形 96×96 + 四周 16px 透明边距） | 必需 | `browser/icon128.png` 可用；当前为满幅圆角方块，审核可接受，有时间可按 96+16 规范重画 |
| 截图 | 1280×800 或 640×400，PNG/JPEG，1–5 张 | 至少 1 张 | [!] 需人工截取。建议：①元素高亮 + 工具条；②评论框；③发送后的提示；④弹窗（已连接状态，拼到 1280×800 画布上）；⑤Web UI 里由评论生成的任务（来源页面 + 截图） |
| 小宣传图（Small promo tile） | 440×280 PNG/JPEG | 必需 | [!] 需制作 |
| 大宣传图（Marquee） | 1400×560 | 可选 | — |
| Edge：Logo | 300×300（推荐）/ 截图 1280×800、宣传图 440×280 等同 Chrome | Logo 必需 | [!] 用 icon 放大重绘 |
| Firefox | 图标从包内读取；截图可选 | — | — |

截图注意：不要出现真实 token、私有代码或他人信息；截图里的界面语言与商店语言一致。
