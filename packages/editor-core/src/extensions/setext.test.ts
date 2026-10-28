import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";

interface ParsedNode {
  name: string;
  from: number;
  to: number;
  text: string;
}

function parse(doc: string): ParsedNode[] {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  // Adopt the completed parse context before reading `syntaxTree(state)`.
  const parsed = state.update({}).state;
  const nodes: ParsedNode[] = [];
  syntaxTree(parsed).iterate({
    enter(node) {
      if (node.name !== "Document") {
        nodes.push({
          name: node.name,
          from: node.from,
          to: node.to,
          text: doc.slice(node.from, node.to),
        });
      }
    },
  });
  return nodes;
}

describe("Typora setext headings", () => {
  it("keeps a lone dash as paragraph text", () => {
    const nodes = parse("ascii path\n-\n");

    expect(nodes.some((node) => node.name === "SetextHeading2")).toBe(false);
    expect(nodes.find((node) => node.name === "Paragraph")?.text).toBe("ascii path\n-");
  });

  it("keeps a lone dash plus trailing space as paragraph text", () => {
    const nodes = parse("ascii path\n- \n");

    expect(nodes.some((node) => node.name === "SetextHeading2")).toBe(false);
    expect(nodes.find((node) => node.name === "Paragraph")?.text).toBe("ascii path\n- ");
  });

  it("keeps a lone equals sign as paragraph text", () => {
    const nodes = parse("ascii path\n=\n");

    expect(nodes.some((node) => node.name === "SetextHeading1")).toBe(false);
    expect(nodes.find((node) => node.name === "Paragraph")?.text).toBe("ascii path\n=");
  });

  it("turns a two-character underline into a level 2 heading", () => {
    const nodes = parse("ascii path\n--\n");

    expect(nodes.find((node) => node.name === "SetextHeading2")?.text).toBe("ascii path\n--");
    expect(nodes.find((node) => node.name === "HeaderMark")).toMatchObject({
      from: 11,
      to: 13,
      text: "--",
    });
  });

  it("turns a two-character equals underline into a level 1 heading", () => {
    const nodes = parse("ascii path\n==\n");

    expect(nodes.find((node) => node.name === "SetextHeading1")?.text).toBe("ascii path\n==");
  });

  it("keeps a paragraph flowing after a lone dash", () => {
    const nodes = parse("foo\n-\nbar\n");

    expect(nodes.some((node) => node.name === "SetextHeading2")).toBe(false);
    expect(nodes.find((node) => node.name === "Paragraph")?.text).toBe("foo\n-\nbar");
  });

  it("still parses a two-character underline inside a blockquote", () => {
    const nodes = parse("> foo\n> --\n");

    expect(nodes.find((node) => node.name === "SetextHeading2")?.text).toContain("foo");
  });

  it("keeps a spaced thematic break after a paragraph", () => {
    const nodes = parse("foo\n- - -\n");

    expect(nodes.some((node) => node.name === "HorizontalRule")).toBe(true);
  });

  it("still lets a bullet list with content interrupt a paragraph", () => {
    const nodes = parse("foo\n- item\n");

    expect(nodes.some((node) => node.name === "BulletList")).toBe(true);
    expect(nodes.some((node) => node.name === "SetextHeading2")).toBe(false);
  });

  it("still gives setext headings precedence over thematic breaks after a paragraph", () => {
    const nodes = parse("ascii path\n---\n");

    expect(nodes.some((node) => node.name === "SetextHeading2")).toBe(true);
    expect(nodes.some((node) => node.name === "HorizontalRule")).toBe(false);
  });

  it("keeps a three-character break as a thematic break after a blank line", () => {
    const nodes = parse("ascii path\n\n---\n");

    expect(nodes.some((node) => node.name === "HorizontalRule")).toBe(true);
    expect(nodes.some((node) => node.name === "SetextHeading2")).toBe(false);
  });
});
