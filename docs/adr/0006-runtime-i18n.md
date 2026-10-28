# ADR-0006：运行时国际化与原生外壳投影

- **状态：** 已接受
- **日期：** 2026-10-28
- **决策者：** Qingmo 维护者（Q-001~Q-008 已确认）
- **关联：** 蓝图 §8.4；`docs/todo/i18n/04-设计方案.md`；`01 T-001~T-018`；`02 E-033~E-049`

## 背景

在本次实现前，仓库已经有两套完整的 `zh-CN` / `en` 资源，但产品层没有“可切换”的运行时：

- i18n 启动后固定为 `zh-CN`，应用没有语言入口；
- `UiStore` 只持久化主题，没有语言键；
- 原生菜单、窗口标题、About 标题、Save As 默认文件名全部硬编码中文；
- `packages/editor-core` 的 Live Preview Widget 直接写中文 title/aria/按钮文案；
- 日志时间、更新日期、文件大小使用系统 locale。

因此，“资源完整”不等于“可交付的双语 UI”。本 ADR 固化运行时语言的所有权、投影边界和回滚方式，避免后续再引入第二套 i18n 或第二份原生文案表。

## 决策

### 1. 语言是 UI 偏好，不是文档属性

1. 语言只存在现有 `UiStore`，持久化键固定为 `qingmo.ui.language`。
2. 不新增 `settings.json`、数据表、迁移、`tauri-plugin-store`、`i18next-browser-languagedetector` 或 `i18nextLng`。
3. 默认 `zh-CN`；非法/缺失/不可读的持久化值回退 `zh-CN`，本次会话仍可切换。
4. 主题与语言共用同一 storage 同步机制；不新增第二套窗口状态。

### 2. 前端是唯一文案源

1. `apps/desktop/src/i18n/locales/{zh-CN,en}.ts` 是唯一产品文案源，namespace 固定为 `common`、`editor`、`errors`、`commands`、`update`、`about`、`logs`、`menu`。
2. 资源随构建打包，不做路由级/插件级懒加载；插件语言包属于后续 P3，当前不实现。
3. `i18next` 只负责前端 React/命令/日志/About 文案与 `Intl` 语言选择；不向 Rust 传资源树。

### 3. 一个运行时协调器

`LocaleController` 是唯一协调器：

1. 订阅 `UiStore`，把语言变更串行投影到 i18next、其他窗口和原生外壳；
2. 用 `pending` 合并快速 A→B→A，用 `generation` 让 `stop()` 后的 await 失效；
3. 写入后重新读取 storage；若其他窗口已写入更新值，则同步并重跑，避免旧快照覆盖新菜单；
4. 主窗口通过 `LocaleHost` 启动；About 窗口使用 `native: null` 的实例，只跟随 i18n 与 storage，不调用原生 locale 命令；
5. `watchUiStorage` 监听 `qingmo.ui.language`/`qingmo.ui.theme` 与 `localStorage.clear()`，main/doc-*/about 三窗口共享同一偏好。

### 4. Rust 只渲染，不持有文案表

1. 前端生成类型化 `NativeShellLabels`（由 Rust `ts-rs` 生成镜像），Rust 只校验字段并重建菜单/标题，不再维护第二份中文/英文字符串。
2. 新增命令 `app_apply_locale`、权限 `allow-app-apply-locale`、错误码 `INVALID_LOCALE`；请求形状为 `{ request: { language, labels } }`。
3. 菜单包含“显示 > 语言”子菜单与命令面板两个入口；两者都写 `UiStore`，不直接调用 Rust。
4. 窗口标题、About 标题、Save As 默认文件名使用同一 `ShellLocale` 状态；启动/文件关联/HTML title 使用中性 `Qingmo` / `Markdown`，避免启动瞬间出现错误语言。
5. `app_apply_locale` 幂等；失败不提交新状态，标题重试失败也不回滚已经生效的菜单语言。

### 5. 编辑器内核只接收 Facet

1. `packages/editor-core` 不 import `i18next`，只接收不可变 `EditorUiCopy`。
2. `EditorUiCopy.version = ${language}:${EDITOR_COPY_SCHEMA_VERSION}`；Widget `eq` 与 Live Preview decoration cache key 都比较 version，保证中英切换必然重绘。
3. `editorUiCopy` Facet + `uiCopyCompartment` 在不重建 EditorState/EditorView 的情况下换文案；IME composing 期间由 `EditorSession` 延后到 `compositionend`。
4. `DEFAULT_EDITOR_UI_COPY` 是 editor-core 独立运行/测试的英文兜底，不是产品文案源；产品始终注入 `buildEditorUiCopy(language)`。
5. Mermaid 内部失败使用 `MermaidRenderError { code, detail? }`，由显式 camelCase 映射到 `copy.mermaid.*`；UI 不显示内部中文错误。

### 6. 默认值与中性文案

1. 产品默认 `zh-CN`，与现有用户习惯一致；`en` 为完整对等语言。
2. 原生应用名固定 `Qingmo`（窗口/HTML/文件关联），菜单内 `appName` 按语言显示“青墨”/“Qingmo”。
3. 未命名文档的 placeholder 与状态栏名称跟随语言；命名空文件不显示 placeholder。
4. 日期/时间/字节统一走 `Intl` 与 `lib/format` 单实现；格式标识（UTF-8/LF）保持规范值，不翻译。

### 7. 测试与门禁

1. 先红后绿；资源 key/插值/复数、20 个错误码、原生 labels、Facet 文案、E2E 切换与持久化都必须有负例或断言。
2. `logs.files`、`logs.toast.cleared` 使用 i18next `_one`/`_other`；zh 只需 `_other`，en 需要 `_one`/`_other`；key 对齐测试先归并复数后缀。
3. `text-scan.test.ts` 扫描 `apps/desktop/src`（排除测试/locales）与 `packages/editor-core/src`（排除测试）无汉字，并扫描无 `i18nextLng`；`APP_NAME`/`APP_NAME_LATIN`/`APP_TAGLINE` 已删除。
4. 原生菜单真机验收与 Windows `cargo check` 属于 T-018；不能用 E2E/Fake 代替。

## 实施状态（2026-10-28）

- **已完成：** T-001~T-018。资源/持久化、`LocaleController`/storage 同步、`NativeShellLabels` + `app_apply_locale`、菜单/标题/About、格式化收口、未命名 placeholder、`EditorUiCopy` Facet、Widget 全量迁移、测试硬化、E2E 语言切换与文档同步均通过。
- **合并：** `0bac056` 合并 `feat/external-change-watch`；外部变更事件与语言投影同时保留，合并后 `pnpm ci:web`/`ci:rust`/`ci:generated`/`ci:negative`/`test:e2e` 全通过。
- **验证证据：** `02 E-033~E-051`、`C-019~C-034`；前端 64 文件/469 测试、E2E 80 条、`pnpm typecheck`/`pnpm lint` 通过。
- **真机冒烟：** macOS debug bundle 验证中文启动、菜单切英文（含勾选）、窗口/About 标题、Quit 经 CloseGuard、重启保持英文、切回中文；未手测 Save As 原生对话框、菜单展开中切语言、大文档/Mermaid 渲染中切语言。
- **残余 PARTIAL：** Windows `cargo check --target x86_64-pc-windows-msvc` 因缺 Windows SDK/ring C 头未通过；GitNexus `detect-changes` 仍报 incomplete/unknown（入口/HTML/测试/再导出文件未映射），未按通过计。
- **偏差：** 原生菜单重建在 mock runtime 受 macOS 主线程限制，无法单测“有效 `app_apply_locale` 后重建菜单”；已由 Rust 单元/契约测试 + macOS 真机覆盖。

## 后果

**正面：**

- 语言切换即时、可持久化、跨窗口一致；没有第二套 i18n 或 Rust 文案表。
- editor-core 可在无 i18n 运行时独立运行；语言切换不重建 EditorState/View，不丢撤销历史。
- 原生菜单/标题与前端共用一份文案源，新增语言只需加一份资源与 labels 投影。
- 硬编码文案、错误码、复数、第二持久化键都有 CI 级扫描/测试。

**代价/限制：**

- 资源随包增大；当前不做按需加载。
- 语言切换需要重建 Live Preview decorations/Widget DOM；大文档切换有一次性成本。
- 原生菜单重建仍依赖平台主线程，真机验收不可省略。
- 插件语言包、RTL 仍未实现，属于后续阶段。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| `tauri-plugin-store` / 新 `settings.json` | 与现有 `UiStore` 重复；Q-001=A 已确认不新增存储 |
| Rust 维护第二份菜单文案表 | 中英漂移、无法复用前端资源；Q-002=A 已确认前端投影 |
| 浏览器语言自动探测 | 行为不可预测、需要新依赖；默认 zh-CN 更符合现有用户 |
| `EditorUiCopy` 只覆盖 aria/title | 可见按钮/空态仍会中英混排；Q-005=A 已确认全量迁移 |
| 切换语言时重建 EditorState/View | 丢撤销历史、破坏 IME；改用 Facet/Compartment |
| 直接把 Mermaid 内部中文 message 显示到 UI | 英文界面泄露中文与技术细节；改用稳定错误码 |

## 证据

- 设计：`docs/todo/i18n/04-设计方案.md` §5.1~§5.12。
- 任务：`docs/todo/i18n/01-实施计划.md` T-001~T-018。
- 证据：`docs/todo/i18n/02-实施状态与验证.md` E-033~E-049、C-019~C-032。
- 契约：`src-tauri/tests/commands_contract.rs`、`packages/shared/src/generated/NativeShellLabels.ts`、`capabilities/default.json`。
- 扫描：`apps/desktop/src/i18n/text-scan.test.ts`；editor-core 汉字扫描命令见 `02 C-030`。

## 残余风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 真机菜单重建未验收 | 语言切换后菜单可能不更新 | T-018 macOS 冒烟；Rust 单测覆盖投影 |
| 大文档切换卡顿 | 一次性重绘成本 | Facet 不重建 View；后续可测量/优化 |
| storage 事件跨平台差异 | 多窗口短暂不同步 | `LocaleController` 重读 storage；E2E 三窗口覆盖 |
| 插件/RTL 未来需求 | 当前资源结构需扩展 | namespace/资源结构已按功能拆分；后续 ADR |
