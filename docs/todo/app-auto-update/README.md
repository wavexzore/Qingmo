# 应用自动更新（App Auto Update）

> **模板定位：** LLM 持续实施控制台
> **功能 ID：** `app-auto-update`
> **对应 SDD Spec：** 无（Qingmo 尚未接入 `.jssdd`）
> **对应需求：** `R-001 ~ R-012`（本文 §2.1）
> **功能分支：** `feat/app-auto-update`（建议；当前分析基线为 `main@7655d49`）
> **优先级：** P2（发布能力前置；蓝图 P4 的市场/灰度部分仍留在 P4）
> **负责人：** 维护者/发布负责人（Xcode 证书、updater key、`release` Environment 见 `03 §5/§6`）
> **最新代码校准日期：** 2026-10-27
> **设计基线：** [`04-设计方案.md`](04-设计方案.md) v1.2
> **计划基线：** [`01-实施计划.md`](01-实施计划.md) v1.2
> **评审记录：** [`05-多轮评审记录.md`](05-多轮评审记录.md)

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "app-auto-update"
feature_name: "应用自动更新"
status: "in_progress"             # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "T-014"             # 当前应执行的任务；无则写 none
last_completed_task: "T-011 (local release)" # 最近完成任务；无则写 none
next_action: "T-011 本地发布完成、GitHub Actions 路径停用；剩余 T-014 双架构真机安装冒烟"
verification_status: "partial"    # not_run | pass | fail | partial | skipped（本地全绿；真机未运行）
research_status: "pass"           # 官方文档、GitHub 实现、论文与标准已完成
call_chain_status: "pass"         # subagent + GitNexus 已完成；Tauri 宏/字符串 invoke 的图边界已记录
code_calibration_status: "pass"   # 基线 98c9c26，与 origin/main 一致；工作树变更已合入 main 工作区
last_verification_command: "node scripts/release/check-versions.mjs --expect 0.1.0; pnpm release:test; ./.release/release.sh --skip-build; actionlint .github/workflows/ci.yml .github/workflows/release.yml"
last_updated: "2026-10-27T22:20:02+08:00"
resume_from:
  - "README.md#0-LLM-STATE每轮实施前必须读取"
  - "01-实施计划.md#6-llm任务队列"
  - "02-实施状态与验证.md#3-执行日志"
  - "02-实施状态与验证.md#8-计划-vs-实际差异"
  - "05-多轮评审记录.md"
allowed_scope:
  - "src-tauri/**"
  - "apps/desktop/**"
  - "packages/shared/**"
  - "scripts/release/**"
  - "scripts/ci/**"
  - "package.json"
  - "src-tauri/Cargo.lock"
  - ".github/workflows/**"
  - "dependency-cruiser.config.cjs"
  - "docs/adr/**"
  - "docs/todo/app-auto-update/**"
  - "docs/BLUEPRINT.md（仅 §9.3/§9.4/§12 的更新器相关偏差）"
  - "docs/TOPOLOGY.md（仅更新链路拓扑）"
  - "README.md（仅状态/下一步段落）"
forbidden_scope:
  - "apps/desktop/src/features/editor/save/SaveCoordinator.ts（只复用，不修改保存状态机）"
  - "apps/desktop/src/app/useCloseGuard.ts（只复用；如需 `closing` 观察位，仅加只读布尔，不改 flush/confirm 顺序）"
  - "packages/editor-core/**"
  - "packages/ui/**（仅复用 Button/tokens，不修改）"
  - "docs/RESEARCH.md"
  - "任何 SQLite/数据库文件"
  - "任何 .env / credentials / secret / 私钥"
  - "任何对 main/master 的 force push"
stop_condition: "Q-001~Q-012 已确认（Q-011 随仅 macOS 标记 N/A）；所有 required=true 的 T-### 均为 done 且有证据；02 的 VERDICT: PASS"
blocker_policy: "遇到 blocked 时在 02 §7 记录 B-###、失败证据、已尝试方案和下一恢复动作；不得跳过依赖、静默改范围或未审批新增配置/数据表"
```

> **状态更新规则：** 每完成一个任务，必须同步更新本块的 `current_task`、`last_completed_task`、`next_action`、`verification_status`、`code_calibration_status`、`last_updated`，并回写 `01 §6` 与 `02 §2/§3`。

---

## 1. 一句话结论

自动更新方案已完成调研、调用链/拓扑分析和三轮评审。按 2026-10-27 的人工决策，MVP **仅支持 macOS universal**，使用 **Xcode 中的 Developer ID 证书签名 + Apple 公证**；技术方案采用 **Tauri 官方 `tauri-plugin-updater` 2.14.0 的 Rust API + Rust 单一更新状态机 + 前端 Port/Controller + 安装前复用 `SaveCoordinator.flush("close")`** 的最小安全切片。当前不新增用户配置、不新增数据表、不新增 localStorage 键；Windows/Linux 移入 `NEXT-AU-007`。

> **高保真原型：** [`prototype/index.html`](prototype/index.html)（13 个状态；命令面板、保存冲突、安装/错误、深浅色；纯静态、无网络/无存储）。

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 命令面板可手动检查更新，显示当前版本、最新版本、发布日期和发布说明 | 组件/E2E：`AC-001` | done |
| R-002 | 启动后静默检查一次；失败无感；发现更新用非模态横幅提示 | 单测/E2E：`AC-002` | done |
| R-003 | 下载显示累计进度与总大小；总大小未知时显示不确定进度；事件节流 | 单测/E2E：`AC-003` | done |
| R-004 | 安装前必须走现有 `SaveCoordinator.flush("close")`；冲突/终态错误阻止安装 | 单测/E2E：`AC-006`/`AC-007` | done |
| R-005 | 安装/重启不绕过 Rust `CloseGuard`；安装中忽略关闭请求；安装失败保留旧版本 | Rust/前端测试：`AC-008`/`AC-009` | done |
| R-006 | Rust 是更新生命周期唯一权威；单飞、状态机、稳定错误码；非法转换明确失败 | Rust 单测/契约：`AC-010` | done |
| R-007 | minisign 验签 + 签名版本绑定（`requireSignedVersion`）；只允许 HTTPS；不允许降级 | 配置测试/安装失败测试：`AC-004`/`AC-005` | done |
| R-008 | 不新增用户配置/数据表/localStorage 键；不授予 `updater:*` JS 权限；CSP 不变 | 安全配置测试/代码审查：`AC-011` | done |
| R-009 | 命令/事件/DTO/权限/生成类型继续单一源，契约测试防漂移 | `cargo test`/Vitest/负例：`AC-012` | done |
| R-010 | 版本单一源检查 + 签名发布流水线 + `latest.json` 平台键/签名版本门禁 | 发布脚本/CI：`AC-013`/`AC-014` | in_progress |
| R-011 | 可测试：Rust 状态机、前端 fake/controller/组件、浏览器 E2E 零真实网络 | 单测/E2E：`AC-015` | done |
| R-012 | ADR、蓝图偏差、回滚、密钥托管/轮换、交接文档齐全 | 文档评审：`AC-016` | done |

### 2.2 非目标

| 项 | 原因 | 后续处理 |
|---|---|---|
| 自动下载后静默安装/强制重启 | 可能丢未保存内容、破坏用户信任；MVP 只做“通知 + 用户确认” | 如需，先评审 `Q-003` |
| 自动回滚到上一版本 | Tauri updater 不支持跨版本自动回滚；安装失败只保证旧版本仍在（macOS 2.13.2 另有恢复） | 修正蓝图 §12；如必须，另立 `NEXT-AU-002` |
| stable/beta 双通道与灰度比例 | 静态 `latest.json` 不支持按比例灰度；双通道需要额外发布/配置决策 | `Q-005`/`NEXT-AU-002` |
| 用户可配置的自动检查/跳过版本/通道 | 当前无统一 settings，新增键会形成第二配置源，违反 ADR-0001/NEXT-006 | `Q-004`/`NEXT-006` |
| Windows/Linux 自动更新 | 2026-10-27 决策：MVP 仅 macOS；Windows NSIS 与 Linux AppImage 的签名/安装/平台键验证成本不进入首版 | `NEXT-AU-007` |
| 移动端自动更新 | App Store/Play 政策禁止桌面式自更新；插件 2.14 对 Android/iOS 为 unsupported | `NEXT-009` |
| 增量更新/差分包 | 官方插件只做整包；增量需自建协议与签名 | `NEXT-AU-004` |
| 自定义 TUF/Uptane 元数据层 | 当前威胁模型下官方插件 + 版本绑定已足够；自建元数据是独立大工程 | `NEXT-AU-001` |
| 遥测/更新成功率上报 | 隐私默认最小化；无后端 | `NEXT-AU-003` |
| 应用市场/插件市场签名 | 与 app updater 信任根分离，属于 P4 | 蓝图 P4 |

---

## 3. 当前运行时链路 / 目标调用链

### 3.1 调研与调用链证据摘要

| 项 | 状态 | 证据位置 | 结论摘要 |
|---|---|---|---|
| 官方文档调研 | pass | `01 §2.4.1` | Tauri updater 2.14.0 默认只验签 artifact；`requireSignedVersion` 可把清单 `version` 绑定到 minisign trusted comment；Tauri CLI 2.12.0+ 的 `tauri build` 自动写入签名版本 |
| GitHub 开源实现调研 | pass | `01 §2.4.2` | 官方 plugins-workspace/tauri-action 是主参考；Screenpipe 的 Rust manager + 事件、Spacedrive 的 hook/进度 UX、NoteGen/Pot 的踩坑作为对照；Go-Sitech-VPN 的 Rust 三阶段可借鉴，但其 HTTP/token/清单未签名/进度 chunk 语义不可照搬 |
| subagent/GitNexus 调用链分析 | pass | `01 §3`；`02 E-003~E-008` | 启动、IPC、保存/关闭、UI 装配链已展开；`SaveCoordinator.flush` 为 CRITICAL；`app_close_confirm` 因 Tauri 宏/字符串 invoke 在图中为 UNKNOWN，不能当安全 |
| 当前代码实时校准 | pass | `02 §8` | 基线 `7655d49` 与 `origin/main` 一致；工作区干净；GitNexus 已重建到该提交；主工作区 WIP 未纳入 |

### 3.2 当前运行时链路 / 目标调用链

当前（无更新器）：

```text
启动：main -> qingmo_lib::run -> Builder(dialog/menu/manage) -> invoke_handler(5 commands) -> RunEvent
手动命令：CommandPalette -> commandRegistry.execute -> feature.run
保存：Mod+S/blur/switch/close -> SaveCoordinator.flush(reason) -> document_write_atomic -> AtomicWriter
关闭：CloseRequested/Cmd+Q -> request_close -> CloseGuard.begin -> app://close-requested
      -> useCloseGuard -> SaveCoordinator.flush("close") -> app_close_confirm -> app.exit(0)
```

目标（更新器）：

```text
检查：CommandPalette / 启动静默
  -> UpdateController.check(silent)
  -> UpdatePort.check -> invoke("app_update_check")
  -> UpdateManager.begin_check -> app.updater_builder().check()
  -> 无更新：Idle；有更新：Available + State 事件
  -> UpdateHost 横幅 / UpdateDialog

下载：用户点击“下载”
  -> UpdateController.download -> invoke("app_update_download")
  -> UpdateManager.begin_download -> plugin Update.download(on_chunk)
  -> 累计/节流 app://update-progress
  -> 验签成功：Ready；失败：Available + 稳定错误码

安装：用户点击“安装并重启”
  -> UpdateController.install()（读取 WorkspaceLayout 注册的 prepareInstall）
  -> SaveCoordinator.flush("close")  ← 复用唯一保存路径
  -> 失败：阻止安装，显示冲突/错误
  -> 成功：invoke("app_update_install")
  -> UpdateManager.begin_install -> Update.install(bytes)（再次验签）
  -> macOS：app.request_restart()（RESTART_EXIT_CODE，不触发 code=None 关闭守卫）
```

关键约束：

1. 正常保存/关闭路径不变；更新只在安装前“调用” `flush("close")`；关闭侧仅增加安装/退出终态，不复制状态机。
2. Rust 是更新生命周期唯一权威；前端只镜像快照和事件，不维护第二套 phase 转换。
3. 默认安全：签名/版本不匹配、未下载、保存失败、关闭请求 pending、非法状态一律 fail-closed。
4. 不新增用户配置/数据表；构建/发布配置新增项需 `Q-008` 批准。

---

## 4. 当前实施状态总览

| T-ID | 任务 | Status | DependsOn | Evidence | Next |
|---|---|---|---|---|---|
| T-001 | ADR/范围与蓝图偏差校准 | done | Q-001~Q-012（已确认） | ADR-0005；蓝图/拓扑；C-012 | T-002 |
| T-002 | 版本单一源/发布门禁脚本 | done | T-001 | `check-versions.mjs`；C-013 | T-003 |
| T-003 | updater 依赖/插件配置/密钥占位 | done | T-002 | 插件 2.14.0；本地 key；C-014 | T-004 |
| T-004 | Rust DTO/错误码/契约/capability/生成类型 | done | T-003 | 9 命令/3 事件/19 错误码；C-015 | T-005 |
| T-005 | 前端契约镜像/UpdatePort/适配器/fake | done | T-004 | UpdatePort/Fake/Tauri；C-017 | T-006 |
| T-006 | Rust UpdateManager 状态机 | done | T-004 | 8 unit + 1 integration；C-016 | T-007 |
| T-007 | Rust 更新命令/插件接线/事件/超时 | done | T-005、T-006 | 4 命令接线；超时/进度/错误分类；C-018 | T-008 |
| T-008 | 前端 UpdateController/Provider | done | T-005 | 10 tests；runId/StrictMode/install gate；C-019 | T-009 |
| T-009 | UI：命令/横幅/对话框/i18n | done | T-008 | 17 update tests；C-020 | T-010 |
| T-010 | 浏览器 E2E fake updater | done | T-009 | 6 update spec；52 E2E；C-021 | T-011/T-012 |
| T-011 | 发布 workflow/latest.json 验证 | done | T-002、T-003 | 本地发布链路；C-025/C-026；GitHub Actions 路径按本地优先停用 | T-014 |
| T-012 | 契约/安全负例与 CI 门禁 | done | T-004/T-005 | 两负例；C-022 | T-013 |
| T-013 | 文档/ADR/蓝图/README 收尾 | done | T-011/T-012 | ADR/README/03；C-023 | T-014 |
| T-014 | 全量验证 + macOS 冒烟 | blocked | T-001~T-013 | 本地全绿；C-024/C-026；universal/公证/latest.json；真机待跑 | B-002 |

> T-014 标为 `blocked` 仅因双架构真机未完成；T-011 本地发布与 T-014 本地全量/构建/公证已通过。GitHub Actions 路径已按本地优先停用。

状态值只允许：`todo`、`in_progress`、`blocked`、`done`、`skipped`。

---

## 5. 交付物清单

| 类型 | 路径/对象 | 预期变更 | 状态 | 证据 |
|---|---|---|---|---|
| Doc | `docs/adr/0005-app-auto-update.md` | 新增 ADR：范围、信任根、退出语义、无 settings | done | T-001；ADR §1~§7 |
| Doc | `docs/BLUEPRINT.md` | §9.3/§9.4/§12 更新器偏差：无百分比灰度、无自动回滚、Rust-only 权限 | done | T-001；蓝图 §9.3/§9.4/§12 |
| Doc | `docs/TOPOLOGY.md` | 更新检查/下载/安装/重启链路与信任边界 | done | T-001；§1/§3.5/§4 |
| Code | `src-tauri/Cargo.toml`、`Cargo.lock` | `tauri-plugin-updater = "=2.14.0"` | done | T-003；C-014 |
| Code | `src-tauri/tauri.conf.json` | `createUpdaterArtifacts`、`plugins.updater.*`（含 `requireSignedVersion`） | done | T-003；C-014（公钥已落配置） |
| Code | `src-tauri/src/lib.rs` | 注册 updater plugin + manage `UpdateManager` | done | T-003（插件）/T-007（状态）；C-018 |
| Code | `src-tauri/src/ipc/dto.rs`、`error.rs`、`contract.rs` | 更新 DTO、6 个错误码、4 命令、2 事件 | done | T-004；C-015 |
| Code | `src-tauri/src/state/update_manager.rs` | Rust 单一更新状态机 | done | T-006；C-016 |
| Code | `src-tauri/src/commands/update.rs` | check/download/install/status + 进度事件 + 超时/错误分类 | done | T-007；C-018 |
| Code | `src-tauri/src/commands/close.rs`、`state/close_guard.rs` | 安装中忽略关闭请求；同一 Mutex 安装门闩 | done | T-007；C-018 |
| Code | `apps/desktop/src/lib/update/{port,tauri,fake}.ts` | UpdatePort + Tauri/Fake 适配器 | done | T-005；C-017 |
| Code | `apps/desktop/src/features/update/*` | Controller/Provider/Host/Dialog/command | done | T-008/T-009；C-019/C-020 |
| Code | `apps/desktop/src/app/AppServices.tsx`、`AppShell.tsx`、`WorkspaceLayout.tsx` | 装配 UpdatePort/Provider/Host/命令 | done | T-005/T-008/T-009；C-020 |
| Code | `packages/shared/src/generated/*`、`index.ts` | ts-rs 生成 DTO + 手工索引 | done | T-004；C-015 |
| Code | `apps/desktop/src/lib/ipc/commands.ts`、`errors.ts` | 命令/事件/错误码镜像 | done | T-004/T-005；C-017 |
| Code | `apps/desktop/src/i18n/locales/{zh-CN,en}.ts` | `update` namespace + 6 个错误文案 | done | T-005/T-009；C-020 |
| Test | `src-tauri/src/state/update_manager.rs` 单测 | 状态机/并发/错误分类 | done | T-006；C-016 |
| Test | `src-tauri/tests/commands_contract.rs`、`security_config.rs` | 9 命令/3 事件/权限/DTO/配置断言 | done | T-004；C-015 |
| Test | `apps/desktop/src/features/update/*.test.tsx` | Controller/Host/Dialog/install flush | done | T-008/T-009；C-019/C-020 |
| Test | `e2e/update.spec.ts`、`apps/desktop/src/e2e/bridge.ts`、`e2e/types.ts`、`e2e/helpers.ts` | FakeUpdatePort 注入 + 零网络 | done | T-010；C-021（6 spec / 52 E2E） |
| Config | `.github/workflows/release.yml`（新） | macOS tag 构建、Xcode 证书签名/公证、DMG 单独公证、draft、latest.json、发布门禁；当前作为可选模板停用 | skipped | T-011；本地发布已完成；GitHub Actions 路径停用 |
| Script | `scripts/release/check-versions.mjs` | 版本单一源校验 | done | T-002；C-013 |
| Script | `scripts/release/check-latest-json.mjs`、`test-check-latest-json.sh` | 平台键/签名版本/URL/笔记上限/AppleDouble/真实 minisign 验签 | done | T-011；C-025；9 个正负例 |
| Script | `scripts/release/make-latest-json.mjs`、`test-make-latest-json.sh` | 本地生成 latest.json；签名版本/URL/notes/唯一产物校验 | done | T-011；C-026；9 个正负例 |
| Script | `scripts/release/build-local.sh` | 本地 universal 构建/Developer ID/App+DMG 公证/latest.json/验签 | done | T-011/T-014；C-026 |
| Script | `scripts/ci/negative-contract.sh`、`negative-capability.sh` | 更新命令/权限负例 | done | T-012；C-022 |
| Doc | `docs/todo/app-auto-update/**` | 本方案、状态、复盘、评审 | in_progress | 本文 |
| Prototype | `docs/todo/app-auto-update/prototype/index.html` | 自包含高保真原型：13 状态、命令面板、保存冲突、安装/错误/暗色；CSP 禁止网络 | done | 本文 §10；无网络请求 |

---

## 6. 数据模型 / 配置 / 接口

### 6.1 数据模型

**不新增数据库、不新增表、不新增迁移。** 更新生命周期只存在于 Rust 进程内存；下载字节只在内存中保留到安装/退出，不写应用数据目录；安装阶段由官方插件写系统临时目录/缓存/备份，清理由插件负责。

核心 Rust 状态（伪代码，最终以 `04 §6.1` 为准）：

```rust
enum UpdatePhase { Idle, Checking, Available, Downloading, Ready, Installing }

struct UpdateManagerState {
    phase: UpdatePhase,
    generation: u64,
    update: Option<tauri_plugin_updater::Update>,
    artifact: Option<DownloadedArtifact>, // Vec<u8> + version
    progress: Option<UpdateProgress>,
}
```

跨 IPC DTO：`UpdateInfo`、`UpdateSnapshot`、`UpdateProgress`、`UpdateProgressPayload`。不包含 token、路径、下载 URL 或用户文档内容。

### 6.2 配置项

| 配置项 | 环境变量 | 默认值 | 行为 | 兼容性 |
|---|---|---|---|---|
| 用户级更新偏好 | 无 | 无 | **MVP 不新增**；不写 localStorage/settings.json/SQLite | 保持 ADR-0001/0003 与 NEXT-006 的 settings 单一源前置 |
| `bundle.createUpdaterArtifacts` | 无 | 未设置 | 设为 `true` 才生成 `.sig`/更新包 | **新增构建配置，需 Q-008 批准** |
| `plugins.updater.pubkey` | 无 | 无 | minisign 公钥（可公开） | **新增构建配置，需 Q-007/Q-008 批准** |
| `plugins.updater.endpoints` | 无 | 无 | 仅 HTTPS GitHub Releases `latest.json` | **新增构建配置，需 Q-001/Q-008 批准** |
| `plugins.updater.requireSignedVersion` | 无 | `false`（插件默认） | 设为 `true`，拒绝清单版本与签名版本不一致 | **新增构建配置，需 Q-008 批准** |
| `dangerousInsecureTransportProtocol` | 无 | `false` | **保持/不设置**；禁止 HTTP | 安全默认 |
| `allowDowngrades` | 无 | `false` | **保持/不设置**；禁止降级 | 安全默认 |
| `plugins.updater.windows.installMode` | 无 | — | **MVP 不适用**（仅 macOS）；未来 Windows 支持时再评审 | `NEXT-AU-007` |

> 以上构建/发布配置不是用户配置，但仍属于“新增配置项”；在 Q-008 明确同意前不得写入仓库。

### 6.3 API / 对外接口（如适用）

| 接口 | 变更 | 兼容性 | 验证 |
|---|---|---|---|
| `app_update_status` | 新增：返回当前 `UpdateSnapshot`，无网络副作用 | 追加；旧前端不调用 | 契约/单测 |
| `app_update_check` | 新增：检查更新；单飞；返回快照 | 追加 | 契约/单测/E2E |
| `app_update_download` | 新增：下载并验签；发进度事件 | 追加 | 单测/E2E |
| `app_update_install` | 新增：安装并重启；安装前由前端 flush | 追加；macOS 成功后会重启，命令可能不返回 | 单测/真机冒烟 |
| `app://update-state` | 新增：phase/update/progress 快照事件 | 追加 | 契约/E2E |
| `app://update-progress` | 新增：累计下载进度事件（节流） | 追加 | 契约/E2E |
| `allow-app-update-*` | 新增 4 条 capability | 追加；不加 `updater:*` | 安全配置/负例 |

---

## 7. 验收标准

| AC-ID | 验收项 | 覆盖任务 | 验证命令/证据 | Status |
|---|---|---|---|---|
| AC-001 | 手动检查：有更新显示版本/说明；无更新提示“已是最新” | T-009 | Vitest + E2E `update.spec.ts`；C-020/C-021 | done |
| AC-002 | 启动静默检查失败不弹窗/不阻断启动；有更新仅横幅 | T-008/T-009 | 单测 + E2E；C-019/C-021 | done |
| AC-003 | 进度累计正确、节流、未知总大小不崩溃 | T-006/T-007 | Rust 单测 + E2E；C-016/C-018/C-021 | done |
| AC-004 | 签名/签名版本错误时不安装，返回 `UPDATE_SIGNATURE_INVALID` | T-007 | C-016/C-018；签名错误清 artifact | done |
| AC-005 | 清单版本与签名版本不一致时不安装 | T-007/T-011 | 插件版本绑定 + 两个脚本 version mismatch 负例；C-025/C-026 | done |
| AC-006 | dirty 文档安装前先 `flush("close")`，保存成功后才调 install | T-008/T-010 | Controller 单测 + E2E；C-020/C-021 | done |
| AC-007 | 冲突/终态错误/另存取消时阻止安装，保留更新状态 | T-008/T-009 | C-020/C-021 | done |
| AC-008 | CloseGuard pending 时 install 返回 `BUSY`，不产生第二次退出 | T-007 | C-018 | done |
| AC-009 | Installing 期间关闭请求被忽略；安装失败后关闭恢复 | T-007 | Rust 单测 C-018；真机重启待 T-014 | in_progress |
| AC-010 | 并发 check/download/install 返回 `BUSY`/`UPDATE_NOT_READY` | T-006/T-007 | C-016/C-018 | done |
| AC-011 | 不新增 `updater:*` 权限；CSP 不变；无 HTTP/降级配置 | T-004/T-012 | `security_config.rs`；C-015/C-022 | done |
| AC-012 | 9 命令/3 事件/DTO/生成文件/负例全绿 | T-004/T-005/T-012 | C-015/C-022 | done |
| AC-013 | `latest.json` 版本/平台键/URL/签名版本/重复项通过门禁 | T-011 | `check-latest-json.mjs` + `make-latest-json.mjs`；C-025/C-026 | done |
| AC-014 | 7 处版本一致；tag 与 tauri.conf 一致 | T-002 | C-013/C-024 | done |
| AC-015 | 浏览器 E2E 零真实更新网络；fake 可控错误/进度 | T-010 | C-021 | done |
| AC-016 | ADR/蓝图偏差/回滚/密钥轮换/交接完整 | T-001/T-013 | C-012/C-023 | done |

---

## 8. 验证入口

LLM 执行每个任务前必须先完成对应任务的 Pre-Implementation Check；完成任务后优先运行以下命令：

```bash
# 契约/安全/生成文件（T-004/T-005/T-012）
cargo test --manifest-path src-tauri/Cargo.toml --test commands_contract --test security_config
bash scripts/ci/check-generated.sh
pnpm typecheck
pnpm test
pnpm depcruise

# 更新状态机/命令（T-006/T-007）
cargo test --manifest-path src-tauri/Cargo.toml update_manager
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# E2E（T-010）
pnpm build:e2e && pnpm test:e2e -- update.spec.ts

# 发布门禁（T-002/T-011）
node scripts/release/check-versions.mjs --expect 0.1.0
node scripts/release/check-latest-json.mjs --latest-json <path> --tag v0.1.0 --pubkey <pubkey> --artifacts <dir>
pnpm release:test

# 本地发布（T-011/T-014；不自动上传/发布）
pnpm release:local

# 全量（T-014）
pnpm ci:local
```

| C-ID | Command | 何时运行 | 预期 |
|---|---|---|---|
| C-001 | `git rev-parse HEAD origin/main` | 每轮开始 | 两者一致（或记录差异） |
| C-002 | `node .gitnexus/run.cjs status` | 每轮开始/改动后 | 索引提交=当前 HEAD |
| C-003 | `cargo test --manifest-path src-tauri/Cargo.toml --test commands_contract` | T-004/T-012 | PASS |
| C-004 | `cargo test --manifest-path src-tauri/Cargo.toml --test security_config` | T-004/T-012 | PASS |
| C-005 | `bash scripts/ci/check-generated.sh` | T-004 | PASS（无 diff） |
| C-006 | `pnpm typecheck && pnpm test` | T-005/T-008/T-009 | PASS |
| C-007 | `pnpm depcruise` | T-005 | PASS |
| C-008 | `pnpm build:e2e && pnpm test:e2e -- update.spec.ts` | T-010 | PASS |
| C-009 | `node scripts/release/check-versions.mjs --expect 0.1.0` | T-002 | PASS |
| C-010 | `node scripts/release/check-latest-json.mjs ...` | T-011 | PASS |
| C-999 | `pnpm ci:local` | T-014 | SKIPPED（未提交工作区 generated stale；按 02 C-024 拆分执行） |

---

## 9. 风险与回滚摘要

| RK-ID | 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|---|
| RK-001 | `latest.json` 未签名；重放/冻结/伪造版本 | 中 | `requireSignedVersion=true`；HTTPS；发布门禁；记录残余风险 | 撤下 release/latest.json；发布 hotfix |
| RK-002 | 更新签名私钥丢失/泄露 | 高 | 离线备份 + GitHub Environment secret + 轮换 runbook | 旧 key 过渡发布；新 key 新通道 |
| RK-003 | 安装前未保存导致丢内容 | 高 | 唯一 `UpdateController.install` 先 `flush("close")`；冲突/错误阻断 | 回滚代码；恢复旧版本；用户文件不自动改 |
| RK-004 | 安装中关闭/双重退出竞态 | 高 | Installing 期间忽略关闭；`request_restart` 不触发 `code=None` 分支 | 回滚 close.rs 分支；force quit |
| RK-005 | Xcode 证书/签名/公证失败 | 高 | 证书从 Xcode 导出到 Environment；`codesign`/`notarytool` 校验；真机 Gatekeeper | 撤回 release；修复证书后重发 |
| RK-006 | macOS universal 架构键/产物不匹配 | 中 | 同时校验 `darwin-aarch64`/`darwin-x86_64`/`darwin-universal*`；真机双架构冒烟 | 撤下平台键；重发 universal 包 |
| RK-007 | 版本漂移（7 处 0.1.0） | 中 | `check-versions.mjs` + release 门禁 | 修正版本后重跑 |
| RK-008 | 发布 workflow 秘密泄露 | 高 | Environment 保护、最小权限、SHA pin、无 PR secret | 轮换 secrets；审计日志 |
| RK-009 | 自动检查隐私/网络失败 | 低 | 仅检查 manifest；失败静默；不自动下载 | 关闭端点/发布 hotfix |
| RK-010 | 发布说明 XSS | 中 | 纯文本 `white-space: pre-wrap`，不用 `dangerouslySetInnerHTML` | 回滚 UI |
| RK-011 | 二进制体积/编译时间增加 | 低 | 测量；只引入官方插件 | 回滚依赖 |
| RK-012 | 静态 `latest.json` 无法百分比灰度 | 中 | 首版全量 stable；beta 用 prerelease 通道 | 撤下 release；hotfix |
| RK-017 | 下载包常驻内存（macOS universal 包可能 40–80 MB） | 中 | `Arc<[u8]>` 单份；测量 RSS；退出释放 | 后续改临时文件/流式安装 |
| RK-018 | 首版 updater 之前的老用户无法自动更新 | 中 | 发布说明 + 一次性手动下载公告 | 手工安装指引 |

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [`00-使用说明.md`](00-使用说明.md) | LLM 执行协议、审批门禁、证据规范 |
| [`01-实施计划.md`](01-实施计划.md) | 调研、调用链、决策、任务队列、文件范围、验证 |
| [`02-实施状态与验证.md`](02-实施状态与验证.md) | 执行日志、命令结果、验收覆盖、最终 VERDICT |
| [`03-复盘与交接.md`](03-复盘与交接.md) | 预实施复盘、踩坑、回滚、维护、交接 |
| [`prototype/index.html`](prototype/index.html) | 自包含高保真交互原型；状态切换、深浅色、命令面板；无网络/无存储 |
| [`04-设计方案.md`](04-设计方案.md) | 架构、状态机、接口、时序、边界、安全、方案对比 |
| [`05-多轮评审记录.md`](05-多轮评审记录.md) | 三轮评审发现、处置、复核 |

---

## 11. 变更日志

| 时间 | 变更 | 作者/Agent | 证据 |
|---|---|---|---|
| 2026-10-27T18:45:00+08:00 | 创建自动更新实施控制台 v1.0 | OpenCode / DeepSeek V4.1 | 基线 `7655d49`；调研/调用链/评审见 01/02/05 |
| 2026-10-27T19:35:00+08:00 | 评审回改 v1.1：7 处版本、3 条事件、D-021/D-022、CloseGuard 门闩、下载上限/HTTPS、发布门禁 | OpenCode / DeepSeek V4.1 | `05` R1/R2/R3；`01`/`04` v1.1 |
| 2026-10-27T19:35:00+08:00 | 决策回写 v1.2：仅 macOS universal；Xcode Developer ID 签名 + 公证；Q-001~Q-012 结论；Windows/Linux 移入 NEXT-AU-007 | OpenCode / DeepSeek V4.1 | 用户 2026-10-27 决策；`01`/`04` v1.2 |
| 2026-10-27T19:57:00+08:00 | 新增高保真原型：13 个更新状态、命令面板、保存冲突、安装/错误/暗色；无网络/无存储 | OpenCode / DeepSeek V4.1 | `prototype/index.html`；Chrome 1440/500 视口核对 |
| 2026-10-27T20:26:05+08:00 | T-001 完成：新增 ADR-0005；校准蓝图 §9.3/§9.4/§12/P4 与 TOPOLOGY 更新链路/信任边界 | OpenCode / DeepSeek V4.1 | C-012；ADR-0005；蓝图/拓扑 diff |
| 2026-10-27T20:27:25+08:00 | T-002 完成：新增 `check-versions.mjs`，覆盖 7 处声明 + Cargo.lock；CI 门禁；正负例通过 | OpenCode / DeepSeek V4.1 | C-013；`scripts/release/check-versions.mjs`；`ci.yml` |
| 2026-10-27T20:31:55+08:00 | T-003 完成：加入 updater 2.14.0、注册插件、配置 GitHub endpoint/公钥/`requireSignedVersion`；密钥文件在仓库外 | OpenCode / DeepSeek V4.1 | C-014；`cargo check`；`security_config` 3 passed |
| 2026-10-27T20:37:43+08:00 | T-004 完成：9 命令/3 事件/19 错误码/DTO/4 权限/生成类型；契约与安全测试通过 | OpenCode / DeepSeek V4.1 | C-015；6 contract + 4 security tests；生成幂等 |
| 2026-10-27T20:41:16+08:00 | T-005 完成：UpdatePort、Tauri/Fake 适配器、AppServices/E2E 装配、depcruise 边界 | OpenCode / DeepSeek V4.1 | C-017；36 update/ipc/app tests；depcruise 165 modules |
| 2026-10-27T20:45:08+08:00 | T-006 完成：UpdateManager 状态机、单飞/generation/进度/失败回退；8 unit + 1 integration | OpenCode / DeepSeek V4.1 | C-016；`cargo test update_manager` 9 passed；clippy 通过 |
| 2026-10-27T20:51:00+08:00 | T-007 完成：4 命令接线、30s/10min 超时、512MiB 上限、进度节流、错误分类、CloseGuard 安装门闩、request_restart | OpenCode / DeepSeek V4.1 | C-018；`cargo test --all-targets`；contract 6 passed |
| 2026-10-27T20:54:45+08:00 | T-008 完成：UpdateController/Provider/useUpdate；runId、StrictMode、stop-before-listen-resolve、install flush gate | OpenCode / DeepSeek V4.1 | C-019；10 tests；typecheck |
| 2026-10-27T21:07:40+08:00 | T-009 完成：命令 `app.checkForUpdates`、横幅、对话框、进度条、纯文本 notes、i18n `update`、close/update 互斥、live prepareInstall | OpenCode / DeepSeek V4.1 | C-020；17 update tests；298 全量 tests |
| 2026-10-27T21:11:24+08:00 | T-010 完成：E2E update bridge/helpers/spec；检查/进度/安装前保存/冲突/错误/零网络 | OpenCode / DeepSeek V4.1 | C-021；6 update spec；52 E2E 全绿 |
| 2026-10-27T21:12:13+08:00 | T-012 完成：负例锚点改为 update 命令/权限；`ci:negative` 通过；安全配置断言 updater 禁权 | OpenCode / DeepSeek V4.1 | C-022；两负例恢复；security_config 4 passed |
| 2026-10-27T21:14:00+08:00 | T-013 完成：ADR-0005 实施状态、主 README P2 状态、03 交接/回滚/证据回写；T-011 待实现项显式标注 | OpenCode / DeepSeek V4.1 | C-023；文档一致性检查 |
| 2026-10-27T21:24:06+08:00 | T-014 本地部分完成：前端 298/后端全 target/E2E 52/负例/构建通过；`tauri build --debug --no-bundle` 与本地 minisign 签名冒烟通过；CI 改 `--no-bundle`；Playwright 不再复用旧 preview server；真机安装仍等 B-002 | OpenCode / DeepSeek V4.1 | C-024；`Qingmo.app.tar.gz.sig` trusted comment `version:0.1.0` |
| 2026-10-27T21:40:21+08:00 | T-011 静态完成：`release.yml`（tag→draft→build/公证→validate→publish）+ `check-latest-json.mjs` + 9 正负例；真实 `.sig` 验签；GitHub `release` Environment/secrets 已配置 | OpenCode / DeepSeek V4.1 | C-025；`actionlint`；真实签名产物 PASS |
| 2026-10-27T22:10:19+08:00 | 本地发布链路完成：universal 构建、Developer ID 签名、App 公证、DMG 单独公证/stapling、`make-latest-json` + 真实 16 MB 产物验签；新增 `release:local`/`release:test`；GitHub DMG 公证步骤补齐 | OpenCode / DeepSeek V4.1 | C-026；`spctl=accepted / Notarized Developer ID`；App+DMG stapled；9+9 正负例 |
| 2026-10-27T22:20:02+08:00 | 按本地优先决策停用 GitHub Actions 发布：删除 `release` Environment 与 8 个 secrets；证书/密码仅保留在本地 `.release/`（gitignored），一键脚本迁入主仓库；文档状态回写 | OpenCode / DeepSeek V4.1 | `gh api .../environments` total_count=0；本地 `.release/` 700/600；`git check-ignore` 通过 |

---

## 12. 人工决策记录（2026-10-27 已确认）

> 规则：**新增配置项、数据表、用户可见行为变更**必须先得到人工确认。以下决策已由用户确认；Q-011 随“仅 macOS”标记 N/A，Windows/Linux 移入 `NEXT-AU-007`。

| Q-ID | 问题 | 选项 | 结论/建议 | 影响 |
|---|---|---|---|---|
| Q-001 | 更新托管在哪里？ | A. GitHub Releases 公共仓库（`releases/latest/download/latest.json`）；B. 自建 HTTPS 对象存储/CDN；C. GitHub + 镜像 fallback；D. 私有仓库 + 认证下载 | **已确认 A**：GitHub Releases 公共仓库 | 端点、密钥、运维、是否需要 token |
| Q-002 | 首版平台范围？ | A′. 仅 macOS universal；B. macOS + Windows；C. 三平台 + deb/rpm | **已确认 A′：仅 macOS universal**；Windows/Linux 移入 `NEXT-AU-007` | 构建矩阵缩减为单 macOS job、latest.json 仅 darwin 键 |
| Q-003 | 检查/下载/安装策略？ | A. 启动静默检查 + 横幅，下载/安装用户确认；B. 自动下载，安装确认；C. 退出时自动安装；D. 仅手动 | **已确认 A** | 用户打扰、数据安全、网络 |
| Q-004 | 是否新增用户配置/数据表？ | A. MVP 不新增；B. 新增统一 settings 文件；C. SQLite settings 表；D. 新增 localStorage 键 | **已确认 A**：不新增用户配置/数据表/localStorage | 保持 ADR-0001/NEXT-006 单一源 |
| Q-005 | 发布通道？ | A. 仅 stable；B. stable + beta（编译期通道/独立 endpoint）；C. 用户可选通道 | **已确认 A**；beta 作为 `NEXT-AU-002` | 端点、发布流程、UI |
| Q-006 | macOS 代码签名？ | A. 使用 Xcode 中的 Developer ID Application 证书 + notarization（从 Xcode 导出 `.p12` 给 CI）；B. 手工证书；C. 不签名（仅开发） | **已确认 A**：Xcode 证书；Tauri CLI 导入临时 keychain，调用 `codesign`/`notarytool` | Gatekeeper、证书/CI secrets、公证流程 |
| Q-007 | updater 私钥托管/轮换？ | A. 离线生成，密码管理器 + GitHub Environment secret，长期使用；B. HSM/1Password CLI；C. 每次发布临时 key | **已确认 A**；记录轮换 runbook | 丢失后无法更新已安装用户 |
| Q-008 | 是否批准新增构建/发布配置？ | `createUpdaterArtifacts`、`plugins.updater.pubkey/endpoints/requireSignedVersion`；不新增用户配置 | **已批准** | 配置/安全/发布 |
| Q-009 | 是否批准新增 IPC 命令/事件？ | 4 命令 + 2 事件 + 4 条 `allow-app-update-*`；不加 `updater:*` | **已批准** | 契约/权限/测试 |
| Q-010 | “失败自动回滚”预期？ | A. 接受“安装失败保留旧版本；坏版本用 hotfix 前行修复”；B. 自建备份/回滚；C. 依赖 OS/企业工具 | **已确认 A**，并修正蓝图 §12 | 设计范围/风险 |
| Q-011 | Linux 包格式？ | A. 仅 AppImage；B. AppImage + deb + rpm；C. 暂不支持 Linux | **N/A**：MVP 仅 macOS；未来 Linux 采用 A | latest.json 键/安装器/权限 |
| Q-012 | 更新 UI 位置/发布说明？ | A. 命令面板 + 横幅 + 对话框，说明纯文本；B. 设置/关于页；C. 原生菜单项 | **已确认 A** | 范围、可访问性、XSS |
