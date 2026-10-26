export interface CompositionTracker {
  isComposing(): boolean;
}

let tracker: CompositionTracker | undefined;

/**
 * Tracks IME composition once per webview. `PlatformPort.isComposing()` is
 * consulted by save shortcuts so pressing Cmd+S while an IME candidate window
 * is open does not save a half-composed string.
 */
export function getCompositionTracker(): CompositionTracker {
  if (tracker) {
    return tracker;
  }

  let composing = false;

  if (typeof window !== "undefined") {
    window.addEventListener(
      "compositionstart",
      () => {
        composing = true;
      },
      true,
    );
    window.addEventListener(
      "compositionend",
      () => {
        composing = false;
      },
      true,
    );
  }

  tracker = {
    isComposing: () => composing,
  };
  return tracker;
}
