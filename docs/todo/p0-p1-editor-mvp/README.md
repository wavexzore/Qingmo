# P0–P1 编辑器 MVP 骨架

> **模板定位：** LLM 持续实施控制台
> **功能 ID：** `p0-p1-editor-mvp`
> **对应 SDD Spec：** 无（Qingmo 尚未接入 `.jssdd`）
> **对应需求：** `R-001 ~ R-015`（本文 §2.1）
> **功能分支：** `main`（本地仓库；已有 `p0-docs-baseline`、`p1-baseline` 两个 tag，未推送远端）
> **优先级：** P0 + P1（垂直切片）
> **负责人：** 待定
> **最新代码校准日期：** 2026-10-26
> **设计基线：** [`04-设计方案.md`](04-设计方案.md) v1.1
> **计划基线：** [`01-实施计划.md`](01-实施计划.md) v1.1

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "p0-p1-editor-mvp"
feature_name: "P0–P1 编辑器 MVP 骨架"
status: "in_progress"             # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "T-011"             # 当前应执行的任务；无则写 none
last_completed_task: "T-010"      # 最近完成任务；无则写 none
next_action: "T-010 已完成（2026-10-26 15:46）；执行 T-011：SaveCoordinator"
verification_status: "partial"    # not_run | pass | fail | partial | skipped（T-001~T-010 全部 PASS；P1 闭环未完成）
research_status: "pass"           # not_run | pass | partial | skipped
call_chain_status: "partial"      # not_run | pass | partial | skipped（骨架/读写直接边已索引；前端 IPC 调用者与关闭链待 T-012 后重建）
code_calibration_status: "pass"   # not_run | pass | fail | partial | skipped（T-001~T-010 后已重新校准）
last_verification_command: "pnpm test && pnpm build && pnpm depcruise"
last_updated: "2026-10-26T15:46:00+08:00"
resume_from:
  - "README.md#0-LLM-STATE每轮实施前必须读取"
  - "01-实施计划.md#6-llm任务队列"
  - "02-实施状态与验证.md#3-执行日志"
  - "02-实施状态与验证.md#8-计划-vs-实际差异"
allowed_scope:
  - "apps/desktop/**"
  - "packages/shared/**"
  - "packages/editor-core/**"
  - "packages/ui/**"
  - "src-tauri/**"
  - "package.json"
  - "pnpm-workspace.yaml"
  - "pnpm-lock.yaml"
  - "src-tauri/Cargo.lock"
  - "rust-toolchain.toml"
  - "tsconfig*.json"
  - "eslint.config.*"
  - ".prettierrc*"
  - ".gitignore"
  - ".nvmrc"
  - "vitest.config.*"
  - "dependency-cruiser.config.cjs"
  - "rustfmt.toml"
  - "clippy.toml"
  - ".github/workflows/**"
  - "bench/**"
  - "e2e/**"
  - "playwright.config.ts"
  - "scripts/fault-injection/**"
  - "docs/adr/**（新增 ADR）"
  - "docs/todo/p0-p1-editor-mvp/**"
  - "README.md（仅状态/下一步段落）"
forbidden_scope:
  - "docs/BLUEPRINT.md（除 Q-011 已确认的 P2 修正）"
  - "docs/RESEARCH.md"
  - "docs/TOPOLOGY.md"
  - "docs/qingmo-topology.*"
  - "docs/topology-gen.js"
  - "plugins/**（P3）"
  - "任何 SQLite/数据库文件"
  - "任何 .env / credentials / secret"
stop_condition: "Q-001~Q-015 已确认（2026-10-26）；所有 required=true 的 T-### 均为 done 且有证据；02 的 VERDICT: PASS"
blocker_policy: "遇到 blocked 时在 02 §7 记录 B-###、失败证据、已尝试方案和下一恢复动作；不得跳过依赖或静默改范围"
```

> **状态更新规则：** 每完成一个任务，必须同步更新本块的 `current_task`、`last_completed_task`、`next_action`、`verification_status`、`code_calibration_status`、`last_updated`，并回写 `01 §6` 与 `02 §2/§3`。

---

## 1. 一句话结论

Qingmo 已从纯文档阶段进入实施：`T-001` 建立了 pnpm workspace + Vite 7/React 19/TS 5 + Tauri 2 骨架与双基线 tag；`T-002` 收紧权限/CSP；`T-003` 冻结 IPC 契约；`T-004` 落地 UI token、App Shell、i18n、状态栏与 CommandRegistry；`T-005` 打通 Rust 原生 dialog、token 边界、严格编码/EOL 与 10MiB 读取；`T-006` 建立原子写、always-hash 冲突与字节级 UTF-16 保存；`T-007` 建立可测试的 IpcPort/PlatformPort 与浏览器 fake adapter；`T-008` 打通欢迎页→原生 dialog→CM6 `EditorState` 的打开流程；`T-009` 建立 Markdown/语言/Compartment 的唯一编辑组合；`T-010` 接入唯一 `EditorView` 与节流状态栏。当前 `10/20` 任务完成，保存协调器、冲突 UI 与关闭守卫尚未接入；下一步 `T-011` SaveCoordinator。

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 建立可启动的 Tauri 2 + React + Vite + CM6 工程 | `pnpm tauri dev` + 三平台 `cargo check` | partial（T-001 已启动；CM6 待 T-009） |
| R-002 | 打开 `.md/.markdown`；`.mdx` 只读 | Rust 侧 dialog + `docToken`；文件信息正确 | todo |
| R-003 | CM6 `EditorState` 是唯一文档真源 | 代码审查 + store 形状测试 | todo |
| R-004 | 最小 Live Preview（标题/强调/行内代码/链接/引用/列表） | 装饰快照 + 1MB 手动 | todo |
| R-005 | 唯一原子保存通道（手动/自动共用） | Rust 单测 + 断电模拟 | todo |
| R-006 | 自动保存：800ms 去抖、5s 上限、单飞、flush 循环、退避 | Vitest fake timers | todo |
| R-007 | 冲突检测：外部修改不静默覆盖；精确 hash 覆盖 | Rust 集成 + E2E | todo |
| R-008 | 大文件退化：10MiB 可编辑；>2M units 关 LP；>10MiB 拒绝 | bench + 手动 | todo |
| R-009 | 命令注册表 + 命令面板 + 快捷键单一来源 | 单测 + 组件测试 | todo |
| R-010 | light/dark/system 主题不重建 EditorView | 组件测试 + 撤销验证 | todo |
| R-011 | zh-CN 默认、en 回退；错误码有文案 | key 对齐测试 | todo |
| R-012 | 无 fs/shell/http 插件；CSP；Rust dialog + token | 契约 + 负例测试 | todo |
| R-013 | 命令名/事件名/能力/DTO 契约锁定 | 六方契约测试 + ts-rs 校验 | todo |
| R-014 | Rust/TS/浏览器 E2E/Tauri 冒烟可验证 | 测试命令全绿 | todo |
| R-015 | 10KB/1MB/10MiB 性能基线只记录不宣称 | `pnpm bench` | todo |

### 2.2 非目标

| 项 | 原因 | 后续处理 |
|---|---|---|
| 工作区根/文件树/最近文件 | P2 | NEXT-001 |
| SQLite/FTS/反链/标签/搜索 | P2；FTS schema 需先修 | NEXT-002 / Q-011 |
| watcher/崩溃恢复/备份/版本历史 | P2；避免临时恢复机制 | NEXT-003 |
| 插件 SDK/Host/市场/签名 | P3 | NEXT-004 |
| Preview 面板/图片/表格/Mermaid/KaTeX/Shiki | P1 只做 Lean LP | NEXT-005 |
| 设置页/settings.json/窗口状态 | P2；避免多配置源 | NEXT-006 |
| 原生菜单/托盘/单实例/深链接/更新器 | P2/P4 | NEXT-007 |
| 协作/CRDT/OT | P6 | NEXT-008 |
| 移动端 | 蓝图非目标 | NEXT-009 |
| 文档 UUID/DB schema | P2 建库前决定 | Q-007 / NEXT-010 |

---

## 3. 当前运行时链路 / 目标调用链

### 3.1 调研与调用链证据摘要

| 项 | 状态 | 证据位置 | 结论摘要 |
|---|---|---|---|
| 官方文档调研 | pass | `01-实施计划.md §2.4.1`；`02 E-001~E-003` | Tauri 2 capabilities/CSP/commands/core 权限/window、CM6 decoration/ref/composition、atomic-write-file、ts-rs、encoding_rs UTF-16 限制已核对；tauri-specta v2 仍为 RC，P1 拒绝 |
| GitHub 开源实现调研 | pass | `01-实施计划.md §2.4.2`；`02 E-004~E-005` | MarkEdit 的 ViewPlugin+Lezer、NoteGen/MarkFlowy 的自定义命令/保存、create-tauri-app 的 Vite 约定已对比；均不复制代码 |
| subagent/GitNexus 调用链分析 | partial | `01-实施计划.md §3`；`02 E-006/E-007/E-012/E-013/C-051/C-057`；`05` | Qingmo 已索引 1,397 nodes/2,949 edges（`2528c61`）；骨架、读写、`invokeCommand -> normalizeError`、`WorkspaceLayout -> CommandRegistry.register`、`EditorSession -> createEditorState` 与双 adapter 选择已验证；动态 IPC 入口与关闭链待 T-012；参考项目 `call -> rawInvoke` 仅作方法参考 |
| 当前代码实时校准 | pass | `02-实施状态与验证.md §8`；`02 E-008/C-021` | T-001 前确认无代码、非 Git；T-001 后已有 `apps/desktop`、`packages/*`、`src-tauri` 骨架与双基线 tag |

### 3.2 目标调用链

```text
用户点击“打开文件”
  -> IpcPort.documentOpen()
  -> Rust document_open（Rust 侧 dialog）
  -> DocumentRegistry: 扩展名/大小/编码校验 -> canonicalize
  -> 读取（open handle + take(MAX+1)）-> blake3
  -> BOM/编码 -> 严格解码 -> EOL 计数 -> 内存 LF
  -> docToken + FilePayload（text LF-only + textUnits）
  -> EditorSession: EditorState.create({ doc, readOnly facet })
  -> EditorHost: 唯一 EditorView + LivePreview ViewPlugin + Theme Compartment
  -> 用户输入 -> CM6 transaction -> EditorState 更新 -> dirty
  -> SaveCoordinator.schedule()
  -> 800ms 去抖 / 5s 上限 / 单飞 / flush 循环
  -> IpcPort.documentWriteAtomic({docToken, text LF-only, expectedCurrentHash?})
  -> Rust: 读当前字节/hash -> 冲突检查 -> encode（UTF-16 手写）
  -> atomic-write-file: temp + fsync + rename
  -> SaveResult -> registry 更新 base_hash/size/mtime -> 前端展示镜像（size/mtime）-> clean
```

关键约束：

1. 文件读写只走 4 条自定义命令 + 1 个关闭事件；不启用 `tauri-plugin-fs`，不允许组件直接 `invoke`，前端不持有可写路径。
2. 正文只存在于 CM6 `EditorState`；React/Zustand 只保存派生状态（dirty/cursor/saveState）。
3. 手动/自动/失焦/关闭保存都必须经 `SaveCoordinator`；关闭统一走 Rust CloseGuard。
4. token 无效、编码未知、UTF-32/无 BOM UTF-16、混合 EOL、冲突未确认时一律拒绝写。
5. P1 不建 SQLite、不建 settings.json；唯一持久化键是 `qingmo.ui.theme`（Q-005 已确认）。

---

## 4. 当前实施状态总览

| T-ID | 任务 | Status | DependsOn | Evidence | Next |
|---|---|---|---|---|---|
| T-001 | pnpm workspace + Git 基线 + Vite/React/TS/Tauri 骨架 | done | none | C-011~C-013/C-017/C-020~C-023/C-025 | T-002 |
| T-002 | Tauri 安全基线（CSP/最小 core 权限） | done | T-001 | C-024/C-026/C-027 | T-003 |
| T-003 | IPC 契约（DTO/错误/4 命令/1 事件/stub/ts-rs/六方契约） | done | T-002 | C-014/C-028~C-031 | T-004 |
| T-004 | UI token / App Shell / i18n / 状态栏 / Registry 核心 | done | T-001 | C-032~C-036 | T-005 |
| T-005 | Rust dialog + DocumentRegistry + `document_open/reload` + 编码 | done | T-003 | C-037~C-044 | T-006 |
| T-006 | 原子写 + 冲突 + `document_write_atomic` | done | T-005 | C-045~C-050 | T-007 |
| T-007 | IpcPort/PlatformPort + 错误归一化 + fake adapter | done | T-003/T-005/T-006 | C-052~C-057 | T-008 |
| T-008 | 文档会话 + 打开流程 + CM6 EditorState | done | T-004/T-007 | C-058~C-066 | T-009 |
| T-009 | CM6 扩展组合（Markdown/语言/readOnly facet） | done | T-008 | C-067~C-070 | T-010 |
| T-010 | React 绑定 + 唯一 EditorView + session store | done | T-009 | C-071~C-075 | T-011 |
| T-011 | `SaveCoordinator` + flush 循环 + 错误分类 | todo | T-010 | none | 下一步 |
| T-012 | 保存 UI + 冲突横幅 + Rust CloseGuard | todo | T-011/T-004/T-007 | none | T-011 后 |
| T-013 | Live Preview v1（ViewPlugin + Lezer + 多选区/IME） | todo | T-010/T-004 | none | T-010 后 |
| T-014 | 大文件降级 + IME 守卫 + 阈值提示 + LP 命令 | todo | T-012/T-013 | none | T-013 后 |
| T-015 | 命令面板 + 快捷键（不新增命令） | todo | T-012/T-013/T-016 | none | 三个命令都注册后 |
| T-016 | 主题：CSS 变量 + Compartment + uiStore + theme 命令 | todo | T-004/T-009/T-010 | none | 可与 T-013 并行 |
| T-017 | 性能基准（真实 view/open/decorate/key/save/RSS） | todo | T-014 | none | T-014 后 |
| T-018 | 浏览器 E2E（fake dialog）+ Rust 集成 | todo | T-012/T-015/T-016 | none | 保存/命令/主题后 |
| T-019 | CI 质量门（ubuntu/macOS/Windows） | todo | T-001~T-018 | none | 全部任务后 |
| T-020 | ADR / 蓝图偏差 / 交接 | todo | T-019 | none | 最后 |

状态值只允许：`todo`、`in_progress`、`blocked`、`done`、`skipped`。

---

## 5. 交付物清单

| 类型 | 路径/对象 | 预期变更 | 状态 | 证据 |
|---|---|---|---|---|
| Code | `apps/desktop/**` | 新增 | partial（T-001 壳） | C-021 |
| Code | `packages/shared/**` | 新增（DTO/常量） | partial（常量） | C-017 |
| Code | `packages/editor-core/**` | 新增（CM6/Live Preview/主题） | partial（mode 契约） | C-017 |
| Code | `packages/ui/**` | 新增（token/原语） | partial（`cx`） | C-017 |
| Code | `src-tauri/**` | 新增（命令/服务/状态/契约） | partial（空壳） | C-013/C-021 |
| Test | `src-tauri/tests/**` | 新增（契约/读写/冲突） | todo | none |
| Test | `apps/desktop/**/*.test.*`、`e2e/**` | 新增 | partial（smoke） | C-017 |
| Config | localStorage `qingmo.ui.theme` | 新增（默认 `system`，Q-005 已确认） | todo | none |
| Config | `src-tauri/capabilities/default.json` | 新增（最小权限） | todo | none |
| Doc | `docs/adr/0001~0003` | 新增 | todo | none |
| Doc | `README.md` 状态段落 | 修改 | done（T-001） | 本文件 §0/§1 |

> **数据表：P1 不新增任何数据表。** 唯一新增持久化键为 `qingmo.ui.theme`，见 §6.2 与 Q-005。

---

## 6. 数据模型 / 配置 / 接口

### 6.1 数据模型

P1 无数据库。跨 IPC 的 DTO（Rust 为源，`ts-rs` 生成 TS）：

```rust
FilePayload {
  doc_token: String, path: String, text: String,  // text 永远 LF-only
  format: TextFormat { encoding, has_bom, eol },
  mixed_eol: bool, hash: String, size: u64, text_units: u64,
  mtime_ms: i64, read_only: bool, read_only_reason: Option<ReadOnlyReason>,
}

SaveRequest { doc_token: String, text: String, expected_current_hash: Option<String> }
SaveResult { hash: String, size: u64, mtime_ms: i64 }
ConflictDetails { current_hash: String, current_mtime_ms: i64, current_size: u64 }
AppError { code: AppErrorCode, message: String, details: Option<Value> }
```

> encoding/BOM/EOL/baseHash 由 Rust `DocumentRegistry` 持有；前端只拿 `docToken` 和展示镜像。`docToken` 是 IPC 句柄，不是文档身份（身份=canonical path）。

### 6.2 配置项

| 配置项 | 环境变量 | 默认值 | 行为 | 兼容性 |
|---|---|---|---|---|
| `qingmo.ui.theme`（localStorage） | 无 | `system` | light/dark/system；非法值回退 system | 新增；P2 引入 settings 时迁移并删除，避免双源（Q-005） |
| `AUTOSAVE_DEBOUNCE_MS` | 无 | 800 | 自动保存去抖 | 工程常量，非用户配置（Q-006） |
| `AUTOSAVE_MAX_WAIT_MS` | 无 | 5000 | 自动保存最大延迟 | 工程常量（Q-006） |
| `LP_MAX_UNITS` | 无 | 2,000,000 | 超过则关闭 Live Preview | 工程常量（Q-006） |
| `MAX_FILE_BYTES` | 无 | `10*1024*1024` | 读写两侧超过则拒绝 | **Rust 唯一权威**；TS 不复制，错误由 `FILE_TOO_LARGE` 返回（Q-002） |
| `SYNTAX_TREE_BUDGET_MS` | 无 | 8 | 单次 update 解析预算 | 工程常量（Q-006） |
| `MAX_LINE_UNITS` | 无 | 10,000 | 超长单行跳过 replace | 工程常量（Q-006） |

### 6.3 API / 对外接口

| 接口 | 变更 | 兼容性 | 验证 |
|---|---|---|---|
| `invoke("document_open")` -> `FilePayload` | 新增 | 新应用，无旧行为 | 契约测试 + Rust 集成 |
| `invoke("document_reload", { docToken })` -> `FilePayload` | 新增 | 新应用 | 契约测试 + Rust 集成 |
| `invoke("document_write_atomic", SaveRequest)` -> `SaveResult` | 新增 | 新应用；字段只增不改 | 契约测试 + 原子写/冲突测试 |
| `invoke("app_close_confirm", { allow })` -> `null` | 新增 | 新应用 | CloseGuard 集成 |
| event `app://close-requested` `{reason}` | 新增 | 新应用 | 契约测试 + E2E |

P1 只有 1 个自定义事件；关闭不再使用前端 `onCloseRequested` 作为主路径。

---

## 7. 验收标准

| AC-ID | 验收项 | 覆盖任务 | 验证命令/证据 | Status |
|---|---|---|---|---|
| AC-001 | 启动与空窗口 | T-001/T-002 | C-021/C-024/C-027：dev 与生产二进制均渲染；控制台 0 error | PASS |
| AC-002 | 打开/编辑/保存闭环 | T-008~T-012 | 打开闭环已由 C-061~C-065 在真实 Tauri 验证；编辑/保存待 T-010~T-012 | partial |
| AC-003 | 原子写无半写 | T-006 | C-045/C-047：temp+fsync+rename；EACCES 保留旧文件；SIGKILL 后目标不变；ENOSPC 未在本机模拟 | partial |
| AC-004 | 自动保存状态机 | T-011 | Vitest fake timers | todo |
| AC-005 | 冲突不静默覆盖（含二次冲突） | T-006/T-012 | C-046：always-hash、CONFLICT details、expectedCurrentHash、二次冲突、只读/缺失 | PASS |
| AC-006 | 10MiB 可编辑/降级 | T-014 | bench + 手动（5MB/10MiB） | todo |
| AC-007 | Live Preview 正确（多选区/IME） | T-013 | 快照测试 + 手动 | todo |
| AC-008 | 安全边界（无 fs/shell/http、CSP、token） | T-002/T-005 | C-026 + C-037：最小权限、严格 CSP、token 伪造/过期、符号链接替换 | PASS |
| AC-009 | 契约不漂移 | T-003/T-019 | C-028/C-029/C-030：命令/权限/DTO/生成文件已覆盖；六方完整版待 T-019 | partial |
| AC-010 | 主题切换不重建 view | T-016 | token 已就绪（C-035）；主题服务/CM6 Compartment 待 T-016 | partial |
| AC-011 | i18n 无硬编码 | T-004 | C-032/C-033：key 对齐 + 13 个错误码文案 + 无 raw key | PASS |
| AC-012 | 浏览器 E2E 可跑（fake dialog） | T-007/T-018 | C-052：FakeIpc/FakePlatform 已可驱动打开/保存/冲突/关闭；Playwright 待 T-018 | partial |
| AC-013 | 命令注册表/面板/快捷键 | T-004/T-015 | C-032：Registry 核心 7 条测试；面板/快捷键待 T-015 | partial |
| AC-014 | 性能基线 | T-017 | `pnpm bench`（open/decorate/key p95/save/RSS） | todo |
| AC-015 | 关闭守卫（红叉/Cmd+Q） | T-012 | CloseGuard 集成 + 手动 | todo |

---

## 8. 验证入口

每个任务执行前必须先完成 `01` 对应任务的 Pre-Implementation Check；完成后运行：

```bash
# 单任务最小验证（示例：T-005）
cargo test --manifest-path src-tauri/Cargo.toml --test document_open

# 前端单任务（示例：T-011）
pnpm vitest run apps/desktop/src/features/editor/save/SaveCoordinator.test.ts

# 最终全量验证（T-019）
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm format:check && pnpm depcruise
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e
pnpm bench
```

| C-ID | Command | 何时运行 | 预期 |
|---|---|---|---|
| C-001 | `shasum -a 256` 6 个基线文件（命令见 `02 §4`） | 方案基线（已运行） | 记录哈希 |
| C-002 | `git rev-parse HEAD` | 方案基线（已运行） | 预期失败：not a git repository |
| C-003 | `find . -maxdepth 3 -type f \| sort` | 方案基线（已运行） | 仅文档 |
| C-004 | `rustc/cargo/node/pnpm --version` | 方案基线（已运行） | 记录版本 |
| C-005 | `npm view ...` | 方案基线（已运行） | 记录候选版本 |
| C-006 | `cargo info ...` / `cargo search ...` | 方案基线（已运行） | 记录候选版本 |
| C-007 | `gitnexus analyze`（参考项目） | 方案基线（已运行） | 记录调用边 |
| C-008 | `git diff 0571bc2..HEAD -- ...` | 方案基线（已运行） | 无输出 |
| C-009 | DeepWiki 查询 | 方案基线（已运行） | 记录摘要 |
| C-010 | Exa 查询 | 方案基线（已运行） | 记录摘要 |
| C-011 | `pnpm install` -> `pnpm install --frozen-lockfile` | T-001（已运行） | PASS |
| C-012 | `pnpm typecheck && pnpm lint` | 每个前端任务后（T-001 已运行） | PASS |
| C-013 | `cargo check --manifest-path src-tauri/Cargo.toml` | T-001 后（已运行） | PASS |
| C-014 | `cargo test --manifest-path src-tauri/Cargo.toml --test commands_contract` | T-003/T-019 | PASS |
| C-015 | `cargo test --manifest-path src-tauri/Cargo.toml --test document_open` | T-005 | PASS |
| C-016 | `cargo test --manifest-path src-tauri/Cargo.toml --test atomic_writer` / `--test conflict` | T-006 | PASS |
| C-017 | `pnpm test` | 每个前端任务后（T-001 已运行） | PASS |
| C-018 | `pnpm test:e2e` | T-018/T-019 | SKIPPED |
| C-019 | `pnpm bench` | T-017 | SKIPPED |
| C-020 | `pnpm build` | T-001（已运行） | PASS |
| C-021 | `pnpm tauri dev` | T-001/T-002（T-001 已运行） | PASS（手动） |
| C-022 | `cargo fmt --check` / `pnpm format:check` | T-001（已运行） | PASS |
| C-023 | `git tag --list` | T-001（已运行） | `p0-docs-baseline`、`p1-baseline` |
| C-024 | `pnpm tauri build --debug` | T-002/T-019 | PASS（单平台） |
| C-025 | `gitnexus analyze --skip-agents-md` | T-001（已运行）/T-006 后 | 1,011 nodes / 1,804 edges；直接边已记录 |
| C-052 | `pnpm vitest run apps/desktop/src/lib` | T-007（已运行） | PASS：28 条端口/fake 测试 |
| C-053 | `pnpm depcruise` | T-007（已运行） | PASS：Tauri import 仅两个 adapter |
| C-057 | `gitnexus analyze --skip-agents-md` | T-007（已运行） | 1,229 nodes / 2,462 edges；`invokeCommand` 4 incoming methods |
| C-066 | `gitnexus analyze --skip-agents-md` | T-008（已运行） | 1,358 nodes / 2,875 edges；`WorkspaceLayout` 唯一注册链入图 |
| C-070 | `gitnexus analyze --skip-agents-md` | T-009（已运行） | 1,397 nodes / 2,949 edges；`EditorSession -> createEditorState` 入图 |
| C-067~C-070 | editor-core 测试 + 全量门禁 + chunk 检查 | T-009（已运行） | PASS：78 测试；79 modules / 171 deps；最大 chunk 366.61KB |
| C-071~C-075 | binding 测试 + 全量门禁 + 真实输入/只读 | T-010（已运行） | PASS：85 测试；83 modules / 185 deps；StrictMode 单 view、节流、只读 |
| C-058~C-066 | Vitest + 全量门禁 + 原生 dialog 打开 README/small/large/MDX + Cancel | T-008（已运行） | PASS：66 测试；72 modules / 158 deps；打开/取消/只读均验证 |
| C-999 | 上述全量命令 + 三平台 CI | 全部任务后 | SKIPPED |

---

## 9. 风险与回滚摘要

| RK-ID | 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|---|
| RK-001 | 10MiB 文档卡顿 | 高 | LP 阈值、无全量解析、bench | 降低上限/关闭 LP |
| RK-002 | WebView/IME 差异 | 高 | composition map/源码行、三平台手动 | 关闭 LP |
| RK-003 | 原子写元数据丢失 | 中 | crate + 权限测试 + 已知限制 | 改用手写 writer |
| RK-004 | 冲突残余 TOCTOU | 中 | 总是 hash + expectedCurrentHash；P2 watcher | 强制保存前再 hash |
| RK-005 | 编码误判/丢字 | 高 | UTF-8/UTF-16 BOM；UTF-32/NUL 拒绝 | 只读打开 |
| RK-006 | capability 配置错误 | 高 | 最小 core + AppManifest + 契约/负例 | 收紧白名单 |
| RK-007 | React 逐键渲染 | 中 | 外部 store/不可变快照；无正文 state | 移除订阅 |
| RK-008 | 契约漂移 | 中 | 六方契约 + 生成文件检查 | 回退命令表 |
| RK-009 | 自动保存风暴 | 中 | 单飞/分类退避/最多 5 次/clean 判断 | 禁用自动保存 |
| RK-010 | 关闭丢内容 | 高 | CloseGuard + flush 循环 + 确认 | 阻止关闭 |
| RK-011 | 版本不兼容 | 中 | T-001 已锁版本（Node 26.12.1/Rust 1.91.1）+ 启动冒烟 | 回退 `p1-baseline`/版本集 |
| RK-012 | 过早抽象 | 低 | 只建 3 包；P1 不抽 PathPolicy trait | 删除空包 |
| RK-013 | token 生命周期/伪造 | 中 | 单文档 token；open 替换；伪造/过期测试 | 重新打开文件 |

回滚总原则：P1 无数据库/schema 迁移；回滚=回到 `p1-baseline` commit/tag、清理 `qingmo.ui.theme`。**用户文件写入不可逆**，代码回滚不能撤销错误保存；事故时先停写、备份、再从备份恢复。详见 `03 §5`。

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [`00-使用说明.md`](00-使用说明.md) | 本目录执行协议、Q 项审批门、证据规范 |
| [`01-实施计划.md`](01-实施计划.md) | T-001~T-020 任务、文件范围、依赖、验证 |
| [`02-实施状态与验证.md`](02-实施状态与验证.md) | 预实施证据 E-001~、命令 C-001~、验收覆盖、VERDICT |
| [`03-复盘与交接.md`](03-复盘与交接.md) | 决策、踩坑、回滚、维护、NEXT-001~010 |
| [`04-设计方案.md`](04-设计方案.md) | 架构、算法、状态机、安全边界、方案对比 |
| [`05-多轮评审记录.md`](05-多轮评审记录.md) | R1 架构 / R2 安全性能 / R3 测试交付复审 |

---

## 11. 变更日志

| 时间 | 变更 | 作者/Agent | 证据 |
|---|---|---|---|
| 2026-10-26T11:00:00+08:00 | 创建实施控制台（方案阶段，未开始编码） | OpenCode / DeepSeek V4.1 | 文档基线 SHA-256 见 `04 §20.1` |
| 2026-10-26T11:30:00+08:00 | 补充调研/调用链证据摘要与 Q 项门禁 | OpenCode / DeepSeek V4.1 | `01 §2–3`、`02 E-001~E-010` |
| 2026-10-26T12:40:00+08:00 | v1.1：同步 R1/R2/R3 回改（token/CloseGuard/LF wire/任务依赖/AC-013~015/Q-013~015/C-ID） | OpenCode / DeepSeek V4.1 | `05`、`01 §14` |
| 2026-10-26T11:35:00+08:00 | Q-001~Q-015 全部按推荐确认；解除 T-001 门禁 | OpenCode / DeepSeek V4.1 | `01 §12`、`02 E-011/B-005` |
| 2026-10-26T13:02:00+08:00 | T-001 完成：workspace/Vite/React/TS/Tauri 骨架、双基线 tag、质量命令全绿、GitNexus 直接边复核 | OpenCode / DeepSeek V4.1 | `02 §3/C-011~C-013/C-017/C-020~C-023/C-025`；`01 §6` |
| 2026-10-26T13:10:00+08:00 | T-002 完成：窗口 label/CSP/assetProtocol/最小 core 权限 + 3 条配置测试；dev 与生产二进制均冒烟 | OpenCode / DeepSeek V4.1 | `02 §3/C-024/C-026/C-027`；`01 §6` |
| 2026-10-26T13:25:00+08:00 | T-003 完成：DTO/错误/4 命令 + 1 事件/stub/ts-rs；Rust 6 条、TS 4 条契约测试通过 | OpenCode / DeepSeek V4.1 | `02 §3/C-014/C-028~C-031`；`01 §6` |
| 2026-10-26T13:35:00+08:00 | T-004 完成：UI token/App Shell/i18n/状态栏/CommandRegistry；21 条 TS 测试、生产预览与 Tauri 窗口冒烟 | OpenCode / DeepSeek V4.1 | `02 §3/C-032~C-036`；`01 §6` |
| 2026-10-26T14:05:00+08:00 | T-005 完成：Rust dialog/DocumentRegistry、严格编码/EOL/10MiB、token 边界；31 条 Rust 测试与原生 dialog 手动读取 | OpenCode / DeepSeek V4.1 | `02 §3/C-037~C-044`；`01 §6` |
| 2026-10-26T14:25:00+08:00 | T-006 完成：原子写/冲突/UTF-16 字节级保存；atomic_writer 10 + conflict 7 + 全量 52 测试；SIGKILL 故障注入通过 | OpenCode / DeepSeek V4.1 | `02 §3/C-045~C-050`；`01 §6` |
| 2026-10-26T14:35:00+08:00 | T-007 完成：IpcPort/PlatformPort/错误归一化/fake adapter；28 条端口测试 + depcruise 0 violations + 越界探针 | OpenCode / DeepSeek V4.1 | `02 §3/C-052~C-057`；`01 §6` |
| 2026-10-26T15:08:00+08:00 | T-008 完成：文档会话/打开流程/CM6 EditorState；66 条 TS 测试 + 真实 dialog 打开 README/18KB/1.0MB/MDX + 取消 | OpenCode / DeepSeek V4.1 | `02 §3/C-058~C-066`；`01 §6` |
