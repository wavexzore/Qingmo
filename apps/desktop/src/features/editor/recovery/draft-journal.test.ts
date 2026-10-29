import { EditorView } from "@codemirror/view";
import type { FilePayload } from "@qingmo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeIpc } from "../../../lib/ipc/fake";
import type { SaveState } from "../../../lib/save-state";
import { EditorSession } from "../EditorSession";
import type { SaveCoordinatorSnapshot } from "../save/SaveCoordinator";
import { DraftJournal, type DraftJournalCoordinator } from "./DraftJournal";

const PATH = "/docs/note.md";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  const text = overrides.text ?? "hello\n";
  return {
    docToken: "token-draft",
    path: PATH,
    text,
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: "hash-draft",
    size: text.length,
    textUnits: text.length,
    mtimeMs: 1,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

class StubCoordinator implements DraftJournalCoordinator {
  private snapshot: SaveCoordinatorSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly session: EditorSession,
    state: SaveState = session.getSnapshot().saveState,
  ) {
    this.snapshot = {
      state,
      conflict: null,
      error: null,
      retryAttempts: 0,
      pending: false,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SaveCoordinatorSnapshot => this.snapshot;

  set(patch: Partial<SaveCoordinatorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    // Mirror SaveCoordinator, which projects every state through the session.
    this.session.setSaveState(this.snapshot.state);
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

const cleanups: Array<() => void> = [];

function untitledJournal(text = "hello", state: SaveState = "dirty") {
  const ipc = new FakeIpc();
  const session = EditorSession.createUntitled("未命名", {
    initialText: text,
    initialDirty: state !== "clean",
  });
  const coordinator = new StubCoordinator(session, state);
  const journal = new DraftJournal({
    session,
    coordinator,
    ipc,
    debounceMs: 5,
    maxWaitMs: 20,
  });
  cleanups.push(() => {
    journal.dispose();
    session.dispose();
  });
  return { ipc, session, coordinator, journal };
}

function namedJournal(state: SaveState = "clean") {
  const ipc = new FakeIpc({ files: [{ path: PATH, text: "hello\n" }] });
  const session = EditorSession.create(payload());
  const coordinator = new StubCoordinator(session, state);
  const journal = new DraftJournal({
    session,
    coordinator,
    ipc,
    debounceMs: 5,
    maxWaitMs: 20,
  });
  cleanups.push(() => {
    journal.dispose();
    session.dispose();
  });
  return { ipc, session, coordinator, journal };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(25);
  await Promise.resolve();
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DraftJournal", () => {
  it("writes an untitled dirty document after the debounce and adopts its id", async () => {
    vi.useFakeTimers();
    const { ipc, journal } = untitledJournal();

    journal.evaluate();
    await settle();

    expect(ipc.draftWrites).toHaveLength(1);
    expect(ipc.draftWrites[0]).toMatchObject({
      kind: "untitled",
      title: "未命名",
      text: "hello",
      anchor: 0,
      head: 0,
    });
    expect(ipc.draftWrites[0]?.id).toBeUndefined();
    expect((await ipc.sessionDraftList()).length).toBe(1);
  });

  it("does not write a named document for dirty or scheduled saves", async () => {
    vi.useFakeTimers();
    const { ipc, coordinator, journal } = namedJournal();

    coordinator.set({ state: "scheduled" });
    journal.evaluate();
    await settle();
    expect(ipc.draftWrites).toHaveLength(0);

    coordinator.set({ state: "saving" });
    journal.evaluate();
    await settle();
    expect(ipc.draftWrites).toHaveLength(0);
  });

  it("writes immediately on error/conflict and on a retrying scheduled state", async () => {
    vi.useFakeTimers();
    const { ipc, session, coordinator, journal } = namedJournal();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: session.editorState, parent });
    session.attach(view);
    cleanups.push(() => {
      session.detach(view);
      view.destroy();
      parent.remove();
    });

    coordinator.set({ state: "error" });
    journal.evaluate();
    await settle();
    expect(ipc.draftWrites).toHaveLength(1);
    expect(ipc.draftWrites[0]).toMatchObject({ kind: "named", path: PATH });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "1" } });
    coordinator.set({ state: "scheduled", retryAttempts: 1 });
    journal.evaluate();
    await settle();
    expect(ipc.draftWrites).toHaveLength(2);

    view.dispatch({ changes: { from: view.state.doc.length, insert: "2" } });
    coordinator.set({ state: "conflict" });
    journal.evaluate();
    await settle();
    expect(ipc.draftWrites).toHaveLength(3);
  });

  it("writes again when only the selection changes", async () => {
    const { ipc, session, journal } = untitledJournal();

    await journal.flushNow();
    expect(ipc.draftWrites).toHaveLength(1);
    const id = ipc.draftWrites[0]?.id;
    expect(id).toBeUndefined();

    // No view is attached in this unit test: update the selection through a
    // real view created for the same state.
    const { EditorView } = await import("@codemirror/view");
    const parent = document.createElement("div");
    document.body.append(parent);
    const editorView = new EditorView({ state: session.editorState, parent });
    session.attach(editorView);
    cleanups.push(() => {
      session.detach(editorView);
      editorView.destroy();
      parent.remove();
    });
    editorView.dispatch({ selection: { anchor: 2 } });
    await journal.flushNow();

    expect(ipc.draftWrites).toHaveLength(2);
    expect(ipc.draftWrites[1]).toMatchObject({ anchor: 2, head: 2 });
    expect(ipc.draftWrites[1]?.id).toBeDefined();
  });

  it("deletes only its own draft when the save becomes clean", async () => {
    vi.useFakeTimers();
    const { ipc, session, coordinator, journal } = untitledJournal();
    const other = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000001",
      kind: "untitled" as const,
      path: null,
      title: "older",
      text: "older body",
      textUnits: 10,
      sizeBytes: 10,
      anchor: 0,
      head: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
      appVersion: "test",
    };
    ipc.seedDraft(other);

    journal.evaluate();
    await settle();
    expect(await ipc.sessionDraftList()).toHaveLength(2);

    session.adoptSavedAs(payload({ path: "/docs/saved.md", text: "hello", size: 5 }));
    coordinator.set({ state: "clean" });
    journal.evaluate();
    await vi.advanceTimersByTimeAsync(0);

    const remaining = await ipc.sessionDraftList();
    expect(remaining.map((draft) => draft.id)).toEqual([other.id]);
  });

  it("does not resurrect a discarded draft", async () => {
    const { ipc, journal } = untitledJournal();

    await journal.flushNow();
    expect(ipc.draftWrites).toHaveLength(1);
    await journal.discardNow();
    expect(await ipc.sessionDraftList()).toHaveLength(0);

    await journal.flushNow();
    expect(ipc.draftWrites).toHaveLength(1);
    expect(await ipc.sessionDraftList()).toHaveLength(0);
  });

  it("adopts a restored draft id and deletes it after Save As succeeds", async () => {
    const ipc = new FakeIpc();
    ipc.seedDraft({
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000002",
      kind: "untitled",
      path: null,
      title: "恢复稿",
      text: "restored",
      textUnits: 8,
      sizeBytes: 8,
      anchor: 0,
      head: 8,
      createdAtMs: 1,
      updatedAtMs: 1,
      appVersion: "test",
    });
    const session = EditorSession.createUntitled("恢复稿", {
      initialText: "restored",
      initialDirty: true,
    });
    const coordinator = new StubCoordinator(session);
    const discarded: string[] = [];
    const journal = new DraftJournal({
      session,
      coordinator,
      ipc,
      initialDraftId: "00000000-0000-4000-8000-000000000002",
      onDiscarded: (id) => discarded.push(id),
    });
    cleanups.push(() => {
      journal.dispose();
      session.dispose();
    });

    await journal.flushNow();
    expect(ipc.draftWrites[0]?.id).toBe("00000000-0000-4000-8000-000000000002");

    session.adoptSavedAs(payload({ path: "/docs/restored.md", text: "restored", size: 8 }));
    coordinator.set({ state: "clean" });
    journal.evaluate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(discarded).toEqual(["00000000-0000-4000-8000-000000000002"]);
    expect(await ipc.sessionDraftList()).toHaveLength(0);
  });

  it("deletes an empty untitled draft and warns once when the store rejects it", async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const session = EditorSession.createUntitled("未命名");
    const coordinator = new StubCoordinator(session, "clean");
    const journal = new DraftJournal({ session, coordinator, ipc });
    cleanups.push(() => {
      journal.dispose();
      session.dispose();
    });

    journal.evaluate();
    await settle();
    expect(ipc.draftWrites).toHaveLength(0);

    const oversized = EditorSession.createUntitled("未命名", {
      initialText: "x".repeat(2 * 1024 * 1024 + 1),
      initialDirty: true,
    });
    const oversizedCoordinator = new StubCoordinator(oversized);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = new DraftJournal({
      session: oversized,
      coordinator: oversizedCoordinator,
      ipc,
    });
    cleanups.push(() => {
      failing.dispose();
      oversized.dispose();
    });

    await failing.flushNow();
    await failing.flushNow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
