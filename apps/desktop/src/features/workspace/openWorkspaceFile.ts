import type { AppError, FilePayload } from "@qingmo/shared";
import { err, ok, type Result } from "@qingmo/shared";

import { normalizeError } from "../../lib/ipc/errors";
import type { IpcPort } from "../../lib/ipc/port";

/**
 * Reads one file from the workspace tree for an in-window switch.
 *
 * Every adapter returns the payload; the caller preserves the current session,
 * adopts the new one, and activates its token.
 */
export async function openWorkspaceFile(
  ipc: IpcPort,
  workspaceToken: string,
  segments: string[],
): Promise<Result<FilePayload, AppError>> {
  try {
    return ok(await ipc.workspaceOpenDocument(workspaceToken, segments));
  } catch (error) {
    return err(normalizeError(error));
  }
}
