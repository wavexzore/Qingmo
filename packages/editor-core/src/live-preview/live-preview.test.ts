import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  LP_MAX_UNITS,
  MAX_LINE_UNITS,
  buildLivePreviewDecorations,
  collectDecorationSpecs,
  createEditorState,
  livePreviewPlugin,
  type DecorationSpec,
} from "../index";

const fixture = readFileSync("packages/editor-core/src/live-preview/fixtures/basic.md", "utf8");
const views: Array<{ view: EditorView; parent: HTMLDivElement }> = [];

afterEach(() => {
  for (const { view, parent } of views.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

function stateFor(doc: string = fixture) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 2_000);
  return state;
}

function collect(
  state: ReturnType<typeof stateFor>,
  selection: readonly { from: number; to: number }[] = [],
): DecorationSpec[] {
  return collectDecorationSpecs(state, [{ from: 0, to: state.doc.length }], selection);
}

function find(
  specs: readonly DecorationSpec[],
  kind: DecorationSpec["kind"],
  className?: string,
): DecorationSpec | undefined {
  return specs.find((spec) => {
    if (spec.kind !== kind) {
      return false;
    }
    return className === undefined || (spec.kind !== "replace" && spec.className === className);
  });
}

function markRange(specs: readonly DecorationSpec[], className: string) {
  const spec = specs.find((item) => item.kind === "mark" && item.className === className);
  return spec ? [spec.from, spec.to] : null;
}

describe("collectDecorationSpecs", () => {
  it("plans headings, emphasis, inline code, links, quotes, lists and fences", () => {
    const state = stateFor();
    // Leave the cursor on the final line so the fixture's first lines are not
    // in source-reveal mode.
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);

    expect(find(specs, "line", "cm-md-h1")).toMatchObject({ from: 0 });
    expect(find(specs, "line", "cm-md-quote")).toBeDefined();
    expect(find(specs, "line", "cm-md-list")).toBeDefined();
    expect(find(specs, "line", "cm-md-code-block")).toBeDefined();

    expect(find(specs, "replace")).toMatchObject({ from: 0, to: 1 });
    expect(markRange(specs, "cm-md-strong")).toEqual([
      fixture.indexOf("strong"),
      fixture.indexOf("strong") + "strong".length,
    ]);
    expect(markRange(specs, "cm-md-em")).toEqual([
      fixture.indexOf("emphasis"),
      fixture.indexOf("emphasis") + "emphasis".length,
    ]);
    expect(markRange(specs, "cm-md-inline-code")).toEqual([
      fixture.indexOf("inline code"),
      fixture.indexOf("inline code") + "inline code".length,
    ]);
    expect(markRange(specs, "cm-md-link")).toEqual([
      fixture.indexOf("link"),
      fixture.indexOf("link") + "link".length,
    ]);

    const url = fixture.indexOf("https://example.com");
    expect(
      specs.some(
        (spec) =>
          spec.kind === "replace" &&
          spec.from === url &&
          spec.to === url + "https://example.com".length,
      ),
    ).toBe(true);

    const listMark = fixture.indexOf("- bullet");
    expect(specs).toContainEqual({ kind: "replace", from: listMark, to: listMark + 1 });
  });

  it("keeps fenced-code fences visible while styling the block line", () => {
    const state = stateFor();
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);
    const fence = fixture.indexOf("```js");
    const closingFence = fixture.lastIndexOf("```");

    expect(
      specs.some(
        (spec) =>
          spec.kind === "replace" &&
          ((spec.from <= fence && spec.to > fence) ||
            (spec.from <= closingFence && spec.to > closingFence)),
      ),
    ).toBe(false);
    expect(
      specs.some(
        (spec) =>
          spec.kind === "line" &&
          spec.from === state.doc.lineAt(fence).from &&
          spec.className === "cm-md-code-block",
      ),
    ).toBe(true);
  });

  it("reveals source on every selected line, including multiple cursors", () => {
    const state = stateFor();
    const headingLine = state.doc.line(1);
    const strongLine = state.doc.line(3);
    const strong = state.doc.toString().indexOf("strong");

    const headingSelected = collect(state, [{ from: headingLine.from, to: headingLine.to }]);
    expect(find(headingSelected, "line", "cm-md-h1")).toBeDefined();
    expect(
      headingSelected.some((spec) => spec.kind === "replace" && spec.from === 0 && spec.to === 1),
    ).toBe(false);
    expect(markRange(headingSelected, "cm-md-strong")).not.toBeNull();

    const multiSelected = collect(state, [
      { from: headingLine.from, to: headingLine.from },
      { from: strong, to: strong },
    ]);
    expect(
      multiSelected.some((spec) => spec.kind === "replace" && spec.from === 0 && spec.to === 1),
    ).toBe(false);
    expect(
      multiSelected.some(
        (spec) =>
          spec.kind === "replace" && spec.from >= strongLine.from && spec.to <= strongLine.to,
      ),
    ).toBe(false);
    expect(markRange(multiSelected, "cm-md-link")).not.toBeNull();
  });

  it("hides every quote marker in a multi-line blockquote", () => {
    const state = stateFor("> first\n> second\n\nbody\n");
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);
    const first = state.doc.toString().indexOf(">");
    const second = state.doc.toString().indexOf(">", first + 1);

    expect(
      specs.some((spec) => spec.kind === "replace" && spec.from === first && spec.to === first + 1),
    ).toBe(true);
    expect(
      specs.some(
        (spec) => spec.kind === "replace" && spec.from === second && spec.to === second + 1,
      ),
    ).toBe(true);
    expect(find(specs, "line", "cm-md-quote")).toBeDefined();
  });

  it("normalizes CRLF before planning decorations", () => {
    const state = stateFor("# heading\r\n\r\n**bold**\r\n");
    const doc = state.doc.toString();

    expect(doc).not.toContain("\r");
    expect(doc).toBe("# heading\n\n**bold**\n");

    const specs = collect(state, [{ from: doc.length, to: doc.length }]);
    expect(find(specs, "line", "cm-md-h1")).toBeDefined();
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === 0 && spec.to === 1)).toBe(
      true,
    );
    expect(markRange(specs, "cm-md-strong")).toEqual([
      doc.indexOf("bold"),
      doc.indexOf("bold") + 4,
    ]);
  });

  it("reveals source on every line touched by a cross-line selection", () => {
    const state = stateFor();
    const headingLine = state.doc.line(1);
    const strongLine = state.doc.line(3);
    const selection = { from: headingLine.from, to: strongLine.to };
    const specs = collect(state, [selection]);

    const replacedInsideSelection = specs.filter(
      (spec) => spec.kind === "replace" && spec.from >= selection.from && spec.to <= selection.to,
    );
    expect(replacedInsideSelection).toEqual([]);
    expect(find(specs, "line", "cm-md-h1")).toBeDefined();
    expect(markRange(specs, "cm-md-strong")).not.toBeNull();
    expect(markRange(specs, "cm-md-link")).not.toBeNull();
  });

  it("hides a reference label but leaves its definition editable", () => {
    const doc = "[text][ref]\n\n[ref]: https://example.com\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);
    const reference = doc.indexOf("[ref]");
    const definition = doc.lastIndexOf("[ref]");

    expect(markRange(specs, "cm-md-link")).toEqual([1, 5]);
    expect(
      specs.some(
        (spec) => spec.kind === "replace" && spec.from === reference && spec.to === reference + 5,
      ),
    ).toBe(true);
    expect(
      specs.some(
        (spec) => spec.kind === "replace" && spec.from === definition && spec.to === definition + 5,
      ),
    ).toBe(false);
  });

  it("does not replace markers of a cross-line link", () => {
    const state = stateFor("before [multi\nline](https://example.com) after\n");
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);
    const opening = state.doc.toString().indexOf("[");

    expect(markRange(specs, "cm-md-link")).not.toBeNull();
    expect(
      specs.some(
        (spec) => spec.kind === "replace" && spec.from === opening && spec.to === opening + 1,
      ),
    ).toBe(false);
  });

  it("skips replacements on an over-long line but keeps its line class", () => {
    const state = stateFor(`# ${"a".repeat(MAX_LINE_UNITS + 5)}\n`);
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);

    expect(find(specs, "line", "cm-md-h1")).toBeDefined();
    expect(specs.some((spec) => spec.kind === "replace")).toBe(false);
  });

  it("returns no decorations above the Live Preview unit budget", () => {
    const state = createEditorState({ doc: "a".repeat(LP_MAX_UNITS + 1) });
    expect(collectDecorationSpecs(state, [{ from: 0, to: state.doc.length }], [])).toEqual([]);
    expect(buildLivePreviewDecorations(state, [{ from: 0, to: state.doc.length }], []).size).toBe(
      0,
    );
  });
});

describe("livePreviewPlugin", () => {
  it("renders decorations in a real view and maps them during composition", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = stateFor();
    const view = new EditorView({ state, parent });
    views.push({ view, parent });

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();
    if (!plugin) {
      throw new Error("Live Preview plugin was not installed");
    }

    expect(view.visibleRanges.length).toBeGreaterThan(0);
    const before = plugin.decorations;
    expect(before.size).toBeGreaterThan(0);
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-strong")).not.toBeNull();

    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => true,
    });
    view.dispatch({ changes: { from: view.state.doc.length, insert: "X" } });
    const during = plugin.decorations;
    expect(during).not.toBe(before);
    expect(during.size).toBe(before.size);

    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => false,
    });
    view.dispatch({ selection: { anchor: 1 } });
    expect(plugin.decorations).not.toBe(during);
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();
  });

  it("rebuilds when a new heading advances the syntax tree", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(), parent });
    views.push({ view, parent });

    const plugin = view.plugin(livePreviewPlugin);
    if (!plugin) {
      throw new Error("Live Preview plugin was not installed");
    }

    const before = plugin.decorations;
    view.dispatch({ changes: { from: 0, insert: "## Added\n\n" } });

    expect(plugin.decorations).not.toBe(before);
    expect(view.dom.querySelector(".cm-md-h2")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-strong")).not.toBeNull();
  });

  it("reuses the decoration set when neither the document, viewport nor selection changes", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(), parent });
    views.push({ view, parent });

    const plugin = view.plugin(livePreviewPlugin);
    if (!plugin) {
      throw new Error("Live Preview plugin was not installed");
    }

    const before = plugin.decorations;
    view.dispatch({ selection: { anchor: 1 } });
    const afterSelection = plugin.decorations;
    expect(afterSelection).not.toBe(before);

    view.dispatch({ selection: { anchor: 1 } });
    expect(plugin.decorations).toBe(afterSelection);
  });
});
