import type { AppErrorCode, CloseReason, ReadOnlyReason, TextFormat } from "@qingmo/shared";

import { COMMANDS } from "../lib/ipc/commands";
import { FakeIpc, type FakeFileSnapshot } from "../lib/ipc/fake";
import type { CloseConfirmRequest } from "../lib/ipc/port";
import { FakePlatform } from "../lib/platform/fake";

export interface E2eSeedFile {
  path: string;
  text?: string;
  format?: Partial<TextFormat>;
  readOnlyReason?: ReadOnlyReason | null;
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
  emitBlur(): void;
  setComposing(composing: boolean): void;
  failSaveAlways(code?: AppErrorCode): void;
  clearErrors(): void;
  getCloseConfirms(): CloseConfirmRequest[];
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

export function createE2eServices(): { ipc: FakeIpc; platform: FakePlatform } {
  const files = window.__QINGMO_E2E_SEED__ ?? [];
  const ipc = new FakeIpc({ files });
  const platform = new FakePlatform();

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
  };

  return { ipc, platform };
}
