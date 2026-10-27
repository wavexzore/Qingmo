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
  type LivePreviewWidgetSpec,
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
  ensureSyntaxTree(state, state.doc.length, 10_000);
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
    return (
      className === undefined ||
      ((spec.kind === "mark" || spec.kind === "line") && spec.className === className)
    );
  });
}

function markRange(specs: readonly DecorationSpec[], className: string) {
  const spec = specs.find((item) => item.kind === "mark" && item.className === className);
  return spec ? [spec.from, spec.to] : null;
}

function findWidget(
  specs: readonly DecorationSpec[],
  kind: LivePreviewWidgetSpec["kind"],
): Extract<DecorationSpec, { kind: "widget" }> | undefined {
  return specs.find(
    (spec): spec is Extract<DecorationSpec, { kind: "widget" }> =>
      spec.kind === "widget" && spec.widget.kind === kind,
  );
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

    expect(find(specs, "replace")).toMatchObject({ from: 0, to: 2 });
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
    expect(specs).toContainEqual({
      kind: "widget",
      from: listMark,
      to: listMark + 1,
      widget: { kind: "bullet" },
    });
  });

  it("renders a fenced code block with a language badge and hidden closing fence", () => {
    const state = stateFor();
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);
    const fence = fixture.indexOf("```js");
    const openingLine = state.doc.lineAt(fence);
    const closingLine = state.doc.lineAt(fixture.lastIndexOf("```"));

    expect(specs).toContainEqual({
      kind: "widget",
      from: openingLine.from,
      to: openingLine.to,
      widget: { kind: "code-language", language: "js", title: null },
    });
    expect(specs).toContainEqual({
      kind: "replace",
      from: closingLine.from,
      to: closingLine.to,
    });
    expect(
      specs.some(
        (spec) =>
          spec.kind === "line" &&
          spec.from === openingLine.from &&
          spec.className === "cm-md-code-block",
      ),
    ).toBe(true);
    expect(
      specs.some(
        (spec) =>
          spec.kind === "line" &&
          spec.from === openingLine.from &&
          spec.className === "cm-md-code-fence",
      ),
    ).toBe(true);
  });

  it("renders setext headings and hides their underline", () => {
    const doc = "Title\n=====\n\nbody\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(find(specs, "line", "cm-md-h1")).toMatchObject({ from: 0 });
    expect(specs).toContainEqual({ kind: "replace", from: 6, to: 11 });
  });

  it("marks strikethrough and hides its delimiters", () => {
    const doc = "~~gone~~\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(markRange(specs, "cm-md-strike")).toEqual([2, 6]);
    expect(specs).toContainEqual({ kind: "replace", from: 0, to: 2 });
    expect(specs).toContainEqual({ kind: "replace", from: 6, to: 8 });
  });

  it("marks highlight and hides its delimiters", () => {
    const doc = "这是 ==重点== 内容\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(markRange(specs, "cm-md-highlight")).toEqual([5, 7]);
    expect(specs).toContainEqual({ kind: "replace", from: 3, to: 5 });
    expect(specs).toContainEqual({ kind: "replace", from: 7, to: 9 });
  });

  it("renders subscript and superscript without their markers", () => {
    const doc = "H~2~O and X^2^\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(markRange(specs, "cm-md-sub")).toEqual([2, 3]);
    expect(markRange(specs, "cm-md-sup")).toEqual([12, 13]);
    expect(specs).toContainEqual({ kind: "replace", from: 1, to: 2 });
    expect(specs).toContainEqual({ kind: "replace", from: 3, to: 4 });
    expect(specs).toContainEqual({ kind: "replace", from: 11, to: 12 });
    expect(specs).toContainEqual({ kind: "replace", from: 13, to: 14 });
  });

  it("styles autolinks and bare GFM URLs", () => {
    const doc = "<https://a.example> and https://b.example\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);
    const bare = doc.indexOf("https://b.example");

    expect(markRange(specs, "cm-md-link")).toEqual([1, 18]);
    expect(
      specs.some(
        (spec) =>
          spec.kind === "mark" &&
          spec.className === "cm-md-link" &&
          spec.from === bare &&
          spec.to === bare + "https://b.example".length,
      ),
    ).toBe(true);
    expect(specs).toContainEqual({ kind: "replace", from: 0, to: 1 });
    expect(specs).toContainEqual({ kind: "replace", from: 18, to: 19 });
  });

  it("renders an inline image as a widget and reveals its source when touched", () => {
    const doc = '![alt](./pic.png "title")\n';
    const state = stateFor(doc);
    const end = doc.trimEnd().length;
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(findWidget(specs, "image")).toEqual({
      kind: "widget",
      from: 0,
      to: end,
      widget: {
        kind: "image",
        src: "./pic.png",
        alt: "alt",
        title: "title",
        width: null,
        height: null,
      },
    });

    const touched = collect(state, [{ from: 3, to: 3 }]);
    expect(findWidget(touched, "image")).toBeUndefined();
  });

  it("resolves reference-style images through their definitions", () => {
    const doc = '![alt][ref]\n\n[ref]: ./pic.png "title"\n';
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(findWidget(specs, "image")).toEqual({
      kind: "widget",
      from: 0,
      to: 11,
      widget: {
        kind: "image",
        src: "./pic.png",
        alt: "alt",
        title: "title",
        width: null,
        height: null,
      },
    });
    expect(find(specs, "line", "cm-md-link-reference")).toBeDefined();
  });

  it("decodes CommonMark entities in a real view", () => {
    const doc = "&amp; &#65; &#x1F600;\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const entities = Array.from(
      view.dom.querySelectorAll(".cm-md-entity"),
      (element) => element.textContent,
    );
    expect(entities).toEqual(["&", "A", "😀"]);
  });

  it("hides hard-break markers without removing the line break", () => {
    const doc = "a  \nb\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(specs).toContainEqual({ kind: "replace", from: 1, to: 3 });
  });

  it("renders a horizontal rule as a widget until the cursor touches it", () => {
    const doc = "---\n\nbody\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(findWidget(specs, "rule")).toEqual({
      kind: "widget",
      from: 0,
      to: 3,
      widget: { kind: "rule" },
    });
    expect(findWidget(collect(state, [{ from: 0, to: 0 }]), "rule")).toBeUndefined();
  });

  it("renders task items with checkboxes and hides their list prefixes", () => {
    const doc = "- [ ] todo\n- [x] done\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(findWidget(specs, "task")).toMatchObject({
      widget: { kind: "task", checked: false },
    });
    expect(
      specs.some(
        (spec) => spec.kind === "widget" && spec.widget.kind === "task" && spec.widget.checked,
      ),
    ).toBe(true);
    expect(specs).toContainEqual({ kind: "replace", from: 0, to: 2 });
    expect(specs).toContainEqual({ kind: "replace", from: 11, to: 13 });
  });

  it("keeps ordered-list numbers visible and styles them", () => {
    const doc = "1. first\n2. second\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(markRange(specs, "cm-md-list-number")).toEqual([0, 2]);
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === 0)).toBe(false);
  });

  it("styles GFM tables while keeping their editable source", () => {
    const doc = "| A | B |\n| :- | -: |\n| 1 | 2 |\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(find(specs, "line", "cm-md-table-header")).toBeDefined();
    expect(find(specs, "line", "cm-md-table-delim")).toBeDefined();
    expect(find(specs, "line", "cm-md-table-row")).toBeDefined();
  });

  it("keeps HTML source visible but styled", () => {
    const doc = "<div>html</div>\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(find(specs, "line", "cm-md-html")).toBeDefined();
  });

  it("reveals an escaped character without its backslash", () => {
    const doc = "\\*literal\\*\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(specs).toContainEqual({ kind: "replace", from: 0, to: 1 });
    expect(specs).toContainEqual({ kind: "replace", from: 9, to: 10 });
  });

  it("renders the current line until the cursor reaches a marker", () => {
    const state = stateFor();
    const doc = state.doc.toString();
    const headingLine = state.doc.line(1);
    const strong = doc.indexOf("strong");

    // Caret inside the heading text: the marker and its space are replaced
    // (hidden) while the line is still styled as a heading.
    const inHeading = collect(state, [{ from: headingLine.from + 5, to: headingLine.from + 5 }]);
    expect(find(inHeading, "line", "cm-md-h1")).toBeDefined();
    expect(inHeading).toContainEqual({ kind: "replace", from: 0, to: 2 });

    // Caret inside bold text: both emphasis markers stay hidden.
    const inStrong = collect(state, [{ from: strong + 3, to: strong + 3 }]);
    expect(
      inStrong.some(
        (spec) =>
          spec.kind === "replace" &&
          spec.from >= state.doc.line(3).from &&
          spec.to <= state.doc.line(3).to,
      ),
    ).toBe(true);
    expect(markRange(inStrong, "cm-md-strong")).not.toBeNull();

    // Touching the marker itself exposes it so it remains editable.
    const onMarker = collect(state, [{ from: headingLine.from, to: headingLine.from }]);
    expect(onMarker.some((spec) => spec.kind === "replace" && spec.from === 0)).toBe(false);
  });

  it("keeps hidden markers hidden with multiple cursors inside the text", () => {
    const state = stateFor();
    const doc = state.doc.toString();
    const strong = doc.indexOf("strong");

    const specs = collect(state, [
      { from: 5, to: 5 },
      { from: strong + 3, to: strong + 3 },
    ]);

    expect(specs.some((spec) => spec.kind === "replace" && spec.from === 0)).toBe(true);
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === strong - 2)).toBe(true);
    expect(markRange(specs, "cm-md-link")).not.toBeNull();
  });

  it("hides the closing heading marker and its separating space", () => {
    const doc = "## two ##\n\nbody\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);

    expect(specs).toContainEqual({ kind: "replace", from: 0, to: 3 });
    expect(specs).toContainEqual({ kind: "replace", from: 6, to: 9 });
    expect(find(specs, "line", "cm-md-h2")).toBeDefined();
  });

  it("keeps empty-heading marker replacements adjacent instead of overlapping", () => {
    const doc = "# #\n\nbody\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);
    const replaces = specs
      .filter((spec) => spec.kind === "replace")
      .sort((left, right) => left.from - right.from);

    expect(replaces).toEqual([
      { kind: "replace", from: 0, to: 2 },
      { kind: "replace", from: 2, to: 3 },
    ]);
  });

  it("hides every quote marker in a multi-line blockquote", () => {
    const state = stateFor("> first\n> second\n\nbody\n");
    const specs = collect(state, [{ from: state.doc.length, to: state.doc.length }]);
    const first = state.doc.toString().indexOf(">");
    const second = state.doc.toString().indexOf(">", first + 1);

    expect(
      specs.some((spec) => spec.kind === "replace" && spec.from === first && spec.to === first + 2),
    ).toBe(true);
    expect(
      specs.some(
        (spec) => spec.kind === "replace" && spec.from === second && spec.to === second + 2,
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
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === 0 && spec.to === 2)).toBe(
      true,
    );
    expect(markRange(specs, "cm-md-strong")).toEqual([
      doc.indexOf("bold"),
      doc.indexOf("bold") + 4,
    ]);
  });

  it("reveals only the markers a cross-line selection actually touches", () => {
    const state = stateFor();
    const doc = state.doc.toString();
    const headingLine = state.doc.line(1);
    const strong = doc.indexOf("strong");
    const link = doc.indexOf("[link]");

    // Starts inside the heading text and ends inside bold text: the heading
    // marker stays hidden, the bold opening marker is revealed, and its closing
    // marker plus the later link markers remain hidden.
    const specs = collect(state, [{ from: headingLine.from + 4, to: strong + 3 }]);

    expect(find(specs, "line", "cm-md-h1")).toBeDefined();
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === 0)).toBe(true);
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === strong - 2)).toBe(false);
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === strong + 6)).toBe(true);
    expect(specs.some((spec) => spec.kind === "replace" && spec.from === link)).toBe(true);
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

  it("adds link titles from inline and reference definitions", () => {
    const doc =
      '[inline](https://example.com "Inline title") and [ref][openai] and [shortcut][]\n' +
      "\n" +
      '[openai]: https://openai.com "OpenAI"\n' +
      "[shortcut]: https://shortcut.example\n";
    const state = stateFor(doc);
    const specs = collect(state, [{ from: doc.length, to: doc.length }]);
    const titleFor = (text: string): string | undefined => {
      const mark = specs.find(
        (spec) =>
          spec.kind === "mark" &&
          spec.className === "cm-md-link" &&
          state.doc.sliceString(spec.from, spec.to) === text,
      );
      return mark?.kind === "mark" ? mark.attributes?.title : undefined;
    };

    expect(titleFor("inline")).toBe("Inline title");
    expect(titleFor("ref")).toBe("OpenAI");
    expect(titleFor("shortcut")).toBe("https://shortcut.example");
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

  it("renders a just-typed heading without its marker until the caret touches it", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(""), parent });
    views.push({ view, parent });

    // Mirrors typing `# ddd` in the untitled editor: the caret ends after the
    // text, so the heading marker is hidden immediately.
    view.dispatch({
      changes: { from: 0, insert: "# ddd" },
      selection: { anchor: 5 },
    });

    const firstLine = view.dom.querySelector(".cm-line");
    expect(firstLine?.textContent).toBe("ddd");
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();

    // Moving to the line start exposes the source so it remains editable.
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("# ddd");
  });

  it("renders bullets, task checkboxes, rules and images in a real view", () => {
    const doc = "- item\n- [ ] todo\n\n---\n\n![alt](x.png)\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    expect(view.dom.querySelector(".cm-md-bullet")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-task input")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-rule")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-image")).not.toBeNull();
  });

  it("toggles a task checkbox through the widget", () => {
    const doc = "- [ ] todo\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    const input = view.dom.querySelector<HTMLInputElement>(".cm-md-task input");
    expect(input?.checked).toBe(false);

    input?.click();

    expect(view.state.doc.toString()).toBe("- [x] todo\n");
    expect(view.dom.querySelector<HTMLInputElement>(".cm-md-task input")?.checked).toBe(true);
  });

  it("renders a fenced code language badge and reveals the fence when touched", () => {
    const doc = "```js\nconst x = 1;\n```\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector(".cm-md-code-language")?.textContent).toBe("js");

    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-md-code-language")).toBeNull();
    expect(view.dom.querySelector(".cm-line")?.textContent).toContain("```js");
  });

  it("labels external diagram fences as source-only", () => {
    const doc = "```plantuml\n@startuml\nAlice -> Bob: Hello\n@enduml\n```\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    const hint = view.dom.querySelector(".cm-md-code-external");
    expect(hint?.textContent).toBe("需外部渲染");
    expect(hint?.getAttribute("title")).toContain("PlantUML 需要外部渲染器");
    expect(view.dom.querySelector(".cm-md-code-language")?.textContent).toBe("plantuml");
    expect(view.dom.textContent).toContain("@startuml");
  });

  it("renders fenced code titles and highlighted lines", () => {
    const doc =
      '```js title="app.js" {2,4-5}\n' +
      "const a = 1;\n" +
      "console.log(a); // 高亮\n" +
      "const b = 2;\n" +
      "console.log(b); // 高亮\n" +
      "console.log(a + b); // 高亮\n" +
      "```\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector(".cm-md-code-language")?.textContent).toBe("js");
    expect(view.dom.querySelector(".cm-md-code-title")?.textContent).toBe("app.js");
    expect(
      Array.from(view.dom.querySelectorAll(".cm-line.cm-md-code-highlight")).map(
        (line) => line.textContent,
      ),
    ).toEqual([
      "console.log(a); // 高亮",
      "console.log(b); // 高亮",
      "console.log(a + b); // 高亮",
    ]);

    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-md-code-title")).toBeNull();
    expect(view.dom.querySelector(".cm-line")?.textContent).toContain("```js");
  });

  it("colors diff code block lines", () => {
    const doc =
      "```diff\n" +
      "--- a/app.ts\n" +
      "+++ b/app.ts\n" +
      "@@ -1 +1 @@\n" +
      "-const port = 3000;\n" +
      "+const port = 8080;\n" +
      '  const host = "localhost";\n' +
      "```\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector(".cm-line.cm-md-code-diff-add")?.textContent).toBe(
      "+const port = 8080;",
    );
    expect(view.dom.querySelector(".cm-line.cm-md-code-diff-del")?.textContent).toBe(
      "-const port = 3000;",
    );
    expect(view.dom.querySelectorAll(".cm-line.cm-md-code-diff-meta")).toHaveLength(3);
    expect(view.dom.querySelector(".cm-line.cm-md-code-diff-add")?.textContent).not.toContain(
      "localhost",
    );
  });

  it("renders a GFM table as a block widget and reveals its source on click", () => {
    const doc = "| A | B |\n| :- | -: |\n| 1 | 2 |\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    // Caret starts in the table: the source is visible and styled.
    expect(view.dom.querySelector(".cm-md-table-header")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-table-block")).toBeNull();

    // Moving outside the table renders it as a real block widget.
    view.dispatch({ selection: { anchor: doc.length } });
    const block = view.dom.querySelector(".cm-md-table-block");
    expect(block).not.toBeNull();
    expect(block?.querySelector("table")).not.toBeNull();
    expect(block?.querySelector("th")?.textContent).toBe("A");
    expect(view.dom.querySelector(".cm-md-table-header")).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);

    // Clicking the rendered table returns to the editable source.
    block?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(0);
    expect(view.dom.querySelector(".cm-md-table-block")).toBeNull();
    expect(view.dom.querySelector(".cm-md-table-header")).not.toBeNull();
  });

  it("renders highlight, sub/sup and safe inline HTML inside table cells", () => {
    const doc =
      "| 语法 | 渲染 |\n" +
      "| --- | --- |\n" +
      "| 高亮 | ==重点== |\n" +
      "| 下标 | H~2~O |\n" +
      "| 上标 | x^2^ |\n" +
      "| HTML | <mark>标记</mark> <ins>插入</ins> <u>下划线</u> H<sub>2</sub>O |\n" +
      "| 混合 | **粗体**、`code`、~~删除~~ |\n" +
      "| 危险 | <script>alert(1)</script> <img src=x onerror=alert(1)> |\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    const block = view.dom.querySelector(".cm-md-table-block");
    const rows = block?.querySelectorAll("tbody tr") ?? [];

    expect(rows[0]?.querySelector("mark.cm-md-highlight")?.textContent).toBe("重点");
    expect(rows[1]?.querySelector("sub")?.textContent).toBe("2");
    expect(rows[2]?.querySelector("sup")?.textContent).toBe("2");
    expect(rows[3]?.querySelector("mark")?.textContent).toBe("标记");
    expect(rows[3]?.querySelector("ins")?.textContent).toBe("插入");
    expect(rows[3]?.querySelector("u")?.textContent).toBe("下划线");
    expect(rows[3]?.querySelector("sub")?.textContent).toBe("2");
    expect(rows[4]?.querySelector("strong")?.textContent).toBe("粗体");
    expect(rows[4]?.querySelector("code")?.textContent).toBe("code");
    expect(rows[4]?.querySelector(".cm-md-strike")?.textContent).toBe("删除");

    // Unknown tags and attributes never become DOM elements.
    expect(rows[5]?.querySelector("script")).toBeNull();
    expect(rows[5]?.querySelector("img")).toBeNull();
    expect(rows[5]?.textContent).toContain("<script>alert(1)</script>");
    expect(rows[5]?.textContent).toContain("onerror=alert(1)");
  });

  it("renders the Markdown syntax guide's inline syntax table", () => {
    const guide = readFileSync("docs/MARKDOWN-SYNTAX.md", "utf8");
    const start = guide.indexOf("| 语法 | 写法 | 渲染 | 支持度 |");
    const end = guide.indexOf("\n\n", start);
    expect(start).toBeGreaterThan(-1);

    const doc = `${guide.slice(start, end)}\n`;
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const tables = Array.from(view.dom.querySelectorAll(".cm-md-table-block"));
    const table = tables.find(
      (block) =>
        Array.from(block.querySelectorAll("th"))
          .map((cell) => cell.textContent)
          .join("|") === "语法|写法|渲染|支持度",
    );
    expect(table).toBeDefined();
    if (!table) {
      return;
    }

    const rowFor = (label: string) =>
      Array.from(table.querySelectorAll("tbody tr")).find(
        (row) => row.querySelector("td")?.textContent === label,
      );

    expect(rowFor("高亮")?.querySelector("mark.cm-md-highlight")?.textContent).toBe("文本");
    expect(rowFor("下标")?.querySelector("sub")?.textContent).toBe("2");
    expect(rowFor("上标")?.querySelector("sup")?.textContent).toBe("2");
    expect(rowFor("下标（HTML）")?.querySelector("sub")?.textContent).toBe("2");
    expect(rowFor("下划线")?.querySelector("u")?.textContent).toBe("文本");
    expect(rowFor("标记")?.querySelector("mark")?.textContent).toBe("文本");
    expect(rowFor("插入")?.querySelector("ins")?.textContent).toBe("文本");
  });

  it("renders safe inline HTML, comments, emoji, alerts and footnotes", () => {
    const doc =
      "a <kbd>Ctrl</kbd> + <mark>高亮</mark> b\n" +
      "\n" +
      "<!-- hidden comment -->\n" +
      "\n" +
      ":smile: :rocket: :unknown_thing:\n" +
      "\n" +
      "> [!NOTE]\n" +
      "> useful\n" +
      "\n" +
      "Text[^1].\n" +
      "\n" +
      "[^1]: Footnote text.\n" +
      "\n" +
      "<hr>\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    expect(view.dom.querySelector("kbd")?.textContent).toBe("Ctrl");
    expect(view.dom.querySelector("mark.cm-md-highlight")?.textContent).toBe("高亮");
    expect(view.dom.textContent).not.toContain("hidden comment");

    expect(view.dom.querySelectorAll(".cm-md-emoji")).toHaveLength(2);
    expect(view.dom.textContent).toContain(":unknown_thing:");

    expect(view.dom.querySelector(".cm-md-alert-label")?.textContent).toBe("NOTE");
    expect(view.dom.querySelector(".cm-md-alert")).not.toBeNull();

    expect(view.dom.querySelector(".cm-md-footnote-ref")?.textContent).toBe("1");
    expect(view.dom.querySelector(".cm-md-footnote-def-label")?.textContent).toBe("1.");
    expect(view.dom.querySelector(".cm-md-footnote-def")).not.toBeNull();

    expect(view.dom.querySelector(".cm-md-rule")).not.toBeNull();
  });

  it("jumps from a footnote reference to its definition", () => {
    const doc = "Text[^1].\n" + "\n" + "填充段落。\n\n".repeat(10) + "[^1]: Footnote text.\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: 0 } });

    const reference = view.dom.querySelector<HTMLElement>(".cm-md-footnote-jump");
    expect(reference?.textContent).toBe("1");
    reference?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("[^1]:"));
  });

  it("renders inline footnotes and preserves literal markers", () => {
    const doc =
      "行内脚注^[直接写在正文中。] 与第二处^[另一条]。\n" + "\n" + "`^[代码]` 和 \\^[转义]\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const notes = view.dom.querySelectorAll<HTMLElement>(".cm-md-footnote-inline");
    expect(notes).toHaveLength(2);
    expect(notes[0]?.textContent).toBe("注1");
    expect(notes[0]?.title).toBe("直接写在正文中。");
    expect(notes[1]?.textContent).toBe("注2");
    expect(view.dom.textContent).not.toContain("直接写在正文中。");
    expect(view.dom.textContent).toContain("^[代码]");
    expect(view.dom.textContent).toContain("转义");

    view.dispatch({ selection: { anchor: doc.indexOf("^[") } });
    expect(view.dom.querySelectorAll(".cm-md-footnote-inline")).toHaveLength(1);
    expect(view.dom.textContent).toContain("^[直接写在正文中。]");
  });

  it("renders inline and block math with KaTeX", () => {
    const doc = "质能方程 $E = mc^2$ 与 $5 and $10\n\n$$\n\\int_0^1 x^2 dx\n$$\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    expect(view.dom.querySelectorAll(".cm-md-math-inline .katex")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".cm-md-math-block .katex")).toHaveLength(1);
    expect(view.dom.textContent).toContain("$5 and $10");
  });

  it("renders fenced math blocks and reveals their source on click", () => {
    const doc = "```math\n\\sum_{i=1}^{n} i\n```\n\n结尾段落\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    const block = view.dom.querySelector<HTMLElement>(".cm-md-math-block");
    expect(block?.querySelector(".katex")).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-code-language")).toBeNull();

    block?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(0);
    expect(view.dom.textContent).toContain("```math");
  });

  it("renders front matter as a metadata card", () => {
    const doc = "---\ntitle: Guide\ntags:\n  - a\n  - b\n---\n\n# Heading\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const card = view.dom.querySelector(".cm-md-frontmatter");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("title");
    expect(card?.textContent).toContain("Guide");
    expect(card?.textContent).toContain("tags");
    expect(view.dom.textContent).not.toContain("title: Guide");

    // Editing front matter reveals the YAML source and suppresses block widgets.
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-md-frontmatter")).toBeNull();
    expect(view.dom.textContent).toContain("title: Guide");
  });

  it("renders a table of contents and jumps to headings", () => {
    const doc = "[TOC]\n\n# First\n\n## Sub\n\n# Second\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const toc = view.dom.querySelector(".cm-md-toc");
    expect(toc).not.toBeNull();
    expect(toc?.textContent).toContain("First");
    expect(toc?.textContent).toContain("Sub");
    expect(toc?.textContent).toContain("Second");

    const first = view.dom.querySelector<HTMLButtonElement>(".cm-md-toc-item");
    first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("# First"));

    // Selecting the placeholder reveals its source instead of the widget.
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-md-toc")).toBeNull();
    expect(view.dom.textContent).toContain("[TOC]");
  });

  it("renders definition lists and reveals source in selection", () => {
    const doc = "CommonMark\n: 一个标准化的 Markdown 规范。\n: 由多方共同维护。\n\nAfter\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const list = view.dom.querySelector(".cm-md-definition-list");
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("CommonMark");
    expect(list?.textContent).toContain("一个标准化的 Markdown 规范。");
    expect(list?.textContent).toContain("由多方共同维护。");

    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-md-definition-list")).toBeNull();
    expect(view.dom.textContent).toContain(": 一个标准化的 Markdown 规范。");
  });

  it("renders a collapsible details block and returns to source on edit", () => {
    const doc =
      "<details>\n" +
      "<summary>查看日志</summary>\n" +
      "\n" +
      "```text\n" +
      "log line\n" +
      "```\n" +
      "\n" +
      "</details>\n" +
      "\n" +
      "After\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const details = view.dom.querySelector(".cm-md-details");
    expect(details).not.toBeNull();
    expect(view.dom.querySelector(".cm-md-details-label")?.textContent).toBe("查看日志");

    const content = view.dom.querySelector<HTMLDivElement>(".cm-md-details-content");
    expect(content?.hidden).toBe(true);
    expect(content?.textContent).toContain("log line");

    view.dom.querySelector<HTMLButtonElement>(".cm-md-details-summary")?.click();
    expect(content?.hidden).toBe(false);

    view.dom
      .querySelector<HTMLButtonElement>(".cm-md-details-edit")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.dom.querySelector(".cm-md-details")).toBeNull();
    expect(view.dom.textContent).toContain("<summary>查看日志</summary>");
  });

  it("renders details without blank lines and nested details", () => {
    const doc =
      "<details>\n" +
      "  <summary>无空行</summary>\n" +
      "  隐藏内容\n" +
      "</details>\n" +
      "\n" +
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
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const topLevel = view.dom.querySelectorAll(".cm-md-details:not(.cm-md-details-nested)");
    expect(topLevel).toHaveLength(2);
    expect(topLevel[0]?.querySelector(".cm-md-details-label")?.textContent).toBe("无空行");
    expect(topLevel[0]?.querySelector(".cm-md-details-content")?.textContent).toContain("隐藏内容");

    const nested = topLevel[1]?.querySelector<HTMLElement>(".cm-md-details-nested");
    expect(nested?.querySelector(".cm-md-details-label")?.textContent).toBe("内层");
    const nestedContent = nested?.querySelector<HTMLDivElement>(".cm-md-details-content");
    expect(nestedContent?.hidden).toBe(false);
    expect(nestedContent?.textContent).toContain("内层内容");

    nested?.querySelector<HTMLButtonElement>(".cm-md-details-summary")?.click();
    expect(nestedContent?.hidden).toBe(true);

    nested
      ?.querySelector<HTMLButtonElement>(".cm-md-details-edit")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.dom.querySelector(".cm-md-details-nested")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-md-details:not(.cm-md-details-nested)")).toHaveLength(1);
    expect(view.dom.textContent).toContain("<summary>内层</summary>");
  });

  it("renders abbreviation definitions and marks their occurrences", () => {
    const doc =
      "*[HTML]: HyperText Markup Language\n" +
      "\n" +
      "HTML 是一种标记语言，HTML5 不是。`HTML` 也不替换。\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const definition = view.dom.querySelector(".cm-md-abbr-def");
    expect(definition).not.toBeNull();
    expect(definition?.textContent).toContain("HTML");
    expect(definition?.textContent).toContain("HyperText Markup Language");

    const marks = view.dom.querySelectorAll(".cm-md-abbr");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe("HTML");
    expect(marks[0]?.getAttribute("title")).toBe("HyperText Markup Language");

    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".cm-md-abbr-def")).toBeNull();
    expect(view.dom.textContent).toContain("*[HTML]: HyperText Markup Language");
  });

  it("renders Obsidian wiki links and embeds", () => {
    const doc =
      "See [[笔记名称]] and [[笔记名称|显示文字]] and [[笔记名称#标题]].\n" +
      "\n" +
      "![[图片.png]] and ![[笔记名称]]\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const links = view.dom.querySelectorAll(".cm-md-wiki-link");
    expect(links).toHaveLength(4);
    expect(links[0]?.textContent).toContain("笔记名称");
    expect(links[1]?.textContent).toContain("显示文字");
    expect(links[2]?.textContent).toContain("笔记名称#标题");
    expect(links[3]?.classList.contains("cm-md-wiki-embed")).toBe(true);
    expect(links[3]?.textContent).toContain("笔记名称");
    expect(links[0]?.getAttribute("title")).toBe("双链：笔记名称");
    expect(links[3]?.getAttribute("title")).toBe("嵌入：笔记名称（不展开笔记内容）");

    const image = view.dom.querySelector(".cm-md-image");
    expect(image?.textContent).toContain("图片.png");
    expect(image?.getAttribute("title")).toBe("嵌入图片：图片.png");

    view.dispatch({ selection: { anchor: doc.indexOf("[[") } });
    expect(view.dom.textContent).toContain("[[笔记名称]]");
  });

  it("renders Obsidian image embeds with size aliases", () => {
    const doc = "![[图片.png|120x80]] and ![[笔记名称|120]]\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const image = view.dom.querySelector<HTMLImageElement>(".cm-md-image img");
    expect(image?.getAttribute("width")).toBe("120");
    expect(image?.getAttribute("height")).toBe("80");
    expect(view.dom.querySelector(".cm-md-wiki-embed")?.textContent).toContain("笔记名称");
  });

  it("renders video, audio and picture blocks with a source escape hatch", () => {
    const doc =
      '<video src="./demo.mp4" controls width="480" title="Demo"></video>\n' +
      "\n" +
      '<audio src="./demo.mp3" controls></audio>\n' +
      "\n" +
      "<picture>\n" +
      '<source srcset="./dark.png" media="(prefers-color-scheme: dark)" />\n' +
      '<img src="./light.png" alt="Logo" />\n' +
      "</picture>\n" +
      "\n" +
      '<iframe src="https://example.com/demo" width="480" height="270"></iframe>\n';
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const video = view.dom.querySelector<HTMLVideoElement>(".cm-md-media-video video");
    expect(video?.getAttribute("src")).toBe("./demo.mp4");
    expect(video?.getAttribute("width")).toBe("480");
    expect(video?.controls).toBe(true);

    const audio = view.dom.querySelector<HTMLAudioElement>(".cm-md-media-audio audio");
    expect(audio?.getAttribute("src")).toBe("./demo.mp3");

    const picture = view.dom.querySelector<HTMLPictureElement>(".cm-md-media-picture picture");
    expect(picture?.querySelector("source")?.getAttribute("srcset")).toBe("./dark.png");
    expect(picture?.querySelector("img")?.getAttribute("alt")).toBe("Logo");

    const embed = view.dom.querySelector(".cm-md-media-iframe");
    expect(embed?.querySelector("iframe")).toBeNull();
    expect(embed?.textContent).toContain("example.com/demo");
    expect(embed?.textContent).toContain("外部嵌入");

    view.dom
      .querySelector<HTMLButtonElement>(".cm-md-media-video .cm-md-media-edit")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.dom.querySelector(".cm-md-media-video")).toBeNull();
    expect(view.dom.textContent).toContain('<video src="./demo.mp4"');
    expect(view.dom.querySelector(".cm-md-media-audio")).not.toBeNull();
  });

  it("renders HTML figures, standalone images and centered containers", () => {
    const doc =
      "<figure>\n" +
      '<img src="./arch.png" alt="架构图" width="400" />\n' +
      "<figcaption>图 1：**系统**架构示意</figcaption>\n" +
      "</figure>\n" +
      "\n" +
      '<img src="./pic.png" alt="示例" width="50%" />\n' +
      "\n" +
      '<div align="center">\n' +
      '<img src="./center.png" alt="居中图片" width="320" />\n' +
      "</div>\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const figure = view.dom.querySelector(".cm-md-figure");
    expect(figure?.querySelector("img")?.getAttribute("alt")).toBe("架构图");
    expect(figure?.querySelector("img")?.getAttribute("width")).toBe("400");
    expect(figure?.querySelector("figcaption")?.textContent).toBe("图 1：系统架构示意");
    expect(figure?.querySelector("figcaption strong")?.textContent).toBe("系统");

    const image = view.dom.querySelector(".cm-md-media-img img");
    expect(image?.getAttribute("alt")).toBe("示例");
    expect(image?.getAttribute("width")).toBe("50%");

    const center = view.dom.querySelector(".cm-md-center-image img");
    expect(center?.getAttribute("alt")).toBe("居中图片");
    expect(center?.getAttribute("width")).toBe("320");
  });

  it("collapses HTML and Obsidian comment blocks into badges", () => {
    const doc =
      "<!--\n多行注释\n也不会渲染\n-->\n" + "\n" + "%% Obsidian 注释 %%\n" + "\n" + "正文\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const comments = view.dom.querySelectorAll(".cm-md-comment");
    expect(comments).toHaveLength(2);
    expect(comments[0]?.textContent).toContain("HTML 注释");
    expect(comments[1]?.textContent).toContain("Obsidian 注释");
    expect(view.dom.textContent).not.toContain("多行注释");

    view.dom
      .querySelector<HTMLButtonElement>(".cm-md-comment-html .cm-md-comment-edit")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.dom.textContent).toContain("多行注释");
    expect(view.dom.querySelectorAll(".cm-md-comment")).toHaveLength(1);
  });

  it("applies image and paragraph attribute blocks", () => {
    const doc =
      "![alt](./pic.png){width=200 height=100}\n" +
      "\n" +
      "一段文字\n" +
      "{: .warning #custom-id}\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const image = view.dom.querySelector<HTMLImageElement>(".cm-md-image img");
    expect(image?.getAttribute("width")).toBe("200");
    expect(image?.getAttribute("height")).toBe("100");
    expect(view.dom.textContent).not.toContain("{width=200");

    const badge = view.dom.querySelector(".cm-md-attr-badge");
    expect(badge?.textContent).toContain("属性");
    expect(badge?.textContent).toContain(".warning #custom-id");
    expect(view.dom.querySelector(".cm-line.cm-md-attr-warning")).not.toBeNull();
    expect(view.dom.textContent).not.toContain("{: .warning");

    view.dispatch({ selection: { anchor: doc.indexOf("{:") } });
    expect(view.dom.querySelector(".cm-md-attr-badge")).toBeNull();
    expect(view.dom.textContent).toContain("{: .warning #custom-id}");
  });

  it("jumps to paragraph attribute ids", () => {
    const doc =
      "前言段落。\n" +
      "\n" +
      "目标段落\n" +
      "{: .warning #custom-id}\n" +
      "\n" +
      "跳转 [目标](#custom-id)\n" +
      "\n" +
      "结尾段落\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const link = view.dom.querySelector<HTMLElement>(".cm-md-anchor-link");
    expect(link?.textContent).toBe("目标");
    link?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("目标段落"));
  });

  it("renders explicit HTML anchors and jumps to the following heading", () => {
    const doc =
      '<a id="install"></a>\n' +
      "## 安装\n" +
      "\n" +
      "跳转 [安装](#install)\n" +
      "\n" +
      "结尾段落\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const badge = view.dom.querySelector(".cm-md-html-anchor");
    expect(badge?.textContent).toContain("#install");
    expect(view.dom.textContent).not.toContain("<a id=");

    const link = view.dom.querySelector<HTMLElement>(".cm-md-anchor-link");
    expect(link?.textContent).toBe("安装");
    link?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("## 安装"));
  });

  it("hides inline Obsidian comments but keeps code spans intact", () => {
    const doc = "正文 %% 行内注释 %% 结束 %% 第二个 %%！\n" + "\n" + "`%% 代码 %%`\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    expect(view.dom.textContent).toContain("正文");
    expect(view.dom.textContent).toContain("结束");
    expect(view.dom.textContent).not.toContain("行内注释");
    expect(view.dom.textContent).not.toContain("第二个");
    expect(view.dom.textContent).toContain("%% 代码 %%");

    view.dispatch({ selection: { anchor: doc.indexOf("%%") } });
    expect(view.dom.textContent).toContain("%% 行内注释 %%");
  });

  it("jumps to headings from internal anchor links", () => {
    const doc =
      "# 第一节\n" + "\n" + "- [第一节](#第一节)\n" + "- [第二节](#第二节)\n" + "\n" + "# 第二节\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });

    const links = view.dom.querySelectorAll(".cm-md-anchor-link");
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toContain("第一节");

    links[0]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("# 第一节"));

    links[1]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("# 第二节"));
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
