# ADR-0002：单一保存路径与原子写

- **状态：** 已接受
- **日期：** 2026-10-26
- **决策者：** Qingmo 维护者（P1 实施）
- **关联：** 蓝图 §7.3；`04 §5.3/§7`；`01 D-004/D-005/D-021/D-024`

## 背景

P1 有四个保存触发点：手动 `Mod+S`、800ms 自动保存、窗口失焦、关闭/切换文档。若每个入口各自实现去抖、冲突判断或写盘，就会出现：

- 两套状态机，关闭时漏掉 pending；
- 自动保存与手动保存并发，旧内容覆盖新内容；
- 前端伪造 format/force/path，绕过 Rust 的编码与路径权威；
- 用 mtime/size 快路径漏掉“同大小同时间”的外部修改。

## 决策

1. **唯一保存入口：`SaveCoordinator.flush(reason)`。** 手动、自动、失焦、关闭/切换全部走同一条 `flush` 队列。
2. **调度参数固定：** 800ms 去抖、5s 最大等待、单飞（single-flight）、pending 合并、失败分类退避（最多 5 次）、冲突/只读/终态错误暂停自动保存。
3. **关闭语义：** `flush("close")` 循环保存直到 clean/终态；成功才允许关闭；冲突或终态错误先弹“仍然关闭？”确认。
4. **唯一写盘实现：`AtomicWriter::write`。** 使用 `atomic-write-file` 的 temp + commit（底层 fsync/rename）；测试覆盖 EACCES、SIGKILL、10MiB 边界。
5. **格式权威在 Rust：** 前端只发送 LF-only `text` 与可选 `expectedCurrentHash`；不发送 path、format、readOnly 或 force 布尔值。Rust 根据打开时记录的 `TextFormat` 还原 BOM/UTF-16/EOL。
6. **保存前总是重读当前字节并计算 BLAKE3。** 没有 mtime/size 快路径；只有当前 hash 与 `base_hash` 不同时，才接受与当前磁盘 hash 完全相等的 `expectedCurrentHash` 作为用户确认的精确覆盖。
7. **写侧上限：** 编码后的字节数仍受 `MAX_FILE_BYTES`（10MiB）约束；超限拒绝且旧文件不变。

## 后果

**正面：**

- 关闭、失焦、手动、自动共享同一套 pending/冲突/退避语义。
- 用户确认覆盖必须匹配“当前磁盘版本”的精确 hash；二次冲突不会被第一次确认绕过。
- 前端无法改变编码/EOL 或绕过路径/只读限制。

**代价/限制：**

- 每次保存都重读全文并 hash，10MiB 保存有固定成本（C-106：Rust save p50 20.31ms；真实 Tauri 449.1ms 上界）。
- `expectedCurrentHash` 只消除“读到 hash 到 rename 之间”的部分窗口；P1 仍存在残余 TOCTOU，P2 watcher/文件锁解决。
- 没有备份/版本历史；保存失败依赖内存保留，P2 补恢复。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 每个入口各自保存 | pending/冲突/关闭语义分叉，无法证明不丢内容 |
| mtime/size 快路径 | 外部修改可能同大小同时间，漏冲突 |
| 前端传 format/force | 前端可伪造编码/EOL/强制覆盖，Rust 失去权威 |
| 只用 `fs::write` | 非原子，崩溃可能半写 |
| 每次保存前加文件锁 | P1 跨平台锁语义复杂；先以 always-hash + 精确确认控制风险 |

## 证据

- C-046：冲突 details、精确覆盖、二次冲突、只读、缺失、IPC 往返、伪造 token。
- C-076：800ms/5s、单飞、pending、close/blur、冲突/二次冲突、reload、退避、终态、只读、dispose。
- C-081/C-084~C-086：冲突取消/仍要关闭、脏编辑红叉、Cmd+Q 先 flush 后退出。
- C-110：Rust 59 条测试，含 UTF-8/UTF-16 BOM/EOL 的 open→save→新 registry 重开、10MiB 精确上限。
- C-109：浏览器 E2E 覆盖自动保存、冲突重载/二次冲突、关闭守卫。

## 未决问题（P2 前置）

- watcher 只能接入 `SaveCoordinator`，不得另起保存路径。
- 备份/崩溃恢复/版本历史必须先定义磁盘布局与清理策略。
- 残余 TOCTOU 需要文件锁、目录锁或 watcher 事件序列化方案。
