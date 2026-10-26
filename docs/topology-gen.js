const fs = require("fs");
const path = require("path");

const outFile = path.join(__dirname, "qingmo-topology.drawio");

const C = {
  trusted: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;verticalAlign=top;align=left;spacing=10;fontSize=15;fontStyle=1;",
  trustedSub: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6c8ebf;verticalAlign=top;align=left;spacing=8;fontSize=12;fontStyle=1;",
  trustedBox: "rounded=1;whiteSpace=wrap;html=1;fillColor=#eef4ff;strokeColor=#6c8ebf;fontSize=11;",
  untrusted: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;dashed=1;verticalAlign=top;align=left;spacing=10;fontSize=15;fontStyle=1;",
  untrustedSub: "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff5f5;strokeColor=#b85450;verticalAlign=top;align=left;spacing=8;fontSize=12;fontStyle=1;",
  untrustedBox: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6e6;strokeColor=#b85450;fontSize=11;",
  rust: "rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;verticalAlign=top;align=left;spacing=10;fontSize=15;fontStyle=1;",
  rustSub: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#82b366;verticalAlign=top;align=left;spacing=8;fontSize=12;fontStyle=1;",
  rustBox: "rounded=1;whiteSpace=wrap;html=1;fillColor=#eef8ea;strokeColor=#82b366;fontSize=11;",
  data: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;verticalAlign=top;align=left;spacing=10;fontSize=15;fontStyle=1;",
  dataBox: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#ffffff;strokeColor=#999999;fontSize=11;",
  ext: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;verticalAlign=top;align=left;spacing=10;fontSize=15;fontStyle=1;",
  extBox: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#999999;fontSize=11;",
  ipc: "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=14;fontStyle=1;",
  actor: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontSize=12;fontStyle=1;",
  title: "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=24;fontStyle=1;",
  subtitle: "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=12;fontColor=#666666;",
  note: "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=11;fontColor=#B85450;fontStyle=1;",
  edge: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#666666;fontSize=10;labelBackgroundColor=#ffffff;",
  edgeDashed: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#666666;dashed=1;fontSize=10;labelBackgroundColor=#ffffff;",
  edgeRed: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#b85450;dashed=1;fontSize=10;labelBackgroundColor=#ffffff;",
};

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;");
}

const cells = [];
let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function box(id, label, x, y, w, h, style) {
  cells.push(
    `<mxCell id="${esc(id)}" value="${esc(label)}" style="${esc(style)}" vertex="1" parent="1">` +
      `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>` +
      `</mxCell>`
  );
}

function edge(id, source, target, label, style, points) {
  const pts = (points || [])
    .map((p) => `<mxPoint x="${p[0]}" y="${p[1]}"/>`)
    .join("");
  const arr = pts ? `<Array as="points">${pts}</Array>` : "";
  cells.push(
    `<mxCell id="${esc(id)}" value="${esc(label || "")}" style="${esc(style || C.edge)}" edge="1" parent="1" source="${esc(source)}" target="${esc(target)}">` +
      `<mxGeometry relative="1" as="geometry">${arr}</mxGeometry>` +
      `</mxCell>`
  );
}

// ---- Title / legend ----
box("title", "Qingmo（轻墨）· 项目目标拓扑图", 40, 14, 1350, 38, C.title);
box(
  "subtitle",
  "Markdown 文件为唯一事实来源 · SQLite 仅做可重建索引 · 用户插件默认不可信 · Tauri 2 + React + CodeMirror 6",
  40,
  54,
  1360,
  24,
  C.subtitle
);

box("legend", "", 1430, 18, 730, 72, "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#cccccc;");
box("leg-trusted", "", 1450, 44, 22, 14, "rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;");
box("leg-trusted-t", "可信", 1478, 36, 44, 28, "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;");
box("leg-untrusted", "", 1540, 44, 22, 14, "rounded=0;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;dashed=1;");
box("leg-untrusted-t", "不可信", 1568, 36, 60, 28, "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;");
box("leg-rust", "", 1645, 44, 22, 14, "rounded=0;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;");
box("leg-rust-t", "Rust", 1673, 36, 44, 28, "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;");
box("leg-data", "", 1735, 44, 22, 14, "rounded=0;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;");
box("leg-data-t", "数据", 1763, 36, 44, 28, "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;");
box(
  "leg-note",
  "SQLite 可删除重建；Markdown 文件才是源",
  1900,
  32,
  240,
  40,
  "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;fontColor=#666666;whiteSpace=wrap;"
);
box("leg-proxy", "", 1825, 44, 22, 14, "rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;");
box("leg-proxy-t", "代理", 1853, 36, 40, 28, "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;");

// ---- Actors ----
box("user", "用户", 80, 90, 180, 50, C.actor);
box("author", "插件作者 / 第三方开发者", 1500, 90, 260, 50, C.actor);

// ---- Trusted WebView ----
box("webview", "可信主窗口 · WebView（React + Vite + TypeScript）", 40, 170, 1280, 560, C.trusted);
box("presentation", "Presentation", 70, 230, 380, 470, C.trustedSub);
box("router", "React Router（Hash Router）", 90, 280, 340, 38, C.trustedBox);
box("pages", "Pages\nWelcome / Workspace / Settings / Plugins", 90, 328, 340, 72, C.trustedBox);
box("command", "Command Palette + Keymap", 90, 410, 340, 48, C.trustedBox);
box("design", "Tailwind tokens / Lucide\nThemes / i18next / a11y", 90, 468, 340, 64, C.trustedBox);
box("forms", "Settings forms + Zod", 90, 542, 340, 48, C.trustedBox);
box("market", "Plugin Market UI", 90, 600, 340, 48, C.trustedBox);
box("layout", "Layout / Tabs / Status Bar", 90, 658, 340, 30, C.trustedBox);

box("editor", "Editor Runtime（文档唯一事实来源）", 480, 230, 560, 470, C.trustedSub);
box("cm6", "CodeMirror 6 · EditorState\n唯一文档事实来源", 500, 280, 520, 70, C.trustedBox);
box("lezer", "Lezer Markdown\n增量解析", 500, 360, 250, 56, C.trustedBox);
box("live", "Live Preview\nDecoration / Widget", 770, 360, 250, 56, C.trustedBox);
box("preview", "Preview Worker\nmarkdown-it → sanitize-html → HTML\nKaTeX / Shiki", 500, 426, 520, 74, C.trustedBox);
box("bridge", "React bridge：useSyncExternalStore + 节流派生值", 500, 510, 520, 44, C.trustedBox);
box("modes", "Source / Live / Split", 500, 564, 250, 44, C.trustedBox);
box("large", "大文件降级\n2MB / 10MB 阈值", 770, 564, 250, 44, C.trustedBox);
box("history", "History / IME / Multi-cursor / Selection", 500, 618, 520, 40, C.trustedBox);
box("truth-note", "正文不进入 Zustand / Query 缓存", 500, 668, 520, 24, "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;fontSize=11;fontColor=#666666;");

box("state", "App State", 1070, 230, 230, 470, C.trustedSub);
box("zustand", "Zustand\nUI state only", 1090, 280, 190, 58, C.trustedBox);
box("query", "TanStack Query\nmetadata / market", 1090, 348, 190, 58, C.trustedBox);
box("zod", "Zod schemas", 1090, 416, 190, 44, C.trustedBox);
box("ipcclient", "IPC client\ntauri-specta types", 1090, 470, 190, 58, C.trustedBox);
box("broker", "Capability Broker\n权限 / 路径 jail\n审计 / 速率", 1090, 538, 190, 84, "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;fontStyle=1;");
box("state-note", "只存 ID / dirty / 模式\n不存正文", 1090, 632, 190, 50, "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;fontSize=11;fontColor=#666666;");

// ---- Untrusted plugin sandbox ----
box("sandbox", "不可信插件沙箱 · 主线程零第三方代码", 1360, 170, 800, 560, C.untrusted);
box("worker", "Plugin Worker\n无 DOM / 无 Tauri\n逻辑、解析、导出\nRPC over postMessage", 1390, 230, 350, 150, C.untrustedBox);
box("iframe", "sandbox iframe\nopaque origin\n插件 UI / 侧栏 / 面板\nallow-scripts（无 same-origin）", 1760, 230, 370, 150, C.untrustedBox);
box("sdk", "Plugin SDK（开发期）\ndefinePlugin / RPC types", 1390, 400, 350, 64, C.untrustedBox);
box("manifest", "Manifest + Ed25519 签名\n权限声明 / 激活事件 / semver", 1390, 474, 350, 84, C.untrustedBox);
box("assets", "plugin://<id>/...\n资源 scope 限定", 1760, 400, 370, 64, C.untrustedBox);
box("privdata", "$APPDATA/Qingmo/plugins/<id>\nstate.json / logs（路径 jail）", 1760, 474, 370, 84, C.untrustedBox);
box("netnote", "所有文件/网络请求\n必须经 Broker", 1390, 568, 350, 50, "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;");
box("install", "安装流程（宿主执行）\nzip → 校验 → 解压", 1760, 568, 370, 50, C.untrustedBox);
box("activation", "激活事件：onCommand / onFence / onFileOpen / onView / onSettings", 1390, 628, 740, 50, C.untrustedBox);
box("forbidden", "禁止：直接 invoke Tauri · 读任意路径 · 直连网络 · 注入全局 CSS / React", 1390, 690, 740, 30, C.note);

// ---- IPC ----
box("ipc", "Tauri 2 IPC 边界 · invoke / events · capabilities / CSP / scope · 最小权限", 40, 760, 2120, 50, C.ipc);

// ---- Rust ----
box("rust", "Tauri 2 · Rust 后端（可信）", 40, 840, 2120, 470, C.rust);
box("fs", "Workspace & FS", 70, 900, 380, 380, C.rustSub);
box("fs-open", "workspace_open / workspace_list", 90, 950, 340, 40, C.rustBox);
box("fs-read", "file_read", 90, 1000, 340, 40, C.rustBox);
box("fs-write", "file_write_atomic\n临时文件 + fsync + rename", 90, 1050, 340, 50, C.rustBox);
box("fs-rename", "rename / delete → trash", 90, 1110, 340, 40, C.rustBox);
box("fs-backup", "backup / recovery", 90, 1160, 340, 40, C.rustBox);
box("fs-dialog", "dialogs / reveal / openExternal", 90, 1210, 340, 50, C.rustBox);

box("watcher", "Watcher & Indexer", 480, 900, 400, 380, C.rustSub);
box("watch-notify", "notify watcher", 500, 950, 360, 44, C.rustBox);
box("watch-debounce", "debounce 200ms / batch", 500, 1004, 360, 36, C.rustBox);
box("watch-hash", "blake3 hash / mtime / conflict", 500, 1050, 360, 40, C.rustBox);
box("watch-queue", "indexer queue（rayon）", 500, 1100, 360, 40, C.rustBox);
box("watch-links", "links / tags / frontmatter", 500, 1150, 360, 40, C.rustBox);
box("watch-rebuild", "rebuild index", 500, 1200, 360, 36, C.rustBox);
box("watch-meta", "metadata / mtime", 500, 1246, 360, 24, "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;fontSize=10;fontColor=#666666;");

box("search", "Search & Index", 910, 900, 350, 380, C.rustSub);
box("search-fts", "SQLite FTS5 query", 930, 950, 310, 44, C.rustBox);
box("search-rank", "bm25 ranking / snippet", 930, 1004, 310, 36, C.rustBox);
box("search-cjk", "CJK tokenizer\ntrigram / jieba-rs", 930, 1050, 310, 50, C.rustBox);
box("search-backlinks", "backlinks / outline", 930, 1110, 310, 40, C.rustBox);
box("search-fallback", "search_scan fallback", 930, 1160, 310, 40, C.rustBox);
box("search-target", "目标：100k 文件 < 200ms", 930, 1210, 310, 40, C.rustBox);

box("security", "Security & Net", 1290, 900, 380, 380, C.rustSub);
box("sec-path", "path jail / canonicalize", 1310, 950, 340, 40, C.rustBox);
box("sec-net", "net broker\norigin allowlist", 1310, 1000, 340, 50, C.rustBox);
box("sec-sig", "plugin signature verify", 1310, 1060, 340, 40, C.rustBox);
box("sec-perm", "permission / audit log", 1310, 1110, 340, 40, C.rustBox);
box("sec-rate", "rate limit / size limit", 1310, 1160, 340, 40, C.rustBox);
box("sec-cap", "capability checks", 1310, 1210, 340, 40, C.rustBox);

box("system", "System", 1700, 900, 430, 380, C.rustSub);
box("sys-updater", "updater（signed manifest）", 1720, 950, 390, 40, C.rustBox);
box("sys-single", "single instance / deep link", 1720, 1000, 390, 40, C.rustBox);
box("sys-menu", "menu / tray / window", 1720, 1050, 390, 40, C.rustBox);
box("sys-plugins", "plugin store / install", 1720, 1100, 390, 40, C.rustBox);
box("sys-log", "logging / tracing", 1720, 1150, 390, 40, C.rustBox);
box("sys-safe", "crash recovery / safe mode", 1720, 1200, 390, 40, C.rustBox);

// ---- Data ----
box("data", "本地数据 · 文件为源，SQLite 可重建", 40, 1350, 1500, 210, C.data);
box("data-md", "Markdown 文件\n*.md / assets\n.qingmo/workspace.json", 70, 1410, 280, 110, C.dataBox);
box("data-db", "index.sqlite\ndocuments / FTS5\nlinks / tags / plugins / recovery", 380, 1410, 340, 110, C.dataBox);
box("data-cfg", "settings.json\nkeybindings\nwindow state", 750, 1410, 260, 110, C.dataBox);
box("data-plugin", "plugins/<id>/<version>\nstate.json / logs", 1040, 1410, 280, 110, C.dataBox);
box("data-backup", "backups/\n<docId>/*.md", 1350, 1410, 160, 110, C.dataBox);

box("external", "外部服务", 1560, 1350, 340, 210, C.ext);
box("ext-market", "插件市场 CDN", 1580, 1410, 300, 40, C.extBox);
box("ext-update", "更新服务器", 1580, 1460, 300, 40, C.extBox);
box("ext-api", "第三方 API", 1580, 1510, 300, 40, C.extBox);

box("os", "操作系统", 1920, 1350, 240, 210, C.ext);
box("os-dialog", "文件对话框", 1940, 1410, 200, 40, C.extBox);
box("os-trash", "回收站", 1940, 1460, 200, 40, C.extBox);
box("os-browser", "浏览器 / 通知", 1940, 1510, 200, 40, C.extBox);

// ---- Edges ----
edge("e-user", "user", "webview", "输入 / 命令", C.edge, [[170, 140], [170, 170]]);
edge("e-author", "author", "sandbox", "开发 / 发布", C.edge, [[1630, 140], [1630, 170]]);

edge("e-editor-ipc", "editor", "ipc", "read / save（去抖）", C.edge, [[760, 700], [760, 760]]);
edge("e-state-ipc", "state", "ipc", "metadata / search", C.edge, [[1185, 700], [1185, 760]]);
edge("e-broker-ipc", "broker", "ipc", "invoke（已校验）", C.edge, [[1280, 580], [1330, 580], [1330, 760]]);
edge("e-worker-broker", "worker", "broker", "RPC", C.edge, [[1390, 305], [1345, 305], [1345, 600], [1280, 600]]);
edge("e-iframe-broker", "iframe", "broker", "postMessage", C.edge, [[2130, 305], [2150, 305], [2150, 745], [1185, 745], [1185, 622]]);
edge("e-manifest-worker", "manifest", "worker", "activate", C.edge + "exitX=0;exitY=0.5;entryX=0;entryY=0.5;", [[1375, 516], [1375, 305]]);
edge("e-assets-iframe", "assets", "iframe", "load", C.edge, [[1945, 400], [1945, 380]]);
edge("e-ipc-rust", "ipc", "rust", "commands / events", C.edge, [[1100, 810], [1100, 840]]);

edge("e-fs-md", "fs", "data-md", "atomic read / write", C.edge, [[260, 1280], [260, 1325], [210, 1325], [210, 1410]]);
edge("e-watch-md", "watcher", "data-md", "watch", C.edgeDashed, [[680, 1280], [680, 1335], [400, 1335], [400, 1410]]);
edge("e-index-db", "watcher", "data-db", "index", C.edge, [[800, 1280], [800, 1320], [620, 1320], [620, 1410]]);
edge("e-search-db", "search", "data-db", "FTS5 query", C.edge, [[1085, 1280], [1085, 1340], [550, 1340], [550, 1410]]);
edge("e-sys-plugin", "system", "data-plugin", "install / plugin state", C.edge, [[1900, 1280], [1900, 1330], [1180, 1330], [1180, 1410]]);
edge("e-sys-ext", "system", "external", "updates / market", C.edge, [[1958, 1280], [1958, 1315], [1730, 1315], [1730, 1350]]);
edge("e-net-ext", "security", "external", "allowlisted HTTPS", C.edge, [[1480, 1280], [1480, 1305], [1650, 1305], [1650, 1350]]);
edge("e-sys-os", "system", "os", "menus / dialogs", C.edge, [[2050, 1280], [2050, 1350]]);

const xml =
  `<mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="2200" pageHeight="1600" math="0" shadow="0">` +
  `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
  cells.join("") +
  `</root></mxGraphModel>`;

fs.writeFileSync(outFile, xml, "utf8");
console.log(`wrote ${outFile} (${xml.length} bytes, ${cells.length} cells)`);
