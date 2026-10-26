import { undo } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FilePayload } from "@qingmo/shared";
import { afterEach, describe, expect, it } from "vitest";

import { EditorSession } from "./EditorSession";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  return {
    docToken: "token-theme",
    path: "/docs/theme.md",
    text: "hello\n",
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-theme",
    size: 6,
    textUnits: 6,
    mtimeMs: 1,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

const openViews: Array<{ view: EditorView; parent: HTMLDivElement }> = [];

function attachView(session: EditorSession): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: session.editorState, parent });
  session.attach(view);
  openViews.push({ view, parent });
  return view;
}

afterEach(() => {
  for (const { view, parent } of openViews.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

describe("editor theme compartment", () => {
  it("switches theme without rebuilding the view or losing undo history", () => {
    const session = EditorSession.create(payload());
    const view = attachView(session);
    const dom = view.dom;

    expect(view.state.facet(EditorView.darkTheme)).toBe(false);

    view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 } });
    expect(session.readText()).toBe("xhello\n");

    session.applyTheme("dark");

    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    expect(view.dom).toBe(dom);
    expect(session.readText()).toBe("xhello\n");

    undo({
      state: view.state,
      dispatch: (transaction: Transaction) => view.dispatch(transaction),
    });
    expect(session.readText()).toBe("hello\n");

    session.applyTheme("light");
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    expect(view.dom).toBe(dom);
  });

  it("carries the current theme through a reloaded payload", () => {
    const session = EditorSession.create(payload());
    session.applyTheme("dark");

    const view = attachView(session);
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    session.replacePayload(payload({ text: "reloaded\n" }));

    expect(session.readText()).toBe("reloaded\n");
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  });
});
