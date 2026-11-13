import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PREVIEW_FULL_MAX_UNITS,
  PREVIEW_PARTIAL_MAX_UNITS,
  type PreviewTier,
} from "@qingmo/editor-core";
import type { MeetingProgress, ReadOnlyReason } from "@qingmo/shared";
import { cx } from "@qingmo/ui";

import type { SaveState } from "../lib/save-state";
import { formatBytes, formatEncoding, formatEol } from "../lib/format";

export type { SaveState } from "../lib/save-state";
export type StatusBarMode = "source" | "livePreview";

export interface StatusBarSnapshot {
  fileName: string | null;
  saveState: SaveState;
  cursor: { line: number; column: number } | null;
  encoding: string | null;
  eol: string | null;
  size: number | null;
  mode: StatusBarMode;
  /** Affordability tier; determines the partial/source badge. */
  previewTier: PreviewTier;
  /** Read-only documents stay loadable but never accept edits. */
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
}

export const EMPTY_STATUS_SNAPSHOT: StatusBarSnapshot = {
  fileName: null,
  saveState: "clean",
  cursor: null,
  encoding: null,
  eol: null,
  size: null,
  mode: "source",
  previewTier: "full",
  readOnly: false,
  readOnlyReason: null,
};

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

const saveStateTone: Record<SaveState, string> = {
  clean: "bg-success",
  dirty: "bg-warning",
  scheduled: "bg-accent",
  saving: "bg-accent",
  error: "bg-danger",
  conflict: "bg-danger",
  readonly: "bg-ink-faint",
};

function Item({
  label,
  value,
  testId,
  className = "inline-flex",
}: {
  label: string;
  value: string;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId}
      // The footer is a container: each item opts into wider layouts so a
      // narrow editor pane hides secondary values instead of wrapping labels.
      className={cx("min-w-0 items-baseline gap-1.5", className)}
    >
      <span
        data-testid={testId ? `${testId}-label` : undefined}
        className="shrink-0 whitespace-nowrap text-[10px] uppercase tracking-[0.12em] text-ink-faint"
      >
        {label}
      </span>
      <span className="truncate text-ink-muted">{value}</span>
    </span>
  );
}

export interface StatusBarProps {
  snapshot?: StatusBarSnapshot;
  /** Shown only for terminal save errors; retries through SaveCoordinator. */
  onRetry?: () => void;
  /** Live meeting state for a result window; omitted for ordinary documents. */
  meeting?: MeetingProgress | null;
  /** Asset URL kept after the terminal state so playback survives completion. */
  meetingAudioUrl?: string;
  /** Renders the partial terminal badge even without a progress snapshot. */
  meetingPartial?: boolean;
}

export function StatusBar({
  snapshot = EMPTY_STATUS_SNAPSHOT,
  onRetry,
  meeting = null,
  meetingAudioUrl = "",
  meetingPartial = false,
}: StatusBarProps) {
  const { t, i18n } = useTranslation(["common", "editor", "meeting"]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const syncTime = () => setCurrentTime(audio.currentTime);
    const syncDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    setCurrentTime(0);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    setPlaying(!audio.paused);
    audio.addEventListener("timeupdate", syncTime);
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", syncTime);
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [meetingAudioUrl]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused) {
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  const seekPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  };

  const fileName = snapshot.fileName ?? t("common:status.noFile");
  const saveLabel = t(`common:saveState.${snapshot.saveState}`);
  const modeLabel = t(`common:mode.${snapshot.mode}`);
  const readOnlyLabel =
    snapshot.readOnlyReason === "mdx"
      ? t("editor:document.readOnlyMdx")
      : snapshot.readOnlyReason === "mixedEol"
        ? t("editor:document.readOnlyMixedEol")
        : t("editor:document.readOnly");
  const cursorLabel = snapshot.cursor
    ? t("editor:status.position", {
        line: snapshot.cursor.line,
        column: snapshot.cursor.column,
      })
    : t("common:status.notAvailable");
  const formatLimit = (units: number) => new Intl.NumberFormat(i18n.language).format(units);
  const partialPreview = snapshot.previewTier === "partial" && snapshot.mode === "livePreview";
  const sourcePreview = snapshot.previewTier === "source";
  const meetingStage = meeting
    ? t(`meeting:stage.${meeting.stage}`, { defaultValue: meeting.stage })
    : null;

  return (
    <footer
      role="status"
      aria-live="polite"
      className="flex h-[var(--qm-status-height)] @container items-center gap-4 overflow-hidden border-t border-line bg-surface px-4 text-[11px]"
      data-testid="status-bar"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cx("size-1.5 shrink-0 rounded-full", saveStateTone[snapshot.saveState])}
        />
        <span className="truncate font-medium text-ink">{fileName}</span>
        {snapshot.readOnly ? (
          <span
            data-testid="read-only-badge"
            className="shrink-0 rounded-full border border-line-strong bg-surface-muted px-2 py-0.5 text-[10px] text-ink-muted"
          >
            {readOnlyLabel}
          </span>
        ) : null}
      </span>

      <span className="hidden h-3 w-px shrink-0 bg-line sm:block" aria-hidden="true" />

      <div className="hidden min-w-0 flex-1 items-center gap-4 overflow-hidden sm:flex">
        <Item testId="status-save" label={t("common:status.save")} value={saveLabel} />
        {snapshot.saveState === "error" && onRetry ? (
          <button
            type="button"
            data-testid="status-retry"
            onClick={onRetry}
            className="shrink-0 whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-[10px] text-ink transition-colors hover:border-line-strong hover:bg-accent-soft"
          >
            {t("common:actions.retry")}
          </button>
        ) : null}
        <Item
          testId="status-cursor"
          className="hidden @md:inline-flex"
          label={t("common:status.cursor")}
          value={cursorLabel}
        />
        <Item
          testId="status-encoding"
          className="hidden @sm:inline-flex"
          label={t("common:status.encoding")}
          value={formatEncoding(snapshot.encoding)}
        />
        <Item
          testId="status-eol"
          className="hidden @xl:inline-flex"
          label={t("common:status.eol")}
          value={formatEol(snapshot.eol)}
        />
        <Item
          testId="status-size"
          className="hidden @2xl:inline-flex"
          label={t("common:status.size")}
          value={formatBytes(snapshot.size, i18n.language)}
        />
        {meetingPartial ? (
          <Item
            testId="status-meeting-stage"
            className="hidden @md:inline-flex"
            label={t("meeting:field.stage")}
            value={t("meeting:stage.partialDone")}
          />
        ) : null}
        {meeting || meetingAudioUrl ? (
          <>
            {meeting && !meetingPartial ? (
              <Item
                testId="status-meeting-stage"
                className="hidden @md:inline-flex"
                label={t("meeting:field.stage")}
                value={meetingStage ?? meeting.stage}
              />
            ) : null}
            {meeting ? (
              <Item
                testId="status-meeting-speakers"
                className="hidden @xl:inline-flex"
                label={t("meeting:field.speakers")}
                value={meeting.speakerCount == null ? "—" : String(meeting.speakerCount)}
              />
            ) : null}
            {meetingAudioUrl ? (
              // The audio URL is a per-window asset URL; it stays valid for
              // the window's lifetime and is released on Destroyed.
              <span
                className="flex w-40 min-w-0 shrink-0 items-center gap-1.5 @lg:w-52"
                data-testid="meeting-audio-player"
              >
                <audio
                  ref={audioRef}
                  data-testid="meeting-audio"
                  src={meetingAudioUrl}
                  preload="metadata"
                  className="hidden"
                />
                <button
                  type="button"
                  data-testid="meeting-audio-toggle"
                  aria-label={t(playing ? "meeting:playback.pause" : "meeting:playback.play")}
                  onClick={togglePlayback}
                  className="grid size-5 shrink-0 place-items-center rounded border border-line text-ink transition-colors hover:border-line-strong hover:bg-accent-soft"
                >
                  {playing ? (
                    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 fill-current">
                      <rect x="2.5" y="2" width="2.5" height="8" rx="0.5" />
                      <rect x="7" y="2" width="2.5" height="8" rx="0.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 fill-current">
                      <path d="M3.2 1.8v8.4a.6.6 0 0 0 .92.5l6.3-4.2a.6.6 0 0 0 0-1L4.12 1.3a.6.6 0 0 0-.92.5Z" />
                    </svg>
                  )}
                </button>
                <span className="shrink-0 tabular-nums text-[10px] text-ink-faint">
                  {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={Math.min(currentTime, duration || 0)}
                  disabled={duration <= 0}
                  data-testid="meeting-audio-seek"
                  aria-label={t("meeting:playback.seek")}
                  aria-valuetext={`${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`}
                  onChange={(event) => seekTo(Number(event.currentTarget.value))}
                  style={{ "--audio-progress": `${seekPercent}%` } as CSSProperties}
                  className="meeting-audio-range min-w-10 flex-1 disabled:cursor-default"
                />
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {partialPreview ? (
          <span
            data-testid="partial-preview-hint"
            title={t("common:status.partialPreviewHint", {
              limit: formatLimit(PREVIEW_FULL_MAX_UNITS),
            })}
            className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-muted"
          >
            {t("common:status.partialPreview")}
          </span>
        ) : null}
        {sourcePreview ? (
          <span
            data-testid="large-file-hint"
            title={t("common:status.largeFileHint", {
              limit: formatLimit(PREVIEW_PARTIAL_MAX_UNITS),
            })}
            className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-muted"
          >
            {t("common:status.largeFile")}
          </span>
        ) : null}
        <span className="whitespace-nowrap text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {modeLabel}
        </span>
      </span>
    </footer>
  );
}
