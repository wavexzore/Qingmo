import { useState } from "react";
import { useTranslation } from "react-i18next";

import { downloadableMembers, removableMembers, rowLabelKey, type ModelRow } from "./modelGroups";

export interface ModelProgressState {
  doneBytes: number;
  totalBytes: number;
}

export interface ModelListProps {
  rows: ModelRow[];
  progress: Record<string, ModelProgressState>;
  onDownload(row: ModelRow): void;
  onCancel(row: ModelRow): void;
  onRemove(row: ModelRow): void;
  onLicense(href: string): void;
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function percent(progress: ModelProgressState | undefined): number {
  if (!progress || progress.totalBytes <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((progress.doneBytes / progress.totalBytes) * 100));
}

/** Local model rows, including the merged speaker-pack row. */
export function ModelList({
  rows,
  progress,
  onDownload,
  onCancel,
  onRemove,
  onLicense,
}: ModelListProps) {
  const { t } = useTranslation("settings");
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <ul className="meeting-models" aria-label={t("ai.models.aria")}>
      {rows.map((row) => {
        const canDownload = downloadableMembers(row).length > 0;
        const canRemove = removableMembers(row).length > 0;
        const downloading = row.state === "downloading";
        const busy = downloading || row.state === "verifying";
        const rowProgress = progress[row.key];
        const readyMembers = row.members.filter((member) => member.state === "ready").length;
        const label =
          row.state === "partial" && row.group
            ? t("ai.models.partialReady", { ready: readyMembers, total: row.members.length })
            : t(rowLabelKey(row.state));
        return (
          <li className="meeting-model" data-testid={`model-row-${row.key}`} key={row.key}>
            <div className="meeting-model-main">
              <div className="meeting-model-copy">
                <p className="meeting-model-name">
                  {row.display}
                  {row.members.some((member) => member.id === "fireredasr2-ctc-int8") ? (
                    <span className="meeting-tag">{t("ai.models.highMemory")}</span>
                  ) : null}
                  {row.members.some((member) => member.id === "qwen3-8b-instruct-q4km") ? (
                    <span className="meeting-tag">{t("ai.models.needs32")}</span>
                  ) : null}
                </p>
                <p className="meeting-model-meta">
                  <span>{formatMb(row.bytes)}</span>
                  <span>{t("ai.models.peak", { mb: row.peakMemoryMb })}</span>
                  <button
                    className="meeting-link"
                    type="button"
                    onClick={() => onLicense(row.members[0]?.licenseUrl ?? "")}
                  >
                    {t("ai.models.license", { license: row.members[0]?.license ?? "" })}
                  </button>
                  {row.members.some((member) => member.languages.length > 0) ? (
                    <span>
                      {t("ai.models.languages", {
                        languages: [
                          ...new Set(row.members.flatMap((member) => member.languages)),
                        ].join(" / "),
                      })}
                    </span>
                  ) : null}
                </p>
                {row.error ? (
                  <p className="meeting-model-error" role="status">
                    {t("ai.models.lastError", { message: row.error.message })}
                  </p>
                ) : null}
              </div>
              <div className="meeting-model-state">
                <span
                  className={`meeting-state is-${row.state}`}
                  data-testid={`model-state-${row.key}`}
                >
                  {label}
                </span>
                {downloading ? (
                  <span className="meeting-model-progress" aria-hidden="true">
                    <span style={{ width: `${percent(rowProgress)}%` }} />
                  </span>
                ) : null}
                <div className="meeting-model-actions">
                  {downloading ? (
                    <button
                      className="meeting-button is-quiet"
                      type="button"
                      data-testid={`model-cancel-${row.key}`}
                      onClick={() => onCancel(row)}
                    >
                      {t("ai.models.cancel")}
                    </button>
                  ) : (
                    <button
                      className="meeting-button is-quiet"
                      type="button"
                      data-testid={`model-download-${row.key}`}
                      disabled={!canDownload || busy}
                      onClick={() => onDownload(row)}
                    >
                      {row.state === "failed" || row.state === "corrupt"
                        ? t("ai.models.retry")
                        : row.state === "partial"
                          ? t("ai.models.resume")
                          : t("ai.models.download")}
                    </button>
                  )}
                  {canRemove ? (
                    <button
                      className="meeting-button is-quiet"
                      type="button"
                      data-testid={`model-remove-${row.key}`}
                      disabled={busy}
                      onClick={() => setConfirming(row.key)}
                    >
                      {t("ai.models.remove")}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            {confirming === row.key ? (
              <div
                className="meeting-model-confirm"
                role="group"
                aria-label={t("ai.models.confirmAria")}
              >
                <p>{t("ai.models.confirmBody", { name: row.display })}</p>
                <div className="meeting-model-actions">
                  <button
                    className="meeting-button is-quiet"
                    type="button"
                    onClick={() => setConfirming(null)}
                  >
                    {t("ai.models.confirmCancel")}
                  </button>
                  <button
                    className="meeting-button is-danger"
                    type="button"
                    data-testid={`model-confirm-${row.key}`}
                    onClick={() => {
                      setConfirming(null);
                      onRemove(row);
                    }}
                  >
                    {t("ai.models.confirmRemove")}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
