import type { AboutInfo, AboutLink } from "@qingmo/shared";
import { invoke } from "@tauri-apps/api/core";

import {
  COMMANDS,
  type CommandName,
  type CommandRequestMap,
  type CommandResponseMap,
} from "../ipc/commands";
import { normalizeError } from "../ipc/errors";
import type { AboutPort } from "./port";

async function invokeAbout<K extends CommandName>(
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
 * The only About adapter allowed to import `@tauri-apps/api`.
 * `dependency-cruiser` enforces this boundary.
 */
export function createTauriAbout(): AboutPort {
  return {
    info(): Promise<AboutInfo> {
      return invokeAbout(COMMANDS.appAboutInfo, {});
    },
    async close(): Promise<void> {
      await invokeAbout(COMMANDS.appAboutClose, {});
    },
    async openLink(link: AboutLink): Promise<void> {
      await invokeAbout(COMMANDS.appAboutOpenLink, { link });
    },
  };
}
