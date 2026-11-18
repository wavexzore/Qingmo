import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DocumentChangedPayload,
  DocumentRelocatedPayload,
  WorkspaceIndexStatusPayload,
} from "@qingmo/shared";

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
    async documentActivate(docToken) {
      await invokeCommand(COMMANDS.documentActivate, { docToken });
    },
    async documentNew() {
      await invokeCommand(COMMANDS.documentNew, {});
      return "window";
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
    documentSaveImage(request) {
      return invokeCommand(COMMANDS.documentSaveImage, request);
    },
    documentHistoryList(docToken, limit, offset) {
      return invokeCommand(COMMANDS.documentHistoryList, {
        docToken,
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
    },
    documentHistoryRead(docToken, entryId) {
      return invokeCommand(COMMANDS.documentHistoryRead, { docToken, entryId });
    },
    documentHistoryRestore(docToken, entryId) {
      return invokeCommand(COMMANDS.documentHistoryRestore, { docToken, entryId });
    },
    workspaceOpen() {
      return invokeCommand(COMMANDS.workspaceOpen, {});
    },
    workspaceCurrent() {
      return invokeCommand(COMMANDS.workspaceCurrent, {});
    },
    workspaceList(workspaceToken, dirSegments) {
      return invokeCommand(COMMANDS.workspaceList, { workspaceToken, dirSegments });
    },
    workspaceOpenDocument(workspaceToken, segments) {
      return invokeCommand(COMMANDS.workspaceOpenDocument, { workspaceToken, segments });
    },
    workspaceLocateDocument(workspaceToken, docToken) {
      return invokeCommand(COMMANDS.workspaceLocateDocument, { workspaceToken, docToken });
    },
    workspaceDelete(workspaceToken, segments) {
      return invokeCommand(COMMANDS.workspaceDelete, { workspaceToken, segments });
    },
    workspaceTrashList(workspaceToken) {
      return invokeCommand(COMMANDS.workspaceTrashList, { workspaceToken });
    },
    workspaceTrashRestore(workspaceToken, entryId, mode) {
      return invokeCommand(COMMANDS.workspaceTrashRestore, { workspaceToken, entryId, mode });
    },
    async workspaceTrashPurge(workspaceToken, entryId) {
      await invokeCommand(COMMANDS.workspaceTrashPurge, { workspaceToken, entryId });
    },
    workspaceSearch(workspaceToken, query, limit, offset) {
      return invokeCommand(COMMANDS.workspaceSearch, {
        workspaceToken,
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
    },
    async workspaceSearchRebuild(workspaceToken) {
      await invokeCommand(COMMANDS.workspaceSearchRebuild, { workspaceToken });
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
    onDocumentRelocated(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;

      void listen<DocumentRelocatedPayload>(EVENTS.documentRelocated, (event) => {
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
          console.error("failed to subscribe to app://document-relocated", normalizeError(error));
        });

      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    },
    onCloseCancelled(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;
      void listen<{ reason: string; generation: number }>(EVENTS.closeCancelled, (event) => {
        if (!disposed) callback(event.payload);
      })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    },
    onWorkspaceIndexStatus(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;
      void listen<WorkspaceIndexStatusPayload>(EVENTS.workspaceIndexStatus, (event) => {
        if (!disposed) callback(event.payload);
      })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    },
    onWorkspaceChanged(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;

      void listen(EVENTS.workspaceChanged, () => {
        if (!disposed) {
          callback();
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
          // The tree keeps working through manual/focus refresh.
          console.error("failed to subscribe to app://workspace-changed", normalizeError(error));
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
    async appOpenExternal(href) {
      await invokeCommand(COMMANDS.appOpenExternal, { href });
    },
    sessionViewStateGet(path, docToken) {
      return invokeCommand(COMMANDS.sessionViewStateGet, {
        path,
        ...(docToken ? { docToken } : {}),
      });
    },
    async sessionViewStateSet(path, state, docToken) {
      await invokeCommand(COMMANDS.sessionViewStateSet, {
        path,
        state,
        ...(docToken ? { docToken } : {}),
      });
    },
    sessionDraftWrite(request) {
      return invokeCommand(COMMANDS.sessionDraftWrite, { request });
    },
    sessionDraftList() {
      return invokeCommand(COMMANDS.sessionDraftList, {});
    },
    sessionDraftRead(id) {
      return invokeCommand(COMMANDS.sessionDraftRead, { id });
    },
    sessionDraftDiscard(id) {
      return invokeCommand(COMMANDS.sessionDraftDiscard, { id });
    },
    async appSettingsOpen() {
      await invokeCommand(COMMANDS.appSettingsOpen, {});
    },
  };
}
