import { invoke } from "@tauri-apps/api/core";

import { normalizeError } from "./errors";
import {
  COMMANDS,
  type CommandName,
  type CommandRequestMap,
  type CommandResponseMap,
} from "./commands";
import type { IpcPort } from "./port";

async function invokeCommand<K extends CommandName>(
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
 * The only production adapter allowed to import `@tauri-apps/api`.
 * `dependency-cruiser` enforces this boundary.
 */
export function createTauriIpc(): IpcPort {
  return {
    documentOpen() {
      return invokeCommand(COMMANDS.documentOpen, {});
    },
    documentTakePending() {
      return invokeCommand(COMMANDS.documentTakePending, {});
    },
    documentReload(docToken) {
      return invokeCommand(COMMANDS.documentReload, { docToken });
    },
    documentSaveAs(text) {
      return invokeCommand(COMMANDS.documentSaveAs, { text });
    },
    documentWriteAtomic(request) {
      return invokeCommand(COMMANDS.documentWriteAtomic, request);
    },
    async appCloseConfirm(request) {
      await invokeCommand(COMMANDS.appCloseConfirm, request);
    },
    async appSetLivePreview(request) {
      await invokeCommand(COMMANDS.appSetLivePreview, request);
    },
  };
}
