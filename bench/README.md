# T-017 性能基准

本目录记录 Qingmo P1 编辑器的可复现性能基线。P1 **只记录，不设门禁**；目的不是证明“16ms/10MiB”，而是让 open / decorate / key / save / IPC / RSS 有明确口径和可重复的数字。

## 快速运行

```bash
pnpm bench            # 生成 fixtures -> Node/jsdom 基准 -> Rust AtomicWriter 基准 -> 合并报告
pnpm bench:fixtures   # 只重新生成确定性 Markdown fixtures
pnpm typecheck:bench  # 只检查 bench 代码类型
```

报告输出到 `bench/results/<YYYY-MM-DD>.json` 与同名 `.md`；逐进程原始数据在 `bench/results/.raw/`（已忽略）。

单尺寸调试：

```bash
BENCH_FIXTURE=medium pnpm exec vitest run --config vitest.bench.config.ts
BENCH_FIXTURE=large pnpm exec vitest run --config vitest.bench.config.ts bench/save.bench.ts
BENCH_SKIP_RUST=1 pnpm bench
```

## Fixtures

`bench/generate-fixtures.mjs` 用固定顺序的 Markdown 块（标题、强调、行内代码、链接、列表、引用、代码块、分隔线）生成：

| Fixture | 目标大小 | 行数（当前） | 是否入库 |
|---|---:|---:|---|
| `small.md` | 10 KiB（10,240 B） | 419 | 是 |
| `medium.md` | 1 MiB（1,048,576 B） | 41,618 | 是 |
| `large.md` | 10 MiB（10,485,760 B） | 408,423 | 否（`.gitignore`，运行时生成） |

生成是确定性的：`manifest.json` 记录字节数与 SHA-256；`pnpm bench` 每次都重新生成，若小/中 fixture 被手改会得到不同哈希。10 MiB 不提交，避免仓库膨胀；任何拿到仓库的人都能用 `pnpm bench:fixtures` 复现同一文件。

> `large.md` 正好等于 10 MiB 上限。`save.bench.ts` 用“替换末尾 3 字节”而不是追加，确保不会因为超过上限而被拒绝。

## 指标口径

| 指标 | 测量方式 | 不是什么 |
|---|---|---|
| `open_ms` | `EditorSession.create(payload)`，即 `createEditorState`；包含 Markdown/语言扩展初始化、2M 单元阈值判断 | 不含原生读盘、Tauri IPC 传输、首次 DOM 渲染 |
| `ipc_copy_ms` | `JSON.stringify` + `JSON.parse` 一个 `FilePayload` | 不是真实 Tauri 传输；只是字符串跨边界的代理值 |
| `decorate_ms` | 80 行视口 + `ensureSyntaxTree(8ms)` + `buildLivePreviewDecorations`；10 KiB/1 MiB 另挂真实 `EditorView` 记录 `viewMountMs` | 不是像素级重绘时间 |
| `key_p95_ms` | 单字符 dispatch/update 的 p95。10 KiB/1 MiB 用真实 `EditorView.dispatch`；10 MiB 关闭 LP 后用 `EditorState.update` | 10 MiB 不含渲染/合成器；不代表真实键盘端到端 |
| `save_ms` | release 构建的 `AtomicWriter::write`：锁内重读 + BLAKE3 + 编码 + `atomic-write-file` 提交；临时副本 | 不是 Tauri 命令/IPC 往返 |
| `max_rss_mb` | 真实 Tauri 打开文件后 `ps -o rss= -p <pid>` | 不是峰值，不含 WebView 多进程的完整 footprint |
| `view_mount_ms` | jsdom 中 `new EditorView({state, parent})` 的耗时 | 不是浏览器首屏；jsdom 无布局 |
| `fake_save_ms` | `FakeIpc.documentWriteAtomic`（UTF-8 编码 + FNV 哈希 + 字符串替换） | 不是磁盘 I/O；只用于对比 JS 侧成本 |

10 MiB 默认关闭 Live Preview（`LP_MAX_UNITS = 2_000_000`），所以 `decorate_ms` 记为 `skipped`、装饰规格为 0，而不是伪造一个全量装饰耗时。`open_ms` 对 10 MiB 只是状态创建；真实首屏以手动 Tauri 的 AX 上界为准。

## 真实 Tauri 手动记录

自动化部分不启动 GUI。真实应用的打开/保存/RSS 通过 `bench/results/tauri-manual.json` 合并：

```json
{
  "capturedAt": "2026-10-26T18:30:00+08:00",
  "method": "AX poll upper bound; ps -o rss= after open",
  "fixtures": {
    "small": { "openMs": 120, "saveMs": 80, "rssMb": 180, "livePreview": true, "notes": "" },
    "medium": { "openMs": 180, "saveMs": 90, "rssMb": 260, "livePreview": true, "notes": "" },
    "large": { "openMs": 4500, "saveMs": 400, "rssMb": 900, "livePreview": false, "notes": "大文档 · 预览关闭" }
  }
}
```

记录方法：

1. `pnpm tauri dev`，用原生对话框打开对应 fixture 的副本。
2. 用 Accessibility API 轮询文档标题/状态栏出现的时间，作为 `openMs` 上界（轮询本身有开销，真实值只会更低）。
3. 编辑一个字符后 `Cmd+S`，轮询“已同步”出现时间，作为 `saveMs` 上界。
4. `ps -o rss= -p <pid>` 记录打开后的 RSS。
5. 10 MiB 必须确认状态栏显示“大文档 · 预览关闭”。

本仓库的 `bench/tauri/measure.swift` 实现了上述轮询（macOS Accessibility）：

```bash
pnpm tauri dev
# 另开终端；<pid> 为 target/debug/qingmo 进程
swift bench/tauri/measure.swift <pid> bench-large-1.md 180
```

脚本会通过 Cmd+O 打开原生面板、按文件名选中并点 Open，轮询“标题 + 编辑器就绪”作为 open 上界；随后聚焦编辑器，10 MiB 用前向删除（避免越过 10 MiB 上限）、其余插入 `z`，再按 Cmd+S 并轮询“已同步”作为 save 上界。目标文件应是仓库根目录下的**临时副本**，不要直接编辑 fixture。

该文件是可选的：不存在时报告仍会生成，只是标记“不含真实 Tauri 数据”。

## 环境与复现

当前基线在 macOS（Apple M3 Max，arm64）、Node 26.12.1、Rust 1.91.1 上采集。数字会受 CPU 频率、磁盘缓存、后台负载影响；比较时请用同一台机器、同一 fixture、同一 release 构建。P1 不把任何阈值写进 CI；T-019 只跑功能/契约/构建门禁。

## 已知限制

- jsdom 没有真实布局/合成器，`key_p95_ms` 与 `view_mount_ms` 不能替代浏览器 Performance 面板。
- `ipc_copy_ms` 是 JSON 往返代理，真实 Tauri IPC 的序列化/协议开销未单独拆分。
- Node 的 `maxRSS` 是进程峰值；Tauri 的 `ps` 是打开后的瞬时 RSS，两者不可直接相加。
- 10 MiB 的 `decorate_ms` 为 skipped；若未来调高 `LP_MAX_UNITS`，这里必须重新测，不能沿用本基线。
