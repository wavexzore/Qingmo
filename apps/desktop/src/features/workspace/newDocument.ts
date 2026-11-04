import type { AppError } from "@qingmo/shared";
import { err, ok, type Result } from "@qingmo/shared";

import { normalizeError } from "../../lib/ipc/errors";
import type { DocumentNewPlacement, IpcPort } from "../../lib/ipc/port";

/**
 * Creates a new document through the port.
 *
 * Tauri resolves `window` after creating a native window; only browser
 * adapters resolve `current` and expect the caller to reset this window.
 * Every rejection shape is normalized to AppError.
 */
export async function newDocument(ipc: IpcPort): Promise<Result<DocumentNewPlacement, AppError>> {
  try {
    return ok(await ipc.documentNew());
  } catch (error) {
    return err(normalizeError(error));
  }
}
