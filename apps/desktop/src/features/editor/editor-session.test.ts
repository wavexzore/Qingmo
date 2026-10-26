import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FilePayload } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import { EditorSession } from "./EditorSession";

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
});
