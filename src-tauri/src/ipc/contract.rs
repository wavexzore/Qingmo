// Single source of truth for command and event names.
//
// This file is also included by `build.rs`, so it must remain dependency-free
// (besides the standard library) and must not reference `crate::`.

pub const COMMANDS: &[&str] = &[
    "document_open",
    "document_reload",
    "document_save_as",
    "document_write_atomic",
    "app_close_confirm",
    "app_update_status",
    "app_update_check",
    "app_update_download",
    "app_update_install",
];

pub const EVENT_CLOSE_REQUESTED: &str = "app://close-requested";
pub const EVENT_UPDATE_STATE: &str = "app://update-state";
pub const EVENT_UPDATE_PROGRESS: &str = "app://update-progress";

pub const EVENTS: &[&str] = &[
    EVENT_CLOSE_REQUESTED,
    EVENT_UPDATE_STATE,
    EVENT_UPDATE_PROGRESS,
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
