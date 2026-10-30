# 调用链、拓扑与影响面证据

> 功能：编辑器大纲面板（Outline）  
> 代码基线：`main@e97d651`（2026-10-30）  
> GitNexus 索引：`e97d651`，391 个文件，`status = ✅ 已是最新`  
> 分析方式：GitNexus CLI `impact/query/context` + 3 个只读 subagent + 源码逐行核对  
> 结论用途：证明接入点唯一、影响面可控、没有第二套文档/标题/持久化逻辑。

---

## 0. 结论先行

1. **唯一顶层 state 工厂**是 `createEditorState`：`packages/editor-core/src/createEditor.ts:89-124`。`headingOutline` 必须在这里注入，才能同时覆盖 Source/Live Preview。
2. **唯一顶层 session 汇合点**是 `EditorSession` 构造函数：`apps/desktop/src/features/editor/EditorSession.ts:187-234`。`create/createUntitled/createDocumentSession/restoreDraft` 都经过它；`replacePayload` 复用同一个 `extraExtensions`。
3. **唯一顶层 view** 由 `EditorHost` 创建：`EditorHost.tsx:39-61`；嵌套代码块使用独立 `EditorState.create`（`code-blocks.ts:665-728`），不会自动获得大纲字段。
4. **`EditorSession` 风险 CRITICAL**：77 impacted / 37 direct / 22 processes / 8 modules。对它的修改必须只新增方法/字段，并单独测试 StrictMode 代际守卫。
5. **`createEditorState` 风险 HIGH**：6 impacted / 3 direct。字段只读文档，限额 200k，先跑 editor-core 全量。
6. **`headingText` 风险 HIGH**：8 impacted。复用其语义，不修改 ATX/Setext 规则。
7. **`readDetailsBlocks` 风险 CRITICAL**：42 impacted。明确不改签名；`details.ts` 只复用 `details-range.ts` 的标签扫描。
8. **`tocPreview` impact UNKNOWN（0 callers）不可信**：`plugin.ts:225` 与 `corpus.test.ts:85` 以值引用；必须保留并改造，不能删除。
9. 当前没有 outline 侧栏、没有共享标题字段、没有大纲命令/菜单；不存在需要合并的旧实现。

---

## 1. 入口与生命周期链路

### 1.1 顶层文档创建

```text
AppShell / DocumentSessionProvider
  -> startSession(...)                         DocumentSessionContext.tsx:88-121
  -> EditorSession.createUntitled(...)          DocumentSessionContext.tsx:123-131
     或 createDocumentSession(ipc, payload)    session/createDocumentSession.ts:31-52
        -> EditorSession.create(payload, ...)   EditorSession.ts:236-238
  -> new EditorSession(...)                     EditorSession.ts:187-234
     -> this.extraExtensions = [                EditorSession.ts:192-196
          ...(options.extensions ?? []),
          editorOpenExternal.of(...),
          minimapExtension(),
        ]
     -> createEditorState({ extraExtensions })  EditorSession.ts:206-214
        -> EditorState.create({ extensions: [ ...basicExtensions, ...markdownExtensions, ... ] })
                                                createEditor.ts:110-124
  -> EditorHost                              EditorPage.tsx:100-107 -> EditorHost.tsx:39-61
     -> new EditorView({ state, parent })
        -> headingOutline.create(state)         outline.ts（新增）
        -> outlineParseDriver constructor      outline.ts（新增）
```

关键点：

- `EditorSession` 构造函数是唯一把 `extraExtensions` 传给 `createEditorState` 的地方。
- `headingOutline` 放在 `createEditorState` 基座，不依赖 `extraExtensions`；即使某个消费者不传 `extraExtensions`，字段仍存在。
- `outlineParseDriver` 是 ViewPlugin；只有 `EditorHost` 创建 view 后才开始推进解析。

### 1.2 重载与恢复

```text
SaveCoordinator.reload / autoReload
  -> session.replacePayload(payload)            EditorSession.ts:362-422
     -> createEditorState({ extraExtensions })  EditorSession.ts:372-379
     -> view.setState(state)                    EditorSession.ts:397-402
        -> 旧 ViewPlugin.destroy()
        -> 新 headingOutline.create
        -> 新 outlineParseDriver.constructor
     -> attachUpdateListener(view)              EditorSession.ts:399
     -> flushOutlineNotify()                    T-004 新增
```

关键点：

- `replacePayload` 复用 `this.extraExtensions`，大纲字段不会在重载后丢失。
- `view.setState` 会重建 state 和 ViewPlugin；`outlineParseDriver` 重新启动。
- `attachUpdateListener` 当前每次调用都 `appendConfig`；`replacePayload` 在新 state 上追加一个 listener，旧 state 的 listener 随 state 丢弃。StrictMode 的 attach→detach→attach 是同一 state，才会重复；需要代际守卫。

### 1.3 模式/主题/只读重配置

```text
toggleLivePreview()
  -> setModeEffect(...)                         EditorSession.ts:470-497
  -> view.dispatch({ effects })                 （view 不重建）

applyTheme(theme)
  -> setThemeEffect(themeExtension(theme))      EditorSession.ts:505-517

setReadOnlyEffect / setEditorUiCopyEffect
  -> compartment.reconfigure(...)               createEditor.ts:59-86
```

- `headingOutline` 在基座，不在 `livePreview()` compartment；模式切换不会移除字段。
- `toggleLivePreview` 只重配 mode compartment；`tocPreview` 被移除/重新加入，但字段和解析驱动保留。
- 主题/文案重配不影响标题语义；`headingOutline` 不依赖 `editorUiCopy`。

### 1.4 销毁

```text
EditorHost effect cleanup
  -> session.detach(view)                       EditorSession.ts:441-447
  -> view.destroy()                             EditorHost.tsx:57-60
     -> outlineParseDriver.destroy()            outline.ts（新增）
     -> headingOutline 随 state 释放
EditorSession.dispose()
  -> 清 timer/listeners                          EditorSession.ts:610-625
  -> attachmentId += 1                          T-004 新增
  -> view = null
```

顺序原因：先停止 session 通知，再销毁 view；即使销毁过程中 update listener 触发，代际 id 也会 no-op。

---

## 2. 标题数据流（当前 vs 目标）

### 2.1 当前

```text
[文档变化]
  -> tocPreview.update                          toc.ts:260-280
     -> buildToc(state)
        -> scanDocument(state)                  toc.ts:70-116
           -> syntaxTree(state).iterate
           -> headings[] + ranges[]
        -> 只有 ranges.length > 0 才生成 widget
  -> specs.ts 内部链接                          specs.ts:852
     -> readHeadingAnchors(state, blocked)      heading-anchors.ts:164-199
        -> 再 syntaxTree(state) 遍历顶层标题
        -> slug 去重
  -> minimap/model.ts                           minimap/model.ts
     -> 行级扫描（presentation-only，不是标题语义）
```

问题：

- 同一标题在 TOC/锚点各扫一遍；新增侧栏会变成第四套。
- TOC 只在 Live Preview 且有 `[TOC]` 时可见；Source 无结构导航。
- `tocPreview` 的 `headings` 没有被其他消费者复用。

### 2.2 目标

```text
[文档变化 / 语法树推进]
  -> headingOutline.update                      outline.ts（新增）
     -> buildHeadingOutline(state)
        -> syntaxTree(state).topNode 直接子节点
        -> 排除 frontmatter/details/fence
        -> entries[] + status + limitReason
  -> tocPreview.update
     -> scanPlaceholders(state)                 // 只找 [TOC]
     -> readHeadingOutline(state).entries       // 不再扫标题
  -> readHeadingAnchors(state, blocked)
     -> readHeadingOutline(state).entries       // 不再扫标题
  -> EditorSession.handleUpdate
     -> outlineChanged? -> scheduleOutlineNotify (100ms)
  -> OutlinePanel
     -> useSyncExternalStore -> getOutlineSnapshot
```

关键点：

- `headingOutline` 是唯一标题语义；TOC/锚点只做占位符、slug、去重、渲染。
- `minimap` 保持独立；它的行分类不影响大纲。
- `readHeadingAnchors` 的签名不变，`specs.ts` 不需要改。

---

## 3. GitNexus 影响面

### 3.1 命令与结果

| 目标 | impact | direct | processes | modules | risk | 处理 |
|---|---:|---:|---:|---:|---|---|
| `EditorSession` | 77 | 37 | 22 | 8 | **CRITICAL** | 只新增方法/字段；代际守卫单独测试 |
| `createEditorState` | 6 | 3 | — | — | **HIGH** | 基座注入；全量 editor-core |
| `headingText` | 8 | — | — | — | **HIGH** | 复用，不改语义 |
| `readHeadingAnchors` | 2 | — | — | — | LOW | 内部改读字段 |
| `readDetailsBlocks` | 42 | — | — | — | **CRITICAL** | 签名不变；标签扫描复用 `details-range.ts` |
| `tocPreview` | 0 | 0 | — | — | **UNKNOWN** | 值引用，保留改造 |
| `EditorPage` | 3 | — | — | — | LOW | 插入面板 |
| `WorkspaceLayout` | 3 | — | — | — | LOW | 命令/菜单 |

### 3.2 `EditorSession` 的直接调用方（节选）

GitNexus 输出包含：

- `DocumentSessionContext.tsx`：创建/恢复 session。
- `SaveCoordinator.ts`：`autoReload`/`flush`/`getSnapshot`。
- `ViewStateRecorder.ts`：订阅 selection/scroll。
- `DraftJournal.ts`：draft 写入。
- `useEditorStatus.ts`：状态栏订阅。
- `useLivePreviewMenu.ts`：菜单 checked 同步。
- `editor-binding.test.tsx`、`editor-session.test.ts`：生命周期测试。

结论：

- 新增 outline 方法不改变这些调用方的行为。
- 修改 `handleUpdate` 早退分支会影响所有 update 订阅；必须保留原有 dirty/selection/mode 逻辑。
- 修改 `attachUpdateListener` 会影响所有 attach 路径；代际守卫是纯防御，不改变正常单次 attach。

### 3.3 `createEditorState` 的直接调用方

- `EditorSession.ts` 构造函数/`replacePayload`。
- editor-core 测试/`bench`（`createEditorState` 直接调用）。
- `live-preview` 各测试。

结论：

- 字段会在所有 editor-core 测试中创建；小文档成本可忽略。
- 200k 测试需要 bench/显式大文档；字段限额保护。
- 不要在 `createEditorState` 中做任何 DOM 操作；`outlineParseDriver` 只是 ViewPlugin 扩展，state-only 测试不会实例化。

### 3.4 `tocPreview` 的 UNKNOWN

GitNexus：

```json
{
  "target": {"name": "tocPreview", "type": "Const"},
  "impactedCount": 0,
  "risk": "UNKNOWN"
}
```

文本检索：

- `packages/editor-core/src/live-preview/plugin.ts:26`：`import { tocPreview } from "./toc";`
- `plugin.ts:148`：`state.field(tocPreview, false)?.blocked`
- `plugin.ts:225`：`tocPreview` 放入 `livePreview()` 数组
- `packages/editor-core/src/live-preview/corpus.test.ts:85`：`state.field(tocPreview).ranges.length`

结论：`tocPreview` 仍被使用；不能因为 impact 0 就删除。改造必须保留字段名/导出，只改内部标题来源。

---

## 4. 候选目标验证

| 候选目标 | 证据 | 选择/排除 | 理由 | 风险 |
|---|---|---|---|---|
| `createEditorState` | `createEditor.ts:89-124`；HIGH 6 | 选择 | 唯一顶层 state 工厂；Source/LP 都需要 | HIGH |
| `EditorSession.extraExtensions` | `EditorSession.ts:192-196` | 部分选择 | 可放 outline 桥接所需的额外扩展；但字段本身放基座，确保 TOC 在 LP 外也有 | CRITICAL |
| `basicExtensions` | `basic.ts:83-104` | 排除 | 非 Markdown 基线；嵌套/未来嵌入不应自动有大纲 | 中 |
| `livePreview()` | `plugin.ts:216-239` | 排除 | 只在 LP 挂载；Source 会失去字段 | 高 |
| `EditorHost` | `EditorHost.tsx:39-61` | 排除 | 第二个 view 生命周期；StrictMode 风险 | 中 |
| `ViewStateRecorder` | `:145-185` | 排除 | 只负责持久化，不负责 UI | 高 |
| `tocPreview` | `toc.ts:260-280`；UNKNOWN | 改造 | 被值引用；TOC 需要共享字段 | 中 |
| `readHeadingAnchors` | LOW 2 | 改造 | 签名不变，内部读字段 | 低 |
| `readDetailsBlocks` | CRITICAL 42 | 仅重构 | 签名不变；标签扫描改为复用 `details-range.ts` | 高 |
| `details-range.ts` | 新增 | 新增 | 轻量闭合范围，供 outline/details 共用 | 中 |
| `minimap/model.ts` | 行扫描 | 排除 | presentation-only，不是标题语义 | 低 |
| `frontmatter.ts` | 纯读取函数 | 不改 | 复用输出 | 中 |

---

## 5. 数据流、配置流、错误流、测试覆盖

### 5.1 数据流

```text
EditorState.doc
  -> Lezer Markdown tree (incremental)
  -> buildHeadingOutline
     -> entries[{level,text,plainText,from,to,line,lineFrom}]
  -> headingOutline (StateField)
  -> EditorSession.getOutlineSnapshot
  -> OutlinePanel props
  -> DOM list
```

不变量：

- `lineFrom <= from <= to`；`line = doc.lineAt(from).number`。
- `entries` 顺序 = 文档顺序。
- `plainText` 是精确 `plainInlineText`，可以为空；UI 回退 `text`，锚点跳过空值。
- `status=complete` 时语法树必须覆盖 `min(doc.length, 200k)` 且未触发 count。
- `limitReason=size` 仅在 `tree.length >= min(doc.length, 200k)` 后标记；`count` 在 entries 达到 5000 时标记；两者都使 `status=partial`。
- 字段最多 5000 条，面板最多 500 条；第 501 条以后仍可生成锚点。

### 5.2 配置流

- 无用户配置。
- `limits.ts` 常量：`OUTLINE_SCAN_MAX_UNITS`/`OUTLINE_SAFETY_MAX_ENTRIES`/`OUTLINE_PANEL_MAX_ENTRIES`/`OUTLINE_PARSE_CHROMIUM_SLICE_MS`/`OUTLINE_PARSE_CHUNK_UNITS`/`OUTLINE_PARSE_MAX_ATTEMPTS_PER_CHUNK`；通知实际用 `statusThrottleMs`。
- `OutlinePanel` Tailwind：`w-60`/`min-[900px]:flex`。

### 5.3 错误流

| 错误 | 捕获点 | 结果 |
|---|---|---|
| `syntaxTree`/`readDetailsRanges` 抛错 | `headingOutline.update` try/catch | 文档未变保留 last-known-safe；文档已变清空；`status=error`；不崩溃 |
| `forceParsing` 抛错 | `outlineParseDriver.run` try/catch | 停止调度；字段保持当前状态 |
| `revealPosition` 位置越界 | `clamp(0, doc.length)` | 不抛错 |
| 面板渲染异常 | local `OutlineErrorBoundary` | 编辑器仍可用 |

### 5.4 测试覆盖

| 层 | 现有测试 | 新增 |
|---|---|---|
| editor-core 字段 | `toc.test`/`heading-anchors.test`/`corpus.test` | `outline.test.ts` |
| desktop session | `editor-session.test.ts`/`editor-binding.test.tsx` | outline/StrictMode/reveal |
| UI | `ui-shell.test.tsx`/`menu-actions.test.tsx` | `OutlinePanel.test.tsx`/`outlineVisibility.test.ts` |
| Rust | `commands_contract.rs`/`menu_tests` | `MENU_ACTIONS=12`/outline label |
| E2E | `minimap/open-edit-save/view-state/palette-theme` | `outline.spec.ts`/`outline-perf.spec.ts` |
| Bench | `minimap.bench.ts` | `outline.bench.ts` |

---

## 6. 调用链风险结论

1. **不要改 `readDetailsBlocks` 签名**：42 impacted，且它不是本功能的核心；新增 `details-range.ts` 供 outline 使用，`details.ts` 只复用标签扫描。
2. **不要在 `livePreview()` 中放字段**：Source 会失去；TOC 在 LP 外也无法保证字段存在。
3. **不要在 `EditorHost` 里建第二套 state**：会破坏单一文档状态。
4. **不要在 React 里 `readText()`**：会复制正文，违反 snapshot 约束。
5. **不要删除 `tocPreview`**：impact 0 是图索引盲区；值引用仍在。
6. **必须修 `attachUpdateListener` 的代际**：StrictMode 会重复；这是本方案唯一的行为修复，需单独测试。
7. **必须同步菜单多处触点**：Rust/TS/names/精确测试/命令面板/生成绑定/i18n/startup JSON；否则 FakePlatform/E2E 通过、真实 Tauri 失效。

---

## 7. 证据索引

- `packages/editor-core/src/createEditor.ts:89-124`
- `packages/editor-core/src/live-preview/toc.ts:70-152`、`:260-280`
- `packages/editor-core/src/live-preview/heading-anchors.ts:164-199`
- `packages/editor-core/src/live-preview/heading-text.ts:5-39`
- `packages/editor-core/src/live-preview/plugin.ts:26`、`:148`、`:225`
- `packages/editor-core/src/live-preview/corpus.test.ts:85`
- `packages/editor-core/src/live-preview/details.ts:96`
- `packages/editor-core/src/live-preview/code-blocks.ts:665-728`
- `apps/desktop/src/features/editor/EditorSession.ts:160-234`、`:362-422`、`:429-447`、`:610-625`、`:724-780`
- `apps/desktop/src/features/editor/EditorHost.tsx:39-61`
- `apps/desktop/src/features/editor/EditorPage.tsx:100-107`
- `apps/desktop/src/features/workspace/WorkspaceLayout.tsx:164-205`、`:250-267`
- `src-tauri/src/ipc/contract.rs:54-82`
- `src-tauri/src/lib.rs:150-300`
- `src-tauri/src/ipc/dto.rs:275-415`
- `src-tauri/tests/commands_contract.rs:75`
- `apps/desktop/src/lib/ipc/commands.ts:117-145`
- `apps/desktop/src/i18n/native.test.ts`
