import type {
  AppError,
  UpdateInfo,
  UpdateProgress,
  UpdateProgressPayload,
  UpdateSnapshot,
} from "@qingmo/shared";

import { AppError as AppErrorClass } from "../ipc/errors";
import type { UpdatePort } from "./port";

export interface FakeUpdatePortOptions {
  currentVersion?: string;
  /** The update returned by `check()`; `null` means "up to date". */
  update?: UpdateInfo | null;
  /** Start directly in this snapshot instead of Idle. */
  initialSnapshot?: UpdateSnapshot;
  checkError?: AppError | null;
  downloadError?: AppError | null;
  installError?: AppError | null;
  /** Cumulative progress steps emitted during `download()`. */
  progressSteps?: UpdateProgress[];
  artifactBytes?: number;
}

export interface FakeUpdateCalls {
  status: number;
  check: number;
  download: number;
  install: number;
}

const DEFAULT_ARTIFACT_BYTES = 38_400_000;

/**
 * Zero-network updater for unit tests and the browser E2E build.
 *
 * It never reads timers, files, or the network; tests drive every transition
 * explicitly. The Tauri adapter remains the only production implementation.
 */
export class FakeUpdatePort implements UpdatePort {
  private snapshot: UpdateSnapshot;
  private update: UpdateInfo | null;
  private checkError: AppError | null;
  private downloadError: AppError | null;
  private installError: AppError | null;
  private progressSteps: UpdateProgress[];
  private readonly artifactBytes: number;
  private downloadHold = false;
  private downloadRelease: (() => void) | null = null;
  private readonly stateListeners = new Set<(snapshot: UpdateSnapshot) => void>();
  private readonly progressListeners = new Set<(progress: UpdateProgressPayload) => void>();

  readonly calls: FakeUpdateCalls = {
    status: 0,
    check: 0,
    download: 0,
    install: 0,
  };

  constructor(options: FakeUpdatePortOptions = {}) {
    const currentVersion = options.currentVersion ?? "0.1.0";
    this.update = options.update ?? null;
    this.checkError = options.checkError ?? null;
    this.downloadError = options.downloadError ?? null;
    this.installError = options.installError ?? null;
    this.artifactBytes = options.artifactBytes ?? DEFAULT_ARTIFACT_BYTES;
    this.progressSteps = options.progressSteps ?? [
      { downloaded: 0, total: this.artifactBytes },
      { downloaded: this.artifactBytes, total: this.artifactBytes },
    ];
    this.snapshot =
      options.initialSnapshot ??
      ({
        phase: "idle",
        generation: 0,
        currentVersion,
        update: null,
        progress: null,
      } satisfies UpdateSnapshot);
  }

  get currentSnapshot(): UpdateSnapshot {
    return this.snapshot;
  }

  async status(): Promise<UpdateSnapshot> {
    this.calls.status += 1;
    return this.snapshot;
  }

  async check(): Promise<UpdateSnapshot> {
    this.calls.check += 1;
    if (this.checkError) {
      throw this.checkError;
    }
    return this.transition({
      phase: this.update ? "available" : "idle",
      update: this.update,
      progress: null,
    });
  }

  async download(): Promise<UpdateSnapshot> {
    this.calls.download += 1;
    if (!this.snapshot.update) {
      throw new AppErrorClass("UPDATE_NOT_READY", "no update is available to download");
    }

    this.transition({
      phase: "downloading",
      progress: { downloaded: 0, total: this.artifactBytes },
    });

    const hold = this.downloadHold;
    this.downloadHold = false;

    if (hold) {
      this.emitProgress({
        generation: this.snapshot.generation,
        downloaded: 0,
        total: this.artifactBytes,
      });
    } else {
      for (const step of this.progressSteps) {
        this.emitProgress({
          generation: this.snapshot.generation,
          downloaded: step.downloaded,
          total: step.total,
        });
      }
    }

    if (this.downloadError) {
      this.transition({ phase: "available", progress: null });
      throw this.downloadError;
    }

    if (hold) {
      await new Promise<void>((resolve) => {
        this.downloadRelease = resolve;
      });
    }

    return this.transition({
      phase: "ready",
      progress: {
        downloaded: this.artifactBytes,
        total: this.artifactBytes,
      },
    });
  }

  async install(): Promise<void> {
    this.calls.install += 1;
    if (this.installError) {
      throw this.installError;
    }
    this.transition({ phase: "installing", progress: null });
  }

  async onState(handler: (snapshot: UpdateSnapshot) => void): Promise<() => void> {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  async onProgress(handler: (progress: UpdateProgressPayload) => void): Promise<() => void> {
    this.progressListeners.add(handler);
    return () => {
      this.progressListeners.delete(handler);
    };
  }

  /** Inject a snapshot and notify state listeners (E2E/manual transitions). */
  emitState(snapshot: UpdateSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }

  /** Inject a progress frame without changing the snapshot. */
  emitProgress(progress: UpdateProgressPayload): void {
    for (const listener of this.progressListeners) {
      listener(progress);
    }
  }

  resetCalls(): void {
    this.calls.status = 0;
    this.calls.check = 0;
    this.calls.download = 0;
    this.calls.install = 0;
  }

  /** E2E/unit control: change what the next `check()` announces. */
  setUpdate(update: UpdateInfo | null): void {
    this.update = update;
  }

  /** E2E/unit control: inject or clear a failure for one operation. */
  setError(operation: "check" | "download" | "install", error: AppError | null): void {
    if (operation === "check") {
      this.checkError = error;
    } else if (operation === "download") {
      this.downloadError = error;
    } else {
      this.installError = error;
    }
  }

  /** E2E control: keep `download()` pending until `releaseDownload()`. */
  holdNextDownload(): void {
    this.downloadHold = true;
  }

  releaseDownload(): void {
    this.downloadHold = false;
    const release = this.downloadRelease;
    this.downloadRelease = null;
    release?.();
  }

  /** E2E control: emit a progress frame for the current download generation. */
  emitDownloadProgress(downloaded: number, total: number | null = null): void {
    this.emitProgress({
      generation: this.snapshot.generation,
      downloaded,
      total,
    });
  }

  private transition(
    change: Pick<UpdateSnapshot, "phase" | "progress"> & Pick<Partial<UpdateSnapshot>, "update">,
  ): UpdateSnapshot {
    const next: UpdateSnapshot = {
      ...this.snapshot,
      ...change,
      generation: this.snapshot.generation + 1,
    };
    this.emitState(next);
    return next;
  }
}
