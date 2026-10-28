import { EditorView } from "@codemirror/view";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { ToastProvider } from "../../components/ToastHost";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import { EditorSession } from "./EditorSession";
import { SaveCoordinator } from "./save/SaveCoordinator";
import { useExternalDocumentChanges } from "./useExternalDocumentChanges";

const PATH = "/docs/note.md";

function Probe({ session, coordinator }: { session: EditorSession; coordinator: SaveCoordinator }) {
  useExternalDocumentChanges(session, coordinator);
  return null;
}

interface Harness {
  ipc: FakeIpc;
  session: EditorSession;
  coordinator: SaveCoordinator;
  view: EditorView | null;
  parent: HTMLDivElement | null;
  unmount(): void;
}

let active: Harness | null = null;

async function mount(text = "hello\n"): Promise<Harness> {
  const ipc = new FakeIpc({ files: [{ path: PATH, text }] });
  const payload = await ipc.documentOpen();
  if (!payload) {
    throw new Error("fake open must return a payload");
  }
  const session = EditorSession.create(payload);
  const coordinator = new SaveCoordinator({ session, ipc });

  const { unmount } = render(
    <AppServicesProvider
      services={{
        ipc,
        platform: new FakePlatform(),
        updates: new FakeUpdatePort(),
        logs: new FakeLogPort(),
      }}
    >
      <ToastProvider>
        <Probe session={session} coordinator={coordinator} />
      </ToastProvider>
    </AppServicesProvider>,
  );

  active = { ipc, session, coordinator, view: null, parent: null, unmount };
  return active;
}

function attachView(harness: Harness): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: harness.session.editorState, parent });
  harness.session.attach(view);
  harness.view = view;
  harness.parent = parent;
  return view;
}

afterEach(() => {
  if (active) {
    active.coordinator.dispose();
    if (active.view) {
      active.session.detach(active.view);
      active.view.destroy();
    }
    active.parent?.remove();
    active.unmount();
    active = null;
  }
});

describe("useExternalDocumentChanges", () => {
  it("reloads a clean document and reports it with a toast", async () => {
    const harness = await mount("hello\n");

    act(() => {
      harness.ipc.setDiskText(PATH, "external\n");
    });

    await waitFor(() => {
      expect(harness.session.readText()).toBe("external\n");
    });
    expect(harness.session.getSnapshot().saveState).toBe("clean");
    expect(screen.getByRole("status")).toHaveTextContent("磁盘上的文件已更新，已重新加载。");
  });

  it("opens a conflict instead of discarding unsaved edits", async () => {
    const harness = await mount("hello\n");
    const view = attachView(harness);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "local" },
    });
    expect(harness.session.getSnapshot().dirty).toBe(true);

    act(() => {
      harness.ipc.setDiskText(PATH, "external\n");
    });

    expect(harness.coordinator.getSnapshot().state).toBe("conflict");
    expect(harness.session.readText()).toBe("hello\nlocal");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a deleted file without touching the editor text", async () => {
    const harness = await mount("hello\n");

    act(() => {
      harness.ipc.deleteDiskFile(PATH);
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "磁盘上的文件已被删除或移动，当前内容仍保留在编辑器中。",
      );
    });
    expect(harness.session.readText()).toBe("hello\n");
    expect(harness.coordinator.getSnapshot().state).toBe("clean");
  });

  it("ignores the event when the disk already matches the base version", async () => {
    const harness = await mount("hello\n");

    act(() => {
      harness.ipc.setDiskText(PATH, "hello\n");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.session.getSnapshot().saveState).toBe("clean");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
