import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

import { codeLanguages } from "./languages";

/**
 * Markdown highlighting uses the app's semantic CSS variables instead of
 * hard-coded colours, so T-016's theme switch only has to change tokens and
 * never rebuild the editor view.
 */
export const qingmoHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--qm-ink)", fontWeight: "600" },
  { tag: tags.strong, color: "var(--qm-ink)", fontWeight: "600" },
  { tag: tags.emphasis, color: "var(--qm-ink)", fontStyle: "italic" },
  { tag: tags.link, color: "var(--qm-accent)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--qm-ink-faint)" },
  { tag: tags.monospace, color: "var(--qm-accent-strong)" },
  { tag: tags.quote, color: "var(--qm-ink-muted)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--qm-ink-muted)" },
  { tag: tags.comment, color: "var(--qm-ink-faint)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--qm-accent-strong)" },
  { tag: tags.string, color: "var(--qm-success)" },
  { tag: tags.number, color: "var(--qm-warning)" },
  { tag: tags.bool, color: "var(--qm-warning)" },
  { tag: tags.typeName, color: "var(--qm-accent)" },
  { tag: tags.function(tags.variableName), color: "var(--qm-accent-strong)" },
  { tag: tags.definition(tags.variableName), color: "var(--qm-ink)" },
  { tag: tags.propertyName, color: "var(--qm-accent)" },
  { tag: tags.operator, color: "var(--qm-ink-muted)" },
  { tag: tags.punctuation, color: "var(--qm-ink-faint)" },
  { tag: tags.invalid, color: "var(--qm-danger)" },
]);

/**
 * Language support only. Syntax highlighting is installed by the theme
 * compartment so a theme switch replaces both together.
 */
export const markdownExtensions: readonly Extension[] = Object.freeze([
  markdown({
    base: markdownLanguage,
    codeLanguages: [...codeLanguages],
  }),
]);
