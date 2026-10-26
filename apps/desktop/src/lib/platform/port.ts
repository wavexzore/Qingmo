import type { CloseReason } from "@qingmo/shared";

export interface PlatformPort {
  /** Subscribe to the Rust CloseGuard event. Returns an unsubscribe function. */
  onCloseRequested(callback: (reason: CloseReason) => void): () => void;
  /** Window lost focus; used by the autosave coordinator in T-011. */
  onBlur(callback: () => void): () => void;
  /** True while an IME composition is active; save shortcuts must not fire. */
  isComposing(): boolean;
}
