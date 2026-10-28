// Single source of truth for command and event names.
//
// This file is also included by `build.rs`, so it must remain dependency-free
// (besides the standard library) and must not reference `crate::`.

pub const COMMANDS: &[&str] = &[
    "document_open",
    "document_take_pending",
    "document_reload",
    "document_save_as",
    "document_write_atomic",
    "app_close_confirm",
    "app_set_live_preview",
    "app_about_info",
    "app_about_close",
    "app_about_open_link",
    "app_update_status",
    "app_update_check",
    "app_update_download",
    "app_update_install",
    "app_logs_list",
    "app_logs_stats",
    "app_logs_export",
    "app_logs_open_dir",
    "app_logs_clear",
];

pub const EVENT_CLOSE_REQUESTED: &str = "app://close-requested";
pub const EVENT_UPDATE_STATE: &str = "app://update-state";
pub const EVENT_UPDATE_PROGRESS: &str = "app://update-progress";
/// Native menu item activation. The payload is one of `MENU_ACTIONS`.
pub const EVENT_MENU_ACTION: &str = "app://menu-action";
/// The watcher found a different (or missing) disk version for an open document.
pub const EVENT_DOCUMENT_CHANGED: &str = "app://document-changed";

pub const EVENTS: &[&str] = &[
    EVENT_CLOSE_REQUESTED,
    EVENT_UPDATE_STATE,
    EVENT_UPDATE_PROGRESS,
    EVENT_MENU_ACTION,
    EVENT_DOCUMENT_CHANGED,
];

/// Menu item ids that the native menu forwards to the webview.
///
/// Predefined AppKit items (undo/copy/paste/close/fullscreen) stay native and
/// are intentionally absent: they must be handled by the first responder.
pub const MENU_FILE_OPEN: &str = "file.open";
pub const MENU_FILE_SAVE: &str = "file.save";
pub const MENU_PALETTE_OPEN: &str = "palette.open";
pub const MENU_VIEW_TOGGLE_LIVE_PREVIEW: &str = "view.toggleLivePreview";
pub const MENU_VIEW_TOGGLE_THEME: &str = "view.toggleTheme";
pub const MENU_LOGS: &str = "app.openLogs";
pub const MENU_THEME_LIGHT: &str = "theme.light";
pub const MENU_THEME_DARK: &str = "theme.dark";
pub const MENU_THEME_SYSTEM: &str = "theme.system";

pub const MENU_ACTIONS: &[&str] = &[
    MENU_FILE_OPEN,
    MENU_FILE_SAVE,
    MENU_PALETTE_OPEN,
    MENU_VIEW_TOGGLE_LIVE_PREVIEW,
    MENU_VIEW_TOGGLE_THEME,
    MENU_LOGS,
    MENU_THEME_LIGHT,
    MENU_THEME_DARK,
    MENU_THEME_SYSTEM,
];

/// Tauri turns `document_open` into the ACL permission `allow-document-open`.
pub fn command_permission(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

/// All application command permissions, in command order.
pub fn command_permissions() -> Vec<String> {
    COMMANDS
        .iter()
        .map(|command| command_permission(command))
        .collect()
}
