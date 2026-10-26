# ADR-0004：路径 token 与 Rust CloseGuard

- **状态：** 已接受
- **日期：** 2026-10-26
- **决策者：** Qingmo 维护者（P1 实施）
- **关联：** 蓝图 §9.2/§9.3；`04 §6.5/§7.2/§13.2`；`01 D-006/D-022`

## 背景

两条边界不能用“前端自觉”保证：

1. **路径边界。** 如果前端调用 dialog 并把 `path` 传给 Rust，任何被攻破的 WebView 都可以自服务任意路径；Rust 的“允许列表”无法区分用户选择与恶意代码构造。
2. **关闭边界。** macOS 的 Cmd+Q 走 `NSApplication terminate:`，可能绕过 `RunEvent::ExitRequested`；如果关闭时不先 flush，未保存内容会丢失。

## 决策

### 路径与 token

1. **原生 dialog 在 Rust：** `document_open` 内部调用 `tauri-plugin-dialog` 的 `pick_file`；前端没有 `dialog:allow-open` 权限，也不接收/提交 path。
2. **不透明 token：** 打开成功后 Rust 生成 UUID `docToken`；前端只持有 token、显示用 canonical path、格式/大小/只读等元数据。
3. **单文档：** P1 `DocumentRegistry` 只保留一个活动文档；成功 open 会先清空旧 token，旧 token 随后返回 `INVALID_PATH`。
4. **raw + canonical：** 同时记录 dialog 返回的 `raw_selected` 与实际读写的 `canonical_target`；`reload` 重新 canonicalize，若符号链接指向变化则返回 `OUTSIDE_SCOPE`，防止替换攻击。
5. **扩展名/大小/编码校验在 Rust：** `.md/.markdown/.mdx`；`.mdx` 只读；10MiB 上限；UTF-8/UTF-16 BOM 严格解码；混合 EOL/UTF-32/无 BOM UTF-16 拒绝或只读。
6. **保存只接受 token：** `document_write_atomic` 不接收 path/format/force；Rust 根据 token 找到 record，并在锁内完成 hash/编码/原子写。

### 关闭守卫

1. **Rust 是唯一退出决策点：** 红叉、Cmd+Q、Dock Quit 都先进入 `CloseGuard::begin(reason)`；已有 pending 时不再发第二个事件。
2. **一个事件：** `app://close-requested` 携带 `{ reason: "window" | "exit" }`；前端 `useCloseGuard` 收到后调用 `SaveCoordinator.flush("close")`。
3. **一个确认命令：** `app_close_confirm { allow }`；`allow=true` 仅在存在 pending 请求时被接受，然后 `app.exit(0)`；`allow=false` 清空 pending，窗口保留。
4. **失败路径：** 事件 emit 失败会 `cancel()`，避免窗口永久无法关闭；前端 flush 冲突/终态错误时弹“仍然关闭？”；用户取消则 `allow=false`。
5. **macOS 菜单：** 自定义 Quit 菜单项复用同一 CloseGuard 路径，替代默认 `terminate:`，不扩展其他原生菜单功能。

## 后果

**正面：**

- 前端无法打开任意路径，也无法在没有 Rust 授权的情况下退出。
- 符号链接替换、伪造/过期 token 都有明确错误码与测试。
- 关闭前 flush 与冲突确认共享同一保存状态机。

**代价/限制：**

- P1 只能单文档；多窗口/工作区需要扩展 token 生命周期与 registry。
- 前端关闭事件必须及时处理；若 WebView 卡死，用户可能无法通过红叉退出（仍需保留强制退出手段，P2 评估）。
- `app_close_confirm` 是应用级命令，必须在 capability 中显式允许；新增窗口需单独授权。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 前端 dialog + path 入参 | 路径 jail 可被前端自服务，不构成安全边界 |
| 直接把绝对路径当 token | 路径可伪造/重放；无法表达过期与单文档生命周期 |
| 只依赖 `ExitRequested` | macOS Cmd+Q 可能绕过，C-086 已实证 |
| 前端直接 `window.close()` | 绕过 Rust 确认与 flush |
| 多文档 registry（P1） | 无工作区/标签页 UI，生命周期与关闭语义未设计 |

## 证据

- C-037：token、符号链接、编码/EOL、10MiB、MDX、目录、权限等 11 条。
- C-041：原生 dialog 返回 canonical path；text 仅 LF。
- C-046：伪造 token、冲突、精确覆盖、IPC 往返。
- C-081：clean/脏/冲突/终态错误关闭、blur+IME、重复关闭。
- C-084/C-085/C-086：冲突态红叉取消/仍要关闭；脏编辑红叉与 Cmd+Q 均先落盘。
- C-112：真实 Tauri 红叉取消/仍要关闭；日志 `close request cancelled by user` / `close request confirmed; exiting`。

## 未决问题（P2 前置）

- 工作区/多文档的 token 生命周期、窗口 label 与 capability 粒度。
- 强制退出/无响应 WebView 的兜底策略。
- watcher 与符号链接替换检测的协同。
