# 性能模型、测试矩阵与验证命令

> 功能：编辑器大纲面板（Outline）  
> 代码基线：`main@e97d651`  
> 状态：**已测量（2026-10-30）**；BENCH 6/6、E2E 3/3 通过  
> 用途：定义性能预算、bench 方法、E2E 断言和证据格式；下文按“预算 / 实测”分栏，不把计划值写成结果。

---

## 0. 结论先行

1. 本方案的成本有三块：**字段构建**、**语法树推进**、**React 列表渲染/通知**。
2. 字段构建限制在 200k units / 5000 条安全上限；常用 500 标题路径实测 p95 1.297ms ≤4ms（Node/jsdom 纯函数），浏览器输入未产生 >50ms 长任务。
3. 语法树推进用 8ms 空闲切片、50k 分块；200k 文档从菜单打开到 `status=complete` 实测 p95 180.8ms ≤300ms。
4. React 通知 100ms trailing；列表 `memo` + `useMemo`；面板只渲染前 500 条（实测 1006 节点），字段/锚点可保留至 5000 条。
5. 测试分四层：纯函数 UT、Session 集成、面板组件、Playwright E2E + perf。
6. 2026-10-30 已完成实测：BENCH-001~006 全通过，E2E-015~017 全通过。具体数字见 §7；原始输出在 `bench/results/.raw/` 与 `02 §4`。

---

## 1. 成本模型

### 1.1 字段构建

```text
buildHeadingOutline(state)
  -> syntaxTree(state)                 O(1) 读取
  -> tree.topNode 直接子节点遍历       O(B)  B = 顶层块数
  -> readFrontMatter(doc)              O(min(doc.lines, 2000))
  -> readDetailsRanges(state)           O(B)（只处理 HTMLBlock，>200k 返回空与 preview 对齐）
  -> headingText/plainInlineText       O(H * L)  H = 标题数，L = 标题长度
  -> entries 分配/比较                 O(H)
```

200k units、约 4k 顶层块、500 标题时，主要成本是：

- 顶层块遍历 4k；
- `readDetailsRanges` 遍历 4k；
- 500 次标题文本/正则；
- `sameOutline` 500 次字段比较。

5000 条安全上限路径主要多出 4500 次标题文本/比较；目标单独记录，不与常用 500 条路径混在一起。

目标 p95 ≤4ms 是工程估计；必须用 bench 校准。

### 1.2 语法树推进

- CM6 初始 3000 units；后台 worker 最多 viewport+100k。
- `outlineParseDriver` 每个分块把 target 设为 `当前树长度 + 50k`，调用 `forceParsing(view, target, 剩余预算)`；同一 target 最多重试 16 次，成功才推进下一块。同一个 8ms 空闲回调内可连续推进多个块。
- 200k 文档约需 4 个 50k 块；实测打开 p95 180.8ms（见 §7），明显低于 300ms 预算。
- 若解析器达到单块尝试上限，保持 partial，等 doc/viewport 变化再试；不阻塞输入。

### 1.3 React 渲染

- 面板 500 行 × 每行 `li > button > text` ≈ 1500-2000 节点。
- `OutlinePanel` `memo`；列表 `useMemo` 依赖 `[visibleEntries, activeIndex, focusIndex, t]`。
- 光标每 100ms 更新；如果 activeIndex 不变，列表元素引用不变，React 跳过子树。
- 活动项变化只改 `aria-current`/class；不重建列表。
- 通知 100ms trailing；连续输入最多 10 次/秒。

### 1.4 内存

- 200k 文档：字段 entries 最多 5000，每项约 5 个字符串/数字；5000 条约数百 KB，可接受。
- 面板只创建 500 个 React 元素；锚点使用完整 5000 条字段。
- 不复制全文；`plainText` 每项一份。
- 不缓存跨 state 的树/entries。

---

## 2. 性能预算与阈值

| 指标 | 场景 | 目标 | 实测（2026-10-30） | 失败处理 |
|---|---|---|---|---|
| `build p95` | 200k units / 500 标题 | ≤4ms | 1.297ms | 降上限/优化 details/frontmatter |
| `build p95` | 200k units / 5000 标题 | ≤12ms | 3.044ms | 降安全上限/优化文本处理 |
| `build p50` | 100k units / 200 标题 | ≤2ms | 0.418ms | 记录 |
| `session_open_ms` | 200k 文档 `EditorSession.create` | 记录 p50/p95，不劣化现有基线 | 字段 create 成本已包含在 E2E-015 打开延迟内 | 优化 details/frontmatter 或降上限 |
| `open p95` | 200k，菜单→complete | ≤300ms | 180.8ms | 提高切片/显示 partial |
| `input long task` | 面板打开，输入 20 字符 | 0 个 >50ms | 0 个；max frame gap 16.8ms | 降上限/延迟通知 |
| DOM 节点 | 面板 500 条 | ≤2500 | 1006 | 降 `OUTLINE_PANEL_MAX_ENTRIES` |
| 通知频率 | 连续输入 | ≤10/s | 100ms trailing；E2E-016 未观察到长任务 | 调整 `statusThrottleMs` |

> 目标是工程初值，不是行业标准；实测由 BENCH-001~006 与 E2E-015~017 采样。

---

## 3. Bench 设计

### 3.1 `bench/outline.bench.ts`

| BENCH-ID | 输入 | 测量 |
|---|---|---|
| BENCH-001 | 10k units / 50 标题 | `buildHeadingOutline` p50/p95 |
| BENCH-002 | 100k units / 200 标题 | 同上 |
| BENCH-003 | 200k units / 500 标题 | 同上 |
| BENCH-004 | 200k units / 5000 标题 | 安全上限路径 + count；字段/锚点保留 5000，第 5001 条不生成锚点 |
| BENCH-005 | 200k units / 0 标题 | 空列表快速路径 |
| BENCH-006 | 200k units / 100 个 details | 排除路径（`readDetailsRanges`） |

方法（`bench/outline.bench.ts` 实际实现）：

```ts
let state = createEditorState({ doc: fixture });
const limit = Math.min(state.doc.length, OUTLINE_SCAN_MAX_UNITS);
let attempts = 0;
while (syntaxTree(state).length < limit && attempts < 100) {
  const before = syntaxTree(state).length;
  ensureSyntaxTree(state, limit, 50);
  state = state.update({}).state; // publish the advanced tree
  attempts = syntaxTree(state).length > before ? 0 : attempts + 1;
}
if (syntaxTree(state).length < limit) throw new Error("bench tree is incomplete");
const samples = [];
for (let i = 0; i < 5 + 50; i++) {        // WARMUP=5，ITERATIONS=50
  const start = performance.now();
  buildHeadingOutline(state);
  if (i >= 5) samples.push(performance.now() - start);
}
```

注意：

- 纯函数 bench 不包含 React/DOM；浏览器 perf 单独测。
- 必须先让语法树覆盖 200k 并断言 `tree.length >= limit`；否则只测到 3000 units，结果无意义。
- `vitest.bench.config.ts` 为 bench worker 设置 `--max-semi-space-size=256 --max-old-space-size=4096`，避免测量循环自身的 scavenge 进入 p95；浏览器真实 GC 由 E2E-016 覆盖。
- BENCH-003 断言 p95 ≤4ms；BENCH-004 断言 p95 ≤12ms、字段 5000、锚点 5000 且不含 `h5000`。
- 合成 fixture 用短行/重复标题，避免 I/O 干扰。

### 3.2 `e2e/outline-perf.spec.ts`

| E2E-ID | 场景 | 测量 |
|---|---|---|
| E2E-015 | 200k seed，菜单打开 | `performance.now()` 从 emitMenuAction 到 `data-outline-status=complete`；p50/p95 |
| E2E-016 | 面板打开，输入 20 字符 | `PerformanceObserver({entryTypes:["longtask"]})` 数量/最长任务 |
| E2E-017 | 500 条列表渲染 | `data-outline-count=500`；DOM 节点数；第 501 条锚点可用 |

方法：

```ts
const start = await page.evaluate(() => performance.now());
await emitMenuAction(page, "view.toggleOutline");
await expect(page.getByTestId("outline-panel")).toHaveAttribute("data-outline-status", "complete");
const end = await page.evaluate(() => performance.now());
```

注意：

- `complete` 依赖解析驱动；200k 在 CI 上可能慢，给 5s timeout。
- 长任务 API 在 Chromium 可用；WebKit 可能不支持，skip/降级为帧间隔。
- 默认 `OUTLINE_PERF=1` 才运行，避免常规 E2E 波动。

---

## 4. 测试矩阵

### 4.1 单元测试（editor-core）

| UT-ID | 用例 | 断言 |
|---|---|---|
| UT-001 | ATX 1-6 | level/text/line/lineFrom |
| UT-002 | Setext 1-2 | text 不含下划线 |
| UT-003 | frontmatter/fence/缩进代码 | 不出现 |
| UT-004 | details | 不出现 |
| UT-005 | 重复/空/图片标题 | 重复保留；空跳过；图片标题回退 text |
| UT-006 | CJK/emoji/组合字符 | 文本不乱码；UTF-16 位置正确 |
| UT-007 | 5000 条字段安全上限 | 截断 + count；第 501 条仍在字段 |
| UT-008 | 200k | 截断 + size + partial；树未覆盖时 limitReason=null，空态为 generating |
| UT-009 | selection-only/tree-only | `sameOutline` 返回旧引用 |
| UT-010 | treeChanged | 3000 units 后标题出现 |
| UT-011 | 无字段 state | `readHeadingOutline` 回退 |
| UT-012 | TOC 占位符/headings | 三种占位符；与字段一致（前 200）；>200k 空态；blockquote/list 不生效 |
| UT-013 | anchors | 与旧 specs blocked 一致；直接调用 ≤200k 排除 details；第 501 条仍有锚点；空 plainText 跳过 |
| UT-029 | 字段错误 | last-known-safe/清空/恢复 |
| UT-030 | driver | fallback/取消/composing/viewportChanged/同一 target 重试上限/空事务不重置/暂停后恢复 |
| UT-031 | details-range | 与 readDetailsBlocks 闭合/未闭合/嵌套一致；>200k 均返回空 |

### 4.2 集成测试（desktop）

| UT-ID | 用例 | 断言 |
|---|---|---|
| UT-014 | 初始 outline | entries 与文档标题一致 |
| UT-015 | 订阅 | docChanged 后 100ms 内通知；unsubscribe 后不通知 |
| UT-016 | snapshot | `JSON.stringify(snapshot)` 不含标题文本 |
| UT-017 | StrictMode 新 view | attach/detach/attach 后一次 dispatch 只通知一次 |
| UT-018 | 同一 view 重挂/replacePayload | 代际守卫；立即通知新标题；无旧标题 |
| UT-019 | revealPosition/focusEditor | selection=lineFrom；clamp；非有限数返回 false；无 view 路径 |
| UT-020 | 面板 entries | 文本/缩进/数量 |
| UT-021 | 空/partial/count/size/error | 提示文案 |
| UT-022 | 活动项 | 二分边界/aria-current |
| UT-023 | 点击 | 调用 revealPosition |
| UT-024 | 关闭 | 回调/aria-label；关闭后 `focusEditor` |
| UT-025 | i18n | zh/en 无空文案 |
| UT-026 | visibility store | toggle/reset/subscribe |
| UT-027 | 显示回退 | `plainText` 空时显示 `text`；锚点由 UT-013 覆盖 |
| UT-028 | roving tabindex | Arrow/Home/End/Enter；clamp；不滚动页面 |
| UT-032 | 1200 条 | 面板 500；字段/锚点 1200 |
| UT-033 | toggle 稳定性 | `session.attachedView` 引用不变；EditorHost 不重挂 |
| UT-034 | 锚点前缀边界 | >200k 的 205k 标题、>5000 的第 5001 条不生成锚点 |

### 4.3 E2E

| E2E-ID | 场景 | 断言 |
|---|---|---|
| E2E-001 | 默认 | 无 `outline-panel`；现有布局 |
| E2E-002 | 菜单开关 | 出现/消失 |
| E2E-003 | 点击 | selection=lineFrom；标题距顶 10±2px |
| E2E-004 | 键盘 | Tab/Enter 跳转 |
| E2E-005 | 活动项 | `aria-current` 跟随光标 |
| E2E-006 | Source/LP | 条目一致 |
| E2E-007 | 重载 | 100ms 内新标题 |
| E2E-008 | 切换文档 | 无旧标题 |
| E2E-009 | 排除 | 无 frontmatter/details/fence |
| E2E-010 | 命令面板 | 执行 toggle |
| E2E-011 | 210k | partial/size + 输入可用 |
| E2E-012 | a11y | nav/ul/button/aria-current/roving tabindex |
| E2E-013 | 窄窗 | <900 隐藏；899/900 边界；无横向溢出 |
| E2E-014 | 主题/语言 | token/文案 |
| E2E-015 | 打开延迟 | p95 ≤300ms（perf） |
| E2E-016 | 输入长任务 | 0 个 >50ms（perf） |
| E2E-017 | 1200 条输入 / 500 条面板 | ≤2500 节点；第 501 条锚点可用 |

---

## 5. 回归矩阵

| 回归 | 命令 | 关注点 |
|---|---|---|
| TOC | `pnpm vitest run packages/editor-core/src/live-preview` | headings/占位符/atomic ranges |
| 锚点 | 同上 | slug/重复/HTML anchor |
| minimap | `pnpm exec playwright test e2e/minimap.spec.ts` | 600/800/1200px 布局 |
| 保存/重载 | `e2e/open-edit-save.spec.ts` | dirty/save/reload |
| 滚动恢复 | `e2e/view-state.spec.ts` | topPos/topOffset |
| 主题 | `e2e/palette-theme.spec.ts` | data-theme/token |
| Markdown 语法 | `e2e/markdown-syntax.spec.ts` | widget/链接 |
| 菜单/语言 | `pnpm vitest run apps/desktop/src/features/workspace apps/desktop/src/i18n` | 命令/标签/生成 |
| Rust | `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | MENU_ACTIONS/标签 |

---

## 6. 证据格式

实施后，`02` 的每条性能证据必须包含：

```text
C-ID / BENCH-ID:
命令:
fixture: <units/lines/headings>
样本数:
p50:
p95:
max:
环境: <Node/Chromium 版本, 机器>
结论: PASS/FAIL
```

E2E 证据：

```text
E2E-ID:
命令:
断言: <selection/anchor/px/status>
结果: passed/failed
截图/日志: <路径或 none>
```

禁止：

- 只写“性能良好”；
- 用纯函数 bench 代替浏览器输入延迟；
- 用 10k 文档代替 200k；
- 用 `data-outline-count` 存在代替标题正确性。

---

## 7. 实测结果（2026-10-30）

### 7.1 环境

- Node.js `v26.12.1`，Vitest `5.0.5`，jsdom。
- Chromium（Playwright `Desktop Chrome`），`workers=1`。
- 命令：
  - `pnpm typecheck:bench && pnpm exec vitest run --config vitest.bench.config.ts bench/outline.bench.ts`
  - `OUTLINE_PERF=1 pnpm exec playwright test e2e/outline-perf.spec.ts`

### 7.2 BENCH-001~006（50 samples，5 warmup）

| ID | units | 标题 | entries | status | p50 | p95 | max | 结果 |
|---|---:|---:|---:|---|---:|---:|---:|---|
| BENCH-001 | 10,000 | 50 | 50 | complete | 0.054ms | 0.093ms | 0.100ms | PASS |
| BENCH-002 | 100,000 | 200 | 200 | complete | 0.418ms | 0.732ms | 2.736ms | PASS |
| BENCH-003 | 200,000 | 500 | 500 | complete | 0.603ms | 1.297ms | 2.017ms | PASS（≤4ms） |
| BENCH-004 | 200,000 | 5,000 | 5,000 | complete | 2.552ms | 3.044ms | 4.478ms | PASS（≤12ms）；锚点 5,000 |
| BENCH-005 | 200,000 | 0 | 0 | complete | 0.362ms | 0.521ms | 1.185ms | PASS |
| BENCH-006 | 200,000 | 100 + 100 details | 100 | complete | 1.022ms | 2.743ms | 2.827ms | PASS |

原始数据：`bench/results/.raw/outline-bench-001.json` ~ `outline-bench-006.json`。

### 7.3 E2E-015~017（Chromium）

| 用例 | 样本 | 结果 |
|---|---:|---|
| E2E-015 200k 菜单→complete | 2 warmup + 16 | p50 155.9ms，p95 180.8ms（≤300ms） |
| E2E-016 面板打开输入 20 字符 | 1 | long task >50ms：0；max frame gap 16.8ms |
| E2E-017 1200 标题 | 1 | first visible 12.3ms；panel nodes 1006（≤2500）；count=500 / total=1200；第 501 条锚点跳到第 1003 行 |

### 7.4 结论

| 项 | 状态 | 说明 |
|---|---|---|
| BENCH-001~006 | pass | 6/6，见 §7.2 |
| E2E-015~017 | pass | 3/3，见 §7.3 |
| C-008/C-009 | pass | 见 `02 §6` |
| 性能阈值 | 已校准 | 分块 10k→50k；bench worker 内存参数；文本快速路径 |
| 失败处理 | 已定义 | 降上限/优化/partial |

> 本文件的数字来自真实命令输出；`02 §4` 是同一批数据的汇总。
