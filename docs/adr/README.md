# Qingmo 实施级 ADR

本目录记录 Qingmo **P1 实施层**的架构决策，与 [`docs/BLUEPRINT.md`](../BLUEPRINT.md) §3.3 的产品级 ADR 互补：

- 蓝图 ADR 说明“为什么选这个方向”（CM6、文件为源、Worker 隔离等）。
- 本目录说明“P1 实际怎么落地、边界在哪里、哪些蓝图假设被推迟或简化”。

| ADR | 主题 | 状态 | 关联 |
|---|---|---|---|
| [0001](0001-editor-mvp-boundaries.md) | 编辑器 MVP 的边界与单一文档真源 | 已接受 | 蓝图 ADR-001/005；`04 §2/§5` |
| [0002](0002-single-save-path.md) | 单一保存路径与原子写 | 已接受 | 蓝图 §7.3；`04 §5.3/§7` |
| [0003](0003-ipc-contract.md) | IPC 契约与生成类型 | 已接受 | 蓝图 ADR-007；`04 §6/§13` |
| [0004](0004-path-token-close-guard.md) | 路径 token 与 Rust CloseGuard | 已接受 | 蓝图 §9.2/§9.3；`04 §6.5/§7.2` |
| [0005](0005-app-auto-update.md) | macOS 应用自动更新：两套信任根、Rust 状态机与无回滚边界 | 已接受 | 蓝图 §9.3/§9.4/§12；`app-auto-update 04 §5/§6/§13` |
| [0006](0006-runtime-i18n.md) | 运行时国际化：UiStore 单一偏好、前端唯一文案源、Rust 投影与 CM6 Facet | 已接受 | 蓝图 §8.4；`i18n 04 §5`；Q-001~Q-008 |
| [0008](0008-data-durability.md) | 数据持久化、恢复与跨进程锁：历史/回收站/会话/ sidecar 锁 | 已接受 | 蓝图 §7.3/§9.2；`trusted-data-search 04 §5/§7/§8` |
| [0009](0009-local-search.md) | 本地全文检索：SQLite/FTS5 缓存、CJK bigram、rowid 求交、500ms 超时 | 已接受 | 蓝图 §9；`trusted-data-search 04 §6/§9/§10` |
| [0010](0010-document-identity-and-toctou.md) | 文档身份、verified IO 与重命名配对：DocumentId、FileIdentity、16 MiB、trash/虚拟树 | 已接受 | 蓝图 §7.3/§7.4/§9.3；`p0-p1-closure 04 §5/§6/§14` |

维护规则：

1. 先改 ADR，再改实现；ADR 必须列出证据与残余风险。
2. 新增/修改命令、事件、DTO、capability 时同步更新 `0003` 与 `01 §13`。
3. 保存/关闭/路径边界变化时同步更新 `0002`/`0004`。
4. 更新链路、签名信任根、发布门禁变化时同步更新 `0005`。
5. 蓝图与实现不一致时，在本目录或 `03 §7.1` 记录偏差，不得静默偏离。
6. 语言所有权、持久化、原生投影或 `EditorUiCopy` 变化时同步更新 `0006`。
7. 文档身份、FileIdentity、verified IO、rename 配对或 16 MiB 边界变化时同步更新 `0010`。
