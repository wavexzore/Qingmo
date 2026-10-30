import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  KIND,
  MINIMAP_MAX_LINES,
  buildBlockBands,
  buildMinimapBuckets,
  computeMinimapWindow,
  computeSliderGeometry,
  createAnchorMap,
  docYToRail,
  docYToScrollTop,
  interpolateLineDocY,
  isEligible,
  lineAtDocY,
  nextVisibility,
  railToDocY,
  scanMinimapDocument,
  scrollTopToDocY,
} from "./model";

describe("scanMinimapDocument", () => {
  it("classifies headings, blocks and presentation rows", () => {
    const source = [
      "---",
      "title: x",
      "---",
      "# H1",
      "text",
      "Setext",
      "===",
      "```ts",
      "# inside fence",
      "```",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "> quote",
      "- item",
      "***",
      "![img](x)",
      "<details>",
      "html",
      "</details>",
      "$$",
      "math",
      "$$",
      "",
    ].join("\n");
    const { lines, blocks } = scanMinimapDocument(source, 4);

    expect(lines.kind[0]).toBe(KIND.frontmatter);
    expect(lines.kind[2]).toBe(KIND.frontmatter);
    expect(blocks[0]).toMatchObject({ kind: "frontmatter", fromLine: 0, toLine: 2 });

    expect(lines.kind[3]).toBe(KIND.heading);
    expect(lines.headingLevel[3]).toBe(1);
    expect(lines.kind[5]).toBe(KIND.heading);
    expect(lines.headingLevel[5]).toBe(1);
    expect(lines.kind[6]).toBe(KIND.blank);

    expect(lines.kind[7]).toBe(KIND.code);
    expect(lines.kind[8]).toBe(KIND.code);
    expect(lines.kind[9]).toBe(KIND.code);
    expect(blocks.find((block) => block.kind === "fence")).toMatchObject({
      fromLine: 7,
      toLine: 9,
      info: "ts",
    });

    expect(lines.kind[10]).toBe(KIND.table);
    expect(lines.kind[12]).toBe(KIND.table);
    expect(blocks.find((block) => block.kind === "table")).toMatchObject({
      fromLine: 10,
      toLine: 12,
    });

    expect(lines.kind[13]).toBe(KIND.quote);
    expect(lines.kind[14]).toBe(KIND.list);
    expect(lines.kind[15]).toBe(KIND.rule);
    expect(lines.kind[16]).toBe(KIND.html);
    expect(blocks.find((block) => block.kind === "media")).toMatchObject({
      fromLine: 16,
      toLine: 16,
    });
    expect(lines.kind[17]).toBe(KIND.html);
    expect(lines.kind[19]).toBe(KIND.html);
    expect(blocks.find((block) => block.kind === "html")).toMatchObject({
      fromLine: 17,
      toLine: 19,
    });
    expect(lines.kind[20]).toBe(KIND.code);
    expect(lines.kind[22]).toBe(KIND.code);
    expect(blocks.find((block) => block.kind === "math")).toMatchObject({
      fromLine: 20,
      toLine: 22,
    });
    expect(lines.kind[23]).toBe(KIND.blank);
  });

  it("marks Mermaid fences as diagram without leaking headings", () => {
    const { lines, blocks } = scanMinimapDocument(
      "```mermaid\ngraph TD\n# not a heading\n```\n",
      4,
    );
    expect(lines.kind[0]).toBe(KIND.diagram);
    expect(lines.kind[2]).toBe(KIND.diagram);
    expect(blocks[0]).toMatchObject({ kind: "fence", info: "mermaid" });
  });

  it("keeps a lone dash as text but honours setext underlines", () => {
    const one = scanMinimapDocument("Title\n-\n", 4);
    expect(one.lines.kind[0]).toBe(KIND.text);

    const two = scanMinimapDocument("Title\n--\n", 4);
    expect(two.lines.kind[0]).toBe(KIND.heading);
    expect(two.lines.headingLevel[0]).toBe(2);
  });

  it("accepts Text input and tabSize for indentation", () => {
    const text = Text.of(["\tindented", "  two"]);
    const four = scanMinimapDocument(text, 4).lines;
    const two = scanMinimapDocument(text, 2).lines;
    expect(four.indent[0]).toBe(4);
    expect(two.indent[0]).toBe(2);
    expect(four.indent[1]).toBe(2);
  });

  it("handles empty and single-line documents", () => {
    const empty = scanMinimapDocument("", 4);
    expect(empty.lines.count).toBe(1);
    expect(empty.lines.kind[0]).toBe(KIND.blank);

    const single = scanMinimapDocument("hello", 4);
    expect(single.lines.count).toBe(1);
    expect(single.lines.kind[0]).toBe(KIND.text);
  });
});

describe("anchor interpolation and mapping", () => {
  it("interpolates every line and preserves the mapping endpoints", () => {
    const map = createAnchorMap(
      [
        { line: 0, docY: 0 },
        { line: 2, docY: 30 },
        { line: 4, docY: 60 },
      ],
      5,
      100,
      6,
      88,
    );

    expect([...map.lineDocY]).toEqual([0, 15, 30, 45, 60]);
    expect(map.docYToRail(0)).toBe(6);
    expect(map.docYToRail(100)).toBe(94);
    expect(map.railToDocY(6)).toBe(0);
    expect(map.railToDocY(94)).toBe(100);
    expect(map.railToDocY(map.docYToRail(42))).toBeCloseTo(42, 4);
  });

  it("drops duplicate docY samples from giant widgets but stays monotonic", () => {
    const lineDocY = interpolateLineDocY(
      [
        { line: 0, docY: 0 },
        { line: 2, docY: 10 },
        { line: 4, docY: 10 },
        { line: 5, docY: 100 },
      ],
      5,
    );

    expect([...lineDocY]).toEqual([0, 5, 10, 40, 70]);
    expect(lineDocY[0]).toBeLessThanOrEqual(lineDocY[1]!);
    expect(lineDocY[1]).toBeLessThanOrEqual(lineDocY[2]!);
    expect(lineDocY[2]).toBeLessThanOrEqual(lineDocY[3]!);
    expect(lineDocY[3]).toBeLessThanOrEqual(lineDocY[4]!);
  });

  it("keeps the virtual terminal even when it shares the last docY", () => {
    const lineDocY = interpolateLineDocY(
      [
        { line: 0, docY: 0 },
        { line: 0, docY: 0 },
      ],
      1,
    );
    expect([...lineDocY]).toEqual([0]);
  });
});

describe("buckets, bands and slider", () => {
  it("aggregates by bucket and keeps block bands at least one bucket tall", () => {
    const { lines, blocks } = scanMinimapDocument("# H\n```ts\ncode\n```\n| A |\n| --- |\n", 4);
    const map = createAnchorMap(
      [
        { line: 0, docY: 0 },
        { line: 5, docY: 100 },
      ],
      6,
      100,
      0,
      10,
    );
    const buckets = buildMinimapBuckets(lines, map.lineDocY, map, 0, 10, 76);
    expect(buckets).toHaveLength(10);
    expect(buckets.some((bucket) => bucket.kind === KIND.heading)).toBe(true);
    expect(buckets.some((bucket) => bucket.kind === KIND.code)).toBe(true);

    const bands = buildBlockBands(blocks, map.lineDocY, map, 5, 0, 10);
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      expect(band.toBucket - band.fromBucket).toBeGreaterThanOrEqual(1);
      expect(band.fromBucket).toBeGreaterThanOrEqual(0);
      expect(band.toBucket).toBeLessThanOrEqual(10);
    }
  });

  it("clamps the slider to the track and enforces a 24px minimum", () => {
    const top = computeSliderGeometry({
      docHeight: 1000,
      trackTop: 6,
      trackHeight: 100,
      scrollTop: 28,
      clientHeight: 200,
      paddingTop: 28,
    });
    expect(top.top).toBe(6);
    expect(top.height).toBe(24);

    const bottom = computeSliderGeometry({
      docHeight: 1000,
      trackTop: 6,
      trackHeight: 100,
      scrollTop: 828,
      clientHeight: 200,
      paddingTop: 28,
    });
    expect(bottom.top + bottom.height).toBeLessThanOrEqual(106);
    expect(bottom.top).toBeGreaterThanOrEqual(6);
  });

  it("computes a VS Code-style window with top padding and bottom clamping", () => {
    expect(
      computeMinimapWindow({
        lineCount: 10,
        viewportStartLine: 0,
        sliderTop: 6,
        trackTop: 6,
        lineHeight: 3,
        trackHeight: 30,
      }),
    ).toEqual({ startLine: 0, paddingLines: 0, lineCount: 10 });

    expect(
      computeMinimapWindow({
        lineCount: 100,
        viewportStartLine: 0,
        sliderTop: 15,
        trackTop: 6,
        lineHeight: 3,
        trackHeight: 30,
      }),
    ).toEqual({ startLine: 0, paddingLines: 3, lineCount: 7 });

    expect(
      computeMinimapWindow({
        lineCount: 100,
        viewportStartLine: 50,
        sliderTop: 21,
        trackTop: 6,
        lineHeight: 3,
        trackHeight: 30,
      }),
    ).toEqual({ startLine: 45, paddingLines: 0, lineCount: 10 });

    expect(
      computeMinimapWindow({
        lineCount: 100,
        viewportStartLine: 99,
        sliderTop: 33,
        trackTop: 6,
        lineHeight: 3,
        trackHeight: 30,
      }),
    ).toEqual({ startLine: 90, paddingLines: 0, lineCount: 10 });
  });

  it("finds the source line containing a document coordinate", () => {
    const lineDocY = new Float64Array([0, 10, 20]);
    expect(lineAtDocY(lineDocY, 0)).toBe(0);
    expect(lineAtDocY(lineDocY, 5)).toBe(0);
    expect(lineAtDocY(lineDocY, 10)).toBe(1);
    expect(lineAtDocY(lineDocY, 20)).toBe(2);
    expect(lineAtDocY(lineDocY, 100)).toBe(2);
  });

  it("uses one document axis with the 28px padding contract", () => {
    expect(scrollTopToDocY(0, 28, 1000)).toBe(0);
    expect(scrollTopToDocY(28, 28, 1000)).toBe(0);
    // A document coordinate is relative to the first line; placing it at the
    // viewport top therefore includes the 28px content padding. The top of the
    // rail is the non-invertible clamp region (scrollTop 0..28 all map to 0).
    expect(docYToScrollTop(0, 28, 900, 0)).toBe(28);
    expect(docYToScrollTop(1000, 28, 900, 0)).toBe(900);
    expect(docYToScrollTop(500, 28, 900, 100)).toBe(428);
  });
});

describe("visibility policy", () => {
  it("applies width hysteresis without reading geometry or line count", () => {
    expect(isEligible({ lines: 1, units: 100, editorWidth: 640, wasVisible: false })).toBe(true);
    expect(isEligible({ lines: 1, units: 100, editorWidth: 639, wasVisible: false })).toBe(false);
    expect(isEligible({ lines: 5, units: 100, editorWidth: 624, wasVisible: true })).toBe(true);
    expect(isEligible({ lines: 5, units: 100, editorWidth: 623, wasVisible: true })).toBe(false);
    expect(isEligible({ lines: 80, units: 100, editorWidth: 623, wasVisible: false })).toBe(false);
  });

  it("hides oversized documents immediately and requires real scroll", () => {
    expect(
      isEligible({
        lines: MINIMAP_MAX_LINES + 1,
        units: 100,
        editorWidth: 1000,
        wasVisible: true,
      }),
    ).toBe(false);
    expect(
      isEligible({
        lines: 100,
        units: 2_000_001,
        editorWidth: 1000,
        wasVisible: true,
      }),
    ).toBe(false);
    expect(
      nextVisibility({
        lines: 100,
        units: 1000,
        editorWidth: 1000,
        wasVisible: false,
        scrollHeight: 100,
        clientHeight: 100,
      }),
    ).toBe("hidden");
    expect(
      nextVisibility({
        lines: 1,
        units: 1000,
        editorWidth: 1000,
        wasVisible: false,
        scrollHeight: 102,
        clientHeight: 100,
      }),
    ).toBe("visible");
  });

  it("round-trips rail coordinates with clamping", () => {
    expect(docYToRail(-10, 100, 6, 88)).toBe(6);
    expect(docYToRail(120, 100, 6, 88)).toBe(94);
    expect(railToDocY(0, 100, 6, 88)).toBe(0);
    expect(railToDocY(120, 100, 6, 88)).toBe(100);
  });
});
