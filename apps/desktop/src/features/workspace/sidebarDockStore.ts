import { useSyncExternalStore } from "react";

export type SidebarView = "workspace" | "outline";

export interface SidebarDockSnapshot {
  open: boolean;
  view: SidebarView;
  /** This window has explicitly shown the dock at least once. */
  everOpened: boolean;
}

/**
 * Per-window, in-memory dock visibility. This is the only visibility source:
 * the old outline store was removed so the two panels cannot disagree.
 */
class SidebarDockStore {
  private snapshot: SidebarDockSnapshot = Object.freeze({
    open: false,
    view: "workspace",
    everOpened: false,
  });
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SidebarDockSnapshot => this.snapshot;

  setOpen(open: boolean): void {
    if (open === this.snapshot.open) {
      return;
    }
    this.commit({
      open,
      view: this.snapshot.view,
      everOpened: this.snapshot.everOpened || open,
    });
  }

  show(view: SidebarView): void {
    if (this.snapshot.open && this.snapshot.view === view && this.snapshot.everOpened) {
      return;
    }
    this.commit({ open: true, view, everOpened: true });
  }

  openLast(fallback: SidebarView | null): void {
    this.commit({
      open: true,
      view: fallback ?? this.snapshot.view,
      everOpened: true,
    });
  }

  /**
   * `fallback` is the view to show when the requested view is already active.
   * A `null` fallback closes the dock in that case.
   */
  toggleView(view: SidebarView, fallback: SidebarView | null): SidebarDockSnapshot {
    if (!this.snapshot.open || this.snapshot.view !== view) {
      this.show(view);
      return this.snapshot;
    }
    if (fallback) {
      this.show(fallback);
    } else {
      this.setOpen(false);
    }
    return this.snapshot;
  }

  resetForTests(): void {
    this.commit({ open: false, view: "workspace", everOpened: false }, true);
  }

  private commit(snapshot: SidebarDockSnapshot, force = false): void {
    if (
      !force &&
      snapshot.open === this.snapshot.open &&
      snapshot.view === this.snapshot.view &&
      snapshot.everOpened === this.snapshot.everOpened
    ) {
      return;
    }
    this.snapshot = Object.freeze(snapshot);
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export const sidebarDockStore = new SidebarDockStore();

export function useSidebarDock(): SidebarDockSnapshot {
  return useSyncExternalStore(
    sidebarDockStore.subscribe,
    sidebarDockStore.getSnapshot,
    sidebarDockStore.getSnapshot,
  );
}
