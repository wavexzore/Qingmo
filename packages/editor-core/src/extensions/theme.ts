import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { qingmoHighlightStyle } from "./markdown";

export type EditorTheme = "light" | "dark";

/**
 * Shared by text lines and block widgets so both start on the same writing
 * column. Line numbers hang outside of it, in the window's page gutter.
 */
const WRITING_INSET_PX = 20;

/**
 * The single source for editor chrome and syntax-highlight colours. Every
 * value is a semantic CSS variable, so the light and dark variants differ only
 * in CodeMirror's built-in dark marker; the palette itself is never duplicated
 * in JavaScript.
 */
const editorThemeSpec = {
  "&": {
    height: "100%",
    color: "var(--qm-ink)",
    backgroundColor: "transparent",
    fontSize: "15px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--qm-font-mono)",
    lineHeight: "1.75",
  },
  ".cm-content": {
    padding: "28px 0",
    caretColor: "var(--qm-accent)",
  },
  ".cm-line": {
    // Symmetric inset keeps the text column centred and fixed when the mode
    // changes; the line numbers hang outside of it.
    padding: `0 ${WRITING_INSET_PX}px`,
  },
  // Block widgets (Mermaid, math, tables, Front Matter…) are children of
  // `.cm-content`, not of a line, so they miss the line padding above. Give
  // them the same inline inset or the cards bleed into the gutter.
  ".cm-content > :not(.cm-line)": {
    marginInline: `${WRITING_INSET_PX}px`,
  },
  ".cm-placeholder": {
    color: "var(--qm-ink-faint)",
    fontFamily: "var(--qm-font-sans)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--qm-ink-faint)",
    border: "none",
    paddingLeft: "0",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--qm-accent-soft)",
  },
  ".cm-activeLine.cm-selectedLine": {
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--qm-accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--qm-accent)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "var(--qm-accent-soft) !important",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--qm-accent) !important",
  },
  "&.cm-focused .cm-selectedText, &.cm-focused .cm-selectedText *": {
    color: "var(--qm-surface) !important",
  },
  ".cm-selectionMatch": {
    backgroundColor: "var(--qm-accent-soft)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--qm-accent-soft)",
    outline: "1px solid var(--qm-accent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--qm-accent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--qm-surface)",
    color: "var(--qm-ink)",
    fontFamily: "var(--qm-font-sans)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--qm-line)",
  },
  ".cm-panel input, .cm-panel button": {
    fontFamily: "var(--qm-font-sans)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--qm-surface-raised)",
    color: "var(--qm-ink)",
    border: "1px solid var(--qm-line)",
    borderRadius: "var(--qm-radius-sm)",
  },
};

/**
 * Reconfigurable editor theme. The syntax highlight style travels with it so
 * the theme compartment owns every colour-bearing extension and a theme switch
 * cannot leave stale highlighting behind. Caching both variants avoids
 * generating a new style module on every switch/reload.
 */
const themeExtensions: Record<EditorTheme, Extension> = {
  light: [
    EditorView.theme(editorThemeSpec, { dark: false }),
    syntaxHighlighting(qingmoHighlightStyle),
  ],
  dark: [
    EditorView.theme(editorThemeSpec, { dark: true }),
    syntaxHighlighting(qingmoHighlightStyle),
  ],
};

export function themeExtension(theme: EditorTheme): Extension {
  return themeExtensions[theme];
}

/** Initial light theme; the app-level theme service applies dark when needed. */
export const qingmoEditorTheme = themeExtension("light");
