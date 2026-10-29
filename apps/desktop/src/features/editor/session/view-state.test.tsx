import { EditorView } from "@codemirror/view";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { FilePayload } from "@qingmo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCloseGuard } from "../../../app/useCloseGuard";
import { FakePlatform } from "../../../lib/platform/fake";
import { COMMANDS } from "../../../lib/ipc/commands";
import { FakeIpc } from "../../../lib/ipc/fake";
import { EditorHost } from "../EditorHost";
import { EditorSession } from "../EditorSession";
import { createDocumentSession } from "./createDocumentSession";
import { ViewStateRecorder } from "./ViewStateRecorder";

const PATH = "/docs/note.md";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  const text = overrides.text ?? "# Title\n\nbody\n";
  return {
    docToken: "token-view",
    path: PATH,
    text,
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-view",
    size: text.length,
    textUnits: text.length,
    mtimeMs: 1,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

function viewState(overrides: Partial<Parameters<FakeIpc["seedViewState"]>[1]> = {}) {
  return {
    anchor: 0,
    head: 0,
    topPos: 0,
    topOffset: 0,
    scrollLeft: 0,
    livePreviewPreferred: true,
    updatedAtMs: 1,
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];

function attach(session: EditorSession): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: session.editorState, parent });
  session.attach(view);
  cleanups.push(() => {
    session.detach(view);
    view.destroy();
    parent.remove();
  });
  return view;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createDocumentSession", () => {
  it("restores the selection and preview preference before the view exists", async () => {
    const ipc = new FakeIpc();
    ipc.seedViewState(PATH, viewState({ anchor: 3, head: 5, livePreviewPreferred: false }));

    const created = await createDocumentSession(ipc, payload());
    cleanups.push(() => created.session.dispose());

    expect(created.viewState?.anchor).toBe(3);
    expect(created.session.getSnapshot()).toMatchObject({
      previewTier: "full",
      livePreviewPreferred: false,
      livePreview: false,
      selection: { anchor: 3, head: 5 },
    });
  });

  it("clamps a persisted selection into the document", async () => {
    const ipc = new FakeIpc();
    ipc.seedViewState(PATH, viewState({ anchor: 9_999, head: -4 }));

    const created = await createDocumentSession(ipc, payload());
    cleanups.push(() => created.session.dispose());

    expect(created.session.getSnapshot().selection).toEqual({
      anchor: created.session.editorState.doc.length,
      head: 0,
    });
  });

  it("opens at the top with defaults when the view-state read fails", async () => {
    const ipc = new FakeIpc();
    ipc.failAlways(COMMANDS.sessionViewStateGet, "IO", "storage offline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const created = await createDocumentSession(ipc, payload());
    cleanups.push(() => created.session.dispose());

    expect(created.viewState).toBeNull();
    expect(created.session.getSnapshot()).toMatchObject({
      livePreviewPreferred: true,
      selection: { anchor: 0, head: 0 },
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("EditorHost view restoration", () => {
  it("passes a clamped scroll target to the first EditorView", () => {
    const session = EditorSession.create(payload());
    cleanups.push(() => session.dispose());
    const scrollIntoView = vi.spyOn(EditorView, "scrollIntoView");
    const target = viewState({
      topPos: 9_999,
      topOffset: 28,
      scrollLeft: 12,
    });

    render(<EditorHost session={session} viewState={target} />);

    expect(screen.getByTestId("editor-host")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith(session.editorState.doc.length, {
      y: "start",
      yMargin: 28,
      x: "start",
      xMargin: -12,
    });
  });

  it("does not request scrolling without persisted state", () => {
    const session = EditorSession.create(payload());
    cleanups.push(() => session.dispose());
    const scrollIntoView = vi.spyOn(EditorView, "scrollIntoView");

    render(<EditorHost session={session} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("ViewStateRecorder", () => {
  it("writes selection, anchor and preference after a debounce", async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const session = EditorSession.create(payload());
    cleanups.push(() => session.dispose());
    const view = attach(session);
    const recorder = new ViewStateRecorder({ ipc, session });
    cleanups.push(() => recorder.dispose());
    recorder.attach(view);

    view.dispatch({ selection: { anchor: 2 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(ipc.viewStateWrites).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(ipc.viewStateWrites).toHaveLength(1);
    const [write] = ipc.viewStateWrites;
    expect(write).toMatchObject({
      path: PATH,
      state: { anchor: 2, head: 2, livePreviewPreferred: true },
    });
    expect(write?.state.topPos).toBe(0);
    // The content padding (28px) is preserved as a positive offset instead of
    // being folded into scrollTop.
    expect(write?.state.topOffset).toBe(28);
  });

  it("skips untitled and empty documents", async () => {
    const ipc = new FakeIpc();
    const session = EditorSession.createUntitled("未命名");
    cleanups.push(() => session.dispose());
    const view = attach(session);
    const recorder = new ViewStateRecorder({ ipc, session });
    cleanups.push(() => recorder.dispose());
    recorder.attach(view);

    recorder.schedule();
    await recorder.flushNow();

    expect(ipc.viewStateWrites).toHaveLength(0);
  });

  it("writes to the new path after Save As adopts a file", async () => {
    const ipc = new FakeIpc();
    const session = EditorSession.createUntitled("未命名");
    cleanups.push(() => session.dispose());
    const view = attach(session);
    view.dispatch({ changes: { from: 0, insert: "hello" } });
    const recorder = new ViewStateRecorder({ ipc, session });
    cleanups.push(() => recorder.dispose());
    recorder.attach(view);

    session.adoptSavedAs(
      payload({ path: "/docs/saved.md", text: "hello", hash: "hash-saved", size: 5 }),
    );
    await recorder.flushNow();

    expect(ipc.viewStateWrites).toHaveLength(1);
    expect(ipc.viewStateWrites[0]?.path).toBe("/docs/saved.md");
  });

  it("deduplicates an unchanged snapshot and retries after a failure", async () => {
    const ipc = new FakeIpc();
    const session = EditorSession.create(payload());
    cleanups.push(() => session.dispose());
    const view = attach(session);
    const recorder = new ViewStateRecorder({ ipc, session });
    cleanups.push(() => recorder.dispose());
    recorder.attach(view);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    view.dispatch({ selection: { anchor: 1 } });
    await recorder.flushNow();
    await recorder.flushNow();
    expect(ipc.viewStateWrites).toHaveLength(1);

    ipc.failNext(COMMANDS.sessionViewStateSet, "IO", "disk full");
    view.dispatch({ selection: { anchor: 2 } });
    await recorder.flushNow();
    view.dispatch({ selection: { anchor: 3 } });
    await recorder.flushNow();
    expect(ipc.viewStateWrites).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it("adopts a replacement view after a StrictMode remount", async () => {
    const ipc = new FakeIpc();
    const session = EditorSession.create(payload());
    cleanups.push(() => session.dispose());
    const first = attach(session);
    const recorder = new ViewStateRecorder({ ipc, session });
    cleanups.push(() => recorder.dispose());
    recorder.attach(first);

    session.detach(first);
    first.destroy();
    const second = attach(session);
    recorder.attach(second);
    second.dispatch({ selection: { anchor: 4 } });
    await recorder.flushNow();

    expect(ipc.viewStateWrites).toHaveLength(1);
    expect(ipc.viewStateWrites[0]?.state).toMatchObject({ anchor: 4, head: 4 });
  });

  it("stops writing after dispose", async () => {
    const ipc = new FakeIpc();
    const session = EditorSession.create(payload());
    cleanups.push(() => session.dispose());
    const view = attach(session);
    const recorder = new ViewStateRecorder({ ipc, session });
    recorder.attach(view);
    recorder.dispose();

    view.dispatch({ selection: { anchor: 2 } });
    await recorder.flushNow();

    expect(ipc.viewStateWrites).toHaveLength(0);
  });
});

describe("useCloseGuard view-state flush", () => {
  it("flushes the recorder before confirming an allowed close", async () => {
    const order: string[] = [];
    const ipc = {
      appCloseConfirm: vi.fn(async () => {
        order.push("confirm");
      }),
    };
    const recorder = {
      flushNow: vi.fn(async () => {
        order.push("flush");
      }),
    };
    const { result } = renderHook(() =>
      useCloseGuard({
        ipc,
        platform: new FakePlatform(),
        coordinator: null,
        viewState: recorder as unknown as ViewStateRecorder,
      }),
    );

    await act(async () => {
      await result.current.allowClose();
    });

    expect(order).toEqual(["flush", "confirm"]);
  });

  it("does not flush when the close is cancelled", async () => {
    const order: string[] = [];
    const ipc = {
      appCloseConfirm: vi.fn(async () => {
        order.push("confirm");
      }),
    };
    const recorder = {
      flushNow: vi.fn(async () => {
        order.push("flush");
      }),
    };
    const { result } = renderHook(() =>
      useCloseGuard({
        ipc,
        platform: new FakePlatform(),
        coordinator: null,
        viewState: recorder as unknown as ViewStateRecorder,
      }),
    );

    await act(async () => {
      await result.current.cancelClose();
    });

    expect(order).toEqual(["confirm"]);
  });
});
