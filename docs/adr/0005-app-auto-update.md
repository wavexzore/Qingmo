# ADR-0005：macOS 应用自动更新

- **状态：** 已接受
- **日期：** 2026-10-27
- **决策者：** Qingmo 维护者（P2 发布能力）
- **关联：** 蓝图 §9.3/§9.4/§12；`docs/todo/app-auto-update/04 §5/§6/§13`；`01 D-001~D-022`；Q-001~Q-012

## 背景

蓝图把自动更新写成一句话（“Tauri updater，签名 manifest；stable/beta 双通道；失败自动回滚”），但这句话与官方 `tauri-plugin-updater` 的实际能力不一致：

- 插件签名的是**更新产物**（`.app.tar.gz` 的 minisign 签名），不是 `latest.json` 文档本身；
- `requireSignedVersion=true` 只把签名 trusted comment 中的 `version:` 与清单版本绑定，无法阻止清单被替换/冻结；
- 静态 `latest.json` 不支持按百分比灰度，也没有跨版本自动回滚；
- 更新安装必须复用现有保存路径，否则 macOS `request_restart()` 会丢未保存内容。

同时，更新是**代码执行入口**：如果 WebView 能直接调用 `updater:*`，XSS 就能绕过 UI 保存确认直接安装。因此更新只能由 Rust 状态机驱动，前端只镜像快照与事件。

## 决策

### 1. 平台与通道

1. **仅 macOS universal**（`darwin-aarch64` + `darwin-x86_64`）发布自动更新；Windows/Linux/移动端不在首版范围，统一进入 `NEXT-AU-007`。
2. **仅 stable 通道**：静态 `latest.json` 固定指向 GitHub Releases 最新正式版；beta/用户切换通道进入 `NEXT-AU-002`。
3. **不做百分比灰度**：静态清单没有分流能力。发布前的 draft + 人工验证是唯一的软灰度；坏版本通过撤下 release + hotfix 处理。

### 2. 两套独立信任根

| 用途 | 机制 | 密钥/凭据位置 |
|---|---|---|
| 应用代码签名 | Xcode `Developer ID Application` + Apple 公证/stapling | 从 Xcode 导出 `.p12`；只放本机 `.release/certs/` 与 `.release/secrets/`（gitignored）；公证凭据在 `~/.tauri/` 与本地脚本环境变量 |
| 更新产物签名 | `tauri-plugin-updater` 的 minisign | 私钥离线生成；只放本机 `~/.tauri/`（0600）；公钥写入 `tauri.conf.json` |

> 本地发布为主：GitHub Actions 通道仅作可选模板保留，当前 `release` Environment 与 secrets 已删除；密钥不得入库、不得上传。

- **不得复用**插件市场的 Ed25519 密钥、Apple 证书或任何 CI 通用密钥。
- updater 私钥丢失后，已安装客户端无法验证新版本，只能要求用户手工安装新公钥版本；轮换 runbook 必须随发布文档维护。
- 公钥是公开配置，不是秘密；私钥不得入库、不得打印、不得进入构建产物。

### 3. Rust 是唯一状态机

1. `UpdateManager` 持有 `phase`、`generation`、进度、已下载 `Update`/artifact 与 `is_installing`；所有转换在同一锁内完成。
2. 前端只通过 4 条命令和 2 条事件观察/触发：`app_update_status`、`app_update_check`、`app_update_download`、`app_update_install`；`app://update-state`、`app://update-progress`。
3. 新增 4 条 `allow-app-update-*` 权限；**不授予 `updater:*`**，前端不直接 import 更新插件，也不接触下载 URL、签名或安装路径。
4. 单飞：检查/下载/安装期间重复命令返回 `BUSY`；前置 phase 不满足返回 `UPDATE_NOT_READY`。
5. 更新错误使用 6 个稳定错误码：`UPDATE_CHECK_FAILED`、`UPDATE_DOWNLOAD_FAILED`、`UPDATE_SIGNATURE_INVALID`、`UPDATE_INSTALL_FAILED`、`UPDATE_UNSUPPORTED`、`UPDATE_NOT_READY`；前端不解析字符串。

### 4. 安装前的保存与关闭门闩

1. 安装前必须调用现有 `SaveCoordinator.flush("close")`；冲突或终态错误时**不调用** `app_update_install`，保留 `Ready` 并提示用户。
2. `CloseGuard` 增加 `Installing`/`Exiting` 终态与 `confirm(allow)`：安装开始后关闭请求被拒绝（`BUSY`），避免安装与退出竞态；`begin`/`begin_install`/`confirm` 共用同一 Mutex。
3. macOS 安装完成后由应用调用 `request_restart()`；命令可能不返回，前端不得依赖其 Promise 做清理。
4. 保存是 **UI 保证**，不是安全边界：XSS 仍可直接调用 `app_update_install`，但无法跳过 Rust 的 phase/签名/关闭检查。

### 5. 清单与网络

1. 端点固定为 GitHub Releases 公共仓库的 `releases/latest/download/latest.json`；仅 HTTPS，`https_only(true)`。
2. `latest.json` 作为文档**不签名**；每个平台产物的 `signature` 是 minisign 签名；`requireSignedVersion=true` 把签名中的 `version:` 与清单版本绑定。
3. `allowDowngrades=false`；只接受更高 semver 且签名版本一致的产物。
4. 下载 URL 必须为 HTTPS，主机限定 GitHub 资产域名；notes 按纯文本渲染，有字节上限。
5. 检查超时 30s、下载超时 10min、进度事件 100ms 节流；失败回退到 `Available`/`Idle`，不弹阻塞对话框。

### 6. 不新增用户配置与持久化

- 不新增 settings 文件、数据表、迁移或 localStorage 键；更新状态只存在于 Rust 内存与前端镜像。
- 不新增用户可见的更新开关；启动后静默检查 + 横幅，下载/安装始终由用户确认。
- 构建配置仅新增 `createUpdaterArtifacts` 与 `plugins.updater`（Q-008 已批准）。

### 7. 发布门禁

1. tag 触发单一 release workflow；先建 draft，再在 `macos-15` 上以 `--target universal-apple-darwin` 构建 `.app.tar.gz`/`.sig` 与 dmg。
2. `check-versions.mjs` 校验 5 个 `package.json`、`Cargo.toml`、`tauri.conf.json`、`Cargo.lock` 与 tag 一致；不一致即失败。
3. `check-latest-json.mjs` 用公钥验签、校验 trusted comment 版本、平台键、URL 主机、notes 上限与资产归属；`--no-network` 只做结构 lint。
4. 发布前人工确认 draft 资产与公证结果，再取消 draft；签名私钥只在 build job 可见，publish 审批不接触私钥。
5. **无自动回滚**：安装失败尽量保留旧版本；已安装坏版本只能 hotfix。

## 实施状态（2026-10-27）

- **已完成：** T-001~T-010、T-012、T-013 已实现并通过本地验证；T-011 的静态 workflow/`check-latest-json`/`make-latest-json`/`build-local.sh` 与本地 universal 发布链路已完成；T-014 的本地全量、universal 构建、Developer ID 签名、App+DMG 公证、`latest.json` 验签已完成。插件 2.14.0 注册、9 命令/3 事件/19 错误码/9 权限契约、`UpdateManager` 状态机、4 条 Rust 命令与超时/进度/错误分类、`CloseGuard` 安装门闩、`UpdatePort` + Tauri/Fake、Controller/Provider、命令面板/横幅/对话框/i18n、零网络 E2E、契约/权限负例均通过。
- **验证证据：** `02 C-014~C-026`；Rust 全 target、前端 298 tests、E2E 52 tests、`pnpm ci:negative`、`cargo fmt/clippy`、`depcruise`、版本门禁、9+9 发布脚本正负例、真实 16 MB universal 产物签名/公证/清单验签均通过。
- **未完成：** T-014 的 macOS Apple Silicon/Intel 真机安装/重启冒烟；T-011 的 GitHub Actions 发布通道已按本地优先决策停用（`release` Environment/secrets 已删除），本地 universal 发布链路已完成并通过 C-026。
- **偏差：** 命令 `app.checkForUpdates` 在 `installing` 外可用；`checking/downloading` 执行时提示忙（`04 §5.7`），而非在 `when` 中全部隐藏。更新对话框/横幅均只读 Rust 快照；开发模式（`import.meta.env.DEV`）默认关闭启动静默检查。
- **结论：** ADR 决策未变更；功能仍为 `in_progress` / `PARTIAL`，不得宣称已完成公开分发验收。

## 后果

**正面：**

- 更新路径与现有保存/关闭状态机对齐，安装前不丢文档。
- WebView 没有 updater 权限，XSS 不能直接下载/安装或读取下载 URL。
- 两套信任根分离，Apple 证书与 updater 私钥互不牵连。
- 版本、清单、权限与 DTO 都由单一源和 CI 门禁约束。

**代价/限制：**

- 首版仅 macOS；Windows/Linux、beta、灰度、回滚均需后续立项。
- 清单未签名，存在冻结/替换导致的 DoS 与社工风险；只能靠 HTTPS、签名版本绑定、撤下 release 与人工审核缓解。
- 私钥丢失/泄露没有在线撤销机制；旧客户端只能靠安全公告与过渡版本处理。
- 安装中关闭被阻断；若安装卡住，用户需要强制退出。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| WebView 直接使用 `updater:*` | XSS 可绕过保存确认；下载 URL/签名进入前端；权限面扩大 |
| 自建更新服务/百分比灰度 | 需要服务端、监控与新配置；超出 MVP，进入 `NEXT-AU-002` |
| 自建下载/回滚备份 | 需要额外磁盘与恢复状态机；与“安装失败保留旧版本”重复，风险高 |
| 复用插件市场 Ed25519 密钥 | 信任域混用；插件密钥轮换会连带破坏应用更新 |
| 不签名更新产物 | 任意仓库写入者即可投递代码；不可接受 |
| 支持 Windows/Linux 首版 | NSIS/AppImage/GLIBC/UAC 语义未验证，拖慢 macOS 闭环；进入 `NEXT-AU-007` |

## 证据

- 设计：`04 §5.1/§5.2/§5.4/§5.8/§6.4/§13`；任务：`01 T-001~T-014`。
- 现有保存/关闭：`ADR-0002`、`ADR-0004`；`SaveCoordinator.flush("close")` 与 `CloseGuard` 已由 C-081/C-112 验证。
- 契约基线：5 命令/1 事件/13 错误码/5 权限（`ADR-0003`）；目标 9 命令/3 事件/19 错误码/9 权限。
- 官方插件行为：`tauri-plugin-updater 2.14.0` 的 `download`/`install`/`verify`、`requireSignedVersion`、`SignedVersionMismatch`；`01 §2.4` 已记录来源与版本。
- 发布门禁：`04 §5.8` 的 `check-versions`/`check-latest-json`/`release.yml` 设计与 `01 T-011/T-012`。

## 残余风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 清单未签名/冻结 | 无法发现更新或被迫停留旧版 | HTTPS、签名版本绑定、撤下 release、hotfix |
| 私钥丢失/泄露 | 更新链失效或被投毒 | 离线备份、Environment、轮换 runbook、安全公告 |
| 无百分比灰度 | 坏版本影响全量 | draft 验证、公告软灰度、快速撤下 |
| 无自动回滚 | 安装失败可能不可用 | 插件保留旧版本；hotfix；手工重装说明 |
| 首版用户无法自动更新 | 需手工安装一次 | 发布说明明确；`RK-018` |
| 安装中强制退出 | 应用可能处于半安装态 | 关闭门闩 + 插件恢复；发布冒烟覆盖 |

## 未决问题（后续立项）

- `NEXT-AU-002`：beta/服务端通道、百分比灰度、自动回滚、密钥轮换自动化。
- `NEXT-AU-007`：Windows/Linux 打包、签名与安装语义。
- 是否引入 TUF/元数据签名，需先评估服务端与客户端复杂度。
