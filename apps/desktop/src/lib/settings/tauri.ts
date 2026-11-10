import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  COMMANDS,
  type CommandName,
  type CommandRequestMap,
  type CommandResponseMap,
} from "../ipc/commands";
import { EVENTS } from "../ipc/commands";
import { normalizeError } from "../ipc/errors";
import type { ModelProgress } from "@qingmo/shared";
import type { KeySlot, SettingsPort } from "./port";

async function invokeSettings<K extends CommandName>(
  command: K,
  args: CommandRequestMap[K],
): Promise<CommandResponseMap[K]> {
  try {
    return await invoke<CommandResponseMap[K]>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * The only settings adapter allowed to import `@tauri-apps/api`.
 * `dependency-cruiser` enforces this boundary.
 */
export function createTauriSettings(): SettingsPort {
  return {
    info(): Promise<string> {
      return invokeSettings(COMMANDS.appSettingsInfo, {});
    },
    async close(): Promise<void> {
      await invokeSettings(COMMANDS.appSettingsClose, {});
    },
    meetingConfigGet: () => invokeSettings(COMMANDS.meetingConfigGet, {}),
    meetingConfigSet: (patch, expectedRevision) =>
      invokeSettings(COMMANDS.meetingConfigSet, { patch, expectedRevision }),
    meetingKeyStatus: (slot: KeySlot) => invokeSettings(COMMANDS.meetingKeyStatus, { slot }),
    meetingKeySet: async (slot: KeySlot, value: string) => {
      await invokeSettings(COMMANDS.meetingKeySet, { slot, value });
    },
    meetingKeyClear: async (slot: KeySlot, all?: boolean) => {
      await invokeSettings(COMMANDS.meetingKeyClear, all === undefined ? { slot } : { slot, all });
    },
    meetingModelsList: () => invokeSettings(COMMANDS.meetingModelsList, {}),
    meetingModelDownload: (id: string) => invokeSettings(COMMANDS.meetingModelDownload, { id }),
    meetingModelDownloadCancel: async (downloadId: string) => {
      await invokeSettings(COMMANDS.meetingModelDownloadCancel, { downloadId });
    },
    meetingModelRemove: async (id: string) => {
      await invokeSettings(COMMANDS.meetingModelRemove, { id });
    },
    onModelProgress(handler) {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen<ModelProgress>(EVENTS.meetingModelProgress, (event) => {
        handler(event.payload);
      }).then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    async openExternal(href: string) {
      await invokeSettings(COMMANDS.appOpenExternal, { href });
    },
  };
}
