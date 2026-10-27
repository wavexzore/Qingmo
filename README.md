# 轻墨 Qingmo

> 像纸一样安静，像代码编辑器一样快。

Qingmo 是一个本地优先、源码为真、支持沙箱化插件扩展的 Markdown 编辑器。

- **桌面外壳**：Tauri 2（Rust）
- **界面**：React + Vite + TypeScript + TailwindCSS
- **编辑内核**：CodeMirror 6 + Lezer
- **插件运行时**：Web Worker + sandbox iframe + 能力代理（Capability Broker）
- **数据**：Markdown 文件为唯一事实来源，SQLite 仅做索引

## 文档

- [项目蓝图](docs/BLUEPRINT.md) —— 架构、插件系统、数据模型、性能预算、路线图
- [项目拓扑图](docs/TOPOLOGY.md) —— 系统运行拓扑、信任边界、关键数据流
- [调研与参考](docs/RESEARCH.md) —— 开源项目分析、官方文档结论、论文与工程证据
- [实施级 ADR](docs/adr/README.md) —— P1 边界、单一保存、IPC 契约、路径 token/CloseGuard

## 状态

当前处于 **P1 编辑器 MVP 收尾** 阶段（T-001~T-020 已完成，20/20；P1 功能、性能基线、E2E、CI 工作流与 ADR/交接已形成；最终 `VERDICT: PARTIAL` 仅因远端 CI/平台真机残余）。已建立 pnpm workspace、Vite 7 + React 19 + TypeScript 5、Tauri 2 外壳与质量工具，并完成安全基线、IPC 契约、UI 基础、Rust 文件读取/原子写、IpcPort/PlatformPort、浏览器 fake adapter、「启动即编辑未命名文档 → 原生对话框/另存为 → CM6 EditorState」打开与保存流程、Markdown/语言/Compartment 编辑组合、真实 EditorView/状态栏、SaveCoordinator 自动保存（去抖/单飞/冲突暂停/退避）、保存/关闭闭环（冲突横幅、二次确认、`file.save`、红叉/Cmd+Q 先落盘后退出）、Live Preview（视口装饰、标记级显隐、覆盖 CommonMark + GFM 全量语法：ATX/Setext 标题、强调/删除线/上下标、行内代码、链接/自动链接、图片 Widget、引用、嵌套/有序/任务列表、代码块语言标签、分隔线、表格 HTML block widget、HTML 源码降级；含 IME map、2M/超长行/8ms 预算）、大文件降级（2M UTF-16 单元以上关闭 LP、状态栏“大文档 · 预览关闭”、`view.toggleLivePreview`、10MiB 可编辑）、主题系统（light/dark/system、`qingmo.ui.theme`、根 `data-theme`、主题 Compartment、`view.toggleTheme`）、命令面板/全局快捷键（registry 驱动、`Mod+K`、`Mod+O`/`Mod+S`/`Mod+Shift+L`、过滤/焦点恢复）、可重复性能基准（确定性 10KiB/1MiB/10MiB fixtures、`pnpm bench`、真实 Rust AtomicWriter、Tauri open/save/RSS；10MiB LP 关闭）与浏览器 E2E（Playwright 4 spec/18 条、seeded FakeIpc/FakePlatform、生产 tree-shake；Rust 跨格式 round-trip/冲突集成；macOS 真实拼音“你好”与关闭守卫手动冒烟）。建立了四 job GitHub Actions（Ubuntu Web/E2E、Ubuntu 契约/生成文件/负例、macOS fmt/clippy/test/debug build、Windows compile-only）与本地 `ci:*` 门禁，本机 actionlint、`pnpm ci:local`、Ubuntu 容器与 macOS debug bundle 均通过（远端 runner 尚未首次运行）；并完成 4 个实施级 ADR（`docs/adr/0001~0004`：MVP 边界、单一保存、IPC 契约、路径 token/CloseGuard）、蓝图偏差与 P2 前置交接。下一步：首次 push 后复核 GitHub Actions 四 job、配置 `main` 分支保护，再按 `docs/todo/p0-p1-editor-mvp/03-复盘与交接.md §8` 进入 P2。

**P2 应用自动更新（ADR-0005）：** 已实现 macOS-only 更新链路——官方 `tauri-plugin-updater` 2.14.0 Rust API、Rust `UpdateManager` 单一状态机、9 命令/4 事件/19 错误码契约（第 4 个事件为原生菜单动作）、`UpdatePort` + Tauri/Fake、Controller/Provider、命令面板/横幅/对话框（发布说明纯文本）、安装前 `SaveCoordinator.flush("close")`、`CloseGuard` 同锁安装门闩，以及零网络 Playwright E2E、契约/权限负例与生成类型门禁。本地 universal 发布链路已通过 Developer ID 签名、App 公证、DMG 单独公证/stapling、updater minisign 与 `latest.json` 验签；GitHub Actions 发布通道已按本地优先决策停用（`release` Environment/secrets 已删除）。当前 `VERDICT: PARTIAL` 仅剩 T-014 macOS 真机安装/重启冒烟；详见 `docs/todo/app-auto-update/02-实施状态与验证.md`。
