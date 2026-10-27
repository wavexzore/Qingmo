import { undo } from "@codemirror/commands";
import type { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FilePayload, SaveRequest, SaveResult } from "@qingmo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMMANDS } from "../../../lib/ipc/commands";
import { FakeIpc, fakeHash } from "../../../lib/ipc/fake";
import type { IpcPort } from "../../../lib/ipc/port";
import { EditorSession, UNTITLED_DOC_TOKEN } from "../EditorSession";
import { SaveCoordinator, SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS } from "./SaveCoordinator";

const PATH = "/docs/note.md";

function payload(overrides: Partial<FilePayload> = {}): FilePayload {
  const text = overrides.text ?? "hello\n";
  return {
    docToken: "token-1",
    path: PATH,
    text,
    format: { encoding: "utf8", hasBom: false, eol: "lf" },
    mixedEol: false,
    hash: fakeHash(text),
    size: new TextEncoder().encode(text).length,
    textUnits: text.length,
    mtimeMs: 1,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

interface Harness {
  ipc: FakeIpc;
  session: EditorSession;
  coordinator: SaveCoordinator;
  view: EditorView;
  parent: HTMLDivElement;
}

let active: Harness | null = null;

async function openHarness(text = "hello\n"): Promise<Harness> {
  const ipc = new FakeIpc({ files: [{ path: PATH, text }] });
  const session = EditorSession.create(await ipc.documentOpen());
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: session.editorState, parent });
  session.attach(view);
  const coordinator = new SaveCoordinator({ session, ipc });
  active = { ipc, session, coordinator, view, parent };
  return active;
}

function attachSession(session: EditorSession): {
  view: EditorView;
  parent: HTMLDivElement;
} {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: session.editorState, parent });
  session.attach(view);
  return { view, parent };
}

async function untitledHarness(options: { saveAsFile?: string | null } = {}): Promise<Harness> {
  const ipc = new FakeIpc({
    saveAsFile: options.saveAsFile !== undefined ? options.saveAsFile : "/docs/untitled.md",
  });
  const session = EditorSession.createUntitled("未命名", { placeholder: "开始写作…" });
  const { view, parent } = attachSession(session);
  const coordinator = new SaveCoordinator({ session, ipc });
  active = { ipc, session, coordinator, view, parent };
  return active;
}

function insert(view: EditorView, text: string): void {
  const position = view.state.doc.length;
  view.dispatch({
    changes: { from: position, insert: text },
    selection: { anchor: position + text.length },
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  if (active) {
    active.coordinator.dispose();
    active.session.detach(active.view);
    active.view.destroy();
    active.parent.remove();
    active = null;
  }
  vi.useRealTimers();
});

describe("SaveCoordinator debounce and max wait", () => {
  it("saves once after 800ms of quiet and leaves a clean session", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "a");
    insert(harness.view, "b");
    expect(harness.coordinator.getSnapshot().state).toBe("scheduled");
    expect(harness.session.getSnapshot().saveState).toBe("scheduled");
    expect(harness.coordinator.getSnapshot().pending).toBe(true);

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toEqual({
      docToken: harness.session.docToken,
      text: "hello\nab",
    });
    expect(harness.ipc.getFile(PATH)?.text).toBe("hello\nab");
    expect(harness.session.readText()).toBe("hello\nab");
    expect(harness.session.getSnapshot().saveState).toBe("clean");
    expect(harness.coordinator.getSnapshot().pending).toBe(false);
  });

  it("forces a save at 5s while typing keeps resetting the debounce", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "a");
    for (let index = 0; index < 49; index += 1) {
      await vi.advanceTimersByTimeAsync(100);
      insert(harness.view, "b");
    }
    // t=4900: the 800ms debounce would fire at t=5700, so only max wait can
    // save during this continuous burst.
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT_MS - 4900 - 1);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(harness.session.getSnapshot().saveState).toBe("clean");
    expect(harness.session.readText().endsWith("bbbbbbbbbb")).toBe(true);
  });
});

interface ControlledIpc extends Pick<
  IpcPort,
  "documentWriteAtomic" | "documentReload" | "documentSaveAs"
> {
  writes: SaveRequest[];
  resolve(index: number, result?: SaveResult): void;
  reject(index: number, error: unknown): void;
  maxConcurrent: number;
}

function controlledIpc(reloadPayload: FilePayload = payload()): ControlledIpc {
  let concurrent = 0;
  let maxConcurrent = 0;
  const writes: SaveRequest[] = [];
  const pending: Array<{
    resolve: (result: SaveResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  return {
    writes,
    maxConcurrent,
    documentWriteAtomic(request) {
      writes.push(request);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      this.maxConcurrent = maxConcurrent;
      return new Promise<SaveResult>((resolve, reject) => {
        pending.push({
          resolve: (result) => {
            concurrent -= 1;
            resolve(result);
          },
          reject: (error) => {
            concurrent -= 1;
            reject(error);
          },
        });
      });
    },
    documentReload: () => Promise.resolve(reloadPayload),
    documentSaveAs: (text) =>
      Promise.resolve(payload({ docToken: "saved-token", path: "/docs/untitled.md", text })),
    resolve(index, result = { hash: "saved-hash", size: 1, mtimeMs: 2 }) {
      pending[index]?.resolve(result);
    },
    reject(index, error) {
      pending[index]?.reject(error);
    },
  };
}

describe("SaveCoordinator single-flight and flush loop", () => {
  it("does not write when flush runs on a clean session", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    expect(await harness.coordinator.flush("manual")).toEqual({ ok: true, state: "clean" });
    expect(await harness.coordinator.flush("blur")).toEqual({ ok: true, state: "clean" });
    expect(write).not.toHaveBeenCalled();
  });

  it("sends LF-only text even when the opened payload contained CRLF", async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc({ files: [{ path: PATH, text: "a\r\nb\r\n" }] });
    const session = EditorSession.create(await ipc.documentOpen());
    const { view, parent } = attachSession(session);
    const coordinator = new SaveCoordinator({ session, ipc });
    const write = vi.spyOn(ipc, "documentWriteAtomic");

    try {
      expect(session.readText()).toBe("a\nb\n");
      insert(view, "c");
      expect((await coordinator.flush("manual")).ok).toBe(true);
      expect(write.mock.calls[0]?.[0].text).toBe("a\nb\nc");
      expect(write.mock.calls[0]?.[0].text).not.toContain("\r");
    } finally {
      coordinator.dispose();
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("keeps edits made during a save pending and writes them in the next round", async () => {
    vi.useFakeTimers();
    const session = EditorSession.create(payload({ text: "abc" }));
    const { view, parent } = attachSession(session);
    const ipc = controlledIpc();
    const coordinator = new SaveCoordinator({ session, ipc });

    try {
      insert(view, "x");
      const flush = coordinator.flush("manual");
      await settle();
      expect(ipc.writes).toHaveLength(1);
      expect(ipc.writes[0]?.text).toBe("abcx");
      expect(coordinator.getSnapshot().state).toBe("saving");

      insert(view, "d");
      expect(coordinator.getSnapshot().pending).toBe(true);
      expect(ipc.writes).toHaveLength(1);

      ipc.resolve(0, { hash: "hash-2", size: 5, mtimeMs: 2 });
      await settle();
      expect(ipc.writes).toHaveLength(2);
      expect(ipc.writes[1]?.text).toBe("abcxd");
      expect(ipc.maxConcurrent).toBe(1);

      ipc.resolve(1, { hash: "hash-3", size: 5, mtimeMs: 3 });
      const result = await flush;

      expect(result).toEqual({ ok: true, state: "clean" });
      expect(session.getSnapshot().saveState).toBe("clean");
      expect(session.getSnapshot().size).toBe(5);
      expect(session.getSnapshot().mtimeMs).toBe(3);
      expect(ipc.maxConcurrent).toBe(1);
    } finally {
      coordinator.dispose();
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("serializes concurrent flush callers into one write", async () => {
    vi.useFakeTimers();
    const session = EditorSession.create(payload({ text: "abc" }));
    const { view, parent } = attachSession(session);
    const ipc = controlledIpc();
    const coordinator = new SaveCoordinator({ session, ipc });

    try {
      insert(view, "d");
      const first = coordinator.flush("manual");
      const second = coordinator.flush("blur");
      await settle();
      expect(ipc.writes).toHaveLength(1);
      expect(coordinator.getSnapshot().state).toBe("saving");

      ipc.resolve(0, { hash: "hash-2", size: 4, mtimeMs: 2 });
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(ipc.writes).toHaveLength(1);
      expect(ipc.maxConcurrent).toBe(1);
    } finally {
      coordinator.dispose();
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });

  it("flush('close') drains pending edits and flush('blur') saves a dirty document", async () => {
    vi.useFakeTimers();
    const session = EditorSession.create(payload({ text: "abc" }));
    const { view, parent } = attachSession(session);
    const ipc = controlledIpc();
    const coordinator = new SaveCoordinator({ session, ipc });

    try {
      insert(view, "1");
      const blur = coordinator.flush("blur");
      await settle();
      expect(ipc.writes).toHaveLength(1);
      ipc.resolve(0, { hash: "hash-2", size: 4, mtimeMs: 2 });
      expect((await blur).ok).toBe(true);
      await settle();
      expect(session.getSnapshot().saveState).toBe("clean");

      insert(view, "2");
      const close = coordinator.flush("close");
      await settle();
      expect(ipc.writes).toHaveLength(2);
      insert(view, "3");
      ipc.resolve(1, { hash: "hash-3", size: 5, mtimeMs: 3 });
      await settle();
      expect(ipc.writes).toHaveLength(3);

      ipc.resolve(2, { hash: "hash-4", size: 6, mtimeMs: 4 });
      const result = await close;
      expect(result).toEqual({ ok: true, state: "clean" });
      expect(ipc.writes.map((request) => request.text)).toEqual(["abc1", "abc12", "abc123"]);
      expect(ipc.maxConcurrent).toBe(1);
    } finally {
      coordinator.dispose();
      session.detach(view);
      view.destroy();
      parent.remove();
    }
  });
});

describe("SaveCoordinator conflicts", () => {
  it("pauses auto-save on conflict, re-conflicts on a stale force, then saves the exact hash", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "!");
    harness.ipc.setDiskText(PATH, "external\n");

    const conflict = await harness.coordinator.flush("manual");
    const firstHash = fakeHash("external\n");
    expect(conflict.ok).toBe(false);
    expect(conflict.failure).toBe("conflict");
    expect(conflict.conflict?.currentHash).toBe(firstHash);
    expect(harness.session.getSnapshot().saveState).toBe("conflict");

    const writesAtConflict = write.mock.calls.length;
    insert(harness.view, "?");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).toHaveBeenCalledTimes(writesAtConflict);

    harness.ipc.setDiskText(PATH, "external-2\n");
    const staleForce = await harness.coordinator.forceSave();
    const secondHash = fakeHash("external-2\n");
    expect(staleForce.ok).toBe(false);
    expect(staleForce.failure).toBe("conflict");
    expect(staleForce.conflict?.currentHash).toBe(secondHash);
    expect(write.mock.calls.at(-1)?.[0].expectedCurrentHash).toBe(firstHash);

    const forced = await harness.coordinator.forceSave();
    expect(forced).toEqual({ ok: true, state: "clean" });
    expect(write.mock.calls.at(-1)?.[0].expectedCurrentHash).toBe(secondHash);
    expect(harness.ipc.getFile(PATH)?.text).toBe(harness.session.readText());
    expect(harness.coordinator.conflictDetails).toBeNull();
  });

  it("keeps the conflict banner when reload fails", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    insert(harness.view, "!");
    harness.ipc.setDiskText(PATH, "external\n");
    expect((await harness.coordinator.flush("manual")).failure).toBe("conflict");
    const details = harness.coordinator.conflictDetails;

    harness.ipc.failNext(COMMANDS.documentReload, "IO");
    const failed = await harness.coordinator.reload();

    expect(failed.ok).toBe(false);
    expect(failed.failure).toBe("conflict");
    expect(failed.error?.code).toBe("IO");
    expect(harness.session.getSnapshot().saveState).toBe("conflict");
    expect(harness.coordinator.conflictDetails).toEqual(details);

    const reloaded = await harness.coordinator.reload();
    expect(reloaded).toEqual({ ok: true, state: "clean" });
    expect(harness.session.readText()).toBe("external\n");
  });

  it("reload rebuilds the state, clears history, and drops the conflict", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    insert(harness.view, "!");
    harness.ipc.setDiskText(PATH, "external\n");
    expect((await harness.coordinator.flush("manual")).failure).toBe("conflict");

    harness.ipc.setDiskText(PATH, "external-final\n");
    const reloaded = await harness.coordinator.reload();

    expect(reloaded).toEqual({ ok: true, state: "clean" });
    expect(harness.session.readText()).toBe("external-final\n");
    expect(harness.view.state.doc.toString()).toBe("external-final\n");
    expect(harness.session.getSnapshot().saveState).toBe("clean");
    expect(harness.coordinator.conflictDetails).toBeNull();

    const undone = undo({
      state: harness.view.state,
      dispatch: (transaction: Transaction) => harness.view.dispatch(transaction),
    });
    expect(undone).toBe(false);
    expect(harness.session.readText()).toBe("external-final\n");
  });
});

describe("SaveCoordinator errors", () => {
  it("retries IO/BUSY with 1s/2s/4s/8s/16s backoff and stops after five retries", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    harness.ipc.failAlways(COMMANDS.documentWriteAtomic, "IO");
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "!");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(write).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getSnapshot().state).toBe("scheduled");
    expect(harness.coordinator.getSnapshot().retryAttempts).toBe(1);

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(write, `before retry ${index + 1}`).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(write, `after retry ${index + 1}`).toHaveBeenCalledTimes(index + 2);
    }

    expect(write).toHaveBeenCalledTimes(6);
    expect(harness.coordinator.getSnapshot().state).toBe("error");
    expect(harness.coordinator.getSnapshot().error?.code).toBe("IO");
    expect(harness.coordinator.getSnapshot().retryAttempts).toBe(5);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledTimes(6);
  });

  it("waits through the backoff for a close flush and succeeds on retry", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    harness.ipc.failNext(COMMANDS.documentWriteAtomic, "IO");
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "!");
    const close = harness.coordinator.flush("close");
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getSnapshot().state).toBe("scheduled");

    await vi.advanceTimersByTimeAsync(999);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await close;

    expect(result).toEqual({ ok: true, state: "clean" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(harness.session.getSnapshot().saveState).toBe("clean");
  });

  it("stops immediately on a terminal error and lets retry() try again", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    harness.ipc.failNext(COMMANDS.documentWriteAtomic, "PERMISSION_DENIED");
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "!");
    const failed = await harness.coordinator.flush("manual");
    expect(failed.ok).toBe(false);
    expect(failed.failure).toBe("error");
    expect(failed.error?.code).toBe("PERMISSION_DENIED");
    expect(harness.session.getSnapshot().saveState).toBe("error");
    expect(write).toHaveBeenCalledTimes(1);

    insert(harness.view, "?");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledTimes(1);

    const retried = await harness.coordinator.retry();
    expect(retried).toEqual({ ok: true, state: "clean" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(harness.coordinator.getSnapshot().error).toBeNull();
  });
});

describe("SaveCoordinator untitled Save As", () => {
  it("keeps edits dirty without auto-saving and writes on manual save", async () => {
    vi.useFakeTimers();
    const harness = await untitledHarness();
    const saveAs = vi.spyOn(harness.ipc, "documentSaveAs");

    insert(harness.view, "draft");
    expect(harness.session.isUntitled).toBe(true);
    expect(harness.session.getSnapshot().saveState).toBe("dirty");
    expect(harness.coordinator.getSnapshot().state).toBe("dirty");
    expect(harness.coordinator.getSnapshot().pending).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveAs).not.toHaveBeenCalled();
    expect(harness.ipc.getFile("/docs/untitled.md")).toBeUndefined();

    const result = await harness.coordinator.flush("manual");
    expect(result).toEqual({ ok: true, state: "clean" });
    expect(saveAs).toHaveBeenCalledWith("draft");
    expect(harness.session.isUntitled).toBe(false);
    expect(harness.session.docToken).not.toBe(UNTITLED_DOC_TOKEN);
    expect(harness.session.getSnapshot().fileName).toBe("untitled.md");
    expect(harness.ipc.getFile("/docs/untitled.md")?.text).toBe("draft");
  });

  it("skips Save As for a pristine buffer but saves before close once dirty", async () => {
    const harness = await untitledHarness();
    const saveAs = vi.spyOn(harness.ipc, "documentSaveAs");

    expect(await harness.coordinator.flush("close")).toEqual({ ok: true, state: "clean" });
    expect(saveAs).not.toHaveBeenCalled();

    insert(harness.view, "close-me");
    const result = await harness.coordinator.flush("close");
    expect(result).toEqual({ ok: true, state: "clean" });
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(harness.ipc.getFile("/docs/untitled.md")?.text).toBe("close-me");
  });

  it("does not open Save As on blur or auto flushes", async () => {
    const harness = await untitledHarness();
    const saveAs = vi.spyOn(harness.ipc, "documentSaveAs");
    insert(harness.view, "draft");

    expect(await harness.coordinator.flush("blur")).toEqual({ ok: true, state: "dirty" });
    expect(await harness.coordinator.flush("auto")).toEqual({ ok: true, state: "dirty" });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("returns a pristine buffer to clean when Save As is cancelled", async () => {
    const harness = await untitledHarness({ saveAsFile: null });

    const cancelled = await harness.coordinator.flush("manual");
    expect(cancelled.ok).toBe(false);
    expect(cancelled.error?.code).toBe("CANCELLED");
    expect(harness.session.getSnapshot().saveState).toBe("clean");
    expect(harness.coordinator.getSnapshot().pending).toBe(false);

    // A later close does not reopen the dialog for an untouched buffer.
    const saveAs = vi.spyOn(harness.ipc, "documentSaveAs");
    expect(await harness.coordinator.flush("close")).toEqual({ ok: true, state: "clean" });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("keeps a cancelled Save As dirty and lets a later save retry", async () => {
    const harness = await untitledHarness({ saveAsFile: null });
    const saveAs = vi.spyOn(harness.ipc, "documentSaveAs");
    insert(harness.view, "draft");

    const cancelled = await harness.coordinator.flush("manual");
    expect(cancelled.ok).toBe(false);
    expect(cancelled.failure).toBe("error");
    expect(cancelled.error?.code).toBe("CANCELLED");
    expect(harness.session.isUntitled).toBe(true);
    expect(harness.session.getSnapshot().saveState).toBe("dirty");
    expect(harness.coordinator.getSnapshot().pending).toBe(true);

    harness.ipc.setSaveAsFile("/docs/retry.md");
    const saved = await harness.coordinator.flush("manual");
    expect(saved).toEqual({ ok: true, state: "clean" });
    expect(saveAs).toHaveBeenCalledTimes(2);
    expect(harness.session.getSnapshot().fileName).toBe("retry.md");
    expect(harness.ipc.getFile("/docs/retry.md")?.text).toBe("draft");
  });
});

describe("SaveCoordinator readonly and disposal", () => {
  it("never writes a read-only session and reports flush success", async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc({ files: [{ path: PATH, text: "readonly\n", readOnlyReason: "mdx" }] });
    const session = EditorSession.create(await ipc.documentOpen());
    const coordinator = new SaveCoordinator({ session, ipc });
    const write = vi.spyOn(ipc, "documentWriteAtomic");

    try {
      expect(session.getSnapshot().saveState).toBe("readonly");
      expect(coordinator.getSnapshot().state).toBe("readonly");
      expect(await coordinator.flush("close")).toEqual({ ok: true, state: "readonly" });
      coordinator.schedule();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(write).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot().state).toBe("readonly");
    } finally {
      coordinator.dispose();
    }
  });

  it("cancels armed timers and ignores doc changes after dispose", async () => {
    vi.useFakeTimers();
    const harness = await openHarness();
    const write = vi.spyOn(harness.ipc, "documentWriteAtomic");

    insert(harness.view, "!");
    expect(harness.coordinator.getSnapshot().state).toBe("scheduled");
    harness.coordinator.dispose();
    harness.session.detach(harness.view);
    harness.view.destroy();
    harness.parent.remove();
    active = null;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).not.toHaveBeenCalled();
  });
});
