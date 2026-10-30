# 论文与人机交互证据

> 功能：编辑器大纲面板（Outline）  
> 检索方式：Exa 学术检索 + DOI/摘要核对  
> 用途：为“默认隐藏、标题粒度、全部层级、活动项、面板宽度”提供 HCI 依据；不把论文结论夸大为产品承诺。

---

## 0. 结论先行

1. 标题/目录是长文档的有效导航信号，但收益主要是**定位效率**，不是理解效果。
2. 超大层级（>1000 项）需要折叠/多面板；本方案用面板 500 条上限 + 平铺缩进控制规模，字段 5000 条仅服务锚点，折叠留后续。
3. 标题数量对检索速度影响不显著，用户主观偏好更多标题；因此显示全部 H1-H6，不按级别过滤。
4. 细粒度结构提示能加快定位“superordinate”内容，但不帮助细节项；大纲不能替代搜索。
5. 代码导航研究显示 thrashing 与低效相关；持续结构导航可能减少来回跳转，但代码场景不能直接外推到写作。
6. Overview+detail 有 split-attention 成本；因此默认隐藏、按需打开、固定 240px，不用常显大面板。

---

## 1. Chimera & Shneiderman 1994

**论文：** *An exploratory evaluation of three interfaces for browsing large hierarchical tables of contents*  
**作者：** Richard Chimera, Ben Shneiderman  
** venue：** ACM Transactions on Information Systems, 1994  
**DOI：** [10.1145/185462.185483](https://doi.org/10.1145/185462.185483)

**方法：** 41 名新手，浏览 1296 项的 TOC；比较三种界面：

- 完全展开、稳定（stable）；
- 展开/收起（expand/contract）；
- 多面板（multipane）。

**结论：**

- expand/contract 与 multipane 在多数任务上显著快于完全展开的 stable 界面。
- 动画（逐项展开/收起）对 expand/contract 的可用性很重要。
- multipane 在重度探索任务上更好：更快、更少杂乱、无需“housekeeping”。
- 作者建议用 expand/contract 替代 stable；multipane 可作为主策略。

**对本方案的启示：**

- 500 条以内的平铺列表是可接受的；超过 500 条，平铺会变成“stable 大列表”，效率下降。因此 `OUTLINE_PANEL_MAX_ENTRIES=500` 是产品/性能上限，超出显示“仅显示前 500”提示；字段 5000 条不进入 DOM。
- 折叠/展开不是 v1 必需，但对 >500 条或深层级文档有价值；记录为 `NEXT-003`。
- 面板内活动项自动滚动（Typora 行为）可以部分替代折叠的“保持上下文”作用。

**边界：**

- 实验只展示 TOC，不展示正文；真实写作场景有正文上下文，不能直接照搬“multipane 一定更好”。
- 1296 项远超本方案面板 500 条上限；字段 5000 条仍不渲染到 DOM。

---

## 2. Lu et al. 2017

**论文：** *Is there any efficient reading strategy when using text signals for navigation in a long document?*  
**作者：** Quan Lu, Qingjun Liu, Jing Chen, Ji Li  
**期刊：** Library Hi Tech, 35(3), 458-472, 2017  
**DOI：** [10.1108/LHT-11-2016-0143](https://doi.org/10.1108/LHT-11-2016-0143)

**方法：** 两个阅读工具（THC-DAT 主题信号、BOOKMARK 标题信号）的案例研究；收集点击行为、阅读效果（分数）与效率（时间）。

**结论：**

- 文本信号的使用行为对阅读**效率**有显著影响，对阅读**效果**没有显著影响。
- 点击行为的离散程度影响效率；不同信号类型影响不同。
- 建议读者减少“找答案”的时间；个性化推荐可基于相邻点击间隔。

**对本方案的启示：**

- 大纲是效率工具，不应宣称“提升理解/记忆”。
- 活动项 + 固定面板 + 点击跳转，目标是减少找标题的时间。
- 不把大纲做成“阅读进度/理解评估”。

**边界：**

- 案例研究，样本/工具特定；不能推导具体 UI 参数。
- “效率”测量是任务时间，不是长期写作产出。

---

## 3. Zhou & Farkas 2009（QuikScan）

**论文：** *QuikScan: Facilitating reading and information navigation through innovative document formatting*  
**作者：** Quan Fa Zhou, David K. Farkas  
** venue：** IEEE International Professional Communication Conference (ProComm), 2009  
**DOI：** [10.1109/IPCC.2009.5208671](https://doi.org/10.1109/IPCC.2009.5208671)

**方法：** 40 名参与者，QuikScan vs 传统格式；计时信息导航任务。

**结论：**

- QuikScan 读者定位 **superordinate** 内容显著更快、准确率更高。
- 对次要细节项没有更好表现。
- 细粒度摘要/编号帮助 skimming 和定位。

**对本方案的启示：**

- 标题粒度的大纲适合“找章节”，不适合“找某句话”；搜索仍是必要补充。
- 不要把大纲做成全文摘要/QuikScan；v1 只做标题。
- 层级缩进 + 标题文本是最小可用的“superordinate”提示。

**边界：**

- QuikScan 是文档格式 + 摘要，不是侧栏大纲；不能直接等同。
- 需要作者额外写摘要，成本高；本方案不引入。

---

## 4. Kools et al. 2008

**论文：** *The effects of headings in information mapping on search speed and evaluation of a brief health education text*  
**作者：** Marieke Kools, Robert A. C. Ruiter, Margaretha W. J. van de Wiel, Gerjo Kok  
**期刊：** Journal of Information Science, 34(6), 833-844, 2008  
**DOI：** [10.1177/0165551508089719](https://doi.org/10.1177/0165551508089719)

**方法：** 系统变化标题频率与信息顺序，测量搜索速度与布局评价。

**结论：**

- 标题的存在确实让搜索任务更容易/更快。
- 不同标题数量之间没有显著搜索速度差异；主观评价更偏好标题多的版本。
- 信息顺序没有显著影响。

**对本方案的启示：**

- 显示全部 H1-H6，不按级别过滤；用户偏好更多结构。
- 不要为了“简洁”只显示 H1/H2；层级缩进已经提供视觉降噪。
- 标题数量不是主要性能风险；真正风险是 DOM/解析成本，所以用 500 条**面板**上限而不是级别过滤；字段保留 5000 条只为锚点完整。

**边界：**

- 印刷健康文本，不是屏幕侧栏；外推需谨慎。
- “更多标题”偏好不等于“无限标题”；面板 500 条上限仍必要，字段 5000 条只为锚点。

---

## 5. Sharafi et al. 2022

**论文：** *Eyes on Code: A Study on Developers' Code Navigation Strategies*  
**作者：** Zohreh Sharafi, Ian Bertram, Michael Flanagan, Westley Weimer  
**期刊：** IEEE Transactions on Software Engineering, 48(5), 1692-1704, 2022  
**DOI：** [10.1109/TSE.2020.3032064](https://doi.org/10.1109/TSE.2020.3032064)

**方法：** 36 名开发者，真实 bug-fixing 任务，眼动 + IDE 交互；三阶段模型（找、理解、编辑）。

**结论：**

- 开发者导航策略随任务阶段变化。
- “thrashing”（在代码元素间过度切换）与更低效果相关。
- 相关性/注意力分布随时间变化。

**对本方案的启示：**

- 持续可见的结构 + 活动项可以帮助保持“我在哪”的上下文，理论上减少 thrashing。
- 但这是代码/IDE 研究，不能直接证明 Markdown 大纲提升写作效率；只作为设计假设。
- 活动项跟随光标（而不是视口）让“当前编辑位置”始终可见，符合“编辑阶段”上下文。

**边界：**

- 代码导航与散文写作差异大；不引用具体百分比。
- 眼动实验环境/任务特定。

---

## 6. Cockburn et al. 2009（Overview+Detail）

**论文：** *A review of overview+detail, zooming, and focus+context interfaces*  
**作者：** Andy Cockburn, Amy Karlson, Benjamin B. Bederson  
**期刊：** ACM Computing Surveys, 41(1), 2009  
**DOI：** [10.1145/1456650.1456652](https://doi.org/10.1145/1456650.1456652)

**结论（综述）：**

- Overview+detail 能提供全局上下文，但会带来 split-attention 成本；用户需要在两个视图间切换注意力。
- 设计需要权衡 overview 的信息量、更新频率和屏幕空间。

**对本方案的启示：**

- 默认隐藏，避免所有文档都承担 split-attention 成本。
- 240px 固定宽 + 纯文本 + 面板 500 条上限（字段 5000 仅服务锚点），控制 overview 的信息密度。
- 不把大纲做成第二个编辑器/预览；它只是导航。

**边界：**

- 综述覆盖多种界面，不是 Markdown 编辑器实验；用于风险认知，不作为具体像素依据。

---

## 7. 论文到设计映射

| 结论 ID | 论文 | 结论 | 设计决策 | 影响 |
|---|---|---|---|---|
| HCI-001 | Chimera 1994 | 超大 TOC 需要折叠/多面板 | 面板 500 条上限；折叠 NEXT-003 | D-005/D-009 |
| HCI-002 | Lu 2017 | 标题导航影响效率而非效果 | 不承诺理解提升；定位为目标 | R-001/R-003 |
| HCI-003 | QuikScan 2009 | 细粒度结构帮助 superordinate | 只做标题；不替代搜索 | R-002/R-005 |
| HCI-004 | Kools 2008 | 标题存在有帮助；数量不显著 | 显示全部 H1-H6 | D-003 |
| HCI-005 | Sharafi 2022 | thrashing 与低效相关 | 活动项 + 固定面板 | D-011 |
| HCI-006 | Cockburn 2009 | overview 有 split-attention 成本 | 默认隐藏；240px | D-008/D-009 |
| HCI-007 | 综合 | 面板内自动滚动保持上下文 | 活动项 `scrollIntoView` | T-006 |

---

## 8. 研究限制

1. 没有直接针对“Markdown 编辑器左侧大纲”的对照实验；结论是从 TOC/标题/代码导航/overview+detail 外推。
2. 论文的样本、任务、文档类型与青墨用户不同；不能把效应量当作产品 KPI。
3. 本方案没有计划做用户实验；以工程可用性/性能/可访问性为主，后续可用 dogfood 反馈校准默认值。
4. 论文只支持“标题导航有价值”，不支持“默认常显”“折叠一定更好”“活动项一定跟随光标”等具体选择；这些由产品/工程权衡决定，并在 Q-002/Q-004 中让用户确认。

---

## 9. 参考资料

- Chimera, R., & Shneiderman, B. (1994). DOI: 10.1145/185462.185483.
- Lu, Q., Liu, Q., Chen, J., & Li, J. (2017). DOI: 10.1108/LHT-11-2016-0143.
- Zhou, Q. F., & Farkas, D. K. (2009). DOI: 10.1109/IPCC.2009.5208671.
- Kools, M., Ruiter, R. A. C., van de Wiel, M. W. J., & Kok, G. (2008). DOI: 10.1177/0165551508089719.
- Sharafi, Z., Bertram, I., Flanagan, M., & Weimer, W. (2022). DOI: 10.1109/TSE.2020.3032064.
- Cockburn, A., Karlson, A., & Bederson, B. B. (2009). DOI: 10.1145/1456650.1456652.
