# ADR-0001：编辑器 MVP 的边界与单一文档真源

- **状态：** 已接受
- **日期：** 2026-10-26
- **决策者：** Qingmo 维护者（P1 实施）
- **关联：** 蓝图 ADR-001/ADR-005；`04 §2/§5`；`01 D-001/D-002/D-013/D-014`

## 背景

蓝图覆盖工作区、SQLite FTS5、搜索、插件、预览 Worker、原生菜单、协作等完整产品面。P1 的目标不是把这些功能做一半，而是先验证最高风险假设：

- CM6 `EditorState` 能否作为唯一文档真源，React 不参与逐键渲染；
- Tauri 2 + Rust 能否安全地完成原生 dialog、编码/EOL 保真、原子写与冲突检测；
- 10MiB 文档能否保持可编辑，Live Preview 能否在视口/选区/IME 下稳定降级；
- 自动保存、关闭守卫、主题与命令面板能否形成可测试的闭环。

## 决策

1. **范围：P0–P1 垂直切片，只做单文件编辑器。** P1 包含打开、编辑、最小 Live Preview、手动/自动保存、冲突检测、主题、命令面板、关闭守卫。
2. **不做：** 工作区/文件树/最近文件、SQLite/搜索、文件 watcher、设置页、插件系统、原生菜单（macOS 自定义 Quit 项除外）、协作、移动端。
3. **唯一文档真源：CM6 `EditorState`。** React 只持有 UI/会话元数据与派生快照；正文不进入 React state、Zustand 或 localStorage。
4. **唯一 EditorView：** 由 `EditorHost` 创建一次；主题/只读/Live Preview 通过 CM6 `Compartment`/facet 切换，不重建 view。
5. **包边界：** P1 只建 `packages/shared`、`packages/editor-core`、`packages/ui`；不建 `plugin-sdk`/`plugin-host`，没有第二消费者就不抽象。
6. **持久化边界：** P1 不建数据库、不写 `settings.json`；唯一新增持久化键是 `localStorage["qingmo.ui.theme"]`。
7. **身份边界：** P1 文档身份是规范路径；`docToken` 只是 IPC 句柄，不是数据库主键。P2 建库前必须重新决定 `documents.id` 与 `path` 的关系（NEXT-010）。

## 后果

**正面：**

- 关键路径短：打开 → 编辑 → 保存 → 冲突/关闭都能端到端验证。
- 没有数据库迁移、没有多配置源、没有插件权限面，回滚成本低。
- CM6 事务/撤销/选区/IME 行为不被 React 渲染干扰。

**代价/限制：**

- 一次只能打开一个文档；打开新文件会使旧 token 失效。
- 没有工作区、搜索、最近文件、watcher、恢复/备份；这些是 P2 的明确入口，不是 P1 的隐藏能力。
- 主题之外的设置没有持久化；P2 统一 settings 时必须迁移 `qingmo.ui.theme`。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 先做完整工作区/SQLite/搜索 | 高风险假设（保存/编码/IME/大文件）尚未验证，过早铺功能会放大返工 |
| ProseMirror/Milkdown 作为主内核 | Markdown 往返有损；双文档模型；大文档压力 |
| React/Zustand 持有正文镜像 | 逐键渲染与双真源；IME/撤销容易分叉 |
| 先建插件 SDK/Host | 无消费者；权限/隔离模型未验证，属于 P3 |

## 证据

- C-093/C-107：10MiB 文档可编辑、LP 关闭、状态栏文案正确。
- C-097/C-099/C-103：主题切换不重建 view，撤销保留。
- C-109：浏览器 E2E 覆盖打开/编辑/保存/冲突/主题/面板/关闭。
- C-112：真实 Tauri 手动验证打开、保存、IME、冲突、关闭守卫。
- C-110：Rust 59 条测试覆盖真实临时文件读写。

## 未决问题（P2 前置）

- 文档身份：UUID / 内容哈希 / 规范路径三选一，需与 FTS5、重命名、链接图一起设计。
- 工作区根与多文档 token 生命周期；窗口/标签页模型。
- settings 单一源与 `qingmo.ui.theme` 迁移。
- watcher/恢复/备份与 `SaveCoordinator` 的接入方式。
