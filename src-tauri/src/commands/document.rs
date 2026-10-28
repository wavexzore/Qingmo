use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, SaveResult};
use crate::services::AtomicWriter;
use crate::state::document_registry::ensure_supported_extension;
use crate::state::{DocumentRegistry, DocumentWatcher, FocusTracker, WindowSessions};

/// Native window title for an open document.
///
/// The macOS window is the document surface, so the file name belongs in the
/// title bar rather than in a second in-app header.
pub(crate) fn window_title_for(path: &Path, app_name: &str) -> String {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => format!("{name} — {app_name}"),
        None => app_name.to_string(),
    }
}

/// Opens the selected file in a new document window.
///
/// The current window is deliberately left untouched; the payload is staged
/// for the new window, which consumes it on boot through
/// `document_take_pending`. The command returns `null` because the caller has
/// nothing to adopt.
#[tauri::command]
pub async fn document_open(app: State<'_, AppHandle>) -> Result<(), AppError> {
    let app = app.inner().clone();
    let path = pick_document(&app).await?;
    open_path_in_new_window(app, path).await
}

/// Asks the native dialog for one document.
async fn pick_document(app: &AppHandle) -> Result<PathBuf, AppError> {
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

    selected.into_path().map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("the dialog returned an unreadable path: {error}"),
        )
    })
}

/// Opens a path that was already chosen by the native dialog or delivered by
/// the operating system (Finder, `open(1)`, a drop target).
///
/// The payload is staged before the window exists, so the window can consume
/// it on boot through `document_take_pending`. The caller owns user-visible
/// error reporting: the dialog command forwards it over IPC, the OS handler
/// only logs it.
pub(crate) async fn open_path_in_new_window(app: AppHandle, path: PathBuf) -> Result<(), AppError> {
    let registry = app.state::<DocumentRegistry>().inner().clone();
    let sessions = app.state::<WindowSessions>().inner().clone();

    let open_registry = registry.clone();
    let payload = tauri::async_runtime::spawn_blocking(move || open_registry.open_path(path))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document open task failed: {error}"),
            )
        })??;

    let app_name = app
        .state::<crate::state::ShellLocale>()
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    let title = window_title_for(Path::new(&payload.path), &app_name);
    let doc_token = payload.doc_token.clone();
    let label = format!("doc-{}", uuid::Uuid::new_v4());
    sessions.stage(&label, payload);

    let built = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App("index.html?window=document".into()),
    )
    .title(title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .focused(true)
    .build();

    match built {
        Ok(window) => {
            tracing::info!(window = %label, "opened a document window");
            app.state::<FocusTracker>().set(&label);
            if let Err(error) = window.set_focus() {
                tracing::warn!(%error, "failed to focus the document window");
            }
        }
        Err(error) => {
            sessions.discard_pending(&label);
            registry.release(&doc_token);
            return Err(AppError::new(
                AppErrorCode::Io,
                format!("failed to create the document window: {error}"),
            ));
        }
    }

    Ok(())
}

/// Filters the URLs delivered by an OS open request down to supported files.
///
/// macOS also delivers directories (for example when a folder is dropped on
/// the dock icon) and unrelated files; opening a window for those would only
/// fail after the fact. Unsupported URLs are skipped silently.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn opened_paths(urls: &[Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| ensure_supported_extension(path).is_ok() && path.is_file())
        .collect()
}

/// Windows delivers a file association as a plain command-line path; macOS
/// uses `RunEvent::Opened` instead. Skip the executable and any flags, and
/// keep the files the registry accepts so a stray argument cannot fail the
/// launch before a window exists.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn startup_paths<I>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .filter(|path| ensure_supported_extension(path).is_ok() && path.is_file())
        .collect()
}

/// Hands the staged document to the window that was created for it.
#[tauri::command]
pub fn document_take_pending<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    sessions: State<'_, WindowSessions>,
    registry: State<'_, DocumentRegistry>,
) -> Result<Option<FilePayload>, AppError> {
    let payload = sessions.take_pending(window.label());
    tracing::info!(
        window = window.label(),
        has_payload = payload.is_some(),
        "document window consumed its pending payload"
    );

    // Start watching only after the window has consumed its payload, so the
    // first event cannot be emitted before the webview has installed its
    // listener.
    if let Some(current) = payload.as_ref() {
        if let Ok(record) = registry.get(&current.doc_token) {
            let path = record.canonical_target.clone();
            drop(record);
            if let Some(watcher) = window.try_state::<DocumentWatcher>() {
                watcher.watch(&current.doc_token, &path);
            }
        }
    }

    Ok(payload)
}

#[tauri::command]
pub async fn document_save_as<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    registry: State<'_, DocumentRegistry>,
    sessions: State<'_, WindowSessions>,
    locale: State<'_, crate::state::ShellLocale>,
    text: String,
) -> Result<FilePayload, AppError> {
    let registry = registry.inner().clone();
    let watch_registry = registry.clone();
    let sessions = sessions.inner().clone();
    let untitled_file_name = locale.untitled_file_name();
    let app_name = locale
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    let (sender, receiver) = tokio::sync::oneshot::channel();

    window
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(&untitled_file_name)
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

    if let Err(error) = window.set_title(&window_title_for(Path::new(&payload.path), &app_name)) {
        tracing::warn!(%error, "failed to update the window title");
    }
    sessions.set_token(window.label(), payload.doc_token.clone());
    if let Ok(record) = watch_registry.get(&payload.doc_token) {
        let path = record.canonical_target.clone();
        drop(record);
        if let Some(watcher) = window.try_state::<DocumentWatcher>() {
            watcher.watch(&payload.doc_token, &path);
        }
    }
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
    use super::{opened_paths, startup_paths, window_title_for};
    use std::path::Path;
    use tauri::Url;

    #[test]
    fn window_title_uses_the_document_file_name() {
        assert_eq!(
            window_title_for(Path::new("/docs/note.md"), "Qingmo"),
            "note.md — Qingmo"
        );
        assert_eq!(window_title_for(Path::new("/"), "青墨"), "青墨");
        assert_eq!(
            window_title_for(Path::new("/docs/note.md"), "青墨"),
            "note.md — 青墨"
        );
    }

    #[test]
    fn os_open_paths_keep_supported_files_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        let markdown = dir.path().join("note.md");
        let mdx = dir.path().join("component.MDX");
        let text = dir.path().join("notes.txt");
        for path in [&markdown, &mdx, &text] {
            std::fs::write(path, "body").expect("write fixture");
        }

        let urls = [
            Url::from_file_path(&markdown).expect("markdown url"),
            Url::from_file_path(&mdx).expect("mdx url"),
            Url::from_file_path(&text).expect("text url"),
            Url::from_file_path(dir.path()).expect("directory url"),
            Url::parse("https://example.com/note.md").expect("remote url"),
        ];

        assert_eq!(opened_paths(&urls), vec![markdown, mdx]);
    }

    #[test]
    fn startup_paths_skip_the_executable_flags_and_unsupported_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let markdown = dir.path().join("note.md");
        let text = dir.path().join("notes.txt");
        for path in [&markdown, &text] {
            std::fs::write(path, "body").expect("write fixture");
        }

        let args = vec![
            std::ffi::OsString::from("C:\\Program Files\\Qingmo\\qingmo.exe"),
            std::ffi::OsString::from("--flag"),
            markdown.clone().into_os_string(),
            text.into_os_string(),
            dir.path().join("missing.md").into_os_string(),
        ];

        assert_eq!(startup_paths(args), vec![markdown]);
    }

    #[test]
    fn os_open_paths_drop_missing_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("gone.md");

        assert!(opened_paths(&[Url::from_file_path(&missing).expect("url")]).is_empty());
    }
}
