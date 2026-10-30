# 性能与测试证据

> 功能：编辑器缩略图（Minimap）  
> 代码基线：`main@43659b1`  
> 目的：为阈值、降级策略、测试矩阵和性能预算提供可复现证据；区分“已测量”与“待实测”。  
> **实施后修订：** 主路径已改为模式感知 Canvas：Source 1:1 文本窗口（字符约 1px、行高约 3px）；Live Preview 扁平化行内标记并按真实 `lineDocY` 绘制标题带/代码卡/表格网格/媒体/公式。绘制成本只与窗口行数相关，像素桶/块带仅在 Canvas 绘制异常时降级。

---

## 0. 结论摘要

1. `Text.iterLines()` 扫描 10 万行约 **2.46ms**（Node 26.12.1，本项目依赖版本），说明“每次文档变化扫描全文”在 100k 行内是可接受的，但必须 debounce，不能每键重绘。
2. 模式感知 Canvas 只覆盖视口窗口（约 200~250 行 × 最多 76 列），不绘制整篇文档；Live Preview 额外绘制少量语义块卡片，像素桶降级路径把绘制量限制在 rail 高度（约 600~800 个 `fillRect`）。
3. 锚点采样（`view.lineBlockAt`）目标是 **1200 个**、硬上限 2000；T-007 实测 read 阶段 ≤2.0ms。
4. **16ms 是工程目标**。T-007 的 C-011 实测 100k 行 CPU p50 **8.60ms** / p95 **10.80ms**，满足目标；wall p50 11.40ms / p95 18.40ms（含等待 CM6 measure 的帧调度）。
5. 现有测试栈：Vitest + jsdom、Playwright Chromium、bench 只记录不设门禁；没有 axe-core、没有截图基线。
6. jsdom 不能验证 canvas、布局、滚动高度、pointer 命中；这些必须放 Playwright。jsdom 的 `clientWidth/scrollHeight` 为 0，插件测试必须用 `MinimapOptions.geometry` 注入几何，否则会直接 Hidden。
7. T-007 的普通文本快路径 + indent/density 单次遍历把 100k scan p50 从 ~17ms 降到 ~8.7ms；因此保留 100k 行上限与 1200 锚点。实现与证据见 `02` §3/§8.1。
8. 1:1 文本渲染的行高/字符宽由 `defaultLineHeight/defaultCharacterWidth / 8` 估算并 clamp（行高 2~4px、字符宽 1~2px），窗口起点由 `viewportStartLine` 与文档相对滑块位置共同决定；滚动只重绘窗口。
9. Live Preview 渲染模式复用同一窗口与 `lineDocY`，把窗口内真实块高归一化到 rail；块卡片数量由窗口内 `blocks` 决定，不随全文块数线性增长。

---

## 1. 已测量的扫描成本

### 1.1 方法

在项目根目录执行：

```bash
node -e '
const {Text} = require("@codemirror/state");
for (const n of [1000,10000,50000,100000]) {
  const lines = Array.from({length:n}, (_,i)=> "  - item " + i + " some text here");
  const doc = Text.of(lines);
  const t0=performance.now();
  let count=0, maxLen=0;
  for (let it=doc.iterLines(); !it.done; it.next()) { count++; const s=it.value; if (s.length>maxLen) maxLen=s.length; }
  const t1=performance.now();
  console.log(n, "lines", (t1-t0).toFixed(2), "ms", "count", count, "max", maxLen);
}
'
```

### 1.2 结果

| 行数 | 耗时 | 备注 |
|---:|---:|---|
| 1,000 | 0.78ms | 冷启动波动 |
| 10,000 | 1.35ms | |
| 50,000 | 1.32ms | |
| 100,000 | 2.46ms | 线性趋势，远低于 16ms |

**解释与限制**：

- 这是 Node 中的 `Text.iterLines()` 纯扫描，不含行对象分配、块分类、`lineBlockAt`、Canvas。
- 不代表 100k 行文档的完整重建成本；但证明“行扫描本身不是瓶颈”。
- 真实浏览器/WebView 的数字需在 T-007 用 `performance.now()` 包裹 `rebuild()` 记录。

---

## 2. 性能预算（工程初值，待校准）

| 操作 | 触发 | 目标 | 依据 | 校准任务 |
|---|---|---:|---|---|
| 行扫描 + 分类 | 文档变化后 120ms | 10k 行 ≤ 4ms；100k 行 ≤ 12ms | 测得 1.35/2.46ms，留 3~5× 余量 | T-003/T-007 |
| 锚点采样 | 文档/几何变化 | 1200 个锚点 ≤ 8ms | 未实测；`lineBlockAt` 为高度图查询 | T-003 |
| 文本窗口 + Canvas | 重建/滚动 | ≤ 4ms | 约 200~250 行 × 最多 76 列；窗口外不绘制 | T-004/T-007 |
| 像素桶 + 块带（降级） | 文本绘制异常 | ≤ 4ms | 最多 ~800 个 1px `fillRect` | T-004/T-007 |
| 滑块滚动更新 | scroll rAF | ≤ 1ms | 只做一次映射 + `transform` | T-004/T-007 |
| 主题切换重绘 | `data-theme` 变化 | ≤ 8ms | 重解析 token + 重绘 | T-004 |
| 滚动停止锚点刷新 | scroll idle 250ms | 1200 锚点 + 100k 行插值 ≤ 12ms（工程目标） | 复用缓冲；实际待 C-011 | T-007 |
| 内存 | 常驻 | **O(lines)**，100k 行需实测堆峰值 | 复用 `Uint8Array/Uint16Array` 行缓冲 + `Float64Array(lineDocY)` + blocks + anchors + buckets | T-003/T-007 |

> 分项目标之和可能超过 16ms（12+8+4=24ms）。T-007 已实测完整 rebuild：CPU p50 8.60ms / p95 10.80ms，保留 100k 上限；若未来回归 >16ms，按顺序降级：增大 `ANCHOR_STRIDE` → 降低 `ANCHOR_MAX` → 降低 `MAX_LINES` → 隐藏。最终 PASS 必须记录实际上限与 p50/p95。

---

## 3. 现有测试基础设施

### 3.1 Vitest + jsdom

- 配置：`vitest.config.ts`，`environment: "jsdom"`，`setupFiles: ["./apps/desktop/src/test/setup.ts"]`。
- 排除：`e2e/**`、`src-tauri/**`。
- `apps/desktop/src/test/setup.ts:9-22` 的 `ResizeObserverMock` 是零尺寸；CM6 在 jsdom 中无法测量真实布局。
- 单测可验证：
  - 纯函数（行分类、锚点映射、文本窗口、`renderedLineText`、降级像素桶、滑块数学）；
  - ViewPlugin 生命周期（DOM 创建/销毁、inline display/padding、`data-minimap-state`），但必须用 `MinimapOptions.geometry` 注入 `editorWidth/railWidth/railHeight/trackTop/trackHeight/contentHeight/documentPadding/clientHeight/scrollHeight`；
  - `EditorSession` 集成（一个 view 一个 rail、`replacePayload`、`view.destroy()`），放在 `apps/desktop/src/features/editor` 测试；
  - StrictMode（`editor-binding.test.tsx:141+` 已有 `<StrictMode>` 用例）；
  - 主题 palette（scoped root + CSS 变量）。
- 单测**不能**验证：
  - Canvas 实际像素；
  - `.cm-editor`/`.cm-scroller` 的真实宽度/padding；
  - `scrollHeight`、`lineBlockAt` 的真实几何；
  - pointer 命中、拖拽、滚动同步；
  - DPR、滚动条宽度。

### 3.2 Playwright

- 配置：`playwright.config.ts`，Chromium，`workers: 1`，`webServer` 自动 `build:e2e` + `preview:e2e`。
- `build:e2e` 是 **production build**，React StrictMode 的 effect 双调用不会发生；StrictMode 不能靠 E2E 证明。
- 现有 E2E：
  - `e2e/open-edit-save.spec.ts:96-120` 断言 `.cm-editor` 宽度等于 viewport、`.cm-content`/`.cm-line` 左 inset 20（只覆盖 6 行 `note.md`，不能证明长文档右让位）；
  - `e2e/view-state.spec.ts` 断言滚动恢复、`topOffset=28`；
  - `e2e/markdown-syntax.spec.ts` 打开 2391 行 `docs/MARKDOWN-SYNTAX.md`，会立即触发 minimap，是最重要的长文档回归套件；
  - `e2e/mermaid-card.spec.ts` 有 canvas/滚动宽度断言，可作为 Canvas 测试参考。
- 现有 fixture：
  - `e2e/fixtures/long.md`：212 行纯文本，适合 minimap 基线；
  - `e2e/fixtures/note.md`：6 行，适合“短文档不显示”断言；
  - 含 table/Mermaid 的测试用 inline seed 构造，不修改现有 fixture。

### 3.3 Bench

- `vitest.bench.config.ts` 单独运行 `bench/**/*.bench.ts`；
- `bench/README.md` 明确：P1 只记录，不设门禁；
- 现有 fixtures：small 10KiB/419 行、medium 1MiB/41,618 行、large 10MiB/408,423 行（运行时生成）；
- minimap bench 应使用纯函数 + 合成 100k `Text`，不依赖 jsdom 布局；`lineBlockAt` 只能靠 Playwright/真实 WebView 测。

### 3.4 缺失项

| 项 | 现状 | 影响 |
|---|---|---|
| axe-core | 未安装 | 不能自动跑 WCAG；用 Playwright role/tab 断言 + 人工检查 |
| 截图基线 | 无 `toHaveScreenshot` | 不做像素级视觉回归；用 Canvas `getImageData` 按结构采样 |
| Canvas 测试工具 | 无 | 用浏览器 `getImageData`，jsdom 只测降级 |
| 性能门禁 | 无 | T-009 显式运行 bench 并记录；不进入 `ci:web`，但作为 PASS 条件 |

---

## 4. 坐标与布局证据

### 4.1 滚动坐标（关键）

`ViewStateRecorder.capture()`：

```ts
view.lineBlockAtHeight(0);
const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
const block = view.lineBlockAtHeight(top);
```

`e2e/view-state.spec.ts` 断言首行 `topOffset = 28`，与 `.cm-content` 的 `padding-top: 28px` 一致。

CM6 源码（`node_modules/@codemirror/view/dist/index.js:8432-8440`）：

```ts
get documentTop() {
  return this.contentDOM.getBoundingClientRect().top + this.viewState.paddingTop;
}
get documentPadding() { return { top: this.viewState.paddingTop, bottom: this.viewState.paddingBottom }; }
```

结论：

- `lineBlockAt(pos).top` 以**首行顶部**为 0，**不含**上 padding；
- `scrollTop` 是 scroller 偏移，`scrollTop=0` 对应 `docY = -paddingTop`；
- 因此换算必须是：

```text
docY = scrollTop - view.documentPadding.top
scrollTop = docY + view.documentPadding.top
docHeight = view.contentHeight - paddingTop - paddingBottom
```

**不能**把 `lineBlockAt(pos).top` 直接当 `scrollTop` 用，否则有 28px 系统偏移。

### 4.2 当前布局

`packages/editor-core/src/extensions/theme.ts`：

- `.cm-content { padding: 28px 20px; }`
- `.cm-line { padding: 0 20px; }`
- `.cm-content > :not(.cm-line) { margin-inline: 20px; }`

`apps/desktop/src/styles.css`：

- `.cm-editor .cm-gutters { position:absolute; left:0; width:40px; }`
- `.cm-editor[data-live-preview="true"] .cm-gutters { display:none; }`

新增 rail 后：

```text
.cm-editor { padding-right: 88px; }   /* 由插件写 inline style，不依赖 class */
.cm-scroller 宽度 = editor 内容宽度 - 88px
rail 位于 editor 的 88px padding 区内，right: 0，width: 76px
```

好处：

- `.cm-scroller` 的横向滚动条、宽 table/code 都在 rail 左侧，不会被 rail 覆盖；
- 垂直滚动条也在 rail 左侧；
- `.cm-content` padding 仍是 20px，现有左 inset 断言不变；
- 嵌套代码块的 `.cm-editor` 没有被插件写 inline padding，不会继承 88px。

E2E 必须断言：

- `.cm-editor` border-box 宽度 = viewport；
- `.cm-editor` `paddingRight = 88px`（长文档）；
- `.cm-content` `padding-left = 20`、`padding-right = 20`；
- `railRect.left >= scrollerRect.right`（不重叠）；
- `document.documentElement.scrollWidth == innerWidth`（页面无横向溢出）；
- 启用 minimap 前后 `.cm-scroller.scrollWidth` 的差值 ≤ `reserve`（不绝对禁止表格/代码块自身的横向滚动）。

### 4.3 为什么不用 `scrollMargins`/`.cm-content` padding

见 `01-official-docs-and-oss.md` §2.3。`scrollMargins` 不占布局。`.cm-content` padding-right 只保证内容末尾让位，横向滚动时右 padding 会移出视口，rail 仍可能盖住中间文本；因此必须用 `.cm-editor` padding。

---

## 5. Minimap 测试矩阵

### 5.1 单元测试（Vitest/jsdom）

| ID | 用例 | 文件 | 断言 |
|---|---|---|---|
| UT-001 | 行分类：ATX 标题 1~6 | `minimap/model.test.ts` | level、kind |
| UT-002 | Setext 标题 | 同上 | `===`/`---` 提升前一行 |
| UT-003 | fenced code（``` / ~~~、info string） | 同上 | 整段 code；mermaid → diagram |
| UT-004 | 表格 header + delimiter + rows | 同上 | 整段 table |
| UT-005 | front matter | 同上 | 首尾 `---` 范围 |
| UT-006 | 列表/引用/分隔线/空行/缩进 | 同上 | kind 正确；tab 按 `tabSize` 展开（4 与 2 各一例） |
| UT-007 | 空文档/单行文档 | 同上 | 不抛错、不产生负坐标 |
| UT-008 | 锚点去重与单调性 | 同上 | `line`、`docY` 严格递增；重复采样被跳过；`lineDocY` 非递减 |
| UT-009 | `docYToRail` 正/逆变换 | 同上 | 端点精确、clamp、内部误差 < 0.5px；Canvas 与滑块同一函数 |
| UT-010 | 降级像素桶聚合 | 同上 | 桶数 ≤ ceil(railHeight)，kind 优先级正确，块带至少 1px |
| UT-011 | 滑块 clamp / 最小高度 | 同上 | top ∈ [0, trackH-h]，h ≥ 24；maxScroll=0；首尾到顶 |
| UT-012 | 文档上限/恢复 | 同上 | 100,001 行或 >2M units disabled；99,999 行 enabled |
| UT-013 | ViewPlugin 创建/销毁/Pending | `minimap/minimap.test.ts` | mock `getContext` 最小 2D stub；rail 存在、aria-hidden、destroy 后移除；Pending 时 display:block/visibility:hidden/padding 已写，on 后 visible；构造/measure 前 destroy 也清理（`geometry` 注入） |
| UT-014 | 无 2D context 降级 | 同上 | 不抛错，`data-minimap-state="unsupported"` |
| UT-015 | 空文档/不足一屏短文档隐藏 | 同上 | `getComputedStyle(rail).display === "none"`、`data-minimap-state="off"`、editor paddingRight 为空；无行数阈值，仅按实际滚动隐藏 |
| UT-016 | `EditorSession` 集成 | `apps/desktop/src/features/editor/editor-session.test.ts` | view 创建后 1 个 rail；`replacePayload` 后 1 个；`view.destroy()` 后 0 个 |
| UT-016b | StrictMode | `editor-binding.test.tsx` | 1 个 view、1 个 rail（几何 mock） |
| UT-017 | 主题 palette | `minimap/theme.test.ts` | scoped root 下 light/dark token 解析正确；probe 被 dispose |
| UT-018 | css-color 抽取回归 | `css-color.test.ts` | 与 Mermaid 原行为一致、probe 被移除 |
| UT-019 | 1200 锚点插值 | `model.test.ts` | 合成 100k 行/1200 锚点，样本点与注入值一致、`lineDocY` 非递减、耗时可接受 |
| UT-020 | 大 widget 重复 docY | `model.test.ts` | 同一 widget 内采样被合并，块内按行插值单调，跨块不跳变；文末 fence/table 到底 |
| UT-021 | 可见性/滞回 | `model.test.ts` | `isEligible` 在 640/624px 宽度边界正确且不读几何/行数；`nextVisibility` 在 `scrollHeight<=clientHeight` 时 hidden，短但可滚动时 visible；超限立即 hidden |
| UT-022 | scrollTop↔docY | `model.test.ts` | `pt=28` 时 `scrollTopToDocY(0)=0`、`docYToScrollTop(offset=0)(0)=0`、`docYToScrollTop(offset=0)(docHeight)=maxScroll` ±1px；点击 offset=clientHeight/2 |
| UT-023 | 文本窗口 | `model.test.ts` | 整篇可容纳、顶部 padding、滑动窗口起点、底部 clamp 四种分支 |
| UT-024 | `lineAtDocY` | `model.test.ts` | 首行/行中/下一行/文末坐标命中正确行 |
| UT-025 | `renderedLineText` | `minimap.test.ts` | 标题/引用/列表/任务/链接/图片/行内代码扁平化；代码 fence/表格返回空串 |

### 5.2 E2E（Playwright）

> E2E-009/011/014 的合成文档通过 `openApp(page, [{ path, text }])` 的 seed 注入（`e2e/helpers.ts`），不新增 fixture 文件；`long.md`/`note.md` 继续复用现有 fixture。`e2e/minimap-perf.spec.ts` 默认 `test.skip(!process.env.MINIMAP_PERF)`，避免 `pnpm test:e2e` 每次都跑 100k 性能采样；C-011 显式设置 `MINIMAP_PERF=1`。

| ID | 场景 | 断言 |
|---|---|---|
| E2E-001 | 打开 `long.md` | `.qm-minimap` 可见（visibility:visible）；canvas backing store 宽高 ≈ CSS 尺寸 × DPR；`data-minimap-state="on"`；默认 Live Preview 下 `data-minimap-render="rendered"`；`.cm-editor` paddingRight=88；`.cm-scroller[data-minimap-scrollbar="hidden"]` |
| E2E-002 | 打开 `note.md` | rail `getComputedStyle(display)==="none"`、`data-minimap-state="off"`；`.cm-editor` paddingRight 为空；content padding = 20；无 `data-minimap-scrollbar`，原生 `scrollbar-width` 不变 |
| E2E-003 | 200 行唯一文本 seed 点击 track 25%/50%/75% | 期望行进入视口 ±2 行；`scrollTop` 单调、在 `[0,maxScroll]` |
| E2E-004 | 拖拽滑块到顶/底 | `scrollTop` 单调；顶部 slider top=trackTop；底部 slider bottom=trackBottom（±1px） |
| E2E-005 | 滚轮悬停 rail | `scrollTop` 变化；页面不滚动 |
| E2E-006 | 切换主题 | Canvas 至少 4 种颜色；light/dark 调色板不同；`.cm-editor` 仍是同一个 DOM 节点 |
| E2E-007 | Source ↔ Live Preview | rail 保留；点击仍可跳转；paddingRight 仍为 88；滚动条替换属性保留；无 console error |
| E2E-008 | 窗口 resize 1200→800→600→1200 | 长文档：`.cm-editor` border-box 宽=viewport、paddingRight=88、content 左右 20、rail.left ≥ scroller.right、页面无横向溢出、滚动条隐藏；600 时隐藏且恢复原生滚动条；focus/theme/mode/reload 后重复 |
| E2E-009 | 大 widget 文档（table/Mermaid/fence/image） | 点击前/中/后：`scrollTop` 单调且不越界；中点点后 widget 卡片可见；不冻结/跳回顶部 |
| E2E-010 | `replacePayload`/外部重载 | rail 仍为 1；`state=on`；滑块不越界 |
| E2E-011 | 100,001 行短行 seed | rail `display:none`、padding 为空（单独 timeout/project） |
| E2E-012 | 可访问性 | rail `aria-hidden=true`、无 tabindex；Tab 顺序不包含 rail；原生滚动键仍工作，且运行时滚动条已隐藏 |
| E2E-013 | 结构颜色 | Canvas 非透明像素中至少 4 种不同 RGB；light/dark 调色板不同 |
| E2E-014 | 已知标题点击（按标题行比例定位 rail） | 标题进入视口；标题中心与 scroller 中心偏差 ≤ 10px；`scrollTop` 在 `[0,maxScroll]` |
| E2E-015 | 短行 + 长行 + 90 行正文 seed，切到 Source | `data-minimap-render="text"`；行高 ≥2px；长行最右 ink 比短行大 >20px，证明按真实字符数推进 |
| E2E-016 | 含标题/代码/表格/链接的 90+ 行 seed | 默认 `rendered`；切 Source 后 `text`；两次 Canvas 哈希不同 |
| E2E-017 | 260 行 seed | `data-minimap-scrollbar="hidden"`；`scrollbar-width=none`；`::-webkit-scrollbar` 宽/高 0px；`overflow-y:auto` 与 `scrollHeight>clientHeight` 不变；滚轮移动 scrollTop 且 slider transform 变化；切 Live Preview 仍隐藏 |
| E2E-018 | 18 行 seed，视口 1280×420 | 行数远低于旧 80 行阈值但内容溢出：`data-minimap-state="on"`、paddingRight=88、原生滚动条隐藏、`scrollHeight>clientHeight` |

### 5.3 Canvas 像素断言

```ts
const pixels = await page.locator(".qm-minimap canvas").evaluate((canvas) => {
  const ctx = (canvas as HTMLCanvasElement).getContext("2d")!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonTransparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) nonTransparent += 1;
  }
  return {
    nonTransparent,
    width: canvas.width,
    height: canvas.height,
    cssWidth: canvas.getBoundingClientRect().width,
    cssHeight: canvas.getBoundingClientRect().height,
  };
});
expect(pixels.nonTransparent).toBeGreaterThan(0);
expect(pixels.width).toBeCloseTo(pixels.cssWidth * devicePixelRatio, 0);
expect(pixels.height).toBeCloseTo(pixels.cssHeight * devicePixelRatio, 0);
```

结构颜色：用 fixture 的 heading/fence/table/quote 行号估算 rail y，读取 1×1 像素，断言颜色不同；light/dark 各采一次，断言对应 token 变化。不能只统计“非透明像素 > 0”。

1:1 文本：在窗口顶部取连续两个源行对应的 rail 横条，分别统计最右非透明像素的 x 坐标；长行必须显著大于短行（E2E-015 用 `> 20px` 容差），以证明绘制的是真实字符位置而不是固定密度条。

渲染模式：对同一文档分别在 Live Preview 与 Source 下读取 Canvas 像素哈希，二者必须不同（E2E-016）；再对含代码块/表格的文档统计块颜色，确认存在 code/table 色带。

### 5.4 Bench

| ID | 输入 | 指标 |
|---|---|---|
| BENCH-001 | 1k / 10k / 50k / 100k 行 | `scan` p50/p95 |
| BENCH-002 | 同上 | `bucket` p50/p95 |
| BENCH-003 | 1200 锚点合成数据 | `anchorMap` p50/p95 |
| BENCH-004 | 100k 行 + 800px rail | `build` 总耗时 / 堆峰值 |

命令：

```bash
pnpm typecheck:bench
BENCH_FIXTURE=medium pnpm exec vitest run --config vitest.bench.config.ts bench/minimap.bench.ts
```

> `medium` 只有 41,618 行。BENCH-001/004 必须在 bench 内用 `Text.of` 合成 100k 行，不能拿 medium 代替。

---

## 6. 验收命令

| C-ID | 命令 | 用途 |
|---|---|---|
| C-001 | `pnpm vitest run packages/editor-core/src/minimap packages/editor-core/src/css-color.test.ts` | 纯函数 + 插件单测 |
| C-002 | `pnpm vitest run packages/editor-core/src/live-preview/mermaid-theme.test.ts packages/editor-core/src/css-color.test.ts` | css-color 抽取回归 |
| C-003 | `pnpm vitest run apps/desktop/src/features/editor` | EditorSession/StrictMode 集成回归 |
| C-004 | `pnpm typecheck` | 全仓类型 |
| C-005 | `pnpm lint` | ESLint |
| C-006 | `pnpm exec playwright test e2e/minimap.spec.ts` | minimap E2E |
| C-007 | `pnpm exec playwright test e2e/open-edit-save.spec.ts e2e/view-state.spec.ts e2e/markdown-syntax.spec.ts e2e/palette-theme.spec.ts` | 布局/滚动/长文档回归 |
| C-008 | `pnpm typecheck:bench && pnpm exec vitest run --config vitest.bench.config.ts bench/minimap.bench.ts` | 纯函数性能记录 |
| C-009 | `pnpm ci:web` | 全量 web 质量门 |
| C-010 | `pnpm test:e2e` | 全量 E2E |
| C-011 | `MINIMAP_PERF=1 pnpm exec playwright test e2e/minimap-perf.spec.ts` | 真实 Chromium 100k rebuild p50/p95（T-009 PASS 条件） |

---

## 7. 已实测与剩余待实测项

1. `lineBlockAt` 真实浏览器批量成本（1200 次）：C-011 已记录 read 阶段 p95 ≤2.0ms。
2. 100k 行完整 `rebuild` 的 p95 与堆峰值：C-011 已实测 CPU p50 8.60ms / p95 10.80ms；堆峰值未单独采样。
3. Live Preview 中 Mermaid/图片加载后的 `geometryChanged` 频率，以及 viewport 外锚点估算误差。
4. 滑块在巨型 widget 上的视觉抖动，是否需要 Obsidian 式跨屏平均。
5. `.cm-editor` padding-right 方案在 Tauri WebView/Windows 经典滚动条下的真实布局。
6. `color-mix()` 背景在 Tauri WebView 的实际表现。
7. jsdom 的 `getContext("2d")` 是返回 null 还是抛错；测试用 `geometry` 注入后的实际行为。
