import type { DraftMeta, DraftWriteRequest } from "@qingmo/shared";

import type { IpcPort } from "../../../lib/ipc/port";
import type { EditorSession } from "../EditorSession";
import type { SaveCoordinator, SaveTimerApi } from "../save/SaveCoordinator";

/** The journal only needs the coordinator's snapshot stream. */
export type DraftJournalCoordinator = Pick<SaveCoordinator, "subscribe" | "getSnapshot">;

export const DRAFT_DEBOUNCE_MS = 1_500;
export const DRAFT_MAX_WAIT_MS = 5_000;

/**
 * Outcome of an explicit flush.
 *
 * `ok` with `meta: null` means the current snapshot is already preserved (or
 * nothing needs preserving); callers replacing the session may proceed.
 * `ok: false` carries the write error so they can keep the session instead.
 */
export type DraftFlushResult = { ok: true; meta: DraftMeta | null } | { ok: false; error: unknown };

export interface DraftFlushOptions {
  /**
   * Write even when the same snapshot was already written by this session.
   *
   * The global store prunes old drafts, so the local `lastWrittenKey` is not
   * proof the rows still exist. Callers replacing the session must force.
   */
  force?: boolean;
  /**
   * Also journal a dirty named document in its normal `dirty` state.
   *
   * Named documents usually rely on the save path, but a late edit between a
   * save and the session replacement has no other durable carrier.
   */
  preserveNamedDirty?: boolean;
}

const defaultTimers: SaveTimerApi = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface DraftJournalOptions {
  session: EditorSession;
  coordinator: DraftJournalCoordinator;
  ipc: Pick<IpcPort, "sessionDraftWrite" | "sessionDraftDiscard">;
  /** A draft restored from the recovery UI; this session now owns it. */
  initialDraftId?: string | null;
  /** Called after a successful delete so the recovery list can update. */
  onDiscarded?: (id: string) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  timers?: SaveTimerApi;
}

/**
 * Writes a crash draft only when the normal save path cannot be trusted.
 *
 * - Untitled dirty documents always need a draft (there is no path to save).
 * - Named documents only draft while `error`/`conflict`, or during a retrying
 *   `scheduled` state; normal dirty/saving states are the save path's job.
 * - An explicit `flushNow({preserveNamedDirty:true})` also journals a merely
 *   dirty named document (session replacement with no save opportunity).
 * - A draft this session owns is deleted only after the coordinator reports
 *   `clean` with no pending edit. Drafts owned by an earlier session are never
 *   touched.
 *
 * The journal reads text only inside `flush`; `evaluate` is O(1) and safe to
 * run from every snapshot notification.
 */
export class DraftJournal {
  private readonly session: EditorSession;
  private readonly coordinator: DraftJournalCoordinator;
  private readonly ipc: Pick<IpcPort, "sessionDraftWrite" | "sessionDraftDiscard">;
  private readonly timers: SaveTimerApi;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onDiscarded: ((id: string) => void) | undefined;
  private readonly unsubscribeSession: () => void;
  private readonly unsubscribeCoordinator: () => void;

  private ownedDraftId: string | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<DraftFlushResult> | null = null;
  private lastWrittenKey: string | null = null;
  private lastSaveState: string | null = null;
  private warned = false;
  private discarding = false;
  private disposed = false;

  constructor({
    session,
    coordinator,
    ipc,
    initialDraftId = null,
    onDiscarded,
    debounceMs,
    maxWaitMs,
    timers = defaultTimers,
  }: DraftJournalOptions) {
    this.session = session;
    this.coordinator = coordinator;
    this.ipc = ipc;
    this.ownedDraftId = initialDraftId;
    this.onDiscarded = onDiscarded;
    this.debounceMs = debounceMs ?? DRAFT_DEBOUNCE_MS;
    this.maxWaitMs = maxWaitMs ?? DRAFT_MAX_WAIT_MS;
    this.timers = timers;
    this.unsubscribeSession = session.subscribe(this.evaluate);
    this.unsubscribeCoordinator = coordinator.subscribe(this.evaluate);
  }

  /** Re-evaluates the current snapshots without reading the document body. */
  evaluate = (): void => {
    if (this.disposed || this.discarding) {
      return;
    }
    const session = this.session.getSnapshot();
    const save = this.coordinator.getSnapshot();

    if (session.readOnly) {
      this.cancelTimers();
      this.discardOwnedWhenIdle();
      this.lastSaveState = save.state;
      return;
    }
    if (this.session.isUntitled && this.session.editorState.doc.length === 0) {
      this.cancelTimers();
      this.discardOwnedWhenIdle();
      this.lastSaveState = save.state;
      return;
    }
    if (!this.shouldWrite()) {
      this.cancelTimers();
      this.releaseWhenClean();
      this.lastSaveState = save.state;
      return;
    }

    const enteredFailure =
      (save.state === "error" || save.state === "conflict") && this.lastSaveState !== save.state;
    this.lastSaveState = save.state;
    if (!this.session.isUntitled && enteredFailure && !this.inFlight) {
      // A retryable error may be in its backoff window; write immediately so a
      // crash before the next retry still has a draft.
      void this.flushNow();
    } else {
      this.schedule();
    }
  };

  schedule(): void {
    if (this.disposed || this.discarding || !this.shouldWrite()) {
      return;
    }
    if (this.debounceTimer === null) {
      this.debounceTimer = this.timers.setTimeout(() => {
        this.debounceTimer = null;
        void this.flushNow();
      }, this.debounceMs);
    }
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = this.timers.setTimeout(() => {
        this.maxWaitTimer = null;
        void this.flushNow();
      }, this.maxWaitMs);
    }
  }

  /**
   * Writes now when a draft is still warranted; safe to call while closing.
   *
   * Returns whether the snapshot is preserved, not whether this call had to
   * write: a snapshot already written earlier is a success. Callers that are
   * about to replace the session must keep it on `ok: false`.
   */
  async flushNow({
    force = false,
    preserveNamedDirty = false,
  }: DraftFlushOptions = {}): Promise<DraftFlushResult> {
    if (this.disposed || this.discarding) {
      return { ok: true, meta: null };
    }
    this.cancelTimers();
    if (!this.shouldWrite(preserveNamedDirty)) {
      this.releaseWhenClean();
      return { ok: true, meta: null };
    }
    return this.writeOnce(force, preserveNamedDirty);
  }

  /**
   * Explicit discard (close prompt). `discarding` stays set so a parallel
   * `flushNow` cannot resurrect the draft while the window is closing.
   */
  async discardNow(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.cancelTimers();
    this.discarding = true;
    const flight = this.inFlight;
    if (flight) {
      await flight;
    }
    await this.discardOwnedDraft();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelTimers();
    this.unsubscribeSession();
    this.unsubscribeCoordinator();
  }

  private shouldWrite(preserveNamedDirty = false): boolean {
    const session = this.session.getSnapshot();
    if (session.readOnly || !session.dirty) {
      return false;
    }
    if (this.session.isUntitled) {
      return this.session.editorState.doc.length > 0;
    }
    if (preserveNamedDirty) {
      return true;
    }
    const save = this.coordinator.getSnapshot();
    return (
      save.state === "error" ||
      save.state === "conflict" ||
      (save.state === "scheduled" && save.retryAttempts > 0)
    );
  }

  private writeOnce(force: boolean, preserveNamedDirty: boolean): Promise<DraftFlushResult> {
    const run = (this.inFlight ?? Promise.resolve({ ok: true, meta: null })).then(() =>
      this.writeLatest(force, preserveNamedDirty),
    );
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    return run;
  }

  private async writeLatest(
    force: boolean,
    preserveNamedDirty: boolean,
  ): Promise<DraftFlushResult> {
    if (this.disposed || this.discarding || !this.shouldWrite(preserveNamedDirty)) {
      return { ok: true, meta: null };
    }
    const snapshot = this.session.getSnapshot();
    const text = this.session.readText();
    const anchor = snapshot.selection.anchor;
    const head = snapshot.selection.head;
    const title = snapshot.fileName;
    const path = this.session.isUntitled ? null : snapshot.docId;
    const key = JSON.stringify([text, anchor, head, title, path]);
    if (!force && key === this.lastWrittenKey) {
      // Already on disk from this session; the snapshot is preserved.
      return { ok: true, meta: null };
    }

    const request: DraftWriteRequest = {
      ...(this.ownedDraftId ? { id: this.ownedDraftId } : {}),
      kind: this.session.isUntitled ? "untitled" : "named",
      ...(path ? { path } : {}),
      title,
      text,
      anchor,
      head,
    };
    try {
      const meta = await this.ipc.sessionDraftWrite(request);
      if (this.disposed) {
        return { ok: true, meta };
      }
      this.ownedDraftId = meta.id;
      this.lastWrittenKey = key;
      this.releaseIfNoLongerNeeded();
      return { ok: true, meta };
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("failed to write the crash draft", error);
      }
      return { ok: false, error };
    }
  }

  private releaseIfNoLongerNeeded(): void {
    if (this.shouldWrite()) {
      return;
    }
    const save = this.coordinator.getSnapshot();
    if (save.state === "clean" && !save.pending) {
      void this.discardOwnedDraft();
    }
  }

  private releaseWhenClean(): void {
    const flight = this.inFlight;
    const release = (): void => {
      if (this.disposed || this.discarding) {
        return;
      }
      const save = this.coordinator.getSnapshot();
      if (save.state === "clean" && !save.pending && !this.session.getSnapshot().dirty) {
        void this.discardOwnedDraft();
      }
    };
    if (flight) {
      void flight.then(release);
    } else {
      release();
    }
  }

  /** Deletes only after any in-flight write has named the draft, so a late
   * response cannot resurrect an id that was already removed. */
  private discardOwnedWhenIdle(): void {
    const flight = this.inFlight;
    if (flight) {
      void flight.then(() => {
        if (!this.disposed) {
          void this.discardOwnedDraft();
        }
      });
    } else {
      void this.discardOwnedDraft();
    }
  }

  private async discardOwnedDraft(): Promise<void> {
    const id = this.ownedDraftId;
    if (!id) {
      return;
    }
    this.ownedDraftId = null;
    this.lastWrittenKey = null;
    try {
      await this.ipc.sessionDraftDiscard(id);
      this.onDiscarded?.(id);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("failed to discard the crash draft", error);
      }
    }
  }

  private cancelTimers(): void {
    if (this.debounceTimer !== null) {
      this.timers.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer !== null) {
      this.timers.clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }
}
