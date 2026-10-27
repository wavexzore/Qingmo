import type {
  AppError,
  CloseRequestedPayload,
  FilePayload,
  SaveRequest,
  SaveResult,
} from "@qingmo/shared";

/**
 * Frontend mirror of `src-tauri/src/ipc/contract.rs`.
 * Values are the exact Tauri command names; the Rust contract test asserts
 * that each literal appears in this file.
 */
export const COMMANDS = {
  documentOpen: "document_open",
  documentReload: "document_reload",
  documentSaveAs: "document_save_as",
  documentWriteAtomic: "document_write_atomic",
  appCloseConfirm: "app_close_confirm",
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

export const COMMAND_NAMES = [
  COMMANDS.documentOpen,
  COMMANDS.documentReload,
  COMMANDS.documentSaveAs,
  COMMANDS.documentWriteAtomic,
  COMMANDS.appCloseConfirm,
] as const satisfies readonly CommandName[];

export const EVENTS = {
  closeRequested: "app://close-requested",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const EVENT_NAMES = [EVENTS.closeRequested] as const satisfies readonly EventName[];

export interface CommandRequestMap {
  [COMMANDS.documentOpen]: Record<string, never>;
  [COMMANDS.documentReload]: { docToken: string };
  [COMMANDS.documentSaveAs]: { text: string };
  [COMMANDS.documentWriteAtomic]: SaveRequest;
  [COMMANDS.appCloseConfirm]: { allow: boolean };
}

export interface CommandResponseMap {
  [COMMANDS.documentOpen]: FilePayload;
  [COMMANDS.documentReload]: FilePayload;
  [COMMANDS.documentSaveAs]: FilePayload;
  [COMMANDS.documentWriteAtomic]: SaveResult;
  [COMMANDS.appCloseConfirm]: null;
}

export type CommandError = AppError;
export type CloseRequestedEvent = CloseRequestedPayload;

/** Mirrors Tauri's `allow-document-open` naming rule. */
export function commandPermission(command: CommandName): string {
  return `allow-${command.replaceAll("_", "-")}`;
}

export const COMMAND_PERMISSIONS = {
  [COMMANDS.documentOpen]: commandPermission(COMMANDS.documentOpen),
  [COMMANDS.documentReload]: commandPermission(COMMANDS.documentReload),
  [COMMANDS.documentSaveAs]: commandPermission(COMMANDS.documentSaveAs),
  [COMMANDS.documentWriteAtomic]: commandPermission(COMMANDS.documentWriteAtomic),
  [COMMANDS.appCloseConfirm]: commandPermission(COMMANDS.appCloseConfirm),
} as const satisfies Record<CommandName, string>;

export type IpcInvoker = <K extends CommandName>(
  command: K,
  args: CommandRequestMap[K],
) => Promise<CommandResponseMap[K]>;
