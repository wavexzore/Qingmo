import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { qingmoHighlightStyle } from "./markdown";

export type EditorTheme = "light" | "dark";

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
    padding: "0 28px",
  },
  ".cm-placeholder": {
    color: "var(--qm-ink-faint)",
    fontFamily: "var(--qm-font-sans)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--qm-ink-faint)",
    border: "none",
    paddingLeft: "12px",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--qm-accent-soft)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--qm-accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--qm-accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--qm-accent-soft)",
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
