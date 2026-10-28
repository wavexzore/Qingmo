import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import {
  DocumentSessionProvider,
  resetPendingDocumentForTests,
  useDocumentSession,
} from "./DocumentSessionContext";
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
          if (payload) {
            value.setSession(EditorSession.create(payload));
          }
        });
      }}
    >
      open
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
  resetPendingDocumentForTests();
  window.history.replaceState({}, "", "/");
});

beforeEach(() => {
  resetPendingDocumentForTests();
  window.history.replaceState({}, "", "/");
});

describe("DocumentSessionProvider", () => {
  it("creates one SaveCoordinator and auto-saves edits through the shared flush path", async () => {
    const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "hello\n" }] });
    const captured: { current: ContextValue | null } = { current: null };

    const { unmount } = render(
      <StrictMode>
        <AppServicesProvider
          services={{
            ipc,
            platform: new FakePlatform(),
            updates: new FakeUpdatePort(),
            logs: new FakeLogPort(),
          }}
        >
          <DocumentSessionProvider>
            <Probe
              ipc={ipc}
              onContext={(value) => {
                captured.current = value;
              }}
            />
          </DocumentSessionProvider>
        </AppServicesProvider>
      </StrictMode>,
    );

    expect(captured.current?.session?.isUntitled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => {
      expect(captured.current?.session?.getSnapshot().docId).toBe("/docs/note.md");
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

  it("boots a document window from the payload staged by Rust", async () => {
    window.history.replaceState({}, "", "/?window=document");
    const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "# staged\n" }] });
    const payload = await ipc.documentOpen();
    if (!payload) {
      throw new Error("fake open must return a payload");
    }
    ipc.stagePending(payload);
    const captured: { current: ContextValue | null } = { current: null };

    render(
      <StrictMode>
        <AppServicesProvider
          services={{
            ipc,
            platform: new FakePlatform(),
            updates: new FakeUpdatePort(),
            logs: new FakeLogPort(),
          }}
        >
          <DocumentSessionProvider>
            <Probe
              ipc={ipc}
              onContext={(value) => {
                captured.current = value;
              }}
            />
          </DocumentSessionProvider>
        </AppServicesProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(captured.current?.session?.getSnapshot().docId).toBe("/docs/note.md");
    });
    expect(captured.current?.session?.isUntitled).toBe(false);
  });

  it("falls back to untitled when a document window has no staged payload", async () => {
    window.history.replaceState({}, "", "/?window=document");
    const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "x" }] });
    const captured: { current: ContextValue | null } = { current: null };

    render(
      <AppServicesProvider
        services={{
          ipc,
          platform: new FakePlatform(),
          updates: new FakeUpdatePort(),
          logs: new FakeLogPort(),
        }}
      >
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

    await waitFor(() => {
      expect(captured.current?.session?.isUntitled).toBe(true);
    });
  });
});
