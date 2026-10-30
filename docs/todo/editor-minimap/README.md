# 编辑器缩略图（Minimap）

> **模板定位：** LLM 持续实施控制台  
> **功能 ID：** `editor-minimap`  
> **对应 SDD Spec：** 无（依据 `docs/roadmap.md` 的编辑器体验增强方向；用户 2026-10-30 明确为 VS Code 式全文 minimap）  
> **对应需求：** R-001 ~ R-006  
> **功能分支：** `main`（当前工作树，未新建分支）  
> **优先级：** P2（编辑器体验增强；不涉及数据安全）  
> **负责人：** Qingmo 维护者  
> **最新代码校准日期：** 2026-10-30  
> **代码基线：** `main@43659b1`  
> **GitNexus 索引：** `43659b1`，`status = ✅ 已是最新`

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "editor-minimap"
feature_name: "编辑器缩略图（Minimap）"
status: "done"                 # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "T-009"
last_completed_task: "T-009"
next_action: "无；功能已完成。提交前先征得用户确认，并用 git add -f docs/todo/editor-minimap 纳入文档"
verification_status: "pass"  # not_run | pass | fail | partial | skipped
research_status: "pass"
call_chain_status: "pass"
code_calibration_status: "pass"
last_verification_command: "pnpm test:e2e -> 118 passed, 1 skipped; C-011 cpu p95=11.20ms"
last_updated: "2026-10-30T22:30:00+08:00"
resume_from:
  - "README.md#0-LLM-STATE每轮实施前必须读取"
  - "01-实施计划.md#6-LLM任务队列"
  - "02-实施状态与验证.md#3-执行日志"
allowed_scope:
  - "packages/editor-core/src/minimap/**"
  - "packages/editor-core/src/css-color.ts"
  - "packages/editor-core/src/live-preview/mermaid-theme.ts"
  - "packages/editor-core/src/index.ts"
  - "apps/desktop/src/features/editor/EditorSession.ts"
  - "apps/desktop/src/features/editor/editor-session.test.ts"
  - "apps/desktop/src/features/editor/editor-binding.test.tsx"
  - "packages/editor-core/src/minimap/*.test.ts、css-color.test.ts"
  - "e2e/minimap.spec.ts"
  - "e2e/minimap-perf.spec.ts"
  - "bench/minimap.bench.ts"
  - "docs/todo/editor-minimap/**"
forbidden_scope:
  - "src-tauri/**"
  - "packages/shared/**"
  - "packages/editor-core/src/createEditor.ts"
  - "apps/desktop/src/features/editor/EditorHost.tsx"
  - "apps/desktop/src/features/editor/session/ViewStateRecorder.ts"
  - "packages/editor-core/src/extensions/basic.ts"
  - "packages/editor-core/src/extensions/theme.ts"
  - "packages/editor-core/src/live-preview/**（除 mermaid-theme.ts 的 tokenReader 抽取）"
  - "apps/desktop/src/styles.css"
  - "packages/ui/src/tokens.css"
  - "apps/desktop/src/features/workspace/WorkspaceLayout.tsx（Q-002=B，不新增命令）"
  - "apps/desktop/src/i18n/locales/**（Q-002=B）"
stop_condition: "所有 required=true 的 T-### 均为 done，最终验证 VERDICT: PASS"
blocker_policy: "遇到 blocked 时记录 B-###、失败证据、已尝试方案和下一恢复动作"
```

> **状态更新规则：** 每完成一个任务，必须同步更新 `current_task`、`last_completed_task`、`next_action`、`verification_status`、`code_calibration_status`、`last_updated`；生成实施方案时已更新 `research_status` 与 `call_chain_status`。

---

## 1. 一句话结论

`editor-minimap` 已 `done`：T-001~T-007、T-009 完成，T-008 因 Q-002=B 保持 `skipped`。实现采用“Canvas 1:1 文本缩略图（固定缩放 + 视口窗口）+ 文档纵轴滑块 + 内容区让位”，零新增持久化配置/DB/Rust。100k 行真实 Chromium 完整 rebuild CPU p95 `11.20ms`（≤16ms）；全量 Vitest `593 passed`，minimap E2E `15 passed`，全量 E2E `118 passed / 1 skipped`（skip 为 C-011 默认关闭）。

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 长文档右侧显示全文 1:1 文本缩略图 | E2E-001：212 行 fixture 可见、Canvas 非空且为文本模式；E2E-002：6 行 fixture 不可见 | pass |
| R-002 | 点击/拖拽/滚轮导航，位置与内容对齐 | E2E-003/004/005：scrollTop 落点、单调拖拽、滚轮 | pass |
| R-003 | 不破坏现有单一真源 | 代码审查 + UT-016 + 现有 view-state E2E；无新增 IPC/持久化 | pass |
| R-004 | 大文档降级与性能预算 | BENCH-001~004；C-011 实测 100k CPU p95 11.20ms；保留 100k 上限 | pass |
| R-005 | 主题/布局/可访问性与现有约定一致 | E2E-006/008/012；Canvas 像素采样；无横向溢出 | pass |
| R-006 | 可测试、可回滚、零持久化配置 | 单测/E2E/bench 覆盖；回滚只需移除一行扩展注入 | pass |

### 2.2 非目标

| 项 | 原因 | 后续处理 |
|---|---|---|
| 图片缩略图/文件树缩略图/文档画廊 | 用户已明确是 VS Code 式全文 minimap | 无 |
| 真实字体轮廓、语法高亮级 minimap | 76px 下不可读；字体/DPR/CJK 成本高 | `NEXT-001`（仅评估） |
| DOM 克隆 Live Preview | 节点爆炸、虚拟化、主题同步复杂 | 无 |
| 搜索命中/诊断/Git/协作标记 | 本期只做文本/结构导航 | `NEXT-002` |
| 左右侧切换、宽度拖拽、透明度/缩放设置 | 需要新配置；Q-005=A 已确认固定 76px | `NEXT-003`（仅评估） |
| 持久化开关/DB/Rust 字段 | Q-001=B / Q-002=B 已确认零配置、零持久化开关 | 无 |
| 替代查找/大纲/键盘滚动 | minimap 是辅助，不是主路径 | 无 |
| 嵌套代码块内 minimap | 独立 `EditorState`，不属于顶层文档 | 无 |

---

## 3. 当前运行时链路 / 目标调用链

### 3.1 调研与调用链证据摘要

| 项 | 状态 | 证据位置 | 结论摘要 |
|---|---|---|---|
| 官方文档调研 | pass | [`research/01-official-docs-and-oss.md`](research/01-official-docs-and-oss.md) | CM6 无内建 minimap；`scrollMargins` 不预留布局；VS Code 默认 Canvas+采样 |
| GitHub 开源实现调研 | pass | 同上 | replit 挂载冲突/整篇解析；Obsidian 锚点映射/滑块稳定可借鉴 |
| 论文/HCI 调研 | pass | [`research/03-papers-and-hci.md`](research/03-papers-and-hci.md) | 结构语义层有价值；overview+detail 有 split-attention 成本 |
| DeepWiki/Exa 外部检索 | pass | [`research/01-official-docs-and-oss.md`](research/01-official-docs-and-oss.md) §1 | 补充仓库文档/网页证据；关键 API 以本地源码二次核对 |
| subagent/GitNexus 调用链分析 | pass | [`research/02-call-chain-and-impact.md`](research/02-call-chain-and-impact.md) | `EditorSession` CRITICAL；唯一注入点 `extraExtensions` |
| 当前代码实时校准 | pass | `02-实施状态与验证.md §8` | HEAD `43659b1`；GitNexus 索引 current；无旧 minimap 实现 |
| 性能证据 | pass | [`research/04-performance-and-test-evidence.md`](research/04-performance-and-test-evidence.md) + `02` §3 | C-011 CPU p50 8.40ms / p95 11.20ms；bench scan p50 8.67ms；见 `02` |

### 3.2 目标调用链

```text
EditorSession.create / createUntitled / restoreDraft
  -> EditorSession 构造函数
  -> this.extraExtensions = [ ...原有项, minimapExtension() ]   ← 唯一新增
  -> createEditorState({ extraExtensions })
  -> EditorHost new EditorView
  -> Minimap ViewPlugin constructor
     -> 判断 eligible（行数/上限/宽度）
     -> scanMinimapDocument(doc)                    纯函数
     -> measureAnchors(lineBlockAt)                 块边界/标题/stride
     -> buildAnchorMap / computeMinimapWindow
     -> Canvas 1:1 text draw（异常降级结构条带）
  -> scroll / pointer / wheel / theme / resize
     -> slider / redraw / scrollDOM.scrollTop
  -> ViewStateRecorder 照常持久化（不变）
```

关键约束：

1. 默认只在 ≥80 行、≤100k 行、≤2M units、编辑器宽度 ≥640px 时显示；短/空/超限文档零布局变化。
2. 任何 Canvas/测量/observer 失败都只能降级为“无 minimap”，不能中断编辑/保存/关闭。
3. 不新增第二套文档、滚动、主题、持久化、命令或配置来源。

---

## 4. 当前实施状态总览

| T-ID | 任务 | Status | DependsOn | Evidence | Next |
|---|---|---|---|---|---|
| T-001 | 失败用例与契约 | done | none | 24 tests + E2E 15 | — |
| T-002 | `css-color.ts` 抽取 | done | T-001 | C-002 43 tests | — |
| T-003 | 纯函数模型与锚点映射 | done | T-002 | C-001 + bench | — |
| T-004 | 主题、Canvas、ViewPlugin | done | T-003 | C-001/C-004 | — |
| T-005 | `EditorSession` 集成 | done | T-004 | C-003 105 tests | — |
| T-006 | E2E 交互/布局/主题/降级 | done | T-005 | C-006 15 + C-007 46 | — |
| T-007 | 性能与可访问性校准 | done | T-006 | C-008 + C-011 p95 11.20ms | — |
| T-008 | 会话内切换命令（Q-002=B，不实施） | skipped | —（Q-002=B 不启动） | none | Q-002=B 已确认，保持 `skipped`；仅未来产品重新评审 Q-002 并改 A 时恢复 |
| T-009 | 全量验证与收尾 | done | T-007（T-008 skipped） | C-009/C-010；VERDICT PASS | — |

状态值只允许：`todo`、`in_progress`、`blocked`、`done`、`skipped`。

---

## 5. 交付物清单

| 类型 | 路径/对象 | 预期变更 | 状态 | 证据 |
|---|---|---|---|---|
| Code | `packages/editor-core/src/css-color.ts` | 新增共享 token reader | done | 实现/测试已落地 |
| Code | `packages/editor-core/src/live-preview/mermaid-theme.ts` | 改为复用共享 reader | done | 实现/测试已落地 |
| Code | `packages/editor-core/src/minimap/model.ts` | 新增纯函数模型 | done | 实现/测试已落地 |
| Code | `packages/editor-core/src/minimap/theme.ts` | 新增 palette 解析 | done | 实现/测试已落地 |
| Code | `packages/editor-core/src/minimap/minimap.ts` | 新增 ViewPlugin/Canvas/交互 | done | 实现/测试已落地 |
| Code | `packages/editor-core/src/index.ts` | 导出 `minimapExtension` | done | 实现/测试已落地 |
| Code | `apps/desktop/src/features/editor/EditorSession.ts` | `extraExtensions` 追加 | done | 实现/测试已落地 |
| Test | `packages/editor-core/src/minimap/*.test.ts` | 新增单测 | done | 实现/测试已落地 |
| Test | `packages/editor-core/src/css-color.test.ts` | 新增抽取回归 | done | 实现/测试已落地 |
| Test | `apps/desktop/src/features/editor/editor-session.test.ts` | 补 UT-016（session 生命周期） | done | 实现/测试已落地 |
| Test | `apps/desktop/src/features/editor/editor-binding.test.tsx` | 补 UT-016b（StrictMode） | done | 实现/测试已落地 |
| Test | `e2e/minimap.spec.ts` | 新增 E2E | done | 实现/测试已落地 |
| Test | `e2e/minimap-perf.spec.ts` | 新增 100k rebuild 采样（C-011） | done | 实现/测试已落地 |
| Bench | `bench/minimap.bench.ts` | 新增性能记录 | done | 实现/测试已落地 |
| Config | 无 | 不新增持久化配置 | — | 无 |
| DB | 无 | 不新增表/迁移 | — | 无 |
| Rust | 无 | 不改 `src-tauri/**` | — | 无 |
| Doc | `docs/todo/editor-minimap/**` | 方案/计划/验证/复盘/评审 | done | 本目录；`docs/` 被 gitignore，入库需 `git add -f` |

---

## 6. 数据模型 / 配置 / 接口

### 6.1 数据模型

无持久化数据模型。运行时只有短生命周期结构：

```ts
interface MinimapLineTable {
  count: number;
  kind: Uint8Array;          // MinimapLineKind 数值编码
  headingLevel: Uint8Array;  // 1-6，0 表示非标题
  indent: Uint8Array;
  density: Uint16Array;      // ASCII + 1.6 * 非 ASCII，capped
}

interface MinimapBlock {
  kind: "fence" | "table" | "frontmatter" | "math" | "media" | "html";
  fromLine: number;
  toLine: number;
  info: string;
}

interface AnchorSample {
  line: number;
  docY: number;          // 0 = 首行顶部，不含 padding
}

// 运行时还有：lineDocY: Float64Array(doc.lines)
// 以及 Canvas/滑块共用的 docYToRail / railToDocY
```

### 6.2 配置项

| 配置项 | 环境变量 | 默认值 | 行为 | 兼容性 |
|---|---|---|---|---|
| 无 | 无 | — | 不新增 `UiStore`/`localStorage`/Rust/SQLite 配置 | 默认行为不变 |

内部工程常量（不是用户配置）：

| 常量 | 值 | 说明 |
|---|---:|---|
| `RAIL_WIDTH` | 76px | 固定 rail 宽度 |
| `RAIL_GAP` | 12px | 与滚动条间距 |
| `MIN_EDITOR_WIDTH` | 640px | 低于此宽度隐藏 |
| `MIN_LINES` | 80 | 低于此长度隐藏 |
| `MAX_LINES` | 100,000 | 高于此长度隐藏 |
| `MAX_UNITS` | 2,000,000 | 复用 `PREVIEW_PARTIAL_MAX_UNITS` |
| `ANCHOR_STRIDE` | 40 | 固定间隔锚点下限；实际 stride = max(40, ceil(lines/1200)) |
| `ANCHOR_TARGET` | 1,200 | 目标锚点数 |
| `ANCHOR_MAX` | 2,000 | 锚点硬上限 |
| `REBUILD_DEBOUNCE` | 120ms | 文档变化重建延迟 |
| `TRACK_PADDING_Y` | 6px | 轨道上下留白 |
| `ANCHOR_REFRESH` | 250ms | 滚动停止后重测锚点 |
| `INDENT_PX` | 2px/级 | 缩进换算 |
| `WHEEL_STEP` | 1 | 滚轮倍率 |
| `EPS` | 0.5px | 锚点去重/插值容差 |
| `MEASURE_KEY` | `Symbol("qm-minimap")` | requestMeasure 去重 key |
| `SLIDER_MIN_PX` | 24px | 滑块最小高度 |
| `MINIMAP_LINE_HEIGHT` | 3px | 1:1 文本缩略图行高；由编辑器行高 /8 估算 |
| `MINIMAP_CHAR_WIDTH` | 1px | 1:1 文本缩略图字符宽；由编辑器字符宽 /8 估算 |
| `MINIMAP_SCALE_DIVISOR` | 8 | 文本缩略图缩放分母 |
| `LINE_HYSTERESIS` | 8 行 | 显示/隐藏滞回 |
| `WIDTH_HYSTERESIS` | 16px | 宽度滞回 |

### 6.3 API / 对外接口

| 接口 | 变更 | 兼容性 | 验证 |
|---|---|---|---|
| `minimapExtension(options?: MinimapOptions): Extension` | 新增导出 | 非破坏性 | `pnpm typecheck` |
| `createTokenReader(root?)` | 包内模块导出（不进入 public index） | 非破坏性 | `css-color.test.ts` |
| `MinimapOptions` | 内部类型 | 不承诺公共 API | 单测 |
| IPC/Rust/DB | 无变更 | 完全兼容 | 审查 `git diff` |

---

## 7. 验收标准

| AC-ID | 验收项 | 覆盖任务 | 验证命令/证据 | Status |
|---|---|---|---|---|
| AC-001 | 长文档显示、短文档/超限隐藏 | T-004/T-006 | E2E-001/002/011 | pass |
| AC-002 | Canvas 有 1:1 文本缩略图、主题变色 | T-004/T-006 | E2E-001/006/013/015 + 像素采样 | pass |
| AC-003 | 点击落点正确 | T-003/T-006 | E2E-003/014 | pass |
| AC-004 | 拖拽/滚轮可用 | T-004/T-006 | E2E-004/005 | pass |
| AC-005 | 主题/模式切换不重建 view、不丢 undo | T-004/T-006 | E2E-006/007 + palette-theme/large-file | pass |
| AC-006 | 布局不破坏、无横向溢出 | T-004/T-006 | E2E-008 + 现有 margins | pass |
| AC-007 | 无重复持久化/无第二套滚动 | T-005/T-006 | 代码审查 + view-state E2E | pass |
| AC-008 | 生命周期干净（1 个 rail） | T-005/T-006 | UT-016/UT-016b/E2E-010 | pass |
| AC-009 | 性能预算（记录并满足所选上限） | T-003/T-007 | C-008 + C-011 | pass |
| AC-010 | 可访问性 | T-004/T-007 | E2E-012 | pass |
| AC-011 | 零配置/DB/Rust | T-009 | `git diff --stat` + 审查 | pass |
| AC-012 | 回滚可执行 | T-009 | 移除扩展注入后回归 | pass |

---

## 8. 验证入口

```bash
# T-001：先记录红色
pnpm vitest run packages/editor-core/src/minimap
pnpm exec playwright test e2e/minimap.spec.ts

# T-002
pnpm vitest run packages/editor-core/src/live-preview/mermaid-theme.test.ts packages/editor-core/src/css-color.test.ts

# T-003/T-004
pnpm vitest run packages/editor-core/src/minimap packages/editor-core/src/css-color.test.ts
pnpm typecheck

# T-005
pnpm vitest run apps/desktop/src/features/editor

# T-006
pnpm exec playwright test e2e/minimap.spec.ts e2e/open-edit-save.spec.ts e2e/view-state.spec.ts e2e/markdown-syntax.spec.ts

# T-007
pnpm typecheck:bench
pnpm exec vitest run --config vitest.bench.config.ts bench/minimap.bench.ts
MINIMAP_PERF=1 pnpm exec playwright test e2e/minimap-perf.spec.ts

# T-009
pnpm ci:web
pnpm test:e2e
```

| C-ID | Command | 何时运行 | 预期 |
|---|---|---|---|
| C-001 | `pnpm vitest run packages/editor-core/src/minimap packages/editor-core/src/css-color.test.ts` | T-003/T-004 后 | PASS |
| C-002 | `pnpm vitest run packages/editor-core/src/live-preview/mermaid-theme.test.ts packages/editor-core/src/css-color.test.ts` | T-002 后 | PASS |
| C-003 | `pnpm vitest run apps/desktop/src/features/editor` | T-005 后 | PASS |
| C-004 | `pnpm typecheck` | 每任务后 | PASS |
| C-005 | `pnpm lint` | T-009 | PASS |
| C-006 | `pnpm exec playwright test e2e/minimap.spec.ts` | T-006 | PASS（15 tests） |
| C-007 | `pnpm exec playwright test e2e/open-edit-save.spec.ts e2e/view-state.spec.ts e2e/markdown-syntax.spec.ts e2e/palette-theme.spec.ts` | T-006 | PASS |
| C-008 | `pnpm typecheck:bench && pnpm exec vitest run --config vitest.bench.config.ts bench/minimap.bench.ts` | T-007 | 纯函数 p50/p95 |
| C-009 | `pnpm ci:web` | T-009 | PASS |
| C-010 | `pnpm test:e2e` | T-009 | PASS |
| C-011 | `MINIMAP_PERF=1 pnpm exec playwright test e2e/minimap-perf.spec.ts` | T-007 | 真实 Chromium 100k rebuild CPU p50/p95；T-009 PASS 条件 |

> 2026-10-30 全部命令已运行：C-001 24、C-002 43、C-003 105、C-006 15、C-007 46、C-011 1（CPU p95 11.20ms）；C-009/C-010 见 `02` §3。C-011 默认 skip，只有设置 `MINIMAP_PERF=1` 才执行。

---

## 9. 风险与回滚摘要

| RK-ID | 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|---|
| RK-001 | `EditorSession` CRITICAL 回归 | 高 | 只追加扩展；先跑基线；集成测试 | 移除扩展注入 |
| RK-002 | 布局/padding 回归 | 高 | 只有可见时写 inline padding；E2E margins/溢出 | 关闭 rail |
| RK-003 | 锚点估算误差/滑块抖动 | 中 | 块边界/媒体边界锚点 + 视口刷新；T-007 观察 | 降低 `MAX_LINES`/隐藏 |
| RK-004 | 100k 行超预算 | 中 | stride/锚点上限/debounce/隐藏 | 降低 `MAX_LINES` |
| RK-005 | 主题色不更新 | 中 | `data-theme` observer + 共享 reader | 隐藏 Canvas 颜色 |
| RK-006 | StrictMode/重载双 rail | 高 | destroy 清理；UT-016b + E2E-010（仅重载） | 回滚 |
| RK-007 | 嵌套代码块误挂 | 中 | 只注入 `EditorSession`；测试 | 回滚 |
| RK-008 | 第二套滚动/持久化 | 高 | 只读 scrollDOM；审查 | 回滚 |
| RK-009 | Canvas 不可用 | 低 | Unsupported 降级 | 隐藏 |
| RK-010 | 命令/i18n 范围蔓延 | 低 | Q-002=B 已确认，T-008 关闭；不新增命令 | 移除 |
| RK-011 | 滚动条遮挡/横向溢出 | 中 | rail right:0 + scroller 缩窄 88px | 调整 reserve |
| RK-012 | 产品干扰 | 中 | Q-001=B 已确认仅长文档显示；无关闭命令（Q-002=B） | 提高阈值/移除 |

**首选回滚**：移除 `EditorSession.ts` 中 `minimapExtension()` 这一行，跑全量回归。无数据迁移、无配置清理。

> 2026-10-30 实施后复核：RK-001~RK-012 均关闭；RK-004 以 C-011 CPU p95 11.20ms 关闭；回滚演练（移除注入 → C-007 45 passed → 恢复）通过。详见 `02` §3/§7。

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [`04-设计方案.md`](04-设计方案.md) | 架构、算法、状态机、边界、验证、回滚 |
| [`01-实施计划.md`](01-实施计划.md) | 调研证据、任务队列、文件范围、验证命令 |
| [`02-实施状态与验证.md`](02-实施状态与验证.md) | 执行日志、命令结果、验收覆盖、最终 VERDICT |
| [`03-复盘与交接.md`](03-复盘与交接.md) | 决策、踩坑、回滚、维护与交接 |
| [`05-多轮评审记录.md`](05-多轮评审记录.md) | 多轮评审发现与修复 |
| [`research/01-official-docs-and-oss.md`](research/01-official-docs-and-oss.md) | 官方文档、VS Code、CM6、开源实现 |
| [`research/02-call-chain-and-impact.md`](research/02-call-chain-and-impact.md) | 调用链、拓扑、GitNexus 影响面 |
| [`research/03-papers-and-hci.md`](research/03-papers-and-hci.md) | 论文与人机交互证据 |
| [`research/04-performance-and-test-evidence.md`](research/04-performance-and-test-evidence.md) | 性能测量、测试矩阵、命令 |

---

## 11. 变更日志

| 时间 | 变更 | 作者/Agent | 证据 |
|---|---|---|---|
| 2026-10-30T12:00:00+08:00 | 创建实施方案控制台 | OpenCode / DeepSeek V4.1 | `main@43659b1` |
| 2026-10-30T18:00:00+08:00 | R1~R4 评审/冻结；文档一致性收口 | OpenCode / DeepSeek V4.1 | `05-多轮评审记录.md` |
| 2026-10-30T20:00:00+08:00 | 用户全部采纳 Q-001~Q-007 推荐；冻结最终组合，T-008 保持 skipped | 用户确认 / OpenCode | 本文 §12；`01-实施计划.md §12/§14` |

---

## 12. 人工确认（已确认）

> 用户已于 **2026-10-30** 明确“全部采纳建议”，Q-001~Q-007 均按“推荐”列生效。下表保留问题、选项与影响，供追溯；`决策` 列是最终生效值。实施时不得自行改回未采纳选项。

| ID | 问题 | 选项 | 推荐 | 决策（2026-10-30） | 影响 |
|---|---|---|---|---|---|
| Q-001 | 默认显示策略 | A. 所有文档常显（含短文档，空白 rail）<br>B. ≥80 行自动显示，短/空/超限隐藏<br>C. 默认关闭，需命令开启 | **B** | **已采纳 B** | 影响 T-004/T-006；B 不改现有短文档布局 |
| Q-002 | 是否新增会话内 `view.toggleMinimap` 命令（不持久化、无默认快捷键） | A. 新增<br>B. 不新增 | **B** | **已采纳 B** | T-008 保持 `skipped`；不新增命令/i18n；均不新增配置/DB |
| Q-003 | 大文档上限 | A. 100k 行 / 2M units，超限隐藏<br>B. 50k 行 / 1M units<br>C. 不设上限 | **A** | **已采纳 A** | 影响性能与降级；C 不推荐 |
| Q-004 | 可访问性深度 | A. 装饰层 `aria-hidden`，原生滚动条/键盘仍是主路径<br>B. `role="scrollbar"` + tabindex + 方向键/Home/End | **A** | **已采纳 A** | v1 不做 minimap 键盘焦点；B 留作 `NEXT-007` |
| Q-005 | 宽度策略 | A. 固定 76px，<640px 隐藏<br>B. 允许用户拖拽/设置宽度（新增配置） | **A** | **已采纳 A** | 固定 76px，不新增宽度配置；可调宽度留 `NEXT-003` |
| Q-006 | 显示模式 | A. Source 与 Live Preview 都显示<br>B. 仅 Live Preview<br>C. 仅 Source | **A** | **已采纳 A** | 两种模式共用同一 ViewPlugin；不做模式判断 |
| Q-007 | 是否做悬停标题/大纲提示 | A. 本期不做<br>B. hover 显示标题文本（需定位/i18n/可访问性） | **A** | **已采纳 A** | 本期无 hover tooltip；留待大纲功能评估 |

**最终生效组合（已冻结）：Q-001 B + Q-002 B + Q-003 A + Q-004 A + Q-005 A + Q-006 A + Q-007 A。**

约束复核：

- 不新增持久化配置、DB 表/迁移、Rust/IPC 字段；不新增命令与 i18n 文案。
- 固定 76px rail，`<640px` 隐藏；不提供拖拽/设置宽度。
- 仅 ≥80 行、≤100k 行、≤2M units、`docHeight > clientHeight` 时显示；8 行/16px 滞回。
- 可访问性为装饰层 `aria-hidden="true"`，原生滚动条与键盘滚动是主路径。
- 若未来要改上述任一决策，必须新增评审记录并同步更新 README/01/02/03/04，不得在实现中静默偏离。
