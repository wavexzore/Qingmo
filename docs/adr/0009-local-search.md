# ADR-0009：本地全文检索（SQLite/FTS5 缓存）

- **状态：** 已接受
- **日期：** 2026-11-08
- **决策者：** Qingmo 维护者（P1 实施）
- **关联：** 蓝图 §9；`trusted-data-search 04 §6/§9/§10/§17`；`01 D-110~D-112`；ADR-0002、ADR-0008

## 背景

工作区需要跨文件的本地全文检索，要求：

- 中文 1–2 字不静默为空；
- 10k 文件索引 < 60s、100k 查询 p95 < 200ms；
- 索引可随时删除并重建，Markdown 永远是真源；
- 查询不出工作区，不上传、不记录查询词；
- 前端不接触 SQL、数据库路径或文件系统。

候选方案包括前端直连数据库、Rust 内存倒排、SQLite/FTS5。前两者会分别破坏“Rust 独占 IO”和“可重建/低内存”的边界，最终选择 SQLite/FTS5，并由 Rust 独占。

## 决策

### 1. 定位与所有权

1. **索引是 cache：** 位于 `app_local_data_dir/index/index.sqlite`；删除 `index/` 后下次打开工作区自动重建，不影响任何 Markdown。
2. **Rust 独占：** 前端只调用 `workspace_search` / `workspace_search_status` / `workspace_search_rebuild` 等命令；不暴露 SQL、DB 路径或 `rusqlite` 类型。
3. **schema：** `workspaces(key, root, last_seen_ms)`、`documents(id, workspace_key, path, abs_path, title, mtime_ms, size_bytes, hash, indexed_at_ms)`、`documents_fts(title, body, tokenize=trigram)`、`documents_fts_short(terms, tokenize=unicode61, content='', contentless_delete=1)`、`index_meta`。
4. **schema 版本：** `INDEX_SCHEMA_VERSION = 2`。打开时若 `user_version` 更低，直接删除 FTS/文档表并重建（索引无主数据，迁移不如重建可靠）；更高则返回 `INDEX_DISABLED`，防止旧 app 写坏新索引。

### 2. 连接与写入

1. **两个连接：** 一个写连接（`Mutex`）、一个 WAL 读连接（`Mutex`）；`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。
2. **事务：** `documents` 与两张 FTS 表的插入/删除在同一事务内；删除顺序为先 FTS 后 `documents`。
3. **增量：** 文件 watcher 只把索引当成 existing refresh 的额外消费者，不改变 `should_refresh` 语义；保存成功后 500ms 目标内 upsert，外部修改 2s 目标内 upsert。
4. **全量扫描：** `scan_root` 以 `hash + mtime + size` 去重；超过 100k 文件或 512 MiB 正文时停止并置 `truncated=true`。扫描中的 generation 可被新扫描取代，旧扫描在检查点退出。
5. **压缩：** FTS `optimize` 后在 `freelist_count >= 256` 且扫描未截断时执行 `VACUUM`，控制 segment 合并留下的空闲页。

### 3. 查询算法

1. **解析：** `search_query::parse` 限制 16 个词、单词 200 字符、整句 1024 字符；支持引号短语与 `-排除`；所有 `MATCH` 表达式参数化并转义，禁止 FTS 语法注入。
2. **分表：** 每个 include/exclude 词按 token 形态路由到 trigram 或 short 表。CJK 1 字 → short unigram；2 字 → short bigram（精确相邻，不再用 phrase 两 token）；≥3 字 → trigram。拉丁 1–2 字符 → short 前缀。
3. **每表取集合：** 对每张表执行一次 `MATCH ... JOIN documents`，拿到该表的 `rowid → mtime` 全集；**不做跨 FTS 表的 SQL JOIN**。FTS5 的 rank 有序扫描无法与另一张虚拟表的 rowid 过滤同时保持，否则会退化为逐行回查（实测 10k 语料 31s）。
4. **求交与评分：** 在 Rust 侧对多表 rowid 求交；命中数 ≤ `SEARCH_SCORE_LIMIT = 2000` 时才查询 bm25 并加权（trigram `bm25(10,1)` + short `0.5×bm25`），否则视为 broad term，只过滤并按 `mtime_ms` 倒序。排序为 score 升序（bm25 越小越相关）、再 mtime 倒序。
5. **排除：** 排除词在对应表内拼成 `NOT (...)`；若排除词只存在于另一张表，则单独取其 rowid 全集并从候选中删除——排除是“全集”语义，不能只删 top-N。
6. **分页与片段：** 先求交/排序/分页，只对最终页取 metadata 与正文；snippet 用 `plain_snippet` 在正文中定位首个包含词，最多 240 字符，不把整篇正文返回前端。
7. **超时：** 每次查询在读连接上安装 `progress_handler(1000, deadline=500ms)`，RAII guard 在所有返回路径清除；SQLite 中断（`OperationInterrupted`）映射为 `SEARCH_TIMEOUT`，`details.timeoutMs = 500`。宽查询不得静默返回空。

### 4. 隔离与隐私

1. **工作区隔离：** 每个查询都 `JOIN documents` 并强制 `workspace_key`；`workspace_key = blake3(canonical root)[..32]`。即使 FTS 表有孤儿行，也不能跨工作区泄漏。
2. **隐私：** 索引只在本机 app data；日志记录 mode/词数/耗时/结果数，不记录查询词或正文；索引目录 0700、文件 0600。
3. **排除目录：** 复用 `is_ignored_relative_path`，不索引 `.git`、`node_modules`、`.obsidian` 等；只索引 `.md/.markdown/.mdx`。

### 5. 故障与降级

| 故障 | 行为 |
|---|---|
| DB 打不开/`quick_check` 失败 | 备份为 `.corrupt`（最多 2 份）后重建 |
| WAL/SHM 残留损坏 | 删除 sidecar 后重开；失败则备份重建 |
| 索引目录只读/父目录不可写 | `open` 返回错误，上层降级为 `SearchIndexService::disabled()`，搜索返回 `INDEX_DISABLED` |
| 索引中退出/崩溃 | WAL 保证已提交事务；未提交的下次扫描补齐 |
| 查询超过 500ms | 中止并返回 `SEARCH_TIMEOUT` |
| 命中上限 | `truncated=true`，前端提示结果不完整 |

### 6. 性能证据（本机 macOS，debug + bundled SQLite）

| 语料 | 文件数 | 正文 | 索引耗时 | DB/正文 | 查询 p95 最高 |
|---|---:|---:|---:|---:|---:|
| 10k | 10,000 | 21.3 MiB | 7.1s（预算 60s） | 3.97× | 6ms |
| 100k | 100,000 | 450 MiB | 105.7s（2 轮扫描） | 2.88× | 122ms（预算 200ms） |

100k 语料按每文件约 4.5 KiB 生成，确保落在 512 MiB 正文上限内；DB/正文比用 SQLite 文件实际字节数计算。

## 后果

**正面：**

- 中文 1–2 字精确可达，混合中英文查询不再退化。
- 查询只取 rowid 集合，broad term 不做全量 bm25，100k 仍远低于 200ms。
- 索引损坏、只读、WAL 残留都有明确降级或自愈路径。
- 删除 `index/` 即可重建，维护成本低。

**代价/限制：**

- 100k 全量扫描仍可能需要两轮（单轮预算/正文上限），首次搜索前可能看到 `indexing=true`。
- short 表额外占用约 2–3% 正文；bigram 让 2 字 CJK 精确但会增大 short 表。
- broad term 的排序退化为时间倒序，不保证相关性最优；这是为 100k p95 做的明确取舍。
- 100k 索引约 1.3 GiB，超过正文 512 MiB 的 2×；DB/正文比目标 ≤4×，但磁盘占用仍显著。
- 索引不覆盖 PDF/Office；只支持 Markdown。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 前端直连 SQLite | 破坏 Rust 独占 IO/路径权威，前端可绕过 workspace jail |
| 跨 FTS 表 SQL JOIN + 统一 bm25 | 10k 实测 31s；FTS5 无法同时保持两表 rank 扫描 |
| 全部查询都算 bm25 | broad term 全量评分，100k p95 超 200ms |
| LIKE `%词%` 兜底 1–2 字 CJK | 全表扫描，100k 不可用；且无法利用索引 |
| 2 字 CJK 用 phrase 两 token | 精确但查询成本高；bigram token 更便宜 |
| 内存倒排 | 启动重建/内存占用不可控，多窗口共享复杂 |
| 索引存到工作区 `.qingmo/` | 污染用户目录、只读工作区失败、跨设备同步冲突 |

## 证据

- `src-tauri/tests/search_query.rs`：短语/排除/1–2 字 CJK/拉丁前缀/超长输入/转义。
- `src-tauri/tests/search_index.rs`：扫描、增量 upsert/remove/rebuild、工作区隔离、排除、schema 版本。
- `src-tauri/tests/search_index_recovery.rs`：disabled、路径为文件、只读父目录、WAL 残留、workspace 隔离、扫描被新 generation 取代。
- `src-tauri/src/services/search_index.rs::tests::an_interrupted_query_maps_to_search_timeout`：中断映射 `SEARCH_TIMEOUT`。
- `bench/search.mjs` + `bench/results/search-10000.json` / `search-100000.json`：上表数据。
- `e2e-tauri/specs/search.spec.ts`：真实 Tauri 打开工作区 → 搜索 → 打开结果 → 编辑保存 → 再搜索命中新词。

## 未决问题

- NEXT-003：跨工作区搜索。
- NEXT-009：`path:`/`tag:`/`OR` 等查询语法。
- NEXT-010：FTS 外部内容表/更激进的 segment 压缩，降低 100k 磁盘占用。
- 首次索引的多轮扫描对用户可见性（状态事件已有，UI 提示可继续打磨）。
