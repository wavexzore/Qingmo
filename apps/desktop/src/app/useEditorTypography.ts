import { useLayoutEffect, useSyncExternalStore } from "react";

import type { EditorSession } from "../features/editor/EditorSession";
import { uiStore } from "../stores/uiStore";

/**
 * Bridges the persisted typography preference to the active editor session.
 * `useLayoutEffect` seeds the state before EditorHost's passive effect creates
 * the first view, so the first frame already uses the user's type. The session
 * equality guard keeps identical snapshots from dispatching again.
 */
export function useEditorTypography(session: EditorSession | null): void {
  const snapshot = useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getSnapshot,
    uiStore.getSnapshot,
  );

  useLayoutEffect(() => {
    session?.applyTypography(snapshot.typography);
  }, [session, snapshot.typography]);
}
