/**
 * Editor presentation modes. The CodeMirror mode compartment reconfigures
 * between these values without recreating the editor view.
 */
export const EDITOR_MODE = {
  source: "source",
  livePreview: "live-preview",
} as const;

export type EditorMode = (typeof EDITOR_MODE)[keyof typeof EDITOR_MODE];
