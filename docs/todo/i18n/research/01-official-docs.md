# 官方文档与标准证据

> 功能 ID：`i18n`
> 调研日期：2026-10-28
> 版本基线：`i18next@26.5.11`、`react-i18next@17.1.9`、`tauri@2.12.5`、`@tauri-apps/api@2.12.4`
> 目的：为运行时语言切换、持久化、原生菜单重建、复数/格式化提供一手依据。

---

## 1. i18next

| 来源 | 关键结论 | 对本方案的影响 | 采用/拒绝 |
|---|---|---|---|
| i18next API `changeLanguage(lng)` / `changeLanguage()` | `changeLanguage` 返回 Promise；不传 `lng` 时走 detector；`cimode` 可用于测试 | 切换只调用一次 `changeLanguage(next)`；测试可用 `cimode` 做键扫描 | 采用 |
| i18next `languageChanged` 事件 | `changeLanguage` 后触发，回调收到新语言 | 用事件更新 `<html lang>`；React 组件由 `useTranslation` 自动重渲染 | 采用 |
| i18next 初始化 `resources` + `supportedLngs` | 资源可直接内联；`supportedLngs` 限制合法语言 | 保持 bundled resources；`supportedLngs = Object.keys(resources)` | 采用 |
| i18next `initAsync` | 设为 `false` 时初始化同步完成，适合首帧确定性 | 保持 `initAsync:false`；不引入 HTTP backend | 采用 |
| i18next FAQ：language detector 会缓存 `i18nextLng` | detector 默认把检测结果写入 localStorage，且会覆盖后续 `fallbackLng`/浏览器设置 | **不引入 `i18next-browser-languagedetector`**，避免与 `qingmo.ui.language` 形成第二持久化键 | 拒绝 detector |
| i18next plural | 使用 `Intl.PluralRules`；英文需要 `_one`/`_other`，中文只有 `_other` | `logs.files`/`logs.toast.cleared` 改为复数键；测试按 locale 的 plural categories 校验 | 采用 |
| i18next interpolation | 默认 `escapeValue:true` 会 HTML 转义；React 应设 `false` | 保持 `escapeValue:false`，不拼接 HTML | 采用 |

**结论：** 现有 i18next 配置已经正确（bundled、同步、React 转义关闭）；缺口不在库，而在“谁触发 `changeLanguage`、谁持久化、谁同步原生外壳”。不要为了切换再引入 detector。

---

## 2. react-i18next

| 来源 | 关键结论 | 对本方案的影响 | 采用/拒绝 |
|---|---|---|---|
| `useTranslation` | 订阅 `languageChanged`，语言变化后重新渲染使用该 hook 的组件 | 现有 14 个组件已使用；无需手工订阅 | 采用 |
| `useSuspense: false` | 资源未就绪时不挂起；需要自己处理 `ready` | 资源 bundled + `initAsync:false`，首帧已 ready；保持现状 | 采用 |
| `i18n` 对象来自 `useTranslation` | 组件内可直接 `i18n.changeLanguage` | 但业务切换应走唯一 `LocaleController`，避免多处直接调用 | 约束 |

**结论：** React 侧只保留 `useTranslation` 消费；切换动作集中到 `LocaleController`，组件不直接调用 `i18n.changeLanguage`（测试除外）。

---

## 3. Tauri 2

| 来源 | 关键结论 | 对本方案的影响 | 采用/拒绝 |
|---|---|---|---|
| `AppHandle::set_menu(menu)` | 运行时设置 app-wide 菜单，返回旧菜单；macOS 通过主线程 `init_app_menu`，Windows 应用到未显式设置菜单的窗口 | `app_apply_locale` 用它重建菜单 | 采用 |
| `WebviewWindow::set_title(&str)` | 可运行时设置窗口标题 | 切换语言后更新所有文档/About/主窗口标题 | 采用 |
| `WebviewWindow::set_menu` | macOS 不支持窗口级菜单；必须用 `AppHandle::set_menu` | 继续 app-wide 菜单，不做每窗口菜单 | 采用 |
| `Menu::with_items` / `Submenu::new` / `MenuItem::with_id` / `CheckMenuItem::with_id` | 当前代码已使用；可声明式构建 | 扩展 `MenuEntry::Submenu` + `Checked` 支持语言子菜单 | 采用 |
| `PredefinedMenuItem::quit` | 走平台默认退出，绕过自定义 CloseGuard | **不用**预定义 Quit；继续自定义 `MENU_QUIT` 走 `request_close` | 拒绝 |
| Tauri capability/ACL | 每个 `invoke` 命令需要 `allow-*` 权限 | 新增 `allow-app-apply-locale`，只给 main/doc-* | 采用 |
| Tauri 主线程 | `set_menu` 在 macOS 内部 `run_on_main_thread`；命令从 webview 线程调用是支持的 | 菜单重建放在 IPC 命令中，不在 `on_menu_event` 同步修改 | 采用 |

**结论：** Tauri 官方 API 足以支持运行时菜单替换；不需要自建菜单协议或前端菜单渲染。关键约束是“app-wide + 主线程 + 自定义 Quit 不能绕过 CloseGuard”。

---

## 4. 语言标签与格式化标准

| 来源 | 关键结论 | 对本方案的影响 | 采用/拒绝 |
|---|---|---|---|
| BCP 47（RFC 5646 + RFC 4647） | 语言标签用 `zh-CN`、`en`；匹配用 lookup/filtering；不要自造 `zh_cn` | 内部统一 `zh-CN`/`en`；不接受 `zh_cn` 持久化值 | 采用 |
| RFC 4647 lookup | 从最具体到最一般逐级截断；找不到则默认 | 若未来做 OS 检测，`zh-Hans-CN` -> `zh-CN`，`en-US` -> `en`，未知 -> 默认 | 采用（预留） |
| W3C `Internationalization Best Practices` | 语言标签应使用 BCP 47；实现通常只需 well-formed 检查 | 只接受两个受支持标签；不做完整 IANA registry 校验 | 采用 |
| Unicode CLDR / `Intl.PluralRules` | 不同语言 plural categories 不同；不能硬编码 `_one/_other` | 测试按 `Intl.PluralRules(locale).resolvedOptions().pluralCategories` 生成期望 | 采用 |
| `Intl.DateTimeFormat` / `Intl.NumberFormat` | 日期/数字格式随 locale；不要手写 `YYYY-MM-DD` | 日志时间、更新日期、文件大小走统一 `lib/format` | 采用 |
| ICU MessageFormat | 功能强，但 i18next 默认插值已覆盖当前需求 | 不引入 ICU 插件；只用 `{{}}` + 复数后缀 | 拒绝（本期） |

---

## 5. 与当前代码的对照

| 现状 | 位置 | 官方依据 | 结论 |
|---|---|---|---|
| `i18n.init` 固定 `lng: DEFAULT_LANGUAGE` | `apps/desktop/src/i18n/index.ts:16-27` | `changeLanguage` 是运行时入口 | 改为从 `UiStore` 读取初始值，并由 controller 切换 |
| `ns` 手写 7 项 | `i18n/index.ts:22` | `resources` 是单一源 | 从 `resources` 动态派生，避免新增 namespace 漏配 |
| 资源 bundle 同步 | `initAsync:false`、`useSuspense:false` | 官方推荐异步时处理 ready；同步时无需 | 保持 |
| 主题 storage 只在 About 监听 | `about/main.tsx:14-18` | 同 origin webview 共享 localStorage | 抽出通用 `uiStorageSync`，语言/主题都监听 |
| 无 detector | 全仓无 `i18next-browser-languagedetector` | detector 会写 `i18nextLng` | 继续保持无 detector |

---

## 6. 参考链接

- i18next API: https://www.i18next.com/overview/api
- i18next FAQ（detector 缓存）: https://www.i18next.com/how-to/faq
- i18next plurals: https://www.i18next.com/translation-function/plurals
- react-i18next `useTranslation`: https://react.i18next.com/latest/usetranslation-hook
- Tauri `AppHandle::set_menu`: https://docs.rs/tauri/2.12.5/tauri/struct.AppHandle.html#method.set_menu
- Tauri `WebviewWindow::set_title`: https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindow.html#method.set_title
- Tauri menu: https://v2.tauri.app/learn/window-menu/
- BCP 47: https://www.rfc-editor.org/rfc/rfc5646
- RFC 4647: https://www.rfc-editor.org/rfc/rfc4647
- W3C i18n best practices: https://www.w3.org/TR/international-specs/
- MDN `Intl.PluralRules`: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules
- MDN `Intl.DateTimeFormat`: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
