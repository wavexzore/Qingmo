import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorState } from "../createEditor";
import { selectAllInCodeBlock } from "./select-all";

const FENCED_DOC = [
  "# Title",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "Tail",
  "",
].join("\n");

const INDENTED_DOC = ["Intro", "", "    const a = 1;", "    const b = 2;", "", "Tail", ""].join(
  "\n",
);

let view: EditorView | null = null;

function openView(doc: string, cursor: number): EditorView {
  const state = createEditorState({ doc }).update({ selection: { anchor: cursor } }).state;
  view = new EditorView({ state, parent: document.body });
  return view;
}

function selectedText(editor: EditorView): string {
  const selection = editor.state.selection.main;
  return editor.state.sliceDoc(selection.from, selection.to);
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

describe("select all inside a code block", () => {
  it("selects only the fenced code content, excluding both fence lines", () => {
    const editor = openView(FENCED_DOC, FENCED_DOC.indexOf("const b") + 2);

    expect(selectAllInCodeBlock(editor)).toBe(true);
    expect(selectedText(editor)).toBe("const a = 1;\nconst b = 2;");
  });

  it("runs through the Mod-a keymap before the default Select All", () => {
    const editor = openView(FENCED_DOC, FENCED_DOC.indexOf("const a") + 1);
    const macLike = /Mac|iPhone|iPad/i.test(navigator.platform ?? "");

    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        keyCode: 65,
        which: 65,
        ctrlKey: !macLike,
        metaKey: macLike,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(selectedText(editor)).toBe("const a = 1;\nconst b = 2;");
  });

  it("selects the code content when the caret is on a fence line", () => {
    const openingFence = FENCED_DOC.indexOf("```ts") + 1;
    const closingFence = FENCED_DOC.lastIndexOf("```") + 1;

    const onOpening = openView(FENCED_DOC, openingFence);
    expect(selectAllInCodeBlock(onOpening)).toBe(true);
    expect(selectedText(onOpening)).toBe("const a = 1;\nconst b = 2;");
    onOpening.destroy();
    view = null;

    const onClosing = openView(FENCED_DOC, closingFence);
    expect(selectAllInCodeBlock(onClosing)).toBe(true);
    expect(selectedText(onClosing)).toBe("const a = 1;\nconst b = 2;");
  });

  it("selects an indented code block's whole range", () => {
    const start = INDENTED_DOC.indexOf("    const a");
    const editor = openView(INDENTED_DOC, start + 6);

    expect(selectAllInCodeBlock(editor)).toBe(true);
    expect(selectedText(editor)).toBe("    const a = 1;\n    const b = 2;");
  });

  it("falls back when the selection already reaches outside the block", () => {
    const start = FENCED_DOC.indexOf("const a");
    const editor = openView(FENCED_DOC, start + 1);
    editor.dispatch({
      selection: { anchor: FENCED_DOC.indexOf("Title"), head: start + 2 },
    });

    expect(selectAllInCodeBlock(editor)).toBe(false);
  });

  it("falls back outside code blocks", () => {
    const editor = openView(FENCED_DOC, FENCED_DOC.indexOf("Title") + 1);
    expect(selectAllInCodeBlock(editor)).toBe(false);
  });
});
