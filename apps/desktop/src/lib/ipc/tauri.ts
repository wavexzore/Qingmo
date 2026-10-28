import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DocumentChangedPayload } from "@qingmo/shared";

import { normalizeError } from "./errors";
import {
  COMMANDS,
  EVENTS,
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
    onDocumentChanged(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;

      void listen<DocumentChangedPayload>(EVENTS.documentChanged, (event) => {
        if (!disposed) {
          callback(event.payload);
        }
      })
        .then((stop) => {
          if (disposed) {
            stop();
          } else {
            unlisten = stop;
          }
        })
        .catch((error: unknown) => {
          // The document stays usable without live change detection; the next
          // native save still performs the exact-hash conflict check.
          console.error("failed to subscribe to app://document-changed", normalizeError(error));
        });

      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    },
    async appCloseConfirm(request) {
      await invokeCommand(COMMANDS.appCloseConfirm, request);
    },
    async appSetLivePreview(request) {
      await invokeCommand(COMMANDS.appSetLivePreview, request);
    },
    async appApplyLocale(request) {
      // Rust takes `request: ApplyLocaleRequest`; Tauri does not spread structs.
      await invokeCommand(COMMANDS.appApplyLocale, { request });
    },
  };
}
