import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { OUTLINE_SCAN_MAX_UNITS, createEditorState } from "../index";
import { tocPreview } from "./toc";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, Math.min(doc.length, OUTLINE_SCAN_MAX_UNITS), 10_000);
  return state.update({}).state;
}

describe("tocPreview", () => {
  it("finds all three supported top-level placeholders", () => {
    const doc = "[TOC]\n\n[[_toc_]]\n\n<!-- toc -->\n\n# One\n\n## Two\n";
    const state = stateFor(doc);
    const toc = state.field(tocPreview);

    expect(toc.ranges).toHaveLength(3);
    expect(toc.headings.map((heading) => heading.text)).toEqual(["One", "Two"]);
  });

  it("ignores placeholders nested in blockquotes and lists", () => {
    const doc = "> [TOC]\n\n- [TOC]\n\n# One\n";
    const toc = stateFor(doc).field(tocPreview);
    expect(toc.ranges).toHaveLength(0);
  });

  it("renders at most 200 headings while the field may contain more", () => {
    const doc = `[TOC]\n\n${Array.from({ length: 250 }, (_, index) => `# H${index}`).join("\n\n")}`;
    const toc = stateFor(doc).field(tocPreview);
    expect(toc.ranges).toHaveLength(1);
    expect(toc.headings).toHaveLength(200);
    expect(toc.headings[199]?.text).toBe("H199");
  });

  it("keeps the >200k empty state", () => {
    const doc = `${"x\n".repeat(OUTLINE_SCAN_MAX_UNITS / 2)}[TOC]\n`;
    const toc = stateFor(doc).field(tocPreview);
    expect(toc.ranges).toHaveLength(0);
    expect(toc.headings).toHaveLength(0);
  });
});
