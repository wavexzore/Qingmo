import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorSession } from "../features/editor/EditorSession";
import { SaveCoordinator } from "../features/editor/save/SaveCoordinator";
import { COMMANDS } from "../lib/ipc/commands";
import { FakeIpc } from "../lib/ipc/fake";
import { FakePlatform } from "../lib/platform/fake";
import { CloseConfirmDialog } from "./CloseConfirmDialog";
import { useCloseGuard, type CloseGuardState } from "./useCloseGuard";

const PATH = "/docs/note.md";

interface Harness {
  ipc: FakeIpc;
  platform: FakePlatform;
  session: EditorSession;
  coordinator: SaveCoordinator;
  view: EditorView;
  parent: HTMLDivElement;
  state: { current: CloseGuardState | null };
  unmount(): void;
}

let active: Harness | null = null;

function Probe({
  ipc,
  platform,
  coordinator,
  onState,
}: {
  ipc: FakeIpc;
  platform: FakePlatform;
  coordinator: SaveCoordinator | null;
  onState(value: CloseGuardState): void;
}) {
  const state = useCloseGuard({ ipc, platform, coordinator });
  onState(state);
  return (
    <CloseConfirmDialog
      prompt={state.prompt}
      onAllow={state.allowClose}
      onCancel={state.cancelClose}
    />
  );
}

async function openHarness(text = "hello\n"): Promise<Harness> {
  const ipc = new FakeIpc({ files: [{ path: PATH, text }] });
  const session = EditorSession.create(await ipc.documentOpen());
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: session.editorState, parent });
  session.attach(view);
  const coordinator = new SaveCoordinator({ session, ipc });
  const platform = new FakePlatform();
  const state: { current: CloseGuardState | null } = { current: null };

  const { unmount } = render(
    <Probe
      ipc={ipc}
      platform={platform}
      coordinator={coordinator}
      onState={(value) => {
        state.current = value;
      }}
    />,
  );

  active = { ipc, platform, session, coordinator, view, parent, state, unmount };
  return active;
}

function insert(view: EditorView, text: string): void {
  const position = view.state.doc.length;
  view.dispatch({ changes: { from: position, insert: text }, selection: { anchor: position + 1 } });
}

afterEach(() => {
  if (active) {
    active.unmount();
    active.coordinator.dispose();
    active.session.detach(active.view);
    active.view.destroy();
    active.parent.remove();
    active = null;
  }
  vi.useRealTimers();
});

describe("useCloseGuard", () => {
  it("confirms a clean close immediately without writing", async () => {
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    await act(async () => {
      harness.platform.emitCloseRequested("window");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.ipc.closeConfirmCalls).toEqual([{ allow: true }]);
    });
    expect(write).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("flushes pending edits before confirming a native close", async () => {
    const harness = await openHarness();
    insert(harness.view, "!");

    await act(async () => {
      harness.platform.emitCloseRequested("exit");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.ipc.closeConfirmCalls).toEqual([{ allow: true }]);
    });
    expect(harness.ipc.getFile(PATH)?.text).toBe("hello\n!");
    expect(harness.session.getSnapshot().saveState).toBe("clean");
  });

  it("asks before closing a conflicted document and can close anyway", async () => {
    const harness = await openHarness();
    insert(harness.view, "!");
    harness.ipc.setDiskText(PATH, "external\n");

    await act(async () => {
      harness.platform.emitCloseRequested("window");
      await Promise.resolve();
    });

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("有未保存的修改");
    expect(harness.ipc.closeConfirmCalls).toHaveLength(0);
    expect(harness.ipc.getFile(PATH)?.text).toBe("external\n");

    fireEvent.click(screen.getByTestId("close-anyway"));
    await waitFor(() => {
      expect(harness.ipc.closeConfirmCalls).toEqual([{ allow: true }]);
    });
  });

  it("cancels the native close and leaves the disk untouched", async () => {
    const harness = await openHarness();
    insert(harness.view, "!");
    harness.ipc.setDiskText(PATH, "external\n");

    await act(async () => {
      harness.platform.emitCloseRequested("exit");
      await Promise.resolve();
    });

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("close-cancel"));

    await waitFor(() => {
      expect(harness.ipc.closeConfirmCalls).toEqual([{ allow: false }]);
    });
    expect(harness.ipc.getFile(PATH)?.text).toBe("external\n");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("prompts after a terminal save error", async () => {
    const harness = await openHarness();
    harness.ipc.failAlways(COMMANDS.documentWriteAtomic, "PERMISSION_DENIED");
    insert(harness.view, "!");

    await act(async () => {
      harness.platform.emitCloseRequested("window");
      await Promise.resolve();
    });

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("保存未完成");
    expect(harness.ipc.closeConfirmCalls).toHaveLength(0);
  });

  it("flushes on blur, deferring while an IME composition is active", async () => {
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "1");
    harness.platform.setComposing(true);
    await act(async () => {
      harness.platform.emitBlur();
      await Promise.resolve();
    });
    expect(write).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new CompositionEvent("compositionend"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(harness.ipc.getFile(PATH)?.text).toBe("hello\n1");
    });

    harness.platform.setComposing(false);
    insert(harness.view, "2");
    await act(async () => {
      harness.platform.emitBlur();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(harness.ipc.getFile(PATH)?.text).toBe("hello\n12");
    });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("ignores a second close request while the first flush is pending", async () => {
    const harness = await openHarness();
    harness.ipc.setCommandDelay(COMMANDS.documentWriteAtomic, 20);
    insert(harness.view, "!");

    await act(async () => {
      harness.platform.emitCloseRequested("window");
      harness.platform.emitCloseRequested("window");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(harness.ipc.closeConfirmCalls).toEqual([{ allow: true }]);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.ipc.closeConfirmCalls).toHaveLength(1);
  });
});
