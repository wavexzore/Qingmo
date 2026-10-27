import type {
  AppErrorCode,
  CloseReason,
  ReadOnlyReason,
  TextFormat,
  UpdateSnapshot,
} from "@qingmo/shared";

import { COMMANDS, type MenuAction } from "../lib/ipc/commands";
import { AppError as AppErrorClass } from "../lib/ipc/errors";
import { FakeIpc, type FakeFileSnapshot } from "../lib/ipc/fake";
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
  setUpdateAvailable(update: E2eUpdateInfo | null): void;
  setUpdateError(operation: "check" | "download" | "install", code: AppErrorCode | null): void;
  holdUpdateDownload(): void;
  releaseUpdateDownload(): void;
  emitUpdateProgress(downloaded: number, total?: number | null): void;
  getUpdateCalls(): FakeUpdateCalls;
  getUpdateSnapshot(): UpdateSnapshot;
}

declare global {
  interface Window {
    __QINGMO_E2E_SEED__?: E2eSeedFile[];
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
} {
  const files = window.__QINGMO_E2E_SEED__ ?? [];
  const ipc = new FakeIpc({ files });
  const platform = new FakePlatform();
  const updates = new FakeUpdatePort();

  window.__QINGMO_E2E__ = {
    setDiskText: (path, text) => {
      ipc.setDiskText(path, text);
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
  };

  return { ipc, platform, updates };
}
