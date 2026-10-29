import { useCallback, useEffect, useRef, useState } from "react";

import type { CloseReason } from "@qingmo/shared";

import type { IpcPort } from "../lib/ipc/port";
import type { PlatformPort } from "../lib/platform/port";
import type { SaveCoordinator } from "../features/editor/save/SaveCoordinator";
import type { DraftJournal } from "../features/editor/recovery/DraftJournal";
import type { ViewStateRecorder } from "../features/editor/session/ViewStateRecorder";

export type ClosePromptKind = "unsaved" | "conflict" | "error";

export interface ClosePrompt {
  reason: CloseReason;
  kind: ClosePromptKind;
}

export interface CloseGuardState {
  prompt: ClosePrompt | null;
  /** True while a native close request is flushing; updates must not overlap it. */
  closing: boolean;
  /** Discards unsaved changes and confirms the close. */
  allowClose(): Promise<void>;
  cancelClose(): Promise<void>;
}

export interface UseCloseGuardOptions {
  ipc: Pick<IpcPort, "appCloseConfirm">;
  platform: PlatformPort;
  coordinator: SaveCoordinator | null;
  /** Optional view-state recorder flushed before an allowed close. */
  viewState?: ViewStateRecorder | null;
  /** Optional crash-draft journal flushed before an allowed close. */
  journal?: DraftJournal | null;
}

/**
 * Bridges the Rust CloseGuard event to SaveCoordinator.
 *
 * - A dirty untitled document asks for exit confirmation first. Confirming
 *   discards the unsaved text and closes; cancelling only dismisses the dialog.
 *   Exit is never coupled to Save As.
 * - Other documents flush first; a conflict/terminal error opens an explicit
 *   "close anyway?" prompt.
 * - Blur flushes the coordinator unless an IME composition is active; a
 *   compositionend then performs the deferred flush.
 */
export function useCloseGuard({
  ipc,
  platform,
  coordinator,
  viewState = null,
  journal = null,
}: UseCloseGuardOptions): CloseGuardState {
  const [prompt, setPrompt] = useState<ClosePrompt | null>(null);
  const [closing, setClosing] = useState(false);
  const coordinatorRef = useRef<SaveCoordinator | null>(coordinator);
  const viewStateRef = useRef<ViewStateRecorder | null>(viewState);
  const journalRef = useRef<DraftJournal | null>(journal);
  const closingRef = useRef(false);
  coordinatorRef.current = coordinator;
  viewStateRef.current = viewState;
  journalRef.current = journal;

  const confirmClose = useCallback(
    async (allow: boolean) => {
      if (allow) {
        // Flush the latest draft and scroll/selection before Rust destroys
        // the webview. A storage failure must not block the close.
        try {
          await journalRef.current?.flushNow();
        } catch (error) {
          console.warn("failed to flush the crash draft before closing", error);
        }
        try {
          await viewStateRef.current?.flushNow();
        } catch (error) {
          console.warn("failed to flush the view state before closing", error);
        }
      }
      await ipc.appCloseConfirm({ allow });
      setPrompt(null);
    },
    [ipc],
  );

  const saveAndClose = useCallback(
    async (reason: CloseReason) => {
      try {
        const coordinator = coordinatorRef.current;
        const result = coordinator
          ? await coordinator.flush("close")
          : ({ ok: true, state: "clean" } as const);

        if (result.ok) {
          await confirmClose(true);
          return;
        }
        // Preserve a crash draft for the conflict/error prompt: the user may
        // still choose to close without resolving it.
        try {
          await journalRef.current?.flushNow();
        } catch (error) {
          console.warn("failed to flush the crash draft before prompting", error);
        }
        setPrompt({ reason, kind: result.failure ?? "error" });
      } catch (error) {
        console.error("close confirmation failed", error);
        setPrompt({ reason, kind: "error" });
      }
    },
    [confirmClose],
  );

  const requestClose = useCallback(
    async (reason: CloseReason) => {
      if (closingRef.current) {
        return;
      }
      closingRef.current = true;
      setClosing(true);
      try {
        const coordinator = coordinatorRef.current;
        const snapshot = coordinator?.getSnapshot();
        const unsavedUntitled =
          coordinator?.isUntitled === true &&
          snapshot !== undefined &&
          snapshot.state !== "clean" &&
          snapshot.state !== "readonly";

        // Untitled text has no path to autosave to, so exit only asks whether
        // to discard it. Saving stays an explicit user action.
        if (unsavedUntitled) {
          try {
            await journalRef.current?.flushNow();
          } catch (error) {
            console.warn("failed to flush the crash draft before prompting", error);
          }
          setPrompt({ reason, kind: "unsaved" });
          return;
        }

        await saveAndClose(reason);
      } finally {
        closingRef.current = false;
        setClosing(false);
      }
    },
    [saveAndClose],
  );

  useEffect(() => {
    return platform.onCloseRequested((reason) => {
      void requestClose(reason);
    });
  }, [platform, requestClose]);

  useEffect(() => {
    let deferred = false;

    const flushOnCompositionEnd = () => {
      if (!deferred) {
        return;
      }
      deferred = false;
      void coordinatorRef.current?.flush("blur");
    };

    const unsubscribe = platform.onBlur(() => {
      if (platform.isComposing()) {
        deferred = true;
        return;
      }
      void coordinatorRef.current?.flush("blur");
    });

    window.addEventListener("compositionend", flushOnCompositionEnd, true);
    return () => {
      unsubscribe();
      window.removeEventListener("compositionend", flushOnCompositionEnd, true);
    };
  }, [platform]);

  const allowClose = useCallback(async () => {
    try {
      if (prompt?.kind === "unsaved") {
        await journalRef.current?.discardNow();
      }
      await confirmClose(true);
    } catch (error) {
      console.error("close was not authorized", error);
    }
  }, [confirmClose, prompt?.kind]);

  const cancelClose = useCallback(async () => {
    try {
      await confirmClose(false);
    } catch (error) {
      console.error("close cancellation failed", error);
      setPrompt(null);
    }
  }, [confirmClose]);

  return { prompt, closing, allowClose, cancelClose };
}
