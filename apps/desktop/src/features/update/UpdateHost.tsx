import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppError } from "@qingmo/shared";

import { Button } from "@qingmo/ui";

import { useToast } from "../../components/ToastHost";
import { normalizeError } from "../../lib/ipc/errors";
import { UpdateDialog } from "./UpdateDialog";
import { useUpdateCommand } from "./updateCommand";
import { useUpdate } from "./useUpdate";

export interface UpdateHostProps {
  /** A close confirmation or in-flight close flush owns the UI. */
  blocked: boolean;
  dialogOpen: boolean;
  onDialogOpenChange(open: boolean): void;
}

function formatPercent(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}

/**
 * The only update surface mounted by the workspace: a non-modal banner plus
 * the details dialog. It registers `app.checkForUpdates` and never invokes
 * Tauri directly.
 */
export function UpdateHost({ blocked, dialogOpen, onDialogOpenChange }: UpdateHostProps) {
  const { t } = useTranslation(["update", "errors"]);
  const toast = useToast();
  const { controller, snapshot } = useUpdate();
  const [dismissedGeneration, setDismissedGeneration] = useState<number | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);

  const openDialog = useCallback(() => onDialogOpenChange(true), [onDialogOpenChange]);
  useUpdateCommand({ blocked, onOpenDialog: openDialog });

  useEffect(() => {
    if (blocked) {
      onDialogOpenChange(false);
    }
  }, [blocked, onDialogOpenChange]);

  useEffect(() => {
    if (!dialogOpen) {
      setActionError(null);
    }
  }, [dialogOpen]);

  const reportError = useCallback(
    (error: unknown) => {
      const normalized = normalizeError(error);
      setActionError(normalized);
      toast.push(t(`errors:${normalized.code}`));
    },
    [t, toast],
  );

  const download = useCallback(() => {
    setActionError(null);
    void controller.download().catch(reportError);
  }, [controller, reportError]);

  const install = useCallback(() => {
    setActionError(null);
    void controller.install().catch(reportError);
  }, [controller, reportError]);

  const dismissBanner = useCallback(() => {
    setDismissedGeneration(snapshot?.generation ?? null);
  }, [snapshot?.generation]);

  const phase = snapshot?.phase ?? "idle";
  const visible =
    !blocked &&
    snapshot !== null &&
    snapshot.generation !== dismissedGeneration &&
    (phase === "available" ||
      phase === "downloading" ||
      phase === "ready" ||
      phase === "installing");
  const percent = snapshot?.progress
    ? formatPercent(snapshot.progress.downloaded, snapshot.progress.total)
    : null;

  return (
    <>
      {visible ? (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-4">
          <section
            role="status"
            data-testid="update-banner"
            className="pointer-events-auto flex w-full max-w-[560px] items-center gap-4 rounded-card border border-line bg-surface-raised px-4 py-3 shadow-float"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                {t("update:banner.kicker")}
              </p>
              <p className="mt-0.5 truncate text-sm text-ink">
                {phase === "available" && snapshot.update
                  ? t("update:banner.available", { version: snapshot.update.version })
                  : t(`update:banner.${phase}`)}
              </p>
              {phase === "downloading" ? (
                <div className="mt-2" data-testid="update-banner-progress">
                  <div
                    role="progressbar"
                    aria-label={t("update:banner.downloading")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    className="h-1 overflow-hidden rounded-full bg-line"
                  >
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-200"
                      style={{ width: `${percent ?? 0}%` }}
                    />
                  </div>
                  {percent !== null ? (
                    <p className="mt-1 text-[11px] text-ink-faint">
                      {t("update:banner.progress", { percent })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {phase === "available" ? (
                <Button
                  data-testid="update-banner-view"
                  className="h-8 px-3 text-xs"
                  onClick={openDialog}
                >
                  {t("update:banner.view")}
                </Button>
              ) : null}
              {phase === "ready" ? (
                <>
                  <Button
                    variant="ghost"
                    className="h-8 px-3 text-xs"
                    data-testid="update-banner-later"
                    onClick={dismissBanner}
                  >
                    {t("update:banner.later")}
                  </Button>
                  <Button
                    className="h-8 px-3 text-xs"
                    data-testid="update-banner-install"
                    onClick={install}
                  >
                    {t("update:banner.install")}
                  </Button>
                </>
              ) : null}
              {phase === "installing" ? (
                <span className="text-xs text-ink-faint">{t("update:banner.keepOpen")}</span>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <UpdateDialog
        open={dialogOpen && !blocked}
        snapshot={snapshot}
        blocked={blocked}
        error={actionError}
        onClose={() => {
          setActionError(null);
          onDialogOpenChange(false);
        }}
        onDownload={download}
        onInstall={install}
      />
    </>
  );
}
