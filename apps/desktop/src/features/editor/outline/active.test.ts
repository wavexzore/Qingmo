import { describe, expect, it } from "vitest";

import type { HeadingOutlineEntry, HeadingOutlineState } from "@qingmo/editor-core";

import { activeOutlineIndex, outlineStatusHint, type Translate } from "./active";

function entry(line: number): HeadingOutlineEntry {
  return {
    level: 1,
    text: `H${line}`,
    plainText: `H${line}`,
    from: line,
    to: line,
    line,
    lineFrom: line,
  };
}

function state(patch: Partial<HeadingOutlineState> = {}): HeadingOutlineState {
  return {
    entries: [entry(1), entry(5), entry(9)],
    status: "complete",
    limitReason: null,
    errorReason: null,
    treeComplete: true,
    ...patch,
  };
}

const t = ((key: string, options?: Record<string, unknown>) =>
  options?.count === undefined ? key : `${key}:${String(options.count)}`) as Translate;

describe("activeOutlineIndex", () => {
  it("returns -1 for an empty outline or a cursor before the first heading", () => {
    expect(activeOutlineIndex([], 1)).toBe(-1);
    expect(activeOutlineIndex(state().entries, 0)).toBe(-1);
  });

  it("returns the last heading at or before the cursor line", () => {
    const entries = state().entries;
    expect(activeOutlineIndex(entries, 1)).toBe(0);
    expect(activeOutlineIndex(entries, 4)).toBe(0);
    expect(activeOutlineIndex(entries, 5)).toBe(1);
    expect(activeOutlineIndex(entries, 9)).toBe(2);
    expect(activeOutlineIndex(entries, 99)).toBe(2);
  });
});

describe("outlineStatusHint", () => {
  it("returns null when the complete outline fits the panel", () => {
    expect(outlineStatusHint(state({ entries: [entry(1)] }), 1, t)).toBeNull();
  });

  it("reports panel truncation for a complete outline", () => {
    expect(outlineStatusHint(state(), 2, t)).toBe("editor:outline.limitPanel");
  });

  it("reports the size, count and error root causes before partial", () => {
    expect(outlineStatusHint(state({ status: "partial", limitReason: "size" }), 3, t)).toBe(
      "editor:outline.limitSize",
    );
    expect(outlineStatusHint(state({ status: "partial", limitReason: "count" }), 3, t)).toBe(
      "editor:outline.limitCount:3",
    );
    expect(outlineStatusHint(state({ status: "error" }), 3, t)).toBe("editor:outline.error");
  });

  it("distinguishes generating with and without a truncated panel", () => {
    expect(outlineStatusHint(state({ status: "partial" }), 3, t)).toBe("editor:outline.generating");
    expect(outlineStatusHint(state({ status: "partial" }), 2, t)).toBe(
      "editor:outline.generatingPanel",
    );
  });
});
