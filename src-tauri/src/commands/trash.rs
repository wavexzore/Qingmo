use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::commands::workspace::authorized_token;
use crate::error::AppError;
use crate::ipc::dto::{TrashEntry, TrashRestoreMode, TrashRestoreResult};
use crate::services::workspace_service;
use crate::services::{FileLockStore, SearchIndexService, TrashStore};
use crate::state::{DocumentRegistry, WindowSessions, WorkspaceRegistry};

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_delete<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    workspace_token: String,
    segments: Vec<String>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    documents: State<'_, DocumentRegistry>,
    trash: State<'_, TrashStore>,
    locks: State<'_, FileLockStore>,
) -> Result<TrashEntry, AppError> {
    let label = window.label().to_string();
    let (_, root) = authorized_token(
        sessions.inner(),
        workspaces.inner(),
        &label,
        &workspace_token,
    )?;
    let root_for_task = root.clone();
    let segments_for_task = segments.clone();
    let documents_for_task = documents.inner().clone();
    let trash = trash.inner().clone();
    let locks = locks.inner().clone();
    let entry = tauri::async_runtime::spawn_blocking(move || {
        let resolved = workspace_service::resolve_delete(&root_for_task, &segments_for_task)?;
        trash.delete(&root_for_task, &resolved.raw_path, Some(&locks), |path| {
            documents_for_task.is_path_open(path)
        })
    })
    .await
    .map_err(|error| {
        AppError::new(
            crate::error::AppErrorCode::Io,
            format!("trash delete task failed: {error}"),
        )
    })??;
    if let Some(index) = app.try_state::<SearchIndexService>() {
        if let Ok(resolved) = workspace_service::resolve_delete(&root, &segments) {
            // A symlink row is indexed by its link path, never by the target.
            index.remove_path(&root, &resolved.raw_path);
        }
    }
    crate::commands::workspace::sync_workspace_watchers(&app);
    Ok(entry)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workspace_trash_list<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    workspace_token: String,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    trash: State<'_, TrashStore>,
) -> Result<Vec<TrashEntry>, AppError> {
    let label = window.label().to_string();
    let (_, root) = authorized_token(
        sessions.inner(),
        workspaces.inner(),
        &label,
        &workspace_token,
    )?;
    let trash = trash.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Ok(trash.list(&root)))
        .await
        .map_err(|error| {
            AppError::new(
                crate::error::AppErrorCode::Io,
                format!("trash list task failed: {error}"),
            )
        })?
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_trash_restore<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    workspace_token: String,
    entry_id: String,
    mode: TrashRestoreMode,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    documents: State<'_, DocumentRegistry>,
    trash: State<'_, TrashStore>,
    locks: State<'_, FileLockStore>,
) -> Result<TrashRestoreResult, AppError> {
    let label = window.label().to_string();
    let (_, root) = authorized_token(
        sessions.inner(),
        workspaces.inner(),
        &label,
        &workspace_token,
    )?;
    let root_for_task = root.clone();
    let documents_for_task = documents.inner().clone();
    let trash = trash.inner().clone();
    let locks = locks.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        trash.restore(&root_for_task, &entry_id, mode, Some(&locks), |path| {
            documents_for_task.is_path_open(path)
        })
    })
    .await
    .map_err(|error| {
        AppError::new(
            crate::error::AppErrorCode::Io,
            format!("trash restore task failed: {error}"),
        )
    })??;
    crate::commands::workspace::sync_workspace_watchers(&app);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workspace_trash_purge<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    workspace_token: String,
    entry_id: String,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    trash: State<'_, TrashStore>,
) -> Result<(), AppError> {
    let label = window.label().to_string();
    let (_, root) = authorized_token(
        sessions.inner(),
        workspaces.inner(),
        &label,
        &workspace_token,
    )?;
    let trash = trash.inner().clone();
    tauri::async_runtime::spawn_blocking(move || trash.purge(&root, &entry_id))
        .await
        .map_err(|error| {
            AppError::new(
                crate::error::AppErrorCode::Io,
                format!("trash purge task failed: {error}"),
            )
        })?
}
