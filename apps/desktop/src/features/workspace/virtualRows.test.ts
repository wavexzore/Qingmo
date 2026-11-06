import { describe, expect, it } from "vitest";

import { visibleRange } from "./virtualRows";

describe("visibleRange", () => {
  it("returns an empty range for zero or invalid rows", () => {
    expect(visibleRange(0, 0, 600)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-5, 0, 600)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(Number.NaN, 0, 600)).toEqual({ start: 0, end: 0 });
  });

  it("adds overscan around one small viewport", () => {
    expect(visibleRange(1, 0, 280)).toEqual({ start: 0, end: 1 });
    expect(visibleRange(100, 0, 280, 28, 8)).toEqual({ start: 0, end: 18 });
  });

  it("clamps a scroll position beyond the list", () => {
    expect(visibleRange(10, 10_000, 280)).toEqual({ start: 9, end: 10 });
  });

  it("clamps when the row count shrinks after scrolling", () => {
    expect(visibleRange(3, 700, 600, 28, 8)).toEqual({ start: 2, end: 3 });
  });

  it("keeps the last 10k rows inside the documented window", () => {
    const range = visibleRange(10_000, 140_000, 560, 28, 8);
    expect(range.start).toBe(4992);
    expect(range.end).toBe(5028);
    expect(range.end - range.start).toBeLessThanOrEqual(36);
  });

  it("clamps negative and non-finite viewport inputs", () => {
    expect(visibleRange(100, -50, -10)).toEqual({ start: 0, end: 8 });
    expect(visibleRange(100, Number.NaN, Number.POSITIVE_INFINITY, 28, 8)).toEqual({
      start: 0,
      end: 8,
    });
  });
});
