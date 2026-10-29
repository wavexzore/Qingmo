import type {
  AppErrorCode,
  ApplyLocaleRequest,
  CloseReason,
  DraftRecord,
  EditorViewState,
  ReadOnlyReason,
  TextFormat,
  UpdateSnapshot,
} from "@qingmo/shared";

import { COMMANDS, type MenuAction } from "../lib/ipc/commands";
import { AppError as AppErrorClass } from "../lib/ipc/errors";
import { FakeIpc, type FakeFileSnapshot } from "../lib/ipc/fake";
import { FakeLogPort } from "../lib/log/fake";
import type { CloseConfirmRequest } from "../lib/ipc/port";
import { FakePlatform } from "../lib/platform/fake";
import { FakeUpdatePort, type FakeUpdateCalls } from "../lib/update/fake";

export interface E2eSeedFile {
  path: string;
  text?: string;
  format?: Partial<TextFormat>;
  readOnlyReason?: ReadOnlyReason | null;
}

export interface E2eUpdateInfo {
  version: string;
  date?: string | null;
  body?: string | null;
}

/**
 * Small, explicit test surface used only by `vite build --mode e2e`.
 *
 * Playwright seeds `__QINGMO_E2E_SEED__` with `addInitScript`, then drives the
 * same FakeIpc/FakePlatform the unit tests use. The production build replaces
 * `MODE` with `production`, so this module is tree-shaken out of the Tauri
 * bundle.
 */
export interface E2eBridge {
  setDiskText(path: string, text: string): void;
  deleteDiskFile(path: string): void;
  getFile(path: string): FakeFileSnapshot | undefined;
  setOpenFile(path: string | null): void;
  setSaveAsFile(path: string | null): void;
  emitClose(reason?: CloseReason): void;
  emitMenuAction(action: MenuAction): void;
  emitBlur(): void;
  setComposing(composing: boolean): void;
  failSaveAlways(code?: AppErrorCode): void;
  clearErrors(): void;
  getCloseConfirms(): CloseConfirmRequest[];
  getLivePreviewMenuCalls(): boolean[];
  getLocaleCalls(): ApplyLocaleRequest[];
  setLogFileCount(count: number): void;
  setUpdateAvailable(update: E2eUpdateInfo | null): void;
  setUpdateError(operation: "check" | "download" | "install", code: AppErrorCode | null): void;
  holdUpdateDownload(): void;
  releaseUpdateDownload(): void;
  emitUpdateProgress(downloaded: number, total?: number | null): void;
  getUpdateCalls(): FakeUpdateCalls;
  getUpdateSnapshot(): UpdateSnapshot;
  /** Reads the FakeIpc view-state map, including writes made by the recorder. */
  getViewState(path: string): Promise<EditorViewState | null>;
}

declare global {
  interface Window {
    __QINGMO_E2E_SEED__?: E2eSeedFile[];
    /** Drafts seeded before React mounts, so the recovery list sees them. */
    __QINGMO_E2E_SEED_DRAFTS__?: DraftRecord[];
    /** View states seeded before the document session is created. */
    __QINGMO_E2E_SEED_VIEW_STATE__?: Array<{ path: string; state: EditorViewState }>;
    /** Path staged for a `/?window=document` boot. */
    __QINGMO_E2E_PENDING__?: string;
    __QINGMO_E2E__?: E2eBridge;
  }
}

export function isE2eMode(): boolean {
  return import.meta.env.MODE === "e2e";
}

export function createE2eServices(): {
  ipc: FakeIpc;
  platform: FakePlatform;
  updates: FakeUpdatePort;
  logs: FakeLogPort;
} {
  const files = window.__QINGMO_E2E_SEED__ ?? [];
  const ipc = new FakeIpc({ files });
  for (const draft of window.__QINGMO_E2E_SEED_DRAFTS__ ?? []) {
    ipc.seedDraft(draft);
  }
  for (const seed of window.__QINGMO_E2E_SEED_VIEW_STATE__ ?? []) {
    ipc.seedViewState(seed.path, seed.state);
  }
  const pendingPath = window.__QINGMO_E2E_PENDING__;
  if (pendingPath) {
    ipc.stagePendingPath(pendingPath);
  }
  const platform = new FakePlatform();
  const updates = new FakeUpdatePort();
  const logs = new FakeLogPort();

  window.__QINGMO_E2E__ = {
    setDiskText: (path, text) => {
      ipc.setDiskText(path, text);
    },
    deleteDiskFile: (path) => {
      ipc.deleteDiskFile(path);
    },
    getFile: (path) => ipc.getFile(path),
    setOpenFile: (path) => {
      ipc.setOpenFile(path);
    },
    setSaveAsFile: (path) => {
      ipc.setSaveAsFile(path);
    },
    emitClose: (reason = "window") => {
      platform.emitCloseRequested(reason);
    },
    emitMenuAction: (action) => {
      platform.emitMenuAction(action);
    },
    emitBlur: () => {
      platform.emitBlur();
    },
    setComposing: (composing) => {
      platform.setComposing(composing);
    },
    failSaveAlways: (code = "IO") => {
      ipc.failAlways(COMMANDS.documentWriteAtomic, code as AppErrorCode);
    },
    clearErrors: () => {
      ipc.clearInjectedErrors();
    },
    getCloseConfirms: () => [...ipc.closeConfirmCalls],
    getLivePreviewMenuCalls: () => [...ipc.livePreviewCalls],
    getLocaleCalls: () => [...ipc.localeCalls],
    setLogFileCount: (count) => {
      logs.fileCount = count;
    },
    setUpdateAvailable: (update) => {
      updates.setUpdate(
        update
          ? {
              version: update.version,
              date: update.date ?? null,
              body: update.body ?? null,
            }
          : null,
      );
    },
    setUpdateError: (operation, code) => {
      updates.setError(
        operation,
        code ? new AppErrorClass(code, `e2e ${operation} failure`) : null,
      );
    },
    holdUpdateDownload: () => {
      updates.holdNextDownload();
    },
    releaseUpdateDownload: () => {
      updates.releaseDownload();
    },
    emitUpdateProgress: (downloaded, total = null) => {
      updates.emitDownloadProgress(downloaded, total);
    },
    getUpdateCalls: () => ({ ...updates.calls }),
    getUpdateSnapshot: () => updates.currentSnapshot,
    getViewState: (path) => ipc.sessionViewStateGet(path),
  };

  return { ipc, platform, updates, logs };
}
