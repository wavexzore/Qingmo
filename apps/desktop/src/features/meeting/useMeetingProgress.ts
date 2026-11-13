import { useCallback, useEffect, useRef, useState } from "react";

import type { AppError, MeetingOutcome, MeetingProgress, MeetingResult } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import { useToast } from "../../components/ToastHost";
import i18n from "../../i18n";
import { normalizeError } from "../../lib/ipc/errors";
import { useDocumentSession } from "../editor/DocumentSessionContext";
import { takeMeetingResult } from "./meetingResult";

const POLL_INTERVAL_MS = 2000;

/** Codes that can succeed without reopening the file picker. */
const RETRYABLE = new Set(["MODEL_NOT_READY", "ASR_UNAVAILABLE", "ASR_FAILED"]);

export type MeetingPhase =
  | "loading"
  | "running"
  | "inserting"
  | "inserted"
  | "insert_failed"
  | "failed"
  | "cancelled"
  | "gone";

export interface UseMeetingProgress {
  phase: MeetingPhase;
  progress: MeetingProgress | null;
  error: AppError | null;
  /** Current attempt; stale events are ignored by this value. */
  attempt: number;
  /** Latest known asset URL, including after the result arrived. */
  audioUrl: string;
  /** True when the taken result is partial. */
  partial: boolean;
  canRetry: boolean;
  retry(): Promise<void>;
  cancel(): Promise<void>;
  retryInsert(): void;
}

export function useMeetingProgress(requestId: string): UseMeetingProgress {
  const { ipc } = useAppServices();
  const { session, journal } = useDocumentSession();
  const toast = useToast();
  const [phase, setPhase] = useState<MeetingPhase>("loading");
  const [progress, setProgress] = useState<MeetingProgress | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [run, setRun] = useState(0);
  const attempt = useRef(1);
  const result = useRef<MeetingResult | null>(null);
  const settingsOpened = useRef(false);

  const insert = useCallback(
    (next: MeetingResult) => {
      if (!session) {
        return;
      }
      setPhase("inserting");
      try {
        session.insertDocumentText(next.markdown);
        journal?.evaluate();
        setPhase("inserted");
      } catch (cause) {
        console.error("failed to insert the meeting result", normalizeError(cause));
        setPhase("insert_failed");
      }
    },
    [journal, session],
  );

  const handleOutcome = useCallback(
    (outcome: MeetingOutcome) => {
      if (outcome === "gone") {
        setPhase("gone");
        return;
      }
      if ("running" in outcome) {
        if (outcome.running.attempt !== attempt.current) {
          return;
        }
        setProgress(outcome.running);
        setPhase("running");
        return;
      }
      if ("ready" in outcome) {
        result.current = outcome.ready;
        setProgress((previous) =>
          previous
            ? {
                ...previous,
                stage: outcome.ready.partial ? "partial_done" : "done",
                audioUrl: outcome.ready.audioUrl || previous.audioUrl,
              }
            : previous,
        );
        void takeMeetingResult(ipc, requestId)
          .then((taken) => {
            const next = taken ?? outcome.ready;
            result.current = next;
            insert(next);
          })
          .catch((cause: unknown) => {
            // The status snapshot already carries the document, so a failed
            // take must not leave the window stuck before insertion.
            console.warn("failed to take the meeting result", normalizeError(cause));
            result.current = outcome.ready;
            insert(outcome.ready);
          });
        return;
      }
      if (outcome.failed.attempt !== attempt.current) {
        return;
      }
      setError(outcome.failed.error);
      setPhase(outcome.failed.error.code === "CANCELLED" ? "cancelled" : "failed");
      if (outcome.failed.error.code === "MODEL_NOT_READY" && !settingsOpened.current) {
        settingsOpened.current = true;
        toast.push(i18n.t("meeting:modelToast"));
        void ipc.appSettingsOpen("ai").catch((cause: unknown) => {
          console.warn("failed to open the settings window", normalizeError(cause));
        });
      }
    },
    [insert, ipc, requestId, toast],
  );

  useEffect(() => {
    if (!requestId) {
      return;
    }
    let disposed = false;
    let timer: number | undefined;

    const settle = async () => {
      try {
        const outcome = await ipc.meetingStatus(requestId);
        if (!disposed) {
          handleOutcome(outcome);
        }
      } catch (cause) {
        if (!disposed) {
          setError(normalizeError(cause));
          setPhase("failed");
        }
      }
    };

    const poll = () => {
      timer = window.setTimeout(async () => {
        if (disposed) {
          return;
        }
        try {
          const outcome = await ipc.meetingStatus(requestId);
          if (disposed) {
            return;
          }
          handleOutcome(outcome);
          if (!terminal(outcome)) {
            poll();
          }
        } catch (cause) {
          if (!disposed) {
            setError(normalizeError(cause));
            setPhase("failed");
          }
        }
      }, POLL_INTERVAL_MS);
    };

    const unsubscribe = ipc.onMeetingProgress((next) => {
      if (disposed || next.requestId !== requestId || next.attempt !== attempt.current) {
        return;
      }
      setProgress(next);
      if (next.stage !== "failed" && next.stage !== "cancelled") {
        if (next.stage !== "done" && next.stage !== "partial_done") {
          setPhase("running");
        }
        return;
      }
      void settle();
    });

    // Subscribe first, then backfill through status so no terminal is missed.
    void (async () => {
      try {
        const outcome = await ipc.meetingStatus(requestId);
        if (disposed) {
          return;
        }
        if (outcome !== "gone" && "running" in outcome) {
          attempt.current = outcome.running.attempt;
        }
        if (outcome !== "gone" && "failed" in outcome) {
          attempt.current = outcome.failed.attempt;
        }
        handleOutcome(outcome);
        if (!terminal(outcome)) {
          poll();
        }
      } catch (cause) {
        if (!disposed) {
          setError(normalizeError(cause));
          setPhase("failed");
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [handleOutcome, ipc, requestId, run]);

  const retry = useCallback(async () => {
    try {
      const response = await ipc.meetingRetry(requestId);
      attempt.current = response.attempt;
      settingsOpened.current = false;
      setError(null);
      setProgress(null);
      setPhase("loading");
      setRun((value) => value + 1);
    } catch (cause) {
      setError(normalizeError(cause));
      setPhase("failed");
    }
  }, [ipc, requestId]);

  const cancel = useCallback(async () => {
    try {
      await ipc.meetingCancel(requestId);
    } catch (cause) {
      console.warn("failed to cancel the meeting", normalizeError(cause));
    }
  }, [ipc, requestId]);

  const retryInsert = useCallback(() => {
    if (result.current) {
      insert(result.current);
    }
  }, [insert]);

  return {
    phase,
    progress,
    error,
    attempt: attempt.current,
    audioUrl: progress?.audioUrl || result.current?.audioUrl || "",
    partial: result.current?.partial === true,
    canRetry: error !== null && RETRYABLE.has(error.code),
    retry,
    cancel,
    retryInsert,
  };
}

function terminal(outcome: MeetingOutcome): boolean {
  return outcome === "gone" || !("running" in outcome);
}
