# 开源实现与 Typora 参考证据

> **功能 ID：** `editor-typography`
> **代码基线：** `main@3f654ba6d8d4866529d81566428214a320bebc61`
> **采集日期：** 2026-11-04
> **方法：** `third_party` 本地取证 + GitHub raw 源码 + DeepWiki MCP 解析。
> **许可证提醒：** MarkText 为 MIT；SiYuan、Logseq、Joplin 为 AGPL-3.0 系列。本文只比较行为与数据流，不复制其代码。

---

## 1. Typora（本地 `third_party`）

### 1.1 字体大小：设置项 + 根元素 `font-size`

证据文件：

- `third_party/typora-recovered/recovered/web/page-dist/js/Preferences.962926a4.0b4e81f7.js`
- `third_party/typora-recovered/recovered/web/bundle-main/modules/35-options.js`

设置 UI 的关键片段（`Preferences...js` 约 19236–20250 字节）：

```js
var t = e.value, n = e.customValue, a = e.onChange,
    o = f.a.useState(n || 14), ...
// radio: useCustomFontSize
// number input:
step: "1",
type: "number",
max: "24",
size: "2",
min: "9",
value: l,
onChange: function(e) {
  var t = e.target.value - 0;
  isNaN(t) || (u(Math.floor(t)), t <= 24 && t >= 9 && a("customFontSize", t))
},
onBlur: function() {
  var e = l;
  e > 24 && (e = 24), e < 9 && (e = 9), u(e), a("customFontSize", e)
}
```

设置写入与投影（同文件约 405267 字节）：

```js
case 22:
  return o.execCommand("File.option.useCustomFontSize=%@".replace("%@", n ? "true" : "false")),
    n ? o.execCommand("document.body.parentElement.style.fontSize = '" + (this.getValue("customFontSize") || 14) + "px'")
      : o.execCommand("document.body.parentElement.style.fontSize = ''"),
    e.abrupt("break", 157);
case 25:
  return this.getValue("useCustomFontSize") && (
    o.execCommand("File.option.customFontSize=%@".replace("%@", n)),
    o.execCommand("document.body.parentElement.style.fontSize = '" + (n || 14) + "px'")
  ), e.abrupt("break", 157);
```

可确认的事实：

| 事实 | 证据 |
|---|---|
| 有“Auto (Recommended) / Customized”两种模式 | 设置 UI 的 radio |
| 自定义字号范围 9–24，步进 1 | number input `min=9 max=24 step=1` |
| 未设置时回退 14（UI 默认显示） | `useState(n \|\| 14)`、`(n \|\| 14)` |
| 投影到 `document.body.parentElement.style.fontSize`，即根 `html` | `case 22` / `case 25` |
| 关闭自定义时清除根字号 | `style.fontSize = ''` |
| Zoom 是独立设置 | 同页 “Zoom” 区块，`zoomFactor` 0.5–2.0 |

**不采用的原因：**

- Typora 把字号写在根 `html` 上，会同时缩放整个 Web UI 的 `rem`/继承字号；青墨的编辑器只是应用的一部分，根字号会污染 Settings、StatusBar、对话框等 chrome。
- 青墨已有明确的编辑器主题层，应该把排版限制在 `.cm-editor` 内。

### 1.2 字体族：设置 UI 没有字体族选项，只能改 CSS

证据：

- `third_party/Typora.app/Contents/Resources/TypeMark/Docs/Custom Font.md`

原文：

> “Custom font in Typora are set by CSS.”
>
> ```css
> body {
>   font-family: Courier;
> }
> ```

可确认的事实：

- Typora 设置页只提供字号，不提供字体族下拉/预设。
- 自定义字体族通过主题 CSS 覆盖 `body`，属于“主题作者/高级用户”能力。
- Typora 官方推荐把 web font 放到主题目录，说明它不枚举系统字体。

**对青墨的含义：**

- 青墨不需要复刻 Typora 的“只能改 CSS”；但也不应做系统字体枚举。
- 使用现有三个设计 token（mono/sans/serif）作为预设，是比自由文本更安全、更一致的最小能力。

### 1.3 字号与 Zoom 分离

Typora 同一设置页同时有 “Font Size” 和 “Zoom”，`zoomFactor` 独立。说明：

- 字号是“排版偏好”，Zoom 是“整页缩放”，两者不是同一件事。
- 青墨本方案只做字号 + 字体族；应用级 zoom 不在范围内（浏览器/WebView 缩放仍可用）。

---

## 2. MarkText（MIT）

### 2.1 设置键与范围

DeepWiki 解析 + GitHub raw 源码（`develop` 分支）：

- 设置 UI：`packages/desktop/src/renderer/src/prefComponents/editor/index.vue`
- 编辑器 watcher：`packages/desktop/src/renderer/src/components/editorWithTabs/editor.vue`
- 偏好定义：`packages/desktop/src/renderer/src/prefComponents/editor/config.ts` 与偏好 schema

关键源码（`editor/index.vue`）：

```vue
<range
  id="setting-fontSize"
  :value="fontSize"
  :min="12"
  :max="32"
  unit="px"
  :step="1"
  :on-change="(value) => onSelectChange('fontSize', value)"
/>
<range
  id="setting-codeFontSize"
  :value="codeFontSize"
  :min="12"
  :max="28"
  unit="px"
  :step="1"
  :on-change="(value) => onSelectChange('codeFontSize', value)"
/>
<range
  id="setting-lineHeight"
  :value="lineHeight"
  :min="1.2"
  :max="2.0"
  :step="0.1"
  :on-change="(value) => onSelectChange('lineHeight', value)"
/>
<font-text-box
  id="setting-editorFontFamily"
  ...
/>
```

`editor.vue` 的 watcher：

```js
watch(fontSize, (value, oldValue) => {
  editor.value.setOptions({ fontSize: value })
})
watch(lineHeight, (value, oldValue) => {
  editor.value.setOptions({ lineHeight: value })
})
watch(editorFontFamily, (value, oldValue) => {
  editor.value.setOptions({ editorFontFamily: resolveEditorFont(value) })
})
```

DeepWiki 给出的偏好键与默认值：

| 键 | 类型 | 默认 | 范围 |
|---|---|---|---|
| `fontSize` | number | 16 | 12–32 |
| `codeFontSize` | number | — | 12–28 |
| `lineHeight` | number | — | 1.2–2.0 |
| `editorFontFamily` | string | `"Open Sans"` | 字体文本框/内置字体列表 |
| `codeFontFamily` | string | — | 字体文本框/内置字体列表 |
| `editorLineWidth` | string/number | — | 阅读宽度 |

### 2.2 可借鉴与不借鉴

可借鉴：

- 字号用 range + 单位 + step，实时 `setOptions` 热更新，不重建文档。
- 字体族和字号分开设置，代码字体单独设置。
- 偏好是全局设置，不是每文档。

不借鉴：

- 任意字体族文本框：青墨只有三个 token，自由文本会引入不可控字体栈和 CSS 注入面。
- 代码字号/行高/阅读宽度同时暴露：首版范围过大，验证矩阵会膨胀。
- MarkText 的 `setOptions` 是它自己的编辑器抽象；青墨应使用 CM6 compartment，而不是复制它的 API 形态。

---

## 3. SiYuan（AGPL-3.0）

DeepWiki 解析结论（未逐行核对全部源码，标注为“DeepWiki 证据”）：

| 能力 | 设置键 | 投影 |
|---|---|---|
| 编辑器字号 | `editor.fontSize` | CSS 变量 `--b3-font-size-editor` |
| 编辑器字体族 | `fontFamilies` | CSS 变量 `--b3-font-family-editor` |
| 代码字体族 | `codeFontFamilies` | 独立 CSS 变量 |
| 行高 | 固定 | 约 `1.625`，未作为用户设置 |

可借鉴：

- 字号/字体族通过设置键集中管理，再投影为 CSS 变量；与青墨 `uiStore` + typography 扩展的“单一来源”思路一致。
- 行高固定，说明“首版只做字号 + 字体族”在产品上是成立的。

不借鉴：

- 直接用根 CSS 变量驱动编辑器：CM6 的测量失效需要 theme facet 变化；SiYuan 的编辑器不是 CM6，不能照搬。
- 字体族用自由列表：青墨不枚举系统字体。

---

## 4. Logseq（AGPL-3.0）

DeepWiki 解析结论：

- 字体族通过 `--ls-font-family` 与 `data-font` 属性控制。
- 字号主要通过主题 CSS，没有像 Typora/MarkText 那样的直接设置 UI。
- 行高/阅读宽度由主题 CSS 决定。

可借鉴：

- 用 `data-*`/CSS 变量做主题级字体切换是可行的，但青墨已有 `uiStore` + CM6 主题层，不需要再引入 `data-font`。
- 它证明“只提供少量预设字体”是常见产品选择。

不借鉴：

- 没有直接设置 UI，用户必须写 CSS；不符合青墨“设置窗口可视化”的目标。

---

## 5. Joplin（AGPL-3.0）

DeepWiki 解析结论：

| 设置键 | 作用 |
|---|---|
| `style.editor.fontSize` | 编辑器正文字号 |
| `style.editor.fontFamily` | 编辑器正文字体族 |
| `style.editor.monospaceFontFamily` | 等宽字体族 |

实现要点：

- Joplin 的 CM6 编辑器通过 `createTheme` 生成主题，把设置值注入编辑器样式。
- 字号/字体族是全局设置，代码字体单独配置。

可借鉴：

- CM6 主题生成 + 全局设置，和本方案的结构最接近。
- 正文字体与代码字体分开，符合青墨“代码块保持 mono”的边界。

不借鉴：

- Joplin 同时暴露正文字体、等宽字体、字号等多个键；青墨首版只做一个正文字体预设 + 一个字号。

---

## 6. 横向对比

| 产品 | 字号 | 字体族 | 行高 | 阅读宽度 | 存储/作用域 | 投影方式 |
|---|---|---|---|---|---|---|
| Typora | 9–24，默认 14/16 | 仅 CSS | 主题 CSS | 主题 CSS | 全局偏好 | 根 `html` font-size |
| MarkText | 12–32，默认 16 | 自由文本 + 内置列表 | 1.2–2.0 | 有 | 全局偏好 | 编辑器 `setOptions` |
| SiYuan | 有 | 字体列表 | 固定 1.625 | 主题 | 全局设置 | CSS 变量 |
| Logseq | 主要 CSS | `--ls-font-family` + `data-font` | 主题 CSS | 主题 CSS | 全局/主题 | CSS 变量 |
| Joplin | 有 | 正文字体 + 等宽字体 | 主题 | 有 | 全局设置 | CM6 `createTheme` |
| **青墨（本方案）** | **12–30，默认 15** | **mono/sans/serif 三预设** | **固定 1.75** | **不做（现有缺口）** | **全局 localStorage** | **CM6 typography compartment** |

---

## 7. 结论

1. **字号 + 字体族预设**是开源产品中最稳定、最小可用的组合；行高/阅读宽度可以后续独立演进。
2. **全局偏好**是主流；每文档排版会与青墨现有 Rust `view-state` 的 `live_preview_preferred` 语义混淆，首版不做。
3. **不枚举系统字体**：三个现有 token 足够覆盖 mono/sans/serif，且避免字体栈注入与跨平台差异。
4. **不使用根 `html` font-size**：会污染应用 chrome；CM6 typography 扩展把影响限制在编辑器内。
5. **不使用自由文本字体族**：枚举值可校验、可持久化、可测试。
6. **不做应用级 zoom**：Typora 也把 Font Size 与 Zoom 分开；青墨首版只做排版偏好。
