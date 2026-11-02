import { describe, expect, it } from "vitest";

import {
  centeredLabelTransform,
  fittedLabelFontSize,
  fitMermaidNodeLabels,
} from "./mermaid-labels";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Box {
  width: number;
  height?: number;
}

function node(fixture: { labelWidth: number; shapeWidth: number; transform?: string }): {
  root: SVGSVGElement;
  label: SVGGElement;
  text: SVGTextElement;
  shape: SVGRectElement;
} {
  const root = document.createElementNS(SVG_NS, "svg");
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "node");
  const shape = document.createElementNS(SVG_NS, "rect");
  const label = document.createElementNS(SVG_NS, "g");
  label.setAttribute("class", "label");
  label.setAttribute("transform", fixture.transform ?? "translate(-20, -11)");
  const text = document.createElementNS(SVG_NS, "text");
  text.style.textAnchor = "middle";
  text.style.fontSize = "14px";
  label.append(text);
  group.append(shape, label);
  root.append(group);

  const sizes = new Map<Element, Box>([
    [shape, { width: fixture.shapeWidth }],
    [label, { width: fixture.labelWidth }],
  ]);
  for (const element of [shape, label]) {
    element.getBBox = () => {
      const box = sizes.get(element) ?? { width: 0 };
      return { x: 0, y: 0, width: box.width, height: box.height ?? 20 } as DOMRect;
    };
  }
  return { root, label, text, shape };
}

describe("centered label transform", () => {
  it("drops only the horizontal component", () => {
    expect(centeredLabelTransform("translate(-20.5, -11.25)")).toBe("translate(0, -11.25)");
    expect(centeredLabelTransform("translate(0, -11)")).toBe("translate(0, -11)");
  });

  it("ignores transforms it cannot parse", () => {
    expect(centeredLabelTransform(null)).toBeNull();
    expect(centeredLabelTransform("scale(2)")).toBeNull();
    expect(centeredLabelTransform("translate(a, 4)")).toBeNull();
  });
});

describe("fitted label font size", () => {
  it("shrinks an overflowing label to the padded shape width", () => {
    expect(fittedLabelFontSize(14, 140, 100)).toBe(10);
    expect(fittedLabelFontSize(14, 140, 120)).toBeCloseTo(10.4, 5);
  });

  it("keeps labels that already fit", () => {
    expect(fittedLabelFontSize(14, 80, 100)).toBeNull();
    expect(fittedLabelFontSize(14, 84, 100)).toBeNull();
  });

  it("never grows and respects the readability floor", () => {
    expect(fittedLabelFontSize(14, 400, 100)).toBe(10);
    expect(fittedLabelFontSize(10, 200, 100)).toBeNull();
    expect(fittedLabelFontSize(14, 0, 100)).toBeNull();
    expect(fittedLabelFontSize(14, 100, 0)).toBeNull();
  });
});

describe("flowchart node labels", () => {
  it("re-centres a label that Mermaid pushed half a width to the left", () => {
    const { root, label } = node({ labelWidth: 80, shapeWidth: 120 });
    expect(fitMermaidNodeLabels(root, "flowchart")).toBe(1);
    expect(label.getAttribute("transform")).toBe("translate(0, -11)");
  });

  it("shrinks a label that is wider than its shape", () => {
    const { root, text } = node({ labelWidth: 140, shapeWidth: 120 });
    expect(fitMermaidNodeLabels(root, "flowchart")).toBe(1);
    expect(text.style.fontSize).toBe("10.4px");
  });

  it("leaves fitting labels and non-guarded anchors untouched", () => {
    const { root, label, text } = node({ labelWidth: 80, shapeWidth: 140 });
    text.style.textAnchor = "start";
    expect(fitMermaidNodeLabels(root, "flowchart")).toBe(0);
    expect(label.getAttribute("transform")).toBe("translate(-20, -11)");
  });

  it("includes nodes nested in subgraphs and skips other diagram kinds", () => {
    const { root, label } = node({ labelWidth: 140, shapeWidth: 100 });
    const cluster = document.createElementNS(SVG_NS, "g");
    cluster.setAttribute("class", "cluster");
    cluster.append(root.querySelector("g.node") as SVGGElement);
    root.append(cluster);
    expect(fitMermaidNodeLabels(root, "flowchart")).toBe(1);
    expect(label.getAttribute("transform")).toBe("translate(0, -11)");
    expect(fitMermaidNodeLabels(root, "state")).toBe(0);
  });
});
