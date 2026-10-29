import { normalizeError } from "../../../lib/ipc/errors";
import type { IpcPort } from "../../../lib/ipc/port";

/**
 * Builds the editor's open-link callback.
 *
 * Opening a link must never fail the document session: a refused or broken
 * destination is logged, while the editor keeps its text and selection.
 */
export function createOpenExternal(ipc: Pick<IpcPort, "appOpenExternal">): (href: string) => void {
  return (href) => {
    void ipc.appOpenExternal(href).catch((error: unknown) => {
      console.warn("failed to open the external link", normalizeError(error));
    });
  };
}
