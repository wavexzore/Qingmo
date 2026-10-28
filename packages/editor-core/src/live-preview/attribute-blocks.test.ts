import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import {
  parseAttributes,
  readAttributeAnchors,
  readAttributeLine,
  readTrailingAttributes,
} from "./attribute-blocks";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

describe("attribute blocks", () => {
  it("parses classes, ids and key/value pairs", () => {
    const parsed = parseAttributes('.warning #custom-id width=200 height="100"');
    expect(parsed.classes).toEqual(["warning"]);
    expect(parsed.id).toBe("custom-id");
    expect(parsed.values.get("width")).toBe("200");
    expect(parsed.values.get("height")).toBe("100");
  });

  it("reads attributes directly after an image", () => {
    const state = stateFor("![alt](./pic.png){width=200 height=100}\n");
    const image = state.doc.toString().indexOf(")") + 1;
    const range = readTrailingAttributes(state.doc, {
      from: 0,
      to: image,
      name: "Image",
      firstChild: null,
      nextSibling: null,
      parent: null,
    });
    expect(range?.values.get("width")).toBe("200");
    if (!range) {
      throw new Error("expected trailing attributes");
    }
    expect(state.doc.sliceString(range.from, range.to)).toBe("{width=200 height=100}");
  });

  it("reads a standalone paragraph attribute line", () => {
    const state = stateFor("一段文字\n{: .warning #custom-id}\n");
    const paragraph = state.doc.toString().indexOf("一段文字");
    const range = readAttributeLine(state.doc, {
      from: paragraph,
      to: state.doc.length - 1,
      name: "Paragraph",
      firstChild: null,
      nextSibling: null,
      parent: null,
    });
    expect(range?.classes).toEqual(["warning"]);
    expect(range?.id).toBe("custom-id");
    expect(range?.from).toBe(state.doc.toString().indexOf("{:"));
  });

  it("collects paragraph id anchors and skips blocked ranges", () => {
    const doc = "目标段落\n{: #target}\n\n" + "普通段落\n\n" + "隐藏段落\n{: #hidden}\n";
    const state = stateFor(doc);
    const anchors = readAttributeAnchors(state, [
      { from: doc.indexOf("隐藏段落"), to: state.doc.length - 1 },
    ]);

    expect(anchors.get("target")?.lineFrom).toBe(0);
    expect(anchors.has("hidden")).toBe(false);
  });
});
