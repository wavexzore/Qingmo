//! Meeting commands: task lifecycle, configuration, API keys and models.
//!
//! T-007 registers the full surface together with its permission guards. The
//! business bodies are owned by T-008 (tasks), T-010 (settings/keys) and T-011
//! (models), so every stub intentionally returns `not_implemented`.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use uuid::Uuid;

use crate::commands::settings::{ensure_settings_window, open_settings, SETTINGS_WINDOW_LABEL};
use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{
    KeyStatus, MeetingConfigGetResponse, MeetingConfigPatch, MeetingConfigSetResponse,
    MeetingOutcome, MeetingResult, MeetingRetryResponse, MeetingStartResponse,
    ModelDownloadResponse, ModelView,
};

/// Task and result commands are limited to document windows and the main
/// window; the settings window never starts a meeting.
fn ensure_document_or_main<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    let label = window.label();
    if label == "main" || label.starts_with("doc-") {
        Ok(())
    } else {
        Err(AppError::new(
            AppErrorCode::PermissionDenied,
            "this command is only available to document and main windows",
        ))
    }
}

/// Read-only meeting commands may also run from the settings window.
fn ensure_reading_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    if window.label() == SETTINGS_WINDOW_LABEL {
        return Ok(());
    }
    ensure_document_or_main(window)
}

fn parse_request_id(request_id: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(request_id).map_err(|_| {
        AppError::new(AppErrorCode::InvalidConfig, "requestId must be a UUID")
            .with_details(serde_json::json!({ "field": "request_id" }))
    })
}

#[tauri::command]
pub fn meeting_start<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<MeetingStartResponse, AppError> {
    ensure_document_or_main(&window)?;
    Err(AppError::not_implemented("meeting_start"))
}

#[tauri::command]
pub fn meeting_retry<R: Runtime>(
    window: WebviewWindow<R>,
    request_id: String,
) -> Result<MeetingRetryResponse, AppError> {
    ensure_document_or_main(&window)?;
    parse_request_id(&request_id)?;
    Err(AppError::not_implemented("meeting_retry"))
}

#[tauri::command]
pub fn meeting_cancel<R: Runtime>(
    window: WebviewWindow<R>,
    request_id: String,
) -> Result<(), AppError> {
    ensure_document_or_main(&window)?;
    parse_request_id(&request_id)?;
    Err(AppError::not_implemented("meeting_cancel"))
}

#[tauri::command]
pub fn meeting_status<R: Runtime>(
    window: WebviewWindow<R>,
    request_id: String,
) -> Result<MeetingOutcome, AppError> {
    ensure_document_or_main(&window)?;
    parse_request_id(&request_id)?;
    Err(AppError::not_implemented("meeting_status"))
}

#[tauri::command]
pub fn meeting_take_result<R: Runtime>(
    window: WebviewWindow<R>,
    request_id: String,
) -> Result<Option<MeetingResult>, AppError> {
    ensure_document_or_main(&window)?;
    parse_request_id(&request_id)?;
    Err(AppError::not_implemented("meeting_take_result"))
}

#[tauri::command]
pub fn meeting_config_get<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<MeetingConfigGetResponse, AppError> {
    ensure_reading_window(&window)?;
    Err(AppError::not_implemented("meeting_config_get"))
}

#[tauri::command]
pub fn meeting_config_set<R: Runtime>(
    window: WebviewWindow<R>,
    patch: MeetingConfigPatch,
    expected_revision: u64,
) -> Result<MeetingConfigSetResponse, AppError> {
    ensure_settings_window(&window)?;
    let _ = (patch, expected_revision);
    Err(AppError::not_implemented("meeting_config_set"))
}

#[tauri::command]
pub fn meeting_key_status<R: Runtime>(
    window: WebviewWindow<R>,
    slot: String,
) -> Result<KeyStatus, AppError> {
    ensure_settings_window(&window)?;
    let _ = slot;
    Err(AppError::not_implemented("meeting_key_status"))
}

#[tauri::command]
pub fn meeting_key_set<R: Runtime>(
    window: WebviewWindow<R>,
    slot: String,
    value: String,
) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    let _ = (slot, value);
    Err(AppError::not_implemented("meeting_key_set"))
}

#[tauri::command]
pub fn meeting_key_clear<R: Runtime>(
    window: WebviewWindow<R>,
    slot: String,
    all: Option<bool>,
) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    let _ = (slot, all);
    Err(AppError::not_implemented("meeting_key_clear"))
}

#[tauri::command]
pub fn meeting_models_list<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Vec<ModelView>, AppError> {
    ensure_reading_window(&window)?;
    Err(AppError::not_implemented("meeting_models_list"))
}

#[tauri::command]
pub fn meeting_model_download<R: Runtime>(
    window: WebviewWindow<R>,
    id: String,
) -> Result<ModelDownloadResponse, AppError> {
    ensure_reading_window(&window)?;
    let _ = id;
    Err(AppError::not_implemented("meeting_model_download"))
}

#[tauri::command]
pub fn meeting_model_download_cancel<R: Runtime>(
    window: WebviewWindow<R>,
    download_id: String,
) -> Result<(), AppError> {
    ensure_reading_window(&window)?;
    let _ = download_id;
    Err(AppError::not_implemented("meeting_model_download_cancel"))
}

#[tauri::command]
pub fn meeting_model_remove<R: Runtime>(
    window: WebviewWindow<R>,
    id: String,
) -> Result<(), AppError> {
    ensure_reading_window(&window)?;
    let _ = id;
    Err(AppError::not_implemented("meeting_model_remove"))
}

/// Opens (or focuses) Settings. When the window is already open, `section`
/// navigates it to the matching deep link first.
#[tauri::command]
pub fn app_settings_open<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    section: Option<String>,
) -> Result<(), AppError> {
    ensure_reading_window(&window)?;
    let section = match section.as_deref() {
        None | Some("ai") => section,
        Some(other) => {
            return Err(AppError::new(
                AppErrorCode::InvalidConfig,
                format!("unknown settings section: {other}"),
            ))
        }
    };
    let already_open = app.get_webview_window(SETTINGS_WINDOW_LABEL).is_some();
    open_settings(&app)?;
    if let (true, Some(section)) = (already_open, section) {
        if let Some(settings) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
            if let Err(error) = settings.eval(format!(
                "window.location.assign('settings.html?section={section}')"
            )) {
                tracing::warn!(%error, "failed to navigate the settings window");
            }
            if let Err(error) = settings.set_focus() {
                tracing::warn!(%error, "failed to focus the settings window");
            }
        }
    }
    Ok(())
}
