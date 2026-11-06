use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, WorkspaceInfo, WorkspaceListing};
use crate::services::workspace_service::{self, MAX_LISTED};
use crate::state::{
    DocumentRegistry, WindowSessions, WorkspaceRegistry, WorkspaceToken, WorkspaceWatcher,
};

const WORKSPACE_IO_TIMEOUT: Duration = Duration::from_secs(15);

/// Reconciles the OS watcher set after any window token change.
pub(crate) fn sync_workspace_watchers<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(watcher) = app.try_state::<WorkspaceWatcher>() {
        watcher.sync_watchers();
    }
}

fn cancelled() -> AppError {
    AppError::new(AppErrorCode::Cancelled, "workspace dialog was cancelled")
}

fn timed_out() -> AppError {
    AppError::new(AppErrorCode::Io, "the workspace operation timed out")
}

fn join_error<E: std::fmt::Display>(context: &str, error: E) -> AppError {
    AppError::new(AppErrorCode::Io, format!("{context}: {error}"))
}

fn probe_directory(path: PathBuf) -> Result<PathBuf, AppError> {
    let canonical = std::fs::canonicalize(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(AppErrorCode::NotFound, "workspace root not found")
        } else {
            AppError::from_io(&error)
        }
    })?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| AppError::from_io(&error))?;
    if !metadata.is_dir() {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "workspace root is not a directory",
        ));
    }
    // Make sure the directory can actually be enumerated now; otherwise the
    // first tree load would fail after the workspace was already committed.
    std::fs::read_dir(&canonical)
        .map_err(|error| AppError::from_io(&error))?
        .next()
        .transpose()
        .map_err(|error| AppError::from_io(&error))?;
    Ok(canonical)
}

/// Queues one blocking workspace operation on the runtime pool.
///
/// On timeout the caller returns immediately; a detached task still awaits the
/// same handle so a late document token can be released.
async fn run_blocking<T, F>(task: F, context: &'static str) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    let mut handle = tauri::async_runtime::spawn_blocking(task);
    match tokio::time::timeout(WORKSPACE_IO_TIMEOUT, &mut handle).await {
        Ok(result) => result.map_err(|error| join_error(context, error))?,
        Err(_) => {
            tauri::async_runtime::spawn(async move {
                let _ = handle.await;
            });
            Err(timed_out())
        }
    }
}

/// Releases a stale token the calling window still held.
///
/// The compare-and-remove is the authority: a concurrent switch to another
/// workspace is left untouched. Returns true when a token was released so the
/// caller can resync watchers.
fn clear_stale_token(
    sessions: &WindowSessions,
    workspaces: &WorkspaceRegistry,
    label: &str,
) -> bool {
    if let Some(token) = sessions.workspace_for(label) {
        if workspaces.get(&token).is_err() {
            if let Some(stale) = sessions.take_workspace_if(label, &token) {
                workspaces.release(&stale);
                return true;
            }
        }
    }
    false
}

fn authorized_token(
    sessions: &WindowSessions,
    workspaces: &WorkspaceRegistry,
    label: &str,
    raw: &str,
) -> Result<(WorkspaceToken, PathBuf), AppError> {
    let token = WorkspaceToken::parse(raw)?;
    if !sessions.owns_workspace(label, &token) {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "invalid or expired workspaceToken",
        ));
    }
    match workspaces.get(&token) {
        Ok(record) => Ok((token, record.root.clone())),
        Err(error) => Err(error),
    }
}

/// Opens a folder picker and commits the selected root to the calling window.
#[tauri::command]
pub async fn workspace_open<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
) -> Result<WorkspaceInfo, AppError> {
    let label = window.label().to_string();
    let sessions = sessions.inner().clone();
    let workspaces = workspaces.inner().clone();
    // Capture the write generation before the dialog. A main-window rebuild or
    // a concurrent switch makes this request stale instead of overwriting it.
    let epoch = sessions.epoch(&label);

    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.dialog().file().pick_folder(move |selected| {
        let _ = sender.send(selected);
    });

    let selected = receiver
        .await
        .map_err(|_| cancelled())?
        .ok_or_else(cancelled)?;
    let path = selected
        .into_path()
        .map_err(|error| AppError::new(AppErrorCode::InvalidPath, error.to_string()))?;

    // The dialog is modal to the window, but the window can still be destroyed
    // from the OS while it is open.
    if app.get_webview_window(&label).is_none() || sessions.is_closed(&label) {
        return Err(AppError::new(
            AppErrorCode::Cancelled,
            "the window was closed",
        ));
    }

    let canonical = run_blocking(move || probe_directory(path), "workspace probe failed").await?;
    let (token, record) = workspaces.open_canonical(canonical);
    match sessions.set_workspace(&label, token.clone(), epoch) {
        Ok(previous) => {
            // Reopening the same root must retry a previously failed watcher.
            let previous_root = previous
                .as_ref()
                .and_then(|token| workspaces.get(token).ok())
                .map(|record| record.root.clone());
            if let Some(previous) = previous {
                workspaces.release(&previous);
            }
            if previous_root.as_deref() == Some(record.root.as_path()) {
                if let Some(watcher) = app.try_state::<WorkspaceWatcher>() {
                    // A healthy watcher stays; only a previously failed root is
                    // rebuilt on reopen.
                    if watcher
                        .failed_roots()
                        .iter()
                        .any(|failed| failed == &record.root)
                    {
                        watcher.rearm_root(&record.root);
                    }
                }
            }
            sync_workspace_watchers(&app);
            Ok(record.info(&token))
        }
        Err(error) => {
            // The window closed or another switch won; this token was never
            // taken over by the session.
            workspaces.release(&token);
            sync_workspace_watchers(&app);
            Err(error)
        }
    }
}

/// Returns the calling window's current workspace, or `null`.
#[tauri::command]
pub fn workspace_current<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
) -> Result<Option<WorkspaceInfo>, AppError> {
    let label = window.label();
    let Some(token) = sessions.workspace_for(label) else {
        sync_workspace_watchers(&app);
        return Ok(None);
    };
    match workspaces.get(&token) {
        Ok(record) => {
            // Idempotent fallback for a child window booting after a fork.
            sync_workspace_watchers(&app);
            Ok(Some(record.info(&token)))
        }
        Err(_) => {
            clear_stale_token(&sessions, &workspaces, label);
            sync_workspace_watchers(&app);
            Ok(None)
        }
    }
}

/// Lists one directory level under the calling window's workspace.
#[tauri::command(async, rename_all = "camelCase")]
pub async fn workspace_list<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    workspace_token: String,
    dir_segments: Vec<String>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
) -> Result<WorkspaceListing, AppError> {
    let label = window.label().to_string();
    let sessions = sessions.inner().clone();
    let workspaces = workspaces.inner().clone();
    let (token, root) = match authorized_token(&sessions, &workspaces, &label, &workspace_token) {
        Ok(value) => value,
        Err(error) => {
            clear_stale_token(&sessions, &workspaces, &label);
            sync_workspace_watchers(&app);
            return Err(error);
        }
    };

    run_blocking(
        move || {
            let _ = token;
            workspace_service::list_directory_with_limit(&root, &dir_segments, MAX_LISTED)
        },
        "workspace list failed",
    )
    .await
}

/// Reads one file from the tree for an in-window document switch.
///
/// The payload is registered but not yet owned by the window: the webview
/// adopts it and calls `document_activate` only after the current document has
/// been preserved, which keeps a failed switch recoverable.
#[tauri::command(async, rename_all = "camelCase")]
pub async fn workspace_open_document<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    workspace_token: String,
    segments: Vec<String>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    documents: State<'_, DocumentRegistry>,
) -> Result<FilePayload, AppError> {
    let label = window.label().to_string();
    let sessions = sessions.inner().clone();
    let workspaces = workspaces.inner().clone();
    let documents = documents.inner().clone();
    let root = match authorized_token(&sessions, &workspaces, &label, &workspace_token) {
        Ok((_, root)) => root,
        Err(error) => {
            clear_stale_token(&sessions, &workspaces, &label);
            sync_workspace_watchers(&app);
            return Err(error);
        }
    };
    let jail_root = root.clone();

    let resolved = run_blocking(
        move || workspace_service::resolve_document(&root, &segments),
        "workspace document resolution failed",
    )
    .await?;

    let payload =
        crate::commands::document::open_document(documents, resolved, Some(jail_root)).await?;
    crate::commands::document::allow_document_assets(&app, std::path::Path::new(&payload.path));
    Ok(payload)
}

/// Locates the calling window's current document inside its workspace.
///
/// Read-only: a stale token returns `null` and is never cleaned here.
#[tauri::command(rename_all = "camelCase")]
pub fn workspace_locate_document<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    workspace_token: String,
    doc_token: String,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    documents: State<'_, DocumentRegistry>,
) -> Result<Option<Vec<String>>, AppError> {
    let label = window.label();
    let token = WorkspaceToken::parse(&workspace_token)?;
    if !sessions.owns_workspace(label, &token) {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "invalid or expired workspaceToken",
        ));
    }
    let Ok(record) = workspaces.get(&token) else {
        return Ok(None);
    };
    if doc_token == "untitled" || sessions.token_for(label).as_deref() != Some(&doc_token) {
        return Ok(None);
    }
    let Ok(document) = documents.get(&doc_token) else {
        return Ok(None);
    };
    let Ok(relative) = document.canonical_target.strip_prefix(&record.root) else {
        return Ok(None);
    };
    if relative.as_os_str().is_empty() {
        return Ok(None);
    }
    let mut segments = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Ok(None);
        };
        let Some(name) = name.to_str() else {
            return Ok(None);
        };
        // Paths that cannot be represented as a tree segment are not shown.
        if workspace_service::validate_segment(name).is_err() {
            return Ok(None);
        }
        segments.push(name.to_string());
    }
    Ok(Some(segments))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn probe_accepts_directories_and_rejects_files_and_missing_paths() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        assert_eq!(probe_directory(root.clone()).expect("directory"), root);

        let file = root.join("note.md");
        std::fs::write(&file, "body").expect("file");
        assert_eq!(
            probe_directory(file).expect_err("file").code,
            AppErrorCode::InvalidPath
        );
        assert_eq!(
            probe_directory(root.join("missing"))
                .expect_err("missing")
                .code,
            AppErrorCode::NotFound
        );
    }

    #[test]
    fn authorized_token_requires_window_ownership() {
        let sessions = WindowSessions::new();
        let workspaces = WorkspaceRegistry::new();
        let root = Path::new("/tmp");
        let (token, _) = workspaces.open_canonical(root.to_path_buf());
        sessions
            .set_workspace("doc-1", token.clone(), 0)
            .expect("workspace");

        assert_eq!(
            authorized_token(&sessions, &workspaces, "doc-1", token.as_str())
                .expect("owner")
                .1,
            root
        );
        assert_eq!(
            authorized_token(&sessions, &workspaces, "doc-2", token.as_str())
                .expect_err("foreign window")
                .code,
            AppErrorCode::InvalidPath
        );
    }
}
