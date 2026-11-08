# quick-agent comments 浏览器插件 — 隐私政策 / Privacy Policy

最后更新：2026-11-08

## 中文

**quick-agent comments**（下称"本插件"）是 quick-agent 的配套工具：用户在网页上框选元素、写下评论，本插件把评论连同页面上下文发送到 **用户自己运行并在插件中配置的 quick-agent hub**（默认 `http://127.0.0.1:7788`，即用户本机），由用户自己的 AI 编程助手处理。

### 收集哪些数据、何时收集

只有在用户**主动**按下快捷键或点击插件按钮、选中元素并点击"发送"时，本插件才会读取并发送以下内容：

- 用户写下的评论文字；
- 当前页面的 URL、标题；
- 所选元素的 CSS 选择器、XPath、标签名、属性、可见文本和 HTML 片段（单个元素最多 3000 字符）；
- 视口尺寸、滚动位置、设备像素比、浏览器 User-Agent；
- 当前标签页可见区域的截图及选区裁剪图（用户可在评论框中取消勾选"附带截图"）；
- 页面在本插件注入之后（或开启"所有网站"模式后自页面加载起）产生的最多 50 条控制台错误。

本插件在本地（`chrome.storage.local`）保存用户填写的 Hub 地址和 Token，不会同步到云端。

### 数据发往哪里

- 所有数据**只**发送到用户在插件设置中填写的 hub 地址。默认是本机 `127.0.0.1`；如果用户填写了其他地址（例如通过 ssh 端口转发或内网访问自己的服务器），数据就发往该地址。
- 本插件**没有**开发者运营的服务器，**不**向开发者或任何第三方发送数据，**不**包含统计分析、广告或追踪代码，**不**加载远程代码。
- hub 是用户自行部署的开源软件，数据在 hub 上如何存储和处理（保存在 hub 所在机器的 `~/.quick-agent/` 下，并交给用户自己配置的 AI 模型服务处理）由用户自行控制。

### 数据使用限制

- 数据仅用于实现插件的唯一用途：把用户的网页评论交给用户自己的 AI 编程助手处理。
- 不出售、不转让数据，不用于广告、信用评估或与该用途无关的目的。

### 权限

- `activeTab` + `scripting`：仅在用户按快捷键或点击插件后，向当前标签页注入框选界面并截图。
- `storage`：保存 Hub 地址和 Token。
- `http://127.0.0.1/*`、`http://localhost/*`：与本机 hub 通信。
- 可选的"所有网站"权限（默认关闭，用户在弹窗中主动开启，可随时关闭）：在用户访问的页面自动恢复未发送的评论草稿，并从页面加载起记录控制台错误。

### 联系方式

问题与反馈：<https://github.com/concept-less/quick/issues>

---

## English

**quick-agent comments** ("the extension") lets you select elements on a web page, write a comment, and send it to **your own quick-agent hub** that you run and configure (default `http://127.0.0.1:7788`, i.e. your own computer), where your own AI coding agent handles it.

**What is collected, and when.** Only when you explicitly trigger the extension (keyboard shortcut or toolbar button), select elements and press "Send": your comment text; the page URL and title; selector/XPath/tag/attributes/visible text/HTML snippet of the selected elements; viewport size, scroll position, device pixel ratio and user agent; a screenshot of the visible tab and a crop of the selection (can be turned off per comment); up to 50 console errors recorded on the page. To show status pins for comments you already sent, the extension asks your hub for comments on the current page URL. The hub URL and token you enter are stored locally in `chrome.storage.local`.

**Where data goes.** Exclusively to the hub address you configure (default: localhost). The developer operates no server and receives no data. No analytics, ads, tracking or remote code. How the hub stores/processes data is under your control (it is self-hosted open-source software).

**Limited use.** Data is used solely to deliver your comments to your own coding agent. It is never sold, transferred, or used for advertising, creditworthiness, or unrelated purposes.

**Permissions.** `activeTab` + `scripting` (inject the picker / take a screenshot only after you invoke the extension), `storage` (hub URL and token), `http://127.0.0.1/*` and `http://localhost/*` (talk to the local hub). Optional "all websites" access is off by default; if you turn it on in the popup, comment pins appear automatically and console errors are recorded from page load. You can turn it off any time.

**Contact:** <https://github.com/concept-less/quick/issues>
