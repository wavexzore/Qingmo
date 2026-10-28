import { LANGUAGE_STORAGE_KEY, THEME_STORAGE_KEY, type UiStore } from "../stores/uiStore";

/**
 * Keeps every webview (main, document windows, About) in sync when another
 * window writes a UI preference. `key === null` covers `localStorage.clear()`.
 */
export function watchUiStorage(
  store: Pick<UiStore, "syncFromStorage">,
  target: Window = window,
): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (
      event.key === null ||
      event.key === THEME_STORAGE_KEY ||
      event.key === LANGUAGE_STORAGE_KEY
    ) {
      store.syncFromStorage();
    }
  };

  target.addEventListener("storage", handleStorage);
  return () => {
    target.removeEventListener("storage", handleStorage);
  };
}
