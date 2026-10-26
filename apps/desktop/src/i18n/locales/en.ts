import type { AppErrorCode } from "@qingmo/shared";

export const common = {
  appName: "Qingmo",
  appNameLatin: "Qingmo",
  tagline: "Quiet as paper, fast as a code editor.",
  actions: {
    openFile: "Open Markdown file",
    openEditor: "View editor",
    backToWelcome: "Back to welcome",
    retry: "Retry",
  },
  welcome: {
    kicker: "Local-first · files never leave this device",
    title: "Give your attention back to the words.",
    description:
      "Qingmo opens Markdown through a native file dialog and keeps source as the truth. Every save checks the version on disk first.",
    recentTitle: "Recent files",
    recentEmpty: "No recent files yet. P1 opens a single file through the dialog.",
  },
  status: {
    file: "File",
    save: "Save",
    cursor: "Cursor",
    encoding: "Encoding",
    eol: "EOL",
    size: "Size",
    mode: "Mode",
    noFile: "No document",
    notAvailable: "—",
    largeFile: "Large file · preview off",
    largeFileHint:
      "The document exceeds 2,000,000 UTF-16 units. Live Preview is off; editing is unaffected.",
  },
  saveState: {
    clean: "Synced",
    dirty: "Unsaved",
    scheduled: "Save pending",
    saving: "Saving",
    error: "Save failed",
    conflict: "Conflict",
    readonly: "Read-only",
  },
  mode: {
    source: "Source",
    livePreview: "Live Preview",
  },
  toast: {
    openComingSoon: "Opening files lands in T-008.",
    regionLabel: "Notifications",
  },
  closeGuard: {
    title: "Unsaved changes",
    conflict: "The file has a conflict",
    error: "The save did not finish",
    description:
      "The document could not be saved. Close Qingmo anyway? Unsaved changes will be lost.",
    allow: "Close anyway",
    cancel: "Cancel",
  },
  errorBoundary: {
    title: "The interface hit a problem",
    description: "You can retry rendering; your file has not been modified.",
  },
} as const;

export const editor = {
  empty: {
    title: "No document open",
    description:
      "Open a .md or .markdown file from the welcome page. The body lives only in editor state.",
    hint: "Once open, you will see the file name, encoding, line endings and save state.",
    openButton: "Open file",
  },
  document: {
    title: "Document loaded",
    description:
      "The body is now in CodeMirror EditorState; the editing view arrives in a later task.",
    path: "Path",
    readOnly: "Read-only",
    readOnlyMdx: "MDX is read-only for now",
    readOnlyMixedEol: "Mixed line endings are read-only",
    format: "Format",
    units: "UTF-16 units",
    hash: "Base hash",
    viewPending:
      "Only EditorState exists right now; no EditorView is created, and the React snapshot contains no body text.",
  },
  status: {
    position: "Line {{line}}, column {{column}}",
    size: "{{value}} bytes",
  },
  conflict: {
    title: "The file changed on disk",
    description: "Autosave is paused. Reload the disk version or overwrite it with your text.",
    reload: "Reload",
    overwrite: "Overwrite",
    later: "Later",
    reopen: "Resolve conflict",
    confirmReloadTitle: "Reload and discard changes?",
    confirmReloadDescription: "Unsaved edits will be lost and undo history will be cleared.",
    confirmOverwriteTitle: "Overwrite the disk file?",
    confirmOverwriteDescription: "External changes on disk will be replaced by the editor text.",
    confirm: "Confirm",
    cancel: "Cancel",
    reloading: "Reloading…",
    overwriting: "Saving…",
    failed: "The action did not finish. Try again.",
  },
  save: {
    resolveBeforeSwitch: "Resolve the conflict or save error before opening another file.",
  },
} as const;

export const errors = {
  INVALID_PATH: "The document handle is invalid or expired.",
  OUTSIDE_SCOPE: "That path is outside the allowed scope.",
  NOT_FOUND: "The file does not exist or was moved.",
  NOT_A_FILE: "The selected path is not a regular file.",
  UNSUPPORTED_EXTENSION: "Only .md and .markdown files are supported.",
  FILE_TOO_LARGE: "The file exceeds the 10 MiB limit.",
  UNSUPPORTED_ENCODING: "Only UTF-8 or UTF-16 with a BOM is supported.",
  CONFLICT: "The file changed on disk; confirm the version first.",
  PERMISSION_DENIED: "You do not have permission to read or write this file.",
  READ_ONLY: "This document is read-only.",
  BUSY: "The previous operation is still running. Try again shortly.",
  IO: "An error occurred while reading or writing the file.",
  CANCELLED: "The operation was cancelled.",
} as const satisfies Record<AppErrorCode, string>;

export const commandLabels = {
  file: {
    open: "Open file",
    save: "Save file",
  },
  view: {
    toggleLivePreview: "Toggle Live Preview",
  },
  category: {
    file: "File",
    view: "View",
  },
} as const;

export const en = { common, editor, errors, commands: commandLabels };
