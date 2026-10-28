# GitHub 开源实现对比

> 功能 ID：`i18n`
> 调研日期：2026-10-28
> 目的：验证“运行时语言切换 + 原生菜单/标题同步 + 持久化”的可行实现，明确可借鉴点与拒绝原因。
> 约束：不直接复制代码；许可证与依赖边界见下表。

---

## 1. 对比总表

| 项目 | 许可证 | 技术栈 | 相关实现 | 可借鉴点 | 不采用/需调整 | 结论 |
|---|---|---|---|---|---|---|
| [`pot-app/pot-desktop`](https://github.com/pot-app/pot-desktop) | GPL-3.0 | Tauri 1 + React + i18next | 运行时切换 `i18n.changeLanguage`；`invoke('update_tray')`；Rust 按语言重建托盘菜单；`tauri-plugin-store` 持久化 `app_language` | “UI 切换 -> invoke -> Rust 重建原生菜单”这条链路；启动时从 store 读取语言 | 每个语言一份 `tray_menu_xx()`，7+ 套菜单结构重复；GPL-3.0 不能直接复制；`tauri-plugin-store` 会新增配置文件/插件 | 借鉴链路，拒绝重复菜单与插件存储 |
| [`spacedriveapp/spacedrive`](https://github.com/spacedriveapp/spacedrive) | Apache-2.0 | Tauri 2 + React + Rust | 语言存于应用配置；`AppearanceSettings` 下拉；React 重新渲染；Rust 菜单为静态英文字符串 | “语言是应用配置的一部分”“设置页下拉”的 UX；Apache-2.0 可参考 | 原生菜单未运行时本地化；配置存 Rust 侧，和本项目的 UiStore/localStorage 模型不同 | 借鉴持久化/设置 UX，拒绝其“菜单不本地化” |
| [`tauri-apps/tauri`](https://github.com/tauri-apps/tauri) | Apache-2.0 | Tauri 官方 | `AppHandle::set_menu`、`WebviewWindow::set_title`、菜单/子菜单/CheckMenuItem API | 运行时替换 app-wide 菜单的官方路径；macOS 主线程语义 | 官方示例不包含 i18n；需要自己定义标签数据 | 采用官方 API，不复制示例菜单 |
| [`i18next/react-i18next`](https://github.com/i18next/react-i18next) | MIT | React + i18next | `useTranslation` 订阅 `languageChanged`；`changeLanguage`；`useSuspense:false` | 组件自动重渲染；无需手工订阅；测试可用 `cimode` | 官方示例常用 detector/HTTP backend，与本项目 bundled/无第二存储的约束不同 | 采用 hook 模式，拒绝 detector/backend |
| [`lobehub/lobe-chat`](https://github.com/lobehub/lobehub) | NOASSERTION | Next.js + i18next | URL `hl` > cookie > `Accept-Language`；`switchLang` 更新 i18n + `<html lang>` + cookie | “显式切换 + 更新 html lang”的 UX；检测优先级思想 | 许可证元数据不明确；服务端 cookie/URL 模型不适用于 Tauri 本地应用 | 仅作 UX 旁证，不引用代码 |

> 许可证核验时间：2026-10-28，通过 GitHub API 读取 `license.spdx_id`；`lobehub` 返回 `NOASSERTION`，因此不作为代码参考。

---

## 2. pot-app/pot-desktop：最接近的运行时链路

### 2.1 实际代码证据

`src/window/Config/pages/General/index.jsx`：

```jsx
onAction={(key) => {
  setAppLanguage(key);
  i18n.changeLanguage(key);
  invoke('update_tray', { language: key, copyMode: '' });
}}
```

`src-tauri/src/tray.rs`：

```rust
tray_handle
    .set_menu(match language.as_str() {
        "en" => tray_menu_en(),
        "zh_cn" => tray_menu_zh_cn(),
        "zh_tw" => tray_menu_zh_tw(),
        "ja" => tray_menu_ja(),
        // ...
        _ => tray_menu_en(),
    })
```

### 2.2 可借鉴

1. **单向链路**：UI 改语言 -> `changeLanguage` -> invoke Rust -> Rust 重建原生菜单。菜单不是第二状态机。
2. **启动读取**：Rust 侧在 `language` 为空时从持久化 store 读取，避免启动和运行时两套默认值。
3. **运行时重建**：不是重建窗口，只替换菜单。

### 2.3 拒绝

| 问题 | 证据 | 本方案替代 |
|---|---|---|
| 每种语言一份完整菜单函数，结构和文案重复 | `tray_menu_en/zh_cn/zh_tw/ja/...` | 单一 `MenuSpec` + 前端 `NativeShellLabels`；结构只写一次 |
| 使用 `tauri-plugin-store` 新增配置文件 | `get("app_language")` | 复用现有 `UiStore` localStorage；不新增文件/插件 |
| Tauri 1 API/`SystemTrayMenu` | `tray.rs` 使用 Tauri 1 | 使用 Tauri 2 `AppHandle::set_menu` |
| GPL-3.0 | 仓库许可证 | 只借鉴思路，不复制代码 |

---

## 3. spacedrive：持久化与设置 UX

### 3.1 实际实现（DeepWiki 摘要）

- 语言作为应用配置的一部分，由 `AppearanceSettings` 下拉修改；
- `useCoreMutation` 更新配置后重新获取配置，React 重新渲染；
- Rust `setup_menu` 中菜单项是静态英文字符串，没有运行时本地化逻辑；
- 菜单更新命令只处理 enable/disable，不改文案。

### 3.2 可借鉴

- 语言偏好属于“应用外观/通用设置”，不是文档状态；与本项目 `UiStore` 的定位一致。
- 设置变更后由单一状态源驱动 React 重渲染，不在组件里缓存翻译。

### 3.3 拒绝

- 原生菜单静态英文：切换中文后菜单仍是英文，属于“半本地化”。
- 配置存 Rust 侧（需要新配置文件和迁移）；本项目已有 localStorage UI 偏好层，复用更小。
- Apache-2.0 可参考，但其配置模型不适用于当前单文档、无 settings 页的架构。

---

## 4. tauri-apps/tauri：官方菜单 API

### 4.1 关键 API

```rust
pub fn set_menu(&self, menu: Menu<R>) -> Result<Option<Menu<R>>>
```

- app-wide；macOS 通过 `init_app_menu` 在主线程设置；
- Windows 应用到未显式设置菜单的窗口；
- `WebviewWindow::set_menu` 在 macOS 不支持，必须用 `AppHandle`。

### 4.2 对本方案的约束

1. 菜单必须 app-wide，不能每个文档窗口一套。
2. 重建菜单必须在主线程安全的 API 内完成；Tauri 内部处理，但不要在自己的 `on_menu_event` 回调里同步重建（先让事件返回，再由前端 invoke 命令）。
3. 预定义 Quit 会绕过 CloseGuard，继续使用自定义 `MENU_QUIT`。

---

## 5. i18next/react-i18next：组件消费模式

### 5.1 关键结论

- `useTranslation` 订阅 `languageChanged`；语言变化后使用该 hook 的组件自动重渲染。
- `useSuspense:false` 时资源未就绪不会挂起，但需要自己处理 ready；本项目 bundled + `initAsync:false`，首帧已就绪。
- `changeLanguage` 是唯一运行时入口；不要在多个组件里各写一套切换逻辑。

### 5.2 拒绝

- 官方示例常用 `i18next-browser-languagedetector` + HTTP backend；detector 会写 `i18nextLng`，backend 会引入网络/异步首帧，均与本项目约束冲突。
- 官方示例不处理 Tauri 原生菜单；原生部分仍需本项目自己的投影契约。

---

## 6. 结论到设计决策

| 结论 ID | 来源 | 结论 | 落地决策 |
|---|---|---|---|
| RS-101 | pot-app | UI -> invoke -> Rust 重建原生菜单是可行链路 | `app_apply_locale` + `ShellLocale` |
| RS-102 | pot-app | 每语言一份菜单函数会重复结构/文案 | 单一 `MenuSpec` + `NativeShellLabels` |
| RS-103 | pot-app | `tauri-plugin-store` 会新增配置文件 | 复用 `UiStore` localStorage |
| RS-104 | spacedrive | 语言属于应用外观偏好，由单一状态源驱动 | `UiStore.language` + `LocaleController` |
| RS-105 | spacedrive | 原生菜单静态英文是半本地化 | 必须重建菜单/标题 |
| RS-106 | tauri | `AppHandle::set_menu` app-wide；macOS 主线程 | 菜单重建走 IPC 命令，不按窗口建菜单 |
| RS-107 | react-i18next | `useTranslation` 自动重渲染 | 组件不手工订阅 |
| RS-108 | i18next FAQ | detector 会写第二持久化键 | 不用 detector |
