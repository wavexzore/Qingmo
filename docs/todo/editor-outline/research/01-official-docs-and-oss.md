# 官方文档与开源实现证据

> 功能：编辑器大纲面板（Outline）  
> 代码基线：`main@e97d651`（2026-10-30）  
> 检索方式：本地 `node_modules` 源码核对 + DeepWiki + GitHub 代码检索 + Exa  
> 用途：证明 `headingOutline` 字段、解析推进、Session 桥接、面板交互和菜单契约的设计选择有依据。

---

## 0. 结论先行

1. **CM6 初始语法树只覆盖前 3000 units**。`LanguageState.init` 明确使用 `Math.min(3000, state.doc.length)`；只在 `StateField.create` 里扫描会长期缺标题。
2. **`ensureSyntaxTree` 可以推进解析，但会临时改 viewport 并可能阻塞**。Zettlr 在 `tocField` 里用 `ensureSyntaxTree(state, doc.length, 1000)`；这证明可行，但 1000ms 的同步预算不适合输入路径。
3. **`forceParsing` 是更合适的“推进并发布”API**：它推进解析，树变化时 `view.dispatch({})`，让 StateField 在下一个事务重建。
4. **Zettlr 的 `tocField` 是共享 StateField 的强先例**：同一个字段被 ToC tab、标题自动补全、move-section、链接解析复用；但它只在 `docChanged` 更新，树推进不会触发重建。
5. **VS Code Outline 的活动项跟随光标**，模型服务去抖/取消，点击通过 `_editor.reveal` 定位；这与本方案 D-011/D-010 一致。
6. **MarkText 的 TOC 数据来自 Muya 的第二套内容模型**，通过 Vuex 存储；这提醒我们不要让侧栏再建一份文档模型。
7. **Typora 的跳转余量是 10px**（`scrollAdjust(elem, 10)`），活动项按滚动位置二分并在面板内自动滚动；本方案只借鉴 10px 和关闭行为，活动项改用光标。

---

## 1. CodeMirror 6 官方文档与本地源码

### 1.1 初始解析预算

本地 `node_modules/.pnpm/@codemirror+language@6.13.1/node_modules/@codemirror/language/dist/index.js`：

```js
static init(state) {
    let vpTo = Math.min(3000 /* Work.InitViewport */, state.doc.length);
    let parseState = ParseContext.create(state.facet(language).parser, state, { from: 0, to: vpTo });
    if (!parseState.work(20 /* Work.Apply */, vpTo))
        parseState.takeTree();
    return new LanguageState(parseState);
}
```

结论：

- 新建 `EditorState` 时只解析前 3000 units。
- 如果 `headingOutline.create` 只读 `syntaxTree(state)`，超过 3000 units 的标题不会出现。
- 需要在语法树推进时重建字段，而不是只在 create/docChanged 时扫描。

### 1.2 解析 worker 的推进范围

同一文件 `parseWorker.work()`：

```js
let done = field.context.work(..., vpTo + (viewportFirst ? 0 : 100000 /* Work.MaxParseAhead */));
```

结论：

- 后台 worker 会优先解析 viewport，然后最多再解析 100k units；不保证覆盖全文。
- 对 200k 文档，如果视口在顶部，后台可能只到 100k；需要 `outlineParseDriver` 主动推进到扫描上限。

### 1.3 `ensureSyntaxTree`

```js
function ensureSyntaxTree(state, upto, timeout = 50) {
    let parse = state.field(Language.state, false)?.context;
    if (!parse) return null;
    let oldVieport = parse.viewport;
    parse.updateViewport({ from: 0, to: upto });
    let result = parse.isDone(upto) || parse.work(timeout, upto) ? parse.tree : null;
    parse.updateViewport(oldVieport);
    return result;
}
```

结论：

- 可以用返回的 tree 直接扫描，即使 `syntaxTree(state)` 尚未发布。
- 会临时把 viewport 改成 `0..upto`，并最多同步工作 `timeout` ms。
- 在 `StateField.update` 中调用会把解析成本放进 state 更新路径；配合大 timeout 会阻塞输入。
- **本方案拒绝在字段内使用**；只在测试/诊断中可用于强制解析。

### 1.4 `forceParsing`

```js
function forceParsing(view, upto = view.viewport.to, timeout = 100) {
    let success = ensureSyntaxTree(view.state, upto, timeout);
    if (success != syntaxTree(view.state)) view.dispatch({});
    return !!success;
}
```

结论：

- 适合 ViewPlugin：推进解析，并在树变化时派发空事务。
- `headingOutline` 监听 `syntaxTree !==` 后会重建。
- 每次调用仍同步工作 `timeout` ms；本方案用 8ms 切片 + 空闲调度。

### 1.5 StateField

官方参考：https://codemirror.net/docs/ref/#state.StateField

- `StateField.define({ create, update, provide })`。
- `update(value, transaction)` 必须返回新值或原值；不应 dispatch。
- `state.field(field)` 可按需读取；字段不存在时用 `state.field(field, false)`。
- 字段值应视为不可变；React 可安全比较引用。

本方案用法：

- `create` 构建初始快照；`update` 只在 `docChanged || treeChanged` 时重建。
- 不在字段 update 中 dispatch/解析推进；解析推进交给 ViewPlugin。

### 1.6 `EditorView.scrollIntoView`

官方参考：https://codemirror.net/docs/ref/#view.EditorView^scrollIntoView

```ts
EditorView.scrollIntoView(pos, { y: "start", yMargin: 10 })
```

- `y: "start"` 把目标放到视口顶部；`yMargin` 留 10px。
- 与 Typora 的 `scrollAdjust(elem, 10)` 对齐。
- 通过 transaction effect 使用，不直接改 `scrollTop`，保留 CM6 的滚动协调。

### 1.7 React `useSyncExternalStore`

官方参考：https://react.dev/reference/react/useSyncExternalStore

- `subscribe` 必须稳定；`getSnapshot` 必须返回缓存值，不能在每次调用创建新对象。
- 本方案 `getOutlineSnapshot` 返回字段对象；字段未变时同一引用。
- `subscribeOutline` 是 session 的箭头属性，引用稳定。

---

## 2. Zettlr：`tocField` 共享 StateField

仓库：https://github.com/Zettlr/Zettlr  
文件：`source/common/modules/markdown-editor/plugins/toc-field.ts`  
许可证：GPL-3.0（只借鉴职责/结构，不复制代码）

关键实现（本地抓取原文）：

```ts
export const tocField = StateField.define<ToCEntry[]>({
  create (state) {
    return generateToc(state)
  },
  update (value, transaction) {
    if (!transaction.docChanged) {
      return value
    }
    return generateToc(transaction.state)
  }
})
```

```ts
function generateToc (state: EditorState): ToCEntry[] {
  let tree = ensureSyntaxTree(state, state.doc.length, 1000)
  if (tree === null) {
    tree = syntaxTree(state)
  }
  tree.iterate({ ... })
}
```

`ToCEntry`：

```ts
export interface ToCEntry {
  line: number
  pos: number
  text: string
  level: number
  renderedLevel: string
  id: string
}
```

DeepWiki 补充：

- `tocField` 被 `ToCTab.vue` 消费；`MainEditor.vue` 把 `tableOfContents` 写入 `windowStateStore`；`MarkdownEditor` 的 `tableOfContents` getter 直接读 `_instance.state.field(tocField, false)`。
- 同一字段还用于 `moveSection`、标题自动补全、`open-markdown-link` 的 `findMatchingHeading`。

可借鉴：

1. 用 StateField 作为唯一 TOC 数据源，而不是 UI 侧扫描。
2. 条目包含 `line/pos/text/level/id`，足够 UI 和跳转。
3. 字段被多个消费者复用，证明“共享字段”不是过度设计。

不采用：

1. `ensureSyntaxTree(..., 1000)` 放在字段 create/update 中：同步预算太大，输入路径会卡。
2. 只在 `docChanged` 更新：语法树推进（无 docChanged）不会重建；本方案必须监听 `treeChanged`。
3. `headingToID` 的 Pandoc 规则与青墨的 GitHub slug 不同；不复制。
4. GPL-3.0 代码不能直接搬进 Apache-2.0 项目；只借鉴模式。

---

## 3. VS Code：OutlineModel / OutlineModelService

仓库：https://github.com/microsoft/vscode  
文件：`src/vs/editor/contrib/documentSymbols/browser/outlineModel.ts`、`src/vs/workbench/contrib/codeEditor/browser/outline/documentSymbolsOutline.ts`  
许可证：MIT

DeepWiki 结论：

- `OutlineModel` 表示文档符号层级；`OutlineModelService` 缓存并按需创建模型。
- 模型更新有 **coalescing（去抖）** 和 **cancellation（取消）**：`TimeoutTimer` 延迟 `_createOutline`，新请求用 `CancellationTokenSource` 取消旧请求。
- 活动项跟随光标：光标变化触发去抖的 `_onDidChange`，`OutlinePane.revealActiveElement` 高亮对应符号；`OutlineModel.getItemEnclosingPosition` 找当前位置的符号。
- 点击条目：`OutlinePane` 的 `onDidOpen` → `IOutline.reveal` → `DocumentSymbolsOutline.reveal` → `_editor.reveal`。

可借鉴：

1. 模型与视图分离；UI 只消费模型。
2. 活动项跟随光标（D-011）。
3. 点击 reveal 到编辑器（D-010）。
4. 更新去抖/取消；本方案用 100ms 通知节流 + 字段同步构建，规模更小。

不采用：

1. `DocumentSymbolProvider` 注册/多 provider 分组：Markdown 只有一个本地 parser，不需要。
2. 异步 Promise 模型：200k 上限下同步构建足够；异步会增加状态机。
3. 符号图标/排序/过滤/拖拽：超出 v1。

---

## 4. MarkText：TOC sidebar

仓库：https://github.com/marktext/marktext  
文件：`packages/desktop/src/renderer/src/components/sideBar/toc.vue`  
许可证：MIT

关键事实（代码检索 + DeepWiki）：

- `toc.vue` 使用 Element UI `el-tree`：
  - `:data="keyedToc"`
  - `node-key="key"`
  - `:default-expanded-keys="expandedKeys"`
  - `:current-node-key="activeNodeKey"`
  - `highlight-current`
- TOC 数据来自 Vuex `editor` store 的 `toc`，由 Muya 的 `getTOC`（`contentState/tocCtrl.js`）从编辑器 blocks 生成。
- 点击条目触发 `scroll-to-header`，携带 `slug`；`editor.vue` 的 `scrollToElement` 用 `#${slug}` 找 DOM 并 `animatedScrollTo`。
- Source 模式有单独的 `sourceCode.vue` 处理 `scroll-to-header`，通过 `findMarkdownHeadingLine`/`scrollSourceEditorToLine` 定位。

可借鉴：

1. `el-tree` 的 current node/展开节点交互。
2. 点击用 slug 事件解耦。
3. 侧栏固定宽度、可切换面板。

不采用：

1. TOC 数据来自 Muya 的第二套内容模型 + Vuex；青墨已有 CM6 单一状态，不能复制。
2. 点击依赖渲染 DOM 的 `#slug`；青墨用文档位置 `lineFrom`，Source/LP 都可靠。
3. 富文本/展开状态持久化；v1 不做。

---

## 5. Typora recovered：OutlinePanel 行为证据

文件：`third_party/typora-recovered/recovered/web/relinked/bundle-main/ui/OutlinePanel.js`  
性质：恢复的闭源 bundle；只作为行为参考，不复制代码。

关键行为：

1. **构建层级列表**：`p(e)` 从 `e.headers` 生成嵌套 `<ul class='outline-children'>`，按 `depth` 闭合；`outline-item-wrapper outline-h{depth}`。
2. **活动项**：`highlightVisibleHeader` 用 `writingArea` 的标题元素与 `scrollTop` 做二分（`b(e)` 返回 -1/0/1），选中 `outline-item-active`/`outline-active`。
3. **延迟**：`highlightVisibleHeaderWithDelay` 在 busy 时 200ms、否则 100ms；`post-wheel` 触发。
4. **面板内自动滚动**：活动项距面板顶部 <0 或超过高度-20 时，滚动 `scrollTop` 并留 200px 余量。
5. **点击跳转**：`.outline-item` 点击 → `findElemById` → `selection.scrollAdjust(elem, 10)`；`autoHideOutline()`（未 pin 时）；`focusAndRestorePos()`。
6. **折叠/展开**：`useCollapsibleOutline`/`useFlatOutline`；`expandAll`/`collapseAll`；展开状态 `expandedOutlineItem`。
7. **过滤**：`search(e)` 用正则高亮 `ty-outline-hit`，未命中加 `ty-outline-miss`；Enter 跳转；上下键选择。
8. **空/短文档**：`n.length<20` 时全部展开。

可借鉴：

1. 点击余量 10px（D-010）。
2. 活动项在面板内 `scrollIntoView`，不滚动编辑器。
3. 关闭/未 pin 时 auto-hide；青墨 v1 用显式开关，不做 auto-hide。
4. 折叠/过滤是后续能力（NEXT-002/003）。

不采用：

1. 视口滚动高亮（需要 scroll/rAF/几何；Q-004 推荐光标）。
2. 折叠/展开、过滤、右键菜单、flat/collapsible 设置（v1 范围外）。
3. DOM `data-ref` 节点 id 映射（青墨用文档位置）。
4. 直接操作 jQuery/`innerHTML`（青墨用 React text nodes）。

---

## 6. 开源实现对比表

| 维度 | Zettlr | VS Code | MarkText | Typora | 青墨方案 |
|---|---|---|---|---|---|
| 数据源 | CM6 StateField | Language provider | Muya blocks + Vuex | 编辑器 nodeMap | CM6 `headingOutline` |
| 唯一性 | 字段共享 | 模型服务 | 第二套内容模型 | DOM 派生 | 字段共享 |
| 更新 | 仅 docChanged | 去抖/取消 | 内容变化 | 渲染后重建 | docChanged + treeChanged |
| 活动项 | 未知 | 光标 | current node | 视口滚动 | 光标 |
| 点击 | 字段 line/pos | `_editor.reveal` | slug → DOM | `scrollAdjust(10)` | `lineFrom` + scrollIntoView |
| 折叠 | 未知 | 树 | `el-tree` | 支持 | v1 不做 |
| 过滤 | 未知 | 有 | 未知 | 支持 | v1 不做 |
| 许可证 | GPL-3.0 | MIT | MIT | 闭源 | 只借鉴模式 |

---

## 7. 设计结论

| 结论 ID | 证据 | 结论 | 落地 |
|---|---|---|---|
| RS-001 | CM6 `LanguageState.init` | 初始只解析 3000 units | 字段监听 treeChanged + driver |
| RS-002 | CM6 `forceParsing` | 可推进并发布树 | `outlineParseDriver` |
| RS-003 | Zettlr | StateField 共享可行 | D-001 |
| RS-004 | Zettlr | 1000ms `ensureSyntaxTree` 阻塞 | 拒绝字段内解析 |
| RS-005 | VS Code | 活动项跟随光标 | D-011 |
| RS-006 | VS Code | 点击 reveal | D-010 |
| RS-007 | MarkText | 第二套内容模型风险 | 不复制 |
| RS-008 | Typora | 10px 跳转余量 | D-010 |
| RS-009 | Typora | 面板内自动滚动 | OutlinePanel |
| RS-010 | 本项目 | Snapshot 不能含正文 | D-006 |
| RS-011 | 本项目 | 菜单三处同步 | D-013 |
| RS-012 | 本项目 | 三套标题扫描 | D-001/D-003 |

---

## 8. 参考资料

- CodeMirror 6 Reference: https://codemirror.net/docs/ref/
- CodeMirror `@codemirror/language` 6.13.1 本地源码：`node_modules/.pnpm/@codemirror+language@6.13.1/.../dist/index.js`
- Zettlr `toc-field.ts`: https://github.com/Zettlr/Zettlr/blob/develop/source/common/modules/markdown-editor/plugins/toc-field.ts
- Zettlr DeepWiki: https://deepwiki.com/search/how-does-the-table-of-contents_596fb30c-f22b-4f77-a3bf-0adc1e49f0ce
- VS Code `outlineModel.ts`: https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/documentSymbols/browser/outlineModel.ts
- VS Code `documentSymbolsOutline.ts`: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/codeEditor/browser/outline/documentSymbolsOutline.ts
- VS Code DeepWiki: https://deepwiki.com/search/how-does-the-outline-view-buil_a7145952-fe23-49d2-9fba-e9e126222f3b
- MarkText `toc.vue`: https://github.com/marktext/marktext/blob/develop/packages/desktop/src/renderer/src/components/sideBar/toc.vue
- MarkText DeepWiki: https://deepwiki.com/search/how-is-the-table-of-contents-s_64d52ac6-e594-4eba-b13b-9e313361dcb0
- Typora recovered `OutlinePanel.js`: `third_party/typora-recovered/recovered/web/relinked/bundle-main/ui/OutlinePanel.js`
