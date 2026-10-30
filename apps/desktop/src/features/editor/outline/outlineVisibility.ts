import { useSyncExternalStore } from "react";

export interface OutlineVisibilitySnapshot {
  open: boolean;
}

/**
 * Per-window, in-memory outline visibility. It intentionally has no storage:
 * every Tauri document window owns its own store instance.
 */
class OutlineVisibilityStore {
  private snapshot: OutlineVisibilitySnapshot = Object.freeze({ open: false });
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OutlineVisibilitySnapshot => this.snapshot;

  setOpen(open: boolean): void {
    if (open === this.snapshot.open) {
      return;
    }
    this.snapshot = Object.freeze({ open });
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  toggle(): boolean {
    this.setOpen(!this.snapshot.open);
    return this.snapshot.open;
  }

  resetForTests(): void {
    this.setOpen(false);
  }
}

export const outlineVisibilityStore = new OutlineVisibilityStore();

export function useOutlineOpen(): boolean {
  return useSyncExternalStore(
    outlineVisibilityStore.subscribe,
    outlineVisibilityStore.getSnapshot,
    outlineVisibilityStore.getSnapshot,
  ).open;
}
