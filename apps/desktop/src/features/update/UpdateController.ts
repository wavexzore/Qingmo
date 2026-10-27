import type { UpdateProgressPayload, UpdateSnapshot } from "@qingmo/shared";

import type { FlushResult } from "../editor/save/SaveCoordinator";
import { AppError, normalizeError } from "../../lib/ipc/errors";
import type { UpdatePort } from "../../lib/update/port";

export type PrepareInstall = () => Promise<FlushResult>;

export interface UpdateControllerOptions {
  autoCheck: boolean;
  autoCheckDelayMs?: number;
}

const DEFAULT_AUTO_CHECK_DELAY_MS = 8_000;

/**
 * Frontend mirror of the Rust update state machine.
 *
 * It never infers a phase; every snapshot comes from the port. The only
 * orchestration it owns is subscription lifecycle, the delayed silent check,
 * and "flush the current document before install".
 */
export class UpdateController {
  private snapshot: UpdateSnapshot | null = null;
  private started = false;
  private runId = 0;
  private installInFlight = false;
  private unlisten: Array<() => void> = [];
  private pendingUnlisten: Array<Promise<() => void>> = [];
  private prepareInstall: PrepareInstall | null = null;
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly autoCheck: boolean;
  private readonly autoCheckDelayMs: number;

  constructor(
    private readonly port: UpdatePort,
    options: UpdateControllerOptions,
  ) {
    this.autoCheck = options.autoCheck;
    this.autoCheckDelayMs = options.autoCheckDelayMs ?? DEFAULT_AUTO_CHECK_DELAY_MS;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): UpdateSnapshot | null => this.snapshot;

  registerPrepareInstall(prepare: PrepareInstall): () => void {
    this.prepareInstall = prepare;
    return () => {
      if (this.prepareInstall === prepare) {
        this.prepareInstall = null;
      }
    };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const run = ++this.runId;
    void this.bootstrap(run);
  }

  stop(): void {
    this.started = false;
    this.runId += 1;
    this.detachAll();
  }

  async check(options: { silent: boolean } = { silent: false }): Promise<UpdateSnapshot | null> {
    try {
      const next = await this.port.check();
      this.publish(next);
      return next;
    } catch (error) {
      const normalized = normalizeError(error);
      await this.reconcile();
      if (!options.silent) {
        throw normalized;
      }
      return this.snapshot;
    }
  }

  async download(): Promise<UpdateSnapshot> {
    try {
      const next = await this.port.download();
      this.publish(next);
      return next;
    } catch (error) {
      await this.reconcile();
      throw normalizeError(error);
    }
  }

  async install(): Promise<void> {
    if (this.installInFlight) {
      throw new AppError("BUSY", "update install already running");
    }
    const prepare = this.prepareInstall;
    if (!prepare) {
      throw new AppError("BUSY", "document save gate is not registered");
    }

    this.installInFlight = true;
    try {
      const result = await prepare();
      if (!result.ok) {
        throw (
          result.error ??
          new AppError(
            result.failure === "conflict" ? "CONFLICT" : "IO",
            "document save blocked the update install",
          )
        );
      }
      await this.port.install();
    } catch (error) {
      await this.reconcile();
      throw normalizeError(error);
    } finally {
      this.installInFlight = false;
    }
  }

  private async bootstrap(run: number): Promise<void> {
    try {
      const state = this.trackUnlisten(this.port.onState((next) => this.publish(next)));
      const progress = this.trackUnlisten(
        this.port.onProgress((next) => this.publishProgress(next)),
      );
      const [offState, offProgress] = await Promise.all([state, progress]);

      if (run !== this.runId) {
        offState();
        offProgress();
        return;
      }
      this.unlisten.push(offState, offProgress);

      const current = await this.port.status();
      if (run !== this.runId) {
        return;
      }
      this.publish(current);

      if (!this.autoCheck) {
        return;
      }
      this.autoCheckTimer = setTimeout(() => {
        this.autoCheckTimer = null;
        if (run === this.runId && this.snapshot?.phase === "idle") {
          void this.check({ silent: true });
        }
      }, this.autoCheckDelayMs);
    } catch (error) {
      if (run !== this.runId) {
        return;
      }
      this.started = false;
      this.runId += 1;
      this.detachAll();
      console.debug("update bootstrap failed", normalizeError(error));
    }
  }

  private detachAll(): void {
    for (const unlisten of this.unlisten) {
      unlisten();
    }
    this.unlisten = [];

    for (const pending of this.pendingUnlisten) {
      void pending.then((unlisten) => unlisten()).catch(() => undefined);
    }
    this.pendingUnlisten = [];

    if (this.autoCheckTimer !== null) {
      clearTimeout(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
  }

  /**
   * Wraps a subscription so cleanup is idempotent: `stop()` may race the
   * `listen()` promise and both paths must be safe to run.
   */
  private trackUnlisten(promise: Promise<() => void>): Promise<() => void> {
    const guarded = promise.then((unlisten) => {
      let done = false;
      return () => {
        if (done) {
          return;
        }
        done = true;
        try {
          unlisten();
        } catch (error) {
          console.debug("update unsubscribe failed", normalizeError(error));
        }
      };
    });
    this.pendingUnlisten.push(guarded);
    void guarded
      .finally(() => {
        this.pendingUnlisten = this.pendingUnlisten.filter((entry) => entry !== guarded);
      })
      .catch(() => undefined);
    return guarded;
  }

  private publish(next: UpdateSnapshot): void {
    if (this.snapshot && next.generation < this.snapshot.generation) {
      return;
    }
    this.snapshot = next;
    this.emit();
  }

  private publishProgress(progress: UpdateProgressPayload): void {
    const current = this.snapshot;
    if (!current || current.phase !== "downloading" || current.generation !== progress.generation) {
      return;
    }
    this.snapshot = {
      ...current,
      progress: {
        downloaded: progress.downloaded,
        total: progress.total,
      },
    };
    this.emit();
  }

  private async reconcile(): Promise<void> {
    const current = await this.port.status().catch(() => null);
    if (current) {
      this.publish(current);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
