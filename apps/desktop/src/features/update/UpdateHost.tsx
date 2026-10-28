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

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const iconProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  viewBox: "0 0 16 16",
} as const;

function DownloadIcon() {
  return (
    <svg {...iconProps} className="size-3.5">
      <path d="M8 2.5v7" />
      <path d="m5 6.5 3 3 3-3" />
      <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps} className="size-3.5">
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg {...iconProps} className="size-3.5 animate-spin">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5V5h-2.5" />
    </svg>
  );
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

  const version = snapshot?.update?.version;
  const downloadingHint = snapshot?.progress
    ? snapshot.progress.total
      ? `${formatMegabytes(snapshot.progress.downloaded)} / ${formatMegabytes(
          snapshot.progress.total,
        )}`
      : formatMegabytes(snapshot.progress.downloaded)
    : null;

  const title =
    phase === "available"
      ? t("update:banner.availableTitle", { version: version ?? "" })
      : phase === "downloading"
        ? t("update:banner.downloadingTitle", { version: version ?? "" })
        : phase === "ready"
          ? t("update:banner.readyTitle")
          : t("update:banner.installingTitle");

  const hint =
    phase === "available"
      ? t("update:banner.availableHint")
      : phase === "downloading"
        ? (downloadingHint ?? t("update:banner.downloadingPreparing"))
        : phase === "ready"
          ? t("update:banner.readyHint", { version: version ?? "" })
          : t("update:banner.installingHint");

  return (
    <>
      {visible ? (
        <section
          role="status"
          data-testid="update-banner"
          className="relative flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-gradient-to-r from-accent-soft to-transparent py-2.5 pr-4 pl-5"
        >
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-raised text-accent shadow-[0_0_0_1px_var(--color-line)]"
          >
            {phase === "ready" ? <CheckIcon /> : null}
            {phase === "installing" ? <RefreshIcon /> : null}
            {phase === "available" || phase === "downloading" ? <DownloadIcon /> : null}
          </span>

          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[13px] leading-5 font-semibold text-ink">
              <span className="truncate">{title}</span>
              {phase === "available" ? (
                <span className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-accent px-1.5 font-mono text-[9px] font-medium tracking-[0.08em] text-surface-raised">
                  {t("update:banner.badge")}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 truncate text-xs leading-5 text-ink-muted">{hint}</p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {phase === "available" ? (
              <>
                <Button
                  variant="ghost"
                  className="h-7 px-2.5 text-xs"
                  data-testid="update-banner-later"
                  onClick={dismissBanner}
                >
                  {t("update:banner.later")}
                </Button>
                <Button
                  className="h-7 px-3 text-xs"
                  data-testid="update-banner-view"
                  onClick={openDialog}
                >
                  {t("update:banner.view")}
                </Button>
              </>
            ) : null}
            {phase === "downloading" ? (
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-xs"
                data-testid="update-banner-view"
                onClick={openDialog}
              >
                {t("update:banner.view")}
              </Button>
            ) : null}
            {phase === "ready" ? (
              <>
                <Button
                  variant="ghost"
                  className="h-7 px-2.5 text-xs"
                  data-testid="update-banner-later"
                  onClick={dismissBanner}
                >
                  {t("update:banner.later")}
                </Button>
                <Button
                  className="h-7 px-3 text-xs"
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

          {phase === "downloading" ? (
            <div
              role="progressbar"
              aria-label={t("update:banner.downloadingTitle", { version: version ?? "" })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              data-testid="update-banner-progress"
              className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden bg-accent/10"
            >
              <div
                className={
                  percent === null
                    ? "h-full w-1/3 animate-pulse bg-accent"
                    : "h-full bg-accent transition-[width] duration-200"
                }
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
          ) : null}
        </section>
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
