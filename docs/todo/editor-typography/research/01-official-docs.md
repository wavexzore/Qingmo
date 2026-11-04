# 官方文档证据：CodeMirror 6、WCAG 2.2、React 生命周期

> **功能 ID：** `editor-typography`
> **代码基线：** `main@3f654ba6d8d4866529d81566428214a320bebc61`
> **采集日期：** 2026-11-04
> **用途：** 为“编辑器字体调整”方案提供官方 API、测量失效、无障碍与生命周期依据。
> **限制：** 本文只记录官方文档与本地实际安装版本源码；不把社区帖子当作规范。

---

## 1. CodeMirror 6 Styling

来源：<https://codemirror.net/examples/styling/>

### 1.1 字体与行高不是固定假设

原文（2026-11-04 抓取）：

> “The editor does not expect a monospace font or a fixed line height.”

同一段还说明：

> “You can style content text with varying fonts, size, color, etc.”

结论：

- CM6 没有把“等宽字体 + 固定行高”写进编辑器不变量；青墨当前的 `var(--qm-font-mono)` / `1.75` 是产品选择，不是框架约束。
- 改变正文字体族或字号不会违反 CM6 的布局模型；但必须让 CM6 重新测量字体度量（见 §2）。

### 1.2 主题是扩展，不是全局 CSS 文件

原文要点：

- “Themes are simply extensions that tell the editor to mount an additional style module and add the (generated) class name that enables those styles to its outer DOM element.”
- 主题规则会被加上生成的类名前缀；`&` 代表编辑器外层元素。
- 注入样式位于其他样式表之前，因此普通 CSS 仍可覆盖主题；这也意味着**应用级 CSS 与 CM6 主题可能形成第二套来源**，必须显式划清边界。

对本方案的含义：

- 用 `EditorView.theme` 生成 typography 样式模块，符合官方扩展模型。
- 不再在 `apps/desktop/src/styles.css` 或 `tokens.css` 里复制字号/字体族；`tokens.css` 只保留字体族 token。

---

## 2. CodeMirror 6 Reference

来源：<https://codemirror.net/docs/ref/>

### 2.1 `EditorView.theme`

参考手册定义：创建一个注册样式模块、并把生成类名加到编辑器外层的扩展；`&` 指代编辑器外层，`&dark` / `&light` 可限定明暗主题。

本地安装版本源码（`@codemirror/view@6.43.15`，`node_modules/@codemirror/view/dist/index.js:8829-8834`）：

```js
static theme(spec, options) {
    let prefix = StyleModule.newName();
    let result = [theme.of(prefix), styleModule.of(buildTheme(`.${prefix}`, spec))];
    if (options && options.dark)
        result.push(darkTheme.of(true));
    return result;
}
```

关键点：

- 每次调用 `EditorView.theme` 都会生成新的 `theme` facet 值和新的 style module。
- 因此 typography 扩展应按 `(fontSize, fontFamily)` 缓存，避免滑杆连续变化时不断创建样式模块。
- 不传 `{ dark: true }` 的 typography 主题不会改变 `darkTheme` facet；明暗仍由现有 `themeExtension` 拥有。

### 2.2 `requestMeasure`

参考手册原文：

> “Schedule a layout measurement, optionally providing callbacks to do custom DOM measuring followed by a DOM write phase. Using this is preferable to reading DOM layout directly from, for example, an event handler, because it'll make sure measuring and drawing done by other components is synchronized, avoiding unnecessary DOM layout computations.”

来源：<https://codemirror.net/docs/ref/#view.EditorView.requestMeasure>

### 2.3 `defaultLineHeight` / `defaultCharacterWidth`

参考手册说明 `defaultLineHeight` 是“The default height of a line in the editor. May not be accurate for all lines.”，`defaultCharacterWidth` 是默认字符宽度。两者都来自 CM6 的 `HeightOracle`，只有在一次 `measure()` 重新读取字体度量后才会更新。

来源：

- <https://codemirror.net/docs/ref/#view.EditorView.defaultLineHeight>
- <https://codemirror.net/docs/ref/#view.EditorView.defaultCharacterWidth>

### 2.4 `setState` 的代价

参考手册明确：`setState` 会“cause the entire document to be redrawn and all view plugins to be reinitialized”，只应在“new state isn't derived from the old state”时使用。

本地源码（`dist/index.js:8120-8156`）与 `EditorSession.replacePayload` 的注释（`EditorSession.ts:417-420`）都表明：

- `setState` 会重建 ViewPlugin、清空 undo。
- 字体偏好是派生状态，不是文档替换；不能用 `setState` 实现热切换。

---

## 3. CM6 测量失效的真实路径

以下均来自本地安装的 `@codemirror/view@6.43.15`，不是推测。

### 3.1 theme facet 变化会自动触发测量

`dist/index.js:8094-8097`：

```js
if (update.startState.facet(theme) != update.state.facet(theme))
    this.viewState.mustMeasureContent = true;
if (redrawn || attrsChanged || scrollTarget || this.viewState.mustEnforceCursorAssoc || this.viewState.mustMeasureContent)
    this.requestMeasure();
```

结论：

- 只要 typography 通过 `EditorView.theme` 进入 `theme` facet，compartment 重配就会自动设置 `mustMeasureContent = true` 并安排测量。
- 不需要调用方手写 `view.requestMeasure()`，也不依赖“调用方记得”。

### 3.2 `measure()` 只在 `measureContent` 为真时重读字体度量

`dist/index.js:6386-6390`：

```js
let refresh = this.heightOracle.mustRefreshForWrapping(whiteSpace) || this.mustMeasureContent === "refresh";
let domRect = dom.getBoundingClientRect();
let measureContent = refresh || this.mustMeasureContent || this.contentDOMHeight != domRect.height;
this.contentDOMHeight = domRect.height;
this.mustMeasureContent = false;
```

`dist/index.js:6447-6452`：

```js
if (measureContent) {
    let lineHeights = view.docView.measureVisibleLineHeights(this.viewport);
    if (oracle.mustRefreshForHeights(lineHeights))
        refresh = true;
    if (refresh || oracle.lineWrapping && Math.abs(contentWidth - this.contentDOMWidth) > oracle.charWidth) {
        let { lineHeight, charWidth, textHeight } = view.docView.measureTextSize();
        refresh = lineHeight > 0 && oracle.refresh(whiteSpace, lineHeight, charWidth, textHeight, ...);
```

结论：

- 纯 CSS 变量修改如果没有触发 `mustMeasureContent`，且内容高度恰好不变，CM6 可能不会重读 `charWidth`。
- 这正是本方案拒绝“只改 `:root` CSS 变量 + 手动 requestMeasure”的原因之一。

### 3.3 CM6 自带的 ResizeObserver 只观察 `scrollDOM`

`dist/index.js:7234-7240`：

```js
if (typeof ResizeObserver == "function") {
    this.resizeScroll = new ResizeObserver(() => {
        ...
        if (... lastUpdate < Date.now() - 75)
            this.onResize();
    });
    this.resizeScroll.observe(view.scrollDOM);
}
```

结论：

- CM6 不会因为 `contentDOM` 的字体度量变化自动测量；它观察的是 `scrollDOM` 尺寸。
- typography 必须走 theme facet 变化，才能稳定触发 `mustMeasureContent`。

### 3.4 minimap 自己的 ResizeObserver

`packages/editor-core/src/minimap/minimap.ts:489-503` 同时观察 `view.dom`、`view.scrollDOM`、`view.contentDOM`；`minimap.ts:543-548` 在 `transaction.reconfigured` 时安排重建。

结论：

- typography compartment 重配会产生 `reconfigured` transaction，minimap 会重建 anchor map / scale。
- 这是选择 CM6 compartment 而不是纯 CSS 变量的另一个直接收益。

---

## 4. WCAG 2.2

### 4.1 SC 1.4.4 Resize Text（AA）

来源：<https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html>

规范原文：

> “Except for captions and images of text, text can be resized without assistive technology up to 200 percent without loss of content or functionality.”

对本方案的含义：

- **不能把“浏览器缩放始终可用”当作已验证事实。** 青墨当前没有应用内 zoom 命令；Tauri WebView 是否支持 `Cmd+plus`/捏合缩放尚未在真实打包环境验证。Settings 窗口固定 1120×720、不可缩放，其自身 chrome 的缩放也不在本功能范围。
- 本功能提供应用内字号调整，是 1.4.4 的**直接支持之一**，但不能据此宣称整个应用（尤其 Settings chrome）满足 1.4.4。
- 字号范围上限必须足够大，使低视力用户不必只依赖未验证的浏览器缩放。方案取 `12–30px`，覆盖常用阅读尺寸。

### 4.2 SC 1.4.8 Visual Presentation（AAA）

来源：<https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html>

规范原文（节选）：

> “Width is no more than 80 characters or glyphs (40 if CJK).”
>
> “Line spacing (leading) is at least space-and-a-half within paragraphs...”
>
> “Text can be resized without assistive technology up to 200 percent in a way that does not require the user to scroll horizontally to read a line of text on a full-screen window.”

对本方案的含义：

- 现有 `1.75` 行高满足“至少 1.5 倍”的**行距下限**。
- 现有编辑器开启 `EditorView.lineWrapping`（`packages/editor-core/src/extensions/basic.ts:97`），字号增大后不会产生横向滚动。
- **重要事实校准：** `packages/ui/src/tokens.css:180` 定义了 `--qm-content-max: 72ch`，但全仓 `rg` 没有消费点；当前编辑器并没有 72ch 最大行宽。方案不得声称“保持 72ch”。行长限制是独立的未来能力（见 `README.md` 的 Q-004）。
- 因此**不能声称当前编辑器整体满足 1.4.8**：行长 ≤80 字符（CJK 40）、段距/字距等仍未验证或未实现。本方案只保证“字号可调 + 行距 1.75 + 不横向滚动”这部分。

### 4.3 SC 1.4.12 Text Spacing（AA）

来源：<https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html>

规范原文（节选）：

> “Line height (line spacing) to at least 1.5 times the font size;”
>
> “Spacing following paragraphs to at least 2 times the font size;”
>
> “Letter spacing (tracking) to at least 0.12 times the font size;”
>
> “Word spacing to at least 0.16 times the font size.”

对本方案的含义：

- 规范要求的是“用户覆盖行高/段距/字距/词距时不丢内容”，不是“作者必须使用这些值”。CM6 的行高是普通 CSS，理论上可被用户样式覆盖；但 Tauri 桌面应用没有浏览器扩展式的用户样式表机制，本方案也未做 text-spacing 覆盖测试。
- 因此**不宣称满足 1.4.12**；只保证字号调整不写死 `px` 行高，继续使用无单位 `1.75`，随字号缩放。若要把 1.4.12 纳入验收，应新增 text-spacing 测试（1.5× 行高、2× 段距、0.12× 字距、0.16× 词距）。

---

## 5. React 生命周期

### 5.1 `useLayoutEffect`

React 官方文档说明：`useLayoutEffect` 在浏览器重新绘制屏幕之前触发；适合“在浏览器绘制前测量布局”。

来源：<https://react.dev/reference/react/useLayoutEffect>

对本方案的含义：

- 编辑器 `EditorHost` 在 passive `useEffect` 中创建唯一 `EditorView`（`apps/desktop/src/features/editor/EditorHost.tsx:39-51`）。
- `WorkspaceLayout` 的 `useLayoutEffect` 会在子组件的 passive effect 之前运行，因此可以在 view 创建前把持久化的 typography 写入 `EditorState`，避免首帧字号/字体闪烁。
- 这是方案选择 `useLayoutEffect` 而不是 `useEffect` 的依据；仍需 E2E 验证真实 WebView 行为。

### 5.2 `useSyncExternalStore`

`uiStore` 已经用 `useSyncExternalStore` 暴露快照（`apps/desktop/src/stores/uiStore.ts:292-294`）。新 hook 复用同一模式，不引入第二个 store。

来源：<https://react.dev/reference/react/useSyncExternalStore>

---

## 6. 官方文档结论

| 结论 | 证据 | 对方案的影响 |
|---|---|---|
| CM6 不要求等宽字体或固定行高 | Styling 文档 | 字体族/字号可作为用户偏好 |
| `EditorView.theme` 是标准扩展 | Ref + 源码 | 用 typography 独立 style module |
| theme facet 变化自动触发测量 | 源码 `8094-8097` | 不需要手动 `requestMeasure` |
| 纯 CSS 变量不会自动测量 | 源码 `7234-7240`、`6386-6390` | 拒绝纯 CSS 方案 |
| `setState` 重建全文与插件 | Ref + 源码 | 拒绝重建 `EditorState` |
| WCAG 1.4.8 要求 ≤80 字符 / ≥1.5 行高 | W3C | 保留 1.75；行长是独立缺口 |
| `--qm-content-max: 72ch` 当前未消费 | `tokens.css:180` + `rg` | 不得声称现有 72ch |
| `useLayoutEffect` 在绘制前运行 | React 文档 | 首帧应用 typography |
