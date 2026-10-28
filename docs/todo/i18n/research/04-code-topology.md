# 运行时 i18n — 代码拓扑与调用链证据

> **功能 ID：** `i18n`
> **分析基线：** `main@195bfb6` + 工作树 WIP（2026-10-28）
> **分析工具：** GitNexus 1.6.12（`node .gitnexus/run.cjs`）、`rg`、人工逐文件核对
> **分析范围：** 前端启动/状态/菜单/编辑器/格式化、Rust 原生外壳、IPC 契约、测试与生成类型
> **结论用途：** 为 `01-实施计划.md`、`04-设计方案.md` 提供“当前链路—目标链路—影响面”证据；本文件不修改代码

---

## 1. 索引校准

### 1.1 本轮实际执行

```bash
node .gitnexus/run.cjs analyze --index-only
node .gitnexus/run.cjs status
node .gitnexus/run.cjs impact <symbol> --direction upstream --summary-only
```

索引结果：

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 索引提交 | `195bfb6` |
| 分析器 | GitNexus 1.6.12 / Node v26.12.1 |
| 图谱规模 | 5,172 nodes / 14,174 edges / 263 clusters / 423 flows |
| 索引时间 | 2026-10-28 11:10（本地） |
| 工作树 | 含未提交 WIP；本轮开始前 `status` 报告 7 个已修改文件，随后全量重建 |
| 完整性 | 本轮 `status` 输出 `current`，`staleness.status = current` |

> **注意：** 前几轮 MCP 曾返回 `staleness: behind`，那是旧的 MCP 缓存元数据；本轮 CLI `status` 与 `impact` 均返回 `current`。本文所有 `impact` 结果均来自本轮重建后的索引。
>
> **图谱不是全量证明：** 本轮分析器报告 `truncation.truncated = true`：565 个候选入口中 365 个未进入排名、27 条 walk 被预算截断、1,077 个 callee 因分支上限被跳过。`impact` 的 `UNKNOWN` 或空调用者必须用文本搜索/人工调用链补证，不能当作“没有影响”。

### 1.2 图谱盲区（必须先声明）

| 盲区 | 证据 | 影响 | 替代证据 |
|---|---|---|---|
| Tauri `#[tauri::command]` 宏生成的命令入口 | `document_save_as` 的 `impact` 为 `UNKNOWN`，`incoming = 0`；但 `commands/mod.rs:11-31` 明确注册 | 不能因图为空就判定“无人调用” | `commands/mod.rs`、`commands_contract.rs:250-379`、前端 `commands.ts:21-41` |
| `tauri::Builder::menu(build_menu)` 闭包 | `build_menu` 的 `incoming = {}` | 启动菜单调用链在图里断开 | `lib.rs:459-464`、`build_menu_for`、`menu_layout` |
| 字符串 `invoke("...")` 与菜单 action 字符串 | `MENU_ACTIONS` 为 `&[&str]`，前端为字面量联合 | 改名不会产生跨语言引用 | `ipc/contract.rs:45-65`、`commands.ts:89-113`、契约测试 |
| `WidgetType.toDOM(view)` 内的 DOM 文案 | 字符串直接写入 `textContent/title/aria-label` | 图只到 `toDOM`，不到文案 | `packages/editor-core/src/live-preview/*` 逐文件扫描 |
| `document.title` / 原生窗口标题 | 图不表达 OS 窗口标题 | 标题不会出现在调用图 | `document.rs:16-21`、`about.rs:9`、`tauri.conf.json:17` |

---

## 2. 当前拓扑

### 2.1 启动与状态

```text
index.html (lang=zh-CN, title=青墨 Qingmo)
  └─ src/main.tsx
       ├─ import "./i18n"
       │    └─ i18n/index.ts
       │         ├─ resources = { zh-CN: zhCN, en }
       │         ├─ lng = DEFAULT_LANGUAGE = "zh-CN"   ← 固定，不读偏好
       │         ├─ ns = [common, editor, errors, commands, update, about, logs]
       │         └─ initAsync:false, useSuspense:false
       ├─ uiStore.initialize()                        ← 只应用主题 data-theme
       └─ <AppShell>
            └─ AppServicesProvider → UpdateProvider → DocumentSessionProvider
                 └─ RouterProvider → WorkspaceLayout → EditorPage

about.html (lang=zh-CN, title=关于青墨)
  └─ src/about/main.tsx
       ├─ import "../i18n"                            ← 同样固定 zh-CN
       ├─ uiStore.initialize()
       └─ storage 监听：仅 qingmo.ui.theme → uiStore.syncFromStorage()
```

证据：

- `apps/desktop/src/i18n/index.ts:7-27`：`resources`、`DEFAULT_LANGUAGE="zh-CN"`、7 个 namespace、`initAsync:false`。
- `apps/desktop/src/main.tsx:5-10`：先 import i18n，再 `uiStore.initialize()`。
- `apps/desktop/src/about/main.tsx:4-18`：只监听 `THEME_STORAGE_KEY`。
- `apps/desktop/src/stores/uiStore.ts:3-14`：唯一持久化键 `qingmo.ui.theme`；`UiSnapshot` 只有 `theme`/`resolvedTheme`。
- `apps/desktop/src/stores/uiStore.ts:143-150`：`syncFromStorage()` 只重新读取主题。
- `apps/desktop/src/stores/uiStore.ts:228-232`：`uiStore` 单例 + `useUiTheme()`。

### 2.2 主题与命令（语言切换的可复用范式）

```text
UiStore.setTheme(next)
  ├─ persist("qingmo.ui.theme")
  ├─ replaceSnapshot -> applyToRoot(data-theme) -> notify
  └─ useThemeService(session) -> session.applyTheme(resolvedTheme)
       └─ EditorSession.applyTheme -> view.dispatch(setThemeEffect(...))

Menu "主题" / Command "view.toggleTheme"
  ├─ lib.rs menu action theme.light|dark|system
  └─ WorkspaceLayout: uiStore.setTheme(...)
      或 themeCommand: uiStore.toggleTheme()
```

证据：

- `apps/desktop/src/app/useThemeService.ts:12-21`：`useSyncExternalStore` + `session.applyTheme`。
- `apps/desktop/src/features/commands/themeCommand.ts:16-28`：命令只调用 store，不直接改 DOM/编辑器。
- `apps/desktop/src/features/editor/EditorSession.ts:419-431`：`applyTheme` 只重配置 `themeCompartment`，不重建 view。
- `packages/editor-core/src/createEditor.ts:17-19,41-51,58-81`：`themeCompartment` / `setThemeEffect` 是现成的“运行时重配置”范式。

> **可复用结论：** 语言应复用同一模式——store 是唯一持久化点，React 通过订阅重渲染，编辑器通过 Compartment 重配置；不要新建第二套全局状态。

### 2.3 原生菜单

```text
tauri::Builder
  └─ .menu(build_menu)                              lib.rs:464
       └─ build_menu(app)                           lib.rs:320-322
            └─ build_menu_for(app, menu_platform()) lib.rs:324-337
                 └─ menu_layout(platform)           lib.rs:167-265
                      ├─ MenuSpec { title: &'static str, items: Vec<MenuEntry> }
                      ├─ 所有 label 为 &'static str 中文字面量
                      └─ macOS: 青墨/文件/编辑/显示/主题/窗口
                         Windows: 文件/编辑/显示/主题/窗口/帮助

on_menu_event(app, event)                           lib.rs:465-530
  ├─ MENU_ABOUT      -> open_about
  ├─ MENU_QUIT       -> close::request_close(Exit)   ← 自定义 Quit 走 CloseGuard
  ├─ MENU_CLOSE_WINDOW -> close::request_close(Window)
  ├─ MENU_TOGGLE_FULLSCREEN -> toggle_fullscreen
  └─ MENU_ACTIONS.contains(id)
       -> command_window(app) -> window.emit_to(EVENT_MENU_ACTION)
            -> WorkspaceLayout.platform.onMenuAction
```

证据：

- `src-tauri/src/lib.rs:84`：`ABOUT_LABEL = "关于青墨"`。
- `src-tauri/src/lib.rs:106-139`：`MenuSpec`/`MenuEntry` 的 label 类型为 `&'static str`。
- `src-tauri/src/lib.rs:167-265`：全部菜单文案硬编码中文；`ABOUT_LABEL` 同时用于 macOS 应用菜单和 Windows 帮助菜单。
- `src-tauri/src/lib.rs:339-371`：`set_live_preview_checked` 遍历顶层与一级子菜单，更新勾选。
- `src-tauri/src/lib.rs:459-530`：Builder 菜单、事件分发、自定义 Quit/Close。
- `src-tauri/src/lib.rs:570-650`：`RunEvent::ExitRequested` 也走 `request_close(Exit)`，是预定义 Quit 的兜底。
- `src-tauri/src/ipc/contract.rs:45-65`：9 个 `MENU_ACTIONS`，无语言 action。
- `apps/desktop/src/features/workspace/WorkspaceLayout.tsx:149-184`：菜单 action switch；`theme.*` 直接写 `uiStore`。
- `apps/desktop/src/lib/ipc/commands.ts:89-113`：前端镜像 9 个 action。

> **关键约束：** 菜单是 app-wide 的；`on_menu_event` 通过 `command_window` 只发给最后一个可编辑窗口（`lib.rs:397-408`）。语言 action 也应走同一条路，不要广播给所有窗口。

### 2.4 窗口标题与保存默认名

```text
document_open
  -> pick_document
  -> open_path_in_new_window
       -> registry.open_path
       -> window_title_for(path) = "{file_name} — 青墨"   document.rs:16-21
       -> WebviewWindowBuilder.title(title)               document.rs:86-95

document_save_as
  -> dialog.set_file_name("未命名.md")                     document.rs:149-156
  -> registry.save_as
  -> window.set_title(window_title_for(path))              document.rs:179

open_about
  -> WebviewWindowBuilder.title("关于青墨")                about.rs:9,95
```

证据：

- `src-tauri/src/commands/document.rs:16-21`：`window_title_for` 硬编码 `" — 青墨"` 与 `"青墨"`。
- `src-tauri/src/commands/document.rs:149-156`：`set_file_name("未命名.md")`。
- `src-tauri/src/commands/document.rs:179-181`：Save As 后更新标题。
- `src-tauri/src/commands/about.rs:9,95`：About 窗口标题硬编码。
- `src-tauri/tauri.conf.json:17`：主窗口静态标题 `"青墨"`；`:42-46` 文件关联描述 `"Markdown 文档"`。
- `apps/desktop/index.html:2,7`、`about.html:2,6`：HTML `lang`/`title` 也固定中文。

> **首帧问题：** Rust 在窗口创建时就要给标题；此时前端尚未加载，Rust 无法读取 `localStorage`。因此必须决定“启动中性标题 + 前端首帧投影”还是“Rust 第二份语言状态”。本方案选择前者（Q-007）。

### 2.5 编辑器与 Widget 文案

```text
EditorPage
  └─ DocumentSessionProvider
       ├─ main window: EditorSession.createUntitled(
       │    i18n.t("editor:empty.title"),
       │    { placeholder: i18n.t("editor:empty.placeholder") })
       └─ document window: document_take_pending -> EditorSession.create(payload)

EditorSession
  ├─ createEditorState({ doc, readOnly, extraExtensions, placeholder })
  │    └─ modeCompartment.of(livePreview())
  └─ attach(view) -> EditorView
       └─ livePreview plugin
            ├─ ViewPlugin: buildFromSpecs -> createLivePreviewWidget -> WidgetType.toDOM(view)
            └─ StateField: details/toc/frontmatter/media/comment/table/math/mermaid
                 └─ WidgetType.toDOM(view) 直接写中文
```

证据：

- `apps/desktop/src/features/editor/DocumentSessionContext.tsx:75-81`：未命名文档标题/placeholder 在**创建时**取 `i18n.t`，之后不会随语言变化。
- `apps/desktop/src/features/editor/EditorSession.ts:138-163`：`placeholder` 被捕获为构造参数；`createEditorState` 只在构造时使用。
- `apps/desktop/src/features/editor/EditorSession.ts:312-322`：`replacePayload` 重新创建 state 时复用旧 `placeholder`。
- `packages/editor-core/src/createEditor.ts:20-30,58-81`：没有 placeholder Compartment，也没有 UI copy 注入点。
- `packages/editor-core/src/live-preview/plugin.ts:16-40`：`cacheKey` 只含 `doc/tree/viewport/selections`，不含语言。
- `packages/editor-core/src/live-preview/plugin.ts:150-200`：`ViewPlugin.update` 只在 key 变化时重建 decorations。
- `packages/editor-core/src/live-preview/widgets.ts:203-209,328,366,435,488,528,560,600`：`textContent/title/aria-label` 直接写中文。
- `packages/editor-core/src/live-preview/details.ts:52-71,436,445,462,485-486`：`<details>` 的默认摘要、空内容、源码按钮等中文。
- `packages/editor-core/src/live-preview/toc.ts:173-196`：目录标题/空态/title 中文。
- `packages/editor-core/src/live-preview/frontmatter.ts:245-294`：Front Matter 卡片中文。
- `packages/editor-core/src/live-preview/media-blocks.ts:159-282`：媒体类型/源码按钮中文。
- `packages/editor-core/src/live-preview/mermaid-blocks.ts:174-266,387,477`：Mermaid 工具栏/提示/失败态中文。
- `packages/editor-core/src/live-preview/mermaid-theme.ts:52-78`：27 个图表类型标签中文。
- `packages/editor-core/src/live-preview/mermaid-render.ts:76,119,158,195`：4 条内部错误消息中文，且会被 `mermaid-blocks.ts:524-526` 直接显示。
- `packages/editor-core/src/live-preview/comment-blocks.ts:144-163`：注释块中文。
- `packages/editor-core/src/live-preview/table-blocks.ts:154`、`math-blocks.ts:222`、`definition-lists.ts:170`、`html-tables.ts:417`：块级源码按钮/提示中文。

**扫描计数（非测试 `.ts`，2026-10-28 工作树）：**

| 分类 | 行数 | 说明 |
|---|---:|---|
| 含中文总行数 | 92 | `rg -n --pcre2 '[\p{Han}]' packages/editor-core/src --glob '*.ts' --glob '!*.test.ts'` |
| 注释 | 2 | `details.ts:15`（块注释）、`mermaid-blocks.ts:569`（`//`） |
| 解析/数据默认值（会显示） | 5 | `details.ts:52,55,71` 的“详情”；`media-blocks.ts:159,161` 的“外部页面/媒体” |
| 错误卡文案 | 6 | `mermaid-render.ts:76,119,158,195`；`mermaid-blocks.ts:500,507`；经 `createError` 进入 DOM |
| 直接 DOM/可访问文案 | 79 | `textContent`/`title`/`aria-label`/badge；其中 27 行为 `mermaid-theme.ts:52-78` 图表类型标签 |
| **最终可见/可访问合计** | **90** | 5 解析默认 + 6 错误卡 + 79 直接 DOM |

> 旧方案摘要中的“91 处”来自上一版工作树；本轮精确值为 **92 行含中文**，其中 **2 行注释、90 行最终可见/可访问**。若按“92 条 UI 文案”估算会偏大；若只按 79 条直接 DOM 估算会漏掉 5 条解析默认值和 6 条错误卡文案。
>
> 具体文件分布（非测试）：`mermaid-theme.ts` 27、`mermaid-blocks.ts` 12（1 注释/2 错误/9 DOM）、`media-blocks.ts` 12（2 解析默认/10 DOM）、`widgets.ts` 9、`details.ts` 9（1 注释/3 解析默认/5 DOM）、`comment-blocks.ts` 5、`mermaid-render.ts` 4（错误）、`frontmatter.ts` 4、`toc.ts` 3、`specs.ts` 2、`table-blocks.ts` 1、`math-blocks.ts` 1、`inline-render.ts` 1、`html-tables.ts` 1、`definition-lists.ts` 1。

**为什么不能在 `packages/editor-core` 里直接 import i18next：**

1. `editor-core` 是纯 CM6 包，不应依赖 React/i18next/应用单例；否则包边界和可测试性被破坏。
2. 同一页面可能有多个 `EditorView`（多窗口/未来分栏），语言必须是 view/state 的输入，而不是进程级单例。
3. `WidgetType.eq` 需要把“文案版本”纳入比较，才能在同一文档、同一位置用新语言重绘；全局可变单例无法可靠触发重绘。
4. `@qingmo/editor-core` 的现有测试直接构造 state，不启动 i18n；Facet 默认可提供英文/中性文案，测试无需改造成异步初始化。

### 2.6 格式化

```text
StatusBar.formatSize(size)                 StatusBar.tsx:49-61
LogDialog.formatSize(bytes)                LogDialog.tsx:32-40   ← 与 StatusBar 重复
LogDialog.formatTime(timestamp)            LogDialog.tsx:42-50   ← toLocaleTimeString([]) 系统 locale
UpdateDialog.formatDate(value)             UpdateDialog.tsx:19-29 ← toLocaleDateString() 系统 locale
```

证据：`apps/desktop/src/components/StatusBar.tsx:49-61`、`features/logs/LogDialog.tsx:32-50`、`features/update/UpdateDialog.tsx:19-29`。

> 这三处是“语言切换后仍显示系统语言”的直接缺口；必须收口到 `lib/format`，否则即使 UI 文案变英文，日期/时间仍可能是中文格式。

---

## 3. GitNexus 影响面（上游）

> 命令：`node .gitnexus/run.cjs impact <symbol> --direction upstream --summary-only --repo .`
> `risk` 是图计算的风险等级；`UNKNOWN` 必须结合文本证据，不能当低风险。

| 符号 | Risk | Direct | 受影响流程/模块 | 结论 |
|---|---|---:|---|---|
| `EditorSession` | **CRITICAL** | 21 | Editor / Commands / Platform | 只做加法：`applyPlaceholder`、`applyUiCopy`、`applyUntitledTitle`；不改保存/关闭/冲突/IME 路径 |
| `menu_layout` | **HIGH** | 4 | `build_menu`、两个菜单结构测试 | 必须数据化重构；测试同步改为中英双语断言 |
| `createEditorState` | **HIGH** | 3 | 4 个流程 / 2 个模块 | 新增 Compartment/Facet 时必须保持旧调用签名兼容；默认参数不能改变现有行为 |
| `UiStore` | **MEDIUM** | 5 | `useThemeService`、`themeCommand`、`WorkspaceLayout`、About | 扩展快照字段；保持 `subscribe/getSnapshot` 协议不变 |
| `window_title_for` | **LOW** | 2 | `document_save_as`、`open_path_in_new_window` | 改签名传入 app name；测试更新 |
| `document_save_as` | **UNKNOWN** | 0 | 图盲区（Tauri 宏） | 文本证据：`commands/mod.rs:16` 注册、`commands.ts:25` 调用、契约测试覆盖；不能因图为空跳过 |
| `build_menu_for` | **LOW** | 1 | `build_menu` | 增加 labels 参数 |
| `DocumentSessionProvider` | **LOW** | 1 | AppShell / Editor | 只改未命名 session 的创建参数；不碰 payload 流程 |
| `useThemeService` | **LOW** | 1 | WorkspaceLayout | 可复用为 `useLocaleService` 的范式，但不合并职责 |

**高风险处理原则：**

1. `EditorSession` 的修改必须是“新增方法/新增 Compartment effect”，不改 `readText`、`applySaveResult`、`replacePayload` 的保存语义。
2. `createEditorState` 新增可选参数（`uiCopy`、`placeholder` 仍兼容）；`DEFAULT_EDITOR_UI_COPY` 采用英文/中性兜底，T-014 必须把现有断言中文的 Widget 测试改为显式注入中文 copy 或英文断言，不能靠默认值静默改变产品行为。
3. `menu_layout` 重构后，`MenuSpec` 的 label 从 `&'static str` 改为借用 `&str`；所有现有菜单测试改为传入测试 labels，保留结构断言（菜单顺序、快捷键、Quit 走 CloseGuard）。

---

## 4. 数据流、配置流、错误流

### 4.1 当前数据流

```text
localStorage qingmo.ui.theme
  -> UiStore 构造读取
  -> UiSnapshot { theme, resolvedTheme }
  -> useThemeService -> EditorSession.applyTheme
  -> data-theme

i18n resources (bundled)
  -> i18n.init(lng=zh-CN)
  -> useTranslation -> React render

Rust ShellLocale
  -> 不存在；菜单/标题是编译期/调用期常量

EditorUiCopy
  -> 不存在；Widget 直接写死中文
```

### 4.2 目标数据流（详见 `04-设计方案.md`）

```text
localStorage qingmo.ui.language
  -> UiStore 构造/ syncFromStorage
  -> UiSnapshot.language
  -> LocaleController（唯一协调器）
       -> i18n.changeLanguage(language)
       -> document.documentElement.lang
       -> buildNativeShellLabels(language)
       -> IpcPort.appApplyLocale({ language, labels })
            -> Rust ShellLocale（进程内，不落盘）
            -> app.set_menu(build_menu_for(..., labels, language, checked))
            -> 遍历窗口更新标题
  -> React useTranslation 自动重渲染
  -> EditorPage -> session.applyPlaceholder / applyUiCopy
       -> CM6 Compartment/Facet -> Widget 重绘
```

### 4.3 配置流

| 配置 | 当前 | 目标 | 是否新增 |
|---|---|---|---|
| `qingmo.ui.language` | 不存在 | `"zh-CN"`/`"en"`，非法值回退 `zh-CN` | **是，Q-001** |
| `qingmo.ui.theme` | 已有 | 不变 | 否 |
| `tauri.conf.json` 主窗口标题 | `"青墨"` | 中性 `"Qingmo"`，首帧后由 Rust 投影 | 值变更，Q-007 |
| 文件关联描述 | `"Markdown 文档"` | 中性 `"Markdown"` | 值变更，Q-007 |
| `i18nextLng` | 不存在 | **明确不引入** | 否 |
| `settings.json` / `tauri-plugin-store` | 不存在 | **明确不引入** | 否 |
| SQLite 表 | 无 | **不新增** | 否 |

### 4.4 错误流

| 场景 | 当前 | 目标 |
|---|---|---|
| 非法 `qingmo.ui.language` | 不适用（无该键） | `readStoredLanguage` 返回 `zh-CN`；不抛错、不阻塞启动 |
| `localStorage` 被禁用/配额满 | 主题已有 try/catch，UI 继续 | 语言同样 try/catch；内存态可切换，仅不持久化 |
| `app_apply_locale` 收到空/超长/控制字符 label | 不适用 | Rust `NativeShellLabels::validate` -> `INVALID_LOCALE`（带 `field`） |
| `app_apply_locale` 收到非法 language | 不适用 | Tauri 反序列化拒绝（类型化 enum）或命令返回 `INVALID_LOCALE`（若采用 string 入参）；前端永不发送非法值 |
| `set_menu` 失败 | 不适用 | 记录 `tracing::warn!`；失败可能降级为无菜单/部分菜单；不提交 `ShellLocale`；UI 语言仍已切换；下一次 `app_apply_locale` 可重试 |
| 保存默认名非法 | 不适用 | 回退 `"Untitled.md"`；Rust 校验 `.md` 且无路径分隔符 |
| About 窗口 storage 事件丢失 | 当前主题也可能丢失 | 启动读取 storage；事件丢失时重开 About 窗口可恢复；不写第二套状态 |

---

## 5. 测试拓扑与现有基线

### 5.1 现有测试入口

```text
apps/desktop/src/i18n/i18n.test.ts
  ├─ 只遍历 [common, editor, errors, commands, update]  ← 漏 about/logs/menu
  ├─ 硬编码 errors 19 个
  └─ 只做 key 集合相等，不检查插值/复数

src-tauri/tests/commands_contract.rs
  ├─ 断言 COMMANDS.len() == 19
  ├─ 断言 EVENTS == 4
  ├─ 断言 capability 权限 == command_permissions()
  └─ 断言 handler 注册每个命令（字符串 contains）

src-tauri/tests/security_config.rs
  ├─ 断言 default capability 权限精确列表
  └─ 断言无 fs/shell/http/store/sql/dialog/path/menu/tray/image/webview/window/updater 前缀

src-tauri/tests/export_bindings.rs
  └─ 导出 FilePayload/SaveRequest/.../LogStats；新增 DTO 必须加到这里
```

证据：`apps/desktop/src/i18n/i18n.test.ts:15-31`、`src-tauri/tests/commands_contract.rs:39-72,75-107,251-300`、`src-tauri/tests/security_config.rs:18-62`、`src-tauri/tests/export_bindings.rs:6-37`。

### 5.2 当前基线（本轮已跑）

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm test` | 45 文件 / 391 测试通过 | 前端基线 |
| `pnpm typecheck` | 通过 | 工作树 WIP 通过 |
| `cargo test --test commands_contract` | 6 通过 | 19 命令 / 4 事件 |
| `node .gitnexus/run.cjs status` | current（重建后） | 见 §1.1 |

> 这些是**改动前**基线，不是本方案实现后的验收结果。`02-实施状态与验证.md` 中相应命令保持 `NOT_RUN`，直到真正执行。

### 5.3 新命令/权限/错误码对测试的影响

| 变更 | 需要同步的断言 | 证据 |
|---|---|---|
| 新增 `app_apply_locale` | `COMMANDS.len()` 19 -> 20；`commands.ts` 镜像；`commands/mod.rs` handler；`capabilities/default.json` 权限；`security_config.rs` 精确列表 | `commands_contract.rs:55`、`security_config.rs:18-62` |
| 新增 `allow-app-apply-locale` | `capability_permissions` 与 `command_permissions()` 自动对齐；`security_config` 精确列表需加一项 | `commands_contract.rs:75-89` |
| 新增 `INVALID_LOCALE` | `APP_ERROR_CODES` 19 -> 20；`i18n.test.ts` 动态错误码覆盖；中英 `errors` 资源 | `apps/desktop/src/lib/ipc/errors.ts:8-28`、`i18n.test.ts:23-31` |
| 新增 `MENU_LANGUAGE_ZH_CN`/`MENU_LANGUAGE_EN` | `MENU_ACTIONS` 9 -> 11；前端 `MENU_ACTIONS`/`MENU_ACTION_NAMES`；E2E helper 联合类型 | `contract.rs:55-65`、`commands.ts:89-113`、`e2e/helpers.ts` |
| 新增 `menu` namespace | `resources` 8 个 namespace；`i18n.test.ts` 动态遍历；`ns` 动态派生 | `i18n/index.ts:22`、`i18n.test.ts:16` |
| 新增 `NativeShellLabels`/`ApplyLocaleRequest`/`AppLanguage` | `export_bindings.rs` 增加 `export_all`；`check-generated.sh` 无 diff | `export_bindings.rs:6-37` |

---

## 6. 当前拓扑到目标拓扑的差异清单

| 层 | 当前 | 目标 | 复用/新增 |
|---|---|---|---|
| 持久化 | `UiStore` 只有 theme | `UiStore` 增加 language，仍只有两个键 | 复用 `UiStore` |
| i18n 初始化 | 固定 `zh-CN` | 从 `UiStore` 读 language；`ns` 动态 | 改 `i18n/index.ts` |
| DOM lang | HTML 固定 | i18n `languageChanged` 同步 `<html lang>` | 新增小函数 |
| 运行时协调 | 无 | `LocaleController` 串行/幂等 | 新增 |
| 菜单文案 | Rust `&'static str` 中文 | 前端 `NativeShellLabels` 投影 | 重构 `lib.rs` |
| 菜单重建 | 启动一次 | `app.set_menu` 运行时替换 | 新增 IPC |
| 标题 | Rust 中文常量 | Rust 用 `ShellLocale.labels` 格式化 | 改 `document.rs`/`about.rs` |
| Save As 默认名 | `"未命名.md"` | `labels.untitled_file_name` | 改 `document.rs` |
| 编辑器 placeholder | 创建时捕获 | Compartment 重配置 | 改 `createEditor.ts`/`EditorSession` |
| Widget 文案 | 硬编码中文 | `EditorUiCopy` Facet + `eq`/cache key | 新增 `editor-core/src/i18n.ts` |
| 格式化 | 系统 locale + 两份 size | `lib/format` + 所选语言 | 新增/收口 |
| About | 只同步 theme | 同步 theme+language | 复用 `syncFromStorage` |
| 第二文案源 | `APP_NAME`/`APP_NAME_LATIN`/`APP_TAGLINE` | 删除 | 改 `packages/shared` |

---

## 7. 结论

1. 当前仓库不是“没有 i18n”，而是“资源层完成、运行时缺失”；方案必须**接线**而不是重写。
2. 语言偏好的自然归属是现有 `UiStore`；新增 `LocaleController` 只做跨层协调，不持有第二份语言状态。
3. 原生菜单/标题是最大的硬编码面，也是唯一需要新 IPC 的地方；Rust 必须只做投影，不维护第二套完整文案。
4. 编辑器 Widget 是第二个硬编码面；CM6 Facet 是唯一与现有 Compartment/Widget 架构一致且可测试的注入方式。
5. `EditorSession`（CRITICAL）、`menu_layout`（HIGH）、`createEditorState`（HIGH）必须先做加法/数据化重构，不能直接改保存/关闭/IME 路径。
6. `document_save_as` 的 `UNKNOWN` 是图谱盲区，不是低风险；修改前必须用 `commands/mod.rs`、前端调用和契约测试三重确认。
7. 所有计数（92 行中文、19 命令、4 事件、19 错误码、391 测试）都是**当前工作树**事实；实现后必须用测试断言而非文档数字防漂移。
