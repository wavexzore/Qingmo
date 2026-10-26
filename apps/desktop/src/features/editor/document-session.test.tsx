import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { DocumentSessionProvider, useDocumentSession } from "./DocumentSessionContext";
import { EditorSession } from "./EditorSession";
import { SAVE_DEBOUNCE_MS } from "./save/SaveCoordinator";

type ContextValue = ReturnType<typeof useDocumentSession>;

function Probe({ ipc, onContext }: { ipc: FakeIpc; onContext: (value: ContextValue) => void }) {
  const value = useDocumentSession();
  onContext(value);
  return (
    <button
      type="button"
      onClick={() => {
        void ipc.documentOpen().then((payload) => {
          value.setSession(EditorSession.create(payload));
        });
      }}
    >
      open
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DocumentSessionProvider", () => {
  it("creates one SaveCoordinator and auto-saves edits through the shared flush path", async () => {
    const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "hello\n" }] });
    const captured: { current: ContextValue | null } = { current: null };

    const { unmount } = render(
      <AppServicesProvider services={{ ipc, platform: new FakePlatform() }}>
        <DocumentSessionProvider>
          <Probe
            ipc={ipc}
            onContext={(value) => {
              captured.current = value;
            }}
          />
        </DocumentSessionProvider>
      </AppServicesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => {
      expect(captured.current?.coordinator).not.toBeNull();
    });
    const session = captured.current?.session;
    const coordinator = captured.current?.coordinator;
    if (!session || !coordinator) {
      throw new Error("session/coordinator not created");
    }

    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);

    try {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
      expect(session.getSnapshot().saveState).toBe("scheduled");
      expect(coordinator.getSnapshot().state).toBe("scheduled");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      });

      expect(ipc.getFile("/docs/note.md")?.text).toBe("hello\n!");
      expect(session.getSnapshot().saveState).toBe("clean");
      expect(coordinator.getSnapshot().state).toBe("clean");
    } finally {
      session.detach(view);
      view.destroy();
      parent.remove();
      unmount();
    }
  });
});
