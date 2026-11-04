# 代码校准与基线证据

> **功能 ID：** `editor-typography`
> **校准日期：** 2026-11-04
> **代码基线：** `main@3f654ba6d8d4866529d81566428214a320bebc61`
> **工作树状态：** 方案阶段未修改生产代码；`git status --porcelain` 仅可能有未跟踪的 `docs/todo/editor-typography/`。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `3f654ba6d8d4866529d81566428214a320bebc61` |
| 提交时间 | 2026-11-04 13:45:40 +0800 |
| 提交信息 | `[feat] 发布 0.1.4 版本` |
| Node | `>=22.12.0`（`package.json` engines） |
| pnpm | `10.28.0` |
| CM6 `@codemirror/view` | `6.43.15` |
| CM6 `@codemirror/state` | `6.7.6` |
| 平台 | macOS (darwin) |

---

## 2. GitNexus 索引状态

```text
$ node .gitnexus/run.cjs status
仓库: /Users/wangxc/Code/Qingmo
分支: main
共享索引：存储 Qingmo-3a868bd8df39，提交 3f654ba 的共享图
索引时间: 2026/11/4 15:34:12
索引提交: 3f654ba
当前提交: 3f654ba
```

结论：索引与当前 HEAD 一致，可以用于影响面分析。MCP 调用时不传 `repo`，避免命中旧分支 `feat/document-new@34e81af` 的共享图。

---

## 3. 基线命令

### 3.1 Typecheck

```bash
pnpm typecheck
```

结果：`PASS`（exit 0）。

```text
packages/shared typecheck: Done
packages/ui typecheck: Done
packages/editor-core typecheck: Done
apps/desktop typecheck: Done
```

### 3.2 目标 Vitest

```bash
pnpm vitest run \
  apps/desktop/src/stores/uiStore.test.ts \
  apps/desktop/src/app/uiStorageSync.test.ts \
  apps/desktop/src/settings/SettingsWindow.test.tsx \
  apps/desktop/src/features/editor/theme.test.ts \
  apps/desktop/src/features/editor/editor-session.test.ts
```

结果：`PASS`。

```text
Test Files  5 passed (5)
Tests       45 passed (45)
Duration    1.19s
```

说明：这是方案阶段的最小基线，不是全量回归。实施阶段必须跑全量 `pnpm test` 与关键 E2E。

---

## 4. 关键代码事实

### 4.1 主题与排版

| 事实 | 证据 |
|---|---|
| 编辑器根字号固定 `15px` | `packages/editor-core/src/extensions/theme.ts:26` |
| 正文字体 `var(--qm-font-mono)` | `theme.ts:32` |
| 正文行高 `1.75` | `theme.ts:33` |
| `editorThemeSpec` 是模块级 const | `theme.ts:21-326` |
| `themeExtension` 缓存 light/dark 两套 | `theme.ts:334-347` |
| `qingmoEditorTheme` 默认 light | `theme.ts:350` |
| `themeCompartment` + `setThemeEffect` | `packages/editor-core/src/createEditor.ts:21,71-73` |
| `createEditorState` 默认装入 light theme | `createEditor.ts:136` |
| `applyTheme` 有 view dispatch / 无 view state.update | `apps/desktop/src/features/editor/EditorSession.ts:571-583` |
| `replacePayload` 重建 state 并重放 theme（仅 themeApplied） | `EditorSession.ts:421-445` |
| `useThemeService` 用 passive `useEffect` | `apps/desktop/src/app/useThemeService.ts:12-21` |
| `EditorHost` 用 passive `useEffect` 创建 view | `apps/desktop/src/features/editor/EditorHost.tsx:39-51` |

### 4.2 UI Store

| 事实 | 证据 |
|---|---|
| 现有持久键 | `qingmo.ui.theme`、`qingmo.ui.language`（`uiStore.ts:10-11`） |
| `UiSnapshot` 只有 theme/resolvedTheme/language | `uiStore.ts:17-24` |
| 构造器读取持久值并 freeze | `uiStore.ts:123-135` |
| `setLanguage` 有 no-op 早退 | `uiStore.ts:162-168` |
| `syncFromStorage` 重建 theme/language | `uiStore.ts:198-206` |
| `replaceSnapshot` 相等性硬编码三字段 | `uiStore.ts:252-259` |
| `Object.freeze(next)` 是浅冻结 | `uiStore.ts:260` |
| `persist` 失败返回 false，不阻塞 UI | `uiStore.ts:267-278` |
| `ThemeStorage` 没有 `removeItem` | `uiStore.ts:26-29` |
| `watchUiStorage` 只过滤 theme/language/null | `apps/desktop/src/app/uiStorageSync.ts:11-19` |

### 4.3 Settings 窗口

| 事实 | 证据 |
|---|---|
| 只渲染语言 section | `apps/desktop/src/settings/SettingsWindow.tsx:198-220` |
| 语言变更走 `uiStore.setLanguage` | `SettingsWindow.tsx:104-115` |
| 左侧 nav 只有一个按钮，`aria-current="page"` 固定、无 onClick | `SettingsWindow.tsx:163-173` |
| 第二个 section 的自然落点 | `SettingsWindow.tsx:220` 之后、`:222` aside 之前 |
| 窗口固定 1120×720、不可缩放 | `src-tauri/src/commands/settings.rs:7-9,60-63` |
| 正文滚动区 padding `42px 56px 0` | `settings/settings.css:366-378` |
| section 上边距 44px | `settings.css:427-429` |
| row 两列 `minmax(0,1fr) auto`，gap 30px | `settings.css:460-467` |
| copy p 最大宽度 350px | `settings.css:476-483` |
| select 固定 248px | `settings.css:607-611` |
| 没有 slider/radio 卡片/预览样式 | 全文件检索无对应类 |

### 4.4 i18n 与测试

| 事实 | 证据 |
|---|---|
| `settings` namespace 中英各一份 | `en.ts:411-464`、`zh-CN.ts:403-455` |
| key 集合/插值必须一致 | `apps/desktop/src/i18n/i18n.test.ts:71-97` |
| 禁止在 `.tsx` 硬编码汉字 | `apps/desktop/src/i18n/text-scan.test.ts:49-64` |
| 禁止第二个语言持久键 | `text-scan.test.ts:66-78` |
| `uiStore.test.ts` 使用全量 `uiSnapshot` helper | `uiStore.test.ts:42-48` |
| `themeCommand.test.ts` 使用全量 `toEqual` | `themeCommand.test.ts:19-32` |
| `uiStorageSync.test.ts` 断言 3 次同步 | `uiStorageSync.test.ts:13-27` |
| Settings E2E 只覆盖语言与跨窗口语言同步 | `e2e/settings.spec.ts:5-58` |

### 4.5 嵌套代码块

| 事实 | 证据 |
|---|---|
| `nestedCodeTheme` 设置 `fontSize: inherit`、mono、`1.75` | `packages/editor-core/src/live-preview/code-blocks.ts:177-204` |
| 嵌套编辑器同时安装 `qingmoEditorTheme` + `nestedCodeTheme` | `code-blocks.ts:665-671` |
| 外层 live preview 又设置一遍 `.cm-md-code-block-widget .cm-editor` / `.cm-scroller` | `packages/editor-core/src/live-preview/theme.ts:1302-1311` |

这是当前最明确的重复来源：`mono` 与 `1.75` 同时存在于 `nestedCodeTheme` 和外层 `livePreviewTheme`。方案只收敛 `1.75` 常量；**外层六块必须保留**（R2 BLOCKER：CM6 级联顺序使 `nestedCodeTheme` 在 serif/sans 下输给 `qingmoEditorTheme`，删除会导致代码块变字体/丢 padding/height）。

---

## 5. 被校准/推翻的假设

| # | 初始假设 | 校准结果 | 影响 |
|---|---|---|---|
| 1 | 当前编辑器有 72ch 行宽 | **错误**。`tokens.css:180` 定义了 `--qm-content-max: 72ch`，但全仓无消费点；编辑器只有 20px writing inset | 方案不得声称保持 72ch；行宽列为未来缺口 Q-004 |
| 2 | Settings 窗口已有主题控件 | **错误**。只有语言 section；主题来自菜单/命令面板 | Typography 是 Settings 的第一个外观类控件，需要新 CSS |
| 3 | 改 `themeExtension` 即可承载 typography | **不推荐**。`themeExtension` 是 HIGH（22 impacted / 4 processes）；会扩大风险 | 新增独立 `typographyExtension`，不扩展 theme |
| 4 | 纯 CSS 变量 + `requestMeasure` 足够 | **不完整**。CM6 只在 `mustMeasureContent` 时重读字体度量；font-family-only 可能不刷新 `charWidth` | 选择 CM6 theme facet |
| 5 | `replacePayload` 会自动保留主题 | **部分错误**。只在 `themeApplied` 时重放；新 state 默认 light | typography 必须在 factory 参数中传递，不能依赖标志 |
| 6 | `UiSnapshot` 加字段只影响 Settings | **错误**。HIGH / lower-bound，36 impacted、20 direct、4 processes | 必须同步所有全量测试与 store 构造点 |
| 7 | `watchUiStorage` 漏加 key 会报错 | **错误**。静默忽略，跨窗口不更新，无日志 | 必须加测试断言 4 次同步 |
| 8 | `Object.freeze(snapshot)` 足够不可变 | **不完整**。浅冻结；嵌套 typography 对象需自行 freeze | `normalizeEditorTypography` 返回冻结对象 |
| 9 | 可以复用 `LanguageSelect` 做字体选择 | **不推荐**。它与语言选项/globe/code/chevron 强绑定，复用会复制 250 行组件 + 180 行 CSS | 用原生 radio 卡片 |
| 10 | 行高 1.75 是“默认行距” | **需谨慎**。Rello 2016 的 1.8 极端值有边际损害；但 WCAG 要求 ≥1.5，青墨现状 1.75 | 首版不改行高；列入 Q-004 |
| 11 | 字体族 serif 更护眼 | **无证据**。Beymer 2008 无显著差异 | 只作为偏好，不宣传性能 |
| 12 | 所有 live preview 字号都是 em | **部分错误**。存在 8.5/9.5/11px 固定 chrome | 明确“不缩放 chrome”的边界 |

---

## 6. 实施前必须重新校准的点

1. `git log -1` 是否仍是 `3f654ba` 或其后继；如果 HEAD 变化，重新跑 `node .gitnexus/run.cjs analyze --index-only`。
2. `uiStore.ts` 的 `replaceSnapshot` 是否仍只比较三个字段。
3. `EditorSession.replacePayload` 是否仍只在 `themeApplied` 时重放 theme。
4. `EditorHost` 是否仍使用 passive `useEffect`（决定 `useLayoutEffect` 时序）。
5. `live-preview/theme.ts` / `code-blocks.ts` 的重复 `1.75` 是否仍在。
6. `--qm-content-max` 是否仍无消费点。
7. `e2e/settings.spec.ts` 的 test id 与 localStorage 断言是否仍是 `qingmo.ui.language`。
8. `SettingsWindow` 是否仍只有语言 section。

---

## 7. 基线结论

- 代码基线干净，类型检查与目标测试通过。
- 现有实现没有字体偏好；`15px/mono/1.75` 是唯一 base 来源。
- 最合适的接入点是 `createEditorState` + `EditorSession` + `uiStore` + `WorkspaceLayout`，而不是改 `EditorHost` 或重建 view。
- 最大的工程风险不是“字体能不能改”，而是 **UiSnapshot 的形状变更、跨窗口同步过滤、Settings 窗口固定布局、以及嵌套代码块的重复来源**。
