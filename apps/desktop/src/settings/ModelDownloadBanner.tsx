import { useTranslation } from "react-i18next";

export interface ModelDownloadBannerProps {
  kind: "asr" | "llm";
  missingCount: number;
  totalBytes: number;
  freeBytes: number;
  requiredBytes: number;
  busy: boolean;
  firstUse: boolean;
  onDownload(): void;
  secondaryLabel?: string;
  secondaryDisabled?: boolean;
  onSecondary?(): void;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
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
  return (
    <section className="meeting-banner" data-testid={`download-banner-${kind}`} aria-live="polite">
      <div className="meeting-banner-copy">
        <p className="meeting-banner-kicker">
          {firstUse ? t("ai.banner.firstUse") : t("ai.banner.continue")}
        </p>
        <p>
          {kind === "asr"
            ? t("ai.banner.asrBody", { size: formatMb(totalBytes) })
            : t("ai.banner.llmBody", { size: formatMb(totalBytes) })}
        </p>
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
        {onSecondary && secondaryLabel ? (
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
