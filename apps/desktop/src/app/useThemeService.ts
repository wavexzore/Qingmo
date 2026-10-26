import { useEffect, useSyncExternalStore } from "react";

import type { EditorSession } from "../features/editor/EditorSession";
import { uiStore } from "../stores/uiStore";

/**
 * Bridges the UI theme store to the active editor session. The store owns the
 * persisted preference and the root `data-theme` attribute; the session only
 * reconfigures its theme compartment, so the view, selection and undo history
 * survive every theme switch.
 */
export function useThemeService(session: EditorSession | null): void {
  const snapshot = useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getSnapshot,
    uiStore.getSnapshot,
  );

  useEffect(() => {
    session?.applyTheme(snapshot.resolvedTheme);
  }, [session, snapshot.resolvedTheme]);
}
