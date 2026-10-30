import { ensureSyntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import {
  OUTLINE_SAFETY_MAX_ENTRIES,
  OUTLINE_SCAN_MAX_UNITS,
  buildHeadingOutline,
  createEditorState,
  headingOutline,
  readDetailsRanges,
  readHeadingOutline,
  sameHeadingOutline,
  type HeadingOutlineState,
} from "../index";

function stateFor(doc: string) {
  let state = createEditorState({ doc });
  ensureSyntaxTree(state, Math.min(doc.length, OUTLINE_SCAN_MAX_UNITS), 10_000);
  // ensureSyntaxTree advances the parse context; an empty transaction
  // publishes the completed tree to state fields.
  state = state.update({}).state;
  return state;
}

function markdownState(doc: string) {
  return EditorState.create({ doc, extensions: [markdown()] });
}

describe("headingOutline", () => {
  it("collects ATX headings with levels, text and line positions", () => {
    const state = stateFor("# One\n\n## Two\n\n###### Six\n");
    const outline = readHeadingOutline(state);

    expect(outline.entries).toMatchObject([
      { level: 1, text: "One", line: 1, lineFrom: 0 },
      { level: 2, text: "Two", line: 3, lineFrom: 7 },
      { level: 6, text: "Six", line: 5, lineFrom: 15 },
    ]);
    expect(outline.status).toBe("complete");
  });

  it("collects Setext headings without the underline", () => {
    const state = stateFor("Title\n=====\n\nSubtitle\n--------\n");
    expect(readHeadingOutline(state).entries.map((entry) => [entry.level, entry.text])).toEqual([
      [1, "Title"],
      [2, "Subtitle"],
    ]);
  });

  it("excludes frontmatter, fenced/indented code and closed details", () => {
    const doc = [
      "---",
      "title: hidden",
      "---",
      "",
      "# Before",
      "",
      "```md",
      "# inside fence",
      "```",
      "",
      "    # inside indent",
      "",
      "<details>",
      "<summary>More</summary>",
      "",
      "# Hidden by details",
      "",
      "</details>",
      "",
      "# After",
      "",
    ].join("\n");
    const state = stateFor(doc);

    const details = readDetailsRanges(state);
    expect(details).toHaveLength(1);
    expect(doc.slice(details[0]?.from, details[0]?.to)).toContain("# Hidden by details");
    expect(readHeadingOutline(state).entries.map((entry) => entry.text)).toEqual([
      "Before",
      "After",
    ]);
  });

  it("keeps duplicate headings and skips empty ones", () => {
    const state = stateFor("# Same\n\n# Same\n\n#\n");
    expect(readHeadingOutline(state).entries.map((entry) => entry.text)).toEqual(["Same", "Same"]);
  });

  it("keeps CJK/emoji text and UTF-16 offsets stable", () => {
    const state = stateFor("# 标题😀\n");
    const entry = readHeadingOutline(state).entries[0];
    expect(entry).toMatchObject({ text: "标题😀", plainText: "标题😀", from: 0, line: 1 });
    expect(entry?.to).toBe(state.doc.line(1).to);
  });

  it("caps the field at 5000 entries and reports count", () => {
    const doc = Array.from({ length: OUTLINE_SAFETY_MAX_ENTRIES + 1 }, (_, index) => {
      return `# H${index}`;
    }).join("\n\n");
    const outline = readHeadingOutline(stateFor(doc));

    expect(outline.entries).toHaveLength(OUTLINE_SAFETY_MAX_ENTRIES);
    expect(outline.entries[499]).toMatchObject({ text: "H499" });
    expect(outline.status).toBe("partial");
    expect(outline.limitReason).toBe("count");
  });

  it("limits a large document to the 200k prefix and reports size only when the tree covers it", () => {
    const prefix = "# Start\n\n";
    const doc = `${prefix}${"x".repeat(OUTLINE_SCAN_MAX_UNITS)}# At 200k+\n`;
    const state = stateFor(doc);
    const outline = readHeadingOutline(state);

    expect(outline.entries.map((entry) => entry.text)).toEqual(["Start"]);
    expect(outline.status).toBe("partial");
    expect(outline.limitReason).toBe("size");
    expect(outline.treeComplete).toBe(true);
  });

  it("does not report size while the syntax tree is still short", () => {
    const doc = `${"paragraph\n\n".repeat(5_000)}# Late\n`;
    const state = createEditorState({ doc });
    const outline = readHeadingOutline(state);

    expect(outline.entries).toHaveLength(0);
    expect(outline.status).toBe("partial");
    expect(outline.limitReason).toBeNull();
    expect(outline.treeComplete).toBe(false);
  });

  it("keeps the field reference for selection-only transactions", () => {
    const state = stateFor("# A\n\nB\n");
    const before = state.field(headingOutline);
    const after = state.update({ selection: { anchor: 1 } }).state.field(headingOutline);
    expect(after).toBe(before);
  });

  it("compares outline values without relying on object identity", () => {
    const one = readHeadingOutline(stateFor("# A\n"));
    const same: HeadingOutlineState = {
      ...one,
      entries: one.entries.map((entry) => ({ ...entry })),
    };
    expect(sameHeadingOutline(one, same)).toBe(true);
    expect(
      sameHeadingOutline(one, {
        ...same,
        entries: same.entries.map((entry) => ({ ...entry, text: "B" })),
      }),
    ).toBe(false);
  });

  it("falls back to a direct build when the state has no field", () => {
    const doc = "# A\n\n## B\n";
    let state = markdownState(doc);
    ensureSyntaxTree(state, doc.length, 10_000);
    state = state.update({}).state;
    expect(state.field(headingOutline, false)).toBeUndefined();
    expect(readHeadingOutline(state).entries.map((entry) => entry.text)).toEqual(["A", "B"]);
  });

  it("builds from an arbitrary state without mutating it", () => {
    const state = stateFor("# A\n");
    expect(buildHeadingOutline(state).entries).toHaveLength(1);
    expect(state.doc.toString()).toBe("# A\n");
  });

  it("advances the initial tree through the view driver", async () => {
    const doc = `# First\n\n${"filler line\n".repeat(1_500)}# Late\n`;
    const state = createEditorState({ doc });
    expect(readHeadingOutline(state).entries.map((entry) => entry.text)).toEqual(["First"]);

    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state, parent });
    try {
      await vi.waitFor(
        () => {
          expect(readHeadingOutline(view.state).entries.map((entry) => entry.text)).toContain(
            "Late",
          );
        },
        { timeout: 5_000, interval: 20 },
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
