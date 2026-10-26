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

export interface E2eBridge {
  setDiskText(path: string, text: string): void;
  getFile(path: string): E2eFileSnapshot | undefined;
  setOpenFile(path: string | null): void;
  emitClose(reason?: CloseReason): void;
  emitBlur(): void;
  setComposing(composing: boolean): void;
  failSaveAlways(code?: string): void;
  clearErrors(): void;
  getCloseConfirms(): Array<{ allow: boolean }>;
}

declare global {
  interface Window {
    __QINGMO_E2E_SEED__?: SeedFile[];
    __QINGMO_E2E__?: E2eBridge;
  }
}

export {};
