# 注意力优先：quick-agent 前台 UI 的设计原则

quick-agent 的前台不管理"会话"，管理的是**你的注意力**。
有了 worker 以后，人类手里稀缺的不再是执行力，而是注意力：哪件事现在需要我？哪件事已经交出去、可以放心不管？哪件事做完了，扫一眼就行？

本文整理了关于人类注意力的研究和设计思想，提炼成 Web UI（`ui/app.html`）遵循的原则，最后给出这些原则在界面上的落点。

---

## 1. 研究与理论

### 1.1 信息丰富导致注意力贫乏（Herbert Simon, 1971）

> "In an information-rich world, the wealth of information means a dearth of something else … What information consumes is rather obvious: it consumes the attention of its recipients. Hence a wealth of information creates a poverty of attention and a need to allocate that attention efficiently …"
> —— H. A. Simon, *Designing Organizations for an Information-Rich World*, 1971

Simon 指出，信息系统的设计目标不是"提供更多信息"，而是**替接收者过滤**，把注意力分配到值得的地方。多个 worker 同时产出状态、日志和汇报，正是"信息丰富"的场景；前台的职责就是替人过滤。

- 引用出处：[Attention economy — Wikipedia（含 Simon 原文引文）](https://en.wikipedia.org/wiki/Attention_economy)

### 1.2 打断与注意力切换的代价（Gloria Mark 等）

- Mark、Gonzalez、Harris（CHI 2005）观察信息工作者发现：工作被切成很短的片段，被打断的任务平均要过 **约 25 分钟**才会重新回到（中间常常插进另外两件事）。[No task left behind?](https://doi.org/10.1145/1054972.1055017)
- Mark、Gudith、Klocke（CHI 2008）发现：被打断的人会**更快**地完成任务来弥补，但代价是**压力、挫败感和工作负荷显著上升**。[The cost of interrupted work: more speed and stress](https://doi.org/10.1145/1357054.1357072)
- Czerwinski、Horvitz、Wilhite 的日记研究（CHI 2004）表明：被打断后最难的是"回到原来那件事"，回去的时候需要外部线索提醒自己做到了哪里。[A diary study of task switching and interruptions](https://doi.org/10.1145/985692.985715)
- Iqbal 和 Horvitz（CHI 2007）发现：处理一条提醒之后，人常常会顺带去看别的东西，要过很久才回到原来的任务。[Disruption and recovery of computing tasks](https://doi.org/10.1145/1240624.1240730)
- Altmann 和 Trafton 的"目标记忆"模型解释了恢复延迟（resumption lag）：被挂起的目标会在记忆里衰减，需要**环境线索**才能快速恢复。[Memory for goals: an activation-based model](https://doi.org/10.1207/s15516709cog2601_2)
- Bailey 和 Konstan（2006）证明：在任务进行中打断，会让完成时间变长、错误率升高、烦躁感增加；同样的提醒放到**任务边界**再出现，代价小得多。[On the need for attention-aware systems](https://doi.org/10.1016/j.chb.2005.12.009)
- Iqbal 和 Bailey（CHI 2008）：把通知推迟到**自然断点**再呈现，能降低挫败感和反应时间，又不会丢失信息。[Effects of intelligent notification management on users and their tasks](https://doi.org/10.1145/1357054.1357070)
- Gloria Mark 的新书 *Attention Span*（2023）总结了二十年的数据：人在屏幕上的注意力平均停留时间已经降到 **约 47 秒**。她主张把注意力当成一种有限的、会耗尽的资源来管理。[gloriamark.com](https://gloriamark.com/attention-span/)

### 1.3 注意力残留（Sophie Leroy, 2009）

Leroy 的实验发现：从任务 A 切到任务 B 时，如果 A **还没完成或没有收尾**，一部分注意力会继续"粘"在 A 上（attention residue），在 B 上的表现明显变差。如果 A 是在明确收尾、或者在时间压力下完成的，残留会少得多。

- [Why is it so hard to do my work? The challenge of attention residue when switching between work tasks](https://doi.org/10.1016/j.obhdp.2009.04.002)，*Organizational Behavior and Human Decision Processes*, 109(2)

### 1.4 "当它已经办妥"：计划能卸下未完成目标（Masicampo & Baumeister, 2011）

未完成的目标会反复闯进脑子（蔡格尼克效应）。Masicampo 和 Baumeister 的实验发现：**只要为它制定一个具体计划**，即使还没开始做，这种干扰也会基本消失。

- [Consider it done! Plan making can eliminate the cognitive effects of unfulfilled goals](https://doi.org/10.1037/a0024192)

对 quick-agent 来说，这正是"交出去"的心理价值：一件事交给 worker，并且得到"谁在做、在哪做、做完会告诉你"的回执，脑子就可以放下它。

### 1.5 深度工作（Cal Newport, 2016）

Newport 把"在无干扰状态下、把认知能力推到极限的专业活动"称为 Deep Work，并主张把浅层事务（邮件、消息）**批量集中处理**，用排程保护大块的专注时间。

- [Deep Work — calnewport.com](https://www.calnewport.com/books/deep-work/)

### 1.6 心流（Mihaly Csikszentmihalyi, 1990）

心流的条件包括：清晰的目标、即时的反馈、挑战与技能匹配，以及**不被打断的专注**。打断会把人从心流里拉出来，重新进入要付出不小的代价。

- [Flow (psychology) — Wikipedia](https://en.wikipedia.org/wiki/Flow_(psychology))

### 1.7 安静技术（Calm Technology）

- Mark Weiser 和 John Seely Brown 在 *Designing Calm Technology*（1995）和 *The Coming Age of Calm Technology*（1996）中提出：好的技术**同时占用注意力的中心和外围（periphery）**，并且能让信息在两者之间平滑移动。大多数信息应该留在外围，让人"知道"却不必"处理"，需要时才移到中心。
  [Designing Calm Technology](https://calmtech.com/papers/designing-calm-technology.html) · [The Coming Age of Calm Technology](https://calmtech.com/papers/coming-age-calm-technology.html)
- Amber Case 的 *Calm Technology*（2015）把它整理成八条原则，与本项目最相关的几条：
  1. 技术只应占用最少的注意力；
  2. 技术应该提供信息，并带来平静；
  3. 技术应该利用外围；
  5. 技术可以沟通，但不必"说话"；
  7. 恰当的技术量，是解决问题所需的最小值。
  [calmtech.com](https://calmtech.com/) · [Calm Tech Principles](https://calmtech.institute/calm-tech-principles)

### 1.8 批处理通知与收件箱清零

- Fitz、Kushlev 等人（2019）的实地实验：把手机通知**每天分三批推送**的人，注意力、生产力和幸福感都更好；完全不推送反而会增加对错过信息的焦虑。[Batching smartphone notifications can improve well-being](https://doi.org/10.1016/j.chb.2019.07.016)
- Kushlev 和 Dunn（2015）：限制为每天查看三次邮件的人，压力明显下降。[Checking email less frequently reduces stress](https://doi.org/10.1016/j.chb.2014.11.005)
- Merlin Mann 的 Inbox Zero（2006/2007）：关键不在于"零封"，而在于**每一项都有一个明确的处置动作**（删除、委派、回复、推迟、去做），收件箱不是存放事情的地方。[Inbox Zero — 43 Folders](https://www.43folders.com/izero)

---

## 2. 设计原则

| # | 原则 | 依据 |
|---|---|---|
| P1 | **默认替你过滤**：首屏只展示需要你的事。其他事退到外围，不在首屏争抢注意力。 | Simon；Calm Tech 原则 1 和 7 |
| P2 | **按打断成本排序**：有人在等你，最高；需要你决定，其次；新的外部输入，再次；纯信息（完成汇报），最低。 | Mark；Bailey & Konstan |
| P3 | **交出去就要放得下**：每次交出一件事，都给出明确的回执（谁接手、在哪台机器、什么目录、做完会怎样通知）。界面替人记住这件事，人就不必挂念。 | Leroy；Masicampo & Baumeister |
| P4 | **外围感知，而非打扰**：进行中的事只占外围，弱化显示，可以瞥一眼。状态变化用"位置移动"（从进行中移到需要你或待扫）表达，不用闪烁、弹窗和红点。 | Weiser & Brown 的中心/外围 |
| P5 | **只有阻塞才能打断**：只有 worker 停下来等你（提问或受阻）时才主动提示。完成、进度这类信息默认不弹出，等你来扫。 | Iqbal & Bailey；Calm Tech 原则 5 |
| P6 | **批量呈现**：专注模式下，完成汇报先暂存，按批次（固定间隔，或结束专注时）一次呈现。 | Fitz 等；Kushlev & Dunn；Newport |
| P7 | **每一项都有处置动作**：回复、追加、放下、稍后、扫过。"已完成待扫"可以一键清空，清空后的空状态本身就是反馈（"心里没有挂着的事"）。 | Inbox Zero |
| P8 | **在断点上呈现**：你正在输入时不打断；新事项安静地进入列表，等你交出一件事或停下来时再看到。 | Iqbal & Bailey；Bailey & Konstan |
| P9 | **单一入口、没有会话**：与前台的交互只有一种动作，就是"把一件事交出去"。不让人管理会话（新建、切换、命名），持久化和上下文压缩在后台自动完成。 | Calm Tech 原则 7；心流（清晰目标、少做选择） |
| P10 | **恢复线索就在手边**：任何事项一点开，就能看到最新汇报、实时终端和简报，回到一件事的成本最低。 | Czerwinski 等；Altmann & Trafton |
| P11 | **安静的视觉**：少颜色、少徽章；数字只用来回答"有几件事在等我"，不做提醒轰炸。 | Calm Tech |

---

## 3. 在 quick-agent 中的落点

| 界面 | 做法 | 原则 |
|---|---|---|
| **需要你** | worker 提问（needs_input）、受阻（blocked）、出错或停下（failed、exited、idle）；前台的确认框；前台没能处理的浏览器评论。按打断成本排序，未看过的在前。每项都能直接回复 worker、查看详情、"稍后"（1 小时后再出现）或"放下"（关闭这个 worker）。 | P1 P2 P7 P10 |
| **进行中** | 已托付出去、正在运行的事，弱化成一行，显示 worker 当前在做什么。 | P3 P4 |
| **已完成待扫** | 完成了但你还没看过的汇报。点开即读，读完自动扫过；也可以"全部扫过"一键清空。 | P6 P7 |
| **交接台** | 和前台的唯一交互是"把一件事交出去"（输入框）。交出后前台立即回执；派单显示为一张交接卡（任务、机器、目录）。和前台的往来是一条持续的记录流，只展开最近的部分，更早的折叠起来。 | P3 P9 |
| **专注模式** | 开启后，完成汇报暂存；每 30 分钟或结束专注时批量放进"已完成待扫"。阻塞类事项照常进入"需要你"，但不弹出通知。 | P5 P6 |
| **提示** | 去掉弹窗式的通知轰炸。前台的提示显示在一行安静的状态文字里，只有错误才浮出。页面标题只在"需要你"有新事项时显示数量。 | P4 P5 P11 |
| **会话** | 去掉会话列表和新建、切换、重命名。后端始终接续同一条前台流，持久化和压缩由 pi 自动完成。 | P9 |
| **回顾** | 想看全部历史时，可以打开"回顾"抽屉（全部任务）。它不在首屏。 | P1 |

### 不做的事

- 不做红色未读徽章，不让数字跳动，不用声音。
- 不把每条进度推到人的眼前；进度属于外围。
- 不让人选择"在哪个会话里说"，任何时候只有一个输入框。
