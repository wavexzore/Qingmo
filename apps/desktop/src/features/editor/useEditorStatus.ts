import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { StatusBarSnapshot } from "../../components/StatusBar";
import type { EditorSession } from "./EditorSession";

/**
 * Subscribes the status bar to the session's throttled notification channel.
 * Cursor moves are trailing-throttled by EditorSession (100ms); save-state
 * changes flush immediately. The unmount cleanup flushes any pending cursor,
 * so switching documents never shows a stale position.
 */
export function useEditorStatus(session: EditorSession): StatusBarSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => session.subscribeStatus(onStoreChange),
    [session],
  );
  const snapshot = useSyncExternalStore(subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    const flush = () => {
      session.flushStatus();
    };
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("blur", flush);
      session.flushStatus();
    };
  }, [session]);

  return {
    fileName: snapshot.fileName,
    saveState: snapshot.saveState,
    cursor: snapshot.cursor,
    encoding: snapshot.format.encoding,
    eol: snapshot.format.eol,
    size: snapshot.size,
    mode: "source",
  };
}
