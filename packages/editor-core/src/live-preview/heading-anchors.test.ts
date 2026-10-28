import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import {
  plainInlineText,
  readAnchorOnlyBlock,
  readHeadingAnchors,
  readHtmlAnchors,
  resolveHeadingAnchor,
  slugifyHeading,
} from "./heading-anchors";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

describe("heading anchors", () => {
  it("strips inline Markdown and creates GitHub-style slugs", () => {
    expect(plainInlineText("**Hello** [world](https://example.com) `code`")).toBe(
      "Hello world code",
    );
    expect(slugifyHeading("1. 标题与标点！")).toBe("1-标题与标点");
    expect(slugifyHeading("Hello, World")).toBe("hello-world");
  });

  it("deduplicates repeated headings", () => {
    const anchors = readHeadingAnchors(stateFor("# Same\n\n## Same\n\n### Same\n"));
    expect([...anchors.keys()]).toEqual(["same", "same-1", "same-2"]);
    expect(anchors.get("same-1")?.level).toBe(2);
  });

  it("resolves encoded fragments and skips blocked headings", () => {
    const state = stateFor("# 第一节\n\n# 第二节\n");
    const all = readHeadingAnchors(state);
    expect(resolveHeadingAnchor(all, "#第一节")?.lineFrom).toBe(0);
    expect(resolveHeadingAnchor(all, "#%E7%AC%AC%E4%BA%8C%E8%8A%82")?.text).toBe("第二节");
    expect(resolveHeadingAnchor(all, "#missing")).toBeNull();

    const blocked = readHeadingAnchors(state, [{ from: 0, to: state.doc.line(1).to }]);
    expect(blocked.has("第一节")).toBe(false);
    expect(blocked.has("第二节")).toBe(true);
  });

  it("reads explicit HTML anchors and targets the following heading", () => {
    const doc = '<a id="install"></a>\n' + "## 安装\n" + "\n" + '## <a name="inline"></a>标题\n';
    const anchors = readHtmlAnchors(stateFor(doc));

    expect(anchors.get("install")?.lineFrom).toBe(doc.indexOf("## 安装"));
    expect(anchors.get("inline")?.lineFrom).toBe(doc.indexOf("## <a"));
    expect(readAnchorOnlyBlock('<a id="x"></a>')).toEqual(["x"]);
    expect(readAnchorOnlyBlock('<a id="x"></a> text')).toBeNull();
  });
});
