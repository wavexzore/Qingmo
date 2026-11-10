import { useTranslation } from "react-i18next";

import type { MeetingProgress } from "@qingmo/shared";

import { cx } from "@qingmo/ui";

import { useAppServices } from "../../app/AppServices";
import { useToast } from "../../components/ToastHost";
import { normalizeError } from "../../lib/ipc/errors";
import type { UseMeetingProgress } from "./useMeetingProgress";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stageLabel(t: (key: string) => string, progress: MeetingProgress | null): string {
  if (!progress) {
    return t("meeting:stage.preparing");
  }
  switch (progress.stage) {
    case "transcribing":
      return t("meeting:stage.transcribing");
    case "releasing":
      return t("meeting:stage.releasing");
    case "partial":
      return t("meeting:stage.partial");
    case "summarizing":
      return t("meeting:stage.summarizing");
    case "rendering":
      return t("meeting:stage.rendering");
    default:
      return t("meeting:stage.preparing");
  }
}

function ProgressBody({ progress }: { progress: MeetingProgress | null }) {
  const { t } = useTranslation(["meeting", "common"]);
  if (!progress) {
    return (
      <div className="flex flex-col items-center gap-3" data-testid="meeting-preparing">
        <div className="size-8 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="text-sm text-ink-muted">{t("meeting:preparing")}</p>
      </div>
    );
  }

  const windowPercent =
    progress.window && progress.window.totalSegments > 0
      ? Math.min(
          100,
          Math.round((progress.window.doneSegments / progress.window.totalSegments) * 100),
        )
      : 0;

  return (
    <div className="flex w-full max-w-xl flex-col gap-4" data-testid="meeting-progress">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" data-testid="meeting-source">
            {progress.sourceName}
          </p>
          <p className="mt-1 text-xs text-ink-muted" data-testid="meeting-stage">
            {stageLabel(t, progress)}
            {progress.window
              ? ` · ${t("meeting:window", {
                  index: progress.window.index + 1,
                  total: progress.window.total,
                })}`
              : ""}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-ink-muted">
          {formatDuration(progress.elapsedMs)} / {formatDuration(progress.durationMs)}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${windowPercent}%` }}
        />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-ink-faint">{t("meeting:field.backend")}</dt>
          <dd className="text-ink-muted">
            {progress.actualBackend.kind === "remote"
              ? t("meeting:backend.remote", { provider: progress.actualBackend.provider })
              : t("meeting:backend.local")}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t("meeting:field.model")}</dt>
          <dd className="truncate text-ink-muted">{progress.localModel || "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t("meeting:field.accel")}</dt>
          <dd className="text-ink-muted">{t(`meeting:accel.${progress.accel}`)}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t("meeting:field.speakers")}</dt>
          <dd className="text-ink-muted">{progress.speakerCount ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t("meeting:field.failed")}</dt>
          <dd className="text-ink-muted">{progress.failedSegments}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t("meeting:field.rtf")}</dt>
          <dd className="text-ink-muted">{progress.rtf?.toFixed(2) ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

export function MeetingBoot({ meeting }: { meeting: UseMeetingProgress }) {
  const { t } = useTranslation(["meeting", "errors", "common"]);
  const { ipc } = useAppServices();
  const toast = useToast();
  const { phase, progress, error, canRetry, retry, cancel, retryInsert } = meeting;

  if (phase === "inserted") {
    return null;
  }

  const openSettings = () => {
    void ipc.appSettingsOpen("ai").catch((cause: unknown) => {
      toast.push(t("meeting:settingsFailed"));
      console.warn("failed to open settings", normalizeError(cause));
    });
  };

  return (
    <section
      data-testid="meeting-boot"
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-6 overflow-auto px-8 py-12"
    >
      {phase === "loading" || phase === "running" || phase === "inserting" ? (
        <>
          <ProgressBody progress={progress} />
          <button
            type="button"
            data-testid="meeting-cancel"
            onClick={() => void cancel()}
            className="rounded-full border border-line px-4 py-1.5 text-xs text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-muted"
          >
            {t("common:actions.cancel")}
          </button>
        </>
      ) : null}

      {phase === "failed" && error ? (
        <div
          className="flex max-w-xl flex-col items-center gap-4 text-center"
          data-testid="meeting-failed"
        >
          <h2 className="text-base font-semibold text-ink">{t("meeting:failedTitle")}</h2>
          <p className="text-sm text-ink-muted">
            {t(`errors:${error.code}`, { defaultValue: error.message })}
          </p>
          {error.code === "MODEL_NOT_READY" ? (
            <p className="text-xs text-ink-faint">{t("meeting:modelHint")}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {canRetry ? (
              <button
                type="button"
                data-testid="meeting-retry"
                onClick={() => void retry()}
                className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-on-accent"
              >
                {t("meeting:retry")}
              </button>
            ) : null}
            {error.code === "MODEL_NOT_READY" ? (
              <button
                type="button"
                data-testid="meeting-open-settings"
                onClick={openSettings}
                className="rounded-full border border-line px-4 py-1.5 text-xs text-ink"
              >
                {t("meeting:openSettings")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {phase === "cancelled" ? (
        <div
          className="flex flex-col items-center gap-2 text-center"
          data-testid="meeting-cancelled"
        >
          <h2 className="text-base font-semibold text-ink">{t("meeting:cancelledTitle")}</h2>
          <p className="text-sm text-ink-muted">{t("meeting:cancelledHint")}</p>
        </div>
      ) : null}

      {phase === "gone" ? (
        <div className="flex flex-col items-center gap-2 text-center" data-testid="meeting-gone">
          <h2 className="text-base font-semibold text-ink">{t("meeting:goneTitle")}</h2>
          <p className="text-sm text-ink-muted">{t("meeting:goneHint")}</p>
        </div>
      ) : null}

      {phase === "insert_failed" ? (
        <div
          className={cx("flex max-w-xl flex-col items-center gap-3 text-center")}
          data-testid="meeting-insert-failed"
        >
          <h2 className="text-base font-semibold text-ink">{t("meeting:insertFailedTitle")}</h2>
          <p className="text-sm text-ink-muted">{t("meeting:insertFailedHint")}</p>
          <button
            type="button"
            data-testid="meeting-retry-insert"
            onClick={retryInsert}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-on-accent"
          >
            {t("meeting:retryInsert")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
