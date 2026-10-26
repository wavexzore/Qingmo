import type { AppErrorCode } from "@qingmo/shared";

export const common = {
  appName: "青墨",
  appNameLatin: "Qingmo",
  tagline: "像纸一样安静，像代码编辑器一样快。",
  actions: {
    openFile: "打开 Markdown 文件",
    openEditor: "查看编辑器空状态",
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
  },
  saveState: {
    clean: "已同步",
    dirty: "未保存",
    saving: "保存中",
    saved: "已保存",
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
  errorBoundary: {
    title: "界面遇到了问题",
    description: "可以重试渲染；你的文件没有被修改。",
  },
} as const;

export const editor = {
  empty: {
    title: "还没有打开的文档",
    description: "从欢迎页打开一个 .md 或 .markdown 文件，正文只会存在于编辑器状态中。",
    hint: "打开后会显示文件名、编码、换行符与保存状态。",
    openButton: "打开文件",
  },
  status: {
    position: "第 {{line}} 行，第 {{column}} 列",
    size: "{{value}} 字节",
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
} as const satisfies Record<AppErrorCode, string>;

export const zhCN = { common, editor, errors };
