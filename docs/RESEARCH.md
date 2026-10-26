# Qingmo 调研与参考

- 调研日期：2026-10-26
- 方法：GitHub Search API（star / 活跃度）+ DeepWiki MCP（源码级架构问答）+ Context7（官方文档）+ Exa（论文检索）
- 目的：为 Qingmo 的编辑器内核、插件系统、Tauri 架构与数据模型提供可追溯的设计依据

---

## 1. 开源项目证据

### 1.1 横向对比

| 项目 | Star（2026-10-26） | 架构 | 插件模型 | 对 Qingmo 的价值 |
|---|---:|---|---|---|
| [MarkEdit](https://github.com/MarkEdit-app/MarkEdit) | 5.9k | Swift 原生外壳 + CodeMirror 6（WKWebView） | 构建期扩展（CSS/JS/CM 扩展） | 证明「原生外壳 + Web 编辑内核」可以做到 4MB 安装包、10MB 文件流畅 |
| [Milkdown](https://github.com/Milkdown/milkdown) | 12.0k | TypeScript + ProseMirror + remark | 代码优先插件，`Ctx` 依赖注入 + Slice + Timer | 插件状态隔离、依赖协调、生命周期的最佳参考 |
| [Tiptap](https://github.com/ueberdosis/tiptap) | 38.9k | TypeScript + ProseMirror | Extension 对象 / 类，`ExtensionManager` 统一解析 | commands、storage、schema、keybindings 的贡献点设计 |
| [Yank Note](https://github.com/purocean/yn) | 6.8k | Electron + Vue 3 | 运行时 JS 插件：`{ name, register(ctx) }` | 证明 Markdown 编辑器可以有丰富的用户插件；但其插件与主应用同上下文，权限不受限 |
| [Logseq](https://github.com/logseq/logseq) | 45.4k | ClojureScript + Electron | 运行时插件，默认 iframe sandbox | 插件目录、白名单 API、插件存储隔离、禁用/错误状态、安全警告的完整样本 |
| [SiYuan](https://github.com/siyuan-note/siyuan) | 46.9k | Electron + TS 前端 + Go 内核 | 运行时插件 + 数据授权 | 插件公开数据的显式授权模型、卸载即撤销授权 |
| [NoteGen](https://github.com/codexu/note-gen) | 12.9k | Tauri 2 + Next.js 15 + React 19 | 应用级功能，无通用插件市场 | Tauri 2 目录结构、SQLite/Store/FS 组合、命令注册方式 |
| [MarkFlowy](https://github.com/drl990114/MarkFlowy) | 2.4k | Tauri 2 + Rust + React | 应用级功能 | 轻量 Tauri 桌面应用的组织方式、ProseMirror 使用经验 |
| [Vditor](https://github.com/Vanessa219/vditor) | 11.4k | TypeScript + Lute（Go→WASM） | 构建期扩展 | 浏览器端三模式（WYSIWYG / 即时渲染 / 分屏）的交互参考 |
| [Mark Text](https://github.com/marktext/marktext) | 63.1k | Electron + Vue 2 | 构建期扩展 | Typora 式体验与大规模用户验证；同时是 Electron 资源占用的反面样本 |

### 1.2 DeepWiki 源码级发现

#### MarkEdit（`MarkEdit-app/MarkEdit`）

- 编辑内核为 **CodeMirror 6**，使用 `@codemirror/lang-markdown` 与 `@lezer/markdown`。
- `EditorState` 是唯一事实来源，所有变更通过 transaction 提交；undo/redo 使用 CM6 history 扩展。
- 大文件策略：`getSyntaxTree` 对超过 **100KB** 的文档不做全量语法树遍历，只按需解析。
- 文件外部变更通过 `presentedItemDidChange()` 检测；自动保存发生在编辑器 idle 时；退出前保存未落盘内容，并提供 `last-edited.md` 恢复线索。
- 官方宣称：安装包约 **4MB**，可轻松编辑 **10MB** 文件；对比 TextKit 编辑器在 10MB 文件上的表现更好。
- 启示：**原生外壳 + Web 编辑内核**是性能与颜值兼得的可行路线；关键是「部分解析 + 视口渲染 + 异步 IO」。

#### Milkdown（`Milkdown/milkdown`）

- 插件是接收 `Ctx` 的函数，通过 `editor.use()` 注册。
- `Ctx` 是依赖注入容器；插件通过 `ctx.inject()` / `ctx.get()` 读写 Slice。
- 生命周期由 `Timer` / `Clock` 协调，插件可以 `ctx.waitTimers()` 等待依赖就绪。
- 可注入 schema、ProseMirror 插件、paste rules、事件监听等。
- 插件主要面向**构建期集成**，未提供运行时第三方插件的沙箱加载。
- 启示：**Ctx + Slice + Timer** 适合作为 Qingmo 内部扩展的依赖模型；但用户插件必须换成跨进程序列化协议。

#### Tiptap（`ueberdosis/tiptap`）

- Extension 分为 `Node` / `Mark` / `Extension`，由 `ExtensionManager` 解析与排序。
- 贡献点：commands、schema、keybindings、input rules、paste rules、ProseMirror plugins、storage。
- 每个扩展有独立 `storage`，通过 `editor` 实例访问文档状态。
- 扩展顺序会影响 mark 嵌套的确定性。
- 启示：**贡献点要分类、要可排序、要有独立状态命名空间**；顺序必须在协议层定义，而不是靠导入顺序。

#### Yank Note（`purocean/yn`）

- 插件对象为 `{ name, register(ctx) }`，集中在 `src/renderer/plugins.ts` 注册。
- 可扩展 markdown-it 插件、补全项、编辑器 action、状态栏菜单、生命周期 Hook（`STARTUP`、`VIEW_RENDERED`、`SETTING_BEFORE_WRITE` 等）、设置 schema。
- 插件与主应用运行在同一 JS 上下文，能直接访问应用能力。
- 启示：**贡献点要覆盖 Markdown 渲染、命令、状态栏、设置**；但同上下文模型不能用于不可信插件。

#### Logseq（`logseq/logseq`）

- 插件安装位置：`.logseq/plugins`；支持市场安装、本地 unpacked、URL 加载。
- 默认 `mode: 'iframe'`，把插件放进严格 `sandbox` 的 iframe；另有 `shadow` 模式只做 CSS/DOM 隔离。
- 插件通过 `window.logseq` / `LSPluginUser` 白名单 API 访问宿主；文件读写被限制在插件自己的存储根目录（`write_plugin_storage_file` / `read_plugin_storage_file`，并有 `assert-storage-path!`）。
- 命令、slash command、UI slot（toolbar/pagebar）、设置 schema、事件、编辑器 API 都是受控贡献点。
- 失败处理：`PluginLocalLoadStatus.ERROR`、`set-plugin-disabled!`、独立 logger。
- 官方明确警告：插件可以访问图谱与本地文件、发起网络请求，也可能造成数据损坏，只应安装可信插件。
- 启示：**iframe + 白名单 API + 插件私有存储目录**是用户插件的最低安全基线；但 Logseq 仍承认插件能力过大，Qingmo 应进一步收紧。

#### SiYuan（`siyuan-note/siyuan`）

- 插件公开数据需要用户在「插件发布数据」界面显式授权；新增字段需要重新授权。
- `data/public` 是公开区，`data/storage/petal` 保持私有，`/api/file/readDir` 仅管理员可用。
- 卸载插件会移除授权与快照。
- 启示：**权限要按数据字段/目录粒度授权，且可撤销**；安装插件不等于授权全部数据。

#### NoteGen / MarkFlowy（Tauri 2）

- 标准结构：`src-tauri/`（Cargo、`main.rs`、`capabilities/default.json`）+ 前端目录；`tauri.conf.json` 定义 `beforeDevCommand`、`frontendDist`。
- NoteGen 使用 `tauri-plugin-fs`、`store`、`sql`、`dialog`、`http`、`os`、`single-instance`、`opener`、`clipboard`、`global-shortcut`、`updater`。
- 自定义命令通过 `tauri::generate_handler!` 注册；Rust 侧负责文件、SQLite、模糊搜索、截图、AI 流式调用等重任务。
- DeepWiki 分析显示 NoteGen 的默认能力配置较宽（`fs:scope` 含 `**`、`csp: null`、asset protocol scope `**`）。这适合快速开发，但**不应作为 Qingmo 的安全基线**。
- 启示：Tauri 侧适合承担 IO、索引、搜索、网络代理；前端只做 UI 与编辑。

---

## 2. 官方文档结论

### 2.1 Tauri 2

- **Capabilities** 是权限边界：按窗口/WebView 授予命令与插件权限，配置位于 `src-tauri/capabilities/*.json`。
- `dialog.save()` 会把用户选择的路径加入 fs 与 asset protocol scope；该 scope 默认不持久化，需要 `tauri-plugin-persisted-scope`。
- **Asset protocol** 的 scope 必须最小化；`**` 等于把任意本地文件暴露给 WebView。
- **CSP** 必须显式配置，不能沿用 `null`；`dangerousDisableAssetCspModification` 会削弱 XSS 防护。
- 自定义命令用 `#[tauri::command]` + `invoke_handler`；事件系统适合后端→前端的异步通知。
- Updater 使用签名 manifest；下载进度通过 `Channel` 流式回传。
- 菜单使用 `MenuBuilder`；窗口、托盘、单实例、深链接都有官方插件。

### 2.2 CodeMirror 6

- **视口渲染**：`EditorView.viewport` 只绘制可见区域及边缘，因此大文档不会把全部内容塞进 DOM。
- **Compartment**：把配置片段包起来，之后通过 transaction 的 `reconfigure` 动态替换（主题、只读、模式、插件装饰）。
- **StateField + Decoration**：用 `StateField` 维护装饰集合，随 transaction 映射；通过 `EditorView.decorations` 提供给视图。
- **Transaction**：所有状态更新统一走 `view.dispatch()`；这是实现增量更新、协作、撤销的基础。
- 结论：CM6 天然适合「源码为真 + 视口级 Live Preview」；不要把文档内容复制到 React state。

### 2.3 Milkdown

- 架构为 `Ctx`（依赖注入）+ `Slice`（共享状态）+ `Timer`（依赖协调）。
- React 集成通过 `MilkdownProvider` + `useEditor`；插件可以在 `ctx` 中拿到编辑器实例。
- 结论：如果未来要做真正的 WYSIWYG 模式，Milkdown 是候选；但不应与 CM6 同时作为主编辑器，避免双状态源。

---

## 3. 论文与工程证据

| 主题 | 文献 | 结论 | 对 Qingmo 的影响 |
|---|---|---|---|
| 本地优先 | Kleppmann et al., *Local-first software*, Onward! 2019, DOI [10.1145/3359591.3359737](https://doi.org/10.1145/3359591.3359737) | 本地副本是主副本；离线可用、长期可读、协作是可选增强 | 文件为唯一事实来源；云端同步只做可选层 |
| OT vs CRDT | Sun et al., *Real Differences between OT and CRDT...*, CSCW 2020, DOI [10.1145/3392825](https://doi.org/10.1145/3392825) | 两者都依赖转换；CRDT 并非天然可交换，存在隐藏复杂度 | v1 不做实时协作；数据模型预留操作日志/版本 |
| 协作算法 | Gentle & Kleppmann, *Collaborative Text Editing with Eg-walker*, 2024, DOI [10.17863/cam.112203](https://doi.org/10.17863/cam.112203) | 相比 CRDT 内存低一个数量级，加载快数个数量级；合并长分支远快于 OT | 未来协作文档模型优先评估 Eg-walker / Yjs，而不是自研 OT |
| CRDT 实测 | Ahmed-Nacer et al., *Evaluating CRDTs for real-time document editing*, DocEng 2011, DOI [10.1145/2034691.2034717](https://doi.org/10.1145/2034691.2034717) | 不同 CRDT 在内存、合并、意图保持上差异显著 | 协作层必须做基准测试，不能只看论文宣传 |
| 增量解析 | Wagner & Graham, *Efficient and flexible incremental parsing*, TOPLAS 1998, DOI [10.1145/293677.293678](https://doi.org/10.1145/293677.293678) | 增量解析可在最优时间复用未受影响的语法树 | 采用 Lezer 增量解析；大文件只解析视口/受影响区间 |
| 增量解析工程 | [Tree-sitter 官方文档](https://tree-sitter.github.io/) | GLR + 增量解析，编辑器实时解析的事实标准 | 若未来需要更复杂的 Markdown 方言，可评估 Tree-sitter |
| Wasm 沙箱 | Johnson et al., *WaVe: a verifiably secure WebAssembly sandboxing runtime*, IEEE S&P 2023, DOI [10.1109/SP46215.2023.10179357](https://doi.org/10.1109/SP46215.2023.10179357) | Wasm 内存隔离强，但宿主与 WASI 边界才是安全关键 | 用户插件的最终隔离形态可选 Wasm + 能力式 WASI；v1 先用 Worker/iframe |
| 插件生命周期 | Marquardt, *Patterns for Plug-Ins*, EuroPLoP 1999, [PDF](http://www.kmarquardt.de/papers/EuroPLoP1999.PlugInPatterns.pdf) | 插件类型生命周期与实例生命周期要分开；加载/激活/停用/卸载要可控 | 插件状态机必须显式建模，支持懒激活与禁用 |
| 插件架构 | Birsan, *On Plug-ins and Extensible Architectures*, ACM Queue 2005, DOI [10.1145/1053331.1053345](https://doi.org/10.1145/1053331.1053345) | 扩展点要稳定；插件本身也应可被插件扩展 | 贡献点协议优先稳定，内部实现可演进 |
| 结构化文档可用性 | Flynn, *Why writers don't use XML*, Balisage 2009, DOI [10.4242/BalisageVol3.Flynn01](https://doi.org/10.4242/BalisageVol3.Flynn01) | 作者抗拒结构化标记，界面设计比语法本身更关键 | 默认 Live Preview，源码可随时查看；不强迫用户学语法 |
| 实时预览可用性 | Moss, *Discoverable Computer Interfaces...*, 2011, [PDF](https://plg.uwaterloo.ca/~a3moss/papers/Mos11_Discoverable_Computer_Interfaces_to_Teach_Users_Efficient_Controls.pdf) | 小样本（n=9）实验：实时预览减少手动预览次数、降低格式错误 | 支持内联 Live Preview；但样本小，需自己做可用性测试 |

> HCI 证据整体偏薄：Markdown 编辑器的对照实验很少，且样本量小。Qingmo 应建立自己的可用性测试与性能基准，而不是只引用论文。

---

## 4. 关键结论（直接约束设计）

1. **单一事实来源**：文档只能存在于 CodeMirror `EditorState` 与磁盘文件中，不能复制进 Zustand/React state。
2. **主线程零第三方代码**：用户插件不得在 UI 主线程执行。
3. **声明式装饰优先**：不允许插件在每次按键时跑任意代码；先提供安全的声明式装饰规则。
4. **能力代理**：插件不能直接 `invoke` Tauri；所有文件/网络/剪贴板操作走宿主代理。
5. **默认拒绝**：安装插件不授予权限；首次使用敏感能力时逐项授权，可随时撤销。
6. **懒激活**：插件按 activation event 启动，避免启动时加载全部插件。
7. **可失败**：插件崩溃/超时/内存泄漏必须可隔离、可禁用、可安全模式启动。
8. **原子写 + 恢复**：自动保存必须原子替换，并保留可恢复副本。
9. **大文件降级**：超过阈值自动关闭昂贵装饰/预览，保证可编辑。
10. **先基准后优化**：用 100KB / 1MB / 10MB / 50MB 固定样本做回归。

---

## 5. 待验证问题

- **Module Worker 兼容性**：WKWebView / WebView2 / WebKitGTK 对 `new Worker(url, { type: 'module' })` 的支持差异，需要实机矩阵测试。
- **iframe + 自定义协议 CSP**：`sandbox="allow-scripts"` 的 opaque origin 加载 `plugin://` 资源时的 CSP 细节。
- **中文全文搜索**：SQLite FTS5 默认 tokenizer 对中文分词不友好；需在 `trigram` 与 `jieba-rs` 预分词之间做基准。
- **插件签名与市场治理**：签名密钥托管、审核流程、恶意插件下架机制。
- **Live Preview 复杂度**：装饰系统在 10MB 文档下的性能上限，需要 PoC 验证。

---

## 6. 参考链接

- MarkEdit：<https://github.com/MarkEdit-app/MarkEdit>
- Milkdown：<https://github.com/Milkdown/milkdown>
- Tiptap：<https://github.com/ueberdosis/tiptap>
- Yank Note：<https://github.com/purocean/yn>
- Logseq：<https://github.com/logseq/logseq>
- SiYuan：<https://github.com/siyuan-note/siyuan>
- NoteGen：<https://github.com/codexu/note-gen>
- MarkFlowy：<https://github.com/drl990114/MarkFlowy>
- Vditor：<https://github.com/Vanessa219/vditor>
- Mark Text：<https://github.com/marktext/marktext>
- Tauri 2 文档：<https://tauri.app/>
- CodeMirror 6 文档：<https://codemirror.net/docs/>
- Milkdown 文档：<https://milkdown.dev/docs>
