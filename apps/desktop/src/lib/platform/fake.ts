import type { CloseReason } from "@qingmo/shared";

import type { MenuAction } from "../ipc/commands";
import type { PlatformPort } from "./port";

/**
 * Browser-test platform. Close and blur events are explicit because a browser
 * page cannot observe the native window lifecycle used by Tauri.
 */
export class FakePlatform implements PlatformPort {
  private readonly closeListeners = new Set<(reason: CloseReason) => void>();
  private readonly menuListeners = new Set<(action: MenuAction) => void>();
  private readonly blurListeners = new Set<() => void>();
  private composing = false;

  onCloseRequested(callback: (reason: CloseReason) => void): () => void {
    this.closeListeners.add(callback);
    return () => {
      this.closeListeners.delete(callback);
    };
  }

  onMenuAction(callback: (action: MenuAction) => void): () => void {
    this.menuListeners.add(callback);
    return () => {
      this.menuListeners.delete(callback);
    };
  }

  onBlur(callback: () => void): () => void {
    this.blurListeners.add(callback);
    return () => {
      this.blurListeners.delete(callback);
    };
  }

  isComposing(): boolean {
    return this.composing;
  }

  setComposing(composing: boolean): void {
    this.composing = composing;
  }

  emitCloseRequested(reason: CloseReason = "window"): void {
    for (const listener of [...this.closeListeners]) {
      listener(reason);
    }
  }

  emitBlur(): void {
    for (const listener of [...this.blurListeners]) {
      listener();
    }
  }

  emitMenuAction(action: MenuAction): void {
    for (const listener of [...this.menuListeners]) {
      listener(action);
    }
  }

  get listenerCounts(): { close: number; menu: number; blur: number } {
    return {
      close: this.closeListeners.size,
      menu: this.menuListeners.size,
      blur: this.blurListeners.size,
    };
  }
}
