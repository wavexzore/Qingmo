import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConflictDetails } from "@qingmo/shared";
import { Button } from "@qingmo/ui";

export interface ConflictBannerProps {
  conflict: ConflictDetails;
  errorCode?: string | null;
  onReload(): Promise<unknown> | void;
  onOverwrite(): Promise<unknown> | void;
  onDismiss(): void;
}

type PendingAction = "reload" | "overwrite";

/**
 * Conflict resolution UI. Both destructive actions require a second explicit
 * confirmation; a single click can never discard edits or external changes.
 */
export function ConflictBanner({
  conflict,
  errorCode,
  onReload,
  onOverwrite,
  onDismiss,
}: ConflictBannerProps) {
  const { t } = useTranslation(["editor"]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!pending || busy) {
      return;
    }
    setBusy(true);
    try {
      await (pending === "reload" ? onReload() : onOverwrite());
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmation =
    pending === "reload"
      ? {
          title: t("editor:conflict.confirmReloadTitle"),
          description: t("editor:conflict.confirmReloadDescription"),
          progress: t("editor:conflict.reloading"),
        }
      : {
          title: t("editor:conflict.confirmOverwriteTitle"),
          description: t("editor:conflict.confirmOverwriteDescription"),
          progress: t("editor:conflict.overwriting"),
        };

  return (
    <section
      role="alert"
      data-testid="conflict-banner"
      className="flex flex-wrap items-start gap-3 border-b border-danger/30 bg-danger/[0.08] px-5 py-3 text-sm"
    >
      <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-danger" />

      <div className="min-w-[220px] flex-1">
        <p className="font-medium text-ink">{t("editor:conflict.title")}</p>
        <p className="mt-0.5 text-xs leading-5 text-ink-muted">
          {t("editor:conflict.description")}
        </p>
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          {conflict.currentHash.slice(0, 12)} · {conflict.currentSize} B
        </p>
        {errorCode ? (
          <p className="mt-1 text-xs text-danger">
            {t("editor:conflict.failed")} ({errorCode})
          </p>
        ) : null}
      </div>

      {pending ? (
        <div className="flex min-w-[260px] flex-col gap-2" data-testid="conflict-confirm">
          <div>
            <p className="text-xs font-medium text-ink">{confirmation.title}</p>
            <p className="mt-0.5 text-[11px] leading-5 text-ink-muted">
              {confirmation.description}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-8 px-3 text-xs"
              disabled={busy}
              onClick={() => {
                void confirm();
              }}
            >
              {busy ? confirmation.progress : t("editor:conflict.confirm")}
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-3 text-xs"
              disabled={busy}
              onClick={() => {
                setPending(null);
              }}
            >
              {t("editor:conflict.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs"
            data-testid="conflict-reload"
            onClick={() => {
              setPending("reload");
            }}
          >
            {t("editor:conflict.reload")}
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs"
            data-testid="conflict-overwrite"
            onClick={() => {
              setPending("overwrite");
            }}
          >
            {t("editor:conflict.overwrite")}
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs"
            data-testid="conflict-later"
            onClick={onDismiss}
          >
            {t("editor:conflict.later")}
          </Button>
        </div>
      )}
    </section>
  );
}
