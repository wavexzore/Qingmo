use std::path::Path;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, SaveResult};
use crate::services::AtomicWriter;
use crate::state::DocumentRegistry;

/// Native window title for an open document.
///
/// The macOS window is the document surface, so the file name belongs in the
/// title bar rather than in a second in-app header.
pub(crate) fn window_title_for(path: &Path) -> String {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => format!("{name} — 青墨"),
        None => "青墨".to_string(),
    }
}

fn set_document_title<R: tauri::Runtime>(app: &AppHandle<R>, path: &Path) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.set_title(&window_title_for(path)) {
            tracing::warn!(%error, "failed to update the window title");
        }
    }
}

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

    let payload = tauri::async_runtime::spawn_blocking(move || registry.open_path(path))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document open task failed: {error}"),
            )
        })??;

    set_document_title(app.inner(), Path::new(&payload.path));
    Ok(payload)
}

#[tauri::command]
pub async fn document_save_as(
    app: State<'_, AppHandle>,
    registry: State<'_, DocumentRegistry>,
    text: String,
) -> Result<FilePayload, AppError> {
    let registry = registry.inner().clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name("未命名.md")
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });

    let selected = receiver
        .await
        .map_err(|_| AppError::new(AppErrorCode::Cancelled, "save dialog was closed"))?
        .ok_or_else(|| AppError::new(AppErrorCode::Cancelled, "save dialog was cancelled"))?;

    let path = selected.into_path().map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("the save dialog returned an unreadable path: {error}"),
        )
    })?;

    let payload = tauri::async_runtime::spawn_blocking(move || registry.save_as(path, &text))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document save-as task failed: {error}"),
            )
        })??;

    set_document_title(app.inner(), Path::new(&payload.path));
    Ok(payload)
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

#[tauri::command(rename_all = "camelCase")]
pub async fn document_write_atomic(
    doc_token: String,
    text: String,
    expected_current_hash: Option<String>,
    registry: State<'_, DocumentRegistry>,
) -> Result<SaveResult, AppError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let record = registry.get(&doc_token)?;
        AtomicWriter::write(&record, &text, expected_current_hash.as_deref())
    })
    .await
    .map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("document write task failed: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::window_title_for;
    use std::path::Path;

    #[test]
    fn window_title_uses_the_document_file_name() {
        assert_eq!(
            window_title_for(Path::new("/docs/note.md")),
            "note.md — 青墨"
        );
        assert_eq!(window_title_for(Path::new("/")), "青墨");
    }
}
