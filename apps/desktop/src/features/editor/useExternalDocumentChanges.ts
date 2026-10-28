import { useEffect, useRef } from "react";

import { useAppServices } from "../../app/AppServices";
import { useToast } from "../../components/ToastHost";
import i18n from "../../i18n";
import type { EditorSession } from "./EditorSession";
import type { SaveCoordinator } from "./save/SaveCoordinator";

/**
 * Bridges `app://document-changed` into the editor session.
 *
 * - A clean buffer reloads automatically: the editor text already matches the
 *   old disk version, so there is nothing local to lose.
 * - A dirty buffer opens the existing conflict banner instead; autosave stays
 *   paused until the user reloads or overwrites.
 * - A deleted file is reported without touching the editor: the text may
 *   still be the only copy the user has.
 *
 * The subscription is installed once. Refs avoid resubscribing on every
 * keystroke, while Save As changes the docToken the callback must compare.
 */
export function useExternalDocumentChanges(
  session: EditorSession,
  coordinator: SaveCoordinator | null,
): void {
  const { ipc } = useAppServices();
  const toast = useToast();
  const sessionRef = useRef(session);
  const coordinatorRef = useRef(coordinator);
  sessionRef.current = session;
  coordinatorRef.current = coordinator;

  useEffect(() => {
    return ipc.onDocumentChanged((change) => {
      const current = sessionRef.current;
      const save = coordinatorRef.current;
      if (!save || current.isUntitled || change.docToken !== current.docToken) {
        return;
      }

      if (change.kind === "deleted") {
        toast.push(i18n.t("editor:external.deleted"));
        return;
      }

      const { currentHash, currentSize, currentMtimeMs } = change;
      if (currentHash === undefined || currentSize === undefined || currentMtimeMs === undefined) {
        return;
      }

      // Our own atomic save, a duplicate event, or a file that was already
      // current: nothing to apply.
      if (currentHash === current.getMetadataSnapshot().hash) {
        return;
      }

      const details = { currentHash, currentSize, currentMtimeMs };

      if (current.getSnapshot().dirty) {
        save.noteExternalChange(details);
        return;
      }

      void save
        .autoReload(details)
        .then((result) => {
          if (result.ok) {
            toast.push(i18n.t("editor:external.reloaded"));
          } else if (result.failure === "error") {
            toast.push(i18n.t("editor:external.reloadFailed"));
          }
        })
        .catch(() => {
          toast.push(i18n.t("editor:external.reloadFailed"));
        });
    });
  }, [ipc, toast]);
}
