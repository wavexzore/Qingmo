import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HistoryEntry, HistoryRecord } from "@qingmo/shared";

import type { IpcPort } from "../../../lib/ipc/port";

interface HistoryDialogProps {
  open: boolean;
  docToken: string;
  ipc: Pick<IpcPort, "documentHistoryList" | "documentHistoryRead" | "documentHistoryRestore">;
  onClose(): void;
  onRestore(payload: Awaited<ReturnType<IpcPort["documentHistoryRestore"]>>): void;
}

function formatTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString();
}

export function HistoryDialog({ open, docToken, ipc, onClose, onRestore }: HistoryDialogProps) {
  const { t } = useTranslation(["history"]);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [preview, setPreview] = useState<HistoryRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEntries(await ipc.documentHistoryList(docToken, 50, 0));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [docToken, ipc]);

  useEffect(() => {
    if (open) {
      setPreview(null);
      void load();
    }
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose, open]);

  const read = async (entry: HistoryEntry): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await ipc.documentHistoryRead(docToken, entry.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await ipc.documentHistoryRestore(docToken, preview.id);
      onRestore(payload);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("history:title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-line bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t("history:title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("history:close")}
            className="rounded p-1 text-ink-muted hover:bg-surface-raised"
          >
            ×
          </button>
        </header>
        {error ? (
          <p role="alert" className="px-4 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,18rem)_1fr]">
          <ul className="min-h-0 overflow-y-auto border-r border-line p-2">
            {busy && entries.length === 0 ? (
              <li className="px-2 py-2 text-sm text-ink-muted">{t("history:loading")}</li>
            ) : entries.length === 0 ? (
              <li className="px-2 py-2 text-sm text-ink-muted">{t("history:empty")}</li>
            ) : (
              entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => void read(entry)}
                    aria-current={preview?.id === entry.id ? "true" : undefined}
                    className={`flex w-full flex-col rounded px-2 py-2 text-left text-xs hover:bg-surface-raised ${
                      preview?.id === entry.id ? "bg-surface-raised" : ""
                    }`}
                  >
                    <span className="text-ink">{formatTime(entry.createdAtMs)}</span>
                    <span className="text-ink-faint">
                      {entry.sizeBytes} B · {entry.hash.slice(0, 8)}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="flex min-h-0 flex-col">
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 text-xs text-ink">
              {preview?.text ?? t("history:previewHint")}
            </pre>
            <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-raised"
              >
                {t("history:cancel")}
              </button>
              <button
                type="button"
                disabled={!preview || busy}
                onClick={() => void restore()}
                className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
              >
                {t("history:restore")}
              </button>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
