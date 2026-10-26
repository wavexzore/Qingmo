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

当前处于 **P1 编辑器 MVP 收尾** 阶段（T-001~T-020 已完成，20/20；P1 功能、性能基线、E2E、CI 工作流与 ADR/交接已形成；最终 `VERDICT: PARTIAL` 仅因远端 CI/平台真机残余）。已建立 pnpm workspace、Vite 7 + React 19 + TypeScript 5、Tauri 2 外壳与质量工具，并完成安全基线、IPC 契约、UI 基础、Rust 文件读取/原子写、IpcPort/PlatformPort、浏览器 fake adapter、「欢迎页 → 原生对话框 → CM6 EditorState」打开流程、Markdown/语言/Compartment 编辑组合、真实 EditorView/状态栏、SaveCoordinator 自动保存（去抖/单飞/冲突暂停/退避）、保存/关闭闭环（冲突横幅、二次确认、`file.save`、红叉/Cmd+Q 先落盘后退出）、Live Preview v1（视口装饰、选区行源码显隐、IME map、2M/超长行/8ms 预算）、大文件降级（2M UTF-16 单元以上关闭 LP、状态栏“大文档 · 预览关闭”、`view.toggleLivePreview`、10MiB 可编辑）、主题系统（light/dark/system、`qingmo.ui.theme`、根 `data-theme`、主题 Compartment、`view.toggleTheme`）、命令面板/全局快捷键（registry 驱动、`Mod+K`、`Mod+O`/`Mod+S`/`Mod+Shift+L`、过滤/焦点恢复）、可重复性能基准（确定性 10KiB/1MiB/10MiB fixtures、`pnpm bench`、真实 Rust AtomicWriter、Tauri open/save/RSS；10MiB LP 关闭）与浏览器 E2E（Playwright 4 spec/13 条、seeded FakeIpc/FakePlatform、生产 tree-shake；Rust 跨格式 round-trip/冲突集成；macOS 真实拼音“你好”与关闭守卫手动冒烟）。建立了四 job GitHub Actions（Ubuntu Web/E2E、Ubuntu 契约/生成文件/负例、macOS fmt/clippy/test/debug build、Windows compile-only）与本地 `ci:*` 门禁，本机 actionlint、`pnpm ci:local`、Ubuntu 容器与 macOS debug bundle 均通过（远端 runner 尚未首次运行）；并完成 4 个实施级 ADR（`docs/adr/0001~0004`：MVP 边界、单一保存、IPC 契约、路径 token/CloseGuard）、蓝图偏差与 P2 前置交接。下一步：首次 push 后复核 GitHub Actions 四 job、配置 `main` 分支保护，再按 `docs/todo/p0-p1-editor-mvp/03-复盘与交接.md §8` 进入 P2。
