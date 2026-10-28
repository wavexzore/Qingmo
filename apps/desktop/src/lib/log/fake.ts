import type { LogEntry, LogLevel, LogStats } from "@qingmo/shared";

import type { LogPort, LogQuery } from "./port";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const SAMPLE: LogEntry[] = [
  {
    timestamp: "2026-10-28T02:45:12.100000Z",
    level: "info",
    target: "qingmo_lib::commands::close",
    message: "arming close request",
  },
  {
    timestamp: "2026-10-28T02:45:12.900000Z",
    level: "warn",
    target: "qingmo_lib::commands::document",
    message: "failed to update the window title",
  },
  {
    timestamp: "2026-10-28T02:45:13.400000Z",
    level: "error",
    target: "qingmo_lib::commands::update",
    message: "failed to emit update state",
  },
];

/**
 * In-memory log store for unit tests and the browser E2E build. Entries are
 * newest last internally and filtered with the same severity rule as Rust.
 */
export class FakeLogPort implements LogPort {
  entries: LogEntry[];
  exportError: Error | null = null;
  readonly calls = { list: 0, stats: 0, export: 0, openDir: 0, clear: 0 };

  constructor(entries: LogEntry[] = SAMPLE) {
    this.entries = [...entries];
  }

  async list(query: LogQuery = {}): Promise<LogEntry[]> {
    this.calls.list += 1;
    const minimum = query.level ? LEVEL_ORDER[query.level] : null;
    const filtered = this.entries
      .filter((entry) => minimum === null || (LEVEL_ORDER[entry.level] ?? 0) >= minimum)
      .reverse();
    return filtered.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 200));
  }

  async stats(): Promise<LogStats> {
    this.calls.stats += 1;
    const count = (level: LogLevel) => this.entries.filter((entry) => entry.level === level).length;
    return {
      totalEntries: this.entries.length,
      errorCount: count("error"),
      warnCount: count("warn"),
      infoCount: count("info"),
      debugCount: count("debug") + count("trace"),
      totalSizeBytes: this.entries.length * 96,
      fileCount: 1,
      oldestEntry: this.entries[0]?.timestamp ?? null,
      newestEntry: this.entries.at(-1)?.timestamp ?? null,
    };
  }

  async export(level: LogLevel | null = null): Promise<string> {
    this.calls.export += 1;
    if (this.exportError) {
      throw this.exportError;
    }
    const suffix = level ? `-${level}` : "";
    return `/Users/test/Downloads/qingmo-logs${suffix}.txt`;
  }

  async openDir(): Promise<void> {
    this.calls.openDir += 1;
  }

  async clear(): Promise<number> {
    this.calls.clear += 1;
    const before = this.entries.length;
    this.entries = [];
    return before;
  }
}
