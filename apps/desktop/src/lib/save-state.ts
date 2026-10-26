/**
 * The single save-state vocabulary shared by EditorSession, StatusBar,
 * SaveCoordinator, and the conflict banner. `dirty` is derived from this
 * value, never stored as a second independent flag.
 *
 * T-011 replaces the earlier transient `saved` value with `scheduled`, so the
 * status bar can show an armed debounce/retry without pretending the document
 * is clean.
 */
export type SaveState =
  "clean" | "dirty" | "scheduled" | "saving" | "error" | "conflict" | "readonly";
