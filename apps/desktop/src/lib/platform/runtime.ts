/**
 * Pure runtime probe. Components never import @tauri-apps/api; only the two
 * production adapters may do that. Keeping the probe dependency-free also
 * makes the browser fallback testable without mocking the Tauri package.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
