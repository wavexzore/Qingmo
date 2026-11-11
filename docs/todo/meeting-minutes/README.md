# 会议纪要（本地音频转结构化纪要）

> **模板定位：** LLM 持续实施控制台
> **功能 ID：** `meeting-minutes`
> **对应 SDD Spec：** 无（依据 `docs/roadmap.md:74` 的「内置 AI 写作」方向；用户 2026-11-10 明确本批只做音频会议纪要）
> **对应需求：** R-001 ~ R-014
> **功能分支：** `feat/meeting-minutes`（建议；当前工作树在 `feat/p0-p1-closure`，未新建）
> **优先级：** P2（新增能力，不改变既有保存/打开不变量）
> **负责人：** Qingmo 维护者
> **最新代码校准日期：** 2026-11-10
> **代码基线：** `feat/p0-p1-closure@e3b5697` + T-001/T-002 未提交改动（33 个文件；`docs/` 未跟踪；`HEAD` 领先 `origin/main` 6 个本地提交）
> **GitNexus 索引：** `Qingmo`，`lastCommit = e3b56975cfad657b1d1691e9053227ee9d778814`，`status = current`
> **设计文档：** [`04-设计方案.md`](04-设计方案.md)
> **高保真原型：** [`prototype.html`](prototype.html)

---

## 0. LLM-STATE（每轮实施前必须读取）

```yaml
schema_version: "1.0"
feature_id: "meeting-minutes"
feature_name: "会议纪要（本地音频转结构化纪要）"
status: "in_progress"           # todo | in_progress | blocked | partial | done | rolled_back | cancelled
current_task: "T-013"          # 当前应执行的任务；Q 全部已决
last_completed_task: "T-012"
next_action: "T-013 Pre-Implementation Check（打包/体积/公证/许可）"
verification_status: "pass" # not_run | pass | fail | partial | skipped
research_status: "pass"        # 官方文档 / 论文 / 开源实现 / 引擎选型四路调研已完成，证据见 01 §2.4 / 05
call_chain_status: "pass"      # GitNexus impact + context + PDG + 源码复核已完成，证据见 01 §3
code_calibration_status: "pass"
last_verification_command: "pnpm ci:local && pnpm ci:tauri && scripts/meeting-models/calibrate.sh"
last_updated: "2026-11-11T06:35:00+08:00"
resume_from:
  - "README.md#0-llm-state每轮实施前必须读取"
  - "01-实施计划.md#12-待确认事项"
  - "01-实施计划.md#6-llm-任务队列"
  - "02-实施状态与验证.md#3-执行日志"
allowed_scope:
  - "src-tauri/src/services/meeting/**"
  - "src-tauri/vendor/**"
  - "scripts/ci/check-vendor.sh"
  - "src-tauri/src/services/mod.rs（注册 meeting 模块）"
  - "src-tauri/src/state/meeting/**"
  - "src-tauri/src/state/mod.rs（注册 meeting 状态）"
  - "src-tauri/src/commands/meeting.rs"
  - "src-tauri/src/commands/mod.rs"
  - "src-tauri/src/commands/document.rs（build_document_window 参数、create_document_window 返回窗口、create_untitled_window_with_label 的 query、document_save_as 仅 meeting 默认名）"
  - "src-tauri/src/state/document_registry.rs（仅 ensure_supported_audio）"
  - "src-tauri/src/commands/settings.rs（app_settings_open、ensure_settings_window 可见性）"
  - "src-tauri/src/commands/locale.rs（仅确认重建路径）"
  - "src-tauri/src/services/workspace_service.rs（音频条目）"
  - "src-tauri/src/lib.rs（State 注册、菜单、Destroyed 取消）"
  - "src-tauri/src/ipc/contract.rs"
  - "src-tauri/src/ipc/dto.rs"
  - "src-tauri/src/error.rs"
  - "src-tauri/Cargo.toml、src-tauri/Cargo.lock、src-tauri/tauri.conf.json、src-tauri/capabilities/*.json"
  - "NOTICE"
  - "scripts/**（模型拉取与校验；不打包）"
  - "src-tauri/tests/**"
  - "apps/desktop/src/features/meeting/**"
  - "apps/desktop/src/features/editor/DocumentSessionContext.tsx"
  - "apps/desktop/src/features/editor/EditorSession.ts"
  - "apps/desktop/src/features/editor/EditorPage.tsx（MeetingBoot 替代 EditorHost + showStatusBar 例外）"
  - "apps/desktop/src/components/StatusBar.tsx"
  - "src-tauri/src/state/session_restore.rs（仅 create_untitled_window_with_label 调用点）"
  - "apps/desktop/src/features/workspace/VirtualWorkspaceTree.tsx（音频行不可用态）"
  - "apps/desktop/src/features/workspace/workspaceTree.ts（audio 映射）"
  - "apps/desktop/src/features/workspace/WorkspaceLayout.tsx（命令注册与菜单分发）"
  - "apps/desktop/src/lib/ipc/**、apps/desktop/src/lib/settings/**"
  - "apps/desktop/src/settings/**"
  - "apps/desktop/src/**/*.test.ts*"
  - "apps/desktop/src/stores/uiStore.ts"
  - "apps/desktop/src/i18n/locales/**、apps/desktop/src/i18n/native.ts"
  - "packages/shared/src/**"
  - "e2e/**、e2e-tauri/**、wdio.conf.ts、wdio.soak.conf.ts"
  - ".github/workflows/ci.yml、package.json（仅 CI 接线）"
  - "apps/desktop/src/e2e/**"
  - "README.md、README.zh-CN.md、docs/roadmap.md（路线图与「v1 不做 AI」表述）"
  - "04-设计方案.md、03-复盘与交接.md（评审与交接收尾）"
forbidden_scope:
  - "packages/editor-core/src/live-preview/**（不改 Live Preview 解析）"
  - "src-tauri/src/services/atomic_writer.rs（不改唯一写入路径）"
  - "src-tauri/src/state/document_registry.rs 的 token 语义"
  - "apps/desktop/src/features/editor/SaveCoordinator*"
stop_condition: "所有 required=true 的 T-### 均为 done，验证报告 VERDICT: PASS；Q-001~Q-011 裁决记录齐全"
blocker_policy: "遇到 blocked 时记录 B-###、失败证据、已尝试方案和下一恢复动作；模型/许可类 blocker 直接转 Q 由人工裁决"
```

> **状态更新规则：** 每完成一个任务，同步更新 `current_task`、`last_completed_task`、`next_action`、`verification_status`、`code_calibration_status`、`last_updated`。执行前必须完成对应任务的 Pre-Implementation Check。

---

## 1. 一句话结论

会议纪要处于 `in_progress`（T-001/T-002 done，R42 已 PASS，T-003 解冻）；方案已定型为「Rust 独占音频解码与推理、复用 untitled 文档窗口承载结果、复用 `SaveCoordinator` 保存、本地离线分离说话人、两级 map-reduce 出结构化纪要并在无 LLM 时降级为抽取式」。R10 把本地模型从档位改成编译期 manifest 清单选择，并把说话人分离提为第一版能力；R23 按用户裁决改为安装包零模型、全部模型在设置页下载。**十一项人工闸门已全部裁决（含本地 LLM 与配置集），T-001~T-003 已完成，T-004 待预检。**

---

## 2. 功能目标与非目标

### 2.1 目标

| R-ID | 目标 | 验收方式 | 状态 |
|---|---|---|---|
| R-001 | 从本地音频文件（m4a/mp3/wav/mp4/flac）生成一篇 Markdown 会议纪要，含摘要、决议、待办、风险、带时间戳的转录 | E2E-001：导入 60 s 中英混合 fixture，断言五个必需小节且时间戳单调 | todo |
| R-002 | 音频路径不作命令参数（仅只读 asset URL 供播放）；密钥只经 IPC 写 keyring、读取不回传明文、不入 localStorage；默认不外传 | 契约测试：`commands.ts` 无音频路径参数；CSP 不变；`asr.mode=local` 时 wiremock 计数为 0 | todo |
| R-003 | 断网可用：ASR 全本地，摘要可在无 LLM 时降级为抽取式 | E2E-003：断网 + 未配置 LLM，仍产出转录与抽取要点，且标注「未生成抽象摘要」 | todo |
| R-004 | 转录必须可追溯到时间戳，结论必须带原文引句 | 单测：`render` 对每个卡片强制输出 `[hh:mm:ss]` 与引句；缺引句降级为「无依据」 | todo |
| R-005 | 长音频分块有界：默认 180 分钟（硬上限 600）/ 500 MiB，超限在选文件阶段拒绝 | 单测：边界值与超限错误码 | todo |
| R-006 | 任务可取消、可观察、单并发 | 单测：取消后 1 个段（≤30 s）或 1 个分离子窗（≤60 s）内停机且无残留；第二次 `meeting_start` 返回 `MEETING_BUSY` | todo |
| R-007 | 结果写入是普通 untitled 文档，保存走既有 `SaveCoordinator`，AI 改动进 undo 栈 | E2E-001：生成后 `Mod+Z` 可整体撤销；`Mod+S` 触发既有 Save As | todo |
| R-008 | 中文与英文界面/纪要双语；语言可自动判定 | 单测：`language=auto` 对纯中文、纯英文、混合样本的判定；i18n key 完整性 | todo |
| R-009 | 失败可解释：模型缺失、LLM 未配置、音频损坏、推理崩溃各有稳定错误码与恢复动作 | 契约负例：9 个新码 + 4 个已落地音频码，36 总数在 `commands_contract` 断言 | todo |
| R-010 | 打包与许可可验证 | `make build` 通过公证；安装包零模型；转写组合可下载并校验、摘要模型可单独下载；`NOTICE` 完整 | todo |
| R-011 | 可选 BYOK 远程转写，失败回退本地一次并标注 | wiremock 401/429/超时；回退只一次 | todo |
| R-012 | 本地离线说话人分离：转录与引句带「说话人 N」标签，同人同色（8 色 emoji）；失败降级 | 集成：双人 fixture 至少 2 个稳定标签；全失败标注「未分离说话人」，部分失败标「部分未分离」 | todo |
| R-013 | 模型下载可恢复、有界 | 同卷 staging、续传、预哈希、SHA-256、单槽、按 `max(2×download_bytes, download_bytes + install_bytes×1.05 + 64MB)` 预检；全量提示预留 ≥ 20.5 GB | todo |
| R-014 | 按硬件自动分层：内存/平台决定默认模型与线程，8B 仅 ≥32 GiB，用户可钉死模型与纯 CPU | 单测：4 档 profile、`runtime.mode=cpu`、Windows 纯 CPU；AC-016 | todo |

### 2.2 非目标

| 项 | 原因 | 后续处理 |
|---|---|---|
| 麦克风实时录制 | 用户只要求「输入一段音频」；实时流式需要另一套 VAD/背压与权限模型 | NEXT-001 |
| 远程实时流式（WSS） | 第一版只做分块上传，Deepgram 实时留后续 | NEXT-011 |
| 拖入 / Finder 打开音频 | 需改 `opened_paths` 与 `RunEvent::Opened` 分流，与保存链路正交 | NEXT-010 |
| 说话人真实身份识别（把「说话人 1」映射为姓名） | 第一版只做声纹聚类编号，姓名需人工改名或通讯录 | NEXT-002 |
| 视频画面理解 | 只取音轨 | NEXT-003 |
| 纪要模板自定义 / 提示词编辑 | 先固化一种结构，模板化交给插件体系 | NEXT-004 |
| 自建云 ASR 服务 / 多租户配额 | 需服务端与账号体系 | NEXT-005 |
| 应用退出后任务续跑 | 第一版窗口关闭即取消 | NEXT-006 |
| 树内直接打开音频 / 拖入窗口 | 需改 `opened_paths`、`RunEvent::Opened` 与树行点击分流 | NEXT-013 |
| 仅重生成摘要（不重转写） | 需保留任务快照与转录缓存 | NEXT-014 |
| ASR 的 GPU 后端（CoreML/CUDA/DirectML） | 需自定义构建或额外运行时，第一版纯 CPU | NEXT-009 / NEXT-015 |
| 硬件自测向导与多种子模型推荐 | 先稳定固定分层 | NEXT-016 |
| 多人协作、日历集成 | 超出单机编辑器范围 | 无 |

---

## 3. 当前运行时链路 / 目标调用链

### 3.1 调研与调用链证据摘要

| 项 | 状态 | 证据位置 | 结论摘要 |
|---|---|---|---|
| 官方文档调研 | pass | `01-实施计划.md §2.4.1` | Tauri `Channel`/capability/CSP、sherpa-onnx 与 whisper.cpp 文档、Apple 公证要求已核实 |
| GitHub 开源实现调研 | pass | `01-实施计划.md §2.4.2` | whisper.cpp / whisperX / Meetily / sherpa-onnx 的流水线与打包方式已对比，均需改造 |
| 论文调研 | pass | `01-实施计划.md §2.4.3` | 两级 map-reduce、VAD 门控、结构卡片、引句校验、忠实度验收均有出处 |
| subagent/GitNexus 调用链分析 | pass | `01-实施计划.md §3` | 现有打开/窗口/保存/契约/设置链路已逐符号定位，`take_pending` 为 CRITICAL、`menu_layout` 为 HIGH |
| 当前代码实时校准 | pass | `02-实施状态与验证.md §8` | 所有引用行号对齐 `e3b5697`，索引 `current` |

### 3.2 当前运行时链路

```text
菜单 Mod+O / 命令 file.open
  -> WorkspaceLayout openDocument()
  -> IpcPort.documentOpen()                         apps/desktop/src/lib/ipc/port.ts:57
  -> document_open (Rust)                           src-tauri/src/commands/document.rs:148
  -> pick_document() 仅 .md/.markdown/.mdx          src-tauri/src/commands/document.rs:390
  -> ensure_supported_extension                     src-tauri/src/state/document_registry.rs:1129
  -> DocumentRegistry.open_path                     src-tauri/src/state/document_registry.rs:302
  -> WindowSessions.stage + create_document_window  src-tauri/src/state/window_sessions.rs:86
  -> WebviewUrl::App("index.html?window=document")  src-tauri/src/commands/document.rs:78
  -> document_take_pending                          src-tauri/src/commands/document.rs:749
  -> EditorSession.create(payload)                  apps/desktop/src/features/editor/EditorSession.ts:298
  -> SaveCoordinator -> document_write_atomic       src-tauri/src/commands/document.rs:989
  -> AtomicWriter                                   src-tauri/src/services/atomic_writer.rs
```

### 3.3 目标调用链

```text
菜单「会议纪要…」/ 命令 meeting.start
  -> IpcPort.meetingStart()（无路径参数）
  -> meeting_start (Rust)                          新增：dialog filter + 大小/时长/魔数校验
  -> MeetingRegistry.begin(path)                   新增：单并发、requestId、取消令牌
  -> create_untitled_window_with_label(Some(label), Some(query))  修改：带 meeting 参数，跳过 main 复用
     └ WebviewUrl "index.html?window=document&meeting=<requestId>&name=<stem>"
  -> 后台 spawn_blocking 流水线                     新增 services/meeting/*
       逐 10 分钟窗口：decode(symphonia) -> 16 kHz mono f32
       -> (diarize(sherpa 离线分离) ∥ VAD(silero/sherpa)) -> 绝对时间
       -> ASR(sherpa-offline) -> 窗内时间 + window_start_ms
       -> speaker join -> Segment.speaker -> quality gate
       -> Releasing -> 结构卡片(map) -> reduce -> 事实校验
  -> EVENT_MEETING_PROGRESS                        新增：契约 EVENTS
  -> meeting_take_result(requestId)                新增：窗口 boot 后取 Markdown
  -> startUntitled() + insertDocumentText(markdown) 新增：单次事务，可整体 undo
  -> 用户编辑 / Mod+S -> SaveCoordinator（不变）
```

关键约束：

1. 音频/模型路径不作为命令参数进入 WebView；仅本次 source 以只读 asset URL 暴露给播放器，`asset_scope` 只做 label→path 映射与路径去重，0→1 时 `allow_file`；allow 进程内保留、release 只清映射，不 `forbid_file`。
2. 结果必须是普通 untitled 文档，不新增窗口类型、不新增保存路径。
3. 任何 AI 能力缺失都必须降级，不能阻止用户拿到转录。
4. 不修改 `take_pending` 语义（GitNexus `CRITICAL`），窗口身份用 query 参数区分。

---

## 4. 当前实施状态总览

| T-ID | 任务 | Status | DependsOn | Evidence | Next |
|---|---|---|---|---|---|
| T-001 | Rust 音频探测、解码与重采样 | done | Q-001, Q-007 | none | 10/10 |
| T-002 | VAD 分段与质量门 | done | T-001, Q-001 | none | 7/7 |
| T-003 | ASR 接入、绝对时间、运行时与逐窗骨架 | done（2026-11-10） | T-002, T-006, Q-002, Q-006, Q-009, Q-010, Q-011 | none | — |
| T-004 | 结构卡片 map / reduce / 校验（含本地 LLM） | done（2026-11-10） | T-003, Q-003, Q-010 | 43/43 + 1 ignored 真 GGUF | — |
| T-004b | 远程 ASR 与回退 | done（2026-11-10） | T-003, T-006, Q-009 | 20/20 | — |
| T-004c | 离线说话人分离与降级 | done（2026-11-10） | T-001, T-003, T-011, Q-002, Q-011 | 分离 5/5 + 2 ignored 真模型、speaker 3/3 | — |
| T-005 | Markdown 渲染与降级路径 | done（2026-11-10） | T-004, T-004c | render 15/15 | — |
| T-006 | MeetingRegistry 状态机、取消、进度事件 | done（2026-11-10） | T-001, Q-004, Q-005 | 35/35 | — |
| T-007 | 命令层、契约、capability、错误码 | done（2026-11-10） | T-006 | contract 62/36/13/15 | — |
| T-008 | 结果窗口接入（query 参数 + 首屏进度 + StatusBar 分支 + 失败重试） | done（2026-11-10） | T-007 | 6/6 + 前端 13 | — |
| T-009 | 菜单、命令面板、i18n、树内音频行 | done（2026-11-10） | T-008, Q-008 | 菜单/树 211 项 | — |
| T-010 | 设置页：转写/摘要双模型、本地/远程与密钥 | done（2026-11-10） | T-007, T-011, Q-003, Q-004, Q-009, Q-010, Q-011 | settings 35/35、keys 4/4 | — |
| T-011 | 模型 manifest、下载/校验/存储（含 3 个 LLM） | todo | T-003, T-006, T-007, T-008, Q-002, Q-006, Q-010, Q-011 | none | — |
| T-012 | 单元/契约/集成/E2E 测试 | todo | T-005, T-009, T-010, T-011, T-004b, T-004c, Q-007, Q-009, Q-010, Q-011 | none | — |
| T-013 | 打包、公证、体积与许可核验 | todo | Q-001, Q-002, Q-006, Q-007, Q-010, Q-011 | none | — |
| T-014 | 文档与路线图收尾 | todo | 全部 | none | — |

状态值只允许：`todo`、`in_progress`、`blocked`、`done`、`skipped`。

---

## 5. 交付物清单

| 类型 | 路径/对象 | 预期变更 | 状态 | 证据 |
|---|---|---|---|---|
| Code | `src-tauri/src/services/meeting/` | 新增（pipeline/decode/diarize/speaker/models/download/runtime/budget/vad/asr/remote_asr/asr_route/cards/summarize/validate/render/llm/llm_local） | done | T-001~T-012 全绿 |
| Code | `src-tauri/vendor/sherpa-onnx/` | 新增（2.0.1 补丁：`ys_log_probs` 解析 + 差异说明 + Apache-2.0） | done | check-vendor --require |
| Code | `src-tauri/src/state/meeting/` | 新增（registry、job、progress、asset_scope、config、downloads） | done | T-006 35/35 |
| Code | `src-tauri/src/commands/meeting.rs`、`commands/settings.rs` | 新增/修改（任务 5、配置 2、密钥 3、模型 4、`app_settings_open`） | done | T-007 契约/权限 |
| Code | `src-tauri/src/commands/document.rs` | 修改（`build_document_window` / `create_untitled_window_with_label` 接受 query、`create_document_window` 返回窗口、`document_save_as` 仅 meeting 默认名） | done | T-008 窗口 6/6 |
| Code | `apps/desktop/src/features/meeting/` | 新增（Progress、错误态、结果接入、模型清单） | done | 前端测试与 E2E |
| Code | `apps/desktop/src/features/editor/DocumentSessionContext.tsx`、`EditorSession.ts`、`EditorPage.tsx`、`components/StatusBar.tsx` | 修改（meeting 参数分支、`insertDocumentText`、状态栏 meeting 段） | done | editor-session 测试 |
| Contract | `src-tauri/src/ipc/contract.rs`、`dto.rs`、`error.rs` | 修改（命令、事件、DTO、错误码） | done | ci:generated/ci:negative |
| Config | `src-tauri/tauri.conf.json`（确认不含模型资源）、`capabilities/*.json`、`NOTICE` | 修改 | partial | capability 已改；NOTICE/确认零模型归 T-013 |
| Script | `scripts/meeting-models/**`（拉取/哈希核对，不打包） | 新增 | done | fetch/verify/calibrate/ci-fetch |
| Config | `app_local_data_dir/meeting/config.json` + 设置页；`uiStore.ts` 仅 UI 偏好 | 新增 | done | config 13 项与迁移 |
| Test | `src-tauri/tests/meeting_*.rs`、`apps/desktop/src/features/meeting/*.test.tsx`、`e2e/meeting*.spec.ts`、`e2e/fixtures/*` | 新增 | done | Rust/浏览器/原生全绿 |
| Doc | `README.md`、`README.zh-CN.md`、`docs/roadmap.md`、`04-设计方案.md`、`03-复盘与交接.md` | 修改（两处「v1 不做 AI」撤回、评审与交接收尾） | todo | T-014 收尾 |
| Prototype | `docs/todo/meeting-minutes/prototype.html` | 新增（已产出） | done | 本目录 |

---

## 6. 数据模型 / 配置 / 接口

### 6.1 数据模型

第一版**不新增 SQLite 表**（Q-005 已裁决 A）；任务与结果驻留内存：

```rust
struct MeetingJob {
    request_id: Uuid,
    attempt: u32,                 // begin=0，retry+1；progress 内为唯一权威值
    source: MeetingSource,        // { path, bytes, duration_ms }
    window_label: String,         // 关窗取消用
    started_at: Instant,
    progress: MeetingProgress,    // 唯一快照：attempt/stage/backend/model/done/total/degraded 都在这
    partial: bool,                // >20%/DecodeFailed/Deadline 置位；retry 重置；finish 复制进 MeetingResult
    stop_reason: Option<StopReason>, // 出口表唯一输入，None→Some 只一次
    exit: Option<StopExit>,          // Releasing/Partial/Failed，None→Some 只一次
    audio_url: Option<String>,    // 建窗后 convert_file_src 写入，finish/retry 并入
    cancel: CancellationToken,
}
```

### 6.2 配置项

以下 13 项为**新增配置项**（Q-004 的 14 项口径已由 R26 修订，Q-011 已批准）；真源是 Rust `meeting/config.json`，默认值见 `04-设计方案.md §11`。设置窗只有「通用」「AI」两项，AI 分区只保留「转写模型」「摘要模型」「范围与产物」。会议开关、语言、说话人分离固定开启。

| 配置项 | 存储 | 默认值 | 行为 |
|---|---|---|---|
| `meeting.runtime.mode` | `meeting/config.json` | `auto` | `auto` 按硬件分层；`cpu` 强制纯 CPU 并关闭 LLM Metal |
| `meeting.asr.mode` | `meeting/config.json` | `local` | `local` / `remote`；远程即上传音频 |
| `meeting.asr.localModel` | `meeting/config.json` | `null`（自动） | `null` 按分层；显式值只接受 `Asr` manifest id |
| `meeting.asr.provider` | `meeting/config.json` | `openai` | `openai` / `groq` / `deepgram` |
| `meeting.asr.model` | `meeting/config.json` | 空 | 远程模型名，空用 provider 默认 |
| `meeting.asr.apiKeyRef` | `meeting/config.json` | 空（派生 `asr.<provider>`） | keyring 账户名 |
| `meeting.llm.mode` | `meeting/config.json` | `local` | `local`（llama.cpp）/ `remote`（OpenAI 兼容） |
| `meeting.llm.localModel` | `meeting/config.json` | `null`（自动） | `null` 按分层；显式值只接受 `Llm` manifest id |
| `meeting.llm.baseUrl` | `meeting/config.json` | 空 | 远程端点；空则只出抽取式 |
| `meeting.llm.model` | `meeting/config.json` | 空 | 远程模型名；空则只出抽取式 |
| `meeting.llm.apiKeyRef` | `meeting/config.json` | 空（派生 `llm.<sha8(baseUrl)>`） | keyring 账户名 |
| `meeting.keepTranscript` | `meeting/config.json` | `true` | 关则只保留摘要与引句 |
| `meeting.maxMinutes` | `meeting/config.json` | `180`（5..=600） | 超过即拒绝 |

`asr.localModel` / `llm.localModel` 的合法值来自 `services/meeting/models.rs` 的编译期 manifest（`ModelPack { id, display, kind, family, license, license_url, languages, peak_memory_mb, peak_basis, group, download_bytes, install_bytes, source, archive, files[] }`），`meeting_config_set` 校验 kind 与 `id`，非法即 `INVALID_CONFIG`。安装包不含模型，全部在设置页下载；转写组合 = 默认 ASR + 解析后的 ASR（同项去重）+ VAD + `speaker-pack`（默认 4 项，钉死非默认时 5 项；无 `combo` 字段），摘要组合 = 解析后的 LLM；`group=speaker-pack` 合并一行。

ASR 清单不变（Paraformer 默认、small、SenseVoice、Zipformer、FireRed）；Zipformer 是唯一有 token 概率的本地模型，其余显示“无置信度”。LLM 清单：

| id | 展示名 | 体积 | 峰值内存 | 许可 | 分层 |
|---|---|---:|---:|---|---|
| `qwen3-1.7b-instruct-q4km` | Qwen3 1.7B Instruct · Q4_K_M | 约 1.1 GB | 2050 MB | Apache-2.0 | ≤15 GiB 默认 |
| `qwen3-4b-instruct-q4km` | Qwen3 4B Instruct · Q4_K_M | 约 2.5 GB | 3560 MB | Apache-2.0 | 16–31 GiB 默认 |
| `qwen3-8b-instruct-q4km` | Qwen3 8B Instruct · Q4_K_M | 约 4.9 GB | 6000 MB | Apache-2.0 | 仅 ≥32 GiB 可选 |

> 说话人能力来自独立分离包（pyannote segmentation-3.0 int8 1.5 MB + CAM++ zh_en 28.3 MB），固定开启、不绑定识别模型。远程转写仅 Deepgram 有标签且为 0 基，需 +1 与跨块归一。**首次只强制转写组合 254 MB，摘要模型可选；全量约 10.2 GB，全部下载预留 ≥ 20.5 GB；分离缺失只降级，实际走本地且 ASR 缺失阻断；LLM 缺失只降级抽取式。**

运行时分层：`TierDefaults` 只依赖注入的 `HardwareProfile`；`ResolvedModels` 记录自动/钉死；设置页拿 `RuntimePreview`。ASR 第一版纯 CPU，macOS 本地 LLM 可用 Metal，Windows 纯 CPU；8B 仅 ≥32 GiB。首跑跳过 2 段预热、取 3 段中位 RTF 并按版本/模型/线程/加速缓存，>0.6 提示远程。

### 6.3 API / 对外接口

| 接口 | 变更 | 兼容性 | 验证 |
|---|---|---|---|
| `meeting_start` / `meeting_cancel` / `meeting_status` | 新增 | 无 | 同上 |
| `meeting_retry` | `requestId` → `{ requestId, attempt }`；仅 Failed 终态、同 id 复用 source/audio_url | `doc-*` / `main` | 窗口测试 |
| `meeting_take_result` | 新增 | 可重复取，窗口销毁后释放 | 同上 |
| `meeting_config_get` | 新增 `MeetingConfigView` + `RuntimePreview` + `revision` | settings、`doc-*`、`main`（只读）；`config_set` 补丁 + `expectedRevision` 仅 settings | capability 负例、冲突重取 |
| `meeting_key_status` / `meeting_key_set` / `meeting_key_clear` | 新增；`slot`，status 返回 `present/absent/keyring_unavailable`，clear 带 `all?` | 仅 settings，明文不回传 | `meeting_key` 单测 |
| `meeting_models_list` | 新增 | settings、`doc-*`、`main`；返回 manifest + 下载态 + 本地字节 | 契约负例、UI 测试 |
| `meeting_model_download` / `meeting_model_download_cancel` / `meeting_model_remove` | 新增 | settings、`doc-*`、`main`；单下载槽 | `meeting_models` 测试 |
| `app_settings_open` | 新增；`section?: "ai"` | `doc-*`、`main`、settings；错误页跳设置 | 契约负例 |
| `app://meeting-progress` | 新增事件 | `emit_to(window_label)`；仍按 id/attempt 防御 | `EVENTS` 断言 |
| `app://meeting-model-progress` | 新增事件 | settings 与发起下载的窗口 | `EVENTS` 断言 |

新增命令 15 个（任务 5、配置 2、密钥 3、模型 4、`app_settings_open` 1）：契约总数 **47 → 62**。新增错误码 9 个（含 `MODEL_DOWNLOAD_FAILED`、`MODEL_BUSY`）：`ASR_UNAVAILABLE`、`ASR_FAILED`、`MODEL_NOT_READY`、`MODEL_DOWNLOAD_FAILED`、`MODEL_BUSY`、`LLM_NOT_CONFIGURED`、`LLM_FAILED`、`MEETING_BUSY`、`INVALID_CONFIG`；另有 4 个音频码（`AUDIO_UNSUPPORTED`、`AUDIO_TOO_LARGE`、`AUDIO_TOO_LONG`、`AUDIO_DECODE_FAILED`）已随 T-001 落地；错误码总数 **27 → 36**。复用 `CANCELLED`、`PERMISSION_DENIED`。

---

## 7. 验收标准

| AC-ID | 验收项 | 覆盖任务 | 验证命令/证据 | Status |
|---|---|---|---|---|
| AC-001 | 60 s fixture 产出五个必需小节与单调时间戳；25 分钟跨窗不归零 | T-005, T-012 | `cargo test --test meeting_pipeline -- --ignored` + `meeting_time` + native E2E-018 | todo |
| AC-002 | 断网且本地 LLM 未下载时降级为抽取式并显式标注 | T-004, T-012 | `cargo test --test meeting_degrade` | todo |
| AC-003 | 结果可整体 undo；完成后直接关窗必弹保存 | T-008, T-012 | browser E2E-001 + native E2E-019 | todo |
| AC-004 | 超限音频在选文件阶段被拒 | T-001, T-012 | `cargo test --test meeting_decode` | todo |
| AC-005 | 取消后无残留线程/临时文件（ASR ≤30 s、分离 ≤60 s 内停机） | T-006, T-012 | `cargo test --test meeting_cancel` | todo |
| AC-006 | 命令/权限/生成绑定零漂移 | T-007, T-012 | `pnpm ci:generated && pnpm ci:negative` + `cargo test --test meeting_contract` | todo |
| AC-007 | 设置页配置往返、密钥不入 localStorage、模型列表与下载态往返 | T-010, T-012 | settings 35/35 + `meeting_keys` 4/4 + `commands_contract` | done |
| AC-008 | 安装包零模型、公证通过、转写组合可下载并校验、摘要模型可单独下载、NOTICE 覆盖全部模型许可 | T-013 | `make build` + E2E-004/010 + `pnpm test -- settings` | todo |
| AC-009 | 无重复实现：仅一处窗口构建、一处保存路径 | 全量 | `git grep` 窗口构建各 1 处 + `AtomicWriter` 唯一写路径 + `detect_changes` + 人工复核 | todo |
| AC-010 | 中英文案完整、无硬编码 | T-009, T-012 | `pnpm test -- i18n` | todo |
| AC-011 | 远程失败只回退一次并标注 | T-004b, T-012 | `cargo test --test meeting_remote` | todo |
| AC-012 | `asr.mode=local` 时 ASR 外传计数为 0 | T-004b, T-012 | wiremock 计数断言 | todo |
| AC-013 | 说话人标签稳定、同人同色、失败降级有标注 | T-004c, T-012 | `meeting_diarize` 真模型 2/2 + `meeting_speaker` 3/3 | done（E2E 待 T-012） |
| AC-014 | 每条结论都有时间戳与引句；缺引句渲染「待核」 | T-005, T-012 | `cargo test --test meeting_render` | todo |
| AC-015 | 英文界面与英文纪要模板完整 | T-005, T-009, T-012 | `cargo test --test meeting_render` + `pnpm test -- i18n` | todo |
| AC-016 | 分层/钉死/预算正确，`runtime.mode=cpu` 关 Metal，8B 仅 ≥32 GiB 且低配钉死被拒 | T-003, T-012 | `cargo test --test meeting_runtime --test meeting_budget` + E2E-017 | todo |
| AC-017 | 本地 LLM 缺失/超时/预算/非法 JSON/取消均降级且不阻断 | T-004, T-012 | `cargo test --test meeting_llm --test meeting_llm_local` | todo |

---

## 8. 验证入口

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test meeting_pipeline -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml --test meeting_contract
cargo test --manifest-path src-tauri/Cargo.toml --test meeting_runtime --test meeting_budget --test meeting_llm --test meeting_llm_local
cargo test --manifest-path src-tauri/Cargo.toml --test meeting_time --test meeting_contract --test meeting_decode
pnpm test -- meeting
pnpm test:e2e -- meeting
pnpm ci:tauri -- meeting
pnpm ci:local
```

| C-ID | Command | 何时运行 | 预期 |
|---|---|---|---|
| C-004 | `cargo test --test meeting_decode` | T-001 后 | PASS |
| C-005 | `cargo test --test meeting_cancel` | T-006 后 | PASS |
| C-006 | `pnpm ci:generated` | T-007 后 | PASS |
| C-009 | `pnpm test:e2e -- meeting` + `pnpm ci:tauri` | T-012 后 | PASS |
| C-999 | `pnpm ci:local && pnpm ci:tauri` | 全部任务完成后 | PASS |

---

## 9. 风险与回滚摘要

| RK-ID | 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|---|
| RK-001 | DMG 体积 | 低 | 安装包零模型；模型全在 `app_local_data_dir` | 无需回滚 |
| RK-002 | 公证失败 | 高 | T-013 提前在本地跑 `make build`；sidecar 走 `externalBin` 签名 | 回退到纯静态链接形态 |
| RK-003 | 幻觉进入纪要 | 高 | VAD 门控 + 置信度/重复率 + 引句强制 | 降级为仅转录 |
| RK-004 | 长音频内存峰值 | 中 | 逐窗单遍、逐子窗释放、相对预算、上限 10 h | 拒绝超限文件 |
| RK-005 | 中文识别质量不达预期 | 中 | 40 条样本先校准 | 换 SenseVoice（需署名） |
| RK-006 | 契约计数/权限漏改 | 中 | 同步 `COMMANDS.len()`、`commands.ts`、capability | `git revert` 单个提交 |
| RK-007 | 模型许可争议 | 高 | T-013 核验并写入 `NOTICE`；清单只收 Apache-2.0/MIT，SenseVoice 单列 | 换模型 |
| RK-008 | `menu_layout` 改动回归 | 中 | 只追加、不动顺序 + 布局断言 | 回退菜单项 |
| RK-009 | 用户误以为音频会上传 | 中 | 默认 `asr.mode=local` + 进度页按 backend 明写 | 关闭远程 |
| RK-010 | provider 条款变化/音频留存 | 中 | 域名写死、T-004b 负例覆盖 | 关闭远程 |
| RK-011 | 远程双重计费 | 中 | 只回退一次并标注 | 关闭回退 |
| RK-012 | 结果取空导致空窗口 | 中 | `meeting_status` 可重取 + `take_result` 保留到窗口销毁 | 手动重开 |
| RK-013 | 分离把同一人拆成多个编号 | 中 | 聚类阈值校准 + 同段多数投票 + 40 条样本回归；标签非身份 | 换 small 或远程 |
| RK-014 | 分离引入额外下载与内存峰值 | 中 | 同窗并行但逐子窗释放；分离预留 160 MB | 换 small 或远程 |
| RK-015 | 远程无标签被误读为「单人会议」 | 低 | 标题下按 backend 标注「远程 · 无说话人标签」 | 切 Deepgram 或本地 |
| RK-016 | 声纹误认导致责任归错 | 中 | 设置页声明「标签非身份」；卡片保留引句 | 人工改名（NEXT-002） |
| RK-017 | 可选模型许可混淆 | 中 | manifest 带许可字段，设置页逐行标注 | 移除该模型 |
| RK-018 | 首用下载失败/太慢 | 高 | 一键转写组合、续传、镜像、ASR 先下、摘要模型独立可选、磁盘提示 | 仅下载识别模型 |
| RK-019 | 全量占满磁盘 | 中 | 按公式预检、≥20.5 GB 提示、单项移除 | 清理后重试 |
| RK-020 | 高内存模型 OOM | 中 | 峰值声明 + 相对预算、32 GiB/8 GiB 门槛 | 换 small 或远程 |
| RK-021 | 本地 LLM 太慢 | 中 | 只给 1.7B/4B、分级超时、20 min 全局 deadline | 切远程或抽取式 |
| RK-022 | Metal 与 CPU 输出漂移 | 低 | 固定 seed/temperature、T-012 双跑 | 关闭 Metal |
| RK-023 | GGUF 许可/来源漂移 | 中 | 只 Apache-2.0、固定 SHA-256、NOTICE | 换等价模型 |

---

## 10. 文档索引

| 文档 | 用途 |
|---|---|
| [`00-使用说明.md`](00-使用说明.md) | LLM 执行协议、状态枚举、证据规范 |
| [`01-实施计划.md`](01-实施计划.md) | 任务队列、依赖、文件范围、调研与调用链证据、Q 清单 |
| [`02-实施状态与验证.md`](02-实施状态与验证.md) | 执行日志、命令结果、验收覆盖、最终 VERDICT |
| [`03-复盘与交接.md`](03-复盘与交接.md) | 决策、踩坑、回滚、维护与交接 |
| [`04-设计方案.md`](04-设计方案.md) | 架构、算法、数据流、降级、安全、测试与灰度 |
| [`05-多轮评审记录.md`](05-多轮评审记录.md) | R1~R39 评审 findings 与处置 |
| [`prototype.html`](prototype.html) | 高保真原型（入口、进度、结果、设置、错误态） |

---

## 11. 变更日志

| 时间 | 变更 | 作者/Agent | 证据 |
|---|---|---|---|
| 2026-11-10T00:00:00+08:00 | 创建实施控制台与设计方案 v1.0 | OpenCode | 用户需求 + 调研/调用链证据 |
| 2026-11-10T00:40:00+08:00 | R1~R6 评审完成，方案冻结 | OpenCode | `05-多轮评审记录.md` |
| 2026-11-10T01:20:00+08:00 | R7 增加 BYOK 远程通道；R8 判 REJECT 后全量修复，R9 PASS 冻结 | OpenCode | `05 §6/§7` |
| 2026-11-10T02:00:00+08:00 | R10 范围变更：内置模型清单替代 `modelTier`，说话人分离升为第一版；原型改为真实组件基线 | OpenCode | 用户 2026-11-10 指令 + 模型/许可实测 + `05 §8` |
| 2026-11-10T02:30:00+08:00 | R11 修复：窗口生命周期、单遍流水线、结果重取、模型命令边界、事件 11→13 | OpenCode | `05 §9` |
| 2026-11-10T03:00:00+08:00 | R12 修复：权限/菜单断言、错误码补全、status 先订阅、Q 依赖、name 参数、硬上限 600 | OpenCode | `05 §10` |
| 2026-11-10T03:30:00+08:00 | R13 修复：任务归属、权限 10/10 拆分、workspaceTree、60 s 分离单元、建窗回滚、菜单 enabled | OpenCode | `05 §11` |
| 2026-11-10T04:30:00+08:00 | R14 修复：menu 无参读配置、配置归属、release、VAD 打包、五格式 fixture | OpenCode | `05 §12` |
| 2026-11-10T05:00:00+08:00 | R15 修复：窗口返回类型、scope 补齐、settings 15 项、R-002 口径、T-011 依赖 | OpenCode | `05 §13` |
| 2026-11-10T05:10:00+08:00 | R16 修复：query 透传、Job last_progress、架构图分流、release_by_label、模板字段 | OpenCode | `05 §14` |
| 2026-11-10T05:20:00+08:00 | R17 修复：Destroyed 取消顺序、allow_file/audio_url、progress 单快照、回退分离条件、行号与计数 | OpenCode | `05 §15` |
| 2026-11-10T05:30:00+08:00 | R18 修复：asset 引用计数、release 返回 source、wiremock、Save As 门控、调用点与文件属主 | OpenCode | `05 §16` |
| 2026-11-10T05:40:00+08:00 | R19 修复：统一窗口返回、allow 常驻、终态按 label 保留、audio_url 入 job、交付物补齐 | OpenCode | `05 §17` |
| 2026-11-10T05:50:00+08:00 | R20 修复：allow 常驻不 forbid、set_audio_url、convert/allow 失败降级、Steps 与口径同步 | OpenCode | `05 §18` |
| 2026-11-10T06:00:00+08:00 | R21 修复：std Mutex、F-ID 去重、asset_scope 属主、Save As 双扩展名、模型拉取步骤 | OpenCode | `05 §19` |
| 2026-11-10T06:10:00+08:00 | R22 PASS；8 条 minor 修复；方案冻结待 Q 裁决 | OpenCode | `05 §20` |
| 2026-11-10T06:40:00+08:00 | R23：安装包零模型、全部下载、默认组合、FireRed/高内存/磁盘预检；Q-002 裁决 | OpenCode | 用户 2026-11-10 指令 + `05 §21` |
| 2026-11-10T07:20:00+08:00 | R23 两轮 REJECT 修复、终审 PASS；方案冻结待 Q | OpenCode | `05 §21` |
| 2026-11-10T07:40:00+08:00 | R24：设置导航收敛「通用」「AI」，会议归 AI，深链 `section=ai` | OpenCode | `05 §21` |
| 2026-11-10T07:50:00+08:00 | R25：Q-001~Q-009 全部裁决落档，无未决项；T-001 起跑 | 用户 2026-11-10 裁决 | `05 §23` |
| 2026-11-10T10:30:00+08:00 | R26：设置只留转写/摘要双模型与本地/远程；固定开启/自动语言/固定分离；本地 LLM+分层；配置 13；Q-010/Q-011 | 用户 2026-11-10 指令 | `05 §24` |
| 2026-11-10T11:00:00+08:00 | R27：Q-010=A、Q-011=A；全部 Q 关闭，T-003 起跑 | 用户 2026-11-10 裁决 | `05 §25` |
| 2026-11-10T11:30:00+08:00 | R28：七维复审 REJECT，逐窗单遍/概率补丁/预算/矩阵/E2E 全量修复 | OpenCode | `05 §26/§27` |
| 2026-11-10T14:30:00+08:00 | R29：三路定向复审判 REJECT；时间基准/Partial/E2E 接线/预算/下载修复 | OpenCode | `05 §28` |
| 2026-11-10T16:00:00+08:00 | R30：终审判 REJECT；RawAsr DTO/Partial/CI/check-vendor 修复 | OpenCode | `05 §29` |
| 2026-11-10T18:30:00+08:00 | R31：终审判 REJECT；StopReason 出口表/PartialDone、CI fixture、check-vendor require 修复 | OpenCode | `05 §30` |
| 2026-11-10T20:30:00+08:00 | R32/R33：连续复审判 REJECT；Silent 守卫/partial 链/渲染失败/vendor 下载修复 | OpenCode | `05 §31` |
| 2026-11-10T22:00:00+08:00 | R34：复审判 REJECT；StopExit/终态快照/插入重试/验收断言修复 | OpenCode | `05 §32` |
| 2026-11-10T23:30:00+08:00 | R35：复审判 REJECT；cleanup 退出码/exit!=Failed/插入重试/AC 证据修复 | OpenCode | `05 §32` |
| 2026-11-10T01:00:00+08:00 | R36：复审判 REJECT；6.2 顺序/取消路径/Option 哨兵/插入分支修复 | OpenCode | `05 §33` |
| 2026-11-10T02:30:00+08:00 | R37：复审判 REJECT；表优先级/取消边/Linux fixture/VAD 单测修复 | OpenCode | `05 §34` |
| 2026-11-10T04:00:00+08:00 | R38：复审判 REJECT；优先级列/Rendering 取消/vendor 契约/CI env/入库修复 | OpenCode | `05 §35` |
| 2026-11-10T04:00:00+08:00 | R39：复审判 REJECT；Preparing 例外/终态措辞/E2E 竞态/预检顺序修复 | OpenCode | `05 §36` |
| 2026-11-10T04:00:00+08:00 | R40：复审判 REJECT；直连措辞/终态事件/计数修复 | OpenCode | `05 §37` |
