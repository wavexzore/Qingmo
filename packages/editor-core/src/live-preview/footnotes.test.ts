import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import { readFootnoteDefinitions, readInlineFootnotes } from "./footnotes";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  // `ensureSyntaxTree` advances the parse context, not the state field; an
  // empty transaction adopts the completed tree for `syntaxTree(state)`.
  return state.update({}).state;
}

describe("readFootnoteDefinitions", () => {
  it("collects definitions and keeps the first duplicate", () => {
    const doc = "Text[^1].\n\n[^1]: First definition.\n\n[^1]: Duplicate.\n\n[^2]: Second.\n";
    const definitions = readFootnoteDefinitions(stateFor(doc));

    expect(definitions.get("1")?.lineFrom).toBe(doc.indexOf("[^1]: First"));
    expect(definitions.get("2")?.lineFrom).toBe(doc.indexOf("[^2]:"));
  });

  it("skips definitions inside blocked ranges", () => {
    const doc = "[^1]: Hidden.\n\n[^2]: Visible.\n";
    const state = stateFor(doc);
    const definitions = readFootnoteDefinitions(state, [{ from: 0, to: state.doc.line(1).to }]);

    expect(definitions.has("1")).toBe(false);
    expect(definitions.has("2")).toBe(true);
  });
});

describe("readInlineFootnotes", () => {
  it("collects inline notes in order and skips literal text", () => {
    const doc =
      "A^[one] B^[two]\n\n" + "`^[code]` and \\^[escaped] and [link](https://example.com/^[url])\n";
    const notes = readInlineFootnotes(stateFor(doc));

    expect([...notes.values()].map((note) => note.content)).toEqual(["one", "two"]);
    expect([...notes.values()].map((note) => note.index)).toEqual([1, 2]);
  });

  it("skips inline notes inside blocked ranges", () => {
    const doc = "Hidden^[one].\n\nVisible^[two].\n";
    const state = stateFor(doc);
    const notes = readInlineFootnotes(state, [{ from: 0, to: state.doc.line(1).to }]);

    expect([...notes.values()].map((note) => note.content)).toEqual(["two"]);
    expect([...notes.values()].map((note) => note.index)).toEqual([1]);
  });
});
