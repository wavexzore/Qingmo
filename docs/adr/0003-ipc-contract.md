# ADR-0003：IPC 契约与生成类型

- **状态：** 已接受
- **日期：** 2026-10-26
- **决策者：** Qingmo 维护者（P1 实施）
- **关联：** 蓝图 ADR-007；`04 §6/§13`；`01 D-007/D-008/D-016`

## 背景

Tauri 2 的 invoke 是动态字符串边界：命令名、事件名、DTO 字段、capability 权限、`build.rs` 权限生成与前端镜像很容易漂移。参考方案 `tauri-specta` v2 在 P1 期间仍是 RC，不适合作为唯一契约来源。P1 需要一条可测试、可生成、可负例复现的契约链。

## 决策

1. **命令/事件单一源：** `src-tauri/src/ipc/contract.rs` 定义 5 条命令与 1 个事件：
   - `document_open`
   - `document_reload`
   - `document_save_as`
   - `document_write_atomic`
   - `app_close_confirm`
   - `app://close-requested`
2. **权限映射：** `command_permission("document_open") -> "allow-document-open"`；`build.rs` 与 `capabilities/default.json` 都从同一命名规则校验，不手写第二套。
3. **DTO 单一源：** Rust `serde` 类型 + `ts-rs` 生成 `packages/shared/src/generated/`；生成文件提交仓库，CI 重跑并要求 `git status --porcelain` 为空。
4. **前端镜像：** `apps/desktop/src/lib/ipc/contract.ts`/`commands.ts` 保留命令名与权限映射；契约测试同时检查 Rust 常量、TS 镜像、capability、build.rs 与生成 DTO。
5. **端口边界：** React 组件只依赖 `IpcPort`/`PlatformPort`；只有 `lib/ipc/tauri.ts`、`lib/platform/tauri.ts` 可以 import `@tauri-apps/*`，由 dependency-cruiser 强制。
6. **错误形状：** 所有命令返回统一 `AppError { code, message, details? }`；前端 `normalizeError` 映射为可 i18n 的错误对象，不解析字符串。
7. **最小权限：** capability 仅保留 2 条 core event 权限 + 5 条应用命令 `allow-*`；不使用 `core:default`，不开放 fs/dialog 前端权限。

## 与蓝图 ADR-007 的偏差

蓝图 ADR-007 写的是“pnpm workspace + 共享 Zod schema”。P1 实际采用：

- pnpm workspace：保留；
- 共享类型：`ts-rs` 生成 + 手写 TS 镜像 + 契约测试；
- Zod：**未引入**。P1 的 IPC 边界校验由 Rust serde/命令实现完成，前端不需要第二套运行时 schema；引入 Zod 会增加一份类型真源与打包体积。

这是**有意的 P1 简化**，不是遗忘。P2 若出现插件 RPC、用户配置或不可信外部输入，再评估在 `shared` 引入 Zod，并保持 Rust 为持久化/文件边界权威。

## 后果

**正面：**

- 命令/事件/权限/DTO 的漂移会在 CI 失败，而不是运行时 404。
- 生成文件可审查，`ts-rs` 重复运行稳定。
- 前端无法绕过 `IpcPort` 直连 Tauri；测试可用 fake adapter。

**代价/限制：**

- 新增命令需要同步 Rust 常量、TS 镜像、capability、生成类型与契约测试；步骤多但可脚本化。
- 没有运行时 Zod 校验；前端只信任类型，Rust 必须继续做完整校验。
- `tauri-specta` 的自动客户端生成仍未采用；P3 前再评估。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| `tauri-specta` v2 RC | 版本不稳定；生成器行为不可控 |
| 只靠 TypeScript 手写类型 | 无 Rust 单一源，字段漂移无法自动发现 |
| 全面引入 Zod | 与 Rust serde 重复；P1 无不可信前端输入场景 |
| 前端直接 `invoke("...")` | 组件耦合 Tauri，E2E/fake 与依赖边界失效 |

## 证据

- C-028：Rust 契约 6 条（命令/事件镜像、capability、build.rs、DTO/错误 wire name、命令注册、reload 假 token）。
- C-029：前端契约 4 条（命令名、权限映射、close 事件、SaveRequest 可选 hash）。
- C-030/C-031：ts-rs 生成 13 个文件且重复运行稳定。
- C-117：Ubuntu 24.04 容器中契约 6 + 安全配置 3 + generated + 负例通过；Linux clippy `-D warnings`。
- C-053/C-054：依赖边界探针拦截越界 import。

## 未决问题（P2 前置）

- 新增工作区/搜索/设置命令时，`COMMANDS` 与 capability 必须同批更新。
- 若引入插件 RPC 或用户配置，重新评估 `shared` 的 Zod/运行时 schema。
- 生成文件检查已进 CI；本地开发需在改 DTO 后运行 `pnpm ci:generated`。
