export type TextEncoding = "utf8" | "utf16Le" | "utf16Be";
export type LineEnding = "lf" | "crlf" | "cr";
export type ReadOnlyReason = "mdx" | "mixedEol";
export type CloseReason = "window" | "exit";

export interface SeedFile {
  path: string;
  text?: string;
  format?: {
    encoding?: TextEncoding;
    hasBom?: boolean;
    eol?: LineEnding;
  };
  readOnlyReason?: ReadOnlyReason | null;
}

export interface E2eFileSnapshot {
  path: string;
  text: string;
  size: number;
}

export interface E2eUpdateInfo {
  version: string;
  date?: string | null;
  body?: string | null;
}

export interface E2eUpdateCalls {
  status: number;
  check: number;
  download: number;
  install: number;
}

export interface E2eUpdateSnapshot {
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing";
  generation: number;
  currentVersion: string;
  update: E2eUpdateInfo | null;
  progress: { downloaded: number; total: number | null } | null;
}

export interface E2eBridge {
  setDiskText(path: string, text: string): void;
  getFile(path: string): E2eFileSnapshot | undefined;
  setOpenFile(path: string | null): void;
  setSaveAsFile(path: string | null): void;
  emitClose(reason?: CloseReason): void;
  emitMenuAction(action: string): void;
  emitBlur(): void;
  setComposing(composing: boolean): void;
  failSaveAlways(code?: string): void;
  clearErrors(): void;
  getCloseConfirms(): Array<{ allow: boolean }>;
  setUpdateAvailable(update: E2eUpdateInfo | null): void;
  setUpdateError(operation: "check" | "download" | "install", code: string | null): void;
  holdUpdateDownload(): void;
  releaseUpdateDownload(): void;
  emitUpdateProgress(downloaded: number, total?: number | null): void;
  getUpdateCalls(): E2eUpdateCalls;
  getUpdateSnapshot(): E2eUpdateSnapshot;
}

declare global {
  interface Window {
    __QINGMO_E2E_SEED__?: SeedFile[];
    __QINGMO_E2E__?: E2eBridge;
  }
}

export {};
