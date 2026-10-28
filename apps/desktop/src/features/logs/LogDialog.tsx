import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LogEntry, LogLevel, LogStats } from "@qingmo/shared";
import { Button } from "@qingmo/ui";

import { useToast } from "../../components/ToastHost";
import { useLogs } from "../../lib/log/useLogs";

type Filter = LogLevel | "all";
type Busy = "export" | "clear" | "openDir" | null;

const FILTERS: LogLevel[] = ["error", "warn", "info", "debug"];
const REFRESH_MS = 2_000;

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: "text-danger",
  warn: "text-warning",
  info: "text-accent",
  debug: "text-ink-faint",
  trace: "text-ink-faint",
};

const RAIL_COLOR: Record<LogLevel, string> = {
  error: "bg-danger",
  warn: "bg-warning",
  info: "bg-accent",
  debug: "bg-ink-faint",
  trace: "bg-ink-faint",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export interface LogDialogProps {
  open: boolean;
  onClose(): void;
}

/**
 * Read-only ledger view of the persisted log. Rust owns files and retention;
 * this dialog only requests filtered pages and exposes export/maintenance.
 */
export function LogDialog({ open, onClose }: LogDialogProps) {
  const { t } = useTranslation(["logs", "errors"]);
  const toast = useToast();
  const logs = useLogs();
  const [filter, setFilter] = useState<Filter>("all");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEntries, nextStats] = await Promise.all([
        logs.list({ level: filter === "all" ? null : filter, limit: 200 }),
        logs.stats(),
      ]);
      setEntries(nextEntries);
      setStats(nextStats);
    } catch {
      toast.push(t("logs:toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [filter, logs, t, toast]);

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirming(false);
    void load();
    return () => {
      const target = previousFocus.current;
      if (target && document.contains(target)) {
        target.focus();
      }
    };
  }, [open, load]);

  useEffect(() => {
    if (!open || !autoRefresh) {
      return;
    }
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load, open]);

  useEffect(() => {
    if (!open) {
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
  }, [onClose, open]);

  const run = useCallback(async (action: Exclude<Busy, null>, work: () => Promise<void>) => {
    setBusy(action);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  }, []);

  const copyEntry = useCallback(
    async (entry: LogEntry) => {
      try {
        await navigator.clipboard.writeText(entry.message);
      } catch {
        // Clipboard can be denied in a bare webview; the toast still confirms
        // the click landed.
      }
      toast.push(t("logs:toast.copied"));
    },
    [t, toast],
  );

  const exportLogs = useCallback(() => {
    void run("export", async () => {
      try {
        const path = await logs.export(filter === "all" ? null : filter);
        toast.push(t("logs:toast.exported", { path }));
      } catch {
        toast.push(t("logs:toast.exportFailed"));
      }
    });
  }, [filter, logs, run, t, toast]);

  const openDirectory = useCallback(() => {
    void run("openDir", async () => {
      try {
        await logs.openDir();
      } catch {
        toast.push(t("logs:toast.openFailed"));
      }
    });
  }, [logs, run, t, toast]);

  const clearOld = useCallback(() => {
    setConfirming(false);
    void run("clear", async () => {
      try {
        const removed = await logs.clear();
        toast.push(t("logs:toast.cleared", { count: removed }));
        await load();
      } catch {
        toast.push(t("logs:toast.clearFailed"));
      }
    });
  }, [load, logs, run, t, toast]);

  if (!open) {
    return null;
  }

  const total = stats?.totalEntries ?? 0;
  const fileCount = stats?.fileCount ?? 0;
  const totalSize = stats?.totalSizeBytes ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/30 p-6 backdrop-blur-[2px]"
      data-testid="logs-dialog-overlay"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="logs-dialog-title"
        aria-describedby="logs-dialog-description"
        className="flex max-h-[min(640px,calc(100dvh-96px))] w-[min(880px,94vw)] flex-col overflow-hidden rounded-[18px] border border-line bg-surface shadow-[0_32px_80px_rgba(20,18,14,0.26),0_2px_0_rgba(255,255,255,0.6)_inset]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-6 px-[26px] pt-6 pb-[18px]">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9.5px] tracking-[0.22em] text-ink-faint uppercase">
              {t("logs:kicker")}
            </p>
            <h2
              id="logs-dialog-title"
              className="mt-1.5 font-serif text-[27px] leading-[1.2] font-semibold tracking-[-0.02em] text-ink"
            >
              {t("logs:title")}
            </h2>
            <p
              id="logs-dialog-description"
              className="mt-[7px] text-xs leading-[1.6] text-ink-muted"
            >
              {t("logs:description")}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("logs:close")}
            data-testid="logs-close"
            onClick={onClose}
            className="mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <svg
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              className="size-[13px]"
            >
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-3.5 border-b border-line px-[26px] pb-3.5">
          <div
            className="flex gap-0.5 rounded-lg bg-surface-muted p-0.5"
            role="group"
            aria-label={t("logs:filter")}
          >
            {(["all", ...FILTERS] as const).map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={filter === level}
                data-testid={level === "all" ? "logs-filter-all" : `logs-filter-${level}`}
                onClick={() => {
                  setFilter(level);
                }}
                className={`h-[25px] rounded-md px-2.5 text-[10.5px] transition-colors ${
                  filter === level
                    ? "bg-surface-raised text-ink shadow-[0_1px_2px_rgba(20,18,14,0.1)]"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {level === "all" ? t("logs:all") : t(`logs:level.${level}`)}
              </button>
            ))}
          </div>

          <label className="inline-flex cursor-pointer items-center gap-[7px] text-[11px] text-ink-muted select-none">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={autoRefresh}
              onChange={(event) => {
                setAutoRefresh(event.target.checked);
              }}
            />
            <span className="relative h-4 w-7 rounded-full bg-line-strong transition-colors peer-checked:bg-accent after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-surface-raised after:shadow-[0_1px_2px_rgba(0,0,0,0.2)] after:transition-transform peer-checked:after:translate-x-3" />
            {t("logs:autoRefresh")}
          </label>

          <p
            className="ml-auto flex gap-1.5 font-mono text-[9.5px] text-ink-faint"
            data-testid="logs-stats"
            aria-label={t("logs:stats", {
              total,
              errors: stats?.errorCount ?? 0,
              warns: stats?.warnCount ?? 0,
            })}
          >
            <span>
              <b className="font-medium text-ink-muted">{total}</b> {t("logs:unitEntries")}
            </span>
            <span aria-hidden="true">{"· "}</span>
            <span>
              <b className="font-medium text-ink-muted">{stats?.errorCount ?? 0}</b>{" "}
              {t("logs:unitErrors")}
            </span>
            <span aria-hidden="true">{"· "}</span>
            <span>
              <b className="font-medium text-ink-muted">{stats?.warnCount ?? 0}</b>{" "}
              {t("logs:unitWarns")}
            </span>
            <span aria-hidden="true">{"· "}</span>
            <span>{t("logs:files", { count: fileCount, size: formatSize(totalSize) })}</span>
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <ol
            className="flex-1 overflow-y-auto px-[26px] pt-1 pb-3.5 [scrollbar-gutter:stable]"
            data-testid="logs-list"
            aria-live="polite"
          >
            {entries.map((entry, index) => (
              <li
                key={`${entry.timestamp}-${index}`}
                data-level={entry.level}
                onClick={() => {
                  void copyEntry(entry);
                }}
                className="grid cursor-default grid-cols-[66px_15px_52px_minmax(0,1fr)] items-start gap-2.5 rounded-[7px] py-[7px] pr-1.5 transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent-soft)_55%,transparent)] [&:last-child_.rail]:bottom-auto [&:last-child_.rail]:h-[13px]"
              >
                <time
                  dateTime={entry.timestamp}
                  className="pt-0.5 text-right font-mono text-[10.5px] text-ink-faint tabular-nums"
                >
                  {formatTime(entry.timestamp)}
                </time>
                <span className="relative grid self-stretch justify-items-center">
                  <span className="rail absolute inset-y-0 w-px bg-line" />
                  <i
                    className={`relative z-[1] mt-1.5 size-[7px] rounded-full border-2 border-surface ${RAIL_COLOR[entry.level]}`}
                  />
                </span>
                <span
                  className={`inline-flex items-center gap-[5px] font-mono text-[9px] whitespace-nowrap ${LEVEL_COLOR[entry.level]}`}
                >
                  <span className="size-[5px] rounded-full bg-current" />
                  {t(`logs:level.${entry.level}`)}
                </span>
                <div className="min-w-0 pt-px">
                  <div className="mb-px flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-ink-faint">{entry.target}</span>
                  </div>
                  <p
                    className={`m-0 font-mono text-[11.5px] leading-[1.7] break-words ${
                      entry.level === "error" || entry.level === "warn"
                        ? "text-ink"
                        : "text-ink-muted"
                    }`}
                  >
                    {entry.message}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          {loading && entries.length === 0 ? (
            <p className="py-16 text-center text-xs text-ink-faint">{t("logs:loading")}</p>
          ) : null}
          {!loading && entries.length === 0 ? (
            <p className="py-16 text-center text-xs text-ink-faint" data-testid="logs-empty">
              <strong className="mb-1.5 block font-serif text-[17px] font-medium text-ink-muted">
                {t("logs:emptyTitle")}
              </strong>
              {t("logs:empty")}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-3.5 border-t border-line px-[26px] py-3">
          <span className="flex min-w-0 flex-1 items-center gap-[7px] font-mono text-[9.5px] text-ink-faint">
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              aria-hidden="true"
              className="shrink-0"
            >
              <path d="M1.5 3.5h3l1 1.2h5v5.3h-9z" />
            </svg>
            <span className="truncate">~/Library/Logs/com.wavexzore.qingmo</span>
            <button
              type="button"
              data-testid="logs-open-dir"
              onClick={openDirectory}
              className="h-5 shrink-0 rounded-[5px] border border-transparent px-1.5 text-[9px] text-ink-faint transition-colors hover:border-line hover:text-ink"
            >
              {t("logs:openShort")}
            </button>
          </span>

          {confirming ? (
            <div
              className="flex items-center gap-2.5 rounded-lg border border-danger/35 bg-danger-soft py-[7px] pr-2.5 pl-3 text-[10.5px] text-ink"
              data-testid="logs-confirm"
            >
              <span>{t("logs:confirmTitle")}</span>
              <Button
                variant="ghost"
                className="h-6 rounded-md border-line bg-surface px-2.5 text-[10.5px]"
                data-testid="logs-clear-confirm"
                onClick={clearOld}
              >
                {t("logs:confirm")}
              </Button>
              <Button
                variant="ghost"
                className="h-6 border-transparent px-2 text-[10.5px]"
                data-testid="logs-clear-cancel"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t("logs:cancel")}
              </Button>
            </div>
          ) : null}

          <div className="flex gap-[7px]">
            <Button
              variant="ghost"
              className="h-8 rounded-lg px-3 text-[11.5px]"
              data-testid="logs-clear"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t("logs:clear")}
            </Button>
            <Button
              className="h-8 gap-[7px] rounded-lg px-3 text-[11.5px] shadow-[0_4px_12px_rgba(44,106,90,0.18)]"
              data-testid="logs-export"
              disabled={busy !== null}
              onClick={exportLogs}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                aria-hidden="true"
              >
                <path d="M6 1.5v6M3.6 5.2 6 7.6l2.4-2.4M2 9.5v1h8v-1" />
              </svg>
              {t("logs:export")}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
