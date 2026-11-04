import type { EditorUiCopy } from "@qingmo/editor-core";
import type { FilePayload } from "@qingmo/shared";

import { normalizeError } from "../../lib/ipc/errors";
import type { IpcPort } from "../../lib/ipc/port";
import type { EditorSession } from "../editor/EditorSession";
import type { SetSessionExtras } from "../editor/DocumentSessionContext";
import {
  createDocumentSession,
  type CreatedDocumentSession,
} from "../editor/session/createDocumentSession";

export interface AdoptInPlaceDeps {
  ipc: Pick<
    IpcPort,
    "documentActivate" | "documentReload" | "sessionViewStateGet" | "appOpenExternal"
  >;
  /** Reads the provider's live session ref (the single source of truth). */
  getCurrentSession(): EditorSession | null;
  /**
   * Saves/journals the session being replaced; `false` means it already
   * surfaced the error and the adoption must be abandoned.
   */
  preserveCurrentSession(): Promise<boolean>;
  /** Installs the adopted session. */
  setSession(next: EditorSession, extras?: SetSessionExtras): void;
  /** Reports a failure toast for an arbitrary error. */
  reportError(error: unknown): void;
  /** Reports that the bounded tail passes were out-typed. */
  reportBusy(): void;
  uiCopy: EditorUiCopy;
}

/**
 * Adopts a harness Open payload in place (browser/E2E only).
 *
 * The session being replaced is preserved first (dialog input, then the tail
 * passes that watch the adoption handoff itself), the same file is re-read
 * from disk so a late save is never overwritten, and every failure abandons
 * the adoption with the current session kept. Returns true only when the
 * payload session was installed.
 */
export async function adoptInPlace(
  {
    ipc,
    getCurrentSession,
    preserveCurrentSession,
    setSession,
    reportError,
    reportBusy,
    uiCopy,
  }: AdoptInPlaceDeps,
  payload: FilePayload,
  baseline: string | null,
  previousToken: string | null,
): Promise<boolean> {
  const live = getCurrentSession();
  const samePath = live !== null && live.getSnapshot().docId === payload.path;
  const late = live !== null && live.readText() !== baseline;
  // From here every write must go through the session being replaced, so
  // restore its token before any await lets an auto-save fire.
  if (previousToken) {
    await ipc.documentActivate(previousToken);
  }
  if (late && !(await preserveCurrentSession())) {
    return false;
  }
  // Snapshot the text the late preserve left behind; the tail passes compare
  // against this to catch input typed during the handoff.
  let preserved = live?.readText() ?? null;
  // The payload can predate a late save when the same file is reopened;
  // adopting it verbatim would let the next save overwrite that text.
  const rebuildFromDisk = async (
    current: CreatedDocumentSession,
  ): Promise<CreatedDocumentSession> => {
    const fresh = await ipc.documentReload(current.session.docToken);
    const rebuilt = await createDocumentSession(ipc, fresh, uiCopy);
    current.session.dispose();
    return rebuilt;
  };
  let created: CreatedDocumentSession | undefined;
  try {
    created = await createDocumentSession(ipc, payload, uiCopy);
    await ipc.documentActivate(created.session.docToken);
    if (late && samePath) {
      created = await rebuildFromDisk(created);
    }
    // Text typed while the adoption was being prepared has no carrier yet.
    // Two bounded passes keep even a fast typist covered.
    for (let pass = 0; pass < 2; pass += 1) {
      if (live === null || live.readText() === preserved) {
        break;
      }
      if (previousToken) {
        await ipc.documentActivate(previousToken);
      }
      if (!(await preserveCurrentSession())) {
        created.session.dispose();
        return false;
      }
      preserved = live.readText();
      await ipc.documentActivate(created.session.docToken);
      if (samePath) {
        created = await rebuildFromDisk(created);
      }
    }
    if (live !== null && live.readText() !== preserved) {
      // The user out-typed both bounded passes. Abandon the adoption instead
      // of dropping the newest keystrokes: the text stays alive in the
      // current session and the Open can simply be repeated.
      console.warn("abandoned an in-place adoption: input kept arriving");
      created.session.dispose();
      if (previousToken) {
        await ipc.documentActivate(previousToken);
      }
      reportBusy();
      return false;
    }
  } catch (error) {
    // A failed re-read must not adopt a stale payload, and a failed tail
    // save must not drop the text: keep the current session, whose latest
    // snapshot is already preserved on disk or as a draft.
    console.warn("failed to finish the in-place adoption", normalizeError(error));
    created?.session.dispose();
    if (previousToken) {
      await ipc.documentActivate(previousToken);
    }
    reportError(error);
    return false;
  }
  setSession(created.session, { viewState: created.viewState });
  return true;
}
