import { EditorView } from "@codemirror/view";

/**
 * The base editor chrome. Colours are semantic CSS variables (already
 * `light-dark()` aware), so the T-016 theme switch reconfigures tokens rather
 * than rebuilding the view or duplicating a second palette here.
 */
export const qingmoEditorTheme = EditorView.theme(
  {
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
  },
  { dark: false },
);
