import { undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FilePayload } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_EDITOR_UI_COPY, editorUiCopy, type EditorUiCopy } from "@qingmo/editor-core";
import { EditorSession, UNTITLED_DOC_TOKEN } from "./EditorSession";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  return {
    docToken: "token-1",
    path: "/docs/note.md",
    text: "# Hello\n\nbody\n",
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-1",
    size: 15,
    textUnits: 15,
    mtimeMs: 123,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

describe("EditorSession", () => {
  it("creates the LF-only EditorState and exposes only an on-demand read", () => {
    const input = payload({ text: "a😀b\n" });
    const session = EditorSession.create(input);

    expect(session.readText()).toBe("a😀b\n");
    expect(session.editorState.doc.toString()).toBe("a😀b\n");
    expect(session.editorState.doc.toString()).not.toContain("\r");
    expect(session.docToken).toBe("token-1");
  });

  it("uses the canonical path as docId and keeps metadata in the snapshot", () => {
    const session = EditorSession.create(payload());
    const snapshot = session.getSnapshot();

    expect(snapshot.docId).toBe("/docs/note.md");
    expect(snapshot.fileName).toBe("note.md");
    expect(snapshot.docToken).toBe("token-1");
    expect(snapshot.format).toEqual({ encoding: "utf8", hasBom: false, eol: "lf" });
    expect(snapshot.hash).toBe("hash-1");
    expect(snapshot.size).toBe(15);
    expect(snapshot.textUnits).toBe(15);
    expect(snapshot.mtimeMs).toBe(123);
    expect(snapshot.saveState).toBe("clean");
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.selection).toEqual({ anchor: 0, head: 0 });
    expect(snapshot.cursor).toEqual({ line: 1, column: 1 });
    expect(snapshot.version).toBe(0);
  });

  it("never puts document text in the React snapshot", () => {
    const input = payload({ text: "secret-body\n" });
    const snapshot = EditorSession.create(input).getSnapshot();

    expect(snapshot).not.toHaveProperty("text");
    expect(snapshot).not.toHaveProperty("content");
    expect(snapshot).not.toHaveProperty("doc");
    expect(JSON.stringify(snapshot)).not.toContain("secret-body");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.format)).toBe(true);
    expect(Object.isFrozen(snapshot.cursor)).toBe(true);
    expect(Object.isFrozen(snapshot.selection)).toBe(true);
  });

  it("applies both readOnly and editable facets for a writable document", () => {
    const session = EditorSession.create(payload());

    expect(session.editorState.facet(EditorState.readOnly)).toBe(false);
    expect(session.editorState.facet(EditorView.editable)).toBe(true);
  });

  it("creates a read-only state and refuses to leave readonly", () => {
    const session = EditorSession.create(
      payload({
        readOnly: true,
        readOnlyReason: "mdx",
      }),
    );

    expect(session.editorState.facet(EditorState.readOnly)).toBe(true);
    expect(session.editorState.facet(EditorView.editable)).toBe(false);
    expect(session.getSnapshot().saveState).toBe("readonly");
    expect(session.getSnapshot().dirty).toBe(false);

    session.setSaveState("dirty");
    expect(session.getSnapshot().saveState).toBe("readonly");
    expect(session.getSnapshot().dirty).toBe(false);
  });

  it("derives dirty from saveState and notifies subscribers on real changes", () => {
    const session = EditorSession.create(payload());
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    session.setSaveState("clean");
    expect(listener).not.toHaveBeenCalled();

    session.setSaveState("dirty");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().dirty).toBe(true);
    expect(session.getSnapshot().version).toBe(1);

    session.setSaveState("dirty");
    expect(listener).toHaveBeenCalledTimes(1);

    session.setSaveState("saving");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().dirty).toBe(true);

    unsubscribe();
    session.setSaveState("clean");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().dirty).toBe(false);
    expect(session.getSnapshot().version).toBe(3);
  });

  it("creates an editable, empty untitled session", () => {
    const session = EditorSession.createUntitled("未命名", { placeholder: "开始写作…" });
    const snapshot = session.getSnapshot();

    expect(session.isUntitled).toBe(true);
    expect(session.docToken).toBe(UNTITLED_DOC_TOKEN);
    expect(snapshot.docId).toBe("untitled");
    expect(snapshot.fileName).toBe("未命名");
    expect(snapshot.format).toEqual({ encoding: "utf8", hasBom: false, eol: "lf" });
    expect(snapshot.saveState).toBe("clean");
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.readOnly).toBe(false);
    expect(session.editorState.doc.length).toBe(0);
    expect(session.editorState.facet(EditorState.readOnly)).toBe(false);
    expect(session.editorState.facet(EditorView.editable)).toBe(true);
  });

  it("swaps the untitled placeholder and name without touching document identity", () => {
    const session = EditorSession.createUntitled("未命名", { placeholder: "开始写作…" });
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      expect(parent.querySelector(".cm-placeholder")?.textContent).toBe("开始写作…");
      const listener = vi.fn();
      session.subscribe(listener);
      const before = session.getSnapshot();

      session.applyPlaceholder("Start writing…");
      session.applyUntitledTitle("Untitled");

      expect(parent.querySelector(".cm-placeholder")?.textContent).toBe("Start writing…");
      expect(session.readText()).toBe("");
      expect(session.getSnapshot()).toMatchObject({
        docId: "untitled",
        docToken: UNTITLED_DOC_TOKEN,
        fileName: "Untitled",
      });
      expect(session.getSnapshot().version).toBe(before.version + 1);
      expect(listener).toHaveBeenCalled();

      session.applyUntitledTitle("Untitled");
      expect(session.getSnapshot().version).toBe(before.version + 1);
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("ignores placeholder and title updates for a named document", () => {
    const session = EditorSession.create(payload({ text: "" }));
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      session.applyPlaceholder("Start writing…");
      session.applyUntitledTitle("Untitled");

      expect(parent.querySelector(".cm-placeholder")).toBeNull();
      expect(session.getSnapshot()).toMatchObject({
        docId: "/docs/note.md",
        fileName: "note.md",
      });
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("defers a placeholder swap until the IME composition ends", () => {
    const session = EditorSession.createUntitled("未命名", { placeholder: "开始写作…" });
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      // jsdom cannot drive CM6's real IME bookkeeping, so pin the observable
      // condition the session guards on and exercise its deferral path.
      Object.defineProperty(view, "composing", {
        configurable: true,
        get: () => true,
      });
      expect(view.composing).toBe(true);

      session.applyPlaceholder("Start writing…");
      expect(parent.querySelector(".cm-placeholder")?.textContent).toBe("开始写作…");

      Object.defineProperty(view, "composing", {
        configurable: true,
        get: () => false,
      });
      view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { data: "a" }));
      expect(view.composing).toBe(false);
      expect(parent.querySelector(".cm-placeholder")?.textContent).toBe("Start writing…");
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("defers a copy swap until the IME composition ends", () => {
    const session = EditorSession.createUntitled("未命名");
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);
    const zhCopy: EditorUiCopy = {
      ...DEFAULT_EDITOR_UI_COPY,
      version: "zh-CN:1",
      language: "zh-CN",
    };

    try {
      expect(view.state.facet(editorUiCopy)).toBe(DEFAULT_EDITOR_UI_COPY);

      Object.defineProperty(view, "composing", {
        configurable: true,
        get: () => true,
      });
      session.applyUiCopy(zhCopy);
      expect(view.state.facet(editorUiCopy)).toBe(DEFAULT_EDITOR_UI_COPY);

      Object.defineProperty(view, "composing", {
        configurable: true,
        get: () => false,
      });
      view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
      expect(view.state.facet(editorUiCopy)).toBe(zhCopy);
      expect(session.readText()).toBe("");
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("adopts a saved path without replacing EditorState or undo history", () => {
    const session = EditorSession.createUntitled("未命名");
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      view.dispatch({ changes: { from: 0, insert: "draft" }, selection: { anchor: 5 } });
      const stateBefore = view.state;
      session.adoptSavedAs(
        payload({
          docToken: "token-2",
          path: "/docs/untitled.md",
          text: "draft",
          hash: "hash-2",
          size: 5,
          textUnits: 5,
        }),
      );

      expect(session.isUntitled).toBe(false);
      expect(session.docToken).toBe("token-2");
      expect(session.attachedView).toBe(view);
      expect(view.state).toBe(stateBefore);
      expect(session.readText()).toBe("draft");
      expect(session.getSnapshot()).toMatchObject({
        docId: "/docs/untitled.md",
        fileName: "untitled.md",
        saveState: "clean",
        dirty: false,
        size: 5,
      });

      undo({
        state: view.state,
        dispatch: (transaction: Transaction) => view.dispatch(transaction),
      });
      expect(session.readText()).toBe("");
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("keeps and clamps the cursor when a reload replaces the payload", () => {
    const session = EditorSession.create(payload({ text: "hello world\n" }));
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      view.dispatch({ selection: { anchor: 6, head: 6 } });

      session.replacePayload(
        payload({ text: "hello brave world\n", hash: "hash-2", size: 18, textUnits: 18 }),
      );
      expect(view.state.doc.toString()).toBe("hello brave world\n");
      expect(session.getSnapshot().selection).toEqual({ anchor: 6, head: 6 });

      // A shorter disk version must not leave the selection past the end.
      session.replacePayload(payload({ text: "hi\n", hash: "hash-3", size: 3, textUnits: 3 }));
      expect(session.getSnapshot().selection).toEqual({ anchor: 3, head: 3 });
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("keeps exactly one minimap rail across reload and removes it on destroy", () => {
    const longText = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    const session = EditorSession.create(payload({ text: longText }));
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      expect(parent.querySelectorAll(".qm-minimap")).toHaveLength(1);

      session.replacePayload(
        payload({ text: `${longText}\nmore`, hash: "hash-2", size: 1000, textUnits: 1000 }),
      );
      expect(parent.querySelectorAll(".qm-minimap")).toHaveLength(1);
      expect(session.attachedView).toBe(view);
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }

    expect(parent.querySelectorAll(".qm-minimap")).toHaveLength(0);
  });

  it("accepts extra extensions for the T-009 composition hook", () => {
    const session = EditorSession.create(payload(), {
      extensions: [EditorState.tabSize.of(4)],
    });
    expect(session.editorState.facet(EditorState.tabSize)).toBe(4);
  });

  it("stops notifying after dispose", () => {
    const session = EditorSession.create(payload());
    const listener = vi.fn();
    session.subscribe(listener);
    session.dispose();
    session.setSaveState("dirty");
    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes an independent outline snapshot without body text", () => {
    const session = EditorSession.create(payload({ text: "# Alpha\n\n## Beta\n" }));
    const outline = session.getOutlineSnapshot();

    expect(outline.entries.map((entry) => entry.text)).toEqual(["Alpha", "Beta"]);
    expect(session.getOutlineSnapshot()).toBe(outline);
    expect(JSON.stringify(session.getSnapshot())).not.toContain("Alpha");
    expect(JSON.stringify(session.getSnapshot())).not.toContain("Beta");
  });

  it("notifies outline subscribers at most once per throttle window", () => {
    vi.useFakeTimers();
    const session = EditorSession.create(payload({ text: "# Alpha\n" }));
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);
    const listener = vi.fn();
    const unsubscribe = session.subscribeOutline(listener);

    try {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n# Beta\n" } });
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(99);
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(session.getOutlineSnapshot().entries.map((entry) => entry.text)).toEqual([
        "Alpha",
        "Beta",
      ]);

      unsubscribe();
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n# Gamma\n" } });
      vi.advanceTimersByTime(100);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
      vi.useRealTimers();
    }
  });

  it("keeps one active outline listener after attaching a new view", () => {
    const session = EditorSession.create(payload({ text: "# Alpha\n" }));
    const listener = vi.fn();
    session.subscribeOutline(listener);
    const views: Array<{ view: EditorView; parent: HTMLDivElement }> = [];

    const attach = () => {
      const parent = document.createElement("div");
      document.body.append(parent);
      const view = new EditorView({ state: session.editorState, parent });
      session.attach(view);
      views.push({ view, parent });
      return view;
    };

    const first = attach();
    session.detach(first);
    first.destroy();

    const second = attach();
    try {
      second.dispatch({ changes: { from: second.state.doc.length, insert: "# Beta\n" } });
      session.flushOutlineNotify();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      session.detach(second);
      second.destroy();
      for (const { view, parent } of views) {
        if (view !== second && view !== first) {
          view.destroy();
        }
        parent.remove();
      }
    }
  });

  it("flushes the new outline immediately after replacePayload", () => {
    const session = EditorSession.create(payload({ text: "# Old\n" }));
    const listener = vi.fn();
    session.subscribeOutline(listener);

    session.replacePayload(payload({ text: "# New\n", hash: "hash-2", size: 6, textUnits: 6 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getOutlineSnapshot().entries.map((entry) => entry.text)).toEqual(["New"]);
  });

  it("reveals positions without editing and clamps invalid values", () => {
    const session = EditorSession.create(payload({ text: "# Alpha\n\nbody\n" }));
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      expect(session.revealPosition(2)).toBe(true);
      expect(view.state.selection.main.head).toBe(2);
      expect(session.readText()).toBe("# Alpha\n\nbody\n");

      expect(session.revealPosition(999)).toBe(true);
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
      expect(session.revealPosition(Number.NaN)).toBe(false);
      expect(session.revealPosition(Number.POSITIVE_INFINITY)).toBe(false);
      expect(session.focusEditor()).toBe(true);
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
    }

    const detached = EditorSession.create(payload({ text: "# Alpha\n" }));
    expect(detached.focusEditor()).toBe(false);
    expect(detached.revealPosition(2)).toBe(true);
    expect(detached.getSnapshot().selection).toEqual({ anchor: 2, head: 2 });
  });
});
