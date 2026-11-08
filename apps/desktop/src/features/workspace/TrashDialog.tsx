import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TrashEntry } from "@qingmo/shared";

import type { IpcPort } from "../../lib/ipc/port";

interface TrashDialogProps {
  open: boolean;
  workspaceToken: string;
  ipc: Pick<IpcPort, "workspaceTrashList" | "workspaceTrashRestore" | "workspaceTrashPurge">;
  onClose(): void;
  onChanged(): void;
}

export function TrashDialog({ open, workspaceToken, ipc, onClose, onChanged }: TrashDialogProps) {
  const { t } = useTranslation(["trash"]);
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEntries(await ipc.workspaceTrashList(workspaceToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [ipc, workspaceToken]);

  useEffect(() => {
    if (open) void load();
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

  const restore = async (entry: TrashEntry, mode: "original" | "copy"): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.workspaceTrashRestore(workspaceToken, entry.id, mode);
      onChanged();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const purge = async (entry: TrashEntry): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ipc.workspaceTrashPurge(workspaceToken, entry.id);
      await load();
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
      aria-label={t("trash:title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-[70vh] w-full max-w-2xl flex-col rounded-lg border border-line bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t("trash:title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("trash:close")}
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
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {busy && entries.length === 0 ? (
            <li className="px-2 py-2 text-sm text-ink-muted">{t("trash:loading")}</li>
          ) : entries.length === 0 ? (
            <li className="px-2 py-2 text-sm text-ink-muted">{t("trash:empty")}</li>
          ) : (
            entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 border-b border-line px-2 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{entry.relativePath}</p>
                  <p className="text-[10px] text-ink-faint">
                    {new Date(entry.deletedAtMs).toLocaleString()} · {entry.sizeBytes} B
                    {entry.state === "orphaned" ? ` · ${t("trash:orphaned")}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(entry, "original")}
                  className="rounded border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-40"
                >
                  {t("trash:restore")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(entry, "copy")}
                  className="rounded border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-40"
                >
                  {t("trash:restoreCopy")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void purge(entry)}
                  className="rounded border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
                >
                  {t("trash:purge")}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
