import type { AppError, ConflictDetails, SaveRequest, SaveResult } from "@qingmo/shared";

import { normalizeError } from "../../../lib/ipc/errors";
import type { IpcPort } from "../../../lib/ipc/port";
import type { SaveState } from "../../../lib/save-state";
import type { EditorSession } from "../EditorSession";

export const SAVE_DEBOUNCE_MS = 800;
export const SAVE_MAX_WAIT_MS = 5_000;
export const SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const SAVE_MAX_RETRY_DELAY_MS = 30_000;

export type FlushReason = "manual" | "auto" | "blur" | "switch" | "close";
export type FlushFailureReason = "conflict" | "error";

export interface FlushResult {
  ok: boolean;
  state: SaveState;
  failure?: FlushFailureReason;
  error?: AppError;
  conflict?: ConflictDetails;
}

/**
 * Save-internal details that do not belong in the document snapshot. The
 * document save state itself still lives in EditorSession; this store only
 * adds the failure payload needed by T-012's banner and retry affordance.
 */
export interface SaveCoordinatorSnapshot {
  state: SaveState;
  conflict: ConflictDetails | null;
  error: AppError | null;
  retryAttempts: number;
  pending: boolean;
}

export interface SaveTimerApi {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface SaveCoordinatorOptions {
  session: EditorSession;
  ipc: Pick<IpcPort, "documentWriteAtomic" | "documentReload">;
  /** Overridable for tests; production uses 800ms. */
  debounceMs?: number;
  /** Overridable for tests; production uses 5s. */
  maxWaitMs?: number;
  /** Overridable for tests; production uses 1s/2s/4s/8s/16s. */
  retryDelaysMs?: readonly number[];
  timers?: SaveTimerApi;
}

type SaveOutcome =
  | { kind: "success"; result: SaveResult }
  | { kind: "conflict"; error: AppError; conflict: ConflictDetails | null }
  | { kind: "error"; error: AppError; retryable: boolean };

const defaultTimers: SaveTimerApi = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function isRetryableSaveError(error: AppError): boolean {
  return error.code === "IO" || error.code === "BUSY";
}

function conflictDetailsOf(details: AppError["details"]): ConflictDetails | null {
  if (details === undefined || details === null || typeof details !== "object") {
    return null;
  }
  if (Array.isArray(details)) {
    return null;
  }
  const currentHash = details.currentHash;
  const currentMtimeMs = details.currentMtimeMs;
  const currentSize = details.currentSize;
  if (
    typeof currentHash !== "string" ||
    typeof currentMtimeMs !== "number" ||
    typeof currentSize !== "number"
  ) {
    return null;
  }
  return {
    currentHash,
    currentMtimeMs,
    currentSize,
  };
}

/**
 * The only save path for an open document.
 *
 * - Manual, automatic, blur, switch and close all funnel through `flush`.
 * - At most one `document_write_atomic` call is in flight; edits during a save
 *   only set `pending` and are written by the next loop round.
 * - Text is read from EditorSession at write time, so React never stores it.
 * - Conflict pauses automatic saving until `forceSave`/`reload`; retryable
 *   IO/BUSY errors back off exponentially and stop after five retries.
 */
export class SaveCoordinator {
  private readonly session: EditorSession;
  private readonly ipc: Pick<IpcPort, "documentWriteAtomic" | "documentReload">;
  private readonly timers: SaveTimerApi;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeDocChanged: () => void;

  private state: SaveState;
  private snapshot: SaveCoordinatorSnapshot;
  private conflict: ConflictDetails | null = null;
  private lastError: AppError | null = null;
  private retryable = false;
  private retryAttempts = 0;
  private pending = false;
  private inFlight: Promise<void> | null = null;
  private forcedHash: string | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor({
    session,
    ipc,
    debounceMs = SAVE_DEBOUNCE_MS,
    maxWaitMs = SAVE_MAX_WAIT_MS,
    retryDelaysMs = SAVE_RETRY_DELAYS_MS,
    timers = defaultTimers,
  }: SaveCoordinatorOptions) {
    this.session = session;
    this.ipc = ipc;
    this.timers = timers;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.retryDelaysMs = retryDelaysMs;

    this.state = session.getSnapshot().saveState;
    this.snapshot = this.makeSnapshot();
    this.unsubscribeDocChanged = session.onDocChanged(() => this.schedule());
  }

  get conflictDetails(): ConflictDetails | null {
    return this.conflict;
  }

  get lastSaveError(): AppError | null {
    return this.lastError;
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SaveCoordinatorSnapshot => this.snapshot;

  /**
   * Arms the 800ms debounce and the 5s maximum-wait timer. Repeated edits only
   * reset the debounce; the max timer is not moved until a save starts.
   */
  schedule(): void {
    if (this.disposed || this.session.getSnapshot().readOnly) {
      return;
    }

    this.pending = true;

    if (this.inFlight) {
      this.publish();
      return;
    }
    if (this.state === "conflict") {
      this.publish();
      return;
    }
    if (this.state === "error" && !this.retryable) {
      this.publish();
      return;
    }
    if (this.retryTimer !== null) {
      this.publish();
      return;
    }

    this.setState("scheduled");
    this.armScheduledTimers();
    this.publish();
  }

  /**
   * Saves until clean, readonly, or a terminal state. Concurrent callers are
   * serialized, so blur can never race a manual save into two writes.
   */
  flush(reason: FlushReason = "manual"): Promise<FlushResult> {
    return this.enqueue(() => this.flushLoop(reason));
  }

  /** Manual retry for any error, including terminal IO/permission failures. */
  retry(): Promise<FlushResult> {
    return this.enqueue(() => this.retryOnce());
  }

  /**
   * Conflict resolution: retry with an exact expected hash. When omitted, the
   * hash captured from the most recent CONFLICT is used.
   */
  forceSave(expectedCurrentHash?: string): Promise<FlushResult> {
    return this.enqueue(() => this.forceSaveOnce(expectedCurrentHash));
  }

  /**
   * Reloads the disk version and rebuilds EditorState, which also clears undo
   * history. Called only after T-012's explicit user confirmation.
   */
  reload(): Promise<FlushResult> {
    return this.enqueue(() => this.reloadOnce());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduledTimers();
    this.unsubscribeDocChanged();
    this.listeners.clear();
    this.inFlight = null;
    this.pending = false;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.flushQueue.then(operation);
    this.flushQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async retryOnce(): Promise<FlushResult> {
    if (this.disposed) {
      return this.failure("error");
    }
    if (this.state !== "error") {
      return this.flushLoop("manual");
    }
    this.lastError = null;
    this.retryable = false;
    this.retryAttempts = 0;
    this.pending = true;
    this.setState("dirty");
    return this.flushLoop("manual");
  }

  private async forceSaveOnce(expectedCurrentHash?: string): Promise<FlushResult> {
    if (this.disposed) {
      return this.failure("error");
    }
    if (this.session.getSnapshot().readOnly) {
      return this.flushLoop("manual");
    }
    await this.waitForIdle();

    const hash = expectedCurrentHash ?? this.conflict?.currentHash;
    if (hash !== undefined) {
      this.forcedHash = hash;
    }
    this.conflict = null;
    this.lastError = null;
    this.retryable = false;
    this.retryAttempts = 0;
    this.pending = true;
    this.setState("dirty");
    return this.flushLoop("manual");
  }

  private async reloadOnce(): Promise<FlushResult> {
    if (this.disposed) {
      return this.failure("error");
    }
    this.cancelScheduledTimers();
    try {
      await this.waitForIdle();
      const payload = await this.ipc.documentReload(this.session.docToken);
      this.session.replacePayload(payload);
      this.conflict = null;
      this.lastError = null;
      this.retryable = false;
      this.retryAttempts = 0;
      this.pending = false;
      this.forcedHash = undefined;
      this.setState(payload.readOnly ? "readonly" : "clean");
      return { ok: true, state: this.state };
    } catch (error) {
      const normalized = normalizeError(error);
      this.lastError = normalized;
      if (this.state === "conflict") {
        // Keep the banner and its exact-hash action available after a failed
        // reload; the user can retry the reload or force the overwrite.
        this.publish();
        return this.failure("conflict");
      }
      this.retryable = false;
      this.setState("error");
      return this.failure("error");
    }
  }

  private async flushLoop(reason: FlushReason): Promise<FlushResult> {
    this.cancelScheduledTimers();

    try {
      while (!this.disposed) {
        if (this.session.getSnapshot().readOnly || this.state === "readonly") {
          this.setState("readonly");
          return { ok: true, state: "readonly" };
        }
        if (this.state === "conflict") {
          return this.failure("conflict");
        }
        if (this.state === "error" && !this.retryable) {
          return this.failure("error");
        }
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }

        const needsSave =
          this.pending ||
          this.state === "dirty" ||
          this.state === "scheduled" ||
          (this.state === "error" && this.retryable);

        if (!needsSave) {
          this.setState("clean");
          return { ok: true, state: "clean" };
        }

        this.cancelRetryTimer();
        const outcome = await this.saveOnce(this.takeForcedHash());
        if (outcome.kind === "success") {
          continue;
        }
        if (outcome.kind === "conflict" || !outcome.retryable) {
          return this.failure(outcome.kind === "conflict" ? "conflict" : "error");
        }
        if (this.retryAttempts >= this.retryDelaysMs.length) {
          this.retryable = false;
          this.setState("error");
          return this.failure("error");
        }

        const configured = this.retryDelaysMs[this.retryAttempts] ?? SAVE_MAX_RETRY_DELAY_MS;
        const delay = Math.min(configured, SAVE_MAX_RETRY_DELAY_MS);
        this.retryAttempts += 1;
        this.setState("scheduled");

        if (reason === "auto") {
          this.armRetry(delay);
          return this.failure("error");
        }

        await this.sleep(delay);
      }
      return this.failure("error");
    } catch (error) {
      const normalized = normalizeError(error);
      this.lastError = normalized;
      this.retryable = false;
      this.setState("error");
      return this.failure("error");
    }
  }

  private async saveOnce(expectedCurrentHash?: string): Promise<SaveOutcome> {
    this.pending = false;
    this.setState("saving");

    const text = this.session.readText();
    const request: SaveRequest =
      expectedCurrentHash === undefined
        ? { docToken: this.session.docToken, text }
        : { docToken: this.session.docToken, text, expectedCurrentHash };

    const write = this.ipc.documentWriteAtomic(request);
    this.inFlight = write.then(
      () => undefined,
      () => undefined,
    );

    try {
      const result = await write;
      this.session.applySaveResult(result);
      this.retryAttempts = 0;
      this.retryable = false;
      this.lastError = null;
      this.setState(this.pending ? "dirty" : "clean");
      return { kind: "success", result };
    } catch (error) {
      const normalized = normalizeError(error);
      this.lastError = normalized;

      if (normalized.code === "CONFLICT") {
        this.conflict = conflictDetailsOf(normalized.details);
        this.retryable = false;
        this.setState("conflict");
        return { kind: "conflict", error: normalized, conflict: this.conflict };
      }

      this.retryable =
        isRetryableSaveError(normalized) && this.retryAttempts < this.retryDelaysMs.length;
      this.setState("error");
      return { kind: "error", error: normalized, retryable: this.retryable };
    } finally {
      this.inFlight = null;
      this.publish();
    }
  }

  private armScheduledTimers(): void {
    this.clearDebounceTimer();
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = null;
      this.clearMaxWaitTimer();
      void this.flush("auto").catch(() => undefined);
    }, this.debounceMs);

    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = this.timers.setTimeout(() => {
        this.maxWaitTimer = null;
        this.clearDebounceTimer();
        void this.flush("auto").catch(() => undefined);
      }, this.maxWaitMs);
    }
  }

  private armRetry(delay: number): void {
    this.cancelRetryTimer();
    this.setState("scheduled");
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.flush("auto").catch(() => undefined);
    }, delay);
  }

  private cancelScheduledTimers(): void {
    this.clearDebounceTimer();
    this.clearMaxWaitTimer();
    this.cancelRetryTimer();
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      this.timers.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearMaxWaitTimer(): void {
    if (this.maxWaitTimer !== null) {
      this.timers.clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async waitForIdle(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private takeForcedHash(): string | undefined {
    const hash = this.forcedHash;
    this.forcedHash = undefined;
    return hash;
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, milliseconds);
    });
  }

  private setState(next: SaveState): void {
    if (this.disposed) {
      return;
    }
    this.session.setSaveState(next);
    this.state = this.session.getSnapshot().saveState;
    this.publish();
  }

  private failure(failure: FlushFailureReason): FlushResult {
    return {
      ok: false,
      state: this.state,
      failure,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.conflict ? { conflict: this.conflict } : {}),
    };
  }

  private makeSnapshot(): SaveCoordinatorSnapshot {
    return Object.freeze({
      state: this.state,
      conflict: this.conflict,
      error: this.lastError,
      retryAttempts: this.retryAttempts,
      pending: this.pending,
    });
  }

  private publish(): void {
    if (this.disposed) {
      return;
    }
    const next = this.makeSnapshot();
    const previous = this.snapshot;
    if (
      previous.state === next.state &&
      previous.conflict === next.conflict &&
      previous.error === next.error &&
      previous.retryAttempts === next.retryAttempts &&
      previous.pending === next.pending
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
