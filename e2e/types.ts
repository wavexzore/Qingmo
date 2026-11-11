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

export interface SeedDraft {
  schemaVersion: number;
  id: string;
  kind: "untitled" | "named";
  path: string | null;
  title: string;
  text: string;
  textUnits: number;
  sizeBytes: number;
  anchor: number;
  head: number;
  createdAtMs: number;
  updatedAtMs: number;
  appVersion: string;
}

export interface SeedViewState {
  anchor: number;
  head: number;
  topPos: number;
  topOffset: number;
  scrollLeft: number;
  livePreviewPreferred: boolean;
  updatedAtMs: number;
}

export interface E2eFileSnapshot {
  path: string;
  text: string;
  size: number;
}

export interface E2eWorkspaceSeed {
  root: string;
  name?: string;
  files?: Array<SeedFile | string>;
}

export interface E2eWorkspaceInfo {
  token: string;
  root: string;
  name: string;
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

export interface E2eLocaleCall {
  language: string;
  labels: Record<string, string>;
}

import type { MeetingScenario } from "../apps/desktop/src/e2e/meetingFake";

export type { MeetingScenario };

export interface E2eBridge {
  setDiskText(path: string, text: string): void;
  deleteDiskFile(path: string): void;
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
  getLivePreviewMenuCalls(): boolean[];
  getLocaleCalls(): E2eLocaleCall[];
  getOpenedLinks(): string[];
  setLogFileCount(count: number): void;
  setUpdateAvailable(update: E2eUpdateInfo | null): void;
  setUpdateError(operation: "check" | "download" | "install", code: string | null): void;
  holdUpdateDownload(): void;
  releaseUpdateDownload(): void;
  emitUpdateProgress(downloaded: number, total?: number | null): void;
  getUpdateCalls(): E2eUpdateCalls;
  getUpdateSnapshot(): E2eUpdateSnapshot;
  getViewState(path: string): Promise<SeedViewState | null>;
  seedWorkspace(root: string, name?: string, files?: Array<SeedFile | string>): E2eWorkspaceInfo;
  addWorkspaceFile(path: string, text?: string): void;
  resetWorkspace(): void;
  setWorkspaceFolder(path: string | null): void;
  emitWorkspaceChanged(): void;
  getWorkspaceCalls(): Array<{ command: string; args: Record<string, unknown> }>;
  startMeeting(scenario?: MeetingScenario): string;
  advanceMeeting(): void;
  failMeeting(code?: string): void;
}

export type E2eAboutLink = "docs" | "github" | "changelog" | "license";

export interface E2eAboutBridge {
  about: {
    openedLinks: E2eAboutLink[];
    closed: boolean;
  };
  updates: {
    setUpdate(update: E2eUpdateInfo | null): void;
  };
}

export interface E2eSettingsBridge {
  settings: {
    closed: boolean;
    setModelState(id: string, state: string): void;
    setDisk(freeBytes: number): void;
    finishActiveDownload(): void;
  };
}

declare global {
  interface Window {
    __QINGMO_E2E_SEED__?: SeedFile[];
    __QINGMO_E2E_SEED_DRAFTS__?: SeedDraft[];
    __QINGMO_E2E_SEED_VIEW_STATE__?: Array<{ path: string; state: SeedViewState }>;
    __QINGMO_E2E_SEED_WORKSPACE__?: E2eWorkspaceSeed;
    __QINGMO_E2E_PENDING__?: string;
    __QINGMO_E2E__?: E2eBridge;
    __QINGMO_ABOUT_E2E__?: E2eAboutBridge;
    __QINGMO_SETTINGS_E2E__?: E2eSettingsBridge;
  }
}

export {};
