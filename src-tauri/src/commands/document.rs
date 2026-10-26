use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::FilePayload;
use crate::state::DocumentRegistry;

#[tauri::command]
pub async fn document_open(
    app: State<'_, AppHandle>,
    registry: State<'_, DocumentRegistry>,
) -> Result<FilePayload, AppError> {
    let registry = registry.inner().clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdx"])
        .pick_file(move |selected| {
            let _ = sender.send(selected);
        });

    let selected = receiver
        .await
        .map_err(|_| AppError::new(AppErrorCode::Cancelled, "file dialog was closed"))?
        .ok_or_else(|| AppError::new(AppErrorCode::Cancelled, "file dialog was cancelled"))?;

    let path = selected.into_path().map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("the dialog returned an unreadable path: {error}"),
        )
    })?;

    tauri::async_runtime::spawn_blocking(move || registry.open_path(path))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document open task failed: {error}"),
            )
        })?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn document_reload(
    doc_token: String,
    registry: State<'_, DocumentRegistry>,
) -> Result<FilePayload, AppError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.reload(&doc_token))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document reload task failed: {error}"),
            )
        })?
}
