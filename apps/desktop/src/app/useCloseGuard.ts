import { useCallback, useEffect, useRef, useState } from "react";

import type { CloseReason } from "@qingmo/shared";

import type { IpcPort } from "../lib/ipc/port";
import type { PlatformPort } from "../lib/platform/port";
import type { SaveCoordinator } from "../features/editor/save/SaveCoordinator";

export interface ClosePrompt {
  reason: CloseReason;
  failure: "conflict" | "error";
}

export interface CloseGuardState {
  prompt: ClosePrompt | null;
  allowClose(): Promise<void>;
  cancelClose(): Promise<void>;
}

export interface UseCloseGuardOptions {
  ipc: Pick<IpcPort, "appCloseConfirm">;
  platform: PlatformPort;
  coordinator: SaveCoordinator | null;
}

/**
 * Bridges the Rust CloseGuard event to SaveCoordinator.
 *
 * - A successful flush confirms the close immediately.
 * - Conflict/terminal error opens an explicit "close anyway?" prompt.
 * - Blur flushes the coordinator unless an IME composition is active; a
 *   compositionend then performs the deferred flush.
 */
export function useCloseGuard({
  ipc,
  platform,
  coordinator,
}: UseCloseGuardOptions): CloseGuardState {
  const [prompt, setPrompt] = useState<ClosePrompt | null>(null);
  const coordinatorRef = useRef<SaveCoordinator | null>(coordinator);
  const closingRef = useRef(false);
  coordinatorRef.current = coordinator;

  const confirmClose = useCallback(
    async (allow: boolean) => {
      await ipc.appCloseConfirm({ allow });
      setPrompt(null);
    },
    [ipc],
  );

  const requestClose = useCallback(
    async (reason: CloseReason) => {
      if (closingRef.current) {
        return;
      }
      closingRef.current = true;
      try {
        const coordinator = coordinatorRef.current;
        const result = coordinator
          ? await coordinator.flush("close")
          : ({ ok: true, state: "clean" } as const);

        if (result.ok) {
          await confirmClose(true);
          return;
        }
        setPrompt({ reason, failure: result.failure ?? "error" });
      } catch (error) {
        console.error("close confirmation failed", error);
        setPrompt({ reason, failure: "error" });
      } finally {
        closingRef.current = false;
      }
    },
    [confirmClose],
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
      await confirmClose(true);
    } catch (error) {
      console.error("close was not authorized", error);
    }
  }, [confirmClose]);

  const cancelClose = useCallback(async () => {
    try {
      await confirmClose(false);
    } catch (error) {
      console.error("close cancellation failed", error);
      setPrompt(null);
    }
  }, [confirmClose]);

  return { prompt, allowClose, cancelClose };
}
