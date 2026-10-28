import type { LogEntry, LogLevel, LogStats } from "@qingmo/shared";
import { invoke } from "@tauri-apps/api/core";

import { COMMANDS } from "../ipc/commands";
import { normalizeError } from "../ipc/errors";
import type { LogPort, LogQuery } from "./port";

/** The only production adapter allowed to import `@tauri-apps/*` for logs. */
export function createTauriLogPort(): LogPort {
  return {
    async list(query: LogQuery = {}) {
      try {
        return await invoke<LogEntry[]>(COMMANDS.appLogsList, {
          level: query.level ?? null,
          limit: query.limit,
          offset: query.offset,
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async stats() {
      try {
        return await invoke<LogStats>(COMMANDS.appLogsStats, {});
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async export(level = null) {
      try {
        return await invoke<string>(COMMANDS.appLogsExport, { level });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async openDir() {
      try {
        await invoke<null>(COMMANDS.appLogsOpenDir, {});
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async clear(keepDays) {
      try {
        return await invoke<number>(COMMANDS.appLogsClear, { keepDays });
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}

export type { LogLevel };
