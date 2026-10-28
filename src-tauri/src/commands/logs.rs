//! Log reading, export and maintenance commands.
//!
//! Every command operates on the app log directory owned by
//! `services::logging`; the webview never supplies a source path.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{LogEntry, LogLevel, LogStats};
use crate::services::logging;

const DEFAULT_PAGE: usize = 200;

fn exported_name(app: &AppHandle<impl Runtime>) -> PathBuf {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Downloads")))
        .unwrap_or_else(|_| std::env::temp_dir())
}

#[tauri::command]
pub fn app_logs_list(
    level: Option<LogLevel>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Vec<LogEntry> {
    logging::read(level, limit.unwrap_or(DEFAULT_PAGE), offset.unwrap_or(0))
}

#[tauri::command]
pub fn app_logs_stats() -> LogStats {
    logging::stats()
}

#[tauri::command]
pub fn app_logs_export(
    app: AppHandle<impl Runtime>,
    level: Option<LogLevel>,
) -> Result<String, AppError> {
    logging::export(&logging::dir(), &exported_name(&app), level)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| AppError::from_io(&error))
}

#[tauri::command]
pub fn app_logs_open_dir(app: AppHandle<impl Runtime>) -> Result<(), AppError> {
    let dir = logging::dir();
    std::fs::create_dir_all(&dir).map_err(|error| AppError::from_io(&error))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))
}

#[tauri::command]
pub fn app_logs_clear(keep_days: Option<u32>) -> usize {
    logging::clear_older_than(
        &logging::dir(),
        keep_days.map_or(logging::RETENTION_DAYS, u64::from),
    )
}
