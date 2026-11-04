# 编辑器字体调整（Editor Typography）

> **模板定位：** LLM 持续实施控制台
> **功能 ID：** `editor-typography`
> **对应 SDD Spec：** 无（依据用户 2026-11-04 需求；参考 Typora/MarkText/SiYuan/Logseq/Joplin）
> **对应需求：** R-001 ~ R-006
> **功能分支：** `main`（方案阶段，未新建分支）
> **优先级：** P2（编辑器体验增强；不涉及数据安全）
> **负责人：** Qingmo 维护者
> **代码基线：** `main@3f654ba6d8d4866529d81566428214a320bebc61`
> **GitNexus 索引：** `3f654ba`，`status = ✅ 已是最新`
> **最新代码校准日期：** 2026-11-04
> **文档状态：** 实施完成，验证通过；等待用户确认提交
> **VERDICT：** `PASS`（typecheck / 769 Vitest / build / depcruise / format / 146 E2E）

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "editor-typography"
feature_name: "编辑器字体调整"
status: "done"                    # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "none"              # T-001 ~ T-009 全部完成
last_completed_task: "T-009"      # 全量验证与文档回填
next_action: "等待用户确认后提交（禁止 AI 署名）"
verification_status: "pass"       # 全量验证通过；detect_changes partial 已记录原因
research_status: "pass"
call_chain_status: "pass"
code_calibration_status: "pass"
last_verification_command: "pnpm typecheck; pnpm test -> 89 files/769 tests; pnpm build; pnpm depcruise; pnpm format:check; pnpm test:e2e -> 146 passed/4 skipped"
last_updated: "2026-11-04T18:55:00+08:00"
resume_from:
  - "README.md#0-LLM-STATE每轮实施前必须读取"
  - "01-实施计划.md#4-任务队列"
  - "02-实施状态与验证.md#3-执行日志"
  - "04-设计方案.md#14-已确认决策"
allowed_scope:
  - "packages/shared/src/editor-typography.ts"
  - "packages/shared/src/index.ts"
  - "packages/editor-core/src/extensions/typography.ts"
  - "packages/editor-core/src/extensions/theme.ts"
  - "packages/editor-core/src/createEditor.ts"
  - "packages/editor-core/src/index.ts"
  - "packages/editor-core/src/live-preview/code-blocks.ts"
  - "packages/editor-core/src/live-preview/theme.ts"
  - "apps/desktop/src/features/editor/EditorSession.ts"
  - "apps/desktop/src/stores/uiStore.ts"
  - "apps/desktop/src/app/uiStorageSync.ts"
  - "apps/desktop/src/app/useEditorTypography.ts"
  - "apps/desktop/src/features/workspace/WorkspaceLayout.tsx"
  - "apps/desktop/src/settings/SettingsWindow.tsx"
  - "apps/desktop/src/settings/settings.css"
  - "apps/desktop/src/i18n/locales/en.ts"
  - "apps/desktop/src/i18n/locales/zh-CN.ts"
  - "apps/desktop/src/**/*.test.*"
  - "e2e/**"
  - "docs/todo/editor-typography/**"
forbidden_scope:
  - "src-tauri/**"
  - "packages/shared/src/generated/**"
  - "apps/desktop/src/features/editor/EditorHost.tsx"
  - "apps/desktop/src/features/editor/DocumentSessionContext.tsx"
  - "apps/desktop/src/styles.css"
  - "packages/ui/src/tokens.css"
  - "packages/editor-core/src/minimap/**"
  - "apps/desktop/src/settings/LanguageSelect.tsx"
  - "packages/editor-core/src/live-preview/plugin.ts"
  - "packages/editor-core/src/live-preview/mermaid-theme.ts"
```

---

## 1. 摘要

青墨的编辑器排版目前硬编码为 `15px` / `var(--qm-font-mono)` / `1.75`，来源是 `packages/editor-core/src/extensions/theme.ts:21-34`。Settings 窗口只有语言，没有字号/字体入口。用户无法在不改 CSS 的情况下调整正文排版。

本方案新增：

- 字号 `12–30px`，默认 `15px`，步进 `1px`。
- 字体族三预设 `mono / sans / serif`，默认 `mono`，只使用现有 `--qm-font-*` token。
- Settings General 页第二个 section “Typography”，含 range、radio 卡片、实时预览、恢复默认。
- 单个 localStorage JSON 键 `qingmo.ui.editorTypography`（Q-001 已批准），通过现有 `uiStore` + `watchUiStorage` 跨窗口同步。
- 独立的 CM6 `typographyCompartment` + `EditorView.theme`；`editorThemeSpec` 不再声明 base 字号/字体/行高。

默认值等于当前行为，升级无视觉变化；切换只 dispatch compartment，不重建 `EditorView`、不清 undo、不移动选区。

> **实施状态（2026-11-04）：** T-001 ~ T-009 已全部完成；全量 Vitest 769、Playwright 146 通过。详见 [`02-实施状态与验证.md`](02-实施状态与验证.md)。

---

## 2. 需求与范围

### 2.1 需求

| ID | 需求 |
|---|---|
| R-001 | 字号 12–30px，默认 15px，步进 1px |
| R-002 | 字体族 mono/sans/serif，默认 mono |
| R-003 | 调整立即作用于所有已打开编辑器窗口；不重建 view、不清 undo、不移动选区 |
| R-004 | 持久化并在重启/新窗口恢复；非法值安全回退 |
| R-005 | Settings 实时预览 + 恢复默认；中英文案完整 |
| R-006 | 不新增 Rust/IPC/DB/菜单/快捷键；代码块/表格/Mermaid 保持既有字体策略 |

### 2.2 范围内

- 编辑器正文字号与字体族。
- 全局偏好持久化与跨窗口同步。
- Settings UI、i18n、CSS、测试。
- 嵌套代码块 `1.75/mono` 重复来源的收敛（T-003）。

### 2.3 范围外

- 行高设置、阅读宽度设置、应用级 zoom。
- 代码块独立字号/字体、表格字体、Mermaid 字体。
- 系统字体枚举、自由字体栈、字体导入。
- 每文档排版、导出/打印排版。
- 命令面板/原生菜单/快捷键。
- 任何 Rust/IPC/数据库/生成契约变更。

> **事实校准：** `packages/ui/src/tokens.css:180` 定义了 `--qm-content-max: 72ch`，但全仓无消费点；当前编辑器没有 72ch 行宽。本方案不得声称“保持 72ch”。

---

## 3. 推荐方案

```text
SettingsWindow (Typography section)
  -> uiStore.setTypography({ fontSize, fontFamily })
  -> localStorage "qingmo.ui.editorTypography" (JSON, version 1)
  -> storage event -> watchUiStorage
  -> uiStore.syncFromStorage
  -> useEditorTypography (useLayoutEffect)
  -> EditorSession.applyTypography
  -> setTypographyEffect
  -> typographyCompartment.reconfigure
  -> EditorView.theme({ fontSize, fontFamily, lineHeight })
  -> CM6 mustMeasureContent + requestMeasure
  -> minimap transaction.reconfigured -> rebuild
```

关键点：

- `EditorTypography` 纯模型放 `packages/shared/src/editor-typography.ts`。
- `typographyExtension` 放 `packages/editor-core/src/extensions/typography.ts`，按 `(fontSize,fontFamily)` 缓存。
- `createEditorState` 新增可选 `typography`，默认 `DEFAULT_EDITOR_TYPOGRAPHY`。
- `EditorSession` 构造（可选 seed）/`replacePayload` 传当前 typography；生产入口目前不传构造参数，持久化值由 `useEditorTypography` 的 layout effect 在 `EditorHost` 创建 view 前 seed；`applyTypography` 有 view dispatch、无 view `state.update`，并在 IME composition 期间延迟。
- `uiStore` 新增 `typography` 快照字段、`setTypography`（返回是否持久化成功）、`typographyPersistenceDegraded`、读取/同步（带 `changedKey`）/相等性。
- `WorkspaceLayout` 在 `useThemeService` 旁并列调用 `useEditorTypography`。
- **保留** `livePreviewTheme` 的六个嵌套代码块样式块（R2 BLOCKER：删除会因 CM6 级联顺序让代码块在 serif/sans 下失去 mono/padding 0/height auto）；只把两处 `1.75` 改为 `EDITOR_LINE_HEIGHT` 常量。

---

## 4. 关键决策

| ID | 决策 | 理由 |
|---|---|---|
| D-001 | 范围 = 字号 + 字体族三预设 | 最小可用；证据支持 |
| D-002 | 12–30px，默认 15，步进 1 | 覆盖 24px 推荐点；默认不变 |
| D-003 | mono/sans/serif，默认 mono | 现有 token；默认不变 |
| D-004 | 全局偏好，单 JSON localStorage 键 | 原子、可迁移；与 theme/language 同层 |
| D-005 | 纯模型放 shared | editor-core 与 app 都依赖；无 DOM |
| D-006 | 新 `typographyCompartment`，不扩展 theme | 职责单一；避开 HIGH |
| D-007 | `editorThemeSpec` 删除 base 排版 | 单一来源 |
| D-008 | `EditorSession` 持有 typography；构造可选 seed、`replacePayload` 传 factory | reload 正确；生产首帧由 layout effect seed |
| D-009 | `useLayoutEffect` 投影 | 在 EditorHost passive 前 seed |
| D-010 | `UiSnapshot.typography` + sync filter + degraded | 复用现有模式，写失败不回滚 |
| D-011 | Settings General 第二 section | 不新增路由/Tab |
| D-012 | 原生 range + 可见 radio + preview + reset | 可访问、无新组件库 |
| D-013 | 保留外层六块，只收敛 `1.75` 常量 | R2：删除会破坏嵌套代码 mono/padding/height |
| D-014 | `EDITOR_LINE_HEIGHT=1.75` 常量 | 行高固定但值单一 |
| D-015 | 不加命令/菜单/快捷键 | 首版最小 |

---

## 5. 风险与缓解

| RK-ID | 风险 | 等级 | 缓解 |
|---|---|---|---|
| RK-001 | 大文档切换卡顿 | 中 | 缓存/rAF/benchmark；必要时 debounce |
| RK-002 | 首帧默认值闪烁 | 中 | `useLayoutEffect` 在 EditorHost passive 前 seed；E2E 首次可观测帧 |
| RK-003 | 跨窗口不同步 | 高 | `watchUiStorage` 加 key + `event.key`；测试 4 次；E2E |
| RK-004 | `UiSnapshot` 形状变更 | 高 | 同步所有全量测试；typecheck |
| RK-005 | Settings 1120×720 布局溢出 | 中 | 300px 控件 + 滚动；E2E |
| RK-006 | 字体族未作用到标题/表格 | 中 | 继承 + E2E；表格保持 mono 是预期 |
| RK-007 | 嵌套代码样式回归 | 中 | 保留外层六块；只替换行高常量；E2E |
| RK-008 | localStorage 损坏/禁用 | 中 | try/catch + degraded 标志 + 一次性 toast |
| RK-009 | 降级旧版本 | 低 | 新键忽略；默认不变 |
| RK-010 | minimap stale | 低 | composition 延迟 + `transaction.reconfigured` 重建 |
| RK-011 | radio 可访问性 | 中 | 原生 input/label/focus ring |
| RK-012 | `EditorSession` CRITICAL | 高 | 最小 API + 全量回归 + `detect_changes` |
| RK-013 | 误称 72ch | 中 | 文档校准；不实现行长 |
| RK-014 | 1.75 vs Rello 1.8 | 低 | 保持现状；Q-004 |

---

## 6. 验收标准

| AC-ID | 验收 | 验证 |
|---|---|---|
| AC-001 | `pnpm typecheck` PASS | C-101 |
| AC-002 | 共享模型单测通过（默认/clamp/trunc/非法/幂等/equals） | `editor-typography.test.ts` |
| AC-003 | 扩展/compartment 单测通过（缓存/不改 doc） | `typography.test.ts` + `editor-core.test.ts` |
| AC-004 | Session 生命周期（view 身份/undo/selection/reload/composing） | `typography.test.ts` |
| AC-005 | Store 持久化/损坏回退/降级/跨窗口同步 | `uiStore.test.ts` + `uiStorageSync.test.ts` |
| AC-006 | Hook null/变化/同值 | `useEditorTypography.test.tsx` |
| AC-007 | Settings 渲染/交互/重置/localStorage | `SettingsWindow.test.tsx` |
| AC-008 | E2E Settings→编辑器计算样式（20px/serif/line-height 比值/标题 1.6em） | `e2e/editor-typography.spec.ts` |
| AC-009 | E2E reload 持久化 + 恢复默认 | 同上 |
| AC-010 | 嵌套代码样式回归（serif 下仍 mono/padding 0/height auto/1.75） | E2E + `markdown-syntax.spec.ts` |
| AC-011 | 全量 Vitest + 关键 E2E | C-108/C-107 |
| AC-012 | 无 `src-tauri/**`、`generated/**`、禁改文件（含未跟踪） | C-113 |
| AC-013 | `detect_changes` 无 `partial/truncated` | C-112 |
| AC-014 | i18n parity + 无硬编码汉字 | `pnpm test` |

---

## 7. 交付物

| 文件 | 内容 |
|---|---|
| `README.md` | 本控制台 |
| `01-实施计划.md` | 任务队列 T-000~T-009 |
| `02-实施状态与验证.md` | 基线命令、验证矩阵、VERDICT |
| `03-复盘与交接.md` | 决策、坑、交接清单 |
| `04-设计方案.md` | 完整设计、修改点、时序、风险 |
| `05-多轮评审记录.md` | R1~R4 评审与修复 |
| `research/01-official-docs.md` | CM6/WCAG/React |
| `research/02-oss-implementations.md` | Typora/MarkText/SiYuan/Logseq/Joplin |
| `research/03-papers-and-hci.md` | Rello/Dyson/Zhu/Beymer |
| `research/04-call-chain-and-impact.md` | GitNexus/拓扑/影响面 |
| `research/05-code-calibration.md` | 基线/代码事实/假设校准 |

---

## 8. 已确认决策（2026-11-04 全部采纳推荐项）

> Q-001 ~ Q-005 已由用户确认，全部采纳推荐项 **A**。以下保留选项与理由，供实施与后续复盘追溯。

### Q-001 持久化方式（已批准：A）

- **A（已采纳）：** 单个 JSON 键 `qingmo.ui.editorTypography`，`{version:1,fontSize,fontFamily}`。
- B：两个 scalar 键 `qingmo.ui.editorFontSize` + `qingmo.ui.editorFontFamily`。
- C：仅会话内生效，不持久化。
- D：Rust `settings.json`/DB 表（当前无此层）。

**决策理由：** 原子写入、一个 key、易迁移、与 `UiSnapshot.typography` 对齐。批准的新增项：localStorage key、`UiSnapshot.typography` 字段、`EditorTypography` 模型与 `version:1`。不新增数据库表、Rust 命令或 IPC。

### Q-002 字号范围与默认值（已采纳：A）

- **A（已采纳）：** 12–30px，默认 15px，步进 1px。
- B：12–32px，默认 15px。
- C：9–24px，默认 15px。
- D：14–24px，默认 15px。

**决策理由：** 默认保持现状；上限 ≥24px（Rello 18pt 推荐点）；下限覆盖小字号偏好。

### Q-003 字体族预设与默认值（已采纳：A）

- **A（已采纳）：** mono / sans / serif，默认 mono。
- B：同上，默认 sans。
- C：同上，默认 serif。
- D：增加自由字体栈输入。

**决策理由：** 默认 = 当前行为；三个 token 已是设计系统的一部分；不新增字体资源。

### Q-004 功能范围（已采纳：A）

- **A（已采纳）：** 字号 + 字体族；行高固定 1.75；不做阅读宽度/zoom。
- B：再加行高 1.4–2.0。
- C：再加阅读宽度 55–100ch，接入 `--qm-content-max`。
- D：再加应用级 zoom。

**决策理由：** 最小可用；行高/行长/zoom 是独立变量，需单独验证。

### Q-005 Settings 信息架构（已采纳：A）

- **A（已采纳）：** 在现有 General 页追加第二个 section “Typography / 排版”。
- B：左侧 nav 新增 “Typography” 独立项/Tab。
- C：编辑器状态栏/popover 内联。
- D：独立窗口。

**决策理由：** 不新增路由/Tab；复用现有布局；窗口可滚动。

---

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-04 | v1.0 | 初稿：完成调研/调用链/设计/任务队列 |
| 2026-11-04 | v1.1 | R2/R3/R4 修订：保留嵌套代码外层六块、首帧 layout effect 语义、持久化降级、E2E/可访问性修正 |
| 2026-11-04 | v1.2 | Q-001 ~ Q-005 全部采纳推荐项 A；解除任务阻塞，进入待实施状态 |
| 2026-11-04 | v1.3 | T-001 ~ T-009 实施完成；全量 Vitest/E2E/构建/依赖/格式检查通过 |
