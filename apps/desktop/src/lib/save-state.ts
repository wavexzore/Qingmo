/**
 * The single save-state vocabulary shared by EditorSession, StatusBar, and
 * (from T-011) SaveCoordinator. `dirty` is derived from this value, never
 * stored as a second independent flag.
 */
export type SaveState = "clean" | "dirty" | "saving" | "saved" | "error" | "conflict" | "readonly";
