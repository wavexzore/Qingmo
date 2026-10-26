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
export { LP_MAX_UNITS, MAX_LINE_UNITS, SYNTAX_TREE_BUDGET_MS } from "./limits";
export { buildLivePreviewDecorations, livePreview, livePreviewPlugin } from "./live-preview/plugin";
export {
  collectDecorationSpecs,
  type DecorationSpec,
  type VisibleRange,
} from "./live-preview/specs";
export { livePreviewTheme } from "./live-preview/theme";

/**
 * Editor presentation modes. The CodeMirror mode compartment reconfigures
 * between these values without recreating the editor view.
 */
export const EDITOR_MODE = {
  source: "source",
  livePreview: "live-preview",
} as const;

export type EditorMode = (typeof EDITOR_MODE)[keyof typeof EDITOR_MODE];
