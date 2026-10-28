# 论文与标准证据

> 功能 ID：`i18n`
> 调研日期：2026-10-28
> 目的：为“文案与核心分离、语言选择可持久化、布局需验证、测试需覆盖插值/复数/截断”提供研究依据。
> 说明：论文结论用于设计约束，不直接复制实现。

---

## 1. 论文

### P-01 Gupta & Wen, *Going Global? Let's Measure Your Product For World-Readiness!*, ACL 2015

- 链接：https://aclanthology.org/2015.tc-1.16.pdf
- 类型：工业界 world-readiness 评估框架（ACL 2015 Translation and Culturalization track）
- 核心结论：
  1. 国际化不只是“翻译字符串”，还包括区域选择、语言选择、日期/时间、数字、排序、单位、用户信息格式等。
  2. 语言选择应遵循平台/系统 locale，并**保存用户偏好**，在跨会话/多工作流中保持一致。
  3. 应使用 ISO/BCP 47 locale 代码，而不是自造代码；应使用标准库做日期/数字格式化。
  4. “Localizability” 要求新增语言不需要改代码。
- 对本方案的影响：
  - `qingmo.ui.language` 持久化 + 跨窗口一致（R-002/R-005）。
  - 统一 `zh-CN`/`en`，不接受 `zh_cn`（`i18n/language.ts`）。
  - 日期/时间/字节统一 `Intl`（R-008）。
  - 文案必须在 locale 文件，不在组件/Rust 硬编码（R-009）。
- 适用边界：论文面向企业软件评估，不提供具体 Tauri/React 实现；其“区域选择”部分在本期只做语言，不做区域/货币。

### P-02 Santos et al., *Bug! Falha! Bachi! Fallo! Défaut! 程序错误! What about Internationalization Testing in the Software Industry?*, ESEM 2020

- DOI：https://doi.org/10.1145/3382494.3422167
- 类型：工业界定性研究（13 位从业者访谈）
- 核心结论：
  1. 国际化测试主要关注 GUI；
  2. **截断（truncation）和误译（mistranslations）是最主要故障**；
  3. 由于大量校验依赖人，测试自动化难以实现/维护。
- 对本方案的影响：
  - 不能只做 key 对齐；必须做英文长文案的布局/截图/手动冒烟（RK-007）。
  - 原生菜单/窗口标题无法用浏览器 E2E 覆盖，保留 macOS 真机冒烟（AC-003/AC-004）。
  - 自动化测试覆盖 key/插值/复数/无硬编码；人工覆盖语义/截断（T-018）。
- 适用边界：研究对象是通用软件，不特指桌面 Markdown 编辑器；其“自动化困难”结论用于确定测试边界，不意味着放弃自动化。

### P-03 Alameer, Mahajan & Halfond, *Detecting and Localizing Internationalization Presentation Failures in Web Applications*, ICST 2016

- DOI：https://doi.org/10.1109/ICST.2016.36
- 类型：自动化检测 i18n 布局失败
- 核心结论：
  1. 翻译后的文本膨胀/收缩会扭曲网页布局；
  2. 手工检查每个页面/语言代价高且易漏；
  3. 自动化方法可以在 54 个 Web 应用上以较高 precision/recall 检测并定位问题元素。
- 对本方案的影响：
  - 英文标签比中文长（如 “Toggle Live Preview”），原生菜单/按钮/状态栏需要英文 E2E 与截图（T-016）。
  - `NativeShellLabels` 增加长度上限（120 字符）和手动菜单冒烟，避免菜单项不可读。
  - 组件测试使用英文长文案做回归，而不是只测中文。
- 适用边界：论文针对 Web 页面布局；原生菜单布局不在其方法覆盖内，需补充手动验证。

### P-04 Escobar-Velásquez et al., *An Empirical Study of i18n Collateral Changes and Bugs in GUIs of Android apps*, ICSME 2020

- DOI：https://doi.org/10.1109/ICSME46990.2020.00061
- 类型：31 个 Android 应用、7 种语言的实证研究
- 核心结论：
  1. 翻译会引入非预期的 GUI 变化/缺陷；
  2. 存在可归纳的 i18n 变更/缺陷分类与坏实践；
  3. 需要自动化 + 人工验证结合。
- 对本方案的影响：
  - 语言切换后不仅要看文案，还要看布局、截断、aria/title（AC-007）。
  - 测试要覆盖“切换后再切回”的幂等路径，避免残留旧 DOM 文案（AC-006）。
- 适用边界：移动端 GUI；本项目为桌面 WebView + 原生菜单，结论作为风险提示。

### P-05 Collins, *Software Localization: Issues and Methods*, ECIS 2001

- 链接：http://aisel.aisnet.org/ecis2001/4
- 类型：软件本地化方法与案例
- 核心结论：
  1. 关键原则是“把文化、语言、用户相关部分从软件核心中隔离”；
  2. 本地化团队应在设计/测试早期介入；
  3. 界面对象与业务对象分离。
- 对本方案的影响：
  - `packages/editor-core` 不引入 i18next；通过 `EditorUiCopy` Facet 注入，保持核心与文案分离（D-007）。
  - Rust 不保存完整文案表，只渲染前端投影（D-001）。
- 适用边界：论文早于现代前端框架；其“隔离”原则仍适用，具体实现需映射到 CM6 Facet/Port。

---

## 2. 标准与规范

| 标准 | 关键条款 | 对本方案的影响 | 采用 |
|---|---|---|---|
| BCP 47（RFC 5646） | 语言标签语法；`zh-CN`、`en` 合法；大小写不敏感但推荐规范形式 | 内部统一规范形式；持久化只接受这两个值 | 采用 |
| RFC 4647 | lookup/filtering；从具体到一般匹配 | 若未来做 OS 检测，按此算法；本期默认 zh-CN，不做 | 预留 |
| W3C Internationalization Best Practices | 语言标签用 BCP 47；不要自造代码 | 拒绝 `zh_cn`；只接受 `zh-CN`/`en` | 采用 |
| Unicode CLDR / `Intl.PluralRules` | 不同语言 plural categories 不同 | 英文 `_one/_other`，中文 `_other`；测试按 `Intl` 生成期望 | 采用 |
| `Intl.DateTimeFormat` / `Intl.NumberFormat` | locale-aware 日期/数字 | 日志时间、更新日期、文件大小统一格式化 | 采用 |
| ICU MessageFormat | 强大的复数/选择/性别 | 本期不需要；i18next 插值 + plural 足够；避免新依赖 | 拒绝（本期） |

---

## 3. 结论到设计约束

| 研究结论 | 设计约束 | 落地任务 |
|---|---|---|
| 语言选择要持久化且跨会话一致 | `UiStore` 单一 key，跨窗口 storage 同步 | T-003/T-008 |
| 新增语言不应改代码 | 文案只在 locale 文件；`ns` 动态派生；无 Rust 文案表 | T-002/T-005/T-015 |
| 截断/误译是主要故障 | 英文长文案 E2E + 原生菜单手动冒烟 + 长度校验 | T-016/T-018 |
| 翻译会导致布局连锁变化 | 切换后再切回的幂等测试；Widget 重绘测试 | T-014/T-016 |
| 核心与文案分离 | editor-core 用 Facet，Rust 用投影，不引入第二 i18n | T-013/T-004 |
| 标准库做格式化 | 统一 `lib/format`，删除两份 `formatSize` | T-011 |
| 语言标签用 BCP 47 | `zh-CN`/`en` 校验；拒绝 `zh_cn` | T-002 |

---

## 4. 引用格式

- Gupta, K., & Wen, L. (2015). *Going Global? Let's Measure Your Product For World-Readiness!* Proceedings of ACL 2015 (Translation and Culturalization track). https://aclanthology.org/2015.tc-1.16.pdf
- Santos, R. E. S., Cordeiro, J. R., Labiche, Y., Magalhães, C. V. C., & da Silva, F. Q. B. (2020). *Bug! Falha! Bachi! Fallo! Défaut! 程序错误!: What about Internationalization Testing in the Software Industry?* ESEM '20. https://doi.org/10.1145/3382494.3422167
- Alameer, A., Mahajan, S., & Halfond, W. G. J. (2016). *Detecting and Localizing Internationalization Presentation Failures in Web Applications.* ICST 2016. https://doi.org/10.1109/ICST.2016.36
- Escobar-Velásquez, C., Osorio-Riaño, M., Dominguez-Osorio, J., Arevalo, M., & Linares-Vásquez, M. (2020). *An Empirical Study of i18n Collateral Changes and Bugs in GUIs of Android apps.* ICSME 2020. https://doi.org/10.1109/ICSME46990.2020.00061
- Collins, R. W. (2001). *Software Localization: Issues and Methods.* ECIS 2001. http://aisel.aisnet.org/ecis2001/4
