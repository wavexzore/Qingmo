import type {
  AppError,
  CloseRequestedPayload,
  FilePayload,
  SaveRequest,
  SaveResult,
  UpdateProgressPayload,
  UpdateSnapshot,
} from "@qingmo/shared";

/**
 * Frontend mirror of `src-tauri/src/ipc/contract.rs`.
 * Values are the exact Tauri command names; the Rust contract test asserts
 * that each literal appears in this file.
 */
export const COMMANDS = {
  documentOpen: "document_open",
  documentTakePending: "document_take_pending",
  documentReload: "document_reload",
  documentSaveAs: "document_save_as",
  documentWriteAtomic: "document_write_atomic",
  appCloseConfirm: "app_close_confirm",
  appUpdateStatus: "app_update_status",
  appUpdateCheck: "app_update_check",
  appUpdateDownload: "app_update_download",
  appUpdateInstall: "app_update_install",
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

export const COMMAND_NAMES = [
  COMMANDS.documentOpen,
  COMMANDS.documentTakePending,
  COMMANDS.documentReload,
  COMMANDS.documentSaveAs,
  COMMANDS.documentWriteAtomic,
  COMMANDS.appCloseConfirm,
  COMMANDS.appUpdateStatus,
  COMMANDS.appUpdateCheck,
  COMMANDS.appUpdateDownload,
  COMMANDS.appUpdateInstall,
] as const satisfies readonly CommandName[];

export const EVENTS = {
  closeRequested: "app://close-requested",
  updateState: "app://update-state",
  updateProgress: "app://update-progress",
  menuAction: "app://menu-action",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const EVENT_NAMES = [
  EVENTS.closeRequested,
  EVENTS.updateState,
  EVENTS.updateProgress,
  EVENTS.menuAction,
] as const satisfies readonly EventName[];

/**
 * Native menu item ids forwarded by `app://menu-action`.
 *
 * Predefined AppKit items (undo/copy/paste/close/fullscreen) never appear
 * here: they are handled by the first responder inside the webview.
 */
export const MENU_ACTIONS = {
  fileOpen: "file.open",
  fileSave: "file.save",
  paletteOpen: "palette.open",
  toggleLivePreview: "view.toggleLivePreview",
  toggleTheme: "view.toggleTheme",
  themeLight: "theme.light",
  themeDark: "theme.dark",
  themeSystem: "theme.system",
} as const;

export type MenuAction = (typeof MENU_ACTIONS)[keyof typeof MENU_ACTIONS];

export const MENU_ACTION_NAMES = [
  MENU_ACTIONS.fileOpen,
  MENU_ACTIONS.fileSave,
  MENU_ACTIONS.paletteOpen,
  MENU_ACTIONS.toggleLivePreview,
  MENU_ACTIONS.toggleTheme,
  MENU_ACTIONS.themeLight,
  MENU_ACTIONS.themeDark,
  MENU_ACTIONS.themeSystem,
] as const satisfies readonly MenuAction[];

export interface CommandRequestMap {
  [COMMANDS.documentOpen]: Record<string, never>;
  [COMMANDS.documentTakePending]: Record<string, never>;
  [COMMANDS.documentReload]: { docToken: string };
  [COMMANDS.documentSaveAs]: { text: string };
  [COMMANDS.documentWriteAtomic]: SaveRequest;
  [COMMANDS.appCloseConfirm]: { allow: boolean };
  [COMMANDS.appUpdateStatus]: Record<string, never>;
  [COMMANDS.appUpdateCheck]: Record<string, never>;
  [COMMANDS.appUpdateDownload]: Record<string, never>;
  [COMMANDS.appUpdateInstall]: Record<string, never>;
}

export interface CommandResponseMap {
  [COMMANDS.documentOpen]: null;
  [COMMANDS.documentTakePending]: FilePayload | null;
  [COMMANDS.documentReload]: FilePayload;
  [COMMANDS.documentSaveAs]: FilePayload;
  [COMMANDS.documentWriteAtomic]: SaveResult;
  [COMMANDS.appCloseConfirm]: null;
  [COMMANDS.appUpdateStatus]: UpdateSnapshot;
  [COMMANDS.appUpdateCheck]: UpdateSnapshot;
  [COMMANDS.appUpdateDownload]: UpdateSnapshot;
  [COMMANDS.appUpdateInstall]: null;
}

export type CommandError = AppError;
export type CloseRequestedEvent = CloseRequestedPayload;
export type UpdateStateEvent = UpdateSnapshot;
export type UpdateProgressEvent = UpdateProgressPayload;

/** Mirrors Tauri's `allow-document-open` naming rule. */
export function commandPermission(command: CommandName): string {
  return `allow-${command.replaceAll("_", "-")}`;
}

export const COMMAND_PERMISSIONS = {
  [COMMANDS.documentOpen]: commandPermission(COMMANDS.documentOpen),
  [COMMANDS.documentTakePending]: commandPermission(COMMANDS.documentTakePending),
  [COMMANDS.documentReload]: commandPermission(COMMANDS.documentReload),
  [COMMANDS.documentSaveAs]: commandPermission(COMMANDS.documentSaveAs),
  [COMMANDS.documentWriteAtomic]: commandPermission(COMMANDS.documentWriteAtomic),
  [COMMANDS.appCloseConfirm]: commandPermission(COMMANDS.appCloseConfirm),
  [COMMANDS.appUpdateStatus]: commandPermission(COMMANDS.appUpdateStatus),
  [COMMANDS.appUpdateCheck]: commandPermission(COMMANDS.appUpdateCheck),
  [COMMANDS.appUpdateDownload]: commandPermission(COMMANDS.appUpdateDownload),
  [COMMANDS.appUpdateInstall]: commandPermission(COMMANDS.appUpdateInstall),
} as const satisfies Record<CommandName, string>;

export type IpcInvoker = <K extends CommandName>(
  command: K,
  args: CommandRequestMap[K],
) => Promise<CommandResponseMap[K]>;
