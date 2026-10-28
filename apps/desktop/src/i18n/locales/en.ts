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
    unsaved: "Before closing",
    conflict: "The file has a conflict",
    error: "The save did not finish",
    description:
      "The document could not be saved. Close Qingmo anyway? Unsaved changes will be lost.",
    unsavedDescription: "Continuing closes this window and discards unsaved changes.",
    confirm: "Confirm",
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
    title: "Untitled",
    placeholder: "Start writing…",
    hint: "Press {{shortcut}} to open a file.",
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
  UPDATE_CHECK_FAILED: "Could not check for updates. Try again later.",
  UPDATE_DOWNLOAD_FAILED: "Could not download the update. Try again later.",
  UPDATE_SIGNATURE_INVALID: "The update signature is invalid; installation was refused.",
  UPDATE_INSTALL_FAILED:
    "The update could not be installed; the current version is still available.",
  UPDATE_UNSUPPORTED: "Automatic updates are not supported on this system or architecture.",
  UPDATE_NOT_READY: "The update is not ready to install.",
} as const satisfies Record<AppErrorCode, string>;

export const update = {
  banner: {
    kicker: "App update",
    badge: "Universal",
    availableTitle: "Qingmo {{version}} has been released",
    availableHint: "Download it to install · writing is never interrupted",
    downloadingTitle: "Downloading Qingmo {{version}}",
    downloadingHint: "Downloaded {{percent}}%",
    downloadingPreparing: "Preparing the download…",
    readyTitle: "The update is ready",
    readyHint: "Qingmo {{version}} is downloaded and verified · restart to finish",
    installingTitle: "Installing the update…",
    installingHint: "Keep Qingmo open",
    view: "View update",
    later: "Later",
    install: "Install and restart",
    keepOpen: "Keep Qingmo open",
  },
  dialog: {
    kicker: "App update",
    title: "Update Qingmo",
    phase: {
      idle: "You are on the latest version.",
      checking: "Checking for updates…",
      available: "A new version is available. Download it to install.",
      downloading: "Downloading the update. Keep your connection open.",
      ready: "The update is downloaded. Qingmo saves the current document, installs, and restarts.",
      installing: "Installing the update. Do not close Qingmo.",
    },
    currentVersion: "Current version",
    latestVersion: "Latest version",
    released: "Released",
    notes: "Release notes",
    noNotes: "This release has no notes.",
    downloading: "Downloading…",
    progress: "Downloading… {{percent}}%",
    download: "Download update",
    install: "Install and restart",
    later: "Later",
  },
  toast: {
    upToDate: "You are on the latest version.",
    busy: "An update operation is already running. Try again shortly.",
  },
} as const;

export const about = {
  windowLabel: "Qingmo / Colophon",
  kicker: "A local-first Markdown writing tool",
  promise: "Keep the words on your device. Keep your attention on writing.",
  manifesto:
    "One sheet of paper, one old pen. No account, no cloud nudging you — only you and the sentence you are writing.",
  edition: "Edition",
  meta: {
    version: "Version",
    build: "Build",
    platform: "Platform",
    license: "License",
  },
  status: {
    upToDate: "You are up to date",
    checking: "Checking for updates…",
    available: "Version {{version}} is available",
    downloading: "Downloading {{version}}…",
    ready: "{{version}} is ready to install",
    installing: "Installing the update…",
    error: "Check failed. Try again.",
  },
  actions: {
    checkUpdates: "Check for updates",
    viewUpdate: "View update",
    copyVersion: "Copy version info",
    close: "Close",
  },
  toast: {
    copied: "Version info copied",
    copyFailed: "Copy failed. Try again.",
    openFailed: "Could not open the link. Try again.",
  },
  links: {
    docs: "Docs",
    github: "GitHub",
    changelog: "Changelog",
    license: "License",
  },
  aria: {
    window: "About Qingmo",
    icon: "Qingmo app icon",
    links: "Related links",
    versionInfo: "Version information",
  },
  copyValue: "Qingmo {{version}} ({{build}}) · {{platform}}",
} as const;

export const commandLabels = {
  file: {
    open: "Open file",
    save: "Save file",
  },
  view: {
    toggleLivePreview: "Toggle Live Preview",
    toggleTheme: "Toggle theme",
  },
  update: {
    checkForUpdates: "Check for updates",
  },
  app: {
    openLogs: "View runtime logs",
  },
  category: {
    file: "File",
    view: "View",
    app: "Application",
  },
  palette: {
    title: "Command palette",
    placeholder: "Search commands…",
    empty: "No matching commands",
    hint: "↑↓ select · Enter run · Esc close",
  },
} as const;

export const logs = {
  kicker: "Diagnostics · Log",
  title: "Runtime logs",
  description:
    "A record of what happens behind the page. Local only, rotated daily, kept for seven days.",
  filter: "Level",
  all: "All",
  level: {
    trace: "Trace",
    debug: "Debug",
    info: "Info",
    warn: "Warn",
    error: "Error",
  },
  stats: "{{total}} entries · {{errors}} errors · {{warns}} warnings",
  unitEntries: "entries",
  unitErrors: "errors",
  unitWarns: "warnings",
  files: "{{count}} files · {{size}}",
  refresh: "Refresh",
  loadingShort: "Loading…",
  loading: "Reading logs…",
  emptyTitle: "This page is empty",
  empty: "Nothing at this level yet. Switch levels or wait for the next action.",
  autoRefresh: "Auto refresh",
  openShort: "Open",
  openDir: "Open folder",
  export: "Export",
  clear: "Clear old logs",
  confirmTitle: "Delete logs older than 7 days?",
  confirm: "Delete",
  cancel: "Cancel",
  close: "Close",
  toast: {
    exported: "Logs exported to {{path}}",
    exportFailed: "Could not export logs. Try again later.",
    cleared: "Deleted {{count}} old log files",
    clearFailed: "Could not clear logs. Try again later.",
    openFailed: "Could not open the log folder. Try again later.",
    loadFailed: "Could not read logs. Try again later.",
    copied: "Copied this entry",
  },
} as const;

export const en = { common, editor, errors, update, commands: commandLabels, about, logs };
