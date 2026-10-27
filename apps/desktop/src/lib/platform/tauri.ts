import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CloseRequestedPayload, MenuActionPayload } from "@qingmo/shared";

import { EVENTS, MENU_ACTION_NAMES, type MenuAction } from "../ipc/commands";
import { normalizeError } from "../ipc/errors";
import { getCompositionTracker } from "./composition";
import type { PlatformPort } from "./port";

/**
 * The only production adapter allowed to import `@tauri-apps/api`.
 * `dependency-cruiser` enforces this boundary.
 */
export function createTauriPlatform(): PlatformPort {
  const composition = getCompositionTracker();
  // Native close/menu events carry their target label. Even if a platform
  // delivers an event to every webview, each window must ignore events that
  // belong to another window. The label is resolved when a listener is
  // registered so building the adapter has no Tauri side effects.
  const currentTarget = () => {
    const label = getCurrentWebviewWindow().label;
    return {
      label,
      options: { target: { kind: "WebviewWindow" as const, label } },
    };
  };

  return {
    onCloseRequested(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;
      const { label: windowLabel, options: listenOptions } = currentTarget();

      void listen<CloseRequestedPayload>(
        EVENTS.closeRequested,
        (event) => {
          if (disposed || event.payload.target !== windowLabel) {
            return;
          }
          callback(event.payload.reason);
        },
        listenOptions,
      )
        .then((stop) => {
          if (disposed) {
            stop();
          } else {
            unlisten = stop;
          }
        })
        .catch((error: unknown) => {
          // A failed subscription means the CloseGuard event cannot arrive.
          // T-012 owns the user-visible recovery; the adapter must not throw
          // from a fire-and-forget listener registration.
          console.error("failed to subscribe to app://close-requested", normalizeError(error));
        });

      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    },

    onMenuAction(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;
      const { label: windowLabel, options: listenOptions } = currentTarget();

      void listen<MenuActionPayload>(
        EVENTS.menuAction,
        (event) => {
          if (disposed || event.payload.target !== windowLabel) {
            return;
          }
          if (MENU_ACTION_NAMES.includes(event.payload.action as MenuAction)) {
            callback(event.payload.action as MenuAction);
          } else {
            console.warn("ignored unknown menu action", event.payload.action);
          }
        },
        listenOptions,
      )
        .then((stop) => {
          if (disposed) {
            stop();
          } else {
            unlisten = stop;
          }
        })
        .catch((error: unknown) => {
          console.error("failed to subscribe to app://menu-action", normalizeError(error));
        });

      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    },

    onBlur(callback) {
      window.addEventListener("blur", callback);
      return () => {
        window.removeEventListener("blur", callback);
      };
    },

    isComposing: () => composition.isComposing(),
  };
}
