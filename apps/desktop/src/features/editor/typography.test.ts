import { undo } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DEFAULT_EDITOR_TYPOGRAPHY, type FilePayload } from "@qingmo/shared";
import { afterEach, describe, expect, it } from "vitest";

import { EditorSession } from "./EditorSession";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  return {
    docToken: "token-typography",
    path: "/docs/typography.md",
    text: "hello\n",
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-typography",
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

describe("editor typography compartment", () => {
  it("defaults to 15px mono and seeds an explicit constructor value", () => {
    const defaultSession = EditorSession.create(payload());
    expect(defaultSession.getTypography()).toEqual(DEFAULT_EDITOR_TYPOGRAPHY);

    const custom = EditorSession.create(payload(), {
      typography: { fontSize: 22, fontFamily: "serif" },
    });
    expect(custom.getTypography()).toEqual({ fontSize: 22, fontFamily: "serif" });
    expect(custom.editorState.doc.toString()).toBe("hello\n");
  });

  it("normalizes constructor and apply input", () => {
    const session = EditorSession.create(payload(), {
      typography: { fontSize: 99, fontFamily: "serif" },
    });
    expect(session.getTypography()).toEqual({ fontSize: 30, fontFamily: "serif" });

    session.applyTypography({ fontSize: 1, fontFamily: "comic" } as never);
    expect(session.getTypography()).toEqual({ fontSize: 12, fontFamily: "mono" });
  });

  it("switches without rebuilding the view or losing undo history and selection", () => {
    const session = EditorSession.create(payload());
    const view = attachView(session);
    const dom = view.dom;
    const before = dom.className;

    view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 } });
    expect(session.readText()).toBe("xhello\n");
    expect(view.state.selection.main.head).toBe(1);

    session.applyTypography({ fontSize: 24, fontFamily: "sans" });

    expect(view.dom).toBe(dom);
    expect(view.dom.className).not.toBe(before);
    expect(view.state.selection.main.head).toBe(1);
    expect(session.readText()).toBe("xhello\n");

    undo({
      state: view.state,
      dispatch: (transaction: Transaction) => view.dispatch(transaction),
    });
    expect(session.readText()).toBe("hello\n");
  });

  it("is a no-op for identical values", () => {
    const session = EditorSession.create(payload(), {
      typography: { fontSize: 18, fontFamily: "mono" },
    });
    const view = attachView(session);
    const className = view.dom.className;

    session.applyTypography({ fontSize: 18, fontFamily: "mono" });

    expect(view.dom.className).toBe(className);
  });

  it("updates state before a view exists", () => {
    const session = EditorSession.create(payload());
    session.applyTypography({ fontSize: 28, fontFamily: "serif" });

    expect(session.getTypography()).toEqual({ fontSize: 28, fontFamily: "serif" });
    const view = attachView(session);
    expect(view.state.doc.toString()).toBe("hello\n");
  });

  it("carries the current typography through a reloaded payload", () => {
    const session = EditorSession.create(payload());
    session.applyTypography({ fontSize: 20, fontFamily: "sans" });
    const view = attachView(session);
    const className = view.dom.className;

    session.replacePayload(payload({ text: "reloaded\n" }));

    expect(session.getTypography()).toEqual({ fontSize: 20, fontFamily: "sans" });
    expect(view.state.doc.toString()).toBe("reloaded\n");
    expect(view.dom.className).toBe(className);
  });

  it("defers the reconfiguration until an IME composition ends", () => {
    const session = EditorSession.create(payload());
    const view = attachView(session);
    const className = view.dom.className;

    let composing = true;
    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => composing,
    });
    session.applyTypography({ fontSize: 26, fontFamily: "serif" });

    expect(view.dom.className).toBe(className);
    expect(session.getTypography()).toEqual({ fontSize: 26, fontFamily: "serif" });

    composing = false;
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(view.dom.className).not.toBe(className);
  });
});
