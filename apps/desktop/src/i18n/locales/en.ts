import type { AppErrorCode } from "@qingmo/shared";

export const common = {
  appName: "Qingmo",
  appNameLatin: "Qingmo",
  tagline: "Quiet as paper, fast as a code editor.",
  actions: {
    openFile: "Open Markdown file",
    openEditor: "View editor empty state",
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
  },
  saveState: {
    clean: "Synced",
    dirty: "Unsaved",
    saving: "Saving",
    saved: "Saved",
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
  status: {
    position: "Line {{line}}, column {{column}}",
    size: "{{value}} bytes",
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

export const en = { common, editor, errors };
