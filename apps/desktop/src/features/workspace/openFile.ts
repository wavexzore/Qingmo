import type { AppError, FilePayload } from "@qingmo/shared";
import { err, ok, type Result } from "@qingmo/shared";

import { normalizeError } from "../../lib/ipc/errors";
import type { IpcPort } from "../../lib/ipc/port";

/**
 * Opens a document through the port. There is deliberately no path parameter:
 * the native dialog and all path validation live in Rust.
 *
 * Cancellation is a normal result (`CANCELLED`) so the UI can stay silent;
 * every other rejection shape is normalized to AppError.
 */
export async function openFile(ipc: IpcPort): Promise<Result<FilePayload, AppError>> {
  try {
    return ok(await ipc.documentOpen());
  } catch (error) {
    return err(normalizeError(error));
  }
}
