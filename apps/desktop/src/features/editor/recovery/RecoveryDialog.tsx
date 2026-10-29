import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppError, DraftMeta, Result } from "@qingmo/shared";
import { Button } from "@qingmo/ui";

/** Explicit restore/discard entry for crash drafts; never writes a path. */
export function RecoveryDialog({
  drafts,
  open,
  canRestore,
  onClose,
  onRestore,
  onDiscard,
}: {
  drafts: DraftMeta[];
  open: boolean;
  /** False while the current document has content or unsaved changes. */
  canRestore: boolean;
  onClose(): void;
  onRestore(id: string): Promise<Result<void, AppError>>;
  onDiscard(id: string): Promise<Result<void, AppError>>;
}) {
  const { t, i18n } = useTranslation(["editor"]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [i18n.language],
  );

  if (!open) {
    return null;
  }

  const run = async (id: string, action: () => Promise<Result<void, AppError>>) => {
    setBusyId(id);
    setError(null);
    const result = await action();
    if (!result.ok) {
      setError(
        t("editor:recovery.actionFailed", {
          code: result.error.code,
        }),
      );
    }
    setBusyId(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-6 backdrop-blur-[2px]"
      data-testid="recovery-overlay"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-card border border-line bg-surface p-6 shadow-card"
      >
        <p className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          {t("editor:recovery.kicker")}
        </p>
        <h2 id="recovery-title" className="mt-2 font-serif text-2xl tracking-[-0.02em]">
          {t("editor:recovery.title")}
        </h2>
        <p className="mt-3 text-sm leading-7 text-ink-muted">{t("editor:recovery.description")}</p>

        {!canRestore ? (
          <p
            data-testid="recovery-blocked"
            className="mt-3 rounded-lg border border-warning/40 bg-warning/[0.08] px-3 py-2 text-xs text-ink"
          >
            {t("editor:recovery.restoreBlocked")}
          </p>
        ) : null}

        <ul
          className="mt-4 min-h-0 flex-1 space-y-2 overflow-auto pr-1"
          data-testid="recovery-list"
        >
          {drafts.length === 0 ? (
            <li className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-muted">
              {t("editor:recovery.empty")}
            </li>
          ) : null}
          {drafts.map((draft) => (
            <li
              key={draft.id}
              data-testid={`recovery-item-${draft.id}`}
              className="flex items-start gap-3 rounded-lg border border-line px-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{draft.title}</p>
                <p className="mt-1 truncate text-[11px] text-ink-faint">
                  {draft.path ?? t("editor:recovery.untitled")}
                  {" · "}
                  {t("editor:recovery.updatedAt", {
                    time: formatter.format(new Date(draft.updatedAtMs)),
                  })}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  data-testid={`recovery-discard-${draft.id}`}
                  disabled={busyId !== null}
                  onClick={() => {
                    void run(draft.id, () => onDiscard(draft.id));
                  }}
                >
                  {t("editor:recovery.discard")}
                </Button>
                <Button
                  data-testid={`recovery-restore-${draft.id}`}
                  disabled={busyId !== null || !canRestore}
                  onClick={() => {
                    void run(draft.id, () => onRestore(draft.id));
                  }}
                >
                  {busyId === draft.id
                    ? t("editor:recovery.restoring")
                    : t("editor:recovery.restore")}
                </Button>
              </div>
            </li>
          ))}
        </ul>

        {error ? (
          <p data-testid="recovery-error" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end">
          <Button variant="ghost" data-testid="recovery-close" onClick={onClose}>
            {t("editor:recovery.close")}
          </Button>
        </div>
      </section>
    </div>
  );
}
