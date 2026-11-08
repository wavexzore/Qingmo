import { attachments, type EditorUiCopy } from "@qingmo/editor-core";
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
function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunk) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export async function createDocumentSession(
  ipc: Pick<IpcPort, "sessionViewStateGet" | "appOpenExternal" | "documentSaveImage">,
  payload: FilePayload,
  uiCopy?: EditorUiCopy,
): Promise<CreatedDocumentSession> {
  let viewState: EditorViewState | null = null;
  try {
    viewState = await ipc.sessionViewStateGet(payload.path);
  } catch (error) {
    console.warn("failed to read the persisted view state", error);
  }

  let currentToken = payload.docToken;
  const session = EditorSession.create(payload, {
    ...(uiCopy ? { uiCopy } : {}),
    openExternal: createOpenExternal(ipc),
    extensions: [
      attachments({
        async onImageFiles(files) {
          const markdown: string[] = [];
          for (const file of files) {
            const result = await ipc.documentSaveImage({
              docToken: currentToken,
              fileName: file.name || "image.png",
              mime: file.type || "image/png",
              dataBase64: base64Of(await file.arrayBuffer()),
            });
            markdown.push(result.markdown);
          }
          return markdown;
        },
      }),
    ],
    ...(viewState
      ? {
          initialSelection: { anchor: viewState.anchor, head: viewState.head },
          previewPreference: viewState.livePreviewPreferred,
        }
      : {}),
  });
  currentToken = session.docToken;
  return { session, viewState };
}
