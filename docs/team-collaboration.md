# 团队协作：几个人加几台机器上的 agent，共用一个工作区

> 状态：设计 + MVP 已实现（`hub/team.ts`、`shared/team.ts`、`test/team.test.ts`）。
> 前置阅读：[`management-philosophy.md`](management-philosophy.md)（为什么以注意力为中心）。注意力模型本身（`shared/attention.ts`、`/api/attention`、打扰策略）由 td9fa 落地，本文的「按人计算注意力」建在它上面。

---

## 0. 结论先行

quick-agent 原来是单人工具：一个人类、一个前台、一群 worker，机器组成 mesh。团队版只加三样东西，并且都服从注意力管理：

1. **成员**：hub 认识多个人。每人一个 user token（`qau_…`），通过邀请码加入，角色只有 `owner` 和 `member`。整个 mesh 是一个团队，机器可以标注所有者。
2. **任务上的人**：每个任务记录发起人（requester）、负责人（assignee，默认是 agent worker，也可以转给一个人）、验收人（reviewer，被请来验收、拍板的人）和关注者（watchers）。任务下可以评论，`@某人` 会进入对方的「需要你」。
3. **按人计算的注意力**：同一个任务对不同的人处在不同的注意力层级。hub 用请求的 token 识别「你是谁」，`/api/attention` 只返回「需要你」的事；另有一个默认不打扰的「团队」视图，能看到所有进行中的事。

刻意不做：多工作区、admin 角色、邮件/OAuth 登录、命名的 agent 档案和小队、看板和自定义状态、活动流、会话式对话、按类型配置通知。理由见第 4 节。

---

## 1. multica 是怎么做的

源码：cloud 机器 `/home/simon/multica`（`apps/docs/content/docs/*.zh.mdx`、`server/migrations/*.sql`、`server/internal/*`）。

### 1.1 工作区、成员和角色

- **工作区**是最上层边界：成员、任务、项目、智能体、skill、执行记录都属于一个工作区，彼此不通。一个账号可以加入多个工作区。工作区有一段「上下文」，提供给工作区里的每个智能体。
- **角色**三种：`owner`、`admin`、`member`（表 `member(workspace_id, user_id, role)`）。角色**只管工作区设置和团队管理**；建任务、评论这类日常协作对所有成员开放。必须始终保留至少一名 owner。
- 移除成员时，他的任务和评论保留，但他拥有的运行时会被停用，绑定的智能体被归档。

### 1.2 认证和邀请

- 浏览器：邮箱验证码或 Google 登录，JWT 放在 HttpOnly cookie 里，30 天滑动续期。
- CLI 和守护进程：个人访问令牌 PAT（`mul_` 前缀），服务器只存哈希和前几位，完整值只显示一次。
- 智能体执行时：服务器为每次运行签发临时令牌（`mat_`），绑定用户、工作区、智能体和这次运行，最长 24 小时。智能体的请求记作智能体的行为，拿不到用户的 PAT。
- 邀请：owner/admin 填邮箱和角色，7 天有效（表 `workspace_invitation`）；另有可以转发的「分享链接」，选定角色和有效期，拿到的人都能加入。

### 1.3 指派、agent 作为成员

- 任务的负责人可以是**成员、智能体或小队**（`issue.assignee_type`）。指派给成员只改归属，指派给智能体会创建一次「运行」。
- **智能体是一份配置**：名称、头像、指令、skills、运行时、模型、Access（谁能运行它：仅自己 / 指定成员 / 整个工作区）。它不常驻，只在被触发时执行。
- **运行时**是执行的地方（一台电脑上的一款 coding 工具），默认私有，所有者可以公开或开放给指定成员。
- **小队**：一个 leader 智能体加若干成员，指派给小队时先唤醒 leader，由它在评论里 `@` 合适的成员。
- 智能体开始工作时把状态改为 `in_progress`，交付后改为 `in_review`，由人验收。

### 1.4 评论、讨论、@提及

- 评论挂在任务下，可以回复成嵌套讨论，可以「解决」讨论、设结论、从评论拆子任务，有表情反应。
- `@成员`：对方收件箱收到提及；`@智能体`：为它创建一次运行，不改负责人；`@all`：通知全体成员。
- 提及是结构化的：`[@名字](mention://member/<uuid>)`，纯文本 `@name` 不算。
- 不含 @ 的回复会按上下文路由：回复智能体的评论就交给它，否则交给任务的智能体负责人。`/note` 开头表示只是人之间的备注。
- 给正在运行的智能体插话（steer），或本轮结束后再处理。

### 1.5 看板、状态流转、活动流

- 内置 7 个状态，分 4 类：`backlog`/`todo`（未开始）、`in_progress`/`in_review`/`blocked`（已开始）、`done`、`cancelled`。可以加自定义状态、自定义属性、工作流（每一步交给谁）。
- 视图：列表、看板、表格、甘特图、泳道；可以保存视图。
- `activity_log` 表记录每个变化（谁、对哪个任务、做了什么），任务详情里展示。

### 1.6 多人通知和收件箱

- 收件箱只面向成员，智能体没有收件箱。
- 自动订阅：创建者、新负责人、评论的人、在描述里被 @ 的人。订阅者收到评论、状态、负责人等变化。
- 自己的操作不通知自己；同一任务的多条通知合并成一项；任务交回给人之后，「运行失败」通知自动归档（`blocked` 除外）。
- `inbox_item.severity` 分 `action_required` / `attention` / `info`；设置里可以按六类开关通知。

### 1.7 共享技能、知识复用

- 工作区 skill：`SKILL.md` 加支持文件，可以手动建、从本地/URL 导入、从运行时复制；挂给多个智能体共用。任何成员可以创建，创建者和 owner/admin 可以修改。
- 工作区「上下文」写团队背景和长期约定，每个智能体执行时都能看到。

### 1.8 权限

- 角色管团队与设置；**Access 管谁能运行哪个智能体**，owner/admin 也不能绕过。
- 运行时默认私有：在别人的电脑上跑智能体用的是对方的机器和凭据，所以共享由所有者决定。
- 评论作者和 owner/admin 可以编辑、删除评论；任何成员可以删除任务。

---

## 2. 哪些适合 quick-agent

判断标准只有一条：**它会不会让人多看一眼不需要看的东西**。注意力是稀缺资源（见 management-philosophy.md），团队功能如果做成「大家都能看到所有动静」，就违背了 quick-agent 的核心。

| multica 能力 | 取舍 | 理由 |
|---|---|---|
| 工作区边界 | 改造：**一个 mesh 就是一个团队** | quick-agent 本来就以 mesh 为整体（任务全网复制）；多工作区对小团队是负担 |
| owner/admin/member | 改造：只要 **owner / member** | 小团队里 admin 和 owner 的区别没有意义；日常协作对 member 全开放，这一点照搬 |
| PAT 哈希存储、完整值只显示一次 | 照搬 | 简单、安全，适合 CLI 和 pi |
| 邮件邀请、分享链接 | 改造：**一次性邀请码**，7 天过期 | 没有邮件服务；邀请码 = 加入凭证，用过即失效 |
| 浏览器登录 cookie | 已有 | Web UI 原本就把 token 换成 HttpOnly cookie |
| 智能体执行临时令牌 | 改造：worker 用所在机器的 hub 凭据，身份记为 `agent`（任务的 worker） | worker 只和自己机器的 hub 说话，hub 知道它属于哪个任务 |
| 负责人可以是成员或智能体 | 照搬 | 默认负责人是 agent worker；可以转交给一个人 |
| 交付后 `in_review` 由人验收 | 照搬为 **reviewer** | 「请 Alice 验收」是团队里最常见的协作 |
| 智能体档案（指令、模型、skills、Access）、小队 | 不做 | quick-agent 的 agent 是「每个任务一个负责人」，不是常驻角色；能力差异落在**机器**上（资源标签、优先级、所有者），前台按资源选机器 |
| 评论、@成员 | 照搬（精简） | 讨论留在任务上，不留在某个人的聊天里 |
| @智能体 | 改造：`@worker` 把评论转给这个任务的 worker | 不加 @ 的评论是人之间的话，**不打扰 worker** |
| 嵌套回复、解决讨论、表情、批注、从评论拆子任务 | 不做 | 平铺评论足够小团队用；都是阅读负担 |
| 看板、自定义状态、属性、工作流、甘特图 | 不做 | 状态由注意力模型统一定义（需要你 / 待扫 / 稍后 / 不用管 / 已归档）；「团队」视图按「球在谁手里」分组，代替看板 |
| 活动流 | 不做成流 | 事件仍记在任务的 events 里，打开任务时可查；**没有全局动态页** |
| 收件箱 + 订阅 + 合并 | 改造为**按人计算的注意力** | 收件箱不存消息，而是从任务状态实时算出来；同一任务永远只占一项 |
| 「自己的操作不通知自己」 | 照搬 | 你派的、你评论的、你 @ 别人的，都不会进你的「需要你」 |
| 交回给人后自动归档失败通知 | 已有 | 注意力模型本来就按任务当前状态算 |
| 按类型开关通知 | 不做 | 打扰策略集中在 hub（只有「需要你」立即打断），不让每个人调 |
| 共享 skills、工作区上下文 | 后续（第 5 节） | 有价值，但不在 MVP |
| 运行时私有/公开 | 后续 | MVP 里团队机器默认共享；机器可以标注所有者，前台据此理解「Bob 的机器」 |

---

## 3. 适配后的方案

### 3.1 身份和成员

**数据**（每台 hub 的 `~/.quick-agent/team.json`，通过 mesh 复制到全网）：

```ts
interface Member {
  id: string;            // 短 id，小写字母数字和连字符，如 "alice"，@ 提及用它
  name: string;          // 显示名
  role: "owner" | "member";
  tokenHash: string;     // sha256(token)，完整 token 只在创建时返回一次
  tokenHint: string;     // token 前 8 位，便于辨认
  createdAt: number; updatedAt: number; rev: number;
  removed?: boolean;     // 墓碑：移除后 token 立即失效，历史记录保留
}
interface Invite { id; codeHash; role; by; createdAt; expiresAt; usedBy?; revoked?; updatedAt; rev }
```

- 复制：成员和邀请都是单独的记录，按 `(updatedAt, rev)` 后写胜，经 mesh `flood` 传播，新链路建立时互相发快照（和任务复制一样）。成员变更很少，后写胜足够。
- **三种凭据**：
  - 机器 token（`config.json` 的 `token`）：这台机器的根凭据，worker、本机 CLI、本机 Web UI 都用它。它的身份是**机器所有者**（`machine.owner`）；没有设置所有者时是「root」，看到的就是今天单人版的全部任务。
  - user token（`qau_…`）：一个成员的凭据，可以连全网任意一台 hub。
  - mesh secret：hub 之间互信，不变。
- **团队的建立**：

```bash
quick team init simon --name "Simon"      # 在第一台机器上：建 owner，并把本机的所有者设为 simon
quick team invite                          # owner 生成一次性邀请码（默认 member，7 天）
# 在 Alice 的电脑上（或任何能访问 hub 的地方）：
quick team join http://hub:7788 <邀请码> alice --name "Alice"
#   → 拿到 user token，保存到她的 config.json 的 client 段；之后她的 pi 前台、quick CLI、Web UI 都以 alice 的身份连这个 hub
quick team ls                              # 成员、角色、拥有的机器
quick team add bob --name Bob              # owner 直接加人（返回 token，转交给 Bob）
quick team role bob owner | quick team remove bob | quick team token bob --reset
quick machine set --owner alice            # 标注机器所有者（已在 mesh 里有自己 hub 的成员用这个）
```

- 两种加入方式：
  1. **没有自己的 hub**：`quick team join` 把 `client: { hub, token, user }` 写进 config；`HubClient` 优先用它（worker 进程除外，worker 永远连本机 hub），`ensureHub` 不在本机起 hub。
  2. **有自己的 hub 在 mesh 里**：`quick machine set --owner alice`，她本机的机器 token 就代表 alice。
- **权限**（`shared/team.ts` 的 `can()`）：

| 操作 | owner | member | root（未设所有者的机器 token） |
|---|:-:|:-:|:-:|
| 派单、评论、转交、请人验收、关注、查看全部任务和团队视图 | ✓ | ✓ | ✓ |
| 确认（知道了）、稍后、回答：只对「球在自己手里」的任务生效 | ✓ | ✓ | ✓ |
| 邀请、加人、改角色、移除、重置别人的 token | ✓ | — | ✓ |
| 配置机器、全网升级 | ✓ | — | ✓ |
| 最后一名 owner 不能被降级或移除 | | | |

### 3.2 任务上的人

`Task` 新增字段（随任务一起全网复制，由任务所在机器的 hub 修改）：

```ts
requester?: string;    // 发起人：派单请求的身份
assignee?: string;     // 负责人：缺省 = 这个任务的 agent worker；设为成员 id 表示转交给这个人
reviewer?: string;     // 验收人：worker 交回（完成、提问、受阻）时球到这个人手里
watchers?: string[];   // 关注者：只出现在他们的「关注」里，永不打扰
pings?: Ping[];        // 点名：指派、@提及、请验收、验收结果……每人确认后清除
comments?: number; lastComment?: { id; author; text; ts };
```

**球在谁手里（holder）**是整个设计的核心概念：

```
worker 在跑（starting/running/handoff）        → 球在 agent 手里，所有人「不用管」
负责人是一个人（assignee）                       → 那个人
否则，有验收人（reviewer）                       → 验收人
否则                                            → 发起人（requester）
都没有（老任务 / root 派的）                     → 团队的 owner（单人版里就是你自己）
```

操作：

| 说法 | API | 效果 |
|---|---|---|
| 「让 Alice 验收」 | `POST /api/tasks/:id/assign {reviewer:"alice"}` | 设验收人，点名 Alice（`review`）。worker 已交回时立刻进 Alice 的「需要你」；还在跑就等交回时再进 |
| 「交给 Bob」（转交给人） | `{assignee:"bob"}` | Bob 成为负责人，点名 Bob（`assign`）；worker 之后的汇报都交给 Bob |
| 「交回给 agent」 | `{assignee:null}` | 负责人回到 worker；给 worker 发追加指令（`send`）时会自动交回 |
| 「抄送 Carol」 | `{watchers_add:["carol"]}` | Carol 只在「关注」里看到 |
| 「交给 Bob 的机器做」 | `qa_dispatch {machine:<Bob 的机器>}` | 只是选机器，人不变；机器列表里有所有者 |
| 派单时直接定好 | `POST /api/tasks {reviewer, assignee, watchers}` | 同上 |

验收闭环：验收人对一个已完成的任务点「知道了」= **验收通过**，任务归档；发起人收到一条「待扫」的 `verdict`（「Alice 已验收」），不打断。验收人给 worker 发追加指令 = 返工，worker 做完又交回给验收人。

### 3.3 评论和 @提及

- 评论存在任务所在机器的 `tasks/<id>/comments.jsonl`，`GET /api/tasks/:id` 一并返回最近的评论；`POST /api/tasks/:id/comments {text}` 会被转发到任务所在的 hub。
- 提及按文本解析：`@成员id` 或 `@显示名`（不区分大小写，匹配团队名册）；`@all` 点名全体成员；`@worker`（或 `@agent`）把这条评论作为追加指令转给任务的 worker。没有匹配到的 `@xxx` 原样保留，不报错。
- 每个被 @ 的人（作者自己除外）得到一个 `mention` 点名，进他的「需要你」，理由一行：「Alice @你：这个接口要不要兼容旧版？」。他确认（知道了）或回复评论后清除。
- 作者自动成为关注者；被 @ 的人不自动关注（和 multica 一致：提及是一次性的叫人，不是订阅）。
- **worker 也能 @人**：worker 多了一个 `qa_comment` 工具，作者记为 `agent`。比如「@alice 这里两种方案你选哪个？」。worker 的 `qa_report(needs_input)` 依旧进 holder 的「需要你」，`qa_comment` 用于点名某个具体的人。
- 不带 @ 的评论只是留言：记在任务上，不进任何人的「需要你」，不打扰 worker。

### 3.4 按人计算的注意力

建立在 td9fa 的注意力模型上：`shared/attention.ts` 的 `attentionOf(task)` 算出任务的基础层级（需要你 / 待扫 / 稍后 / 不用管 / 已归档）；团队层（`shared/team.ts` 的 `personalAttention(task, viewer, base)`）再决定**对这个人**它在哪一层：

1. 这个人有未确认的点名 → `assign` / `review` / `mention` 是「需要你」，`verdict` 是「待扫」。标记 `[@]` `[ASSIGNED]` `[REVIEW]` `[VERDICT]`。
2. 这个人就是 holder → 用基础层级；验收人面对一个已完成待扫的任务时升级为「需要你」（`[REVIEW] 请你验收`）——请人验收本身就是要他拍板。
3. 这个人是参与者（发起、负责、验收、关注）但球不在他手里 → 基础层级是需要你/待扫/稍后时改为「不用管」，理由写清楚「等 Alice 验收」；其余照基础层级。
4. 和他无关 → 不在他的队列里，只在团队视图里。

确认（`ack`）也按人：清掉这个人在该任务上的点名；只有 holder 的确认才会把任务标为已读（`unread=false`）。别人点「知道了」不会替 holder 做决定。

接口：

- `GET /api/attention`：按 token 识别身份，返回这个人的队列（`items` 已排序、`counts`）。root 身份仍是全部任务（单人版行为不变）；`?user=alice` 只有 owner/root 可以用（排查用）。
- `GET /api/attention?scope=team`：**团队视图**，所有未归档的任务，带 `holder`、`requester`、`assignee`、`reviewer`，按「球在谁手里」分组。没有打扰，前端默认不显示，需要时切过去。
- SSE：每个连接带着自己的身份，`attention` 事件按连接的身份逐个计算，`interrupt` 也按人算（Alice 的「需要你」只打断 Alice）。`task` 事件不变（团队视图需要）。
- 自己的操作不打断自己：点名的发起者就是自己时不生成点名；自己派的任务交回给自己仍然照常（那是你派的事）。

前端：pi 前台、Web UI、Electron 都通过 token 拿到「自己的」队列，渲染逻辑不变；Web UI 增加「团队」视图、任务详情里的评论区和「负责 / 验收 / 关注」行。

### 3.5 前台 agent 知道团队

- 系统提示里加一段「团队」：你在为谁工作、成员名册（id、名字、角色、拥有的机器），以及规则：
  - 「让 Alice 验收 / 拍板」→ 派单时传 `reviewer`，或对已有任务用 `qa_task_assign`。
  - 「转给 Bob 处理」→ `qa_task_assign {assignee:"bob"}`。
  - 「交给 Bob 的机器做」→ 按机器列表里的所有者选 `machine`，人不变。
  - 「问问 Carol」「告诉 Alice」→ `qa_comment`，正文里 `@carol`。
  - 名字对不上名册时先问人类，不要猜。
- 工具：`qa_dispatch` 增加 `reviewer`、`assignee`、`watchers`；新增 `qa_task_assign`、`qa_comment`；`qa_tasks` 增加 `scope: mine | team`；`qa_machines` 显示机器所有者。
- 汇报的投递：td9fa 里「哪个前台主动告诉人类」由 hub 的 `pickFront` 决定；团队版只在**这个人的前台**之间选（前台连接带着身份）。

### 3.6 定时任务（tb605）

计划也有所有者：创建计划的身份记为 `owner`，计划触发的任务以它为 `requester`（结果进计划所有者的队列）。计划创建时也可以带 `reviewer`/`watchers`，原样传给派单。

---

## 4. 刻意没做的 multica 能力

| 能力 | 为什么不做 |
|---|---|
| 多工作区、切换工作区 | 一个 mesh 一个团队。真要隔离，就起两套 mesh |
| admin 角色 | 三五个人的团队，owner/member 足够；角色越多越要解释 |
| 邮箱验证码、Google 登录、会话续期 | 需要邮件服务和公网登录页；token + 邀请码对开发者团队足够，Web UI 已经把 token 换成 HttpOnly cookie |
| 命名的智能体（指令、模型、头像、Access）、小队 | quick-agent 的 agent 是「这个任务的负责人」，用完即走；能力差异体现在机器（资源标签、优先级、所有者）上，前台按资源选机器。做命名智能体会引入「去找哪个 agent 聊」的会话心智 |
| 对话（Chat） | quick-agent 没有会话；一切都是「把一件事交出去」 |
| 看板、自定义状态、工作流、属性、甘特图、保存视图 | 状态只表达「需不需要你」。团队视图按「球在谁手里」分组，一屏看完；更多维度就是更多需要看的东西 |
| 全局活动流 | 这正是注意力管理要消灭的信息流。事件仍在每个任务的 events 里，需要时打开任务看 |
| 收件箱消息列表、已读/未读每条消息、归档 | 「需要你」由任务状态实时算出，同一任务只占一项；不存在需要逐条清理的消息 |
| 按类型开关通知 | 打扰策略只有一条（只有「需要你」立即打断），集中在 hub；个人可调会让团队里每个人的「需要你」含义不同 |
| 嵌套讨论、解决讨论、表情反应、批注、编辑冲突合并、从评论拆子任务 | 小团队的任务评论数量不多，平铺足够；这些功能都在增加阅读量 |
| `@all` 之外的群组提及、子任务阶段唤醒 | 后续需要时再加 |
| 运行时私有/指定成员 | MVP 默认团队机器共享（mesh 本来就是互信的）。机器可以标所有者，前台理解「Bob 的机器」。真正的访问控制见第 5 节 |
| 评论编辑和删除 | MVP 只追加，避免复制冲突；写错了再评论一条 |

---

## 5. 后续

1. **共享技能**：团队 skills 目录（例如 `~/.quick-agent/team-skills/`），mesh 同步（按文件哈希，后写胜），hub 启动 worker 时把它加入 pi 的 skills 路径。任何成员可以加，创建者和 owner 可以改。worker 完成后可以建议把做法沉淀成 skill，由人确认。
2. **团队上下文**：一段所有 worker 都会看到的团队约定（multica 的工作区上下文），附在 brief 后面。
3. **机器访问控制**：机器 `access: "team" | "owner" | string[]`，派单时校验 requester。
4. **评论驱动的返工**：验收人在评论里写「返工：…」并 @worker，worker 继续做完后交回验收人。现在可以用 `@worker` 手工做到。
5. **团队专注模式**：专注状态现在是 hub 级的（td9fa），可以改成按人。
6. **通知投递到人的设备**：成员的 Electron 客户端连远程 hub 时，系统通知只发给那个人（现在已经是按连接身份过滤的）。

---

## 6. 实现位置

| 部分 | 文件 |
|---|---|
| 成员、权限、提及解析、按人注意力（纯函数） | `shared/team.ts` |
| 名册存储与 mesh 复制、身份识别、邀请、评论、指派、点名 | `hub/team.ts`，接入 `hub/server.ts` |
| 客户端 profile（连远程 hub 的 user token） | `shared/config.ts` 的 `client`，`shared/hub-client.ts` |
| CLI | `quick team …`、`quick comment`、`quick assign`、`quick inbox`、`quick team board`，`quick machine set --owner` |
| 前台 | `extensions/front.ts`：团队提示段、`qa_dispatch` 新参数、`qa_task_assign`、`qa_comment`、`qa_tasks scope` |
| worker | `extensions/worker.ts`：`qa_comment`，brief 里写明发起人和验收人 |
| Web UI | `ui/app.html`：团队视图、评论区、负责/验收/关注 |
| 测试 | `test/team.test.ts`（单元 + 两个用户连同一个隔离 hub 的端到端） |
