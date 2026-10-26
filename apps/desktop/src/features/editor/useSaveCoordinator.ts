import { useCallback, useSyncExternalStore } from "react";

import type { SaveCoordinator, SaveCoordinatorSnapshot } from "./save/SaveCoordinator";

const EMPTY_SNAPSHOT: SaveCoordinatorSnapshot = Object.freeze({
  state: "clean",
  conflict: null,
  error: null,
  retryAttempts: 0,
  pending: false,
});

/**
 * Subscribes the conflict banner/status UI to save-internal details. The
 * document save state itself still comes from EditorSession; this store only
 * carries conflict/error payloads that the metadata snapshot must not hold.
 */
export function useSaveCoordinator(coordinator: SaveCoordinator | null): SaveCoordinatorSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => coordinator?.subscribe(listener) ?? (() => undefined),
    [coordinator],
  );
  const getSnapshot = useCallback(
    () => coordinator?.getSnapshot() ?? EMPTY_SNAPSHOT,
    [coordinator],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
