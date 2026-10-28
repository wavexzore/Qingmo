use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::NativeShellLabels;

/// Stable label and size for the custom settings window.
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
const SETTINGS_WINDOW_WIDTH: f64 = 1120.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 720.0;

/// The settings window has no document state, so every command is scoped to it.
fn ensure_settings_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    if window.label() == SETTINGS_WINDOW_LABEL {
        Ok(())
    } else {
        Err(AppError::new(
            AppErrorCode::PermissionDenied,
            "this command is only available to the settings window",
        ))
    }
}

fn settings_window_title(labels: Option<NativeShellLabels>) -> String {
    labels
        .map(|labels| labels.settings)
        .unwrap_or_else(|| "Settings".to_string())
}

/// Opens the settings window, or focuses it when it is already open.
///
/// It mirrors the Folio prototype: fixed 1120 × 720, no native decorations,
/// transparent corners and a webview-drawn title bar. Keeping it out of the
/// taskbar matches the About window and keeps the app’s window list document
/// focused.
pub fn open_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window.show().map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("failed to show the settings window: {error}"),
            )
        })?;
        let _ = window.unminimize();
        window.set_focus().map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("failed to focus the settings window: {error}"),
            )
        })?;
        return Ok(());
    }

    let title = settings_window_title(app.state::<crate::state::ShellLocale>().labels());
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("settings.html".into()),
    )
    .title(title)
    .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(true)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .skip_taskbar(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .center()
    .focused(true)
    .build()
    .map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("failed to create the settings window: {error}"),
        )
    })?;

    if let Err(error) = window.set_focus() {
        tracing::warn!(%error, "failed to focus the settings window");
    }
    Ok(())
}

#[tauri::command]
pub fn app_settings_info<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<String, AppError> {
    ensure_settings_window(&window)?;
    Ok(app.package_info().version.to_string())
}

#[tauri::command]
pub fn app_settings_close<R: Runtime>(window: WebviewWindow<R>) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    window.destroy().map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("failed to close the settings window: {error}"),
        )
    })
}
