import type { EditorUiCopy } from "@qingmo/editor-core";
import type { EditorViewState, FilePayload } from "@qingmo/shared";

import type { IpcPort } from "../../../lib/ipc/port";
import { EditorSession } from "../EditorSession";
import { createOpenExternal } from "./open-external";

export interface CreatedDocumentSession {
  session: EditorSession;
  /**
   * Persisted scroll/selection/preference, or `null` when the open fails or
   * the document has never been seen. The caller passes it to `EditorHost`
   * so the first frame is already scrolled to the saved position.
   */
  viewState: EditorViewState | null;
}

/**
 * Creates a named document session and restores its view state.
 *
 * A storage failure must never block opening a document: it degrades to the
 * default cursor at the top and preview enabled.
 */
export async function createDocumentSession(
  ipc: Pick<IpcPort, "sessionViewStateGet" | "appOpenExternal">,
  payload: FilePayload,
  uiCopy?: EditorUiCopy,
): Promise<CreatedDocumentSession> {
  let viewState: EditorViewState | null = null;
  try {
    viewState = await ipc.sessionViewStateGet(payload.path);
  } catch (error) {
    console.warn("failed to read the persisted view state", error);
  }

  const session = EditorSession.create(payload, {
    ...(uiCopy ? { uiCopy } : {}),
    openExternal: createOpenExternal(ipc),
    ...(viewState
      ? {
          initialSelection: { anchor: viewState.anchor, head: viewState.head },
          previewPreference: viewState.livePreviewPreferred,
        }
      : {}),
  });
  return { session, viewState };
}
