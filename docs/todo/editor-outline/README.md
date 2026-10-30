# 编辑器大纲面板（Outline）

> **模板定位：** LLM 持续实施控制台  
> **功能 ID：** `editor-outline`  
> **对应 SDD Spec：** 无（依据用户 2026-10-30 的“左侧大纲面板”需求与 `third_party/typora-recovered` 行为证据）  
> **对应需求：** R-001 ~ R-008  
> **功能分支：** `main`（当前工作树，未新建分支）  
> **优先级：** P1（编辑器核心导航能力；不涉及数据安全）  
> **负责人：** Qingmo 维护者  
> **最新代码校准日期：** 2026-10-30  
> **代码基线：** `main@e97d651`  
> **GitNexus 索引：** `e97d651`，`status = ✅ 已是最新`（391 个文件）

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "editor-outline"
feature_name: "编辑器大纲面板（Outline）"
status: "done"                 # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "none"
last_completed_task: "T-009"
next_action: "征得用户同意后提交；提交后复跑 pnpm ci:generated"
verification_status: "pass"    # not_run | pass | fail | partial | skipped
research_status: "pass"
call_chain_status: "pass"
code_calibration_status: "pass"
last_verification_command: "pnpm test:e2e"
last_updated: "2026-10-30T18:00:00+08:00"
resume_from:
  - "README.md#0-LLM-STATE每轮实施前必须读取"
  - "01-实施计划.md#6-LLM任务队列"
  - "02-实施状态与验证.md#3-执行日志"
allowed_scope:
  - "packages/editor-core/src/live-preview/outline.ts"          # 新增
  - "packages/editor-core/src/live-preview/outline.test.ts"     # 新增
  - "packages/editor-core/src/live-preview/details-range.ts"    # 新增，轻量详情范围读取
  - "packages/editor-core/src/live-preview/details.ts"          # 仅重构为复用 details-range，行为不变
  - "packages/editor-core/src/live-preview/heading-text.ts"     # 移入 plainInlineText
  - "packages/editor-core/src/live-preview/toc.ts"
  - "packages/editor-core/src/live-preview/heading-anchors.ts"
  - "packages/editor-core/src/live-preview/heading-anchors.test.ts"
  - "packages/editor-core/src/live-preview/corpus.test.ts"        # UT-012 视需要补 TOC 断言
  - "packages/editor-core/src/limits.ts"
  - "packages/editor-core/src/createEditor.ts"
  - "packages/editor-core/src/index.ts"
  - "apps/desktop/src/features/editor/EditorSession.ts"
  - "apps/desktop/src/features/editor/editor-session.test.ts"
  - "apps/desktop/src/features/editor/editor-binding.test.tsx"
  - "apps/desktop/src/features/editor/outline/**（新增）"
  - "apps/desktop/src/features/editor/EditorPage.tsx"
  - "apps/desktop/src/features/workspace/WorkspaceLayout.tsx"
  - "apps/desktop/src/features/workspace/menu-actions.test.tsx"
  - "apps/desktop/src/features/workspace/open-flow.test.tsx"
  - "apps/desktop/src/lib/ipc/commands.ts"
  - "apps/desktop/src/lib/ipc/contract.test.ts"
  - "apps/desktop/src/i18n/native.ts"
  - "apps/desktop/src/i18n/locales/zh-CN.ts"
  - "apps/desktop/src/i18n/locales/en.ts"
  - "apps/desktop/src/i18n/locales/menu.zh-CN.json"
  - "apps/desktop/src/i18n/locales/menu.en.json"
  - "src-tauri/src/ipc/contract.rs"
  - "src-tauri/src/ipc/dto.rs"
  - "src-tauri/src/state/shell_locale.rs"                       # 测试 JSON 补 outline
  - "src-tauri/src/lib.rs"
  - "src-tauri/src/startup_locale.rs"                            # 仅测试/资源投影，如需要
  - "src-tauri/tests/commands_contract.rs"
  - "packages/shared/src/generated/NativeShellLabels.ts（生成物）"
  - "e2e/helpers.ts"
  - "e2e/outline.spec.ts（新增）"
  - "e2e/outline-perf.spec.ts（新增）"
  - "e2e/fixtures/outline.md（新增）"
  - "e2e/fixtures/outline-switched.md（新增）"
  - "bench/outline.bench.ts（新增）"
  - "vitest.bench.config.ts（bench worker 内存参数）"
  - "docs/todo/editor-outline/**"
forbidden_scope:
  - "apps/desktop/src/stores/uiStore.ts（除非 Q-003 改为持久化并由用户批准）"
  - "apps/desktop/src/styles.css"
  - "packages/ui/src/tokens.css"
  - "packages/editor-core/src/live-preview/frontmatter.ts"
  - "packages/editor-core/src/live-preview/specs.ts（只允许随 heading-anchors 签名保持不变）"
  - "packages/editor-core/src/minimap/**"
  - "apps/desktop/src/features/editor/session/ViewStateRecorder.ts"
  - "src-tauri/src/commands/**（不新增 IPC 命令）"
  - "任何数据库/迁移/持久化配置"
stop_condition: "所有 required=true 的 T-### 均为 done，02 的最终验证 VERDICT: PASS"
blocker_policy: "遇到 blocked 时记录 B-###、失败证据、已尝试方案和下一恢复动作"
```

> **状态更新规则：** 每完成一个任务，必须同步更新 `current_task`、`last_completed_task`、`next_action`、`verification_status`、`code_calibration_status`、`last_updated`；本方案生成时已更新 `research_status` 与 `call_chain_status`。

---

## 1. 一句话结论

`editor-outline` 已实施完成并通过全部质量门（`VERDICT: PASS`）。`editor-core` 的 `headingOutline` StateField 是唯一标题模型，`[TOC]`、标题锚点与左侧大纲共享它；`EditorSession` 通过独立 outline 订阅与 `revealPosition` 暴露给 React。默认隐藏，通过命令面板与原生“显示 > 大纲”打开；开关只在会话内内存，不新增持久化配置、DB、IPC 命令或第三方依赖。实现、性能、回滚与提交前审查证据见 `02-实施状态与验证.md`。

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 左侧大纲面板可打开/关闭，默认隐藏；显示当前文档的标题层级 | E2E-001/002/010：默认无面板、菜单/命令打开后可见、再次关闭 | pass |
| R-002 | 唯一标题数据源：`[TOC]`、标题锚点、侧栏大纲共用 `headingOutline` | 代码审查 + UT-001~UT-006 + 现有 TOC/锚点回归 | pass |
| R-003 | 点击条目跳转到标题行并滚动到视口顶部附近；不修改文档 | E2E-003/004；UT-019 | pass |
| R-004 | 编辑、重载、Source/Live Preview 切换、主题/语言切换后大纲保持同步 | E2E-005/006/007/008 + UT-010/011/014/015/018 | pass |
| R-005 | 正确排除 frontmatter、`<details>`、围栏代码块内标题；支持 ATX/Setext | UT-002/003/004；E2E-009 | pass |
| R-006 | 大文档有界降级：最多扫描 200k UTF-16 units；字段安全上限 5000 条、UI 500 条；partial 提示；不阻塞输入 | BENCH-001~006；C-009；E2E-011/015/016/017 | pass |
| R-007 | 可访问、可国际化；命令面板、原生菜单、i18n 多处一致 | E2E-012/013/014；Rust 菜单测试；`native.test.ts` | pass |
| R-008 | 零持久化配置/DB；回滚路径明确 | `git diff --stat` + 回滚演练 | pass |

### 2.2 非目标

| 项 | 原因 | 后续处理 |
|---|---|---|
| 左侧文件树/文件夹 | 用户原话包含“文件夹/大纲”，截图只展示大纲；文件树涉及 workspace 模型、文件监听、拖拽与持久化，不能与本方案混做 | `Q-001`；如需要另立 `workspace-file-tree` 方案 |
| 大纲内搜索/过滤 | Typora 有 filter，但需要命中高亮、键盘上下选择与额外 i18n；v1 先保证可靠跳转 | `NEXT-002` |
| 可折叠/展开的树、拖拽排序、自动编号 | Typora/VS Code 有折叠；Markdown 大纲通常层级不深，v1 平铺 + 缩进足够；折叠需要每项状态与键盘树语义 | `NEXT-003` |
| 随视口滚动高亮（Typora `highlightVisibleHeader`） | 需要 scroll 监听、rAF 合并和几何计算；v1 使用光标行高亮，确定性强且可测 | `Q-004`；`NEXT-004` |
| 富文本/Markdown 行内格式渲染 | 侧栏只做导航，不复制 Markdown 渲染；纯文本可避免第二套 inline renderer | 无 |
| 代码块内符号（函数/类）大纲 | 本文档大纲只表达 Markdown 标题；代码块有独立编辑器与语言服务 | 无 |
| 修复标题 slug 冲突/显式锚点覆盖规则 | 会改变链接解析语义，属于独立缺陷修复 | `Q-006`；`NEXT-005` |
| 多窗口同步大纲开关、持久化开关 | 每个 Tauri 文档窗口是独立 webview；跨窗口同步需要 localStorage/BroadcastChannel/新 IPC | `Q-003`；`NEXT-006` |
| 新增默认快捷键 | 需要避免与现有 `Mod+O/S/K/L` 冲突并更新 keybinding 文档 | `Q-007` |

---

## 3. 当前运行时链路 / 目标调用链

### 3.1 调研与调用链证据摘要

| 项 | 状态 | 证据位置 | 结论摘要 |
|---|---|---|---|
| 官方文档调研 | pass | [`research/01-official-docs-and-oss.md`](research/01-official-docs-and-oss.md) | CM6 初始语法树只到 3000 units；`ensureSyntaxTree` 可推进解析；`StateField` 适合放共享标题模型 |
| GitHub 开源实现调研 | pass | 同上 | Zettlr `tocField` 是 StateField；VS Code OutlineModelService 去抖/取消、活动项跟随光标；MarkText TOC 来自 Muya 的第二套内容模型 |
| 论文/HCI 调研 | pass | [`research/03-papers-and-hci.md`](research/03-papers-and-hci.md) | 标题/TOC 提升长文定位效率；超大层级需要折叠/多面板；导航工具不应替代搜索 |
| DeepWiki/Exa 外部检索 | pass | `research/01` §1/§3 | 用于确认开源实现职责与论文结论；关键 API 以本地源码二次核对 |
| subagent/GitNexus 调用链分析 | pass | [`research/02-call-chain-and-impact.md`](research/02-call-chain-and-impact.md) | `EditorSession` CRITICAL；`createEditorState` HIGH；`headingText` HIGH；`tocPreview` impact UNKNOWN 但被值引用 |
| 当前代码实时校准 | pass | `02-实施状态与验证.md §8` | HEAD `e97d651`；索引 current；无既有 outline 实现 |
| 性能证据 | pass | [`research/04-performance-and-test-evidence.md`](research/04-performance-and-test-evidence.md) | 实测 p95：200k/500 build 1.30ms、面板打开 180.8ms、输入 0 个 >50ms 长任务（`02 §4`） |

### 3.2 目标调用链

```text
EditorSession.create / createUntitled / restoreDraft
  -> EditorSession 构造函数
  -> createEditorState({ extraExtensions })
     -> basicExtensions + markdownExtensions
     -> headingOutline (StateField)                 ← 唯一标题模型
     -> outlineParseDriver (ViewPlugin)             ← 空闲切片推进语法树
  -> EditorHost new EditorView
     -> 初始 3000 units 解析
     -> outlineParseDriver 逐帧 forceParsing 到扫描上限
     -> headingOutline 在 treeChanged 时重建
  -> [TOC] 占位符 / 标题锚点 / 侧栏都读取同一个 headingOutline
  -> EditorSession.subscribeOutline / getOutlineSnapshot
  -> OutlinePanel（纯文本列表）
  -> 点击 -> EditorSession.revealPosition(lineFrom)
     -> view.dispatch({ selection, effects: scrollIntoView(y:"start", yMargin:10) })
```

关键约束：

1. 文档仍只来自 `EditorState`；侧栏不读取 `readText()`，不复制 Markdown。
2. 标题文本不得进入 `EditorSessionSnapshot`；必须走独立的 outline 订阅。
3. 任何解析/渲染失败只能降级为“无大纲/部分大纲”，不能中断编辑、保存或关闭。
4. 默认隐藏，未打开时零布局变化；打开后只有面板宽度让位，不改变编辑器 DOM 生命周期。

---

## 4. 当前实施状态总览

| T-ID | 任务 | Status | DependsOn | Evidence | Next |
|---|---|---|---|---|---|
| T-001 | 失败用例与契约 | done | none | none | 先写 UT/E2E 红例 |
| T-002 | `headingOutline` 模型、轻量 details 范围、字段与解析驱动 | done | T-001 | none | 实现 `outline.ts`/`details-range.ts` |
| T-003 | `[TOC]` 与标题锚点改为消费共享字段 | done | T-002 | none | 改 `toc.ts`/`heading-anchors.ts` |
| T-004 | `EditorSession` 桥接与 StrictMode 监听修复 | done | T-003 | none | 加 outline 订阅/reveal |
| T-005 | 开关命令、原生菜单、i18n、生成绑定 | done | T-004 | none | 改多处菜单契约 |
| T-006 | `OutlinePanel` 与 `EditorPage` 布局 | done | T-005 | none | 实现侧栏 |
| T-007 | E2E：开关/跳转/活动项/模式/边界 | done | T-006 | none | 写 `e2e/outline.spec.ts` |
| T-008 | 性能与可访问性校准 | done | T-007 | none | bench + browser perf |
| T-009 | 全量验证、回滚演练与收尾 | done | T-008 | none | C-011/C-012 |
| T-010 | 文件树（Q-001=A，另立方案） | skipped | T-009 | none | 当前范围只做大纲 |

状态值只允许：`todo`、`in_progress`、`blocked`、`done`、`skipped`。

---

## 5. 交付物清单

| 类型 | 路径/对象 | 预期变更 | 状态 | 证据 |
|---|---|---|---|---|
| Code | `packages/editor-core/src/live-preview/outline.ts` | 新增 `headingOutline`、`readHeadingOutline`、`outlineParseDriver` | done | 02 §3 |
| Code | `packages/editor-core/src/live-preview/details-range.ts` | 新增轻量闭合 `<details>` 范围读取；不依赖 `specs.ts`/DOM | done | 02 §3 |
| Code | `packages/editor-core/src/live-preview/details.ts` | 仅改为复用 `details-range` 的标签扫描，行为/签名不变 | done | 02 §3 |
| Code | `packages/editor-core/src/live-preview/heading-text.ts` | 接收 `plainInlineText`；`heading-anchors.ts` re-export | done | 02 §3 |
| Code | `packages/editor-core/src/live-preview/toc.ts` | 删除重复标题扫描，改为读取共享字段 | done | 02 §3 |
| Code | `packages/editor-core/src/live-preview/heading-anchors.ts` | 改为消费共享字段的 `plainText/level/lineFrom` | done | 02 §3 |
| Code | `packages/editor-core/src/limits.ts` | 新增 `OUTLINE_SCAN_MAX_UNITS`/`OUTLINE_SAFETY_MAX_ENTRIES`/`OUTLINE_PANEL_MAX_ENTRIES` 等 | done | 02 §3 |
| Code | `packages/editor-core/src/createEditor.ts` | 基座注入字段与解析驱动 | done | 02 §3 |
| Code | `packages/editor-core/src/index.ts` | 导出字段、读取函数和类型 | done | 02 §3 |
| Code | `apps/desktop/src/features/editor/EditorSession.ts` | outline 订阅、快照、`revealPosition`/`focusEditor`、监听代际修复 | done | 02 §3 |
| Code | `apps/desktop/src/features/editor/outline/OutlinePanel.tsx` | 新增侧栏组件 | done | 02 §3 |
| Code | `apps/desktop/src/features/editor/outline/outlineVisibility.ts` | 新增会话内开关 store | done | 02 §3 |
| Code | `apps/desktop/src/features/editor/outline/useOutline.ts` | 新增 `useSyncExternalStore` 绑定 | done | 02 §3 |
| Code | `apps/desktop/src/features/editor/outline/active.ts` | 新增活动项二分、状态文案、面板内滚动 helper | done | 02 §3 |
| Code | `apps/desktop/src/features/editor/EditorPage.tsx` | 左侧面板 + 编辑器 flex 布局 | done | 02 §3 |
| Code | `apps/desktop/src/features/workspace/WorkspaceLayout.tsx` | 注册 `view.toggleOutline`、处理菜单动作 | done | 02 §3 |
| Code | `apps/desktop/src/lib/ipc/commands.ts` | 新增菜单动作镜像 | done | 02 §3 |
| Code | `apps/desktop/src/i18n/native.ts`、`locales/*` | 新增 outline 文案与菜单标签 | done | 02 §3 |
| Code | `src-tauri/src/ipc/contract.rs`、`dto.rs`、`lib.rs` | 新增菜单动作与 `outline` 标签 | done | 02 §3 |
| Code | `packages/shared/src/generated/NativeShellLabels.ts` | 由 `cargo test --manifest-path src-tauri/Cargo.toml --test export_bindings` 生成 | done | 02 §3 |
| Test | `packages/editor-core/src/live-preview/outline.test.ts` | 新增模型/字段/排除/限额测试 | done | 02 §3 |
| Test | `packages/editor-core/src/live-preview/heading-anchors.test.ts` | 补共享字段回归 | done | 02 §3 |
| Test | `packages/editor-core/src/live-preview/corpus.test.ts` | 仅在 UT-012 需要时补 TOC/字段一致性断言 | done | 02 §3 |
| Test | `apps/desktop/src/features/editor/editor-session.test.ts` | 补 outline/StrictMode/重载测试 | done | 02 §3 |
| Test | `apps/desktop/src/features/editor/outline/*.test.tsx` | 新增面板/开关/活动项测试 | done | 02 §3 |
| Test | `apps/desktop/src/features/workspace/menu-actions.test.tsx` | 补菜单动作开关 | done | 02 §3 |
| Test | `apps/desktop/src/features/workspace/open-flow.test.tsx` | 命令面板 6 项改为 7 项 | done | 02 §3 |
| Test | `apps/desktop/src/lib/ipc/contract.test.ts` | `MENU_ACTION_NAMES` 精确数组加入 `view.toggleOutline` | done | 02 §3 |
| Test | `src-tauri/src/startup_locale.rs` | 启动菜单 JSON 投影自动覆盖 `outline` 字段 | done | 02 §3 |
| Test | `src-tauri/tests/commands_contract.rs` | `MENU_ACTIONS` 长度 11→12；`valid_labels()` 加 `outline` | done | 02 §3 |
| Test | `e2e/outline.spec.ts` | 新增大纲 E2E | done | 02 §3 |
| Test | `e2e/helpers.ts` | 补 `view.toggleOutline` 菜单动作类型 | done | 02 §3 |
| Test | `e2e/fixtures/outline.md` | 新增 ATX/Setext/frontmatter/details/fence/重复标题 fixture | done | 02 §3 |
| Test | `e2e/outline-perf.spec.ts` | 新增大文档打开/输入采样 | done | 02 §3 |
| Bench | `bench/outline.bench.ts` | 新增纯函数性能记录 | done | 02 §3 |
| Config | 无 | 不新增 `UiStore`/`localStorage`/Rust/SQLite 配置 | — | 无 |
| DB | 无 | 不新增表/迁移 | — | 无 |
| IPC | 无新增命令；仅新增菜单动作字符串 | 兼容 | — | 无 |
| Doc | `docs/todo/editor-outline/**` | 方案/计划/验证/复盘/评审/研究 | done | 本目录（`docs/` 被 gitignore，提交需 `git add -f`） |

---

## 6. 数据模型 / 配置 / 接口

### 6.1 数据模型

```ts
export type OutlineStatus = "complete" | "partial" | "error";
export type OutlineLimitReason = "size" | "count" | null;

export interface HeadingOutlineEntry {
  /** 1-6，来自 ATX/SetextHeadingN。 */
  level: number;
  /** 去掉 #/Setext 下划线后的原始标题文本。 */
  text: string;
  /** 精确的 plainInlineText(text)，可以为空；UI 显示时回退 text。 */
  plainText: string;
  /** 标题节点在文档中的范围。 */
  from: number;
  to: number;
  /** 1-based 行号，用于活动项二分。 */
  line: number;
  /** 标题行首位置，用于 selection/scroll。 */
  lineFrom: number;
}

export interface HeadingOutlineState {
  entries: readonly HeadingOutlineEntry[];
  status: OutlineStatus;
  /** 文档超过扫描上限且树覆盖 limit 时为 "size"；字段安全上限 5000 条时为 "count"。 */
  limitReason: OutlineLimitReason;
  /** status=error 时的简短原因；不包含正文。 */
  errorReason: string | null;
}
```

### 6.2 配置项

| 配置项 | 环境变量 | 默认值 | 行为 | 兼容性 |
|---|---|---|---|---|
| 无用户配置 | 无 | 大纲默认隐藏 | 会话内开关，不写 `localStorage`/DB/Rust | 默认行为不变 |

内部工程常量（不是用户配置，Q-005 可调整）：

| 常量 | 值 | 说明 |
|---|---:|---|
| `OUTLINE_SCAN_MAX_UNITS` | 200,000 | 大纲扫描上限；初始值与 `PREVIEW_FULL_MAX_UNITS` 相同，但独立可调，避免 Q-005 改 preview 预算 |
| `OUTLINE_SAFETY_MAX_ENTRIES` | 5,000 | 字段保留的安全上限；保证 UI 只显示 500 条时，第 501 条之后的标题仍可生成锚点 |
| `OUTLINE_PANEL_MAX_ENTRIES` | 500 | 侧栏最多渲染的标题数；只影响 DOM，不影响字段/锚点 |
| `OUTLINE_PARSE_CHROMIUM_SLICE_MS` | 8ms | Chromium 单个空闲回调最多推进的解析时间 |
| `OUTLINE_PARSE_CHUNK_UNITS` | 50,000 | 每个分块目标为当前树 + 50k；同一 8ms 回调可连续推进多个块 |
| `OUTLINE_PARSE_MAX_ATTEMPTS_PER_CHUNK` | 16 次 | 同一 target 最多 16 次 8ms 尝试；false 不代表 context 未推进，不能按 3 次 false 判死 |
| `OUTLINE_PARSE_WEBKIT_DELAY_MS` | 64ms | 无 `requestIdleCallback`（WKWebView）时的调度延迟 |
| `OUTLINE_PARSE_WEBKIT_SLICE_MS` | 4ms | 无空闲 API 时单次推进预算 |
| `OUTLINE_NOTIFY_MS` | 100ms | 设计默认值；不作为独立常量导出，`EditorSession` 复用 `statusThrottleMs`（默认 100ms，测试可注入） |
| `OUTLINE_PANEL_WIDTH` | 240px | 设计令牌；实现用 Tailwind `w-60`，无同名 TS 导出 |
| `OUTLINE_MIN_VIEWPORT` | 900px | 设计令牌；实现用 `min-[900px]:flex`，无同名 TS 导出 |
| `OUTLINE_SCROLL_MARGIN` | 10px | 点击后标题距视口顶部的余量（对齐 Typora `scrollAdjust(10)`） |

### 6.3 API / 对外接口

| 接口 | 变更 | 兼容性 | 验证 |
|---|---|---|---|
| `headingOutline: StateField<HeadingOutlineState>` | 新增导出 | 非破坏性 | `outline.test.ts` |
| `readHeadingOutline(state): HeadingOutlineState` | 新增导出 | 非破坏性 | 单测 |
| `EditorSession.getOutlineSnapshot(): HeadingOutlineState` | 新增方法 | 非破坏性 | `editor-session.test.ts` |
| `EditorSession.subscribeOutline(listener): () => void` | 新增方法 | 非破坏性 | 单测 |
| `EditorSession.revealPosition(position: number): boolean` | 新增方法 | 非破坏性 | 单测/E2E |
| `EditorSession.focusEditor(): boolean` | 新增方法 | 非破坏性 | 面板关闭回焦 |
| `readDetailsRanges(state): readonly DetailsRange[]` | 内部函数（`editor-core` 内部/测试，不新增公共 API） | 非破坏性 | `details`/`outline` 单测 |
| `view.toggleOutline` 命令 | 新增 | 非破坏性 | 命令/菜单测试 |
| `view.toggleOutline` 菜单动作 | 新增 | 非破坏性 | Rust/TS 契约测试 |
| IPC/Rust 命令/DB | 不新增 | 完全兼容 | `git diff --stat` |

---

## 7. 验收标准

| AC-ID | 验收项 | 覆盖任务 | 验证命令/证据 | Status |
|---|---|---|---|---|
| AC-001 | 默认无面板；命令面板与原生菜单均可打开/关闭 | T-005/T-006/T-007 | E2E-001/002/010 | pass |
| AC-002 | 标题文本/层级/顺序与文档一致；ATX/Setext 都支持 | T-002/T-007 | UT-001/002；E2E-003 | pass |
| AC-003 | frontmatter、details、围栏代码块内标题不出现 | T-002/T-007 | UT-003/004；E2E-009 | pass |
| AC-004 | 点击条目后光标落在标题行首，标题进入视口且距顶约 10px | T-004/T-007 | E2E-003/004 | pass |
| AC-005 | 活动项跟随光标；光标在首个标题前时无活动项 | T-006/T-007 | E2E-005 | pass |
| AC-006 | Source/Live Preview 两种模式都显示同一份大纲 | T-003/T-007 | E2E-006；现有模式测试 | pass |
| AC-007 | 编辑、重载、切换文档后大纲更新且不残留旧标题 | T-004/T-007 | E2E-007/008；UT-015/018 | pass |
| AC-008 | `[TOC]` 与标题锚点仍工作，且不再单独扫描标题 | T-003 | C-001；代码审查 | pass |
| AC-009 | 无第二套标题解析/第二套 Markdown 渲染；`details.ts` 只复用标签扫描 | T-002/T-003 | 审查 + `git diff --stat` | pass |
| AC-010 | 200k/500 标题常用路径性能达标；字段最多 5000 条、UI 最多 500 条；超限显示 partial 提示且不阻塞输入；锚点只覆盖前缀 | T-002/T-003/T-008 | BENCH-001~006；C-009；E2E-011/015/016/017；UT-034 | pass |
| AC-011 | `nav`/`ul`/`button`、`aria-current`、roving tabindex、关闭按钮可读；窄窗布局不破 | T-006/T-008 | E2E-012/013 | pass |
| AC-012 | zh-CN/en 文案完整；菜单多处契约一致；生成绑定最新；主题/语言切换正确 | T-005 | C-004/C-010；`native.test.ts`；E2E-014 | pass |
| AC-013 | 零持久化配置/DB/新 IPC 命令 | T-009 | `git diff --stat` + 审查 | pass |
| AC-014 | 回滚可执行：关闭面板/移除命令后编辑器回归 | T-009 | 回滚演练 C-007 | pass |

---

## 8. 验证入口

```bash
# T-001：先记录红色
pnpm vitest run packages/editor-core/src/live-preview/outline.test.ts
pnpm vitest run apps/desktop/src/features/editor
pnpm exec playwright test e2e/outline.spec.ts

# T-002/T-003
pnpm vitest run packages/editor-core/src/live-preview

# T-004
pnpm vitest run apps/desktop/src/features/editor

# T-005
pnpm vitest run apps/desktop/src/features/workspace apps/desktop/src/i18n
cargo test --manifest-path src-tauri/Cargo.toml --all-targets

# T-006
pnpm vitest run apps/desktop/src/features/editor/outline
pnpm typecheck

# T-007
pnpm exec playwright test e2e/outline.spec.ts

# T-008
pnpm typecheck:bench
pnpm exec vitest run --config vitest.bench.config.ts bench/outline.bench.ts
OUTLINE_PERF=1 pnpm exec playwright test e2e/outline-perf.spec.ts

# T-009
pnpm ci:generated
pnpm ci:web
pnpm test:e2e
```

| C-ID | Command | 何时运行 | 预期 |
|---|---|---|---|
| C-001 | `pnpm vitest run packages/editor-core/src/live-preview` | T-002/T-003 后 | PASS |
| C-002 | `pnpm vitest run apps/desktop/src/features/editor` | T-004 后 | PASS |
| C-003 | `pnpm vitest run apps/desktop/src/features/editor/outline apps/desktop/src/features/workspace apps/desktop/src/i18n` | T-005/T-006 后 | PASS |
| C-004 | `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | T-005 后 | PASS |
| C-005 | `pnpm typecheck` | 每任务后 | PASS |
| C-006 | `pnpm exec playwright test e2e/outline.spec.ts` | T-007 后 | PASS |
| C-007 | `pnpm exec playwright test e2e/open-edit-save.spec.ts e2e/view-state.spec.ts e2e/minimap.spec.ts e2e/markdown-syntax.spec.ts e2e/palette-theme.spec.ts` | T-007 后 | PASS |
| C-008 | `pnpm typecheck:bench && pnpm exec vitest run --config vitest.bench.config.ts bench/outline.bench.ts` | T-008 后 | 记录 p50/p95 |
| C-009 | `OUTLINE_PERF=1 pnpm exec playwright test e2e/outline-perf.spec.ts` | T-008 后 | p95 达标 |
| C-010 | `pnpm ci:generated` | T-005/T-009 | PASS |
| C-011 | `pnpm ci:web` | T-009 | PASS |
| C-012 | `pnpm test:e2e` | T-009 | PASS |
| C-013 | `pnpm ci:rust` | T-009 | PASS |

> C-009 默认 skip；只有设置 `OUTLINE_PERF=1` 才运行。实测结果见 `02 §3~§4`；C-010 需在提交后复跑。

---

## 9. 风险与回滚摘要

| RK-ID | 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|---|
| RK-001 | `EditorSession` CRITICAL 回归 | 高 | 只新增方法/字段；监听代际修复单独测试；先跑基线 | 移除 outline 方法与订阅 |
| RK-002 | `createEditorState` HIGH 影响所有消费者 | 高 | 字段/驱动只读文档；限制 200k；全量 editor-core 回归 | 移除基座注入 |
| RK-003 | TOC/锚点行为变化 | 高 | 共享字段逐字段对齐；现有测试全跑；不改进 slug 规则 | 回退 `toc.ts`/`heading-anchors.ts` |
| RK-004 | 初始语法树不完整导致大纲缺标题 | 中 | `treeChanged` 监听 + 空闲解析驱动 + partial 提示 | 提高切片/上限 |
| RK-005 | 大文档输入卡顿 | 中 | 200k units + 字段 5000 条安全上限 + UI 500 条；8ms 切片；节流通知；bench 门禁 | 降低上限或默认关闭 |
| RK-006 | 默认打开破坏现有布局/E2E | 高 | 默认隐藏；打开后才让位；900px 以下隐藏 | 默认隐藏/移除面板 |
| RK-007 | StrictMode 重复 update listener | 高 | 代际 id 守卫 + UT；attach/detach 测试 | 回退守卫 |
| RK-008 | 菜单多处不同步（Rust/TS/names/测试/生成/i18n） | 中 | `MENU_ACTIONS` 长度测试 + 精确契约测试 + 生成绑定 | 移除菜单动作 |
| RK-009 | i18n key 缺失/标签为空 | 中 | `native.test.ts` 全字段校验；zh/en 对照 | 移除文案 |
| RK-010 | 生成绑定过期 | 中 | `pnpm ci:generated` | 重新生成 |
| RK-011 | 可访问性不足 | 中 | 语义化 nav/list/button + aria-current + 键盘测试 | 修 UI |
| RK-012 | 产品范围蔓延到文件树 | 中 | Q-001 明确拆分为独立方案 | 关闭 T-010 |

**首选回滚**：将 `EditorPage` 的 `<OutlinePanel>` 条件渲染移除、撤销 `view.toggleOutline` 命令与菜单动作；`headingOutline` 字段可保留（只读、无 UI），也可一并移除注入。无数据迁移、无配置清理。

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [`04-设计方案.md`](04-设计方案.md) | 架构、算法、状态机、边界、验证、回滚 |
| [`01-实施计划.md`](01-实施计划.md) | 调研证据、任务队列、文件范围、验证命令 |
| [`02-实施状态与验证.md`](02-实施状态与验证.md) | 执行日志、命令结果、验收覆盖、最终 VERDICT |
| [`03-复盘与交接.md`](03-复盘与交接.md) | 决策、踩坑、回滚、维护与交接 |
| [`05-多轮评审记录.md`](05-多轮评审记录.md) | 多轮评审发现与修复 |
| [`research/01-official-docs-and-oss.md`](research/01-official-docs-and-oss.md) | CM6、Zettlr、VS Code、MarkText、Typora |
| [`research/02-call-chain-and-impact.md`](research/02-call-chain-and-impact.md) | 调用链、拓扑、GitNexus 影响面 |
| [`research/03-papers-and-hci.md`](research/03-papers-and-hci.md) | 论文与人机交互证据 |
| [`research/04-performance-and-test-evidence.md`](research/04-performance-and-test-evidence.md) | 性能模型、测试矩阵、命令 |

---

## 11. 变更日志

| 时间 | 变更 | 作者/Agent | 证据 |
|---|---|---|---|
| 2026-10-30T23:30:00+08:00 | 创建实施方案控制台 | OpenCode / DeepSeek V4.1 | `main@e97d651` |
| 2026-10-30T23:30:00+08:00 | 完成官方文档、开源实现、论文、GitNexus 与三路 subagent 调研 | OpenCode / DeepSeek V4.1 | `research/*.md` |
| 2026-10-30T23:30:00+08:00 | R1~R4 评审；修复循环依赖、5000/500、error、driver、900px、菜单触点 | OpenCode / DeepSeek V4.1 | `05-多轮评审记录.md` |
| 2026-10-30T23:59:00+08:00 | R5 独立评审；修复 driver 分块、面板空态、UT 归属、TOC 占位符、滚动/回焦 | OpenCode / DeepSeek V4.1 | `05-多轮评审记录.md §7` |
| 2026-10-30T23:59:00+08:00 | R6 独立复审；修复 forceParsing 空事务、面板接线、footer/空态、details 200k、验收映射 | OpenCode / DeepSeek V4.1 | `05-多轮评审记录.md §8` |
| 2026-10-30T16:40:00+08:00 | 用户确认 Q-001~Q-007 全部采纳 A；方案冻结，可启动 T-001 | 用户 / OpenCode | 本文档 §12；`01 §12`；`04 §22` |
| 2026-10-30T18:00:00+08:00 | 完成 T-001~T-009；647 UT + 135 E2E；性能/回滚通过 | OpenCode / DeepSeek V4.1 | `02 §3~§9` |

---

## 12. 人工确认结论（已确认）

> 用户已于 2026-10-30 确认 Q-001~Q-007 全部采纳推荐项 A。以下为最终生效决策，不再阻塞 T-001；后续如需变更，必须走变更控制并重新评审。

| ID | 问题 | 选项 | 已确认 | 影响 |
|---|---|---|---|---|
| Q-001 | 本方案是否只做大纲，文件树另立方案？ | A. 只做大纲，文件树另立 `workspace-file-tree`<br>B. 本方案同时包含文件树<br>C. 先只做大纲，文件树排到下一期 | **A** | T-010 保持 skipped；不引入 workspace 模型、文件监听或持久化评审 |
| Q-002 | 大纲默认显示还是隐藏？ | A. 默认隐藏，命令/菜单打开<br>B. 有标题时自动打开<br>C. 始终显示（空文档也占位） | **A** | 不影响现有 minimap/布局 E2E；命令与菜单提供入口 |
| Q-003 | 开关是否持久化？ | A. 仅会话内内存（每个窗口独立）<br>B. `localStorage` 新 key（需批准）<br>C. 按文档路径持久化（需 DB/存储评审） | **A** | 不新增配置或数据表；新窗口默认关闭 |
| Q-004 | 活动项跟随光标还是视口？ | A. 光标行（v1，简单可测）<br>B. 视口顶部（Typora 式，需 scroll 监听/rAF）<br>C. 两者结合 | **A** | 无 scroll/rAF 逻辑；与 Typora 的视口高亮不同，作为已知限制 |
| Q-005 | 大文档扫描上限？ | A. 200k units；字段安全上限 5000 条、UI 500 条<br>B. 500k units；字段 10000 条、UI 1000 条<br>C. 不设上限（不推荐） | **A** | >200k 只覆盖前缀；字段保留 5000 条保证锚点；面板最多渲染 500 条 |
| Q-006 | 是否顺带修复标题 slug 冲突？ | A. 不在本期，另立缺陷修复<br>B. 本期修复并加锚点回归 | **A** | 保持现有链接解析语义；slug 冲突留在独立缺陷中 |
| Q-007 | 是否添加默认快捷键？ | A. 不加，仅命令面板/菜单<br>B. 加 `Mod+Shift+O`（需检查冲突）<br>C. 加其他组合 | **A** | 不新增快捷键与冲突测试；仅命令面板和原生菜单 |

**最终生效组合（已确认）：Q-001 A + Q-002 A + Q-003 A + Q-004 A + Q-005 A + Q-006 A + Q-007 A。**
