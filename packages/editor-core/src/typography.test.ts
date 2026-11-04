import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorState, typographyExtension } from "./index";

const openViews: Array<{ view: EditorView; parent: HTMLDivElement }> = [];

function mount(extensions = [typographyExtension({ fontSize: 20, fontFamily: "serif" })]) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: "hello\n", extensions }),
    parent,
  });
  openViews.push({ view, parent });
  return view;
}

afterEach(() => {
  for (const { view, parent } of openViews.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

describe("typographyExtension", () => {
  it("emits the size, family token, and fixed line height", () => {
    mount();

    const css = document.head.textContent ?? "";
    expect(css).toContain("font-size: 20px");
    expect(css).toContain("font-family: var(--qm-font-serif)");
    expect(css).toContain("line-height: 1.75");
  });

  it("reuses the same extension for identical values and differs per value", () => {
    const first = typographyExtension({ fontSize: 18, fontFamily: "sans" });
    const second = typographyExtension({ fontSize: 18, fontFamily: "sans" });
    const otherSize = typographyExtension({ fontSize: 19, fontFamily: "sans" });
    const otherFamily = typographyExtension({ fontSize: 18, fontFamily: "serif" });

    expect(second).toBe(first);
    expect(otherSize).not.toBe(first);
    expect(otherFamily).not.toBe(first);
  });

  it("normalizes out-of-range input before generating styles", () => {
    mount([typographyExtension({ fontSize: 99, fontFamily: "serif" })]);

    expect(document.head.textContent ?? "").toContain("font-size: 30px");
  });

  it("installs typography through createEditorState", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: createEditorState({
        doc: "hello\n",
        typography: { fontSize: 12, fontFamily: "mono" },
      }),
      parent,
    });
    openViews.push({ view, parent });

    expect(document.head.textContent ?? "").toContain("font-size: 12px");
    expect(view.state.doc.toString()).toBe("hello\n");
  });
});
