import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import { readCommentBlocks } from "./comment-blocks";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  // `ensureSyntaxTree` advances the parse context, not the state field; an
  // empty transaction adopts the completed tree for `syntaxTree(state)`.
  return state.update({}).state;
}

describe("readCommentBlocks", () => {
  it("reads multi-line HTML comments", () => {
    const blocks = readCommentBlocks(stateFor("<!--\n多行注释\n也不会渲染\n-->\n\n正文\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("html");
    expect(blocks[0]?.lines).toBe(4);
  });

  it("reads Obsidian comment paragraphs", () => {
    const blocks = readCommentBlocks(stateFor("%%\nObsidian 注释\n%%\n\n正文\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("obsidian");
    expect(blocks[0]?.raw).toContain("Obsidian 注释");
  });

  it("ignores single-line comments and inline comment text", () => {
    expect(readCommentBlocks(stateFor("<!-- 单行 -->\n\n正文\n"))).toEqual([]);
    expect(readCommentBlocks(stateFor("正文 %% inline %% 结束\n"))).toEqual([]);
  });

  it("ignores comments inside details and code fences", () => {
    expect(
      readCommentBlocks(
        stateFor("<details>\n<summary>x</summary>\n\n<!--\n隐藏\n-->\n\n</details>\n"),
      ),
    ).toEqual([]);
    expect(readCommentBlocks(stateFor("```html\n<!--\n注释\n-->\n```\n"))).toEqual([]);
  });
});
