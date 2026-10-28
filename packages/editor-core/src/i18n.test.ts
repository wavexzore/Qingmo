import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  createEditorState,
  DEFAULT_EDITOR_UI_COPY,
  editorUiCopy,
  localizeWidget,
  setEditorUiCopyEffect,
  type EditorUiCopy,
} from "./index";

function copy(version: string, label: string): EditorUiCopy {
  return {
    ...DEFAULT_EDITOR_UI_COPY,
    version,
    language: version.split(":")[0] ?? version,
    widgets: {
      ...DEFAULT_EDITOR_UI_COPY.widgets,
      externalRender: label,
    },
  };
}

describe("EditorUiCopy facet", () => {
  it("defaults to the English neutral copy without i18next", () => {
    const state = createEditorState({ doc: "hello\n" });

    expect(state.facet(editorUiCopy)).toBe(DEFAULT_EDITOR_UI_COPY);
    expect(DEFAULT_EDITOR_UI_COPY.version).toBe("en:1");
    expect(JSON.stringify(DEFAULT_EDITOR_UI_COPY)).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("reconfigures the facet without rebuilding state or touching the document", () => {
    const zh = copy("zh-CN:1", "需外部渲染");
    const en = copy("en:1", "External render");
    const state = createEditorState({ doc: "hello\n", uiCopy: zh });

    const next = state.update({ effects: setEditorUiCopyEffect(en) }).state;

    expect(next).not.toBe(state);
    expect(next.doc.toString()).toBe("hello\n");
    expect(next.facet(editorUiCopy)).toBe(en);
    expect(next.facet(EditorState.readOnly)).toBe(false);
  });

  it("renders through the facet and replaces DOM after a copy change", () => {
    const zh = copy("zh-CN:1", "需外部渲染");
    const en = copy("en:1", "External render");
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: createEditorState({ doc: "x", uiCopy: zh }),
      parent,
    });

    try {
      const widget = localizeWidget({
        content: "x",
        copyVersion: zh.version,
        sameContent: (left, right) => left === right,
        render: (_content, current) => {
          const element = document.createElement("span");
          element.textContent = current.widgets.externalRender;
          return element;
        },
      });

      expect(widget.toDOM(view).textContent).toBe("需外部渲染");

      view.dispatch({ effects: setEditorUiCopyEffect(en) });
      expect(widget.toDOM(view).textContent).toBe("External render");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("compares widget content and copy version", () => {
    const first = copy("zh-CN:1", "需外部渲染");
    const second = copy("en:1", "External render");
    const make = (content: string, current: EditorUiCopy) =>
      localizeWidget({
        content,
        copyVersion: current.version,
        sameContent: (left, right) => left === right,
        render: () => document.createElement("span"),
      });

    expect(make("x", first).eq(make("x", first))).toBe(true);
    expect(make("x", first).eq(make("y", first))).toBe(false);
    expect(make("x", first).eq(make("x", second))).toBe(false);
  });
});
