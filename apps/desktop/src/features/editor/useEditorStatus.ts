import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { StatusBarSnapshot } from "../../components/StatusBar";
import type { EditorSession } from "./EditorSession";

/**
 * Subscribes the status bar to the session's throttled notification channel.
 * Cursor moves are trailing-throttled by EditorSession (100ms); save-state
 * changes flush immediately. The unmount cleanup flushes any pending cursor,
 * so switching documents never shows a stale position.
 */
export function useEditorStatus(session: EditorSession, enabled = true): StatusBarSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) {
        return () => undefined;
      }
      return session.subscribeStatus(onStoreChange);
    },
    [enabled, session],
  );
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const flush = () => {
      session.flushStatus();
    };
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("blur", flush);
      session.flushStatus();
    };
  }, [enabled, session]);

  return {
    fileName: snapshot.fileName,
    saveState: snapshot.saveState,
    cursor: snapshot.cursor,
    encoding: snapshot.format.encoding,
    eol: snapshot.format.eol,
    size: snapshot.size,
    mode: snapshot.livePreview ? "livePreview" : "source",
    previewTier: snapshot.previewTier,
    readOnly: snapshot.readOnly,
    readOnlyReason: snapshot.readOnlyReason,
  };
}
