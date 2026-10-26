import { EditorView } from "@codemirror/view";

/**
 * Lean Live Preview styling. All values come from the app's semantic tokens;
 * nothing here is a second palette, and no selector escapes `.cm-editor`.
 */
export const livePreviewTheme = EditorView.theme(
  {
    ".cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6": {
      color: "var(--qm-ink)",
      fontWeight: "650",
      lineHeight: "1.45",
    },
    ".cm-md-h1": { fontSize: "1.6em" },
    ".cm-md-h2": { fontSize: "1.4em" },
    ".cm-md-h3": { fontSize: "1.24em" },
    ".cm-md-h4": { fontSize: "1.12em" },
    ".cm-md-h5": { fontSize: "1.04em" },
    ".cm-md-h6": { fontSize: "0.98em", color: "var(--qm-ink-muted)" },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-em": { fontStyle: "italic" },
    ".cm-md-inline-code": {
      padding: "0.05em 0.28em",
      borderRadius: "3px",
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-accent-strong)",
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-link": {
      color: "var(--qm-accent)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
    ".cm-md-quote": {
      color: "var(--qm-ink-muted)",
      fontStyle: "italic",
      boxShadow: "inset 2px 0 0 var(--qm-line-strong)",
    },
    ".cm-md-code-block": {
      backgroundColor: "var(--qm-surface-muted)",
      fontFamily: "var(--qm-font-mono)",
    },
  },
  { dark: false },
);
