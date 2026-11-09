# P0/P1 收尾与可信基础加固

> **模板定位：** LLM 持续实施控制台
> **功能 ID：** `p0-p1-closure`
> **对应 SDD Spec：** 无（沿用 `docs/todo/trusted-data-search/` 的交付记录）
> **对应需求：** R-001 ~ R-008
> **功能分支：** `feat/p0-p1-closure`
> **优先级：** P0/P1
> **负责人：** Qingmo 维护者 / 后续维护 Agent
> **最新代码校准日期：** 2026-11-09
> **代码基线：** `feat/p0-p1-closure@a23d736`

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "p0-p1-closure"
feature_name: "P0/P1 收尾与可信基础加固"
status: "done"                 # T-001~T-015 已实施；VERDICT PASS（B-001~B-005 PARTIAL）
current_task: "T-015（已完成）"
last_completed_task: "T-015"
next_action: "等待用户明确同意后提交；提交后复跑 pnpm ci:local、记录 Windows/Linux CI URL、执行 VoiceOver 14 项与 C-021。"
verification_status: "pass"      # PARTIAL 项见 B-001~B-005
research_status: "pass"
call_chain_status: "pass"
code_calibration_status: "pass"
decisions_status: "approved"     # Q-001~Q-008 全部 approved，无附加条件
last_verification_command: "C-001~C-021（见 02 §4）"
last_updated: "2026-11-09T23:30:00+08:00"
resume_from:
  - "README.md#0-LLM-STATE每轮实施前必须读取"
  - "01-实施计划.md#6-决策门禁gates"
  - "01-实施计划.md#7-llm任务队列"
  - "02-实施状态与验证.md#4-命令与结果"
allowed_scope:
  - "src-tauri/Cargo.toml"
  - "src-tauri/Cargo.lock"
  - "src-tauri/src/"
  - "src-tauri/tests/"
  - "src-tauri/tests/fixtures/identity_rollback/"
  - "src-tauri/examples/fault_write.rs"
  - "src-tauri/examples/two_process_save.rs"
  - "src-tauri/examples/identity_rollback.rs"
  - "apps/desktop/src/features/workspace/"
  - "apps/desktop/src/features/editor/"
  - "apps/desktop/src/lib/ipc/"
  - "apps/desktop/src/i18n/locales/"
  - "packages/editor-core/src/"
  - "packages/shared/src/generated/"
  - "e2e/"
  - "bench/"
  - "scripts/maintenance/"
  - "scripts/ci/"
  - ".github/workflows/ci.yml"
  - "docs/"
forbidden_scope:
  - "node_modules/"
  - "src-tauri/target/"
  - ".gitnexus/"
  - "用户 Markdown 文件内容（禁止写入内部 ID 或元数据）"
stop_condition: "所有 required=true 的 T-### 均为 done，02 的 VERDICT 为 PASS；Q-001 ~ Q-008 均已 approved 或 rejected 且记录决策。"
blocker_policy: "遇到 blocked 时记录 B-###、失败证据、已尝试方案和下一恢复动作"
```

> **状态更新规则：** 每完成一个任务，同步更新 `current_task`、`last_completed_task`、`next_action`、`verification_status`、`code_calibration_status` 和 `last_updated`。任何 Q 决策变化必须同步 `01 §6` 和 `02`。
>
> **状态口径：** README `status=done`、`01` 的 `状态=done`、`02` 的 `VERDICT=PASS` 一致：T-001~T-015 已实施并通过自动化验收；B-001~B-005 为外部环境/未提交工作区/人工验收缺口，恢复动作见 `02 §7`。提交仍需用户明确同意。

---

## 1. 一句话结论

P0/P1 收尾已完成 T-001~T-015：以 **权威 DocumentId + live/by_file/legacyPaths + FileIdentity 句柄复核 + 统一 16 MiB + 虚拟树焦点/ARIA** 为最小可信切片，并补齐 rename 配对、trash/恢复、token 生命周期、回滚工具与 ADR-0010。自动化验证通过（Rust all-targets、Vitest 877、Playwright 160+4、真实 Tauri WDIO 7）；B-001~B-005 为提交后 CI、Windows/Linux run URL、VoiceOver、GitNexus 映射与 xlarge 手动测量的 PARTIAL 项。

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 10 MiB 边界闭环：打开/保存/索引/watcher 使用同一文档上限，10 MiB + 1 字符保存后必须能重新打开 | C-003 + 16 MiB bench | done |
| R-002 | 稳定文档身份与重命名配对：外部文件/目录 rename 后，打开文档、历史、视图状态、窗口恢复保持一致；搜索索引不残留旧行 | C-005/C-006/C-008 | done |
| R-003 | 残余 TOCTOU 与路径安全：open/save/reload/trash 使用句柄身份复核；所有文档命令校验窗口归属 | C-004/C-009/C-010 | done |
| R-004 | 工作区树 10k 与无障碍：首帧 DOM 有界、键盘焦点可达、ARIA 完整、VoiceOver 可验收 | C-011/C-012 | done（VoiceOver PARTIAL+B-003） |
| R-005 | 平台与 symlink 一致性：Windows/Linux 编译与定向测试；树/索引对 symlink 采用同一策略 | C-013 | done（CI URL PARTIAL+B-002） |
| R-006 | 文档令牌生命周期：Save As 释放 current+previous token；DocumentWatcher 只向所属窗口广播 | C-007 | done |
| R-007 | 历史与回收站恢复正确性：`read_raw` 校验 size/hash；trash 同卷/跨卷恢复校验 hash；恢复目标经过 root jail | C-006/C-009 | done |
| R-008 | 搜索索引事件一致性：文件 rename 原子迁移索引行；目录 rename 前缀 rekey；symlink 按 link path | C-008 | done |

### 2.2 非目标

| 项 | 原因 | 后续处理 |
|---|---|---|
| 完整 `openat2(RESOLVE_BENEATH)` / Windows 句柄级 root jail | 需要跨平台系统调用与大规模路径层重构，超出本批最小安全切片 | NEXT-001 |
| 在用户 Markdown 文件中写入块 ID / 文档 ID | 会污染用户文件并破坏互操作 | 永不采用 |
| 新增用户可调配置项 | 本批所有阈值是产品安全边界，不作为用户配置 | NEXT-002 |
| 新增 SQLite 表或修改搜索索引 schema | 索引是缓存；本批用事件迁移修复，不引入新表 | NEXT-008 |
| 跨重启按文件身份全盘扫描恢复重命名窗口 | 启动成本不可控；先覆盖运行期 rename 和下次打开 | NEXT-003 |
| 系统回收站 / 目录回收站 | 跨平台 list/restore 能力不足 | NEXT-004 |
| app data 跨进程 identity 锁 | 单实例假设；本批不做 | NEXT-011 |
| 原子 compare-and-rename（renameat2/ReplaceFile） | 可移植层复杂；L-016 | NEXT-012 |
| symlink target rename 自动修复 | watcher 不修改用户文件系统；L-017 | NEXT-013 |

---

## 3. 当前运行时链路 / 目标调用链

### 3.1 调研与调用链证据摘要

| 项 | 状态 | 证据位置 | 结论摘要 |
|---|---|---|---|
| 官方文档调研 | pass | `01 §2.4`；`02 E-001~E-007` | ARIA APG、atomic-write-file、file-id、notify 已核对；commit Err/dirfd 语义已确认 |
| GitHub 开源实现调研 | pass | `01 §2.4.2` | VS Code/Joplin/SiYuan 的身份与 watcher 设计仅作参考，不复制代码 |
| subagent/GitNexus 调用链分析 | pass | `01 §3`；`02 E-008~E-014` | 4 个 explore + 3 个 general 评审；`open_path_inner`/`list_directory_with_limit`/`scan_root` 为 HIGH |
| 当前代码实时校准 | pass | `02 §8` | 已逐行复核 registry/atomic/workspace/watcher/search/history/trash/lock/session/frontend |
| 多轮评审 | pass | `05` | R1 自审 + R2~R14 外部评审；R5/R6/R7 的 21 项 Critical、R8 的 5C/15M/4m、R9 的 4C/11M/5m、R10 的 3C/7M/6m、R11 的 1C/2M/8m、R12 的 1M/4m、R13 的 1M/1m 已在 v1.9 修复，R14 窄复核通过；R15 实施后收口复核 PASS |

### 3.2 运行时链路：实施前基线 / 已实施目标

实施前基线（`a23d736`，问题链）：

```text
document_open / workspace_open_document
  -> DocumentRegistry::open_path_inner            document_registry.rs:153
     -> canonicalize + starts_with(root)          document_registry.rs:160-177
     -> FileLockStore::acquire(path hash)         file_lock.rs:49-83
     -> FileService::read(canonical)              file_service.rs:53-126
        -> metadata -> File::open -> 10 MiB cap
  -> DocToken::new()                              document_registry.rs:187
  -> DocumentRecord { raw_selected, canonical_target, state }

document_write_atomic
  -> DocumentRegistry::write_atomic               document_registry.rs:303
     -> AtomicWriter::write_with_services         atomic_writer.rs:41
        -> path lock -> DocState lock
        -> read_current (hash/size/mtime)         atomic_writer.rs:168
        -> history.capture(path hash bucket)     history_store.rs:119
        -> write_formatted(temp + rename)        atomic_writer.rs:137

外部 rename
  -> WorkspaceWatcher::handle_events              workspace_watcher.rs:429
     -> Modify(Name) with 2 paths 落入默认分支     workspace_watcher.rs:472-479
     -> 逐路径 notify_upsert；旧路径不存在 -> 旧行残留
  -> DocumentWatcher 按 canonical path 轮询       document_watcher.rs:135
     -> 两次缺失 -> Deleted                       document_watcher.rs:305-315
     -> 后续 save 返回 NotFound
```

目标（最小可信切片，已由 T-001~T-015 实施）：

```text
document_open
  -> WorkspaceService::resolve_document (root jail)
  -> FileService::read_raw(MAX_DOCUMENT_BYTES)   // fstat/O_NOFOLLOW, format+identity
  -> DocumentIdentityStore::resolve_open(path, identity)
     -> 返回 DocumentId（新 ID 同步持久化）
  -> DocumentRecord { document_id, paths, io_lock, active, state }
  -> registry.by_path.insert(PathKey, token)

document_write_atomic
  -> WindowSessions::owns_current_document(label, token)
  -> DocumentRegistry::write_atomic
     -> record.io_lock -> paths snapshot -> FileLock(path) -> DocState
     -> FileService::read_raw(MAX_DOCUMENT_BYTES)
     -> history.capture(record.document_id)
     -> write_formatted (dirfd/target 复核)
     -> commit 后 fstat -> identity.bind_save(id, new_file)

外部 rename（文件）
  -> WorkspaceWatcher::handle_events
     -> if index: SearchIndexService::rename_path(root, old_rel, new_rel, prepared) -> Result
     -> DocumentRegistry::rekey_path(old_abs, new_abs, root) -> Result
        -> io_lock -> identity.adopt(record.id, new_path, new_file)
        -> return relocated
     -> WorkspaceWatcher: emit_to owner + allow_document_assets + apply_window_titles

外部 rename（目录）
  -> WorkspaceWatcher
     -> DocumentRegistry::rekey_prefix(old_dir, new_dir, root) -> Result
     -> SearchIndexService::notify_rescan

工作区树 10k
  -> visibleRange 使用 DEFAULT_VIEWPORT_HEIGHT
  -> focusRow 离屏时先滚动 + restoreTarget，再聚焦
  -> aria-current / aria-posinset / aria-setsize / aria-level 完整
```

关键约束：

1. 不引入第二套文档身份：`DocumentId` 是唯一持久身份，`DocToken` 仍是 IPC 句柄。
2. 不引入第二套写盘路径：所有保存继续走 `AtomicWriter::write_formatted`。
3. 不引入第二套路径解析：workspace jail 继续复用 `workspace_service`；新增的只是身份复核。
4. 搜索索引仍是可重建缓存，不把用户数据或身份表放进 `index.sqlite`。
5. 文件锁继续使用 path-hash，不改为 DocumentId；跨版本/identity 故障仍互斥。

---

## 4. 当前实施状态总览

| T-ID | 任务 | Status | DependsOn | Gates | Evidence | Next |
|---|---|---|---|---|---|---|
| T-001 | FileIdentity 原语 | todo | none | none | none | 可开始（R14 已通过） |
| T-002 | DocumentIdentityStore | todo | T-001 | Q-002,Q-007 | none | 等 T-001 |
| T-003 | 统一 16 MiB | todo | T-001 | Q-001 | none | 等 T-001 |
| T-004 | verified read/write | todo | T-001,T-003 | Q-003,Q-005 | none | 等 T-003 |
| T-005 | registry 身份/路径/rekey | todo | T-002,T-004 | Q-002,Q-007,Q-008 | none | 等 T-004 |
| T-006 | History/View 稳定 ID | todo | T-005 | Q-002,Q-007 | none | 等 T-005 |
| T-007 | token/归属/定向事件 | todo | T-006 | none | none | 等 T-006 |
| T-008 | rename/索引/symlink | todo | T-005,T-006,T-007 | Q-004 | none | 等 T-007 |
| T-009 | trash 跨卷/jail/流式 | todo | T-004,T-008 | Q-003 | none | 等 T-008 |
| T-010 | reload/save-as/history raw | todo | T-007,T-009 | Q-005 | none | 等 T-009 |
| T-011 | 虚拟树 10k/焦点/ARIA | todo | T-003 | none | none | 与后端并行 |
| T-012 | 10k/VoiceOver 验收 | todo | T-011 | none | none | 等 T-011 |
| T-013 | Windows/Linux CI | todo | T-004,T-007,T-008,T-009 | Q-006 | none | 等 T-009 |
| T-014 | identity/history/view 回滚工具 | todo | T-002,T-006 | Q-002,Q-007 | none | 等 T-006 |
| T-015 | ADR/文档/最终验证 | todo | T-001~T-014 | Q-001~Q-008 | none | 最后执行 |

状态值只允许：`todo`、`in_progress`、`blocked`、`done`、`skipped`。

---

## 5. 交付物清单

| 类型 | 路径/对象 | 预期变更 | 状态 | 证据 |
|---|---|---|---|---|
| Code | `src-tauri/src/services/file_identity.rs` | 新增 | todo | none |
| Code | `src-tauri/src/services/document_identity.rs` | 新增 | todo | none |
| Code | `src-tauri/src/state/document_registry.rs` | 修改 | todo | none |
| Code | `src-tauri/src/services/file_service.rs` | 修改 | todo | none |
| Code | `src-tauri/src/services/atomic_writer.rs` | 修改 | todo | none |
| Code | `src-tauri/src/services/history_store.rs` | 修改 | todo | none |
| Code | `src-tauri/src/services/session_store.rs` | 修改 | todo | none |
| Code | `src-tauri/src/services/trash_store.rs` | 修改 | todo | none |
| Code | `src-tauri/src/services/search_index.rs` | 修改 | todo | none |
| Code | `src-tauri/src/state/workspace_watcher.rs` | 修改 | todo | none |
| Code | `src-tauri/src/state/document_watcher.rs` | 修改 | todo | none |
| Code | `src-tauri/src/commands/document.rs` | 修改 | todo | none |
| Code | `src-tauri/src/state/window_sessions.rs` | 修改 | todo | none |
| Code | `apps/desktop/src/features/workspace/VirtualWorkspaceTree.tsx` | 修改 | todo | none |
| Code | `apps/desktop/src/features/workspace/virtualRows.ts` | 修改 | todo | none |
| Test | `src-tauri/tests/file_identity.rs` | 新增 | todo | none |
| Test | `src-tauri/tests/document_identity.rs` | 新增 | todo | none |
| Test | `src-tauri/tests/document_token.rs` | 新增 | todo | none |
| Test | `src-tauri/tests/{document_roundtrip,atomic_writer,workspace,workspace_watcher,search_index,history_store,session_store,trash_store,storage_gc,document_save_as,document_window,file_lock,session_restore,export_bindings}.rs` | 修改 | todo | none |
| Test | `apps/desktop/src/features/workspace/VirtualWorkspaceTree.test.tsx` | 修改 | todo | none |
| Test | `e2e/workspace-10k.spec.ts` | 新增 | todo | none |
| Script | `src-tauri/examples/identity_rollback.rs` | 新增 | todo | none |
| CI | `.github/workflows/ci.yml` | 修改 | todo | none |
| Doc | `docs/adr/0010-document-identity-and-toctou.md` | 新增 | todo | none |
| Doc | `docs/BLUEPRINT.md` / `docs/roadmap.md` | 修改 | todo | none |
| Doc | `docs/todo/p0-p1-closure/{README,01,02,03,04,05}.md` | 修改 | todo | none |

---

## 6. 数据模型 / 配置 / 接口

### 6.1 数据模型

本批**不新增 SQLite 表**，搜索索引 schema 不变。新增一个受控的本地 JSON 身份索引（Q-002 已批准）：

```json
{
  "schemaVersion": 3,
  "entries": {
    "0f7f...uuid": {
      "path": "/Users/me/notes/a.md",
      "legacyPaths": ["/Users/me/notes/old-name.md"],
      "file": { "kind": "inode", "device": 16777220, "inode": 123456, "birthNs": 1760000000000000000 },
      "fileState": "present",
      "lastSeenMs": 1760000000000,
      "state": "active"
    }
  }
}
```

约束：

- 文件位于 `app_local_data_dir/identity/documents.json`，目录 `0700`、文件 `0600`。
- 最多 `IDENTITY_MAX_ENTRIES = 20_000`；TTL 180 天；tombstone 7 天；文件上限 8 MiB。
- 只保存路径、文件身份与时间戳，不保存正文、不保存用户内容。
- `DocumentId` 是 UUID v4；`DocToken` 仍是每次打开生成的 IPC 句柄，不持久化。
- 原子保存会更换 inode：`bind_save` 保留 ID，只更新 file identity。
- 外部 rename：`adopt(id, new_path, file)` 保留 ID，绝不重新 `observe` 分配新 ID。
- `disabled()` 完全使用 legacy 键（history path-hash、view path、lock path-hash），不生成伪 ID。

### 6.2 配置项

| 配置项 | 环境变量 | 默认值 | 行为 | 兼容性 |
|---|---|---|---|---|
| 无新增用户配置 | 无 | 无 | 本批不引入设置项 | 默认行为不变 |

内部常量（不是用户配置）：

| 常量 | 新值 | 说明 |
|---|---|---|
| `MAX_DOCUMENT_BYTES` | `16 * 1024 * 1024` | 打开/保存/索引/watcher 共用 |
| `IDENTITY_MAX_ENTRIES` | `20_000` | 身份索引上限 |
| `IDENTITY_TTL_MS` | `180 * 24 * 3600 * 1000` | 身份索引 TTL |
| `IDENTITY_TOMBSTONE_MS` | `7 * 24 * 3600 * 1000` | 删除/重建语义 |
| `DEFAULT_VIEWPORT_HEIGHT` | `560` | 虚拟树首帧回退高度 |

### 6.3 API / 对外接口

| 接口 | 变更 | 兼容性 | 验证 |
|---|---|---|---|
| `document_reload` | 增加窗口归属 + active 校验；io_lock + 路径锁 | 前端无感 | C-007/C-010 |
| `document_write_atomic` | 增加窗口归属 + active 校验 | 前端无感 | C-007/C-010 |
| `document_save_image` | 增加窗口归属校验 | 前端无感 | C-007 |
| `document_history_*` | 增加窗口归属；restore 校验 raw hash | 前端无感 | C-006/C-007 |
| `document_save_as` | 释放 current+previous token；目标已有 live doc -> Conflict | 前端无感 | C-005/C-007 |
| `session_view_state_*` | 增加可选 `docToken`；后端用 DocumentId | 旧客户端走 legacy | C-006 |
| `WindowIntent` | 增加可选 `documentId` | 向后兼容（`serde(default)`） | C-006 |
| `VirtualWorkspaceTree` | 增加 `aria-current`、kind 标签、type-ahead | 内部组件 | C-011/C-012 |
| `app://document-relocated` | 新增事件 `{docToken,path,name}` | 旧前端忽略 | C-008 |

---

## 7. 验收标准

| AC-ID | 验收项 | 覆盖任务 | 验证命令/证据 | Status |
|---|---|---|---|---|
| AC-001 | 10 MiB + 1 字符保存成功，随后重新打开成功；16 MiB + 1 被明确拒绝 | T-003 | C-003,C-019,C-021 | PASS（C-021 PARTIAL+B-005） |
| AC-002 | 保存/文件 rename 后 DocumentId、历史、视图稳定；目录 rename 后打开文档可保存；index 未 attach 时同样成立 | T-005,T-006,T-008 | C-005/C-006/C-008 | PASS |
| AC-003 | 关闭应用期间 rename，重新打开新路径仍命中历史/视图（同 file identity + legacyPaths） | T-005,T-006 | C-005/C-006 | PASS |
| AC-004 | 文件/目录 rename 后搜索索引无旧行；symlink link/target rename 与 detach 后无 stale raw 行、越界不入索引 | T-008 | C-008 | PASS |
| AC-005 | Save As 后 current+previous token 释放、旧 watcher 停止；跨窗口 token 的 reload/write/history/image/view-state 被拒绝；事件只到 owning window | T-007 | C-007 | PASS |
| AC-006 | reload 在并发保存时等待锁；history raw 篡改被拒绝；trash 同卷/跨卷恢复成功；恶意 entry 不能越界 | T-009,T-010 | C-009/C-010 | PASS |
| AC-007 | 10k 单目录首帧 treeitem <= 40；End/Home 可聚焦并滚动；`aria-current` 正确；VoiceOver 14 项通过 | T-011,T-012 | C-011/C-012 + 手工 | PASS（自动项）；VoiceOver PARTIAL+B-003 |
| AC-008 | Windows 定向 `cargo test` 通过或 PARTIAL+B-ID；Linux `--all-targets` 通过；symlink 负例通过 | T-013 | C-013 | PARTIAL+B-002 |
| AC-009 | `pnpm ci:local` 全绿；`pnpm ci:tauri` 通过或 PARTIAL+B-ID | T-015 | C-015/C-016 | PASS（ci:generated PARTIAL+B-001；ci:tauri PASS） |
| AC-010 | 未新增配置项/数据表；唯一新增数据文件已在 Q-002 获批；无第二套身份/写盘/watcher/路径解析 | T-002,T-005,T-008,T-015 | C-020（退出码 0 + 人工审计） | PASS |

> 说明：`PARTIAL` 仅用于外部环境/未提交工作区/人工验收缺口，功能与自动化证据见 `02 §4`。最终 VERDICT 为 `PASS`（附 B-001~B-005）。

---

## 8. 验证入口

> **唯一 C-ID 来源：** [`02-实施状态与验证.md §4`](02-实施状态与验证.md#4-命令与结果)。README 只引用，不重复定义。

```bash
# 单任务最小验证（从仓库根执行）
cargo test --manifest-path src-tauri/Cargo.toml --test file_identity
cargo test --manifest-path src-tauri/Cargo.toml --test document_identity
cargo test --manifest-path src-tauri/Cargo.toml --test document_roundtrip --test atomic_writer
cargo test --manifest-path src-tauri/Cargo.toml --test workspace --test workspace_watcher --test search_index
cargo test --manifest-path src-tauri/Cargo.toml --test history_store --test session_store --test trash_store --test file_lock
cargo test --manifest-path src-tauri/Cargo.toml --test document_save_as --test document_window --test document_token
pnpm exec vitest run apps/desktop/src/features/workspace

# 模块回归
pnpm test:e2e -- e2e/workspace-10k.spec.ts
pnpm test:e2e -- e2e/workspace-navigation.spec.ts
pnpm typecheck && pnpm lint

# 全量
pnpm ci:local
pnpm ci:tauri
node .gitnexus/run.cjs detect-changes --scope all --repo .
```

| C-ID | 用途 | 何时运行 |
|---|---|---|
| C-001 ~ C-014 | 任务级验证 | 对应 T 完成后 |
| C-015 | `pnpm ci:local` | T-015 |
| C-016 | `pnpm ci:tauri` 或 PARTIAL+B-ID | T-015 |
| C-017 | GitNexus `detect_changes` | 提交前/T-015 |
| C-018 | `pnpm typecheck && pnpm lint` | T-015 |
| C-019 | `pnpm bench`（16 MiB `xlarge`） | T-003/T-015 |
| C-020 | 静态审计（无新增配置/SQL/第二套实现） | T-015 |
| C-021 | Tauri 16 MiB 首屏/RSS 手动记录（`bench/tauri/measure.swift`） | T-003/T-015 |

---

## 9. 风险与回滚摘要

| RK-ID | 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|---|
| RK-001 | 16 MiB 打开导致内存/首帧退化 | 中 | 16 MiB bench + RSS 门槛；超限回退 Q-001 B/C | 回滚保留 16 MiB 读取；C-019/C-021 监控 |
| RK-002 | 身份索引损坏或迁移失败导致历史/视图“看不到” | 高 | 同步新 ID、copy/merge、dual-read、备份、脚本 | 停用 identity -> legacy；运行 T-014 脚本 |
| RK-003 | rename 事件平台差异/目录 rename | 中 | 文件双边+单边 rescan+目录前缀+父目录恢复 | 关闭配对，回到 rescan |
| RK-004 | 网络卷 file ID 不稳定导致误判 | 中 | 拒绝全零；失败回退 path；同目录限制 | 禁用身份复核，仅保留 canonicalize |
| RK-005 | view-state 迁移丢条目 | 中 | 迁移前 `.v1-backup-*`；dual-read；失败保留 | 恢复备份 |
| RK-006 | 虚拟树焦点/滚动回归 | 中 | 10k Vitest + Playwright + 手工键盘 | 恢复 viewport fallback |
| RK-007 | Windows CI 定向测试失败 | 中 | 先 `cargo check`，再逐测试启用；保留 compile-only | 降级 compile-only + B-ID，AC-008 PARTIAL |
| RK-008 | 搜索索引 rename 迁移失败 | 低 | 单事务 + 失败回退 rescan；索引可重建 | 删除 `index/` 重建 |
| RK-009 | 锁 key 变化旧锁文件残留 | 低 | **不改变锁 key** | 无 |
| RK-010 | identity 数据文件隐私 | 低 | 0700/0600；不存正文；日志脱敏 | 删除 identity 并回滚 |
| RK-011 | 多实例 identity 分叉 | 中 | 单实例假设；文档化 | NEXT-011 |
| RK-012 | 同路径新文件继承旧 ID | 中 | mark_missing 移除 by_path；resolve_open_new；tombstone 拒绝 live | 关闭 path 优先，按 file identity 新建 |
| RK-013 | hardlink 共享 ID/历史 | 中 | by_file 多值 + hardlink 默认新 ID | 按 path 新建 |
| RK-014 | atomic temp 遗留 | 低 | commit Err best-effort；同路径锁内 >24h 清理 | 手工清理匹配 temp |
| RK-015 | 关闭期间 rename 历史不可见 | 中 | file identity + legacyPaths alias 迁移 | 运行 T-014 工具/恢复备份 |
| RK-016 | 最后 commit 覆盖窗口 | 中 | ExpectedTarget + parent identity + FileLock 缩小窗口；L-016 | 保留原文件/临时副本，人工恢复 |
| RK-017 | symlink target rename 后 link 悬空 | 中 | 不重写用户 symlink；raw detach 到 canonical + 索引 rescan；L-017/NEXT-013 | 手工重建 link 或 Save As |

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [`01-实施计划.md`](01-实施计划.md) | 任务队列、依赖/Gates、文件范围、调研与调用链证据 |
| [`02-实施状态与验证.md`](02-实施状态与验证.md) | 执行日志、C-ID 命令、基线、验收覆盖、VERDICT |
| [`03-复盘与交接.md`](03-复盘与交接.md) | 决策、踩坑、回滚、维护与交接 |
| [`04-设计方案.md`](04-设计方案.md) | 架构、身份算法、数据流、状态机、异常流、兼容性 |
| [`05-多轮评审记录.md`](05-多轮评审记录.md) | 多轮评审发现、修复与最终结论 |

---

## 11. 变更日志

| 时间 | 变更 | 作者/Agent | 证据 |
|---|---|---|---|
| 2026-11-09T14:10:00+08:00 | 创建实施控制台与初版方案 | OpenCode Agent | 本文件 |
| 2026-11-09T15:40:00+08:00 | 升级 v1.1：任务 T-001~T-015、Q Gates、C-ID 统一、范围/回滚修正 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T17:10:00+08:00 | Q-001~Q-008 全部批准；R5/R6 复审；方案具备实施前提 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T19:00:00+08:00 | 升级 v1.3：R5/R6/R7 修复；任务依赖/文件范围/AC/C-ID/风险同步；进入 R8 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T21:30:00+08:00 | 升级 v1.4：R8 修复；C-021 Tauri 证据；任务依赖/文件/AC 同步；进入 R9 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:30:00+08:00 | 升级 v1.5：R9 修复；FileIdentity/rekey/close/symlink/image/history/bench/view 归属；RK-017；R10 待执行 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:55:00+08:00 | 升级 v1.6：R10 修复；T-001 libc、target rename 身份复核、assets dirfd、view-state root、10 MiB 测试覆盖；R11 待执行 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:59:00+08:00 | 升级 v1.7：R11 修复；save_image wrapper、i18n 测试、poll_once 逐候选、schema v3；R12 待执行 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:59:00+08:00 | 升级 v1.8：R12 修复；poll_once legacy 外层检测、T-005 快照借用、C-003 document_open；R13 待执行 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:59:00+08:00 | 升级 v1.9：R13 修复；identity_pending legacy/degraded Deleted、02 口径；R14 待执行 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:59:00+08:00 | R14 窄复核通过；随后 T-001~T-015 实施完成 | OpenCode Agent | `05-多轮评审记录.md` |
| 2026-11-09T23:30:00+08:00 | T-015 收口：ADR-0010、BLUEPRINT/roadmap、VERDICT PASS；B-001~B-005 PARTIAL | OpenCode Agent | `02 §4/§15`；`05 R15` |
