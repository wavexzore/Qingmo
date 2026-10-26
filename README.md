# 轻墨 Qingmo

> 像纸一样安静，像代码编辑器一样快。

Qingmo 是一个本地优先、源码为真、支持沙箱化插件扩展的 Markdown 编辑器。

- **桌面外壳**：Tauri 2（Rust）
- **界面**：React + Vite + TypeScript + TailwindCSS
- **编辑内核**：CodeMirror 6 + Lezer
- **插件运行时**：Web Worker + sandbox iframe + 能力代理（Capability Broker）
- **数据**：Markdown 文件为唯一事实来源，SQLite 仅做索引

## 文档

- [项目蓝图](docs/BLUEPRINT.md) —— 架构、插件系统、数据模型、性能预算、路线图
- [项目拓扑图](docs/TOPOLOGY.md) —— 系统运行拓扑、信任边界、关键数据流
- [调研与参考](docs/RESEARCH.md) —— 开源项目分析、官方文档结论、论文与工程证据

## 状态

当前处于**蓝图阶段**，尚未开始编码。下一步是按蓝图第 13 节的 P0/P1 阶段搭建骨架。
