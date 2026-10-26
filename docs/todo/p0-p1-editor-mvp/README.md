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
status: "partial"                 # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "none"              # 当前应执行的任务；无则写 none
last_completed_task: "T-020"      # 最近完成任务；无则写 none
next_action: "T-020 已完成（2026-10-26 20:05，20/20）；P1 代码冻结。首次 push 后复核 GitHub Actions 四 job、配置分支保护；P2 从 03 §8 开始"
verification_status: "partial"    # not_run | pass | fail | partial | skipped（T-001~T-020 本地门禁 PASS；远端 CI/平台真机残余）
research_status: "pass"           # not_run | pass | partial | skipped
call_chain_status: "partial"      # not_run | pass | partial | skipped（打开/保存 UI/关闭/LP/大文件/主题/面板/bench/E2E 链已索引；仅 Tauri invoke、hook 内部闭包、registry 字符串命令、Playwright 运行时、Rust example 跨 crate 调用与 CM6 facet 内部调度不展开）
code_calibration_status: "pass"   # not_run | pass | fail | partial | skipped（T-001~T-020 后已重新校准）
last_verification_command: "pnpm ci:local && actionlint .github/workflows/ci.yml && pnpm tauri build --debug"
last_updated: "2026-10-26T20:05:00+08:00"
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

Qingmo 已从纯文档阶段进入实施：`T-001` 建立了 pnpm workspace + Vite 7/React 19/TS 5 + Tauri 2 骨架与双基线 tag；`T-002` 收紧权限/CSP；`T-003` 冻结 IPC 契约；`T-004` 落地 UI token、App Shell、i18n、状态栏与 CommandRegistry；`T-005` 打通 Rust 原生 dialog、token 边界、严格编码/EOL 与 10MiB 读取；`T-006` 建立原子写、always-hash 冲突与字节级 UTF-16 保存；`T-007` 建立可测试的 IpcPort/PlatformPort 与浏览器 fake adapter；`T-008` 打通欢迎页→原生 dialog→CM6 `EditorState` 的打开流程；`T-009` 建立 Markdown/语言/Compartment 的唯一编辑组合；`T-010` 接入唯一 `EditorView` 与节流状态栏；`T-011` 建立 SaveCoordinator（去抖/单飞/flush/冲突暂停/退避）并接入每文档实例；`T-012` 接入 `file.save`、冲突横幅/二次确认、状态栏重试、switch/blur/close flush 与 Rust CloseGuard（含 macOS Cmd+Q）；`T-013` 建立视口级 Live Preview（标题/强调/行内代码/链接/引用/列表/代码块）、所有选区行源码显隐、IME map 与 2M/超长行/8ms 预算；`T-014` 对 2,000,000 UTF-16 单元以上文档默认关闭 LP，增加 `largeFile`/`livePreview` 会话状态、状态栏“大文档 · 预览关闭”与 `view.toggleLivePreview`，真实验证 5MB/10MiB 打开、10MiB-1 编辑保存到精确 10MiB、10MiB+1 写入拒绝；`T-016` 建立 `uiStore` 主题 slice、`qingmo.ui.theme` 持久化、根 `data-theme`、system `matchMedia`、light/dark 缓存主题扩展与 `view.toggleTheme`，验证切换不重建 view、撤销保留，浏览器验证 light/dark、刷新持久化与 system 跟随；`T-015` 建立 registry 驱动的命令面板与唯一全局 `keydown` 分发，`Mod+K` 打开、四个命令展示/执行、过滤/回车/Esc/焦点恢复，真实验证 4 命令、保存、主题、原生 dialog、预览开关与撤销保留。`T-017` 建立确定性 10KiB/1MiB/10MiB fixtures、Node/jsdom 与真实 Rust `AtomicWriter` 基准、`pnpm bench` 编排和真实 Tauri AX/RSS 记录，实测 Node open p50 1.103/2.812/25.9ms、Rust save p50 4.9/5.978/20.31ms、Tauri open 上界 328.3/304.7/853.2ms、RSS 171.1/175.4/250.1MB，10MiB LP 关闭。`T-018` 建立 Playwright 4 spec/13 条 E2E、seeded FakeIpc/FakePlatform bridge、Rust 跨格式 round-trip/10MiB 与命令级冲突集成，并完成真实 Tauri 主题、macOS 拼音“你好”、Cmd+S、冲突横幅与关闭守卫手动冒烟；生产构建已确认排除 e2e bridge。`T-019` 建立四 job GitHub Actions（Ubuntu web/E2E、Ubuntu contract/generated/negative、macOS fmt/clippy/test/debug build、Windows compile-only）、本地 `ci:*` 门禁、ts-rs 生成检查与契约/能力负例；本机通过 actionlint、`pnpm ci:local`、Ubuntu 24.04 容器与 macOS debug bundle，但远端 runner 尚未首次运行。`T-020` 完成 4 个实施级 ADR（MVP 边界、单一保存、IPC 契约、路径 token/CloseGuard）、`03 §7.1` 蓝图偏差、`03 §8.1` P2 前置与最终交接。当前 `20/20` 任务完成，P1 代码冻结；最终 `VERDICT: PARTIAL` 仅因远端 GitHub Actions/Windows runner 未首次运行与 Windows/Linux 真机/ENOSPC 未覆盖。

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 建立可启动的 Tauri 2 + React + Vite + CM6 工程 | `pnpm tauri dev` + 三平台 `cargo check` | PASS（T-001 启动；T-009/T-010 CM6 已接入） |
| R-002 | 打开 `.md/.markdown`；`.mdx` 只读 | Rust 侧 dialog + `docToken`；文件信息正确 | PASS（C-037~C-044/C-061~C-065） |
| R-003 | CM6 `EditorState` 是唯一文档真源 | 代码审查 + store 形状测试 | PASS（T-008~T-010） |
| R-004 | 最小 Live Preview（标题/强调/行内代码/链接/引用/列表） | 装饰快照 + 1MB 手动 | PASS（C-088/C-090/C-091） |
| R-005 | 唯一原子保存通道（手动/自动共用） | Rust 单测 + 断电模拟 | PASS（C-045~C-050/C-076/C-081） |
| R-006 | 自动保存：800ms 去抖、5s 上限、单飞、flush 循环、退避 | Vitest fake timers | PASS（C-076/C-078/C-079） |
| R-007 | 冲突检测：外部修改不静默覆盖；精确 hash 覆盖 | Rust 集成 + E2E | PASS（C-046/C-076/C-083/C-109/C-110） |
| R-008 | 大文件退化：10MiB 可编辑；>2M units 关 LP；>10MiB 拒绝 | C-093/C-095/C-105/C-107 | PASS |
| R-009 | 命令注册表 + 命令面板 + 快捷键单一来源 | C-101 33 条定向测试 + C-103 真实 Tauri | PASS |
| R-010 | light/dark/system 主题不重建 EditorView | C-097/C-099 组件/撤销/浏览器 | PASS |
| R-011 | zh-CN 默认、en 回退；错误码有文案 | key 对齐测试 | PASS（C-032/C-033） |
| R-012 | 无 fs/shell/http 插件；CSP；Rust dialog + token | 契约 + 负例测试 | PASS（C-026/C-037/C-053） |
| R-013 | 命令名/事件名/能力/DTO 契约锁定 | 六方契约测试 + ts-rs 校验 | todo |
| R-014 | Rust/TS/浏览器 E2E/Tauri 冒烟可验证 | 测试命令全绿 | todo |
| R-015 | 10KB/1MB/10MiB 性能基线只记录不宣称 | C-105 自动基准 + C-107 真实 Tauri | PASS |

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
| subagent/GitNexus 调用链分析 | partial | `01-实施计划.md §3`；`02 E-006/E-007/E-012~E-024/C-051/C-057/C-066/C-070/C-075/C-080/C-087/C-092/C-096/C-100/C-104/C-108/C-114`；`05` | Qingmo 已索引 2,517 nodes/6,318 edges（`86271ff`）；骨架、读写、`invokeCommand -> normalizeError`、`WorkspaceLayout -> useCloseGuard/CommandRegistry.register/useCommandKeybindings/CommandPalette`、`EditorSession -> createEditorState -> livePreview`、`EditorSession.toggleLivePreview -> publish`、`WorkspaceLayout -> useThemeService -> applyTheme -> themeExtension`、`useThemeCommand -> registerThemeCommand`、`CommandPalette -> formatKeybinding/execute`、`DocumentEditor -> ConflictBanner`、`run -> request_close`、`DocumentSessionProvider.setSession -> SaveCoordinator`、`buildLivePreviewDecorations -> collectDecorationSpecs`、`run.mjs -> generateFixtures`、`measureOpen -> EditorSession`、`measureSave -> FakeIpc/EditorSession`、`openApp/openSeededFile -> spec`、`mock_webview -> conflict_integration` 与双 adapter 选择已验证；仅动态 invoke、hook 内部闭包、registry 字符串命令、Playwright 运行时、Rust example 跨 crate 调用与 CM6 facet 内部调度不展开；参考项目 `call -> rawInvoke` 仅作方法参考 |
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
| T-011 | `SaveCoordinator` + flush 循环 + 错误分类 | done | T-010 | C-076~C-080 | T-012 |
| T-012 | 保存 UI + 冲突横幅 + Rust CloseGuard | done | T-011/T-004/T-007 | C-081~C-087 | T-013 |
| T-013 | Live Preview v1（ViewPlugin + Lezer + 多选区/IME） | done | T-010/T-004 | C-088~C-092 | T-014 |
| T-014 | 大文件降级 + IME 守卫 + 阈值提示 + LP 命令 | done | T-012/T-013 | C-093~C-096 | T-016 |
| T-015 | 命令面板 + 快捷键（不新增命令） | done | T-012/T-013/T-016 | C-101~C-104 | T-017 |
| T-016 | 主题：CSS 变量 + Compartment + uiStore + theme 命令 | done | T-004/T-009/T-010 | C-097~C-100 | T-015 |
| T-017 | 性能基准（真实 view/open/decorate/key/save/RSS） | done | T-014 | C-105~C-108 | T-018 |
| T-018 | 浏览器 E2E（fake dialog）+ Rust 集成 | done | T-012/T-015/T-016 | C-109~C-114 | T-019 |
| T-019 | CI 质量门（ubuntu/macOS/Windows） | done | T-001~T-018 | C-115~C-119 | T-020 |
| T-020 | ADR / 蓝图偏差 / 交接 | done | T-019 | C-120~C-124 | P2（首次 push 后复核 CI） |

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
| AC-002 | 打开/编辑/保存闭环 | T-008~T-012 | C-061~C-065/C-073/C-079/C-081~C-085：打开/编辑/自动/手动保存/冲突/关闭闭环 | PASS |
| AC-003 | 原子写无半写 | T-006 | C-045/C-047：temp+fsync+rename；EACCES 保留旧文件；SIGKILL 后目标不变；ENOSPC 未在本机模拟 | partial |
| AC-004 | 自动保存状态机 | T-011 | C-076/C-078/C-079：去抖/5s/单飞/退避/终态/只读 + 真实自动保存 | PASS |
| AC-005 | 冲突不静默覆盖（含二次冲突） | T-006/T-011/T-012 | C-046：always-hash/二次冲突；C-083：横幅/二次确认/精确 hash 覆盖；C-084：关闭不覆盖磁盘 | PASS |
| AC-006 | 10MiB 可编辑/降级 | T-014 | C-093/C-095/C-105/C-107：5MB/10MiB 降级、10MiB-1 保存到精确 10MiB、10MiB+1 拒绝、状态徽标；open 上界 853ms、RSS 250MB | PASS |
| AC-007 | Live Preview 正确（多选区/IME） | T-013 | C-088/C-090/C-091：13 条 LP 测试（多选区/跨行/IME map/2M）+ 真实样式/选区显隐/1MB 滚动输入 | PASS |
| AC-008 | 安全边界（无 fs/shell/http、CSP、token） | T-002/T-005 | C-026 + C-037：最小权限、严格 CSP、token 伪造/过期、符号链接替换 | PASS |
| AC-009 | 契约不漂移 | T-003/T-019 | C-028/C-029/C-030/C-031 + C-117：契约 6 + 安全配置 3 + generated + 负例在 Ubuntu 容器通过 | PASS |
| AC-016 | 实施边界可交接 | T-020 | C-120/C-124：4 个 ADR、13 个 Markdown 0 断链、20/20 required；P2 前置 6 项 | PASS |
| AC-010 | 主题切换不重建 view | T-016 | C-097：dark facet/view 身份/undo；C-099：light/dark 背景、刷新持久化、system 跟随；C-103：真实 Tauri Mod+Shift+L 后正文/光标/撤销保留 | PASS |
| AC-011 | i18n 无硬编码 | T-004 | C-032/C-033：key 对齐 + 13 个错误码文案 + 无 raw key | PASS |
| AC-012 | 浏览器 E2E 可跑（fake dialog） | T-007/T-018 | C-109：4 spec/13 条（打开/编辑/保存/冲突/主题/面板/关闭/IME）；C-113 生产排除 bridge | PASS |
| AC-013 | 命令注册表/面板/快捷键 | T-004/T-015/T-018 | C-032/C-093/C-097/C-101/C-103；C-109 浏览器面板保存、主题切换保留 undo、焦点恢复 | PASS |
| AC-014 | 性能基线 | T-017 | C-105 自动基准（3 尺寸 × 6 指标）+ C-107 真实 Tauri open/save/RSS；10MiB decorate skipped 如实记录 | PASS |
| AC-015 | 关闭守卫（红叉/Cmd+Q） | T-012 | C-081/C-084~C-086：冲突确认/取消/仍要关闭、脏编辑红叉与 Cmd+Q 先 flush 后退出 | PASS |

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
| C-018 | `pnpm test:e2e` | T-018/T-019 | PASS（C-109：13/13） |
| C-019 | `pnpm bench` | T-017 | PASS（C-105） |
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
| C-075 | `gitnexus analyze --skip-agents-md` | T-010（已运行） | 1,477 nodes / 3,220 edges；`EditorPage -> EditorHost/useEditorStatus/useEditor` 入图 |
| C-071~C-075 | binding 测试 + 全量门禁 + 真实输入/只读 | T-010（已运行） | PASS：85 测试；83 modules / 185 deps；StrictMode 单 view、节流、只读 |
| C-080 | `gitnexus analyze --skip-agents-md` | T-011（已运行） | 1,691 nodes / 4,210 edges；`DocumentSessionProvider.setSession -> SaveCoordinator` 入图 |
| C-076~C-080 | 协调器测试 + 覆盖率 + 全量门禁 + 真实自动保存/冲突 + GitNexus | T-011（已运行） | PASS：101 测试；86 modules / 204 deps；83.6% lines；等待保存→已同步、冲突不覆盖 |
| C-081~C-087 | 保存 UI/关闭守卫测试 + 全量门禁 + 真实冲突/关闭/Cmd+Q + GitNexus | T-012（已运行） | PASS：114 TS/54 Rust；92 modules / 233 deps；冲突二次确认、取消保留窗口、脏编辑/Cmd+Q 先落盘后退出 |
| C-087 | `gitnexus analyze --skip-agents-md` | T-012（已运行） | 1,795 nodes / 4,464 edges；`WorkspaceLayout -> useCloseGuard`、`run -> request_close`、`DocumentEditor -> ConflictBanner` 入图 |
| C-088~C-092 | LP 测试 + 全量门禁 + 真实 LP/1MB + GitNexus | T-013（已运行） | PASS：127 TS/54 Rust；98 modules / 244 deps；13 条 LP 测试；1.03MB 文档可滚动/输入/自动保存 |
| C-092 | `gitnexus analyze --skip-agents-md` | T-013（已运行） | 1,886 nodes / 4,740 edges；`EditorSession -> createEditorState -> livePreview`、`buildLivePreviewDecorations -> collectDecorationSpecs` 入图 |
| C-093~C-096 | 大文件/状态栏/打开流程测试 + 全量门禁 + 真实 5MB/10MiB + GitNexus | T-014（已运行） | PASS：136 TS/54 Rust；99 modules / 248 deps；2M/5MB/10MiB 降级；10MiB-1 保存到精确 10MiB、10MiB+1 被拒；1,920 nodes/4,877 edges |
| C-096 | `gitnexus analyze --skip-agents-md` | T-014（已运行） | 1,920 nodes / 4,877 edges；`EditorSession.toggleLivePreview -> publish -> sameCursor/sameSelection/flushStatus` 入图 |
| C-097~C-100 | 主题测试 + 全量门禁 + 浏览器视觉/持久化 + GitNexus | T-016（已运行） | PASS：144 TS/54 Rust；105 modules / 267 deps；light/dark、刷新持久化、system 跟随；2,052 nodes/5,281 edges |
| C-100 | `gitnexus analyze --skip-agents-md` | T-016（已运行） | 2,052 nodes / 5,281 edges；`WorkspaceLayout -> useThemeService -> applyTheme -> themeExtension`、`useThemeCommand -> registerThemeCommand` 入图 |
| C-101~C-104 | 面板/快捷键测试 + 全量门禁 + 真实 Tauri + GitNexus | T-015（已运行） | PASS：33 定向测试；168 TS/54 Rust；109 modules/287 deps；4 命令/Mod+K/Mod+S/Mod+Shift+L/Mod+O/焦点/撤销；2,108 nodes/5,426 edges |
| C-105~C-108 | 自动基准 + 全量门禁 + 真实 Tauri open/save/RSS + GitNexus | T-017（已运行） | PASS：3 尺寸 × 6 指标；168 TS/54 Rust；109 modules/287 deps；Tauri open 328.3/304.7/853.2ms、RSS 171.1/175.4/250.1MB；2,381 nodes/6,037 edges |
| C-109~C-114 | Playwright E2E + Rust 集成 + 全量门禁 + 真实 IME/关闭冒烟 + tree-shake + GitNexus | T-018（已运行） | PASS：E2E 13/13；Rust 59/59；168 TS；110 modules/293 deps；生产无 e2e bridge；2,517 nodes/6,318 edges |
| C-115~C-119 | actionlint + `pnpm ci:local` + Ubuntu 容器 + macOS debug build + GitNexus | T-019（已运行） | PASS：四 job workflow；E2E 13/13、Rust 59、168 TS；Ubuntu 契约 6 + 安全 3 + Linux clippy；Qingmo.app 32.90MiB/dmg 10.34MiB；2,521 nodes/6,322 edges；远端 runner 未首次运行 |
| C-120~C-124 | 链接/ID 检查 + `pnpm ci:local` + actionlint/格式 + GitNexus + ADR 评审 | T-020（已运行） | PASS：13 个 Markdown 0 断链；4/4 ADR；TS 23/168、Rust 59、E2E 13；20/20 required；P2 前置/首次 push 清单齐全 |
| C-058~C-066 | Vitest + 全量门禁 + 原生 dialog 打开 README/small/large/MDX + Cancel | T-008（已运行） | PASS：66 测试；72 modules / 158 deps；打开/取消/只读均验证 |
| C-999 | 上述全量命令 + 三平台 CI | 全部任务后 | PARTIAL（本地 C-121 全绿；GitHub Actions 四 job/Windows `cargo check` 未首次运行） |

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
| 2026-10-26T15:36:00+08:00 | T-009 完成：唯一 `createEditorState`、8 语言、3 Compartment、分包；78 条 TS 测试、构建无告警 | OpenCode / DeepSeek V4.1 | `02 §3/C-067~C-070`；`01 §6` |
| 2026-10-26T15:46:00+08:00 | T-010 完成：唯一 EditorView、节流状态栏、真实输入/只读验证；85 条 TS 测试 | OpenCode / DeepSeek V4.1 | `02 §3/C-071~C-075`；`01 §6` |
| 2026-10-26T16:02:00+08:00 | T-011 完成：SaveCoordinator（800ms/5s/单飞/flush/冲突暂停/退避）、每文档实例；101 条 TS 测试；真实等待保存→已同步、冲突不覆盖 | OpenCode / DeepSeek V4.1 | `02 §3/C-076~C-080`；`01 §6` |
| 2026-10-26T16:30:00+08:00 | T-012 完成：保存 UI/冲突二次确认/`file.save`/switch/blur/close flush/Rust CloseGuard；114 TS/54 Rust；红叉取消/仍要关闭、脏编辑与 Cmd+Q 先落盘后退出 | OpenCode / DeepSeek V4.1 | `02 §3/C-081~C-087`；`01 §6` |
| 2026-10-26T17:00:00+08:00 | T-013 完成：视口 Live Preview、所有选区行显隐、IME map、2M/超长行/8ms 预算；127 TS/54 Rust；真实样式/选区/多行引用/1.03MB 滚动输入 | OpenCode / DeepSeek V4.1 | `02 §3/C-088~C-092`；`01 §6` |
| 2026-10-26T17:30:00+08:00 | T-014 完成：2M 单元以上 LP 降级、largeFile/livePreview、状态栏“大文档 · 预览关闭”、view.toggleLivePreview；136 TS/54 Rust；真实 5MB/10MiB 打开、10MiB-1 保存到精确 10MiB、10MiB+1 拒绝 | OpenCode / DeepSeek V4.1 | `02 §3/C-093~C-096`；`01 §6` |
| 2026-10-26T17:40:00+08:00 | T-016 完成：uiStore 主题 slice、qingmo.ui.theme、根 data-theme、system matchMedia、light/dark 缓存主题、view.toggleTheme；144 TS/54 Rust；浏览器 light/dark、刷新持久化、system 跟随 | OpenCode / DeepSeek V4.1 | `02 §3/C-097~C-100`；`01 §6` |
| 2026-10-26T18:40:00+08:00 | T-017 完成：确定性 10KiB/1MiB/10MiB fixtures、open/decorate/key/save 自动基准、真实 Rust AtomicWriter、pnpm bench 编排、Tauri AX/RSS；Tauri open 328.3/304.7/853.2ms、RSS 171.1/175.4/250.1MB | OpenCode / DeepSeek V4.1 | `02 §3/C-105~C-108`；`01 §6` |
| 2026-10-26T19:05:00+08:00 | T-018 完成：Playwright 4 spec/13 条、e2e bridge、Rust 跨格式 round-trip 与命令级冲突集成、真实 IME/关闭守卫冒烟；生产排除 bridge | OpenCode / DeepSeek V4.1 | `02 §3/C-109~C-114`；`01 §6` |
| 2026-10-26T19:35:00+08:00 | T-019 完成：四 job GitHub Actions、本地 `ci:*`、ts-rs 生成检查、契约/能力负例、Linux menu import 修复；actionlint/Ubuntu 容器/macOS debug build 通过，远端 runner 待首次运行 | OpenCode / DeepSeek V4.1 | `02 §3/C-115~C-119`；`01 §6` |
| 2026-10-26T20:05:00+08:00 | T-020 完成：4 个实施级 ADR、9 项蓝图偏差、6 项 P2 前置、最终 PARTIAL/交接；20/20 required，本地门禁全绿 | OpenCode / DeepSeek V4.1 | `02 §3/C-120~C-124`；`01 §6` |
| 2026-10-26T17:56:00+08:00 | T-015 完成：registry 命令面板、唯一全局 keydown、Mod+K/Mod+O/Mod+S/Mod+Shift+L、过滤/回车/Esc/焦点恢复；168 TS/54 Rust；真实 4 命令、保存、主题、dialog、预览与撤销 | OpenCode / DeepSeek V4.1 | `02 §3/C-101~C-104`；`01 §6` |
