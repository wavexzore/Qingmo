export {
  createEditorState,
  modeCompartment,
  normalizeLineEndings,
  readOnlyCompartment,
  readOnlyExtensions,
  setModeEffect,
  setReadOnlyEffect,
  setThemeEffect,
  themeCompartment,
} from "./createEditor";
export type { CreateEditorStateOptions } from "./createEditor";
export { basicExtensions, createBasicExtensions } from "./extensions/basic";
export { codeLanguages, languageForFilename } from "./extensions/languages";
export { markdownExtensions, qingmoHighlightStyle } from "./extensions/markdown";
export { qingmoEditorTheme } from "./extensions/theme";

/**
 * Editor presentation modes. The CodeMirror mode compartment reconfigures
 * between these values without recreating the editor view.
 */
export const EDITOR_MODE = {
  source: "source",
  livePreview: "live-preview",
} as const;

export type EditorMode = (typeof EDITOR_MODE)[keyof typeof EDITOR_MODE];
