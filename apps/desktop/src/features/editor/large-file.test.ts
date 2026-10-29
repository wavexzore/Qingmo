import { undo } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PREVIEW_PARTIAL_MAX_UNITS, livePreviewPlugin } from "@qingmo/editor-core";
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

function settleModeSync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const { view, parent } of openViews.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

describe("large-file degradation", () => {
  it("keeps the 2M UTF-16 unit boundary exact", () => {
    const atLimit = EditorSession.create(textPayload(PREVIEW_PARTIAL_MAX_UNITS));
    expect(atLimit.getSnapshot()).toMatchObject({
      previewTier: "partial",
      livePreviewPreferred: true,
      livePreview: true,
    });

    const overLimit = EditorSession.create(textPayload(PREVIEW_PARTIAL_MAX_UNITS + 1));
    expect(overLimit.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: true,
      livePreview: false,
    });
    expect(overLimit.toggleLivePreview()).toBe(false);
    expect(overLimit.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: true,
      livePreview: false,
    });
  });

  it("keeps a 5MB ASCII document editable with preview off", () => {
    const session = EditorSession.create(textPayload(5 * MIB, "# Heading\n\n"));

    expect(session.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: true,
      livePreview: false,
      readOnly: false,
      saveState: "clean",
    });
    expect(session.readText()).toHaveLength(5 * MIB);
  });

  it("opens a 10MiB document without enabling preview", () => {
    const session = EditorSession.create(textPayload(10 * MIB, "# Heading\n\n"));

    expect(session.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: true,
      livePreview: false,
      readOnly: false,
    });
    expect(session.readText()).toHaveLength(10 * MIB);
  }, 20_000);

  it("reloads a large document back into source mode and restores preview when it shrinks", () => {
    const session = EditorSession.create(payload());
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreviewPreferred: true,
      livePreview: true,
    });

    session.replacePayload(textPayload(PREVIEW_PARTIAL_MAX_UNITS + 1));
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: true,
      livePreview: false,
    });

    session.replacePayload(payload());
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreviewPreferred: true,
      livePreview: true,
    });
  });

  it("preserves a user-disabled preference across reloads", () => {
    const session = EditorSession.create(payload());
    expect(session.toggleLivePreview()).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      livePreviewPreferred: false,
      livePreview: false,
    });

    session.replacePayload(payload({ text: "other\n", textUnits: 6, size: 6 }));
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreviewPreferred: false,
      livePreview: false,
    });

    session.replacePayload(textPayload(PREVIEW_PARTIAL_MAX_UNITS + 1));
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: false,
      livePreview: false,
    });

    session.replacePayload(payload());
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreviewPreferred: false,
      livePreview: false,
    });

    expect(session.toggleLivePreview()).toBe(true);
    expect(session.getSnapshot()).toMatchObject({
      livePreviewPreferred: true,
      livePreview: true,
    });
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
    expect(session.getSnapshot()).toMatchObject({
      livePreviewPreferred: false,
      livePreview: false,
    });
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
    expect(session.getSnapshot()).toMatchObject({
      livePreviewPreferred: true,
      livePreview: true,
    });
    expect(session.attachedView).toBe(view);
    expect(view.dom.querySelector(".cm-md-h1")).not.toBeNull();
  });

  it("syncs the mode compartment when the document crosses 2M in a live view", async () => {
    const session = EditorSession.create(textPayload(PREVIEW_PARTIAL_MAX_UNITS));
    const view = attachView(session);

    expect(session.getSnapshot().previewTier).toBe("partial");
    expect(session.getSnapshot().livePreview).toBe(true);
    expect(view.plugin(livePreviewPlugin)).not.toBeNull();
    expect(view.dom.dataset.livePreview).toBe("true");

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
    });
    await settleModeSync();

    expect(session.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreviewPreferred: true,
      livePreview: false,
    });
    expect(view.plugin(livePreviewPlugin)).toBeNull();
    expect(view.dom.dataset.livePreview).toBeUndefined();

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "# Title\n\nbody\n" },
      selection: { anchor: 0 },
    });
    await settleModeSync();

    expect(session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreviewPreferred: true,
      livePreview: true,
    });
    expect(view.plugin(livePreviewPlugin)).not.toBeNull();
    expect(view.dom.dataset.livePreview).toBe("true");
  });

  it("defers the mode sync until IME composition ends", async () => {
    const session = EditorSession.create(textPayload(PREVIEW_PARTIAL_MAX_UNITS));
    const view = attachView(session);

    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => true,
    });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    await settleModeSync();

    expect(session.getSnapshot()).toMatchObject({
      previewTier: "source",
      livePreview: false,
    });
    // The snapshot is already source, but the extension must wait for
    // compositionend so the IME is not interrupted.
    expect(view.plugin(livePreviewPlugin)).not.toBeNull();
    expect(view.dom.dataset.livePreview).toBe("true");

    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => false,
    });
    view.contentDOM.dispatchEvent(new Event("compositionend"));
    await settleModeSync();

    expect(view.plugin(livePreviewPlugin)).toBeNull();
    expect(view.dom.dataset.livePreview).toBeUndefined();
    expect(session.attachedView).toBe(view);
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
    expect(session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreview: true,
    });
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
