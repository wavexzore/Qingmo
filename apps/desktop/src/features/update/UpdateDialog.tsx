import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { UpdateSnapshot } from "@qingmo/shared";
import { Button } from "@qingmo/ui";

export interface UpdateDialogProps {
  open: boolean;
  snapshot: UpdateSnapshot | null;
  /** A close confirmation or document flush owns the UI; hide update actions. */
  blocked: boolean;
  /** Last user-initiated failure; the primary action remains the retry. */
  error: { code: string } | null;
  onClose(): void;
  onDownload(): void;
  onInstall(): void;
}

function formatDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString();
}

function formatPercent(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}

/**
 * Modal details view. It is intentionally presentational: every transition
 * still comes from the Rust snapshot through `UpdateController`.
 */
export function UpdateDialog({
  open,
  snapshot,
  blocked,
  error,
  onClose,
  onDownload,
  onInstall,
}: UpdateDialogProps) {
  const { t } = useTranslation(["update", "errors"]);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = previousFocus.current;
      if (target && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  const installing = snapshot?.phase === "installing";
  const disabled = blocked || installing;

  useEffect(() => {
    if (!open || disabled) {
      return;
    }
    const listener: EventListener = (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [disabled, onClose, open]);

  if (!open) {
    return null;
  }

  const phase = snapshot?.phase ?? "idle";
  const update = snapshot?.update;
  const date = formatDate(update?.date ?? null);
  const progress = snapshot?.progress ?? null;
  const percent = progress ? formatPercent(progress.downloaded, progress.total) : null;
  const canDownload = phase === "available" && !disabled;
  const canInstall = phase === "ready" && !disabled;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-6 backdrop-blur-[2px]"
      data-testid="update-dialog-overlay"
      onMouseDown={disabled ? undefined : onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        aria-describedby="update-dialog-description"
        className="flex max-h-[min(640px,calc(100dvh-48px))] w-full max-w-[520px] flex-col rounded-card border border-line bg-surface p-6 shadow-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          {t("update:dialog.kicker")}
        </p>
        <h2 id="update-dialog-title" className="mt-2 font-serif text-2xl tracking-[-0.02em]">
          {t("update:dialog.title")}
        </h2>
        <p id="update-dialog-description" className="mt-2 text-sm leading-7 text-ink-muted">
          {t(`update:dialog.phase.${phase}`)}
        </p>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-faint">{t("update:dialog.currentVersion")}</dt>
          <dd className="text-ink">v{snapshot?.currentVersion ?? "—"}</dd>
          <dt className="text-ink-faint">{t("update:dialog.latestVersion")}</dt>
          <dd className="text-ink">{update ? `v${update.version}` : "—"}</dd>
          {date ? (
            <>
              <dt className="text-ink-faint">{t("update:dialog.released")}</dt>
              <dd className="text-ink">{date}</dd>
            </>
          ) : null}
        </dl>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            {t("update:dialog.notes")}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-ink-muted">
            {update?.body?.trim() ? update.body : t("update:dialog.noNotes")}
          </p>
        </div>

        {phase === "downloading" ? (
          <div className="mt-4" data-testid="update-dialog-progress">
            <div
              role="progressbar"
              aria-label={t("update:dialog.downloading")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              className="h-1.5 overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              {percent === null
                ? t("update:dialog.downloading")
                : t("update:dialog.progress", { percent })}
            </p>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            data-testid="update-error"
            className="mt-4 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
          >
            {t(`errors:${error.code}`)}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="update-later"
            disabled={installing}
            autoFocus
            onClick={onClose}
          >
            {t("update:dialog.later")}
          </Button>
          {canDownload ? (
            <Button data-testid="update-download" onClick={onDownload}>
              {t("update:dialog.download")}
            </Button>
          ) : null}
          {canInstall ? (
            <Button data-testid="update-install" onClick={onInstall}>
              {t("update:dialog.install")}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
