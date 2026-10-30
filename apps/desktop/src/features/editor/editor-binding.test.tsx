import { undo } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setThemeEffect } from "@qingmo/editor-core";
import type { FilePayload } from "@qingmo/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorHost } from "./EditorHost";
import { EditorSession } from "./EditorSession";
import { useEditorStatus } from "./useEditorStatus";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  return {
    docToken: "token-1",
    path: "/docs/note.md",
    text: "hello world\n",
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-1",
    size: 12,
    textUnits: 12,
    mtimeMs: 1,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

function attachView(session: EditorSession): { view: EditorView; parent: HTMLDivElement } {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: session.editorState, parent });
  session.attach(view);
  return { view, parent };
}

let cleanupView: (() => void) | undefined;

afterEach(() => {
  cleanupView?.();
  cleanupView = undefined;
  vi.useRealTimers();
});

describe("EditorSession store", () => {
  it("returns a cached snapshot and replaces it only on real changes", () => {
    const session = EditorSession.create(payload());
    const first = session.getSnapshot();

    expect(session.getSnapshot()).toBe(first);
    expect(session.getMetadataSnapshot()).toBe(session.getMetadataSnapshot());

    session.setSaveState("saving");
    const second = session.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.saveState).toBe("saving");
    expect(second.version).toBe(1);
    expect(session.getSnapshot()).toBe(second);
    expect(first.saveState).toBe("clean");
  });

  it("enforces a single attached view and syncs transactions back into state", () => {
    const session = EditorSession.create(payload({ text: "abc\n" }));
    const { view, parent } = attachView(session);
    cleanupView = () => {
      session.detach(view);
      view.destroy();
      parent.remove();
    };

    expect(session.attachedView).toBe(view);
    expect(() => session.attach(view)).toThrow(/already has an attached EditorView/);

    act(() => {
      view.dispatch({ changes: { from: 0, insert: "X" }, selection: { anchor: 1 } });
    });

    expect(session.readText()).toBe("Xabc\n");
    expect(session.editorState.doc.toString()).toBe("Xabc\n");
    expect(session.getSnapshot().saveState).toBe("dirty");
    expect(session.getSnapshot().dirty).toBe(true);
    expect(session.getSnapshot().cursor).toEqual({ line: 1, column: 2 });
  });

  it("supports undo through the composed history extension", () => {
    const session = EditorSession.create(payload({ text: "abc" }));
    const { view, parent } = attachView(session);
    cleanupView = () => {
      session.detach(view);
      view.destroy();
      parent.remove();
    };

    act(() => {
      view.dispatch({ changes: { from: 3, insert: "d" }, selection: { anchor: 4 } });
    });
    expect(session.readText()).toBe("abcd");

    act(() => {
      undo({
        state: view.state,
        dispatch: (transaction: Transaction) => view.dispatch(transaction),
      });
    });
    expect(session.readText()).toBe("abc");
  });

  it("notifies docChanged listeners for the future SaveCoordinator", () => {
    const session = EditorSession.create(payload({ text: "abc\n" }));
    const { view, parent } = attachView(session);
    cleanupView = () => {
      session.detach(view);
      view.destroy();
      parent.remove();
    };

    const listener = vi.fn();
    const unsubscribe = session.onDocChanged(listener);

    act(() => {
      view.dispatch({ changes: { from: 3, insert: "!" } });
    });
    expect(listener).toHaveBeenCalledTimes(1);

    act(() => {
      view.dispatch({ selection: { anchor: 1 } });
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "?" } });
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("EditorHost", () => {
  it("creates exactly one view under StrictMode and destroys it on unmount", async () => {
    const session = EditorSession.create(payload({ text: "hello world\n" }));

    const { container, unmount } = render(
      <StrictMode>
        <EditorHost session={session} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    });
    expect(container.querySelector(".cm-content")).toHaveTextContent("hello world");
    expect(container.querySelectorAll(".qm-minimap")).toHaveLength(1);
    expect(session.attachedView).not.toBeNull();

    unmount();
    expect(session.attachedView).toBeNull();
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(0);
    expect(container.querySelectorAll(".qm-minimap")).toHaveLength(0);
  });

  it("does not rebuild the view when theme compartments are reconfigured", async () => {
    const session = EditorSession.create(payload());
    const { container } = render(<EditorHost session={session} />);

    await waitFor(() => {
      expect(session.attachedView).not.toBeNull();
    });
    const view = session.attachedView;
    const editor = container.querySelector(".cm-editor");
    expect(editor).not.toBeNull();

    act(() => {
      view?.dispatch({
        effects: setThemeEffect(EditorView.theme({ "&": { color: "red" } })),
      });
    });

    expect(container.querySelector(".cm-editor")).toBe(editor);
    expect(session.attachedView).toBe(view);
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
  });
});

function StatusProbe({ session, onRender }: { session: EditorSession; onRender: () => void }) {
  const status = useEditorStatus(session);
  onRender();
  return (
    <span data-testid="status-probe">
      {status.saveState}|{status.cursor?.line}:{status.cursor?.column}
    </span>
  );
}

describe("useEditorStatus throttle", () => {
  it("renders a bounded number of times for 100 typed characters", () => {
    vi.useFakeTimers();
    const session = EditorSession.create(payload({ text: "abc" }));
    const { view, parent } = attachView(session);
    cleanupView = () => {
      session.detach(view);
      view.destroy();
      parent.remove();
    };

    const onRender = vi.fn();
    render(<StatusProbe session={session} onRender={onRender} />);
    expect(screen.getByTestId("status-probe")).toHaveTextContent("clean|1:1");
    const initialRenders = onRender.mock.calls.length;

    act(() => {
      for (let index = 0; index < 100; index += 1) {
        const position = view.state.doc.length;
        view.dispatch({
          changes: { from: position, insert: "x" },
          selection: { anchor: position + 1 },
        });
      }
    });

    expect(screen.getByTestId("status-probe")).toHaveTextContent("dirty|1:104");
    expect(onRender.mock.calls.length).toBeLessThanOrEqual(initialRenders + 2);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onRender.mock.calls.length).toBeLessThanOrEqual(initialRenders + 3);

    act(() => {
      session.setSaveState("saving");
    });
    expect(screen.getByTestId("status-probe")).toHaveTextContent("saving|1:104");
    expect(onRender.mock.calls.length).toBeLessThanOrEqual(initialRenders + 4);
  });
});
