import type { AppErrorCode } from "@qingmo/shared";

export const common = {
  appName: "青墨",
  appNameLatin: "Qingmo",
  tagline: "像纸一样安静，像代码编辑器一样快。",
  actions: {
    openFile: "打开 Markdown 文件",
    openEditor: "查看编辑器",
    backToWelcome: "返回欢迎页",
    retry: "重试",
  },
  welcome: {
    kicker: "本地优先 · 文件不离开设备",
    title: "把注意力还给文字。",
    description:
      "青墨用原生文件对话框打开 Markdown，在编辑器中保持源码为真；保存前总会检查磁盘上的版本。",
    recentTitle: "最近文件",
    recentEmpty: "还没有最近文件。P1 只支持通过对话框打开单个文件。",
  },
  status: {
    file: "文件",
    save: "保存",
    cursor: "光标",
    encoding: "编码",
    eol: "换行",
    size: "大小",
    mode: "模式",
    noFile: "未打开文档",
    notAvailable: "—",
    largeFile: "大文档 · 预览关闭",
    largeFileHint: "文档超过 2,000,000 个 UTF-16 单元，已关闭实时预览；编辑不受影响。",
  },
  saveState: {
    clean: "已同步",
    dirty: "未保存",
    scheduled: "等待保存",
    saving: "保存中",
    error: "保存失败",
    conflict: "有冲突",
    readonly: "只读",
  },
  mode: {
    source: "源码",
    livePreview: "实时预览",
  },
  toast: {
    openComingSoon: "文件打开将在 T-008 接入。",
    regionLabel: "通知",
  },
  closeGuard: {
    title: "有未保存的修改",
    conflict: "文件存在冲突",
    error: "保存未完成",
    description: "当前文档未能保存。仍要关闭青墨吗？未保存的修改会丢失。",
    allow: "仍要关闭",
    cancel: "取消",
  },
  errorBoundary: {
    title: "界面遇到了问题",
    description: "可以重试渲染；你的文件没有被修改。",
  },
} as const;

export const editor = {
  empty: {
    title: "未命名",
    placeholder: "开始写作…",
    hint: "按 {{shortcut}} 可以打开文件。",
  },
  document: {
    title: "文档已载入",
    description: "正文已进入 CodeMirror EditorState；编辑视图将在后续任务接入。",
    path: "路径",
    readOnly: "只读",
    readOnlyMdx: "MDX 暂为只读",
    readOnlyMixedEol: "混合换行暂为只读",
    format: "格式",
    units: "UTF-16 单元",
    hash: "基线哈希",
    viewPending: "当前仅创建 EditorState，不创建 EditorView；React 快照不含正文。",
  },
  status: {
    position: "第 {{line}} 行，第 {{column}} 列",
    size: "{{value}} 字节",
  },
  conflict: {
    title: "文件已在磁盘上被修改",
    description: "自动保存已暂停。请重新加载磁盘版本，或用当前内容覆盖。",
    reload: "重新加载",
    overwrite: "覆盖保存",
    later: "稍后",
    reopen: "处理冲突",
    confirmReloadTitle: "确认重新加载？",
    confirmReloadDescription: "当前未保存的修改会被丢弃，撤销历史会清空。",
    confirmOverwriteTitle: "确认覆盖？",
    confirmOverwriteDescription: "磁盘上的外部修改会被当前内存内容替换。",
    confirm: "确认",
    cancel: "取消",
    reloading: "正在重新加载…",
    overwriting: "正在保存…",
    failed: "操作未完成，请重试。",
  },
  save: {
    resolveBeforeSwitch: "请先处理当前文档的冲突或保存错误，再打开其他文件。",
  },
} as const;

export const errors = {
  INVALID_PATH: "文档句柄无效或已过期。",
  OUTSIDE_SCOPE: "该路径不在允许的范围内。",
  NOT_FOUND: "文件不存在或已被移动。",
  NOT_A_FILE: "所选路径不是普通文件。",
  UNSUPPORTED_EXTENSION: "只支持 .md 与 .markdown 文件。",
  FILE_TOO_LARGE: "文件超过 10 MiB 上限。",
  UNSUPPORTED_ENCODING: "仅支持 UTF-8 或带 BOM 的 UTF-16。",
  CONFLICT: "文件已被外部修改，请先确认版本。",
  PERMISSION_DENIED: "没有读取或写入该文件的权限。",
  READ_ONLY: "当前文档为只读，无法保存。",
  BUSY: "上一个操作尚未完成，请稍后再试。",
  IO: "读写文件时发生错误。",
  CANCELLED: "操作已取消。",
  UPDATE_CHECK_FAILED: "检查更新失败，请稍后重试。",
  UPDATE_DOWNLOAD_FAILED: "下载更新失败，请稍后重试。",
  UPDATE_SIGNATURE_INVALID: "更新包签名校验失败，已拒绝安装。",
  UPDATE_INSTALL_FAILED: "安装更新失败，当前版本仍然可用。",
  UPDATE_UNSUPPORTED: "当前系统或架构不支持自动更新。",
  UPDATE_NOT_READY: "更新尚未准备好安装。",
} as const satisfies Record<AppErrorCode, string>;

export const update = {
  banner: {
    kicker: "应用更新",
    available: "新版本 {{version}} 可用",
    downloading: "正在下载更新…",
    ready: "更新已下载，可以安装",
    installing: "正在安装更新…",
    view: "查看",
    later: "稍后",
    install: "安装并重启",
    progress: "已下载 {{percent}}%",
    keepOpen: "请保持青墨打开",
  },
  dialog: {
    kicker: "应用更新",
    title: "更新青墨",
    phase: {
      idle: "当前已是最新版本。",
      checking: "正在检查更新…",
      available: "新版本已就绪，下载后即可安装。",
      downloading: "正在下载更新，请保持网络连接。",
      ready: "更新已下载。安装前会先保存当前文档，然后青墨会重新启动。",
      installing: "正在安装更新，请不要关闭青墨。",
    },
    currentVersion: "当前版本",
    latestVersion: "最新版本",
    released: "发布日期",
    notes: "发布说明",
    noNotes: "此版本没有发布说明。",
    downloading: "正在下载…",
    progress: "正在下载… {{percent}}%",
    download: "下载更新",
    install: "安装并重启",
    later: "稍后",
  },
  toast: {
    upToDate: "已是最新版本。",
    busy: "更新操作正在进行，请稍后再试。",
  },
} as const;

export const commandLabels = {
  file: {
    open: "打开文件",
    save: "保存文件",
  },
  view: {
    toggleLivePreview: "切换实时预览",
    toggleTheme: "切换主题",
  },
  update: {
    checkForUpdates: "检查更新",
  },
  category: {
    file: "文件",
    view: "视图",
    app: "应用",
  },
  palette: {
    title: "命令面板",
    placeholder: "搜索命令…",
    empty: "没有匹配的命令",
    hint: "↑↓ 选择 · Enter 执行 · Esc 关闭",
  },
} as const;

export const zhCN = { common, editor, errors, update, commands: commandLabels };
