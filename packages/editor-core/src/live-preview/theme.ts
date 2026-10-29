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
    ".cm-md-strike": {
      textDecoration: "line-through",
      color: "var(--qm-ink-muted)",
    },
    ".cm-md-highlight": {
      backgroundColor: "var(--qm-highlight)",
      borderRadius: "2px",
    },
    ".cm-md-sub": {
      fontSize: "0.78em",
      lineHeight: "0",
      verticalAlign: "sub",
    },
    ".cm-md-sup": {
      fontSize: "0.78em",
      lineHeight: "0",
      verticalAlign: "super",
    },
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
    ".cm-md-alert": {
      backgroundColor: "var(--qm-surface-muted)",
      boxShadow: "inset 3px 0 0 var(--qm-accent)",
      fontStyle: "normal",
    },
    ".cm-md-quote.cm-md-alert": { fontStyle: "normal" },
    ".cm-md-alert-note": { boxShadow: "inset 3px 0 0 var(--qm-accent)" },
    ".cm-md-alert-tip": { boxShadow: "inset 3px 0 0 var(--qm-success)" },
    ".cm-md-alert-important": { boxShadow: "inset 3px 0 0 var(--qm-accent-strong)" },
    ".cm-md-alert-warning": { boxShadow: "inset 3px 0 0 var(--qm-warning)" },
    ".cm-md-alert-caution": { boxShadow: "inset 3px 0 0 var(--qm-danger)" },
    ".cm-md-alert-label": {
      display: "inline-block",
      marginRight: "0.35em",
      padding: "0 0.35em",
      borderRadius: "3px",
      backgroundColor: "var(--qm-surface)",
      color: "var(--qm-ink-muted)",
      fontSize: "0.72em",
      fontWeight: "700",
      letterSpacing: "0.04em",
      verticalAlign: "middle",
    },
    ".cm-md-emoji": {
      fontFamily:
        "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif",
    },
    ".cm-md-footnote-ref": {
      color: "var(--qm-accent)",
      fontSize: "0.75em",
      verticalAlign: "super",
    },
    ".cm-md-footnote-jump": {
      cursor: "pointer",
      textDecoration: "underline",
      textDecorationStyle: "dotted",
      textUnderlineOffset: "0.15em",
    },
    ".cm-md-footnote-jump:hover": {
      color: "var(--qm-accent-strong)",
      backgroundColor: "var(--qm-accent-soft)",
    },
    ".cm-md-footnote-inline": {
      color: "var(--qm-accent)",
      fontSize: "0.72em",
      verticalAlign: "super",
      cursor: "help",
      borderBottom: "1px dotted var(--qm-accent-soft)",
    },
    ".cm-md-footnote-inline:hover": {
      backgroundColor: "var(--qm-accent-soft)",
      borderBottomColor: "var(--qm-accent)",
    },
    ".cm-md-footnote-def": {
      color: "var(--qm-ink-muted)",
      fontSize: "0.92em",
    },
    ".cm-md-footnote-def-label": {
      marginRight: "0.3em",
      color: "var(--qm-accent)",
    },
    ".cm-md-kbd": {
      padding: "0.05em 0.3em",
      border: "1px solid var(--qm-line-strong)",
      borderRadius: "3px",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.9em",
    },
    ".cm-md-math-inline": {
      padding: "0 0.08em",
    },
    ".cm-md-math-block": {
      // Outer spacing belongs to the measured root (padding); the visual card
      // sits inside so margins cannot desynchronise the height map.
      padding: "0.6em 0",
      contain: "inline-size",
      cursor: "text",
    },
    ".cm-md-math-block-card": {
      padding: "0.5em 0.75em",
      overflowX: "auto",
      backgroundColor: "var(--qm-surface-muted)",
      borderRadius: "6px",
    },
    ".cm-md-math-block-render": {
      display: "flex",
      justifyContent: "center",
    },
    ".cm-md-mermaid": {
      // CodeMirror ignores block-widget margins when measuring, so the outer
      // rhythm is padding and the bordered card is an inner element.
      padding: "0.75em 0",
      contain: "inline-size",
      cursor: "default",
      outline: "none",
    },
    ".cm-md-mermaid-card": {
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-md)",
      backgroundColor: "var(--qm-surface)",
      overflow: "hidden",
      transition: "border-color var(--qm-duration-fast) var(--qm-ease-out)",
    },
    ".cm-md-mermaid:hover .cm-md-mermaid-card, .cm-md-mermaid:focus-visible .cm-md-mermaid-card": {
      borderColor: "var(--qm-line-strong)",
    },
    ".cm-md-mermaid:focus-visible .cm-md-mermaid-card": {
      boxShadow: "0 0 0 1px var(--qm-accent-soft)",
    },
    ".cm-md-mermaid-head": {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      minHeight: "34px",
      padding: "0 10px 0 12px",
      borderBottom: "1px solid var(--qm-line)",
      backgroundColor: "var(--qm-surface-raised)",
      color: "var(--qm-ink-muted)",
      userSelect: "none",
    },
    ".cm-md-mermaid-title": {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      minWidth: "0",
    },
    ".cm-md-mermaid-icon": {
      width: "9px",
      height: "9px",
      flex: "0 0 auto",
      border: "1px solid var(--qm-accent)",
      borderRadius: "1px",
      boxShadow: "inset 0 0 0 1px var(--qm-accent-soft)",
      transform: "rotate(45deg)",
    },
    ".cm-md-mermaid-badge": {
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "8.5px",
      letterSpacing: "0.16em",
      whiteSpace: "nowrap",
    },
    ".cm-md-mermaid-sep": {
      color: "var(--qm-ink-faint)",
      fontSize: "9.5px",
    },
    ".cm-md-mermaid-kind": {
      overflow: "hidden",
      color: "var(--qm-ink-muted)",
      fontSize: "9.5px",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-md-mermaid-head.is-error .cm-md-mermaid-kind": {
      color: "var(--qm-danger)",
    },
    ".cm-md-mermaid-actions": {
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      minWidth: "54px",
      minHeight: "24px",
      marginLeft: "auto",
    },
    ".cm-md-mermaid-hint": {
      color: "var(--qm-ink-faint)",
      fontSize: "9.5px",
      whiteSpace: "nowrap",
      transition: "opacity var(--qm-duration-fast) var(--qm-ease-out)",
    },
    ".cm-md-mermaid-tools": {
      position: "absolute",
      top: "50%",
      right: "0",
      display: "flex",
      alignItems: "center",
      gap: "2px",
      opacity: "0",
      pointerEvents: "none",
      transform: "translateY(-50%)",
      visibility: "hidden",
      transition:
        "opacity var(--qm-duration-fast) var(--qm-ease-out), visibility var(--qm-duration-fast) var(--qm-ease-out)",
    },
    ".cm-md-mermaid:hover .cm-md-mermaid-hint, .cm-md-mermaid:focus-within .cm-md-mermaid-hint": {
      opacity: "0",
    },
    ".cm-md-mermaid:hover .cm-md-mermaid-tools, .cm-md-mermaid:focus-within .cm-md-mermaid-tools": {
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
    },
    ".cm-md-mermaid-tool": {
      display: "inline-flex",
      flex: "0 0 auto",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "22px",
      height: "22px",
      padding: "0 5px",
      border: "0",
      borderRadius: "4px",
      backgroundColor: "transparent",
      color: "var(--qm-ink-muted)",
      cursor: "pointer",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "9.5px",
      lineHeight: "1",
      whiteSpace: "nowrap",
    },
    ".cm-md-mermaid-tool:hover": {
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-ink)",
    },
    ".cm-md-mermaid-tool.is-active": {
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-ink)",
    },
    ".cm-md-mermaid-tool[hidden]": {
      display: "none",
    },
    ".cm-md-mermaid-tool:disabled": {
      cursor: "default",
      opacity: "0.35",
    },
    ".cm-md-mermaid-tool:focus-visible": {
      outline: "1px solid var(--qm-accent)",
      outlineOffset: "0",
    },
    ".cm-md-mermaid-canvas": {
      padding: "22px 26px",
      overflowX: "auto",
      overflowY: "hidden",
      backgroundColor: "var(--qm-surface)",
      transition: "opacity var(--qm-duration-base) var(--qm-ease-out)",
    },
    ".cm-md-mermaid-canvas.is-refreshing": {
      opacity: "0.55",
    },
    ".cm-md-mermaid-figure": {
      display: "flex",
      justifyContent: "center",
      width: "100%",
      minWidth: "100%",
    },
    ".cm-md-mermaid-figure.is-zoomed": {
      width: "max-content",
    },
    ".cm-md-mermaid-figure svg": {
      display: "block",
      maxWidth: "none",
      height: "auto",
    },
    ".cm-md-mermaid-figure.is-zoomed svg": {
      maxWidth: "none",
    },
    ".cm-md-mermaid-skeleton": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "10px",
      width: "100%",
      minHeight: "132px",
    },
    ".cm-md-mermaid-skeleton-node": {
      width: "64px",
      height: "32px",
      border: "1px dashed var(--qm-line-strong)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-raised)",
      animation: "qm-mermaid-pulse 1.6s var(--qm-ease-out) infinite",
    },
    ".cm-md-mermaid-skeleton-link": {
      width: "28px",
      height: "1px",
      backgroundColor: "var(--qm-line-strong)",
    },
    ".cm-md-mermaid-error": {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "10px",
      width: "100%",
      minHeight: "88px",
      padding: "6px 0",
      color: "var(--qm-danger)",
      textAlign: "center",
    },
    ".cm-md-mermaid-error-message": {
      maxWidth: "100%",
      overflowWrap: "anywhere",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "11px",
      lineHeight: "1.5",
      whiteSpace: "pre-wrap",
    },
    ".cm-md-mermaid-edit": {
      height: "24px",
      padding: "0 10px",
      border: "1px solid var(--qm-line-strong)",
      backgroundColor: "var(--qm-surface-raised)",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-sans)",
    },
    ".cm-md-mermaid-edit:hover": {
      borderColor: "var(--qm-accent)",
      backgroundColor: "var(--qm-accent-soft)",
      color: "var(--qm-accent-strong)",
    },
    "@keyframes qm-mermaid-pulse": {
      "0%, 100%": { opacity: "0.55" },
      "50%": { opacity: "1" },
    },
    ".cm-md-frontmatter-widget": {
      // Padding keeps the block's spacing inside its measured height.
      padding: "0.6em 0",
    },
    ".cm-md-frontmatter": {
      padding: "0.55em 0.75em",
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-muted)",
      cursor: "text",
    },
    ".cm-md-frontmatter-header": {
      display: "flex",
      alignItems: "center",
      gap: "0.45em",
      marginBottom: "0.4em",
    },
    ".cm-md-frontmatter-title": {
      fontSize: "0.82em",
      fontWeight: "700",
      letterSpacing: "0.02em",
    },
    ".cm-md-frontmatter-badge": {
      padding: "0.05em 0.35em",
      borderRadius: "3px",
      backgroundColor: "var(--qm-accent-soft)",
      color: "var(--qm-accent-strong)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.65em",
      fontWeight: "700",
    },
    ".cm-md-frontmatter-count": {
      marginLeft: "auto",
      color: "var(--qm-ink-faint)",
      fontSize: "0.7em",
    },
    ".cm-md-frontmatter-grid": {
      display: "grid",
      gridTemplateColumns: "minmax(5em, 11em) minmax(0, 1fr)",
      gap: "0.2em 0.75em",
      maxHeight: "16em",
      overflow: "auto",
    },
    ".cm-md-frontmatter-row": {
      display: "contents",
    },
    ".cm-md-frontmatter-key": {
      overflowWrap: "anywhere",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.76em",
    },
    ".cm-md-frontmatter-value": {
      overflowWrap: "anywhere",
      fontSize: "0.82em",
    },
    ".cm-md-frontmatter-raw": {
      margin: "0",
      overflowX: "auto",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.76em",
      whiteSpace: "pre-wrap",
    },
    ".cm-md-frontmatter-empty, .cm-md-frontmatter-more": {
      color: "var(--qm-ink-faint)",
      fontSize: "0.75em",
    },
    ".cm-md-frontmatter-more": {
      marginTop: "0.35em",
    },
    ".cm-md-toc": {
      // The nav is the measured block root, so its rhythm is padding.
      padding: "0.5em 0",
    },
    ".cm-md-toc-card": {
      padding: "0.55em 0.75em",
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-muted)",
    },
    ".cm-md-toc-title": {
      marginBottom: "0.3em",
      color: "var(--qm-ink-muted)",
      fontSize: "0.72em",
      fontWeight: "700",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
    ".cm-md-toc-list": {
      margin: "0",
      padding: "0",
      listStyle: "none",
      maxHeight: "22em",
      overflow: "auto",
    },
    ".cm-md-toc-entry": {
      margin: "0",
      padding: "0",
    },
    ".cm-md-toc-item": {
      display: "block",
      width: "100%",
      padding: "0.18em 0.3em",
      border: "none",
      borderRadius: "3px",
      backgroundColor: "transparent",
      color: "var(--qm-ink)",
      font: "inherit",
      fontSize: "0.86em",
      lineHeight: "1.35",
      textAlign: "left",
      cursor: "pointer",
    },
    ".cm-md-toc-item:hover": {
      backgroundColor: "var(--qm-accent-soft)",
      color: "var(--qm-accent-strong)",
    },
    ".cm-md-toc-empty": {
      color: "var(--qm-ink-faint)",
      fontSize: "0.78em",
    },
    ".cm-md-definition-list": {
      // Padding, not margin: CodeMirror's block-widget height map ignores
      // margins and would let clicks below the block land on the next line.
      padding: "0.5em 0",
    },
    ".cm-md-definition-item": {
      display: "grid",
      gridTemplateColumns: "minmax(5em, max-content) minmax(0, 1fr)",
      columnGap: "0.9em",
      padding: "0.12em 0",
    },
    ".cm-md-definition-term": {
      gridColumn: "1",
      color: "var(--qm-ink)",
      fontWeight: "600",
    },
    ".cm-md-definition-desc": {
      gridColumn: "2",
      margin: "0",
      color: "var(--qm-ink-muted)",
    },
    ".cm-md-definition-desc + .cm-md-definition-desc": {
      marginTop: "0.15em",
    },
    ".cm-md-abbr": {
      textDecoration: "underline dotted",
      textUnderlineOffset: "0.18em",
      cursor: "help",
    },
    ".cm-md-abbr-def": {
      display: "inline-flex",
      alignItems: "baseline",
      gap: "0.4em",
      padding: "0.05em 0.4em",
      border: "1px solid var(--qm-line)",
      borderRadius: "3px",
      backgroundColor: "var(--qm-surface-muted)",
      fontSize: "0.82em",
      lineHeight: "1.4",
    },
    ".cm-md-abbr-def-badge": {
      color: "var(--qm-ink-faint)",
      fontSize: "0.76em",
      letterSpacing: "0.04em",
    },
    ".cm-md-abbr-def-term": {
      color: "var(--qm-accent-strong)",
      fontFamily: "var(--qm-font-mono)",
      fontWeight: "600",
    },
    ".cm-md-abbr-def-value": {
      color: "var(--qm-ink-muted)",
    },
    ".cm-md-wiki-link": {
      display: "inline-flex",
      alignItems: "baseline",
      gap: "0.22em",
      padding: "0 0.25em",
      borderBottom: "1px solid var(--qm-accent-soft)",
      borderRadius: "2px",
      color: "var(--qm-accent-strong)",
      cursor: "pointer",
    },
    ".cm-md-wiki-link:hover": {
      backgroundColor: "var(--qm-accent-soft)",
    },
    ".cm-md-wiki-embed": {
      borderBottomStyle: "dotted",
      color: "var(--qm-ink-muted)",
    },
    ".cm-md-wiki-icon": {
      color: "var(--qm-accent)",
      fontSize: "0.82em",
    },
    ".cm-md-wiki-label": {
      overflowWrap: "anywhere",
    },
    ".cm-md-anchor-link": {
      color: "var(--qm-accent-strong)",
      textDecoration: "underline",
      textDecorationColor: "var(--qm-accent-soft)",
      textUnderlineOffset: "0.18em",
      cursor: "pointer",
    },
    ".cm-md-anchor-link:hover": {
      backgroundColor: "var(--qm-accent-soft)",
      textDecorationColor: "var(--qm-accent)",
    },
    ".cm-md-html-anchor": {
      display: "inline-flex",
      alignItems: "baseline",
      gap: "0.35em",
      padding: "0.05em 0.4em",
      border: "1px dashed var(--qm-line-strong)",
      borderRadius: "var(--qm-radius-sm)",
      color: "var(--qm-ink-faint)",
      fontSize: "0.78em",
    },
    ".cm-md-html-anchor-icon": {
      color: "var(--qm-accent)",
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-details-widget": {
      // Padding keeps the block's rhythm inside its measured height.
      padding: "0.6em 0",
    },
    ".cm-md-details": {
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-muted)",
      overflow: "hidden",
      contain: "inline-size",
    },
    ".cm-md-details-header": {
      display: "flex",
      alignItems: "center",
      gap: "0.5em",
      padding: "0.35em 0.6em",
      backgroundColor: "var(--qm-surface-raised)",
    },
    ".cm-md-details[data-open='true'] .cm-md-details-header": {
      borderBottom: "1px solid var(--qm-line)",
    },
    ".cm-md-details-summary": {
      display: "inline-flex",
      flex: "1",
      alignItems: "center",
      gap: "0.45em",
      padding: "0.1em 0",
      border: "none",
      backgroundColor: "transparent",
      color: "var(--qm-ink)",
      font: "inherit",
      fontWeight: "600",
      fontSize: "0.9em",
      textAlign: "left",
      cursor: "pointer",
    },
    ".cm-md-details-icon": {
      width: "1em",
      color: "var(--qm-accent)",
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-details-edit": {
      padding: "0.1em 0.4em",
      border: "1px solid var(--qm-line)",
      borderRadius: "3px",
      backgroundColor: "transparent",
      color: "var(--qm-ink-faint)",
      fontSize: "0.68em",
      cursor: "pointer",
    },
    ".cm-md-details-edit:hover": {
      borderColor: "var(--qm-accent)",
      color: "var(--qm-accent)",
    },
    ".cm-md-details-content": {
      maxHeight: "32em",
      padding: "0.2em 0.75em 0.5em",
      overflow: "auto",
      fontSize: "0.9em",
    },
    ".cm-md-details-content p": {
      margin: "0.35em 0",
    },
    ".cm-md-details-plain": {
      margin: "0.35em 0",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
    ".cm-md-details-nested": {
      margin: "0.45em 0",
      backgroundColor: "var(--qm-surface)",
    },
    ".cm-md-details-content h1, .cm-md-details-content h2, .cm-md-details-content h3, .cm-md-details-content h4, .cm-md-details-content h5, .cm-md-details-content h6":
      {
        margin: "0.55em 0 0.25em",
        lineHeight: "1.3",
      },
    ".cm-md-details-code": {
      position: "relative",
      margin: "0.4em 0",
    },
    ".cm-md-details-code pre": {
      margin: "0",
      padding: "0.5em 0.65em",
      overflowX: "auto",
      backgroundColor: "var(--qm-surface)",
      borderRadius: "4px",
    },
    ".cm-md-details-code code": {
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.82em",
    },
    ".cm-md-details-code-lang": {
      position: "absolute",
      top: "0.2em",
      right: "0.4em",
      color: "var(--qm-ink-faint)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.62em",
    },
    ".cm-md-details-list": {
      margin: "0.3em 0",
      paddingLeft: "1.3em",
    },
    ".cm-md-details-li-text": {
      margin: "0.1em 0",
    },
    ".cm-md-details-quote": {
      margin: "0.3em 0",
      paddingLeft: "0.6em",
      borderLeft: "2px solid var(--qm-line-strong)",
      color: "var(--qm-ink-muted)",
    },
    ".cm-md-details-table": {
      margin: "0.4em 0",
      borderCollapse: "collapse",
      fontSize: "0.85em",
    },
    ".cm-md-details-table th, .cm-md-details-table td": {
      padding: "0.2em 0.5em",
      border: "1px solid var(--qm-line)",
    },
    ".cm-md-details-table th": {
      backgroundColor: "var(--qm-surface-raised)",
      fontWeight: "600",
    },
    ".cm-md-details-html": {
      margin: "0.4em 0",
      padding: "0.4em 0.6em",
      overflowX: "auto",
      backgroundColor: "var(--qm-surface)",
      borderRadius: "4px",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.76em",
      whiteSpace: "pre-wrap",
    },
    ".cm-md-details-empty": {
      padding: "0.3em 0",
      color: "var(--qm-ink-faint)",
      fontSize: "0.8em",
    },
    ".cm-md-media": {
      // Outer rhythm lives in padding so it is part of the measured height.
      padding: "0.6em 0",
      contain: "inline-size",
    },
    ".cm-md-media-card": {
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-muted)",
      overflow: "hidden",
    },
    ".cm-md-media-header": {
      display: "flex",
      alignItems: "center",
      gap: "0.5em",
      padding: "0.35em 0.6em",
      backgroundColor: "var(--qm-surface-raised)",
    },
    ".cm-md-media-badge": {
      padding: "0.05em 0.35em",
      borderRadius: "3px",
      backgroundColor: "var(--qm-accent-soft)",
      color: "var(--qm-accent-strong)",
      fontSize: "0.66em",
      fontWeight: "700",
      letterSpacing: "0.04em",
    },
    ".cm-md-media-name": {
      flex: "1",
      overflow: "hidden",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.75em",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-md-media-edit": {
      padding: "0.1em 0.4em",
      border: "1px solid var(--qm-line)",
      borderRadius: "3px",
      backgroundColor: "transparent",
      color: "var(--qm-ink-faint)",
      fontSize: "0.68em",
      cursor: "pointer",
    },
    ".cm-md-media-edit:hover": {
      borderColor: "var(--qm-accent)",
      color: "var(--qm-accent)",
    },
    ".cm-md-media-body": {
      display: "flex",
      justifyContent: "center",
      padding: "0.45em 0.6em",
    },
    ".cm-md-media-element": {
      maxWidth: "100%",
      maxHeight: "26em",
      borderRadius: "3px",
      backgroundColor: "#000",
    },
    ".cm-md-media-audio .cm-md-media-body": {
      justifyContent: "stretch",
    },
    ".cm-md-media-audio .cm-md-media-element": {
      width: "100%",
      backgroundColor: "transparent",
    },
    ".cm-md-media-image": {
      maxWidth: "100%",
      maxHeight: "26em",
      objectFit: "contain",
    },
    ".cm-md-figure": {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "0.35em",
      margin: "0",
    },
    ".cm-md-figure figcaption": {
      color: "var(--qm-ink-muted)",
      fontSize: "0.82em",
      textAlign: "center",
    },
    ".cm-md-center-image": {
      display: "flex",
      justifyContent: "center",
      width: "100%",
    },
    ".cm-md-media-fallback": {
      display: "flex",
      alignItems: "center",
      gap: "0.4em",
      padding: "0.5em 0.2em",
      color: "var(--qm-ink-muted)",
      fontSize: "0.82em",
    },
    ".cm-md-media-fallback[hidden]": {
      display: "none",
    },
    ".cm-md-media-fallback-icon": {
      color: "var(--qm-accent)",
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-comment-widget": {
      // Padding keeps the block's rhythm inside its measured height.
      padding: "0.35em 0",
    },
    ".cm-md-comment": {
      display: "flex",
      alignItems: "center",
      gap: "0.45em",
      padding: "0.28em 0.55em",
      border: "1px dashed var(--qm-line-strong)",
      borderRadius: "var(--qm-radius-sm)",
      color: "var(--qm-ink-faint)",
      fontSize: "0.78em",
    },
    ".cm-md-comment-icon": {
      color: "var(--qm-accent)",
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-comment-badge": {
      color: "var(--qm-ink-muted)",
      fontWeight: "600",
    },
    ".cm-md-comment-meta": {
      flex: "1",
      fontSize: "0.9em",
    },
    ".cm-md-comment-edit": {
      padding: "0.05em 0.35em",
      border: "1px solid var(--qm-line)",
      borderRadius: "3px",
      backgroundColor: "transparent",
      color: "var(--qm-ink-faint)",
      fontSize: "0.85em",
      cursor: "pointer",
    },
    ".cm-md-comment-edit:hover": {
      borderColor: "var(--qm-accent)",
      color: "var(--qm-accent)",
    },
    ".cm-md-attr": {
      paddingInlineStart: "0.6em",
      borderInlineStart: "2px solid var(--qm-line-strong)",
    },
    ".cm-md-attr-warning": {
      borderInlineStartColor: "var(--qm-warning)",
    },
    ".cm-md-attr-error": {
      borderInlineStartColor: "var(--qm-danger)",
    },
    ".cm-md-attr-success": {
      borderInlineStartColor: "var(--qm-success)",
    },
    ".cm-md-attr-badge": {
      display: "inline-flex",
      alignItems: "baseline",
      gap: "0.4em",
      padding: "0.05em 0.4em",
      border: "1px solid var(--qm-line)",
      borderRadius: "3px",
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-ink-faint)",
      fontSize: "0.74em",
    },
    ".cm-md-attr-badge-label": {
      color: "var(--qm-accent-strong)",
      fontWeight: "600",
    },
    ".cm-md-attr-badge-value": {
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-list": {
      color: "var(--qm-ink)",
    },
    ".cm-md-list-number": {
      color: "var(--qm-ink-muted)",
      fontVariantNumeric: "tabular-nums",
    },
    ".cm-md-bullet": {
      display: "inline-block",
      width: "1.1em",
      color: "var(--qm-accent)",
      fontWeight: "700",
    },
    ".cm-md-task": {
      display: "inline-flex",
      alignItems: "center",
      marginRight: "0.3em",
      verticalAlign: "middle",
    },
    ".cm-md-task input": {
      margin: "0",
      accentColor: "var(--qm-accent)",
      cursor: "pointer",
    },
    ".cm-md-rule": {
      display: "inline-block",
      width: "100%",
      height: "1px",
      backgroundColor: "var(--qm-line-strong)",
      verticalAlign: "middle",
    },
    ".cm-md-image": {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.35em",
      maxWidth: "100%",
      padding: "0.08em 0.4em",
      borderRadius: "4px",
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-ink-muted)",
      verticalAlign: "middle",
    },
    ".cm-md-image img": {
      display: "block",
      maxWidth: "100%",
      maxHeight: "320px",
      borderRadius: "4px",
    },
    ".cm-md-image-icon": {
      color: "var(--qm-accent)",
      fontFamily: "var(--qm-font-mono)",
    },
    ".cm-md-image-fallback": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      maxWidth: "28em",
    },
    ".cm-md-code-block": {
      backgroundColor: "var(--qm-surface-muted)",
      fontFamily: "var(--qm-font-mono)",
    },
    // Top-level fences render as a small terminal window: a chrome bar with
    // traffic lights, title, language and actions, then the embedded editor.
    // The vertical rhythm must be padding on the block widget root: CodeMirror
    // measures block widgets without their margins, so margins here would shift
    // the hit-testing of every line below the block.
    ".cm-md-code-block-widget": {
      padding: "0.7em 0",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.92em",
    },
    ".cm-md-code-block-card": {
      position: "relative",
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-md)",
      backgroundColor: "var(--qm-surface)",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
    },
    ".cm-md-code-block-card:focus-within": {
      borderColor: "var(--qm-line-strong)",
      boxShadow: "0 0 0 2px var(--qm-accent-soft), 0 1px 2px rgba(0, 0, 0, 0.05)",
    },
    ".cm-md-code-header": {
      display: "flex",
      alignItems: "center",
      gap: "0.55em",
      height: "2.6em",
      padding: "0 0.7em",
      borderBottom: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-md) var(--qm-radius-md) 0 0",
      backgroundColor: "color-mix(in srgb, var(--qm-surface-muted) 55%, var(--qm-surface))",
      userSelect: "none",
    },
    ".cm-md-code-dots": {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.42em",
      flex: "none",
    },
    ".cm-md-code-dot": {
      width: "0.68em",
      height: "0.68em",
      borderRadius: "50%",
    },
    ".cm-md-code-dot-red": {
      backgroundColor: "#ff5f57",
    },
    ".cm-md-code-dot-yellow": {
      backgroundColor: "#febc2e",
    },
    ".cm-md-code-dot-green": {
      backgroundColor: "#28c840",
    },
    ".cm-md-code-header-spacer": {
      flex: "1",
    },
    ".cm-md-code-block-widget .cm-md-code-title": {
      flex: "0 1 auto",
      minWidth: "0",
      maxWidth: "45%",
      overflow: "hidden",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.76em",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-md-code-actions": {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.15em",
      flex: "none",
      marginLeft: "auto",
    },
    ".cm-md-code-action": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "2em",
      height: "2em",
      padding: "0",
      border: "0",
      borderRadius: "4px",
      backgroundColor: "transparent",
      color: "var(--qm-ink-faint)",
      cursor: "pointer",
    },
    ".cm-md-code-action:hover": {
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-ink)",
    },
    ".cm-md-code-action:focus-visible": {
      outline: "1px solid var(--qm-accent)",
      outlineOffset: "1px",
    },
    ".cm-md-code-action svg": {
      width: "1.05em",
      height: "1.05em",
      display: "block",
    },
    '.cm-md-code-copy[data-state="copied"]': {
      color: "var(--qm-success)",
    },
    '.cm-md-code-copy[data-state="failed"]': {
      color: "var(--qm-danger)",
    },
    ".cm-md-code-menu": {
      position: "absolute",
      top: "calc(2.6em + 4px)",
      right: "0.6em",
      zIndex: "20",
      minWidth: "9em",
      padding: "0.25em",
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-raised)",
      boxShadow: "0 10px 28px rgba(0, 0, 0, 0.16)",
    },
    ".cm-md-code-menu[hidden]": {
      display: "none",
    },
    ".cm-md-code-menu-item": {
      display: "block",
      width: "100%",
      padding: "0.4em 0.6em",
      border: "0",
      borderRadius: "4px",
      backgroundColor: "transparent",
      color: "var(--qm-ink)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.8em",
      textAlign: "left",
      cursor: "pointer",
    },
    ".cm-md-code-menu-item:hover, .cm-md-code-menu-item:focus-visible": {
      backgroundColor: "var(--qm-surface-muted)",
      outline: "none",
    },
    ".cm-md-code-language-picker": {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      flex: "none",
    },
    ".cm-md-code-block-widget .cm-md-code-language": {
      appearance: "none",
      display: "inline-flex",
      alignItems: "center",
      gap: "0.18em",
      height: "2em",
      minWidth: "2.2em",
      padding: "0 0.4em",
      border: "1px solid transparent",
      borderRadius: "4px",
      outline: "none",
      backgroundColor: "transparent",
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.78em",
      letterSpacing: "0.02em",
      lineHeight: "1",
      cursor: "pointer",
    },
    ".cm-md-code-block-widget .cm-md-code-language:hover": {
      backgroundColor: "var(--qm-surface-muted)",
      color: "var(--qm-ink)",
    },
    ".cm-md-code-block-widget .cm-md-code-language:focus-visible": {
      borderColor: "var(--qm-accent)",
      backgroundColor: "var(--qm-surface)",
      color: "var(--qm-ink)",
    },
    '.cm-md-code-block-widget .cm-md-code-language[aria-expanded="true"]': {
      borderColor: "var(--qm-line-strong)",
      backgroundColor: "var(--qm-surface)",
      color: "var(--qm-ink)",
    },
    ".cm-md-code-block-widget .cm-md-code-language:disabled": {
      cursor: "default",
      opacity: "0.65",
    },
    ".cm-md-code-language-label": {
      maxWidth: "9em",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-md-code-language-chevron": {
      width: "0.78em",
      height: "0.78em",
      flex: "none",
      opacity: "0.6",
    },
    ".cm-md-code-language-popover": {
      position: "absolute",
      top: "calc(100% + 0.35em)",
      right: "0",
      zIndex: "25",
      display: "flex",
      flexDirection: "column",
      width: "15em",
      maxWidth: "min(15em, 60vw)",
      padding: "0.35em",
      border: "1px solid var(--qm-line)",
      borderRadius: "var(--qm-radius-sm)",
      backgroundColor: "var(--qm-surface-raised)",
      boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
    },
    ".cm-md-code-language-popover[hidden]": {
      display: "none",
    },
    ".cm-md-code-language-search": {
      width: "100%",
      padding: "0.35em 0.5em",
      border: "1px solid var(--qm-line)",
      borderRadius: "4px",
      outline: "none",
      backgroundColor: "var(--qm-surface)",
      color: "var(--qm-ink)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.78em",
      userSelect: "text",
    },
    ".cm-md-code-language-search:focus": {
      borderColor: "var(--qm-accent)",
    },
    ".cm-md-code-language-list": {
      display: "flex",
      flexDirection: "column",
      gap: "1px",
      marginTop: "0.3em",
      maxHeight: "13.5em",
      overflowY: "auto",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--qm-line-strong) transparent",
    },
    ".cm-md-code-language-list::-webkit-scrollbar": {
      width: "0.35em",
    },
    ".cm-md-code-language-list::-webkit-scrollbar-thumb": {
      borderRadius: "999px",
      backgroundColor: "var(--qm-line-strong)",
    },
    ".cm-md-code-language-list::-webkit-scrollbar-track": {
      backgroundColor: "transparent",
    },
    ".cm-md-code-language-option": {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "0.5em",
      width: "100%",
      padding: "0.35em 0.5em",
      border: "0",
      borderRadius: "4px",
      backgroundColor: "transparent",
      color: "var(--qm-ink)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.78em",
      textAlign: "left",
      cursor: "pointer",
    },
    ".cm-md-code-language-option:hover, .cm-md-code-language-option[data-active='true']": {
      backgroundColor: "var(--qm-surface-muted)",
    },
    ".cm-md-code-language-option[aria-selected='true']": {
      color: "var(--qm-accent)",
    },
    ".cm-md-code-language-option[aria-selected='true']::after": {
      content: '"✓"',
      fontSize: "0.9em",
    },
    ".cm-md-code-block-widget .cm-editor": {
      height: "auto",
      backgroundColor: "transparent",
      fontSize: "inherit",
    },
    ".cm-md-code-block-widget .cm-scroller": {
      fontFamily: "var(--qm-font-mono)",
      lineHeight: "1.75",
      overflow: "visible",
    },
    ".cm-md-code-block-widget .cm-content": {
      padding: "0",
      caretColor: "var(--qm-accent)",
    },
    ".cm-md-code-block-widget .cm-line": {
      padding: "0",
    },
    ".cm-md-code-block-widget .cm-gutters": {
      display: "none",
    },
    ".cm-md-code-block-widget .cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-md-code-editor": {
      padding: "0.75em 1em 0.9em",
    },
    ".cm-md-code-block.cm-selectedLine": {
      backgroundColor: "transparent",
    },
    ".cm-md-code-fence": {
      color: "var(--qm-ink-faint)",
    },
    // The opening fence is a source-only marker. When the caret is elsewhere,
    // collapse its otherwise empty line so the block starts at the code text.
    ".cm-md-code-fence-hidden": {
      height: "0",
      lineHeight: "0",
      fontSize: "0",
      paddingTop: "0",
      paddingBottom: "0",
      overflow: "hidden",
    },
    ".cm-md-code-fence-hidden + .cm-md-code-block": {
      paddingTop: "0.35em",
    },
    // The closing fence carries the language badge in its bottom-right corner.
    ".cm-md-code-fence-close": {
      paddingBottom: "0.2em",
    },
    ".cm-md-code-fence-badged": {
      textAlign: "right",
    },
    ".cm-md-code-highlight": {
      backgroundColor: "var(--qm-accent-soft)",
      boxShadow: "inset 2px 0 0 var(--qm-accent)",
    },
    ".cm-md-code-diff-add": {
      backgroundColor: "color-mix(in srgb, var(--qm-success) 14%, transparent)",
      boxShadow: "inset 2px 0 0 var(--qm-success)",
    },
    ".cm-md-code-diff-del": {
      backgroundColor: "color-mix(in srgb, var(--qm-danger) 14%, transparent)",
      boxShadow: "inset 2px 0 0 var(--qm-danger)",
    },
    ".cm-md-code-diff-meta": {
      color: "var(--qm-accent-strong)",
      backgroundColor: "var(--qm-accent-soft)",
    },
    ".cm-md-code-info": {
      // Inline widgets participate in the line's text flow. Right-aligning the
      // closing line keeps the badge in the block's bottom-right corner
      // without a full-width element (which would wrap the widget buffers and
      // leave a tall empty strip).
      display: "inline-flex",
      alignItems: "center",
      gap: "0.45em",
      userSelect: "none",
    },
    ".cm-md-code-title": {
      color: "var(--qm-ink-muted)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.76em",
    },
    ".cm-md-code-external": {
      padding: "0 0.35em",
      border: "1px dashed var(--qm-warning)",
      borderRadius: "3px",
      color: "var(--qm-warning)",
      fontSize: "0.72em",
      whiteSpace: "nowrap",
    },
    ".cm-md-code-language": {
      display: "inline-block",
      padding: "0 0.35em",
      borderRadius: "3px",
      backgroundColor: "var(--qm-surface)",
      color: "var(--qm-ink-faint)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.76em",
      letterSpacing: "0.04em",
      verticalAlign: "middle",
    },
    ".cm-md-table": {
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.92em",
    },
    ".cm-md-table-header": {
      fontWeight: "600",
      backgroundColor: "var(--qm-surface-muted)",
    },
    ".cm-md-table-delim": {
      color: "var(--qm-ink-faint)",
    },
    ".cm-md-table-block": {
      // Padding, not margin, so the block's measured height matches its layout
      // and hit-testing stays aligned for the lines that follow the table.
      padding: "0.55em 0",
      overflowX: "auto",
      contain: "inline-size",
      cursor: "text",
    },
    ".cm-md-table-block table": {
      borderCollapse: "collapse",
      width: "100%",
      fontSize: "0.92em",
    },
    ".cm-md-table-block caption": {
      captionSide: "top",
      padding: "0.25em 0",
      color: "var(--qm-ink-muted)",
      fontSize: "0.86em",
      fontWeight: "600",
      textAlign: "center",
    },
    ".cm-md-table-block th, .cm-md-table-block td": {
      border: "1px solid var(--qm-line)",
      padding: "0.4em 0.65em",
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: "1.5",
      position: "relative",
      // URLs have no spaces: without this a cell can force the whole table
      // into horizontal scrolling instead of wrapping.
      overflowWrap: "anywhere",
      wordBreak: "break-word",
    },
    // Rendered cells stay visible while another cell is edited; the
    // transparent editor on top handles clicks, caret placement and typing.
    ".cm-md-table-cell-view": {
      display: "block",
    },
    ".cm-md-table-cell-input": {
      position: "absolute",
      inset: "0",
      margin: "0",
      padding: "inherit",
      border: "0",
      outline: "none",
      background: "var(--qm-surface)",
      color: "inherit",
      font: "inherit",
      textAlign: "inherit",
      opacity: "0",
      cursor: "text",
      // Raw Markdown is often longer than the rendered cell; wrapping keeps
      // the whole cell value readable instead of clipping one endless line.
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      wordBreak: "break-word",
      overflowY: "auto",
      resize: "none",
    },
    ".cm-md-table-cell-input:focus": {
      opacity: "1",
      outline: "2px solid var(--qm-accent)",
      outlineOffset: "-2px",
      borderRadius: "2px",
    },
    // Unfocused cells raise rendered links above the transparent editor so
    // ⌘/Ctrl+Click can open them; a focused cell hands the pointer back to
    // its editor.
    ".cm-md-table-block th:not(:focus-within) .cm-md-link[data-href], .cm-md-table-block td:not(:focus-within) .cm-md-link[data-href]":
      {
        position: "relative",
        zIndex: "1",
      },
    ".cm-md-table-block th": {
      backgroundColor: "var(--qm-surface-muted)",
      fontWeight: "600",
    },
    ".cm-md-table-block mark": {
      backgroundColor: "var(--qm-highlight)",
      color: "inherit",
      borderRadius: "2px",
    },
    ".cm-md-table-block kbd": {
      padding: "0.05em 0.3em",
      border: "1px solid var(--qm-line-strong)",
      borderRadius: "3px",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.9em",
    },

    ".cm-md-html": {
      color: "var(--qm-ink-faint)",
    },
    ".cm-md-link-reference": {
      color: "var(--qm-ink-faint)",
      fontFamily: "var(--qm-font-mono)",
      fontSize: "0.9em",
    },
  },
  { dark: false },
);
