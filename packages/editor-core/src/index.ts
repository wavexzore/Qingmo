export {
  createEditorState,
  modeCompartment,
  normalizeLineEndings,
  placeholderCompartment,
  readOnlyCompartment,
  readOnlyExtensions,
  setModeEffect,
  setPlaceholderEffect,
  setReadOnlyEffect,
  setThemeEffect,
  setEditorUiCopyEffect,
  themeCompartment,
  uiCopyCompartment,
} from "./createEditor";
export type { CreateEditorStateOptions } from "./createEditor";
export {
  DEFAULT_EDITOR_UI_COPY,
  EDITOR_COPY_SCHEMA_VERSION,
  editorUiCopy,
  localizeWidget,
  CopyAwareWidget,
  editorCopyChanged,
  type EditorUiCopy,
  type LocalizeWidgetOptions,
} from "./i18n";
export { basicExtensions, createBasicExtensions } from "./extensions/basic";
export { codeLanguages, languageForFilename } from "./extensions/languages";
export { markdownExtensions, qingmoHighlightStyle } from "./extensions/markdown";
export { codeBlockSelectAll, selectAllInCodeBlock } from "./extensions/select-all";
export { qingmoEditorTheme, themeExtension, type EditorTheme } from "./extensions/theme";
export {
  PREVIEW_FULL_MAX_UNITS,
  PREVIEW_PARTIAL_MAX_UNITS,
  MAX_LINE_UNITS,
  SYNTAX_TREE_BUDGET_MS,
  previewTierFor,
  type PreviewTier,
} from "./limits";
export { buildLivePreviewDecorations, livePreview, livePreviewPlugin } from "./live-preview/plugin";
export {
  collectDecorationSpecs,
  readTable,
  type DecorationSpec,
  type LivePreviewWidgetSpec,
  type ParsedTable,
  type TableAlignment,
  type TableCellRange,
  type VisibleRange,
} from "./live-preview/specs";
export { tableBlockPreview } from "./live-preview/table-blocks";
export {
  editorOpenExternal,
  isOpenableHref,
  linkHrefAt,
  openExternalLink,
  type EditorOpenExternalPort,
} from "./live-preview/link-click";
export { codeBlockPreview, type CodeBlockRange } from "./live-preview/code-blocks";
export { mathBlockPreview } from "./live-preview/math-blocks";
export { mermaidBlockPreview } from "./live-preview/mermaid-blocks";
export { frontMatterPreview, readFrontMatter } from "./live-preview/frontmatter";
export type {
  FrontMatterEntry,
  FrontMatterFormat,
  ParsedFrontMatter,
} from "./live-preview/frontmatter";
export { tocPreview } from "./live-preview/toc";
export { definitionListPreview, parseDefinitionList } from "./live-preview/definition-lists";
export type { DefinitionListData } from "./live-preview/definition-lists";
export { detailsBlockPreview, readDetailsBlocks } from "./live-preview/details";
export type { DetailsBlock } from "./live-preview/details";
export { mediaBlockPreview, readMediaBlocks } from "./live-preview/media-blocks";
export type { MediaBlock, MediaKind, MediaSource } from "./live-preview/media-blocks";
export { commentBlockPreview, readCommentBlocks } from "./live-preview/comment-blocks";
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
export { minimapExtension } from "./minimap/minimap";
export type { MinimapOptions, MinimapState } from "./minimap/minimap";

/**
 * Editor presentation modes. The CodeMirror mode compartment reconfigures
 * between these values without recreating the editor view.
 */
export const EDITOR_MODE = {
  source: "source",
  livePreview: "live-preview",
} as const;

export type EditorMode = (typeof EDITOR_MODE)[keyof typeof EDITOR_MODE];
