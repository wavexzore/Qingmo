import type { UpdateFlushRequest, UpdateProgressPayload, UpdateSnapshot } from "@qingmo/shared";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { COMMANDS, EVENTS } from "../ipc/commands";
import { normalizeError } from "../ipc/errors";
import type { UpdatePort } from "./port";

async function invokeUpdate<K extends keyof typeof COMMANDS>(
  command: (typeof COMMANDS)[K],
): Promise<UpdateSnapshot> {
  try {
    return await invoke<UpdateSnapshot>(command, {});
  } catch (error) {
    throw normalizeError(error);
  }
}

async function invokeInstall(): Promise<void> {
  try {
    await invoke<null>(COMMANDS.appUpdateInstall, {});
  } catch (error) {
    throw normalizeError(error);
  }
}

async function invokeFlushAck(requestId: number, ok: boolean): Promise<void> {
  try {
    await invoke<null>(COMMANDS.appUpdateFlushAck, { requestId, ok });
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * The only production adapter allowed to import `@tauri-apps/*` for updates.
 * `dependency-cruiser` enforces this boundary.
 */
export function createTauriUpdatePort(): UpdatePort {
  return {
    status() {
      return invokeUpdate(COMMANDS.appUpdateStatus);
    },
    check() {
      return invokeUpdate(COMMANDS.appUpdateCheck);
    },
    download() {
      return invokeUpdate(COMMANDS.appUpdateDownload);
    },
    install() {
      return invokeInstall();
    },
    async onState(handler) {
      try {
        const unlisten = await listen<UpdateSnapshot>(EVENTS.updateState, (event) => {
          handler(event.payload);
        });
        return () => {
          unlisten();
        };
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async onProgress(handler) {
      try {
        const unlisten = await listen<UpdateProgressPayload>(EVENTS.updateProgress, (event) => {
          handler(event.payload);
        });
        return () => {
          unlisten();
        };
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async onFlushRequest(handler) {
      try {
        const unlisten = await listen<UpdateFlushRequest>(EVENTS.updateFlushRequest, (event) => {
          handler(event.payload);
        });
        return () => {
          unlisten();
        };
      } catch (error) {
        throw normalizeError(error);
      }
    },
    flushAck(requestId, ok) {
      return invokeFlushAck(requestId, ok);
    },
  };
}
