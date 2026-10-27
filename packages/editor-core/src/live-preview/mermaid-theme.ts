/**
 * Mermaid's `base` theme is configured entirely from Qingmo's semantic CSS
 * tokens. This module resolves those tokens to concrete colours (the sandbox
 * iframe cannot see the editor document), maps them onto Mermaid's theme
 * variables, and builds the small amount of diagram-specific CSS the design
 * relies on.
 *
 * Rendering still happens with `securityLevel: "strict"` and
 * `htmlLabels: false`; nothing here changes that contract.
 */

export type MermaidTheme = "default" | "dark";

export type MermaidDiagramKind =
  | "flowchart"
  | "sequence"
  | "class"
  | "state"
  | "er"
  | "gantt"
  | "pie"
  | "quadrant"
  | "mindmap"
  | "git"
  | "c4"
  | "journey"
  | "timeline"
  | "requirement"
  | "sankey"
  | "xychart"
  | "block"
  | "packet"
  | "architecture"
  | "kanban"
  | "radar"
  | "treemap"
  | "ishikawa"
  | "wardley"
  | "zenuml"
  | "info"
  | "unknown";

export interface MermaidDiagramInfo {
  kind: MermaidDiagramKind;
  label: string;
}

/** Bump when the variable mapping or theme CSS changes. */
export const MERMAID_THEME_VERSION = 1;

const DIAGRAM_LABELS: Record<MermaidDiagramKind, string> = {
  flowchart: "流程图",
  sequence: "时序图",
  class: "类图",
  state: "状态图",
  er: "ER 图",
  gantt: "甘特图",
  pie: "饼图",
  quadrant: "象限图",
  mindmap: "思维导图",
  git: "Git 图",
  c4: "C4 架构图",
  journey: "用户旅程",
  timeline: "时间线",
  requirement: "需求图",
  sankey: "桑基图",
  xychart: "XY 图表",
  block: "块图",
  packet: "数据包图",
  architecture: "架构图",
  kanban: "看板",
  radar: "雷达图",
  treemap: "矩形树图",
  ishikawa: "鱼骨图",
  wardley: "沃德利图",
  zenuml: "ZenUML 时序图",
  info: "说明",
  unknown: "图表",
};

const KIND_BY_KEYWORD: Record<string, MermaidDiagramKind> = {
  sequence: "sequence",
  sequencediagram: "sequence",
  class: "class",
  classdiagram: "class",
  state: "state",
  statediagram: "state",
  "statediagram-v2": "state",
  er: "er",
  erdiagram: "er",
  gantt: "gantt",
  pie: "pie",
  quadrant: "quadrant",
  quadrantchart: "quadrant",
  mindmap: "mindmap",
  git: "git",
  gitgraph: "git",
  c4: "c4",
  c4context: "c4",
  c4container: "c4",
  c4component: "c4",
  c4deployment: "c4",
  c4dynamic: "c4",
  journey: "journey",
  timeline: "timeline",
  requirement: "requirement",
  requirementdiagram: "requirement",
  sankey: "sankey",
  "sankey-beta": "sankey",
  xychart: "xychart",
  "xychart-beta": "xychart",
  block: "block",
  "block-beta": "block",
  packet: "packet",
  "packet-beta": "packet",
  architecture: "architecture",
  "architecture-beta": "architecture",
  kanban: "kanban",
  radar: "radar",
  "radar-beta": "radar",
  treemap: "treemap",
  "treemap-beta": "treemap",
  ishikawa: "ishikawa",
  "ishikawa-beta": "ishikawa",
  wardley: "wardley",
  "wardley-beta": "wardley",
  zenuml: "zenuml",
  info: "info",
};

function stripFrontMatter(code: string): string {
  const text = code.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return text;
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return text;
  }
  return text.slice(text.indexOf("\n", end + 1) + 1);
}

function firstStatement(code: string): string {
  for (const rawLine of stripFrontMatter(code).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) {
      continue;
    }
    return line;
  }
  return "";
}

/** Reads the Mermaid diagram keyword without trusting user output. */
export function diagramInfo(code: string): MermaidDiagramInfo {
  const statement = firstStatement(code);
  const keyword = statement.split(/\s+/)[0]?.toLowerCase().replace(/:$/, "") ?? "";
  let kind: MermaidDiagramKind = "unknown";
  if (keyword.startsWith("flowchart") || keyword.startsWith("graph")) {
    kind = "flowchart";
  } else {
    kind = KIND_BY_KEYWORD[keyword] ?? "unknown";
  }
  return { kind, label: DIAGRAM_LABELS[kind] };
}

export function diagramKind(code: string): MermaidDiagramKind {
  return diagramInfo(code).kind;
}

/**
 * Dense multi-subgraph flowcharts need ELK's partitioned, obstacle-aware
 * routing. Mermaid's default ELK preset is used for small diagrams; the
 * model-order preset is applied by the renderer only to these large graphs.
 */
export function mermaidLayout(kind: MermaidDiagramKind, code: string): "elk" | undefined {
  if (kind !== "flowchart" || /^\s*flowchart-elk\b/m.test(code)) {
    return undefined;
  }
  const subgraphs = code.match(/^\s*subgraph\b/gm)?.length ?? 0;
  return subgraphs >= 3 ? "elk" : undefined;
}

/**
 * ELK's layered layout keeps each subgraph in its own band and routes edges
 * orthogonally around nodes. Model order keeps declaration order inside each
 * layer, which makes hand-written architecture diagrams predictable.
 */
export function mermaidElkConfig(): Record<string, unknown> {
  return {
    preset: "modelOrder",
    forceNodeModelOrder: true,
    considerModelOrder: "NODES_AND_EDGES",
    keepEntryNodeOnTop: true,
    mergeEdges: false,
    lineHops: true,
    straightenEdges: true,
  };
}

export function isMermaidDiagramKind(value: unknown): value is MermaidDiagramKind {
  return typeof value === "string" && value in DIAGRAM_LABELS;
}

/**
 * Concrete palette handed to the sandbox. Arrays use the same ordering as
 * Mermaid's `cScale`, `git` and mindmap branch variables.
 */
export interface MermaidPalette {
  fontFamily: string;
  surface: string;
  surfaceMuted: string;
  ink: string;
  inkMuted: string;
  accent: string;
  accentStrong: string;
  diagramNode: string;
  diagramLine: string;
  diagramSurfaceAlt: string;
  diagramBorder: string;
  diagramGrid: string;
  diagramActorLine: string;
  diagramNote: string;
  diagramNoteBorder: string;
  diagramNoteText: string;
  diagramTask: string;
  diagramActive: string;
  diagramDone: string;
  diagramCrit: string;
  diagramCritBorder: string;
  diagramMilestone: string;
  diagramExclude: string;
  diagramOnAccent: string;
  cats: string[];
  accents: string[];
  mindRootBg: string;
  mindRootText: string;
  mindLeafBg: string;
  mindLeafText: string;
  mindPillText: string;
  mindBranches: Array<{ pill: string; line: string }>;
  c4: {
    person: string;
    personBorder: string;
    system: string;
    systemBorder: string;
    external: string;
    externalBorder: string;
  };
}

const DEFAULT_FONT =
  '"Avenir Next", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

/**
 * Fallbacks are only used when the editor stylesheet is unavailable (unit
 * tests, a bare renderer page, or a document that has not loaded the app
 * styles yet). The normal path resolves every value from the CSS tokens.
 */
const LIGHT_FALLBACK: MermaidPalette = {
  fontFamily: DEFAULT_FONT,
  surface: "#fbf8f1",
  surfaceMuted: "#ece5d8",
  ink: "#1d1c19",
  inkMuted: "#6f675b",
  accent: "#2c6a5a",
  accentStrong: "#1f5145",
  diagramNode: "#f3ecdf",
  diagramLine: "#8a8172",
  diagramSurfaceAlt: "#f7f1e6",
  diagramBorder: "#c9bfae",
  diagramGrid: "#d8cfc0",
  diagramActorLine: "#c1b6a4",
  diagramNote: "#f7ecd2",
  diagramNoteBorder: "#d0b477",
  diagramNoteText: "#3d3220",
  diagramTask: "#e5eee8",
  diagramActive: "#ead9b8",
  diagramDone: "#d9e3cf",
  diagramCrit: "#e8d2c7",
  diagramCritBorder: "#a65f45",
  diagramMilestone: "#b08a45",
  diagramExclude: "#f1ebdf",
  diagramOnAccent: "#fbf8f1",
  cats: ["#cfe0d7", "#ead9b8", "#d6e0e4", "#e8d2c7", "#ddd8e4", "#d9e3cf", "#eadfcd", "#d3ded9"],
  accents: ["#2c6a5a", "#b08a45", "#5f7480", "#a65f45", "#7a5a66", "#6f7a4e", "#8a7345", "#4f7a6a"],
  mindRootBg: "#1f5145",
  mindRootText: "#fbf8f1",
  mindLeafBg: "#fbf8f1",
  mindLeafText: "#1d1c19",
  mindPillText: "#fbf8f1",
  mindBranches: [
    { pill: "#2c6a5a", line: "#6f9b8b" },
    { pill: "#5f7480", line: "#8ba1ab" },
    { pill: "#8a6a2f", line: "#b99a61" },
    { pill: "#a65f45", line: "#c58d78" },
  ],
  c4: {
    person: "#2c6a5a",
    personBorder: "#1f5145",
    system: "#5f7480",
    systemBorder: "#4b5d68",
    external: "#6f675b",
    externalBorder: "#5a5349",
  },
};

const DARK_FALLBACK: MermaidPalette = {
  fontFamily: DEFAULT_FONT,
  surface: "#1c1f1b",
  surfaceMuted: "#20241e",
  ink: "#ece7dc",
  inkMuted: "#b4ada0",
  accent: "#7fb5a2",
  accentStrong: "#a5d0c1",
  diagramNode: "#262b24",
  diagramLine: "#9d9689",
  diagramSurfaceAlt: "#20241e",
  diagramBorder: "#3a3f36",
  diagramGrid: "#3a3f36",
  diagramActorLine: "#5c584f",
  diagramNote: "#3a3427",
  diagramNoteBorder: "#8a7345",
  diagramNoteText: "#f0e4c5",
  diagramTask: "#2b3830",
  diagramActive: "#4a3f28",
  diagramDone: "#39442b",
  diagramCrit: "#4a332b",
  diagramCritBorder: "#d18e75",
  diagramMilestone: "#d4ac63",
  diagramExclude: "#181b16",
  diagramOnAccent: "#151714",
  cats: ["#2f4a40", "#4a3f28", "#2f3e45", "#4a332b", "#3b3445", "#39442b", "#443b2b", "#2c3d37"],
  accents: ["#7fb5a2", "#d4ac63", "#8fa8b3", "#d18e75", "#b58a9a", "#a8b77f", "#c3a86b", "#8fc7a8"],
  mindRootBg: "#7fb5a2",
  mindRootText: "#151714",
  mindLeafBg: "#1c1f1b",
  mindLeafText: "#ece7dc",
  mindPillText: "#ece7dc",
  mindBranches: [
    { pill: "#2f4a40", line: "#7fb5a2" },
    { pill: "#2f3e45", line: "#8fa8b3" },
    { pill: "#4a3a1f", line: "#c3a86b" },
    { pill: "#4a2f26", line: "#d18e75" },
  ],
  c4: {
    person: "#2f4a40",
    personBorder: "#7fb5a2",
    system: "#2f3e45",
    systemBorder: "#8fa8b3",
    external: "#443b2b",
    externalBorder: "#c3a86b",
  },
};

function fallbackPalette(theme: MermaidTheme): MermaidPalette {
  return theme === "dark" ? DARK_FALLBACK : LIGHT_FALLBACK;
}

function hexChannel(value: string): string {
  const channel = Math.max(0, Math.min(255, Math.round(Number(value))));
  return channel.toString(16).padStart(2, "0");
}

/**
 * `getComputedStyle` returns `rgb(...)`/`rgba(...)`. Mermaid's comma-separated
 * options (for example `xyChart.plotColorPalette`) cannot contain commas
 * inside a colour, so opaque colours are normalised to hex.
 */
export function normalizeMermaidColor(value: string): string {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(
    value,
  );
  if (!match) {
    return value;
  }
  const [, red, green, blue, alpha] = match;
  if (!red || !green || !blue) {
    return value;
  }
  if (alpha !== undefined && Number(alpha) < 1) {
    return `rgba(${Math.round(Number(red))}, ${Math.round(Number(green))}, ${Math.round(Number(blue))}, ${alpha})`;
  }
  return `#${hexChannel(red)}${hexChannel(green)}${hexChannel(blue)}`;
}

interface TokenReader {
  color(token: string, fallback: string): string;
  raw(token: string, fallback: string): string;
  dispose(): void;
}

function tokenReader(root?: HTMLElement): TokenReader | null {
  const doc = root?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  const view = doc?.defaultView;
  const tokenRoot = root ?? doc?.documentElement;
  const parent = root ?? doc?.body ?? doc?.documentElement;
  if (!doc || !view || !tokenRoot || !parent) {
    return null;
  }

  const host = doc.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
  const probe = doc.createElement("span");
  host.append(probe);
  parent.append(host);

  return {
    color(token, fallback) {
      // Plain token values are usable as-is (and are the only thing jsdom
      // can resolve). `light-dark()` and other functions need a probe, which
      // lets the browser compute the value for the current color-scheme.
      const raw = view.getComputedStyle(tokenRoot).getPropertyValue(token).trim();
      if (raw && !/^(?:light-dark|var|color-mix)\(/i.test(raw)) {
        return normalizeMermaidColor(raw);
      }
      probe.style.color = `var(${token}, ${fallback})`;
      const value = view.getComputedStyle(probe).color.trim();
      return normalizeMermaidColor(value && !value.startsWith("var(") ? value : fallback);
    },
    raw(token, fallback) {
      const value = view.getComputedStyle(tokenRoot).getPropertyValue(token).trim();
      return value || fallback;
    },
    dispose() {
      host.remove();
    },
  };
}

/** Resolves the current theme's semantic tokens to a concrete palette. */
export function resolveMermaidPalette(theme: MermaidTheme, root?: HTMLElement): MermaidPalette {
  const fallback = fallbackPalette(theme);
  const reader = tokenReader(root);
  if (!reader) {
    return fallback;
  }

  try {
    const color = (token: string, value: string) => reader.color(token, value);
    const cats = fallback.cats.map((value, index) => color(`--qm-diagram-cat-${index + 1}`, value));
    const accents = fallback.accents.map((value, index) =>
      color(`--qm-diagram-accent-${index + 1}`, value),
    );
    const branches = fallback.mindBranches.map((branch, index) => ({
      pill: color(`--qm-mind-branch-${index + 1}-pill`, branch.pill),
      line: color(`--qm-mind-branch-${index + 1}-line`, branch.line),
    }));

    return {
      fontFamily: reader.raw("--qm-font-sans", fallback.fontFamily),
      surface: color("--qm-surface", fallback.surface),
      surfaceMuted: color("--qm-surface-muted", fallback.surfaceMuted),
      ink: color("--qm-ink", fallback.ink),
      inkMuted: color("--qm-ink-muted", fallback.inkMuted),
      accent: color("--qm-accent", fallback.accent),
      accentStrong: color("--qm-accent-strong", fallback.accentStrong),
      diagramNode: color("--qm-diagram-node", fallback.diagramNode),
      diagramLine: color("--qm-diagram-line", fallback.diagramLine),
      diagramSurfaceAlt: color("--qm-diagram-surface-alt", fallback.diagramSurfaceAlt),
      diagramBorder: color("--qm-diagram-border", fallback.diagramBorder),
      diagramGrid: color("--qm-diagram-grid", fallback.diagramGrid),
      diagramActorLine: color("--qm-diagram-actor-line", fallback.diagramActorLine),
      diagramNote: color("--qm-diagram-note", fallback.diagramNote),
      diagramNoteBorder: color("--qm-diagram-note-border", fallback.diagramNoteBorder),
      diagramNoteText: color("--qm-diagram-note-text", fallback.diagramNoteText),
      diagramTask: color("--qm-diagram-task", fallback.diagramTask),
      diagramActive: color("--qm-diagram-active", fallback.diagramActive),
      diagramDone: color("--qm-diagram-done", fallback.diagramDone),
      diagramCrit: color("--qm-diagram-crit", fallback.diagramCrit),
      diagramCritBorder: color("--qm-diagram-crit-border", fallback.diagramCritBorder),
      diagramMilestone: color("--qm-diagram-milestone", fallback.diagramMilestone),
      diagramExclude: color("--qm-diagram-exclude", fallback.diagramExclude),
      diagramOnAccent: color("--qm-diagram-on-accent", fallback.diagramOnAccent),
      cats,
      accents,
      mindRootBg: color("--qm-mind-root-bg", fallback.mindRootBg),
      mindRootText: color("--qm-mind-root-text", fallback.mindRootText),
      mindLeafBg: color("--qm-mind-leaf-bg", fallback.mindLeafBg),
      mindLeafText: color("--qm-mind-leaf-text", fallback.mindLeafText),
      mindPillText: color("--qm-mind-pill-text", fallback.mindPillText),
      mindBranches: branches,
      c4: {
        person: color("--qm-c4-person", fallback.c4.person),
        personBorder: color("--qm-c4-person-border", fallback.c4.personBorder),
        system: color("--qm-c4-system", fallback.c4.system),
        systemBorder: color("--qm-c4-system-border", fallback.c4.systemBorder),
        external: color("--qm-c4-external", fallback.c4.external),
        externalBorder: color("--qm-c4-external-border", fallback.c4.externalBorder),
      },
    };
  } finally {
    reader.dispose();
  }
}

export type MermaidThemeVariable = string | boolean | Record<string, unknown>;

export interface MermaidThemeConfig {
  variables: Record<string, MermaidThemeVariable>;
  themeCSS: string;
  c4: Record<string, string>;
}

function cat(palette: MermaidPalette, index: number): string {
  return palette.cats[index] ?? palette.diagramNode;
}

function accent(palette: MermaidPalette, index: number): string {
  return palette.accents[index] ?? palette.accent;
}

function mindmapCSS(palette: MermaidPalette): string {
  const branches = palette.mindBranches
    .map(
      (item, index) => `
      .mindmap-node.mind-depth-1.section-${index} .node-bkg { fill: ${item.pill} !important; }
      .section-edge-${index} { stroke: ${item.line} !important; }`,
    )
    .join("");

  return `
      .mindmap-node .node-line- { display: none !important; }
      .mindmap-node .node-bkg { stroke: none !important; }
      .mindmap-node:not(.mind-depth-1):not(.section-root) .node-bkg { fill: ${palette.mindLeafBg} !important; }
      .mindmap-node.mind-depth-1 text,
      .mindmap-node.mind-depth-1 text tspan { fill: ${palette.mindPillText} !important; font-weight: 600 !important; }
      .mindmap-node:not(.mind-depth-1):not(.section-root) text,
      .mindmap-node:not(.mind-depth-1):not(.section-root) text tspan {
        fill: ${palette.mindLeafText} !important;
        font-weight: 400 !important;
      }
      .mindmap-node.section-root .basic { fill: ${palette.mindRootBg} !important; }
      .mindmap-node.section-root text,
      .mindmap-node.section-root text tspan { fill: ${palette.mindRootText} !important; font-weight: 600 !important; }
      ${branches}
      .edgePaths path { stroke-width: 1.5px !important; stroke-linecap: round; }
      .edgePaths path.edge-depth-1 { stroke-width: 2.5px !important; }
    `;
}

function c4CSS(palette: MermaidPalette): string {
  return `
      .c4-person-shape { stroke-width: 1.25px; }
      g > text { fill: ${palette.ink} !important; }
      text[fill="#444444"] { fill: ${palette.inkMuted} !important; }
      path[stroke="#444444"], line[stroke="#444444"] { stroke: ${palette.diagramLine} !important; }
      marker path { fill: ${palette.diagramLine} !important; stroke: ${palette.diagramLine} !important; }
    `;
}

function sequenceCSS(palette: MermaidPalette): string {
  return `
      rect.actor { fill: ${palette.diagramNode} !important; stroke: ${palette.accent} !important; }
      rect[class^="activation"] { fill: ${palette.diagramTask} !important; stroke: ${palette.accent} !important; }
      rect.note { fill: ${palette.diagramNote} !important; stroke: ${palette.diagramNoteBorder} !important; }
      .noteText, .noteText > tspan { fill: ${palette.diagramNoteText} !important; }
    `;
}

function architectureCSS(palette: MermaidPalette): string {
  // Mermaid's built-in icon loader paints its fallback glyphs on #087ebf.
  return `rect[style*="#087ebf"] { fill: ${palette.c4.person} !important; }`;
}

function packetCSS(palette: MermaidPalette): string {
  return `.packetBlock { fill: ${palette.diagramTask} !important; stroke: ${palette.diagramBorder} !important; }`;
}

function treemapCSS(palette: MermaidPalette): string {
  return `
      .treemapNode.section { fill: ${palette.diagramSurfaceAlt} !important; stroke: ${palette.diagramBorder} !important; }
      .treemapNode.leaf { fill: ${cat(palette, 0)} !important; stroke: ${palette.diagramBorder} !important; }
    `;
}

function radarCSS(palette: MermaidPalette): string {
  return `.radarGraticule { fill: ${palette.diagramGrid} !important; stroke: ${palette.diagramGrid} !important; }`;
}

function kanbanCSS(palette: MermaidPalette): string {
  return `.disabled text { fill: ${palette.inkMuted} !important; }`;
}

function journeyCSS(palette: MermaidPalette): string {
  // Mermaid's config sanitizer drops array-valued options such as
  // `journey.actorColours`, so the legend dots are recoloured in CSS instead.
  const actors = palette.cats
    .slice(0, 6)
    .map((color, index) => `circle.actor-${index} { fill: ${color} !important; }`)
    .join("\n      ");
  return `
      ${actors}
      text.journey-section, .journey-section text { fill: ${palette.ink} !important; }
      text.task, .task text { fill: ${palette.ink} !important; }
    `;
}

function kindCSS(kind: MermaidDiagramKind, palette: MermaidPalette): string {
  switch (kind) {
    case "c4":
      return c4CSS(palette);
    case "mindmap":
      return mindmapCSS(palette);
    case "git":
      return ".arrow { stroke-width: 2.5px !important; stroke-linecap: round; }";
    case "sequence":
      return sequenceCSS(palette);
    case "architecture":
      return architectureCSS(palette);
    case "packet":
      return packetCSS(palette);
    case "treemap":
      return treemapCSS(palette);
    case "radar":
      return radarCSS(palette);
    case "kanban":
      return kanbanCSS(palette);
    case "journey":
      return journeyCSS(palette);
    default:
      return "";
  }
}

function buildThemeCSS(kind: MermaidDiagramKind, palette: MermaidPalette): string {
  return `
      * { filter: none !important; }
      .node rect, .node circle, .node ellipse, .node polygon { stroke-width: 1.25px; }
      .edgePath .path, .flowchart-link { stroke-width: 1.25px; }
      .cluster rect { stroke-dasharray: 3 4; }
      .edgeLabel, .edgeLabel p { font-size: 12px; }
      .actor { stroke-width: 1.25px; }
      .messageText, .loopText, .noteText { font-size: 13px !important; }
      text.actor, text.actor > tspan { font-size: 14px !important; }
      [id$="-sequencenumber"] { fill: ${palette.accent} !important; }
      .sequenceNumber { fill: ${palette.diagramOnAccent} !important; }
      ${kindCSS(kind, palette)}
    `;
}

function c4Config(palette: MermaidPalette): Record<string, string> {
  return {
    person_bg_color: palette.c4.person,
    person_border_color: palette.c4.personBorder,
    system_bg_color: palette.c4.system,
    system_border_color: palette.c4.systemBorder,
    external_system_bg_color: palette.c4.external,
    external_system_border_color: palette.c4.externalBorder,
    system_db_bg_color: palette.c4.system,
    system_db_border_color: palette.c4.systemBorder,
    system_queue_bg_color: palette.c4.system,
    system_queue_border_color: palette.c4.systemBorder,
    external_system_db_bg_color: palette.c4.external,
    external_system_db_border_color: palette.c4.externalBorder,
    external_system_queue_bg_color: palette.c4.external,
    external_system_queue_border_color: palette.c4.externalBorder,
  };
}

/** Maps the palette onto Mermaid `base` theme variables. */
export function buildMermaidTheme(
  theme: MermaidTheme,
  kind: MermaidDiagramKind,
  palette: MermaidPalette = resolveMermaidPalette(theme),
): MermaidThemeConfig {
  const variables: Record<string, MermaidThemeVariable> = {
    darkMode: theme === "dark",
    background: palette.surface,
    fontFamily: palette.fontFamily,
    fontSize: "14px",
    primaryColor: palette.diagramNode,
    primaryTextColor: palette.ink,
    primaryBorderColor: palette.accent,
    secondaryColor: palette.diagramTask,
    secondaryTextColor: palette.accentStrong,
    secondaryBorderColor: palette.accent,
    tertiaryColor: palette.diagramSurfaceAlt,
    tertiaryTextColor: palette.inkMuted,
    tertiaryBorderColor: palette.diagramGrid,
    mainBkg: palette.diagramNode,
    nodeBorder: palette.accent,
    nodeTextColor: palette.ink,
    lineColor: palette.diagramLine,
    textColor: palette.ink,
    edgeLabelBackground: palette.surface,
    clusterBkg: palette.diagramSurfaceAlt,
    clusterBorder: palette.diagramBorder,
    titleColor: palette.ink,
    actorBkg: palette.diagramNode,
    actorBorder: palette.accent,
    actorTextColor: palette.ink,
    actorLineColor: palette.diagramActorLine,
    signalColor: palette.inkMuted,
    signalTextColor: palette.ink,
    labelBoxBkgColor: palette.diagramNode,
    labelBoxBorderColor: palette.accent,
    labelTextColor: palette.ink,
    loopTextColor: palette.ink,
    noteBkgColor: palette.diagramNote,
    noteBorderColor: palette.diagramNoteBorder,
    noteTextColor: palette.diagramNoteText,
    activationBkgColor: palette.diagramTask,
    activationBorderColor: palette.accent,
    sequenceNumberColor: palette.surface,
    pieTitleTextColor: palette.ink,
    pieSectionTextColor: palette.ink,
    pieLegendTextColor: palette.inkMuted,
    pieStrokeColor: palette.surface,
    pieOuterStrokeColor: palette.diagramGrid,
    pieTitleTextSize: "13px",
    pieSectionTextSize: "12px",
    pieLegendTextSize: "12px",
    tagLabelColor: palette.ink,
    tagLabelBackground: palette.surfaceMuted,
    tagLabelBorder: palette.diagramBorder,
    commitLabelColor: palette.ink,
    commitLabelBackground: palette.diagramNode,
    sectionBkgColor: palette.diagramSurfaceAlt,
    altSectionBkgColor: palette.surface,
    sectionBkgColor2: palette.diagramSurfaceAlt,
    excludeBkgColor: palette.diagramExclude,
    taskBkgColor: palette.diagramTask,
    taskBorderColor: palette.accent,
    taskTextColor: palette.ink,
    taskTextDarkColor: palette.ink,
    taskTextOutsideColor: palette.ink,
    activeTaskBkgColor: palette.diagramActive,
    activeTaskBorderColor: palette.accent,
    doneTaskBkgColor: palette.diagramDone,
    doneTaskBorderColor: palette.accent,
    critBkgColor: palette.diagramCrit,
    critBorderColor: palette.diagramCritBorder,
    todayLineColor: palette.diagramCritBorder,
    gridColor: palette.diagramGrid,
    milestoneBkgColor: palette.diagramMilestone,
    milestoneBorderColor: palette.diagramMilestone,
    wardleyEvolutionColor: palette.diagramCritBorder,
    archEdgeColor: palette.diagramLine,
    archEdgeArrowColor: palette.diagramLine,
    archGroupBorderColor: palette.diagramBorder,
    archEdgeWidth: "1.25px",
  };

  for (let index = 0; index < 8; index += 1) {
    variables[`cScale${index}`] = cat(palette, index);
    variables[`pie${index + 1}`] = cat(palette, index);
    variables[`pie${index + 9}`] = cat(palette, index % 4);
    variables[`git${index}`] = accent(palette, index);
    variables[`gitBranchLabel${index}`] = palette.diagramOnAccent;
    variables[`fillType${index}`] = cat(palette, index);
  }

  variables.radar = {
    axisColor: palette.diagramLine,
    graticuleColor: palette.diagramGrid,
    curveStrokeWidth: 2,
  };
  variables.xyChart = {
    plotColorPalette: palette.accents.join(","),
  };
  variables.wardley = {
    backgroundColor: palette.surface,
    axisColor: palette.diagramLine,
    axisTextColor: palette.ink,
    gridColor: palette.diagramGrid,
    componentFill: palette.diagramNode,
    componentStroke: palette.accent,
    componentLabelColor: palette.ink,
    linkStroke: palette.diagramLine,
    evolutionStroke: palette.diagramCritBorder,
    annotationStroke: palette.diagramLine,
    annotationTextColor: palette.ink,
    annotationFill: palette.surface,
  };

  return {
    variables,
    themeCSS: buildThemeCSS(kind, palette),
    c4: c4Config(palette),
  };
}

/** Diagram-specific Mermaid config; shared by the sandbox renderer. */
export function mermaidDiagramConfig(
  c4: Record<string, string>,
  elk?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(elk ? { elk } : {}),
    flowchart: {
      useMaxWidth: false,
      curve: "linear",
      padding: 14,
      nodeSpacing: 44,
      rankSpacing: 52,
    },
    sequence: {
      useMaxWidth: false,
      actorMargin: 76,
      boxMargin: 12,
      messageMargin: 36,
      mirrorActors: false,
    },
    gantt: {
      useMaxWidth: false,
      barHeight: 22,
      barGap: 4,
      topPadding: 40,
      leftPadding: 80,
      gridLineStartPadding: 20,
      fontSize: 13,
      sectionFontSize: 12,
      numberSectionStyles: 4,
    },
    pie: { useMaxWidth: false, textPosition: 0.6 },
    mindmap: { useMaxWidth: false, padding: 12, maxNodeWidth: 200, colorBy: "branch" },
    gitGraph: { useMaxWidth: false, diagramPadding: 12, rotateCommitLabel: false },
    journey: { useMaxWidth: false },
    xyChart: {
      useMaxWidth: false,
      width: 700,
      height: 500,
    },
    sankey: {
      useMaxWidth: false,
      width: 600,
      height: 400,
      linkColor: "gradient",
      nodeAlignment: "justify",
      showValues: true,
      nodeWidth: 10,
      nodePadding: 12,
      labelStyle: "legacy",
    },
    radar: {
      useMaxWidth: false,
      width: 600,
      height: 600,
    },
    c4: {
      useMaxWidth: false,
      diagramMarginX: 30,
      diagramMarginY: 0,
      c4ShapeMargin: 30,
      c4ShapePadding: 14,
      width: 200,
      height: 110,
      boxMargin: 10,
      boxTextMargin: 5,
      noteMargin: 10,
      messageMargin: 35,
      ...c4,
    },
  };
}

function stringArray(value: unknown, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "string")
  );
}

const PALETTE_STRING_FIELDS = [
  "fontFamily",
  "surface",
  "surfaceMuted",
  "ink",
  "inkMuted",
  "accent",
  "accentStrong",
  "diagramNode",
  "diagramLine",
  "diagramSurfaceAlt",
  "diagramBorder",
  "diagramGrid",
  "diagramActorLine",
  "diagramNote",
  "diagramNoteBorder",
  "diagramNoteText",
  "diagramTask",
  "diagramActive",
  "diagramDone",
  "diagramCrit",
  "diagramCritBorder",
  "diagramMilestone",
  "diagramExclude",
  "diagramOnAccent",
  "mindRootBg",
  "mindRootText",
  "mindLeafBg",
  "mindLeafText",
  "mindPillText",
] as const;

/**
 * Validates a palette that came over `postMessage`. The parent is trusted,
 * but the sandbox should still only feed strings into Mermaid's parser.
 */
export function sanitizeMermaidPalette(value: unknown): MermaidPalette | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (!PALETTE_STRING_FIELDS.every((field) => typeof candidate[field] === "string")) {
    return null;
  }
  if (!stringArray(candidate.cats, 8) || !stringArray(candidate.accents, 8)) {
    return null;
  }
  if (!Array.isArray(candidate.mindBranches) || candidate.mindBranches.length !== 4) {
    return null;
  }
  const branches: Array<{ pill: string; line: string }> = [];
  for (const entry of candidate.mindBranches) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const branch = entry as Record<string, unknown>;
    if (typeof branch.pill !== "string" || typeof branch.line !== "string") {
      return null;
    }
    branches.push({ pill: branch.pill, line: branch.line });
  }
  const c4 = candidate.c4;
  if (typeof c4 !== "object" || c4 === null) {
    return null;
  }
  const c4Record = c4 as Record<string, unknown>;
  for (const field of [
    "person",
    "personBorder",
    "system",
    "systemBorder",
    "external",
    "externalBorder",
  ]) {
    if (typeof c4Record[field] !== "string") {
      return null;
    }
  }

  return {
    ...(candidate as unknown as MermaidPalette),
    cats: [...candidate.cats],
    accents: [...candidate.accents],
    mindBranches: branches,
    c4: {
      person: c4Record.person as string,
      personBorder: c4Record.personBorder as string,
      system: c4Record.system as string,
      systemBorder: c4Record.systemBorder as string,
      external: c4Record.external as string,
      externalBorder: c4Record.externalBorder as string,
    },
  };
}

/** Small helper used by tests and by the renderer cache key. */
export function mermaidPaletteKey(theme: MermaidTheme): string {
  return `${MERMAID_THEME_VERSION}:${theme}`;
}
