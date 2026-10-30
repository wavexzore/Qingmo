# 官方文档与开源实现调研

> 功能：编辑器缩略图（Minimap）  
> 代码基线：`main@43659b1`（2026-10-30）  
> 调研日期：2026-10-30  
> 结论用途：为 [`04-设计方案.md`](../04-设计方案.md) 的算法、挂载方式、主题和性能边界提供一手证据。  
> **实施后修订：** 用户在实现后明确要求“参考 VS Code 做成 1:1 缩小”。最终主路径改为 Canvas 1:1 文本窗口（字符约 1px、行高约 3px，保留结构色），下文第 0 节第 3/6 条与 §3.3 “字符渲染器”结论为调研阶段判断，已被 F-051 取代；像素桶仅作为 Canvas 异常降级。

---

## 0. 结论摘要

1. **CodeMirror 6 没有内建 minimap**。正确接入方式是 `ViewPlugin`，由插件管理自己的 DOM、Canvas 和生命周期；不应把 minimap 塞进 `EditorState` 或 `basicExtensions`。
2. `EditorView.scrollMargins` **不是布局预留机制**。它只影响 `scrollIntoView` 等滚动计算；真正为右侧 rail 预留宽度必须通过布局/CSS（本方案用 `view.dom` 绝对定位 + `.cm-editor` 右侧 padding）。
3. VS Code 的默认 minimap 是 **Canvas + 行采样 + 基于文档几何的滑块**；`renderCharacters` 默认 `true`，但可以切到 blocks。调研阶段判断“76px 下字符不可读、结构色块更合适”；实施后按用户要求改为 1:1 文本缩略图，结构色仅用于区分行语义（F-051）。
4. `replit/codemirror-minimap` 的挂载方式依赖 `.cm-gutters` 类；本项目 `styles.css` 把 `.cm-gutters` 强制绝对定位到左侧 40px，并在 Live Preview 隐藏，因此**不能照搬**。它还会 `doc.toString()` 后整篇 Lezer 解析，长文档成本不可接受。
5. `Nymbo/Markdown-Minimap` 是 Markdown 场景最接近的参考：整篇独立渲染、用标题锚点校准滚动映射、滑块高度做跨屏平均、最小可抓取高度。其完整 DOM 克隆/重渲染方案过重，但**锚点校准与滑块稳定策略值得采用**。
6. 最终方案采用“**1:1 文本缩略图 + 结构色 + 视口窗口 + 单一文档纵轴 + 锚点校准**”：Canvas 与滑块共用 `docYToRail`；锚点只用于估算每行 `docY`；点击/拖拽经同一映射回真实 `scrollTop`；不克隆 DOM、不读取真实字体轮廓、不新增第三方依赖。

---

## 1. 调研范围与证据等级

| 证据类型 | 来源 | 等级 | 用法 |
|---|---|---|---|
| 本地依赖源码 | `node_modules/@codemirror/view@6.43.15`、`@codemirror/state@6.7.6` | A（可执行/可类型检查） | API 语义、生命周期、几何坐标 |
| 官方文档 | CodeMirror 6 Reference、VS Code 官方文档/源码 | A | 配置默认值、渲染策略 |
| 成熟开源实现 | VS Code、`replit/codemirror-minimap`、`Nymbo/Markdown-Minimap` | B（实现参考） | 架构取舍、性能策略 |
| 论文 | 见 [`03-papers-and-hci.md`](03-papers-and-hci.md) | B | 交互与信息设计依据 |
| 仓库文档/网页检索 | DeepWiki、Exa（VS Code / CM6 / replit / Obsidian） | B | 定位实现与文档；关键 API/坐标仍以本地源码二次核对 |
| 本项目代码 | `apps/`、`packages/`、`e2e/`、`bench/` | A | 接入点、约束、回归面 |

> 开源项目只借鉴架构与算法思想，不复制代码。若后续需要直接复用某段实现，必须单独核对许可证并在 `NOTICE` 中登记。

---

## 2. CodeMirror 6 官方能力与边界

### 2.1 `ViewPlugin` 生命周期

本地类型定义：`node_modules/@codemirror/view/dist/index.d.ts`。

| API | 语义 | 对 minimap 的约束 |
|---|---|---|
| `ViewPlugin.fromClass(create, spec)` | 每个 `EditorView` 创建一个插件实例 | rail DOM、Canvas、监听器必须全部由插件实例持有 |
| `constructor(view)` | view 创建后调用 | 此时可挂 DOM，但布局可能尚未测量 |
| `update(update: ViewUpdate)` | 每次 view update 调用 | 用 `docChanged` / `geometryChanged` / `viewportChanged` / `selectionSet` 分流 |
| `destroy()` | view 销毁或 `setState` 替换插件时调用 | 必须移除 DOM、取消 rAF/定时器、断开 observer、移除监听器 |
| `provide` | 插件可提供 facet | 本方案不需要用 `scrollMargins` 预留布局 |

`ViewUpdate` 关键标志（同文件）：

- `docChanged`：文档变化，需要重建行模型。
- `geometryChanged`：行高/块高/视口几何变化，需要重测锚点与 rail 尺寸。
- `viewportChanged`：可见范围变化，通常由滚动或文档变化引起；只更新滑块即可。
- `selectionSet`：选区变化，可更新光标标记。

### 2.2 几何 API 与坐标语义

| API | 返回值/语义 | 本方案用法 |
|---|---|---|
| `view.contentHeight` | 编辑器内容总高度（含上下 padding） | 判断是否可滚动、滑块比例的上界 |
| `view.documentTop` | 文档内容顶部的屏幕坐标 | 与 `scrollDOM` 的 rect 换算视口位置（`ViewStateRecorder` 已用同一套坐标） |
| `view.lineBlockAt(pos)` | 指定位置的 `BlockInfo`，含 `top`、`bottom`、`height` | 锚点采样：源码行号 → 编辑器纵向坐标 |
| `view.lineBlockAtHeight(height)` | 屏幕空间高度对应的块 | 仅在需要时读取可见行；本方案主路径用 `lineBlockAt` |
| `view.scrollDOM` | 滚动容器（`.cm-scroller`） | 唯一滚动真源；只读监听，不另建滚动状态 |
| `view.dom` | 编辑器根节点（`.cm-editor`，`position: relative`） | rail 的绝对定位父级 |

**坐标一致性证据**：`apps/desktop/src/features/editor/session/ViewStateRecorder.ts:145-185` 使用

```ts
const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
const block = view.lineBlockAtHeight(top);
```

把 `scrollTop` 映射到文档块；`e2e/view-state.spec.ts` 断言首行 `topOffset = 28`。注意：`lineBlockAt(pos).top` 以首行顶部为 0，不含 `.cm-content` 的上 padding；`scrollTop` 是 scroller 偏移。二者相差 `documentPadding.top`，锚点映射必须先做 `scrollTop - paddingTop` 换算，不能直接相等。

### 2.3 `scrollMargins` 的真实语义（重要纠正）

`EditorView.scrollMargins` 的类型是：

```ts
static scrollMargins: Facet<(view: EditorView) => Partial<Rect> | null, ...>
```

官方语义是“滚动到某个位置时额外考虑的边距”，**不参与 flex 布局、不改变 `.cm-content` 可用宽度**。`replit/codemirror-minimap` 同时做了两件事：

1. 把 minimap DOM 作为 `.cm-gutters` flex 子项插入 `scrollDOM`，由 flex 布局占宽；
2. 额外提供 `scrollMargins`，让 `scrollIntoView` 知道右侧有 minimap。

只提供 `scrollMargins` 不会给 rail 让出空间。因此本方案明确：

- **不用** `scrollMargins` 作为布局预留；
- 用 `view.dom.style.paddingRight` 预留（inline style，CM6 不会重写）；
- rail 绝对定位在 `view.dom` 内，避免参与 `.cm-scroller` 的横向滚动。

### 2.4 主题与 CSS 变量

`packages/editor-core/src/extensions/theme.ts` 的 `qingmoEditorTheme` 全部使用 `var(--qm-*)`，注释明确“palette 不在 JavaScript 中复制”。Canvas 不能直接消费 CSS 变量，必须解析为 concrete color。

现有唯一解析器在 `packages/editor-core/src/live-preview/mermaid-theme.ts:338-382`：

- 创建隐藏 `span` probe；
- `getComputedStyle` 读取 token；
- 对 `light-dark()` / `var()` / `color-mix()` 走 probe 计算；
- `normalizeMermaidColor` 把 `rgb()/rgba()` 规范化为 hex/rgba。

本方案把这段能力抽到 `packages/editor-core/src/css-color.ts`，Mermaid 与 minimap 共用，避免第二套颜色解析。

### 2.5 `basicExtensions` 与嵌套编辑器

`packages/editor-core/src/extensions/basic.ts` 是顶层编辑器基线；嵌套代码块编辑器在 `packages/editor-core/src/live-preview/code-blocks.ts:665-728` 用独立 `EditorState.create`，并直接使用 `qingmoEditorTheme`，不走 `createEditorState`。

因此：

- 把 minimap 放进 `basicExtensions` 或 `qingmoEditorTheme` 会扩大影响面，且可能让嵌套代码块出现 minimap；
- 正确位置是 `EditorSession.extraExtensions`（所有顶层 session 的汇合点）；
- `createEditorState` 保持不默认挂载，避免 editor-core 的其他消费者被动获得 UI。

---

## 3. VS Code minimap

### 3.1 官方配置与默认值

来源：`microsoft/vscode` 主分支 `src/vs/editor/common/config/editorOptions.ts`，`IEditorMinimapOptions` 与 `EditorMinimap` 构造器。

| 配置 | 代码默认值 | 语义 | 本方案取舍 |
|---|---|---|---|
| `editor.minimap.enabled` | `true` | 是否显示 | 本项目按文档长度自动显示，不新增用户配置 |
| `editor.minimap.size` | `'proportional'` | `proportional` / `fill` / `fit` | 采用“整篇适配 rail 高度”的 proportional 思路 |
| `editor.minimap.side` | `'right'` | 左/右 | 固定右侧 |
| `editor.minimap.showSlider` | `'mouseover'` | 滑块显示时机 | 常显低透明度，hover/drag 增强 |
| `editor.minimap.renderCharacters` | `true` | 字符渲染 vs 色块 | 采用色块（Markdown 字符在 76px 下不可读） |
| `editor.minimap.maxColumn` | `120` | 最大渲染列数 | 采用“密度上限”而非字符列 |
| `editor.minimap.scale` | `1` | 字体相对大小 | 不暴露 |
| `editor.minimap.autohide` | `'none'` | 自动隐藏 | 不做 |

> 注意：`size` 的 JSDoc 写“Defaults to 'actual'”，但构造器实际默认是 `'proportional'`。以可执行代码为准。

### 3.2 渲染管线

来源：`src/vs/editor/browser/viewParts/minimap/minimap.ts`。

- `Minimap` 是 view part，Canvas 绘制。
- 两种渲染器：
  - `renderCharacters: true`：`MinimapCharRenderer` 逐字符绘制（4x2 / 2x1 像素）。
  - `renderCharacters: false`：按行绘制色块，颜色来自该行 token。
- 大文件通过 `MinimapSamplingState` 采样：行数超过 minimap 可容纳行数时，按比例抽样，而不是绘制全部行。
- `MinimapLayout` 计算滑块：
  - `sliderHeight = max(1, floor(viewportHeight * viewportHeight / logicalScrollHeight))`（当 minimap 高度等于编辑器高度时）；
  - `computedSliderRatio = maxMinimapSliderTop / (scrollHeight - viewportHeight)`；
  - `sliderTop = scrollTop * computedSliderRatio`。
- 这依赖“源码行高基本一致”的前提；Markdown Live Preview 的块级 widget 会破坏该前提，因此不能把 `line / lineCount` 当作纵轴。

### 3.3 可借鉴与拒绝

| 点 | 结论 |
|---|---|
| Canvas 而非 DOM | 采用：长文档不会产生成千上万个节点 |
| 色块模式 | 调研阶段采用；实施后改为文本模式，结构色保留为行语义（F-051） |
| 行采样 | 采用其思想：本方案绘制视口窗口内的真实行；降级时才用像素桶聚合 |
| 行数均分 / 滚动行程比例 | 拒绝：无法表达 widget 高度，滑块与结构错位；改用单一 `docYToRail` + 锚点校准 |
| 字符渲染器 | 实施后采用简化版：1px 字符格 + 上下半行墨迹，不读取真实字体轮廓（F-051） |
| 配置面 | 拒绝：本期不新增 `enabled/size/side/scale` 等设置 |

---

## 4. `replit/codemirror-minimap`

### 4.1 事实

- 仓库：<https://github.com/replit/codemirror-minimap>，MIT，包版本 `0.5.2`。
- 入口：`src/index.ts` 的 `showMinimap` facet + `ViewPlugin.fromClass`。
- 挂载：`this.view.scrollDOM.insertBefore(this.dom, this.view.contentDOM.nextSibling)`，并给 DOM 加 `cm-gutters` / `cm-minimap-gutter` 类（`src/index.ts:77-96`）。
- 宽度：`getWidth()` 按编辑器宽度缩放，最大 `Scale.MaxWidth = 120`（`src/Config.ts`、`src/index.ts:132-139`）。
- 预留：`provide` 返回 `EditorView.scrollMargins.of(view => ({ right: width }))`（`src/index.ts:265-276`）；真正占宽的是 `.cm-gutters` 的 flex 布局。
- 渲染：`TextState` 在文档变化时 `state.doc.toString()`，再用 `parser.parse(docToString, treeFragments)` 整篇解析（`src/text.ts:98-100`）；随后按当前滚动窗口绘制。
- 滚动：`Overlay.ts` 的 `computeTop()` 用 `scrollTop / (scrollHeight - clientHeight)` 的全局比例；点击用 `scrollHeight/clientHeight` 与 `SCALE` 估算。
- 事件：`eventHandlers.scroll` 中 `requestAnimationFrame(() => this.render())`（`src/index.ts:265-270`）。

### 4.2 不采用原因

| 原因 | 证据 | 影响 |
|---|---|---|
| `.cm-gutters` 类冲突 | 本项目 `apps/desktop/src/styles.css:10-21` 把 `.cm-editor .cm-gutters` 强制 `position:absolute; left:0; width:40px`，Live Preview 下 `display:none` | 直接照搬会把 minimap 放到左侧并在 Live Preview 消失 |
| 整篇 `toString()` + Lezer 解析 | `src/text.ts:98-100` | 10 万行文档每次输入都整篇解析，成本不可控 |
| 滚动行程比例 | `src/Overlay.ts` `computeTop()` | 只用 `scrollTop/(scrollHeight-clientHeight)`，与 Canvas 行位置不是同一坐标，滑块与内容漂移 |
| 滚动窗口式绘制 | `canvasStartAndEndIndex()` 按滚动比例只画当前窗口 | 不是“整篇一览”，用户看不到全文结构 |
| 额外依赖 `crelt` | `package.json` | 本项目可直接 `document.createElement`，无需新增依赖 |

> 结论：借“ViewPlugin + Canvas”的骨架；拒绝其挂载、整篇解析和滚动行程比例。最终采用 1:1 文本窗口；像素桶仅作异常降级。

---

## 5. `Nymbo/Markdown-Minimap`（Obsidian）

### 5.1 事实

- 仓库：<https://github.com/Nymbo/Markdown-Minimap>，MIT，版本 `2.9.3`，约 5.3k 行 TypeScript。
- README 明确：多数 minimap 克隆编辑器 DOM，只能看到虚拟化后的可见部分；该项目**独立渲染整篇笔记**。
- `src/anchors.ts`：收集标题锚点，校准编辑器坐标与 minimap 坐标；注释指出“单一全局比例在长笔记上可累积数百像素误差”。
- `src/scroll-model.ts`：
  - `THUMB_REACH = 2`：滑块高度按视口上下各 2 屏平均，避免经过大 embed 时伸缩；
  - `minViewportHeight`：最小可抓取高度；
  - `mappedTop` 同时考虑面板映射与滚动行程，保证首尾精确。
- README 提到 14,000 词笔记上，未校准的比例会让视口标记偏移约 150px。
- 设置包括“按笔记开关”“默认开启”“缩放”“透明度”“为 minimap 让位”等。

### 5.2 可借鉴

| 点 | 采用方式 |
|---|---|
| 整篇独立渲染，不克隆虚拟化 DOM | 采用：Canvas 直接从 `EditorState.doc` 生成行模型 |
| 标题/块边界锚点 | 采用：锚点估算每行 `docY`，Canvas 与滑块共用 `docYToRail` |
| 滑块高度跨屏平均 | 采用其思想：本方案先按可见范围映射并 clamp 最小高度；若 E2E 发现抖动，再加 ±1~2 屏平均 |
| 最小滑块高度 | 采用：`SLIDER_MIN_PX = 24` |
| “为 minimap 让位” | 采用：`.cm-editor` 右侧 padding，而不是覆盖正文 |
| 按笔记/设备设置 | 拒绝：本期不新增持久化配置 |
| 完整 DOM 克隆 + Markdown 重渲染 | 拒绝：复杂度和维护成本远超收益 |
| Prism 语法高亮、折叠同步、图片渲染 | 拒绝：本期只做 1:1 文本轮廓 + 结构色 |

---

## 6. 其他候选与排除

| 候选 | 结论 | 原因 |
|---|---|---|
| 直接引入 `@replit/codemirror-minimap` | 排除 | 依赖冲突、挂载冲突、整篇解析、全局比例 |
| 直接引入 Obsidian 插件代码 | 排除 | 依赖 Obsidian API，无法在 Tauri/CM6 直接运行 |
| DOM/SVG 逐行渲染 | 排除 | 长文档节点数过大，虚拟化/滚动同步复杂 |
| 逐字符 Canvas 字形 | 排除 | 字体度量、DPR、主题、CJK 宽度成本高；76px 下不可读 |
| `EditorView.scrollMargins` 单独预留 | 排除 | 语义不支持布局占宽 |
| 右侧 `.cm-gutters` | 排除 | 现有 CSS 强制左侧 40px 且 Live Preview 隐藏 |
| 新增第三方 minimap 依赖 | 排除 | 本期无必要；自研约 500~700 行可控 |

---

## 7. 采用/拒绝总表

| ID | 来源 | 结论 | 落地决策 | 影响任务 |
|---|---|---|---|---|
| RS-001 | CM6 官方 | 无内建 minimap；`ViewPlugin` 是唯一正确生命周期载体 | D-003 / D-004 | T-004 / T-005 |
| RS-002 | CM6 官方 | `scrollMargins` 不预留布局 | D-003 | T-004 |
| RS-003 | VS Code | Canvas + blocks + 行采样适合长文档 | D-001 / D-008 | T-003 / T-004 |
| RS-004 | VS Code | 行数均分/滚动行程比例依赖均匀行高，Markdown 不成立 | D-002 | T-003 |
| RS-005 | VS Code | 滑块最小 1px、按视口比例计算 | D-002 / AC-004 | T-003 |
| RS-006 | replit | `.cm-gutters` 挂载、整篇解析不可用 | D-003 / D-008 | T-004 |
| RS-007 | replit | Canvas 窗口骨架可借鉴；像素桶仅作降级 | D-001 / D-008 | T-003 / T-004 |
| RS-008 | Obsidian | 锚点校准解决累积误差 | D-002 | T-003 |
| RS-009 | Obsidian | 滑块最小高度与跨屏平均避免抖动 | D-002 / RK-003 | T-003 / T-007 |
| RS-010 | Obsidian | “让位”用布局 margin/padding，不用 transform | D-003 | T-004 / T-006 |
| RS-011 | 本项目 | `.cm-gutters` 全局 CSS 禁止复用 | D-003 | T-004 |
| RS-012 | 本项目 | 嵌套代码块独立 `EditorState`，不得挂 minimap | D-004 | T-005 |
| RS-013 | 本项目 | 主题色唯一来源是 `--qm-*`；Canvas 需 concrete color | D-005 | T-002 |
| RS-014 | 论文 | 语义层（标题/代码/表格）比字符更有导航价值 | D-001 / D-006 | T-003 / T-004 |

---

## 8. 未验证与限制

1. **`lineBlockAt` 批量采样成本未实测**。10 万行 × 最多 1200 个目标锚点（硬上限 2000）的真实浏览器耗时需要在 T-003 用 Playwright/真实 WebView 记录；当前只测了 `Text.iterLines`（见 `04-performance-and-test-evidence.md`）。
2. **`contentHeight` 在 Mermaid/图片异步加载后会变化**。方案依赖 `geometryChanged` 与 `ResizeObserver` 重建；实际触发频率需在 E2E 观察。
3. **Windows 经典滚动条宽度**未在真机验证；方案不读取 `scrollbarWidth`，rail `right:0`，滚动条位于 scroller 内、rail 左侧。
4. **`color-mix()` 在旧 WebView 的支持**未验证；rail 背景使用它，但 Canvas 颜色不依赖它，最坏情况只是背景透明。
5. **Obsidian 插件的跨屏平均**是否必要，取决于本项目 E2E 的滑块抖动观测；先实现简单 clamp，T-007 再决定是否加平均。
