import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorState } from "../createEditor";
import { editorOpenExternal, isOpenableHref } from "./link-click";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
});

function stateWith(doc: string, open: (href: string) => void, readOnly = false) {
  const state = createEditorState({
    doc,
    readOnly,
    extraExtensions: [editorOpenExternal.of({ open })],
  });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state.update({}).state;
}

function mount(doc: string, open: (href: string) => void, readOnly = false): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: stateWith(doc, open, readOnly), parent });
  views.push(view);
  return view;
}

function mouseDown(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

const INLINE_LINK_DOC = "[参考](https://example.com/a) 结尾\n";
const TABLE_LINK_DOC = "| 链接 |\n| --- |\n| https://example.com/x |\n\n结尾\n";

describe("openable hrefs", () => {
  it("accepts web, mail and protocol-relative destinations", () => {
    for (const href of [
      "https://example.com",
      "http://example.com",
      "mailto:hello@example.com",
      "//example.com/x",
      "www.example.com",
    ]) {
      expect(isOpenableHref(href)).toBe(true);
    }
  });

  it("rejects document-local and script destinations", () => {
    for (const href of [
      "#heading",
      "./OTHER.md",
      "../assets/logo.png",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
    ]) {
      expect(isOpenableHref(href)).toBe(false);
    }
  });
});

describe("inline link activation", () => {
  it("keeps the destination in data-href and never in href", () => {
    const view = mount(INLINE_LINK_DOC, () => undefined);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");

    expect(link?.textContent).toBe("参考");
    expect(link?.dataset.href).toBe("https://example.com/a");
    expect(link?.getAttribute("href")).toBeNull();
    expect(link?.getAttribute("title")).toBeNull();
  });

  it("opens on a platform-modifier click without moving the caret", () => {
    const opened: string[] = [];
    const view = mount(INLINE_LINK_DOC, (href) => opened.push(href));
    view.dispatch({ selection: { anchor: INLINE_LINK_DOC.length } });
    const before = view.state.selection;
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(link).not.toBeNull();

    const event = mouseDown(link!, { metaKey: true });

    expect(opened).toEqual(["https://example.com/a"]);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.eq(before)).toBe(true);
  });

  it("keeps a plain click for editing", () => {
    const opened: string[] = [];
    const view = mount(INLINE_LINK_DOC, (href) => opened.push(href));
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");

    mouseDown(link!, {});

    expect(opened).toEqual([]);
  });

  it("opens on a plain click in a read-only document", () => {
    const opened: string[] = [];
    const view = mount(INLINE_LINK_DOC, (href) => opened.push(href), true);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");

    mouseDown(link!, {});

    expect(opened).toEqual(["https://example.com/a"]);
  });

  it("leaves document-local links inert", () => {
    const opened: string[] = [];
    const view = mount("[说明](./OTHER.md) 结尾\n", (href) => opened.push(href));
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(link?.dataset.href).toBe("./OTHER.md");

    mouseDown(link!, { metaKey: true });

    expect(opened).toEqual([]);
  });

  it("keeps anchor links on their in-document jump", () => {
    const doc = '<a id="install"></a>\n## 安装\n\n跳转 [安装](#install)\n';
    const opened: string[] = [];
    const view = mount(doc, (href) => opened.push(href));
    const anchor = view.dom.querySelector<HTMLElement>(".cm-md-anchor-link");
    expect(anchor).not.toBeNull();

    mouseDown(anchor!, { metaKey: true });

    expect(opened).toEqual([]);
  });
});

describe("modifier link affordance", () => {
  it("marks inline links while the platform modifier is held", () => {
    const view = mount(INLINE_LINK_DOC, () => undefined);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(link).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    link!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, metaKey: true, clientX: 8, clientY: 8 }),
    );
    expect(link!.hasAttribute("data-link-hover")).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    expect(link!.hasAttribute("data-link-hover")).toBe(false);
  });

  it("does not advertise inert document-local links", () => {
    const view = mount("[说明](./OTHER.md) 结尾\n", () => undefined);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(link).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    link!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, metaKey: true, clientX: 8, clientY: 8 }),
    );
    expect(link!.hasAttribute("data-link-hover")).toBe(false);
  });

  it("marks a focused table cell whose link is covered by its editor", () => {
    const view = mount(TABLE_LINK_DOC, () => undefined);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table-block .cm-md-link");
    const textarea = view.dom.querySelector<HTMLTextAreaElement>(
      '.cm-md-table-cell-input[data-row="0"][data-col="0"]',
    );
    expect(link).not.toBeNull();
    expect(textarea).not.toBeNull();
    link!.getClientRects = () => [new DOMRect(0, 0, 120, 20)] as unknown as DOMRectList;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    textarea!.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        metaKey: true,
        clientX: 10,
        clientY: 10,
      }),
    );

    expect(textarea!.hasAttribute("data-link-hover")).toBe(true);
  });

  it("keeps read-only links discoverable without a modifier", () => {
    const view = mount(INLINE_LINK_DOC, () => undefined, true);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(link).not.toBeNull();

    link!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 8, clientY: 8 }));

    expect(link!.hasAttribute("data-link-hover")).toBe(true);
  });

  it("marks line-end links so the trailing badge stays at the baseline", () => {
    const endView = mount("[参考](https://example.com/a)\n", () => undefined);
    const endLink = endView.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(endLink).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    endLink!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, metaKey: true, clientX: 8, clientY: 8 }),
    );
    expect(endLink!.hasAttribute("data-link-tail")).toBe(true);

    const inlineView = mount("[参考](https://example.com/a) 之后\n", () => undefined);
    const inlineLink = inlineView.dom.querySelector<HTMLElement>(".cm-md-link");
    expect(inlineLink).not.toBeNull();
    inlineLink!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, metaKey: true, clientX: 8, clientY: 8 }),
    );
    expect(inlineLink!.hasAttribute("data-link-tail")).toBe(false);
  });
});

describe("table cell links", () => {
  it("renders bare GFM URLs as links with their destination", () => {
    const view = mount(TABLE_LINK_DOC, () => undefined);
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table-block .cm-md-link");

    expect(link?.textContent).toBe("https://example.com/x");
    expect(link?.dataset.href).toBe("https://example.com/x");
    expect(link?.getAttribute("href")).toBeNull();
  });

  it("keeps the whole raw cell value for the editor", () => {
    const doc = "| 链接 |\n| --- |\n| https://a.example ｜ https://b.example |\n";
    const view = mount(doc, () => undefined);
    const textarea = view.dom.querySelector<HTMLTextAreaElement>(
      '.cm-md-table-cell-input[data-row="0"][data-col="0"]',
    );

    expect(textarea?.tagName).toBe("TEXTAREA");
    expect(textarea?.value).toBe("https://a.example ｜ https://b.example");
  });

  it("opens on a platform-modifier click and edits on a plain click", () => {
    const opened: string[] = [];
    const view = mount(TABLE_LINK_DOC, (href) => opened.push(href));
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table-block .cm-md-link");
    const textarea = view.dom.querySelector<HTMLTextAreaElement>(
      '.cm-md-table-cell-input[data-row="0"][data-col="0"]',
    );
    expect(link).not.toBeNull();
    expect(textarea).not.toBeNull();

    mouseDown(link!, { metaKey: true });
    expect(opened).toEqual(["https://example.com/x"]);
    expect(document.activeElement).not.toBe(textarea);

    mouseDown(link!, {});
    expect(opened).toEqual(["https://example.com/x"]);
    expect(document.activeElement).toBe(textarea);
  });

  it("opens on a platform-modifier click when the cell editor is focused", () => {
    const opened: string[] = [];
    const view = mount(TABLE_LINK_DOC, (href) => opened.push(href));
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table-block .cm-md-link");
    const textarea = view.dom.querySelector<HTMLTextAreaElement>(
      '.cm-md-table-cell-input[data-row="0"][data-col="0"]',
    );
    expect(link).not.toBeNull();
    expect(textarea).not.toBeNull();
    // jsdom has no layout: give the rendered link a rectangle and aim the
    // modifier click at the transparent textarea that covers it.
    link!.getClientRects = () => [new DOMRect(0, 0, 120, 20)] as unknown as DOMRectList;

    textarea!.focus();
    mouseDown(textarea!, { metaKey: true, clientX: 10, clientY: 10 });

    expect(opened).toEqual(["https://example.com/x"]);
  });

  it("opens on a plain click when the table is read-only", () => {
    const opened: string[] = [];
    const view = mount(TABLE_LINK_DOC, (href) => opened.push(href), true);
    expect(view.dom.querySelector(".cm-md-table-cell-input")).toBeNull();
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table-block .cm-md-link");

    mouseDown(link!, {});

    expect(opened).toEqual(["https://example.com/x"]);
  });

  it("opens the destination of a Markdown link cell", () => {
    const doc = "| 链接 |\n| --- |\n| [参考](https://example.com/doc) |\n";
    const opened: string[] = [];
    const view = mount(doc, (href) => opened.push(href));
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table-block .cm-md-link");
    expect(link?.textContent).toBe("参考");

    mouseDown(link!, { metaKey: true });

    expect(opened).toEqual(["https://example.com/doc"]);
  });
});
