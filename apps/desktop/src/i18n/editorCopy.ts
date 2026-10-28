import {
  EDITOR_COPY_SCHEMA_VERSION,
  type EditorUiCopy,
  type MermaidDiagramKind,
} from "@qingmo/editor-core";

import i18n from "./index";
import type { SupportedLanguage } from "./language";

const DIAGRAM_KIND_KEYS: Record<MermaidDiagramKind, string> = {
  flowchart: "diagramKinds.flowchart",
  sequence: "diagramKinds.sequence",
  class: "diagramKinds.class",
  state: "diagramKinds.state",
  er: "diagramKinds.er",
  gantt: "diagramKinds.gantt",
  pie: "diagramKinds.pie",
  quadrant: "diagramKinds.quadrant",
  mindmap: "diagramKinds.mindmap",
  git: "diagramKinds.git",
  c4: "diagramKinds.c4",
  journey: "diagramKinds.journey",
  timeline: "diagramKinds.timeline",
  requirement: "diagramKinds.requirement",
  sankey: "diagramKinds.sankey",
  xychart: "diagramKinds.xychart",
  block: "diagramKinds.block",
  packet: "diagramKinds.packet",
  architecture: "diagramKinds.architecture",
  kanban: "diagramKinds.kanban",
  radar: "diagramKinds.radar",
  treemap: "diagramKinds.treemap",
  ishikawa: "diagramKinds.ishikawa",
  wardley: "diagramKinds.wardley",
  zenuml: "diagramKinds.zenuml",
  info: "diagramKinds.info",
  unknown: "diagramKinds.unknown",
};

/**
 * Builds the editor-core projection for one language. editor-core only sees
 * this immutable value; it never imports i18next or the app's resources.
 */
export function buildEditorUiCopy(language: SupportedLanguage): EditorUiCopy {
  const t = i18n.getFixedT(language, "editor");

  const diagramKinds = Object.fromEntries(
    Object.entries(DIAGRAM_KIND_KEYS).map(([kind, key]) => [kind, t(key)]),
  ) as Record<MermaidDiagramKind, string>;

  return {
    version: `${language}:${EDITOR_COPY_SCHEMA_VERSION}`,
    language,
    widgets: {
      externalRender: t("widgets.externalRender"),
      externalRenderHint: (name) => t("widgets.externalRenderHint", { name }),
      attributes: t("widgets.attributes"),
      footnoteJump: t("widgets.footnoteJump"),
      inlineFootnote: (content) => t("widgets.inlineFootnote", { content }),
      inlineFootnoteLabel: (index) => t("widgets.inlineFootnoteLabel", { index }),
      abbreviation: t("widgets.abbreviation"),
      wikiEmbed: (target) => t("widgets.wikiEmbed", { target }),
      wikiLink: (target) => t("widgets.wikiLink", { target }),
      htmlAnchor: (label) => t("widgets.htmlAnchor", { label }),
      anchorJump: (href) => t("widgets.anchorJump", { href }),
      taskToggle: t("widgets.taskToggle"),
    },
    details: {
      summary: t("details.summary"),
      empty: t("details.empty"),
      tooLarge: t("details.tooLarge"),
      edit: t("details.edit"),
      editTitle: t("details.editTitle"),
      wrapperTitle: t("details.wrapperTitle"),
    },
    toc: {
      title: t("toc.title"),
      empty: t("toc.empty"),
      wrapperTitle: t("toc.wrapperTitle"),
    },
    frontmatter: {
      title: t("frontmatter.title"),
      wrapperTitle: t("frontmatter.wrapperTitle"),
      entries: (count) =>
        t(count === 1 ? "frontmatter.entriesOne" : "frontmatter.entriesOther", { count }),
      empty: t("frontmatter.empty"),
      more: (hidden) => t("frontmatter.more", { hidden }),
    },
    media: {
      video: t("media.video"),
      audio: t("media.audio"),
      gallery: t("media.gallery"),
      figure: t("media.figure"),
      image: t("media.image"),
      centeredImage: t("media.centeredImage"),
      embed: t("media.embed"),
      imageEmbedTitle: (target) => t("media.imageEmbedTitle", { target }),
      externalPage: t("media.externalPage"),
      externalBlocked: t("media.externalBlocked"),
      source: t("media.source"),
      editSource: t("media.editSource"),
    },
    mermaid: {
      edit: t("mermaid.edit"),
      editTitle: t("mermaid.editTitle"),
      zoomOut: t("mermaid.zoomOut"),
      zoomReset: t("mermaid.zoomReset"),
      zoomIn: t("mermaid.zoomIn"),
      fitWidth: t("mermaid.fitWidth"),
      fitTitle: t("mermaid.fitTitle"),
      source: t("mermaid.source"),
      sourceTitle: t("mermaid.sourceTitle"),
      hintEdit: t("mermaid.hintEdit"),
      hintScroll: t("mermaid.hintScroll"),
      renderFailed: t("mermaid.renderFailed"),
      unsafeSvg: t("mermaid.unsafeSvg"),
      invalidSvg: t("mermaid.invalidSvg"),
      unavailable: t("mermaid.unavailable"),
      readyTimeout: t("mermaid.readyTimeout"),
      renderTimeout: t("mermaid.renderTimeout"),
    },
    math: { editSource: t("math.editSource") },
    table: { editSource: t("table.editSource") },
    codeBlock: {
      language: t("codeBlock.language"),
      copy: t("codeBlock.copy"),
      copied: t("codeBlock.copied"),
      copyFailed: t("codeBlock.copyFailed"),
      more: t("codeBlock.more"),
      selectAll: t("codeBlock.selectAll"),
    },
    definitionList: { editSource: t("definitionList.editSource") },
    comments: {
      wrapperTitle: t("comments.wrapperTitle"),
      html: t("comments.html"),
      obsidian: t("comments.obsidian"),
      hiddenLines: (lines) =>
        t(lines === 1 ? "comments.hiddenLinesOne" : "comments.hiddenLinesOther", { lines }),
      source: t("comments.source"),
      editSource: t("comments.editSource"),
    },
    diagramKinds,
  };
}
