import { undo } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LP_MAX_UNITS } from "@qingmo/editor-core";
import type { FilePayload } from "@qingmo/shared";
import { afterEach, describe, expect, it } from "vitest";

import { EditorSession } from "./EditorSession";

const MIB = 1024 * 1024;

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  return {
    docToken: "token-large",
    path: "/docs/large.md",
    text: "# Title\n\nbody\n",
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-large",
    size: 14,
    textUnits: 14,
    mtimeMs: 1,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

function textPayload(units: number, prefix = ""): FilePayload {
  const text = `${prefix}${"a".repeat(Math.max(0, units - prefix.length))}`;
  return payload({ text, textUnits: text.length, size: text.length });
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

describe("large-file degradation", () => {
  it("keeps the 2M UTF-16 unit boundary exact", () => {
    const atLimit = EditorSession.create(textPayload(LP_MAX_UNITS));
    expect(atLimit.getSnapshot().largeFile).toBe(false);
    expect(atLimit.getSnapshot().livePreview).toBe(true);

    const overLimit = EditorSession.create(textPayload(LP_MAX_UNITS + 1));
    expect(overLimit.getSnapshot().largeFile).toBe(true);
    expect(overLimit.getSnapshot().livePreview).toBe(false);
    expect(overLimit.toggleLivePreview()).toBe(false);
    expect(overLimit.getSnapshot().livePreview).toBe(false);
  });

  it("keeps a 5MB ASCII document editable with preview off", () => {
    const session = EditorSession.create(textPayload(5 * MIB, "# Heading\n\n"));

    expect(session.getSnapshot()).toMatchObject({
      largeFile: true,
      livePreview: false,
      readOnly: false,
      saveState: "clean",
    });
    expect(session.readText()).toHaveLength(5 * MIB);
  });

  it("opens a 10MiB document without enabling preview", () => {
    const session = EditorSession.create(textPayload(10 * MIB, "# Heading\n\n"));

    expect(session.getSnapshot()).toMatchObject({
      largeFile: true,
      livePreview: false,
      readOnly: false,
    });
    expect(session.readText()).toHaveLength(10 * MIB);
  }, 20_000);

  it("reloads a large document back into source mode", () => {
    const session = EditorSession.create(payload());
    expect(session.getSnapshot().livePreview).toBe(true);

    session.replacePayload(textPayload(LP_MAX_UNITS + 1));
    expect(session.getSnapshot().largeFile).toBe(true);
    expect(session.getSnapshot().livePreview).toBe(false);
  });

  it("toggles preview in place while preserving the view, text and undo history", () => {
    const session = EditorSession.create(payload());
    const view = attachView(session);
    const parentEditor = view.dom;

    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();

    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "X" }, selection: { anchor: end + 1 } });
    expect(session.readText()).toBe("# Title\n\nbody\nX");

    expect(session.toggleLivePreview()).toBe(false);
    expect(session.getSnapshot().livePreview).toBe(false);
    expect(session.attachedView).toBe(view);
    expect(view.dom).toBe(parentEditor);
    expect(view.dom.querySelector(".cm-md-h1")).toBeNull();
    expect(session.readText()).toBe("# Title\n\nbody\nX");

    undo({
      state: view.state,
      dispatch: (transaction: Transaction) => view.dispatch(transaction),
    });
    expect(session.readText()).toBe("# Title\n\nbody\n");

    expect(session.toggleLivePreview()).toBe(true);
    expect(session.getSnapshot().livePreview).toBe(true);
    expect(session.attachedView).toBe(view);
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();
  });

  it("does not rebuild or toggle the view during IME composition", () => {
    const session = EditorSession.create(payload());
    const view = attachView(session);

    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => true,
    });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    expect(session.attachedView).toBe(view);
    expect(session.getSnapshot().livePreview).toBe(true);
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();

    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => false,
    });
    view.dispatch({ selection: { anchor: 0 } });
    expect(session.attachedView).toBe(view);
    expect(session.getSnapshot().livePreview).toBe(true);
  });
});
