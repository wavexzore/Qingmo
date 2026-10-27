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
export { qingmoEditorTheme, themeExtension, type EditorTheme } from "./extensions/theme";
export { LP_MAX_UNITS, MAX_LINE_UNITS, SYNTAX_TREE_BUDGET_MS } from "./limits";
export { buildLivePreviewDecorations, livePreview, livePreviewPlugin } from "./live-preview/plugin";
export {
  collectDecorationSpecs,
  readTable,
  type DecorationSpec,
  type LivePreviewWidgetSpec,
  type ParsedTable,
  type TableAlignment,
  type VisibleRange,
} from "./live-preview/specs";
export { TABLE_BLOCK_MAX_UNITS, tableBlockPreview } from "./live-preview/table-blocks";
export { MATH_BLOCK_MAX_UNITS, mathBlockPreview } from "./live-preview/math-blocks";
export { MERMAID_BLOCK_MAX_UNITS, mermaidBlockPreview } from "./live-preview/mermaid-blocks";
export {
  FRONTMATTER_MAX_UNITS,
  frontMatterPreview,
  readFrontMatter,
} from "./live-preview/frontmatter";
export type {
  FrontMatterEntry,
  FrontMatterFormat,
  ParsedFrontMatter,
} from "./live-preview/frontmatter";
export { TOC_BLOCK_MAX_UNITS, tocPreview } from "./live-preview/toc";
export {
  DEFINITION_LIST_MAX_UNITS,
  definitionListPreview,
  parseDefinitionList,
} from "./live-preview/definition-lists";
export type { DefinitionListData } from "./live-preview/definition-lists";
export {
  DETAILS_BLOCK_MAX_UNITS,
  detailsBlockPreview,
  readDetailsBlocks,
} from "./live-preview/details";
export type { DetailsBlock } from "./live-preview/details";
export {
  MEDIA_BLOCK_MAX_UNITS,
  mediaBlockPreview,
  readMediaBlocks,
} from "./live-preview/media-blocks";
export type { MediaBlock, MediaKind, MediaSource } from "./live-preview/media-blocks";
export {
  COMMENT_BLOCK_MAX_UNITS,
  commentBlockPreview,
  readCommentBlocks,
} from "./live-preview/comment-blocks";
export type { CommentBlock, CommentKind } from "./live-preview/comment-blocks";
export { renderMermaid, type MermaidTheme } from "./live-preview/mermaid-render";
export {
  MERMAID_THEME_VERSION,
  buildMermaidTheme,
  diagramInfo,
  diagramKind,
  isMermaidDiagramKind,
  mermaidDiagramConfig,
  mermaidElkConfig,
  mermaidLayout,
  mermaidPaletteKey,
  resolveMermaidPalette,
  sanitizeMermaidPalette,
  type MermaidDiagramInfo,
  type MermaidDiagramKind,
  type MermaidPalette,
  type MermaidThemeConfig,
} from "./live-preview/mermaid-theme";
export { sanitizeMermaidSvg } from "./live-preview/mermaid-sanitize";
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
