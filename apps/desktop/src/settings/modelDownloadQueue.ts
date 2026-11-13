import type { ModelProgress } from "@qingmo/shared";

import type { SettingsPort } from "../lib/settings/port";

type Listener = (update: ModelProgress) => void;

/**
 * One progress bridge for the settings port. The download queue lives here,
 * not in the React tree: switching sections or reopening the settings window
 * must not lose the waiter that advances the queue.
 */
let bridged: SettingsPort | null = null;
const listeners = new Set<Listener>();
const waiters = new Map<string, () => void>();
const active = new Map<string, string>();
let running = false;
let stop = false;

export function ensureModelProgressBridge(settings: SettingsPort): void {
  if (bridged === settings) {
    return;
  }
  bridged = settings;
  listeners.clear();
  waiters.clear();
  active.clear();
  running = false;
  stop = false;
  settings.onModelProgress((update) => {
    for (const listener of listeners) {
      listener(update);
    }
    if (update.state === "done" || update.state === "failed" || update.state === "cancelled") {
      waiters.get(update.modelId)?.();
      waiters.delete(update.modelId);
      active.delete(update.modelId);
    }
  });
}

export function subscribeModelProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginModelDownload(modelId: string, downloadId: string): void {
  active.set(modelId, downloadId);
}

export function activeDownloadId(modelId: string): string | undefined {
  return active.get(modelId);
}

export function waitForModel(modelId: string): Promise<void> {
  return new Promise((resolve) => waiters.set(modelId, resolve));
}

export function dropWaiter(modelId: string): void {
  waiters.delete(modelId);
}

export function isQueueRunning(): boolean {
  return running;
}

export function setQueueRunning(value: boolean): void {
  running = value;
}

export function shouldStopQueue(): boolean {
  return stop;
}

export function setStopQueue(value: boolean): void {
  stop = value;
}
