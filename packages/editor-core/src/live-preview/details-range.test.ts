import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { OUTLINE_SCAN_MAX_UNITS, createEditorState } from "../index";
import { readDetailsRanges } from "./details-range";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, Math.min(doc.length, OUTLINE_SCAN_MAX_UNITS), 10_000);
  return state.update({}).state;
}

describe("readDetailsRanges", () => {
  it("returns closed top-level details ranges", () => {
    const doc = "before\n\n<details>\n<summary>x</summary>\n\nbody\n\n</details>\n\nafter\n";
    const ranges = readDetailsRanges(stateFor(doc));
    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0]?.from, ranges[0]?.to)).toContain("<details>");
    expect(doc.slice(ranges[0]?.from, ranges[0]?.to)).toContain("</details>");
  });

  it("ignores unclosed details", () => {
    expect(readDetailsRanges(stateFor("<details>\n\nbody\n"))).toHaveLength(0);
  });

  it("covers nested details with one outer range", () => {
    const doc = "<details>\n<details>\n<summary>inner</summary>\n\nx\n\n</details>\n\n</details>\n";
    const ranges = readDetailsRanges(stateFor(doc));
    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0]?.from, ranges[0]?.to)).toContain("inner");
  });

  it("returns no ranges above the preview cap", () => {
    const doc = `${"x\n".repeat(OUTLINE_SCAN_MAX_UNITS / 2)}<details>\n\nx\n\n</details>\n`;
    expect(readDetailsRanges(stateFor(doc))).toHaveLength(0);
  });
});
