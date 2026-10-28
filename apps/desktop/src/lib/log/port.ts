import type { LogEntry, LogLevel, LogStats } from "@qingmo/shared";

export interface LogQuery {
  level?: LogLevel | null;
  limit?: number;
  offset?: number;
}

/**
 * Read-only access to the on-disk application log.
 *
 * Rust owns the directory and retention policy; the webview only asks for
 * filtered pages, exports and maintenance actions.
 */
export interface LogPort {
  list(query?: LogQuery): Promise<LogEntry[]>;
  stats(): Promise<LogStats>;
  /** Exports matching entries to Downloads and returns the written path. */
  export(level?: LogLevel | null): Promise<string>;
  openDir(): Promise<void>;
  /** Removes rolling files older than `keepDays`; returns the deleted count. */
  clear(keepDays?: number): Promise<number>;
}
