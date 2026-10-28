/**
 * The closed Mermaid diagram-kind vocabulary. It lives in its own module so
 * both `i18n.ts` (which types `diagramKinds`) and `mermaid-theme.ts` (which
 * parses diagram keywords) can depend on it without an import cycle.
 */
export const MERMAID_DIAGRAM_KINDS = [
  "flowchart",
  "sequence",
  "class",
  "state",
  "er",
  "gantt",
  "pie",
  "quadrant",
  "mindmap",
  "git",
  "c4",
  "journey",
  "timeline",
  "requirement",
  "sankey",
  "xychart",
  "block",
  "packet",
  "architecture",
  "kanban",
  "radar",
  "treemap",
  "ishikawa",
  "wardley",
  "zenuml",
  "info",
  "unknown",
] as const;

export type MermaidDiagramKind = (typeof MERMAID_DIAGRAM_KINDS)[number];
