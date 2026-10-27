import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import { commentBlockPreview } from "./comment-blocks";
import { definitionListPreview } from "./definition-lists";
import { detailsBlockPreview } from "./details";
import { readFootnoteDefinitions } from "./footnotes";
import { frontMatterPreview } from "./frontmatter";
import { mathBlockPreview } from "./math-blocks";
import { mediaBlockPreview } from "./media-blocks";
import { mermaidBlockPreview } from "./mermaid-blocks";
import { tableBlockPreview } from "./table-blocks";
import { tocPreview } from "./toc";

/**
 * The syntax guide is the shared reference corpus for Live Preview. Counts in
 * this file were cross-checked against Typora 1.14.15's HTML export, so a
 * change here means either the guide changed or a block parser regressed.
 */
const DOC = readFileSync("docs/MARKDOWN-SYNTAX.md", "utf8");

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  // State fields are created before ensureSyntaxTree finishes; one transaction
  // lets every block field observe the completed tree.
  return state.update({ selection: { anchor: doc.length } }).state;
}

function countNodes(state: ReturnType<typeof stateFor>) {
  const counts: Record<string, number> = {};
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Document") {
        counts[node.name] = (counts[node.name] ?? 0) + 1;
      }
      return true;
    },
  });
  return counts;
}

describe("MARKDOWN-SYNTAX corpus", () => {
  it("matches Typora's block inventory for the guide", () => {
    const state = stateFor(DOC);
    const nodes = countNodes(state);
    const headings = [0, 0, 0, 0, 0, 0, 0];
    syntaxTree(state).iterate({
      enter(node) {
        const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
        if (match) {
          const level = Number(match[1]);
          headings[level] = (headings[level] ?? 0) + 1;
        }
      },
    });

    let alerts = 0;
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== "Blockquote") {
          return true;
        }
        const raw = state.doc.sliceString(node.from, node.to);
        if (/^\s*>+\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(raw)) {
          alerts += 1;
        }
        return false;
      },
    });

    const fields = {
      tableWidgets: state.field(tableBlockPreview).ranges.length,
      mermaid: state.field(mermaidBlockPreview).ranges.length,
      mathBlocks: state.field(mathBlockPreview).ranges.length,
      media: state.field(mediaBlockPreview).ranges.length,
      details: state.field(detailsBlockPreview).ranges.length,
      // Definition lists and abbreviations are Qingmo extensions; Typora
      // renders these two sections as plain paragraphs.
      definitionLists: state.field(definitionListPreview).ranges.length,
      commentBlocks: state.field(commentBlockPreview).ranges.length,
      frontMatter: state.field(frontMatterPreview).blocked.length,
      tocPlaceholders: state.field(tocPreview).ranges.length,
    };

    expect({
      headings,
      tables: nodes.Table ?? 0,
      tableHeaders: nodes.TableHeader ?? 0,
      tableRows: nodes.TableRow ?? 0,
      lists: (nodes.BulletList ?? 0) + (nodes.OrderedList ?? 0),
      listItems: nodes.ListItem ?? 0,
      tasks: nodes.Task ?? 0,
      blockquotes: nodes.Blockquote ?? 0,
      alerts,
      codeFences: nodes.FencedCode ?? 0,
      indentedCode: nodes.CodeBlock ?? 0,
      rules: nodes.HorizontalRule ?? 0,
      links: nodes.Link ?? 0,
      images: nodes.Image ?? 0,
      inlineCode: nodes.InlineCode ?? 0,
      entities: nodes.Entity ?? 0,
      linkDefinitions: nodes.LinkReference ?? 0,
      footnoteDefinitions: readFootnoteDefinitions(state).size,
      htmlBlocks: nodes.HTMLBlock ?? 0,
      htmlTags: nodes.HTMLTag ?? 0,
      ...fields,
    }).toEqual({
      // Typora export: h1 3 / h2 32 / h3 103 / h4 8 / h5 1 / h6 1.
      headings: [0, 3, 32, 103, 8, 1, 1],
      tables: 19,
      tableWidgets: 19,
      tableHeaders: 19,
      tableRows: 140,
      lists: 25,
      listItems: 94,
      tasks: 5,
      // 23 regular quotes plus 6 GitHub-style alerts.
      blockquotes: 29,
      alerts: 6,
      // 127 fenced blocks include the 34 Mermaid diagrams and one fence
      // inside a blockquote; the indented example is a CodeBlock.
      codeFences: 127,
      indentedCode: 1,
      rules: 29,
      links: 48,
      images: 9,
      inlineCode: 254,
      entities: 14,
      // `[openai]:`, `[openai 官网]:` and `[logo]:`.
      linkDefinitions: 3,
      // `[^1]:` / `[^2]:` definitions.
      footnoteDefinitions: 2,
      htmlBlocks: 4,
      htmlTags: 33,
      mermaid: 34,
      mathBlocks: 3,
      media: 3,
      details: 1,
      definitionLists: 2,
      commentBlocks: 0,
      frontMatter: 0,
      tocPlaceholders: 0,
    });
  });
});
