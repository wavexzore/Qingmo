import type { AppError as AppErrorPayload, AppErrorCode, JsonValue } from "@qingmo/shared";

/**
 * Runtime mirror of the Rust `AppErrorCode` union. Keeping the array literal
 * in sync is asserted by the IPC tests so an unknown wire code cannot silently
 * pass through the adapter.
 */
export const APP_ERROR_CODES = [
  "INVALID_PATH",
  "OUTSIDE_SCOPE",
  "NOT_FOUND",
  "NOT_A_FILE",
  "UNSUPPORTED_EXTENSION",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_ENCODING",
  "CONFLICT",
  "PERMISSION_DENIED",
  "READ_ONLY",
  "BUSY",
  "IO",
  "CANCELLED",
  "UPDATE_CHECK_FAILED",
  "UPDATE_DOWNLOAD_FAILED",
  "UPDATE_SIGNATURE_INVALID",
  "UPDATE_INSTALL_FAILED",
  "UPDATE_UNSUPPORTED",
  "UPDATE_NOT_READY",
  "INVALID_LOCALE",
] as const satisfies readonly AppErrorCode[];

const APP_ERROR_CODE_SET: ReadonlySet<string> = new Set(APP_ERROR_CODES);

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && APP_ERROR_CODE_SET.has(value);
}

/**
 * The single error type crossing the IpcPort boundary.
 *
 * It implements the generated `AppError` DTO so callers can either use the
 * class (`error instanceof AppError`, `error.code`) or serialize it with
 * `toJSON()` when a payload-shaped value is needed.
 */
export class AppError extends Error implements AppErrorPayload {
  readonly code: AppErrorCode;
  readonly details?: JsonValue;

  constructor(code: AppErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  toJSON(): AppErrorPayload {
    if (this.details === undefined) {
      return { code: this.code, message: this.message };
    }
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

function messageFor(code: AppErrorCode): string {
  return `IPC command failed with ${code}`;
}

/**
 * Normalizes every rejection shape the adapters can observe.
 *
 * Tauri rejects with the serialized Rust error object, but a missing command,
 * a crashed webview bridge, or a bug in an adapter can produce a string,
 * `Error`, or arbitrary value. Those become `IO` as specified by the port
 * contract; a valid `{ code, message }` object keeps its code (including
 * `BUSY` and `CANCELLED`).
 */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError("IO", error.message || "Unexpected IPC error");
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<AppErrorPayload>;
    if (isAppErrorCode(candidate.code)) {
      const message =
        typeof candidate.message === "string" && candidate.message.length > 0
          ? candidate.message
          : messageFor(candidate.code);
      const details = candidate.details;
      return details === undefined
        ? new AppError(candidate.code, message)
        : new AppError(candidate.code, message, details);
    }
  }

  if (typeof error === "string" && error.length > 0) {
    return new AppError("IO", error);
  }

  return new AppError("IO", "Unexpected IPC error");
}
