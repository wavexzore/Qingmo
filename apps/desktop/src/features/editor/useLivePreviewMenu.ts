import { useEffect } from "react";

import type { IpcPort } from "../../lib/ipc/port";
import type { EditorSession } from "./EditorSession";

/**
 * Mirrors the effective Live Preview mode in the native menu.
 *
 * The checkmark must follow every entry point: the menu item, the command
 * palette, and the automatic source-mode fallback for large files. Rust owns
 * the shared menu and re-applies the stored value when another window gains
 * focus, so reporting the effective snapshot here is enough for multi-window
 * consistency.
 */
export function useLivePreviewMenu(ipc: IpcPort, session: EditorSession | null): void {
  useEffect(() => {
    if (!session) {
      return;
    }

    let reported = session.getSnapshot().livePreview;
    const report = () => {
      const { livePreview } = session.getSnapshot();
      if (livePreview === reported) {
        return;
      }
      reported = livePreview;
      void ipc.appSetLivePreview({ livePreview }).catch(() => undefined);
    };

    // A large file starts in source mode even though the menu item defaults
    // to checked, so the first report must be unconditional.
    void ipc.appSetLivePreview({ livePreview: reported }).catch(() => undefined);
    return session.subscribe(report);
  }, [ipc, session]);
}
