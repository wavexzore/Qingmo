import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import { readDetailsBlocks } from "./details";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

describe("readDetailsBlocks", () => {
  it("pairs a details block and extracts its summary", () => {
    const doc =
      "<details>\n" +
      "<summary>点击查看完整日志</summary>\n" +
      "\n" +
      "```text\n" +
      "log line\n" +
      "```\n" +
      "\n" +
      "</details>\n";
    const blocks = readDetailsBlocks(stateFor(doc));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.summary).toBe("点击查看完整日志");
    expect(blocks[0]?.open).toBe(false);
    expect(blocks[0]?.raw).toContain("</details>");
    expect(doc.slice(blocks[0]?.bodyFrom, blocks[0]?.bodyTo)).toContain("log line");
  });

  it("recognizes the open attribute", () => {
    const blocks = readDetailsBlocks(
      stateFor("<details open>\n<summary>默认展开</summary>\n\n内容\n\n</details>\n"),
    );
    expect(blocks[0]?.open).toBe(true);
  });

  it("accepts a details block without blank lines", () => {
    const doc = "<details>\n  <summary>点击展开</summary>\n  隐藏内容\n</details>\n";
    const blocks = readDetailsBlocks(stateFor(doc));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.summary).toBe("点击展开");
    expect(blocks[0]?.children).toEqual([]);
    expect(doc.slice(blocks[0]?.bodyFrom, blocks[0]?.bodyTo).trim()).toBe("隐藏内容");
  });

  it("nests details blocks and keeps their open state", () => {
    const doc =
      "<details>\n" +
      "<summary>外层</summary>\n" +
      "\n" +
      "外层内容\n" +
      "\n" +
      "<details open>\n" +
      "<summary>内层</summary>\n" +
      "\n" +
      "内层内容\n" +
      "\n" +
      "</details>\n" +
      "\n" +
      "</details>\n";
    const blocks = readDetailsBlocks(stateFor(doc));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.summary).toBe("外层");
    expect(blocks[0]?.children).toHaveLength(1);
    const inner = blocks[0]?.children[0];
    expect(inner?.summary).toBe("内层");
    expect(inner?.open).toBe(true);
    expect(doc.slice(inner?.bodyFrom, inner?.bodyTo)).toContain("内层内容");
  });

  it("nests details blocks that share one HTML block", () => {
    const doc =
      "<details><summary>外层</summary>文本" +
      "<details><summary>内层</summary>内层内容</details>" +
      "</details>\n";
    const blocks = readDetailsBlocks(stateFor(doc));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.summary).toBe("外层");
    expect(blocks[0]?.children).toHaveLength(1);
    expect(blocks[0]?.children[0]?.summary).toBe("内层");
  });

  it("ignores details markup inside code fences and unclosed blocks", () => {
    expect(
      readDetailsBlocks(stateFor("```html\n<details>\n<summary>x</summary>\n</details>\n```\n")),
    ).toEqual([]);
    expect(readDetailsBlocks(stateFor("<details>\n<summary>x</summary>\n\n内容\n"))).toEqual([]);
  });
});
