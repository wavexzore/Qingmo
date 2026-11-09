# ADR-0008：数据持久化、恢复与跨进程锁

- **状态：** 已接受
- **日期：** 2026-11-08
- **决策者：** Qingmo 维护者（P1 实施）
- **关联：** 蓝图 §7.3/§9.2；`trusted-data-search 04 §5/§7/§8`；`01 D-102/D-104~D-109/D-115`；ADR-0002

## 背景

P1 的 Markdown 文件是唯一真源，但“可信编辑”还需要四类辅助数据：

- 保存前的版本历史，用于误保存后的恢复；
- 应用内回收站，用于误删后的恢复（macOS 的系统回收站没有可用的 list/restore API）；
- 窗口/草稿/视图状态，用于崩溃或重启后回到原处；
- 跨进程 sidecar 锁，用于降低两个 Qingmo 副本同时 read→check→write 的覆盖风险。

这些数据一旦与主数据混在一起，就会产生第二套写入路径、第二套所有权或第二套 watcher，最终出现“UI 显示已保存但磁盘不是最新”的分叉。因此必须先固定它们与 `AtomicWriter`、`DocumentRegistry`、`WorkspaceRegistry` 的关系。

## 决策

### 1. 主数据与派生数据的边界

1. **Markdown 文件是唯一主数据。** 历史、回收站、`session/`、`locks/` 都位于 app data 目录，删除它们不会删除或迁移任何用户文件。
2. **历史与回收站属于“可恢复数据”，不是索引。** 删除 `history/` 或 `trash/` 会永久失去对应恢复能力，因此维护文档必须明确警告；`index/` 才是可随时删除的缓存。
3. **所有会改变 Markdown 字节的操作仍然只经过 `AtomicWriter`。** 历史恢复、回收站恢复也复用该路径与 `TextFormat`，不新增第二条写盘实现。

### 2. 历史（HistoryStore）

1. **捕获点：** `AtomicWriter::write_with_format` 在读取当前磁盘字节之后、提交新字节之前捕获；一次读取同时服务 hash 校验与历史快照，避免二次读盘。
2. **分桶：** 以 canonical path 的 BLAKE3 哈希分目录；`DocToken` 只在进程内有效，不能作为持久键。
3. **保留：** 每文档 50 版、30 天、64 MiB；全局 512 MiB；相邻内容在 10s 合并窗口内去重。
4. **写入是 best-effort：** 历史失败只记录 `warn`，不阻塞保存；磁盘满或权限失败时主保存仍必须成功。
5. **恢复：** 恢复前先把“当前版本”再写入历史；恢复使用历史条目的 `TextFormat` 覆盖 BOM/UTF-16/EOL，随后走 `AtomicWriter`，因此恢复本身也可再次恢复。

### 3. 回收站（TrashStore）

1. **应用自管：** 条目元数据记录原路径、工作区、删除时间、大小与 hash；条目状态区分 `active` 与 `orphaned`。
2. **同卷：** `rename` 到 `trash/`；**跨卷：** copy → fsync → hash 校验 → rename → 删除源文件。源文件在副本校验成功前不删除。
3. **保留：** 200 项、30 天、512 MiB；只自动淘汰 `active`。`orphaned`（恢复目标已不存在/工作区已移除）保留到用户显式 purge，避免“为了满足配额而静默丢数据”。
4. **恢复：** 目标已存在时不覆盖；支持“保留两者”的命名策略；恢复内容仍走 `AtomicWriter` 的格式还原，不直接 `fs::write`。

### 4. 会话、草稿与窗口恢复

1. **`session/windows.json` 只存“打开意图”**（路径、工作区、窗口顺序），不存光标/滚动；后者仍由 `view-state.json` 提供，避免两套视图状态。
2. **上限：** 20 个窗口、`windows.json` 256 KiB、200 条 view、30 天；草稿 2 MiB/篇、20 篇、8 MiB 总量、7 天。
3. **启动优先级：** OS open（Finder/open(1)/Dock）优先于会话恢复；一旦本轮已有 OS open，恢复剩余窗口必须停止，防止“恢复窗口 + 打开窗口”重复。
4. **损坏处理：** JSON 解析失败时保留有限数量的 `.corrupt` 备份（10 份/7 天），然后以空状态继续启动；启动不得因恢复数据损坏而失败。

### 5. 跨进程 sidecar 锁

1. **位置：** `app_local_data_dir/locks/<blake3(canonical_path)[..32]>.lock`，目录 0700、文件 0600。锁不放在用户文档目录，避免只读工作区失败或在文件树中暴露。
2. **语义：** `File::try_lock` + 10ms 轮询 + 2s 超时；超时返回 `BUSY`，消息为“另一个 Qingmo 窗口正在保存此文件”。锁在 `Drop`/进程退出/崩溃时由 OS 释放，不需要 stale 清理。
3. **锁序：** 路径锁 → registry map → `DocState` → HistoryStore/TrashStore mutex；禁止反向获取。`AtomicWriter::write_with_format` 在锁内完成 read→check→encode→commit。
4. **覆盖范围：** 保存、另存为、打开/重载、工作区删除、回收站恢复共用同一路径锁。
5. **边界：** 它是 **advisory** 锁，只协调 Qingmo 实例，不约束其他编辑器；`canonicalize` 与 `open` 之间仍存在残余 TOCTOU（NEXT-006）。`single-instance` 仍是正常第二实例的第一道拦截，锁用于副本/测试 helper 等绕过场景。

### 6. 统一 GC

启动时后台 `spawn_blocking` 依次执行 session → history/trash → index GC。任一类失败只记日志，不影响启动；`locks/` 不参与 GC，避免删除仍被持有的 inode；`windows.json` 不参与 7 天淘汰。

## 后果

**正面：**

- 误保存、误删、崩溃、重启都有明确的恢复路径，且全部复用同一条写入路径。
- 删除任何辅助目录都不会破坏 Markdown；维护者可以安全地重建缓存。
- 跨进程保存由 OS 锁串行化；崩溃不会留下永久锁。
- 配额与淘汰规则可测试、可解释，`orphaned` 不会静默丢失。

**代价/限制：**

- 历史是写放大来源：每次不同内容保存都会多写一份；用 10s 合并、去重和配额控制。
- 回收站跨卷恢复需要复制，10 MiB 文件有可感知延迟。
- 路径哈希意味着外部重命名后旧历史/回收站条目孤立；需要 NEXT-004 的稳定文档 ID。
- `locks/` 会为每个打开过的路径留下 0 字节文件；当前不做自动清理。
- advisory 锁无法阻止其他编辑器并发写入，也不能消除 canonicalize→open 的窗口。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 依赖 macOS 系统回收站 | 无跨平台 list/restore；无法在应用内展示与恢复 |
| 历史写入独立于 `AtomicWriter` | 第二次读盘 + 第二套格式/冲突判断，容易出现历史与磁盘不一致 |
| 把锁文件放在文档旁边 | 只读工作区无法创建；污染用户目录与文件树 |
| 只用 single-instance，不做锁 | 副本、测试 helper、未来多进程场景仍会互相覆盖 |
| `orphaned` 也按配额淘汰 | 极端情况下会为了配额静默删除唯一可恢复副本 |
| 把窗口几何写进 `windows.json` | 与 view-state 形成两套状态，恢复顺序与覆盖规则复杂 |

## 证据

- `src-tauri/tests/history_store.rs`：捕获、去重/合并、50 版与 30 天、容量上限、恢复前后格式。
- `src-tauri/tests/trash_store.rs`：删除/恢复、同名不覆盖、跨卷复制校验、200/30d/512MiB、`orphaned` 保留。
- `src-tauri/tests/session_restore.rs`、`session_store.rs`：20 窗口、损坏回退、OS open 优先、草稿上限。
- `src-tauri/tests/storage_gc.rs`：四类存储上限、空数据耗时、失败不影响启动。
- `src-tauri/tests/file_lock.rs`：2s `BUSY`、释放后可获取、禁用 store 为 no-op。
- `scripts/ci/two-process-save.sh`：两个真实进程并发保存（最终为一个完整 payload）、持锁时 `BUSY`、SIGKILL 后锁自动释放。
- `scripts/e2e/soak.sh`：50 轮真实窗口 create/edit/cancel-close/confirm-close + 每 10 轮真实保存；10 MiB × 3 编码、10 次同名图片、SIGKILL 注入。

## 未决问题

- NEXT-004：稳定 documentId / 路径重命名配对。
- NEXT-006：`openat2(RESOLVE_BENEATH)` 或句柄身份，消除残余 TOCTOU。
- NEXT-007：目录回收站与系统回收站适配器。
- `locks/` 的全局清理策略（仅在应用未运行时安全）。
