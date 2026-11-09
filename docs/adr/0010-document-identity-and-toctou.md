# ADR-0010：文档身份、verified IO 与重命名配对

- **状态：** 已接受
- **日期：** 2026-11-09
- **决策者：** Qingmo 维护者（P0/P1 收尾）
- **关联：** `p0-p1-closure 04 §5/§6/§14`；D-001~D-021；ADR-0002、ADR-0004、ADR-0008、ADR-0009

## 背景

P1 的保存路径是“读当前文件 → 写临时文件 → rename 覆盖”。这在数据完整性上是正确的，但带来三个跨能力问题：

1. **原子保存会更换 inode。** 若把 inode/file ID 直接当文档身份，每次保存都会“换一个人”；历史、视图状态、窗口恢复和搜索索引全部按 canonical path 派生键，外部 rename 后同样失联。
2. **路径安全仍是 check-then-use。** `canonicalize + starts_with` 之后到 `open`/`rename` 之间没有句柄级身份复核；父目录或目标文件可在窗口内被替换，形成残余 TOCTOU。
3. **边界与所有权不一致。** 打开上限 10 MiB、写入上限 16 MiB 导致“保存成功但无法重开”；`DocumentWatcher` 全局广播 token 事件；Save As 覆盖当前 token 而不释放 current+previous；回收站跨卷恢复、trusted root 与 symlink 语义不完整。

本 ADR 固化本批的最小可信切片：**一个权威 DocumentId + 一个 FileIdentity 复核原语 + 一个统一 16 MiB 边界**，复用既有 `DocumentRegistry`、`AtomicWriter`、`FileLockStore`、`HistoryStore`、`SessionStore`、`SearchIndexService`、`WorkspaceWatcher`、`TrashStore`，不新增第二套写盘、watcher、身份或路径解析。

## 决策

### 1. DocumentId 是持久身份，而不是 inode

1. 新增 `DocumentIdentityStore`，持久文件为 `app_local_data_dir/identity/documents.json`，schema v3：
   - `entries[DocumentId] = { path, legacyPaths, fileState, file, lastSeenMs, state }`；
   - `by_path` / `by_file` 为派生索引，写入时与 entries 同步维护。
2. `DocumentRecord.document_id` 在记录生命周期内**不可变**；live record 的 ID 是权威。History/View 直接接收 `DocumentId`，不在使用时重新 `observe(path)`，避免 use-time 抢 ID/串桶。
3. 保存、外部 rename、目录 rename 只 `adopt` 原 ID，绝不重新分配；只有“同路径已变成另一个文件”才通过 `resolve_open_new` 生成新 ID。
4. `identity/documents.json` 损坏时备份并从 history/view 的 legacy 键重建；`DocumentIdentityStore` 不可用时完全使用 legacy 键（history path-hash、view path、lock path-hash），**不生成伪 ID**。降级态写 API 返回 `IDENTITY_DEGRADED`。
5. 唯一新增持久文件就是 `identity/documents.json`；不新增用户配置项、不新增 SQL 表、不向用户 Markdown 写入任何 ID。

### 2. FileIdentity 只做复核与配对

1. Unix 使用 `dev + ino + birth`；Windows 使用 volume serial + file index（HighRes/LowRes）；不可用时为 `Unavailable`，全零身份拒绝。
2. FileIdentity 用于：
   - open/save/reload 的 target/parent 复核；
   - watcher rename 配对与父目录恢复扫描；
   - 关闭期间 rename 后的窗口恢复候选。
3. FileIdentity **不是**文档主键：原子保存换 inode，只有持久 DocumentId 能跨保存稳定。
4. 身份不可用或网络卷 inode 复用场景回退 path 匹配；`Present` 但身份不同视为“同路径新文件”，不继承旧 ID/历史。

### 3. 路径快照、锁顺序与 rekey

1. `DocumentRecord` 持有 `paths: Mutex<DocumentPaths>`：
   ```text
   DocumentPaths { raw_path, canonical_target, parent_identity, file_identity, generation }
   ```
   `raw_path` 保留用户可见的 symlink/link 拼写，`canonical_target` 是实际读写目标。
2. `io_lock` 是路径变更的唯一进程内 owner。全局顺序：
   ```text
   registry.rekey_lock -> record.io_lock -> FileLock(path) -> DocState -> store 内部锁
   ```
   `FileLockStore` 只由 `AtomicWriter` 与 `TrashStore` 获取，`DocumentRegistry` 不直接持有 path lock，避免双 owner/ABBA。
3. `rekey_path` / `rekey_prefix` / `rekey_token` / `rekey_document` 在 `rekey_lock` 内排序获取全部 `io_lock`，先校验目标未被其他 live token 占用，再更新 paths/by_path/identity；任一冲突整体失败。
4. 文件锁继续使用 `blake3(path)[..32]`，不注入 identity；rename 后保存使用新 path 锁。这样跨版本、disabled、identity 故障时仍互斥。

### 4. verified read / write

1. 读取走 `FileService::read_raw`：O_NOFOLLOW / O_NONBLOCK（Unix）、句柄 fstat 身份、前后 size/mtime 稳定检查；记录 parent identity。
2. 写入统一走 `AtomicWriter`：
   - `ExpectedTarget::{Existing{identity,hash,size,mtime}, Absent}` 锚定 `read_current` 的版本；
   - `parent_identity` 锚定父目录；
   - Unix 用 `AtomicWriteFile::directory()` 的 dirfd 做 fstat 复核；Windows 用句柄可达的身份；
   - `commit()` 返回 Err 时重新读取 hash/size，成功则视为提交成功，无法判断时保留原文件/temp 并报错。
3. `reload` 使用 `AtomicWriter::with_read_lock` 获取同一 path 锁；Save As 使用 `AtomicWriter::write_new` 只获取一次锁；history restore 使用 `AtomicWriter::restore_with_services`，expected target 由同一个 locked `read_current` 产生，调用方不能自带未验证版本。
4. 打开/保存/索引/watcher 统一 `MAX_DOCUMENT_BYTES = 16 MiB`；写入仍受 `MAX_WRITE_BYTES` 约束，超限返回 `FILE_TOO_LARGE`。

### 5. rename、索引与 watcher

1. 文件 rename：旧/新路径都按事件绝对路径匹配，`rekey` 保留 ID；`md -> txt` 等扩展名变化同样 rekey。
2. 目录 rename：`rekey_prefix` 重写所有以旧目录为前缀的 raw/canonical path；索引按前缀迁移，失败则 rescan。
3. 搜索索引：
   - `prepare_upsert` + `upsert_prepared` 单事务写入；
   - `rename_path` 单事务迁移旧行；
   - `remove_path_or_prefix` 清理失效行；
   - symlink 文件按 link path 索引，只索引 root 内目标。
4. `WorkspaceWatcher` 通过 `WorkspaceEventSink` 通知，不直接依赖 `DocumentWatcher`；Tauri sink 负责 asset scope、标题与 `app://document-relocated`。
5. `DocumentWatcher` 每轮从 registry 读取最新 `canonical_target`，只向 `sessions.label_for_current(token)` 对应窗口发送 `document-changed`；previous token 静默。

### 6. Token 生命周期与窗口所有权

1. `SaveResult` 返回 `docToken` 与 `generation`；`document_activate` 用二者校验结果归属。
2. Save As 使用 `replace_token` 在同锁内返回 current + previous；命令层对两者 `deactivate`、release registry、停止 watcher。
3. mutating 命令（save/reload/save image/history restore/trash）只接受 current token；previous token 只允许回滚。
4. view-state 与历史命令校验窗口所属 workspace；`window_path_match` 在 path 相同但身份不同时拒绝继承旧视图。

### 7. 回收站

1. 恢复目标统一经 `resolve_relative_target`：段校验、逐段拒绝 symlink 组件、最近存在祖先 canonical + `starts_with`；Original/Copy 都走该 jail。
2. trusted roots 只在 workspace open 后恢复；`roots=[]` 不恢复任何 Pending。恶意 `entry.root` 不能越界写入。
3. 同卷与跨卷恢复都先流式校验 payload hash；跨卷用 staging copy，严禁覆盖目标（含 broken symlink）。
4. symlink 删除只移动 link 本身，hash link 文本，绝不读取/删除 target；恢复重建 link。
5. Pending/Orphaned 计入容量治理，但不按 TTL 静默删除——它们可能仍是唯一副本。

### 8. 回滚

1. `src-tauri/examples/identity_rollback.rs` 复用 Rust `blake3`，把 ID 桶映射回 legacy path 键。
2. 默认 dry-run，不写盘；`--apply` 只复制/合并 history 与 view-state，绝不删除 identity/history/view。
3. 报告写入 `rollback-report.json`；冲突、缺失 payload、无效路径必须显式列出，不能静默跳过。

## 后果

**正面：**

- 保存/外部 rename/目录 rename 后，历史、视图、窗口恢复与索引不再失联。
- open/save/reload/trash 的目标与父目录在写入前有句柄级复核，残余 TOCTOU 窗口显著缩小。
- 10–16 MiB 文档保存后可以重新打开；索引与 watcher 使用同一边界。
- 10k 单目录首帧 DOM 有界，Home/End/type-ahead 与 ARIA 语义可用。
- Save As 不再泄漏 token，watcher 事件不再跨窗口广播。
- identity 故障/回滚/Windows 场景有明确的 legacy 降级路径。

**代价/限制：**

- 唯一新增持久文件 `identity/documents.json` 需要备份/迁移/回滚；多实例仍只有进程内锁（L-011）。
- 网络卷 file ID 不稳定、Linux birth 不可用时只能弱匹配（L-003）。
- 可移植层仍无法原子 compare-and-rename，最后一次复核与 `commit()` 之间仍有极小覆盖窗口（L-016）。
- symlink target 被外部 rename 后 link 可能悬空；本批不自动重写用户链接（L-017/NEXT-013）。
- 16 MiB 文档仍全量进入 CM6/IPC，内存随文件大小上升（L-005）。

## 证据

- `src-tauri/tests/file_identity.rs`（11 项）：三变体、句柄身份、全零、birth、Unix/Windows 差异。
- `src-tauri/tests/document_identity.rs`（24 项 + 1 项 Windows-only）：schema v3、live/by_file/legacyPaths、adopt、tombstone、degraded、GC、Windows PathKey。
- `src-tauri/tests/document_token.rs`（5 项）：Save As current+previous、ownership、定向事件。
- `src-tauri/tests/document_roundtrip.rs`（11 项）：16 MiB 边界、md→txt reload、Save As symlink/history、expected target。
- `src-tauri/tests/history_store.rs`（7 项）/`session_store.rs`（20 项）：ID 桶、legacy 迁移、dual-read、raw 篡改拒绝。
- `src-tauri/tests/workspace_watcher.rs`（14 项）/`search_index.rs`（10 项）：文件/目录 rename、relocated、symlink link path、索引迁移。
- `src-tauri/tests/trash_store.rs`（12 项）/`workspace.rs`（12 项）：trusted roots、同卷 hash、symlink link、大文件流式、`..`/symlink 父目录拒绝。
- `src-tauri/tests/identity_rollback.rs`（8 项）+ `examples/identity_rollback.rs`：dry-run/apply、合并、v1 view 迁移、不删除源。
- `apps/desktop/src/features/workspace/VirtualWorkspaceTree.test.tsx`（19 项）/`virtualRows.test.ts`：10k 首帧 ≤40、End/Home、aria-current、type-ahead。
- `e2e/workspace-10k.spec.ts` + `e2e/workspace-navigation.spec.ts`：真实浏览器 10k 首帧、End/Home、当前行。
- `pnpm ci:tauri`：真实 Tauri WDIO 7 项通过（打开/保存/冲突/图片/搜索/窗口）。
- `bench/results/2026-11-09.json`：16 MiB open p50 47.5ms、save p50 97.2ms、Node peak RSS 635.4MB。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 用 inode/file ID 直接当文档 ID | 原子保存每次换 inode，历史/视图必然失联 |
| 继续全部按 path 键 | 外部 rename、目录 rename、关闭期间 rename 无法恢复 |
| 在 Markdown 中写块 ID/文档 ID | 污染用户文件、破坏互操作 |
| 新增 SQLite identity 表 | 需新增表/迁移，且 identity 不是可重建缓存；Q-002 只批准 JSON |
| 文件锁改 DocumentId | 新旧版本不互斥、disabled 时失效、rename 后锁键漂移 |
| 第二个 writer/watcher/路径解析层 | 双写盘与双事件源会引入不一致，维护成本高 |
| 前端直接做 identity/rename 映射 | 破坏 Rust 独占 IO 与路径权威 |
| 全盘 identity 扫描恢复跨重启 rename | 启动成本不可控（NEXT-003） |
