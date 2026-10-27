import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { readFrontMatter } from "./frontmatter";

function doc(text: string) {
  return EditorState.create({ doc: text }).doc;
}

describe("readFrontMatter", () => {
  it("parses a YAML block at the top of the document", () => {
    const frontMatter = readFrontMatter(
      doc(
        "---\n" +
          "title: Markdown 指南\n" +
          "tags:\n" +
          "  - markdown\n" +
          "  - docs\n" +
          "draft: false\n" +
          "---\n" +
          "\n" +
          "# 标题\n",
      ),
    );

    expect(frontMatter?.format).toBe("yaml");
    expect(frontMatter?.from).toBe(0);
    expect(frontMatter?.entries).toEqual([
      { key: "title", values: ["Markdown 指南"] },
      { key: "tags", values: ["markdown", "docs"] },
      { key: "draft", values: ["false"] },
    ]);
    expect(frontMatter?.raw).toContain("title: Markdown 指南");
  });

  it("parses TOML front matter and inline arrays", () => {
    const frontMatter = readFrontMatter(
      doc('+++\ntitle = "Guide"\ntags = ["markdown", "docs"]\n+++\n\nBody\n'),
    );

    expect(frontMatter?.format).toBe("toml");
    expect(frontMatter?.entries).toEqual([
      { key: "title", values: ["Guide"] },
      { key: "tags", values: ["markdown, docs"] },
    ]);
  });

  it("parses JSON front matter with nested values", () => {
    const frontMatter = readFrontMatter(
      doc(
        "{\n" +
          '  "title": "Guide",\n' +
          '  "tags": ["markdown", "mermaid"],\n' +
          '  "draft": false,\n' +
          '  "meta": { "lang": "zh" }\n' +
          "}\n\nBody\n",
      ),
    );

    expect(frontMatter?.format).toBe("json");
    expect(frontMatter?.entries).toEqual([
      { key: "title", values: ["Guide"] },
      { key: "tags", values: ["markdown", "mermaid"] },
      { key: "draft", values: ["false"] },
      { key: "meta", values: ['{"lang":"zh"}'] },
    ]);
  });

  it("requires a complete JSON object", () => {
    expect(readFrontMatter(doc('{\n  "a": 1\n}\n'))?.format).toBe("json");
    expect(readFrontMatter(doc("{\n  not json\n}\n\nBody\n"))).toBeNull();
    expect(readFrontMatter(doc('{\n  "a": 1\n\nBody\n'))).toBeNull();
  });

  it("does not treat a horizontal rule or an unclosed block as front matter", () => {
    expect(readFrontMatter(doc("---\n\n# Title\n\n---\n\nText\n"))).toBeNull();
    expect(readFrontMatter(doc("---\ntitle: Guide\n\n# Title\n"))).toBeNull();
    expect(readFrontMatter(doc("# Title\n\n---\ntitle: Guide\n---\n"))).toBeNull();
  });

  it("accepts an empty YAML block", () => {
    const frontMatter = readFrontMatter(doc("---\n---\n\nBody\n"));
    expect(frontMatter?.entries).toEqual([]);
    expect(frontMatter?.body.trim()).toBe("");
  });
});
