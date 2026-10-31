import { describe, expect, it } from "vitest";

import {
  buildPersonSilhouette,
  extendSequenceLifelines,
  externalTypeLabel,
  isVerticalBackEdge,
  terminalArrowOverlap,
  type NodeBox,
} from "./mermaid-postprocess";

function box(overrides: Partial<NodeBox> = {}): NodeBox {
  return {
    left: 0,
    right: 100,
    top: 0,
    bottom: 50,
    cx: 50,
    cy: 25,
    width: 100,
    height: 50,
    ...overrides,
  };
}

describe("C4 person silhouette", () => {
  it("merges the head and body into one closed outline", () => {
    const path = buildPersonSilhouette(0, 0, 200, 80, 30, 100, -40, 46);
    expect(path).not.toBeNull();
    expect(path).toContain("A46,46 0 1 1");
    expect(path?.startsWith("M0,30")).toBe(true);
    expect(path?.endsWith("Z")).toBe(true);
  });

  it("leaves shapes that do not overlap untouched", () => {
    expect(buildPersonSilhouette(0, 0, 200, 80, 30, 100, 200, 46)).toBeNull();
    expect(buildPersonSilhouette(0, 0, 0, 80, 30, 100, -20, 46)).toBeNull();
  });

  it("normalises external C4 type labels", () => {
    expect(externalTypeLabel("c4-external_system")).toBe("External System");
    expect(externalTypeLabel("c4-external_person")).toBe("External Person");
    expect(externalTypeLabel("c4-person")).toBeNull();
  });
});

describe("overlapping terminal arrowheads", () => {
  it("merges two nearly identical terminal approaches", () => {
    const overlap = terminalArrowOverlap(
      { start: { x: 169, y: 279 }, end: { x: 169, y: 299 } },
      { start: { x: 167, y: 259 }, end: { x: 167, y: 299 } },
    );
    expect(overlap).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps side-by-side approaches with insufficient overlap", () => {
    expect(
      terminalArrowOverlap(
        { start: { x: 0, y: 0 }, end: { x: 0, y: 20 } },
        { start: { x: 10, y: 0 }, end: { x: 10, y: 20 } },
      ),
    ).toBeLessThan(0.8);
    expect(
      terminalArrowOverlap(
        { start: { x: 0, y: 0 }, end: { x: 0, y: 20 } },
        { start: { x: 0, y: 10 }, end: { x: 0, y: 30 } },
      ),
    ).toBe(0);
  });

  it("counts a longitudinal offset against the arrowhead length", () => {
    expect(
      terminalArrowOverlap(
        { start: { x: 0, y: 0 }, end: { x: 0, y: 20 } },
        { start: { x: 0, y: 2 }, end: { x: 0, y: 22 } },
      ),
    ).toBeCloseTo(0.8, 5);
  });

  it("does not merge arrows entering from opposite directions", () => {
    expect(
      terminalArrowOverlap(
        { start: { x: 0, y: 0 }, end: { x: 0, y: 20 } },
        { start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
      ),
    ).toBe(0);
  });

  it("accepts collinear diagonal approaches", () => {
    expect(
      terminalArrowOverlap(
        { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
        { start: { x: 2, y: 2 }, end: { x: 9, y: 9 } },
      ),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it("ignores very short stubs", () => {
    expect(
      terminalArrowOverlap(
        { start: { x: 0, y: 0 }, end: { x: 0, y: 4 } },
        { start: { x: 0, y: 0 }, end: { x: 0, y: 4 } },
      ),
    ).toBe(0);
  });
});

describe("vertical back-edge routing contract", () => {
  it("accepts a direct upward edge in the same column", () => {
    const source = box({ top: 200, bottom: 250, cy: 225 });
    const target = box({ top: 0, bottom: 50, cy: 25 });
    expect(isVerticalBackEdge(source, target)).toBe(true);
  });

  it("rejects forward, side-by-side and diagonal edges", () => {
    const source = box({ top: 200, bottom: 250, cy: 225 });
    const target = box({ top: 300, bottom: 350, cy: 325 });
    expect(isVerticalBackEdge(source, target)).toBe(false);

    const shifted = box({ left: 300, right: 400, cx: 350, top: 0, bottom: 50, cy: 25 });
    expect(isVerticalBackEdge(source, shifted)).toBe(false);

    const close = box({ top: 190, bottom: 210, cy: 200 });
    expect(isVerticalBackEdge(source, close)).toBe(false);
  });
});

describe("sequence lifeline extension", () => {
  function lifelines(...ends: number[]): SVGSVGElement {
    const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const end of ends) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "actor-line 200");
      line.setAttribute("data-et", "life-line");
      line.setAttribute("y2", String(end));
      root.append(line);
    }
    return root;
  }

  function ends(root: SVGSVGElement): number[] {
    return [...root.querySelectorAll("line")].map((line) => Number(line.getAttribute("y2")));
  }

  it("extends untouched default lifelines to the content bottom", () => {
    const root = lifelines(2000, 2000);
    expect(extendSequenceLifelines(root, 3200)).toBe(2);
    expect(ends(root)).toEqual([3200, 3200]);
  });

  it("keeps lifelines shortened by destroy participants", () => {
    const root = lifelines(2000, 1400);
    expect(extendSequenceLifelines(root, 3200)).toBe(1);
    expect(ends(root)).toEqual([3200, 1400]);
  });

  it("leaves lifelines that already reach the content untouched", () => {
    const root = lifelines(2000);
    expect(extendSequenceLifelines(root, 1800)).toBe(0);
    expect(ends(root)).toEqual([2000]);
  });
});
