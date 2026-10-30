# 论文与人机交互证据

> 功能：编辑器缩略图（Minimap）  
> 调研日期：2026-10-30  
> 目的：回答“minimap 应该显示什么、放在哪里、如何交互、何时不该显示”，避免只凭 VS Code 外观做设计。  
> **实施后修订：** 论文证据仍成立——语义层有价值、缩略图不是阅读界面。最终实现同时保留 1:1 文本形状与结构色；Live Preview 进一步用渲染块/真实块高对齐所见内容；76px 下文本只作轮廓/空间线索，不承诺可读（F-051/F-052）。

---

## 0. 结论摘要

1. **Minimap 的价值主要是空间记忆与整篇定位，不是阅读**。DeLine et al. 2006 的 Code Thumbnails 明确把缩略图当作“视觉地标”，而不是可读文本。
2. **语义层比字符层更有价值**。Bacher et al. 2018 在 minimap 上叠加 scope 信息层，使代码理解题正确率从 59.3% 提升到 71.2%（p < 0.001）。对本项目意味着：标题、代码块、表格、引用等结构色比逐字符字形更值得强调。最终实现用结构色着色 1:1 文本轮廓，兼顾空间形状与语义（F-051）。
3. **Overview+detail 有收益，也有 split-attention 成本**。Cockburn et al. 2009 的综述指出：空间分离的 overview 需要用户在两个视图间建立对应关系，可能增加认知负担。因此 minimap 必须是可选/克制的辅助，不能替代查找、大纲和键盘导航。
4. **导航 affordance 应减少点击次数、保持空间稳定**。Henley et al. 2017 的实证研究（虽然不是 minimap 专项）支持“点击即达、布局稳定、减少导航步骤”的方向。
5. 本方案因此选择：1:1 文本轮廓 + 结构色、固定右侧 rail、点击/拖拽直达、默认只在长文档出现、不承诺 76px 下文字可读、不新增持久化开关（避免设置负担）。

---

## 1. DeLine et al. 2006 — Code Thumbnails

**Citation**  
Robert DeLine, Mary Czerwinski, Brian Meyers, Gina Venolia, Steven Drucker, George Robertson.  
*Code Thumbnails: Using Spatial Memory to Navigate Source Code.*  
VL/HCC 2006, pp. 11–18. DOI: [10.1109/VLHCC.2006.14](https://doi.org/10.1109/VLHCC.2006.14).

**研究/设计**

- 在 Visual Studio 中把整篇源码缩略图叠加到滚动条（Code Thumbnail Scrollbar），并提供文件缩略图桌面（Code Thumbnail Desktop）。
- 缩略图字号最大 2.5pt，刻意保持“略低于可读阈值”，让开发者用**文字形状**做视觉地标，而不是阅读。
- 当前视口用矩形框标出；折叠结构用括号表示；鼠标悬停显示可能的目标名称。
- 点击缩略图任意位置可跳到对应代码。
- 对 11 名有经验开发者做了形成性评估。

**对本项目的启示**

| 启示 | 落地 |
|---|---|
| 缩略图是空间地标，不是阅读器 | 76px 宽度下不画字符，只画结构/密度色块 |
| 视口标记必须清楚 | 滑块常显低透明度，hover/drag 增强 |
| 点击即达 | rail 任意位置点击跳转并居中 |
| 结构地标（折叠/括号）有价值 | 标题、代码块、表格、引用用不同颜色/宽度 |
| 稳定的一维空间支持空间记忆 | rail 固定右侧、固定宽度、文档顺序稳定 |

**局限**：研究对象是代码，不是 Markdown；没有测量长文档中的滑块精度；缩略图是位图字形，不是语义层。

---

## 2. Bacher et al. 2018 — Code Mini-Map 语义层

**Citation**  
Ivan Bacher, Brian Mac Namee, John D. Kelleher.  
*The Code Mini-Map Visualisation: Encoding Conceptual Structures Within Source Code.*  
VISSOFT 2018. DOI: [10.1109/VISSOFT.2018.00023](https://doi.org/10.1109/VISSOFT.2018.00023).

**研究/设计**

- 在传统 code minimap 上增加“scope information layer”，用额外编码显示作用域链、变量所属作用域、光标当前作用域。
- 60 名参与者、20 道代码理解题，两组各 30 人：
  - 普通 minimap：356/600 正确（59.3%）
  - minimap + scope layer：421/600 正确（71.2%）
  - Pearson χ²，p < 0.001。
- 结论：在 minimap 上叠加额外语义层，对代码理解有正向作用；作者认为可推广到其他“文本不直接表达”的宏观结构。

**对本项目的启示**

- Markdown 的“宏观结构”是标题层级、代码块、表格、引用、front matter、分隔线；这些应在 minimap 中有可辨识的编码。
- 不需要逐字符还原；**语义层/结构层**才是导航价值所在。
- 颜色/宽度编码必须克制：层级过多会让 76px 宽的 rail 变成噪声。

**局限**：任务是 scope 理解，不是长文档导航；样本是 JavaScript 代码；没有比较“语义 minimap”与“字符 minimap”的导航速度。

---

## 3. Cockburn et al. 2009 — Overview+Detail 综述

**Citation**  
Andy Cockburn, Amy Karlson, Benjamin B. Bederson.  
*A review of overview+detail, zooming, and focus+context interfaces.*  
ACM Computing Surveys 41(1), Article 2, 2009. DOI: [10.1145/1456650.1456652](https://doi.org/10.1145/1456650.1456652).

**核心结论**

- Overview+detail 通过空间分离同时提供上下文与焦点，常见且有效，但用户需要在两个视图之间建立对应关系。
- 综述引用 Hornbæk et al. 2002 与 Baudisch et al. 2002：在 overview 与 detail 之间切换需要心理努力和时间；空间分离会产生 split-attention 成本。
- 没有一种方案绝对最优；overview+detail、zooming、focus+context 各有代价。
- 在电子文档阅读中，overview+detail 与 fisheye 相对传统平铺文本有性能优势（Hornbæk & Frøkjær 2003）。

**对本项目的启示**

| 启示 | 落地 |
|---|---|
| Minimap 是辅助，不是主路径 | 保留查找、键盘滚动、未来大纲；不拦截快捷键 |
| 两个视图必须容易对应 | 滑块位置与 minimap 内容用同一锚点映射；主题/布局一致 |
| 占用空间是真实成本 | 只在长文档显示；短文档不预留宽度 |
| 不要强制 | 本期自动显示；Q-002=B 已确认不新增会话内关闭命令 |
| 视觉噪声会增加 split-attention | 结构色不超过 6 类；文本只画 1px 轮廓，不画可读字形 |

---

## 4. Henley et al. 2017 — 导航 affordance 原则

**Citation**  
Austin Z. Henley, Scott D. Fleming, Maria V. Luong.  
*Toward Principles for the Design of Navigation Affordances in Code Editors: An Empirical Investigation.*  
CHI 2017, pp. 5690–5702. DOI: [10.1145/3025453.3025645](https://doi.org/10.1145/3025453.3025645).

**研究/结论**

- 32 名专业 LabVIEW 程序员，比较 tabbed editor 与 Patchworks（并排 patch）两种导航界面。
- Patchworks 用户每次导航点击更少、更常并排查看、导航错误更少。
- 提出五条导航 affordance 设计原则，核心方向是：减少导航步骤、保持信息可见、降低空间记忆负担。

**对本项目的启示**

- 点击 minimap 一次即可到达目标，避免“滚动—寻找—再滚动”。
- rail 固定位置、固定宽度，形成稳定的空间记忆。
- 不把 minimap 做成需要展开/折叠/配置的面板。

**局限**：不是 minimap 专项；LabVIEW 与 Markdown 写作任务不同；不能据此断言 minimap 一定提升写作效率。

---

## 5. 证据到设计决策的映射

| 证据 | 设计决策 | 验收 |
|---|---|---|
| DeLine 2006：缩略图是地标，不是阅读 | D-001 Canvas 1:1 文本轮廓 + 结构色 | AC-002 像素采样能看到不同结构色；E2E-015 验证行长度差异 |
| Bacher 2018：语义层提升理解 | D-006 标题/代码/表格/引用分类 | AC-002 / 单测分类器 |
| Cockburn 2009：overview 有 split-attention 成本 | D-007 仅长文档显示；不替代搜索/大纲 | AC-001 短文档 rail 隐藏 |
| Cockburn 2009：两个视图要能对应 | D-002 Canvas 与滑块共用 `docYToRail`，锚点只校准行位置 | AC-003 点击落点 / AC-004 拖拽 |
| DeLine 2006 / Obsidian：视口标记必须清楚 | D-009 滑块常显、hover/drag 增强 | AC-004 / E2E |
| Henley 2017：减少导航步骤 | D-002 点击/拖拽/滚轮直达 | AC-003 / AC-005 |
| 所有论文：没有“必须常显”的证据 | D-007 自动显示、零持久化配置 | Q-001=B（已确认） |

---

## 6. 不能从论文直接推出的结论

1. **不能断言 minimap 会提升青墨用户的写作效率**。现有论文主要研究代码理解/导航，不是中文 Markdown 写作。
2. **不能断言 76px 是最佳宽度**。这是工程初值，需要 dogfood 与 E2E 视口测试校准。
3. **不能断言“语义 minimap 一定优于字符 minimap”在 Markdown 中成立**。Bacher 的结论是“额外语义层有正向作用”，不是“字符层无价值”。
4. **不能断言滑块跨屏平均一定需要**。Obsidian 的实现说明它能减少抖动，但本项目可以先 clamp 最小高度，观察后再加。

---

## 7. 参考资料

- [Code Thumbnails (Microsoft Research)](https://www.microsoft.com/en-us/research/publication/code-thumbnails-using-spatial-memory-to-navigate-source-code/)
- [The Code Mini-Map Visualisation (DOI)](https://doi.org/10.1109/vissoft.2018.00023)
- [A review of overview+detail, zooming, and focus+context interfaces (DOI)](https://doi.org/10.1145/1456650.1456652)
- [Toward Principles for the Design of Navigation Affordances in Code Editors (DOI)](https://doi.org/10.1145/3025453.3025645)
- [Nymbo/Markdown-Minimap](https://github.com/Nymbo/Markdown-Minimap)
- [replit/codemirror-minimap](https://github.com/replit/codemirror-minimap)
- [microsoft/vscode minimap.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/viewParts/minimap/minimap.ts)
