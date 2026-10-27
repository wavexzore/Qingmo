import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CloseRequestedPayload } from "@qingmo/shared";

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

  return {
    onCloseRequested(callback) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;

      void listen<CloseRequestedPayload>(EVENTS.closeRequested, (event) => {
        if (!disposed) {
          callback(event.payload.reason);
        }
      })
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

      void listen<string>(EVENTS.menuAction, (event) => {
        if (disposed) {
          return;
        }
        if (MENU_ACTION_NAMES.includes(event.payload as MenuAction)) {
          callback(event.payload as MenuAction);
        } else {
          console.warn("ignored unknown menu action", event.payload);
        }
      })
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
