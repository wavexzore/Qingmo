import { useTranslation } from "react-i18next";

import { formatMb } from "./modelGroups";

export interface BannerActiveDownload {
  label: string;
  doneBytes: number;
  totalBytes: number;
  verifying: boolean;
}

export interface ModelDownloadBannerProps {
  kind: "asr" | "llm";
  missingCount: number;
  totalBytes: number;
  freeBytes: number;
  requiredBytes: number;
  busy: boolean;
  firstUse: boolean;
  active?: BannerActiveDownload | null;
  onCancel?(): void;
  onDownload(): void;
  secondaryLabel?: string;
  secondaryDisabled?: boolean;
  onSecondary?(): void;
}

/** First-use download strip; the primary action always reflects the gap set. */
export function ModelDownloadBanner({
  kind,
  missingCount,
  totalBytes,
  freeBytes,
  requiredBytes,
  busy,
  firstUse,
  active,
  onCancel,
  onDownload,
  secondaryLabel,
  secondaryDisabled,
  onSecondary,
}: ModelDownloadBannerProps) {
  const { t } = useTranslation("settings");
  if (missingCount === 0) {
    return null;
  }
  const diskFull = freeBytes < requiredBytes;
  const percent =
    active && active.totalBytes > 0
      ? Math.min(100, Math.round((active.doneBytes / active.totalBytes) * 100))
      : 0;
  return (
    <section className="meeting-banner" data-testid={`download-banner-${kind}`} aria-live="polite">
      <div className="meeting-banner-copy">
        <p className="meeting-banner-kicker">
          {active
            ? active.verifying
              ? t("ai.banner.verifying")
              : t("ai.banner.downloading")
            : firstUse
              ? t("ai.banner.firstUse")
              : t("ai.banner.continue")}
        </p>
        {active ? (
          <>
            <p>{active.label}</p>
            <div className="meeting-banner-progress-line">
              <div
                className="meeting-banner-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ width: `${percent}%` }} />
              </div>
              <span>{active.verifying ? t("ai.banner.verifying") : `${percent}%`}</span>
            </div>
          </>
        ) : (
          <p>
            {kind === "asr"
              ? t("ai.banner.asrBody", { size: formatMb(totalBytes) })
              : t("ai.banner.llmBody", { size: formatMb(totalBytes) })}
          </p>
        )}
        {diskFull ? (
          <p className="meeting-banner-warn">
            {t("ai.banner.diskFull", {
              free: formatMb(freeBytes),
              required: formatMb(requiredBytes),
            })}
          </p>
        ) : null}
      </div>
      <div className="meeting-banner-actions">
        {active && onCancel ? (
          <button
            className="meeting-button is-quiet"
            type="button"
            data-testid={`download-cancel-${kind}`}
            onClick={onCancel}
          >
            {t("ai.banner.cancel")}
          </button>
        ) : (
          <button
            className="meeting-button is-primary"
            type="button"
            data-testid={`download-primary-${kind}`}
            disabled={busy || diskFull}
            onClick={onDownload}
          >
            {firstUse
              ? kind === "asr"
                ? t("ai.banner.asrPrimary", { size: formatMb(totalBytes) })
                : t("ai.banner.llmPrimary", { size: formatMb(totalBytes) })
              : t("ai.banner.continuePrimary", {
                  count: missingCount,
                  size: formatMb(totalBytes),
                })}
          </button>
        )}
        {!active && onSecondary && secondaryLabel ? (
          <button
            className="meeting-button is-quiet"
            type="button"
            data-testid={`download-secondary-${kind}`}
            disabled={busy || secondaryDisabled}
            onClick={onSecondary}
          >
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
