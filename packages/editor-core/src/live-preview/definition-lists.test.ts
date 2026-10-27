import { describe, expect, it } from "vitest";

import { parseDefinitionList } from "./definition-lists";

describe("parseDefinitionList", () => {
  it("parses a term and its definitions", () => {
    expect(parseDefinitionList("Markdown\n: 一种轻量级标记语言。")).toEqual({
      terms: ["Markdown"],
      definitions: ["一种轻量级标记语言。"],
    });
    expect(
      parseDefinitionList("CommonMark\n: 一个标准化的 Markdown 规范。\n: 由多方共同维护。"),
    ).toEqual({
      terms: ["CommonMark"],
      definitions: ["一个标准化的 Markdown 规范。", "由多方共同维护。"],
    });
  });

  it("joins indented continuation lines", () => {
    expect(parseDefinitionList("Term\n: first line\n  second line")).toEqual({
      terms: ["Term"],
      definitions: ["first line second line"],
    });
  });

  it("does not convert ordinary paragraphs", () => {
    expect(parseDefinitionList("A normal paragraph\nwith another line")).toBeNull();
    expect(parseDefinitionList(": orphan definition")).toBeNull();
    expect(parseDefinitionList("Term\n: definition\nnot indented continuation")).toBeNull();
    expect(parseDefinitionList("Term only")).toBeNull();
  });
});
