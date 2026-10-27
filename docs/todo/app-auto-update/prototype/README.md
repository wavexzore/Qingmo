# 青墨自动更新 · 高保真原型

打开 [`index.html`](index.html) 即可，无需构建、安装依赖或启动服务器。

## 操作

| 操作 | 说明 |
|---|---|
| 左侧 01—13 | 切换更新状态；选择后立即渲染 |
| 自动演示 | 检查 → 更新说明 → 下载 → 安装 → 更新完成 |
| 重置原型 | 回到日常写作并滚回文档顶部 |
| 浅色 / 深色 | 切换配色；不写入 localStorage |
| `⌘K` / `Ctrl+K` | 打开命令面板 |
| `↑` / `↓` / `Enter` | 在命令面板中选择与执行 |
| `Esc` | 关闭对话框/命令面板；安装中会提示不可关闭 |

深色状态可直接用 URL 打开，例如：

```text
index.html?theme=dark#dialog
```

## 覆盖状态

`idle`、`checking`、`available`、`dialog`、`downloading`、`ready`、`installing`、`conflict`、`error`、`offline`、`palette`、`uptodate`、`updated`。

其中保存冲突包含“重新载入 / 覆盖”两步确认；安装中会阻断关闭并逐步展示保存、验签、写入与重启；下载失败和检查失败分别覆盖可重试与静默失败路径。

## 边界

- 纯静态 HTML/CSS/JS，CSP 为 `default-src 'none'`，不发起网络请求。
- 不调用 Tauri、不读写文件、不写入 localStorage/sessionStorage。
- 版本号、包体大小、签名/公证与 Release Notes 均为演示数据。
- 原型只用于评审 UI/交互与状态覆盖，不代表 `02-实施状态与验证.md` 中的运行时验收。
