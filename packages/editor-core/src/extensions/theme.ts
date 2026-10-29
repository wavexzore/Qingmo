import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { qingmoHighlightStyle } from "./markdown";

export type EditorTheme = "light" | "dark";

/**
 * Shared by text lines and block widgets so both start on the same writing
 * column. Line numbers hang outside of it, in the page's left inset.
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
    // The page inset lives on the content, not on the host wrapper, so the
    // scroller (and its vertical scrollbar) can span the whole window width.
    padding: `28px ${WRITING_INSET_PX}px`,
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
    backgroundColor: "transparent",
    color: "var(--qm-ink)",
    fontFamily: "var(--qm-font-sans)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "none",
  },
  ".cm-panel input, .cm-panel button": {
    fontFamily: "var(--qm-font-sans)",
  },
  ".qm-search-panel": {
    padding: "12px 16px 6px",
  },
  ".qm-search-card": {
    display: "flex",
    flexDirection: "column",
    width: "min(720px, 100%)",
    margin: "0 auto",
    overflow: "hidden",
    border: "1px solid var(--qm-line)",
    borderRadius: "var(--qm-radius-md)",
    backgroundColor: "var(--qm-surface)",
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.06)",
    transition:
      "border-color var(--qm-duration-fast) var(--qm-ease-out), box-shadow var(--qm-duration-fast) var(--qm-ease-out)",
  },
  ".qm-search-card:focus-within": {
    borderColor: "color-mix(in srgb, var(--qm-accent) 36%, var(--qm-line))",
    boxShadow: "0 14px 34px rgba(0, 0, 0, 0.14), 0 0 0 2px var(--qm-accent-soft)",
  },
  ".qm-search-row": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minHeight: "40px",
    padding: "0 8px 0 10px",
  },
  ".qm-search-row-find": {
    backgroundColor: "var(--qm-surface-raised)",
  },
  ".qm-search-row-replace": {
    minHeight: "38px",
    borderTop: "1px solid var(--qm-line)",
    backgroundColor: "var(--qm-surface)",
  },
  ".qm-search-row[hidden]": {
    display: "none",
  },
  ".qm-search-glyph": {
    display: "inline-flex",
    flex: "0 0 auto",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    color: "var(--qm-accent)",
  },
  ".qm-search-glyph-replace": {
    color: "var(--qm-ink-faint)",
  },
  ".qm-search-glyph svg": {
    display: "block",
    width: "15px",
    height: "15px",
  },
  ".qm-search-input": {
    flex: "1 1 auto",
    minWidth: "0",
    padding: "5px 0",
    border: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: "var(--qm-ink)",
    caretColor: "var(--qm-accent)",
    fontFamily: "var(--qm-font-sans)",
    fontSize: "13px",
    lineHeight: "1.5",
  },
  ".qm-search-input:focus-visible": {
    outline: "none",
  },
  ".qm-search-input::placeholder": {
    color: "var(--qm-ink-faint)",
  },
  ".qm-search-options": {
    display: "flex",
    flex: "0 0 auto",
    alignItems: "center",
    gap: "2px",
  },
  ".qm-search-toggle": {
    minWidth: "26px",
    height: "24px",
    padding: "0 6px",
    border: "1px solid transparent",
    borderRadius: "5px",
    backgroundColor: "transparent",
    color: "var(--qm-ink-faint)",
    cursor: "pointer",
    fontFamily: "var(--qm-font-mono)",
    fontSize: "10px",
    letterSpacing: "0.02em",
    lineHeight: "1",
    whiteSpace: "nowrap",
    transition:
      "background-color var(--qm-duration-fast) var(--qm-ease-out), color var(--qm-duration-fast) var(--qm-ease-out)",
  },
  ".qm-search-toggle:hover": {
    backgroundColor: "var(--qm-surface-muted)",
    color: "var(--qm-ink-muted)",
  },
  '.qm-search-toggle[aria-pressed="true"]': {
    borderColor: "var(--qm-line)",
    backgroundColor: "var(--qm-accent-soft)",
    color: "var(--qm-accent-strong)",
  },
  ".qm-search-toggle:focus-visible, .qm-search-select:focus-visible": {
    outline: "1px solid var(--qm-accent)",
    outlineOffset: "0",
  },
  ".qm-search-toggle-word": {
    textDecoration: "underline",
    textDecorationThickness: "1px",
    textUnderlineOffset: "2px",
  },
  ".qm-search-select": {
    height: "24px",
    padding: "0 5px",
    border: "none",
    borderRadius: "5px",
    backgroundColor: "transparent",
    color: "var(--qm-ink-faint)",
    cursor: "pointer",
    fontFamily: "var(--qm-font-sans)",
    fontSize: "10.5px",
    lineHeight: "1",
    whiteSpace: "nowrap",
    transition:
      "background-color var(--qm-duration-fast) var(--qm-ease-out), color var(--qm-duration-fast) var(--qm-ease-out)",
  },
  ".qm-search-select:hover": {
    backgroundColor: "var(--qm-surface-muted)",
    color: "var(--qm-accent-strong)",
  },
  ".qm-search-divider": {
    flex: "0 0 auto",
    width: "1px",
    height: "16px",
    margin: "0 2px",
    backgroundColor: "var(--qm-line)",
  },
  ".qm-search-icon-button": {
    display: "inline-flex",
    flex: "0 0 auto",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    padding: "0",
    border: "none",
    borderRadius: "5px",
    backgroundColor: "transparent",
    color: "var(--qm-ink-faint)",
    cursor: "pointer",
    transition:
      "background-color var(--qm-duration-fast) var(--qm-ease-out), color var(--qm-duration-fast) var(--qm-ease-out)",
  },
  ".qm-search-icon-button:hover": {
    backgroundColor: "var(--qm-surface-muted)",
    color: "var(--qm-ink)",
  },
  ".qm-search-icon-button:focus-visible": {
    outline: "1px solid var(--qm-accent)",
    outlineOffset: "0",
  },
  ".qm-search-icon-button svg": {
    display: "block",
    width: "14px",
    height: "14px",
  },
  ".qm-search-close:hover": {
    backgroundColor: "color-mix(in srgb, var(--qm-danger) 10%, transparent)",
    color: "var(--qm-danger)",
  },
  ".qm-search-actions": {
    display: "flex",
    flex: "0 0 auto",
    alignItems: "center",
    gap: "4px",
  },
  ".qm-search-action": {
    height: "26px",
    padding: "0 10px",
    border: "1px solid var(--qm-line)",
    borderRadius: "5px",
    backgroundColor: "transparent",
    color: "var(--qm-ink-muted)",
    cursor: "pointer",
    fontFamily: "var(--qm-font-sans)",
    fontSize: "11.5px",
    lineHeight: "1",
    whiteSpace: "nowrap",
    transition:
      "background-color var(--qm-duration-fast) var(--qm-ease-out), border-color var(--qm-duration-fast) var(--qm-ease-out), color var(--qm-duration-fast) var(--qm-ease-out)",
  },
  ".qm-search-action:hover": {
    borderColor: "var(--qm-line-strong)",
    backgroundColor: "var(--qm-surface-muted)",
    color: "var(--qm-ink)",
  },
  ".qm-search-action:focus-visible": {
    outline: "1px solid var(--qm-accent)",
    outlineOffset: "1px",
  },
  ".qm-search-action-primary": {
    borderColor: "transparent",
    backgroundColor: "var(--qm-accent-soft)",
    color: "var(--qm-accent-strong)",
    fontWeight: "600",
  },
  ".qm-search-action-primary:hover": {
    borderColor: "transparent",
    backgroundColor: "color-mix(in srgb, var(--qm-accent) 18%, transparent)",
    color: "var(--qm-accent-strong)",
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
