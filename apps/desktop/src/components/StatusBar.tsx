import { useTranslation } from "react-i18next";

import { cx } from "@qingmo/ui";

import type { SaveState } from "../lib/save-state";

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
}

export const EMPTY_STATUS_SNAPSHOT: StatusBarSnapshot = {
  fileName: null,
  saveState: "clean",
  cursor: null,
  encoding: null,
  eol: null,
  size: null,
  mode: "source",
};

const saveStateTone: Record<SaveState, string> = {
  clean: "bg-success",
  dirty: "bg-warning",
  scheduled: "bg-accent",
  saving: "bg-accent",
  error: "bg-danger",
  conflict: "bg-danger",
  readonly: "bg-ink-faint",
};

function formatSize(size: number | null): string {
  if (size === null) {
    return "—";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</span>
      <span className="truncate text-ink-muted">{value}</span>
    </span>
  );
}

export function StatusBar({ snapshot = EMPTY_STATUS_SNAPSHOT }: { snapshot?: StatusBarSnapshot }) {
  const { t } = useTranslation(["common", "editor"]);

  const fileName = snapshot.fileName ?? t("common:status.noFile");
  const saveLabel = t(`common:saveState.${snapshot.saveState}`);
  const modeLabel = t(`common:mode.${snapshot.mode}`);
  const cursorLabel = snapshot.cursor
    ? t("editor:status.position", {
        line: snapshot.cursor.line,
        column: snapshot.cursor.column,
      })
    : t("common:status.notAvailable");

  return (
    <footer
      role="status"
      aria-live="polite"
      className="flex h-[var(--qm-status-height)] items-center gap-4 overflow-hidden border-t border-line bg-surface px-4 text-[11px]"
      data-testid="status-bar"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cx("size-1.5 shrink-0 rounded-full", saveStateTone[snapshot.saveState])}
        />
        <span className="truncate font-medium text-ink">{fileName}</span>
      </span>

      <span className="hidden h-3 w-px shrink-0 bg-line sm:block" aria-hidden="true" />

      <div className="hidden min-w-0 flex-1 items-center gap-4 overflow-hidden sm:flex">
        <Item label={t("common:status.save")} value={saveLabel} />
        <Item label={t("common:status.cursor")} value={cursorLabel} />
        <Item label={t("common:status.encoding")} value={snapshot.encoding ?? "—"} />
        <Item label={t("common:status.eol")} value={snapshot.eol ?? "—"} />
        <Item label={t("common:status.size")} value={formatSize(snapshot.size)} />
      </div>

      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {modeLabel}
      </span>
    </footer>
  );
}
