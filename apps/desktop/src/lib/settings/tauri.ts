import { invoke } from "@tauri-apps/api/core";

import {
  COMMANDS,
  type CommandName,
  type CommandRequestMap,
  type CommandResponseMap,
} from "../ipc/commands";
import { normalizeError } from "../ipc/errors";
import type { SettingsPort } from "./port";

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
  };
}
