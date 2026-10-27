import { describe, expect, it } from "vitest";

import {
  buildMermaidTheme,
  diagramInfo,
  diagramKind,
  mermaidElkConfig,
  mermaidLayout,
  resolveMermaidPalette,
  sanitizeMermaidPalette,
  type MermaidPalette,
} from "./mermaid-theme";

describe("diagramInfo", () => {
  it.each([
    ["flowchart TB\n  A --> B", "flowchart", "流程图"],
    ["graph LR\n  A --> B", "flowchart", "流程图"],
    ["flowchart-elk TD\n  A --> B", "flowchart", "流程图"],
    ["sequenceDiagram\n  A->>B: hi", "sequence", "时序图"],
    ["classDiagram\n  A <|-- B", "class", "类图"],
    ["stateDiagram-v2\n  [*] --> A", "state", "状态图"],
    ["erDiagram\n  A ||--o{ B : has", "er", "ER 图"],
    ["gantt\n  title Plan", "gantt", "甘特图"],
    ['pie\n  "A" : 1', "pie", "饼图"],
    ["quadrantChart\n  A: [0.1, 0.2]", "quadrant", "象限图"],
    ["mindmap\n  root((Qingmo))", "mindmap", "思维导图"],
    ["gitGraph\n  commit", "git", "Git 图"],
    ["gitGraph LR:\n  commit", "git", "Git 图"],
    ['C4Context\n  Person(a, "A")', "c4", "C4 架构图"],
    ['C4Container\n  System(a, "A")', "c4", "C4 架构图"],
    ["journey\n  title Day", "journey", "用户旅程"],
    ["timeline\n  2026 : launch", "timeline", "时间线"],
    ["requirementDiagram\n  requirement a", "requirement", "需求图"],
    ["sankey-beta\n  A,B,1", "sankey", "桑基图"],
    ["xychart-beta\n  bar [1]", "xychart", "XY 图表"],
    ["block-beta\n  a", "block", "块图"],
    ['packet-beta\n  0-10: "a"', "packet", "数据包图"],
    ["architecture-beta\n  service a", "architecture", "架构图"],
    ["kanban\n  todo[Todo]", "kanban", "看板"],
    ["radar-beta\n  axis a", "radar", "雷达图"],
    ['treemap-beta\n  "A": 1', "treemap", "矩形树图"],
    ['ishikawa-beta\n  "A"', "ishikawa", "鱼骨图"],
    ["wardley-beta\n  component A", "wardley", "沃德利图"],
    ["zenuml\n  A->B: hi", "zenuml", "ZenUML 时序图"],
    ["info\n  showInfo", "info", "说明"],
  ])("recognises %s", (code, kind, label) => {
    expect(diagramInfo(code)).toEqual({ kind, label });
  });

  it("skips front matter, comments and init directives", () => {
    const code = [
      "---",
      "title: Example",
      "---",
      '%%{init: {"theme": "base"}}%%',
      "%% a comment",
      "sequenceDiagram",
      "  A->>B: hi",
    ].join("\n");
    expect(diagramKind(code)).toBe("sequence");
  });

  it("falls back to the generic label", () => {
    expect(diagramInfo("not-a-diagram")).toEqual({ kind: "unknown", label: "图表" });
  });
});

describe("mermaidLayout", () => {
  const subgraphs = (count: number): string =>
    [
      "flowchart TB",
      ...Array.from(
        { length: count },
        (_, index) => `  subgraph S${index}["S${index}"]\n    A${index}\n  end`,
      ),
    ].join("\n");

  it("routes large multi-subgraph flowcharts with the model-order ELK layout", () => {
    expect(mermaidLayout("flowchart", subgraphs(2))).toBeUndefined();
    expect(mermaidLayout("flowchart", subgraphs(3))).toBe("elk");
    expect(
      mermaidLayout("flowchart", subgraphs(3).replace("flowchart TB", "flowchart-elk TB")),
    ).toBeUndefined();
    expect(mermaidLayout("sequence", "sequenceDiagram\n  A->>B: hi")).toBeUndefined();
  });

  it("keeps source order, entry nodes on top and crossing hops for dense graphs", () => {
    expect(mermaidElkConfig()).toMatchObject({
      preset: "modelOrder",
      forceNodeModelOrder: true,
      keepEntryNodeOnTop: true,
      mergeEdges: false,
      lineHops: true,
    });
  });
});

describe("Mermaid theme mapping", () => {
  const palette = resolveMermaidPalette("default");

  it("resolves a complete fallback palette", () => {
    expect(palette.surface).toMatch(/^(#|rgb)/);
    expect(palette.cats).toHaveLength(8);
    expect(palette.accents).toHaveLength(8);
    expect(palette.mindBranches).toHaveLength(4);
    expect(palette.c4.person).toMatch(/^(#|rgb)/);
  });

  it("maps semantic tokens onto Mermaid variables", () => {
    const built = buildMermaidTheme("default", "flowchart", palette);
    expect(built.variables.darkMode).toBe(false);
    expect(built.variables.primaryColor).toBe(palette.diagramNode);
    expect(built.variables.nodeBorder).toBe(palette.accent);
    expect(built.variables.lineColor).toBe(palette.diagramLine);
    expect(built.variables.edgeLabelBackground).toBe(palette.surface);
    expect(built.variables.cScale0).toBe(palette.cats[0]);
    expect(built.variables.git0).toBe(palette.accents[0]);
    expect(built.variables.pie9).toBe(palette.cats[0]);
  });

  it("keeps dark mode and the C4 shape palette", () => {
    const built = buildMermaidTheme("dark", "c4", resolveMermaidPalette("dark"));
    expect(built.variables.darkMode).toBe(true);
    expect(built.c4.person_bg_color).toBeTruthy();
    expect(built.c4.external_system_bg_color).toBeTruthy();
    expect(built.themeCSS).toContain('text[fill="#444444"]');
  });

  it("injects mindmap and Git CSS only for their own diagram kinds", () => {
    const mind = buildMermaidTheme("default", "mindmap", palette);
    expect(mind.themeCSS).toContain(".mindmap-node.mind-depth-1.section-0");
    expect(mind.themeCSS).toContain(".edgePaths path.edge-depth-1");

    const git = buildMermaidTheme("default", "git", palette);
    expect(git.themeCSS).toContain(".arrow { stroke-width: 2.5px");

    const flow = buildMermaidTheme("default", "flowchart", palette);
    expect(flow.themeCSS).not.toContain(".mindmap-node");
    expect(flow.themeCSS).not.toContain(".arrow { stroke-width");
  });

  it("accepts only structurally valid palettes from postMessage", () => {
    expect(sanitizeMermaidPalette(palette)).not.toBeNull();
    expect(sanitizeMermaidPalette({ ...palette, cats: ["#fff"] })).toBeNull();
    expect(sanitizeMermaidPalette({ ...palette, surface: 42 })).toBeNull();
    expect(sanitizeMermaidPalette({ ...palette, mindBranches: [] })).toBeNull();
    expect(
      sanitizeMermaidPalette({
        ...palette,
        c4: { ...palette.c4, person: undefined },
      }),
    ).toBeNull();
  });

  it("resolves scoped CSS variables when a root is provided", () => {
    const scope = document.createElement("div");
    scope.style.setProperty("--qm-surface", "#123456");
    document.body.append(scope);
    const scoped: MermaidPalette = resolveMermaidPalette("default", scope);
    scope.remove();
    expect(scoped.surface).toBe("#123456");
  });

  it("does not leave measurement probes in the document", () => {
    const before = document.body.childElementCount;
    resolveMermaidPalette("default");
    resolveMermaidPalette("dark");
    expect(document.body.childElementCount).toBe(before);
  });
});
