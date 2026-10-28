import { Facet, type Transaction } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";

import type { MermaidDiagramKind } from "./live-preview/mermaid-kinds";

/** Bump when fields are added/renamed or the default copy changes meaning. */
export const EDITOR_COPY_SCHEMA_VERSION = 1;

/** True when a transaction changed the injected copy (language/schema). */
export function editorCopyChanged(transaction: Transaction): boolean {
  return (
    transaction.startState.facet(editorUiCopy).version !==
    transaction.state.facet(editorUiCopy).version
  );
}

/**
 * Every user-visible string editor-core renders. The desktop app builds this
 * from its `editor` namespace; editor-core never imports i18next.
 *
 * Functions are part of the contract so structured labels (`Note 1`,
 * `Embedded image: …`) cannot be rebuilt from concatenated fragments.
 */
export interface EditorUiCopy {
  /** Language + schema version; Widget eq and the decoration cache use it. */
  version: string;
  language: string;
  widgets: {
    externalRender: string;
    externalRenderHint: (name: string) => string;
    attributes: string;
    footnoteJump: string;
    inlineFootnote: (content: string) => string;
    inlineFootnoteLabel: (index: number) => string;
    abbreviation: string;
    wikiEmbed: (target: string) => string;
    wikiLink: (target: string) => string;
    htmlAnchor: (label: string) => string;
    anchorJump: (href: string) => string;
    taskToggle: string;
  };
  details: {
    summary: string;
    empty: string;
    tooLarge: string;
    edit: string;
    editTitle: string;
    wrapperTitle: string;
  };
  toc: {
    title: string;
    empty: string;
    wrapperTitle: string;
  };
  frontmatter: {
    title: string;
    wrapperTitle: string;
    entries: (count: number) => string;
    empty: string;
    more: (hidden: number) => string;
  };
  media: {
    video: string;
    audio: string;
    gallery: string;
    figure: string;
    image: string;
    centeredImage: string;
    embed: string;
    imageEmbedTitle: (target: string) => string;
    externalPage: string;
    externalBlocked: string;
    source: string;
    editSource: string;
  };
  mermaid: {
    edit: string;
    editTitle: string;
    zoomOut: string;
    zoomReset: string;
    zoomIn: string;
    fitWidth: string;
    fitTitle: string;
    source: string;
    sourceTitle: string;
    hintEdit: string;
    hintScroll: string;
    renderFailed: string;
    unsafeSvg: string;
    invalidSvg: string;
    unavailable: string;
    readyTimeout: string;
    renderTimeout: string;
  };
  math: { editSource: string };
  table: { editSource: string };
  codeBlock: {
    language: string;
    searchLanguage: string;
    plainText: string;
    customLanguage: (value: string) => string;
    copy: string;
    copied: string;
    copyFailed: string;
    more: string;
    selectAll: string;
  };
  definitionList: { editSource: string };
  comments: {
    wrapperTitle: string;
    html: string;
    obsidian: string;
    hiddenLines: (lines: number) => string;
    source: string;
    editSource: string;
  };
  diagramKinds: Record<MermaidDiagramKind, string>;
}

const DIAGRAM_KINDS_EN: Record<MermaidDiagramKind, string> = {
  flowchart: "Flowchart",
  sequence: "Sequence",
  class: "Class",
  state: "State",
  er: "ER",
  gantt: "Gantt",
  pie: "Pie",
  quadrant: "Quadrant",
  mindmap: "Mindmap",
  git: "Git",
  c4: "C4",
  journey: "Journey",
  timeline: "Timeline",
  requirement: "Requirement",
  sankey: "Sankey",
  xychart: "XY chart",
  block: "Block",
  packet: "Packet",
  architecture: "Architecture",
  kanban: "Kanban",
  radar: "Radar",
  treemap: "Treemap",
  ishikawa: "Ishikawa",
  wardley: "Wardley",
  zenuml: "ZenUML",
  info: "Info",
  unknown: "Diagram",
};

/**
 * Standalone/test fallback. The product always injects `buildEditorUiCopy`;
 * this value exists so editor-core can run without a translation runtime.
 */
export const DEFAULT_EDITOR_UI_COPY: EditorUiCopy = Object.freeze({
  version: `en:${EDITOR_COPY_SCHEMA_VERSION}`,
  language: "en",
  widgets: {
    externalRender: "External render",
    externalRenderHint: (name: string) =>
      `${name} requires an external renderer; the editor shows the source only`,
    attributes: "Attributes",
    footnoteJump: "Jump to footnote definition",
    inlineFootnote: (content: string) => `Inline footnote: ${content}`,
    inlineFootnoteLabel: (index: number) => `Note ${index}`,
    abbreviation: "Abbreviation",
    wikiEmbed: (target: string) => `Embed: ${target} (note content is not expanded)`,
    wikiLink: (target: string) => `Wiki link: ${target}`,
    htmlAnchor: (label: string) => `HTML anchor: ${label}`,
    anchorJump: (href: string) => `Jump to ${href}`,
    taskToggle: "Toggle task",
  },
  details: {
    summary: "Details",
    empty: "(empty)",
    tooLarge: "Content is too large; click “Source” to edit.",
    edit: "Source",
    editTitle: "Edit details block source",
    wrapperTitle: "Click the summary to expand/collapse; click the content to edit the source",
  },
  toc: {
    title: "Contents",
    empty: "No headings in this document",
    wrapperTitle: "Click an item to jump; click the blank area to edit the placeholder",
  },
  frontmatter: {
    title: "Front matter",
    wrapperTitle: "Click to edit Front Matter",
    entries: (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`,
    empty: "No metadata",
    more: (hidden: number) => `${hidden} more; click to view the source`,
  },
  media: {
    video: "Video",
    audio: "Audio",
    gallery: "Gallery",
    figure: "Figure",
    image: "Image",
    centeredImage: "Centered image",
    embed: "External embed",
    imageEmbedTitle: (target: string) => `Embedded image: ${target}`,
    externalPage: "External page",
    externalBlocked: "External pages are not loaded in the editor for security",
    source: "Source",
    editSource: "Edit media source",
  },
  mermaid: {
    edit: "Edit source",
    editTitle: "Edit Mermaid source",
    zoomOut: "Zoom out",
    zoomReset: "Reset to 100%",
    zoomIn: "Zoom in",
    fitWidth: "Fit",
    fitTitle: "Fit canvas width",
    source: "Source",
    sourceTitle: "Edit Mermaid source",
    hintEdit: "Click “Source” to edit",
    hintScroll: "Scroll horizontally to view",
    renderFailed: "Render failed",
    unsafeSvg: "Diagram content failed the safety filter",
    invalidSvg: "Diagram SVG is invalid",
    unavailable: "Mermaid renderer is unavailable",
    readyTimeout: "Mermaid renderer took too long to load",
    renderTimeout: "Mermaid diagram render timed out",
  },
  math: { editSource: "Click to edit the formula source" },
  table: { editSource: "Click a cell to edit the table" },
  codeBlock: {
    language: "Code language",
    searchLanguage: "Search languages",
    plainText: "Plain text",
    customLanguage: (value: string) => `Use “${value}”`,
    copy: "Copy code",
    copied: "Copied",
    copyFailed: "Copy failed",
    more: "More actions",
    selectAll: "Select all code",
  },
  definitionList: { editSource: "Click to edit the definition list source" },
  comments: {
    wrapperTitle: "Click to view the comment source",
    html: "HTML comment",
    obsidian: "Obsidian comment",
    hiddenLines: (lines: number) => `${lines} ${lines === 1 ? "line" : "lines"} hidden`,
    source: "Source",
    editSource: "Edit comment source",
  },
  diagramKinds: Object.freeze(DIAGRAM_KINDS_EN),
});

/**
 * The single copy source for Live Preview. `combine` keeps the last injected
 * value, matching the compartment's one-slot lifecycle.
 */
export const editorUiCopy = Facet.define<EditorUiCopy, EditorUiCopy>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_EDITOR_UI_COPY,
});

export interface LocalizeWidgetOptions<Content> {
  content: Content;
  copyVersion: string;
  sameContent: (left: Content, right: Content) => boolean;
  render: (content: Content, copy: EditorUiCopy) => HTMLElement;
}

class LocalizedWidget<Content> extends WidgetType {
  constructor(private readonly options: LocalizeWidgetOptions<Content>) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof LocalizedWidget &&
      other.options.copyVersion === this.options.copyVersion &&
      this.options.sameContent(this.options.content, other.options.content as Content)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    return this.options.render(this.options.content, view.state.facet(editorUiCopy));
  }
}

/**
 * Simple widgets can be built from a render function instead of a class. The
 * widget compares both its content and the copy version, and reads the facet
 * at `toDOM` time so a language switch replaces the DOM without rebuilding
 * EditorState/EditorView.
 */
export function localizeWidget<Content>(options: LocalizeWidgetOptions<Content>): WidgetType {
  return new LocalizedWidget(options);
}

/**
 * Small base class for class-based widgets. Subclasses keep their content eq
 * checks and add `sameCopy(other)` so a language switch replaces the DOM even
 * when the Markdown content is unchanged.
 */
export abstract class CopyAwareWidget extends WidgetType {
  protected constructor(readonly copy: EditorUiCopy) {
    super();
  }

  protected sameCopy(other: WidgetType): boolean {
    return other instanceof CopyAwareWidget && other.copy.version === this.copy.version;
  }
}
