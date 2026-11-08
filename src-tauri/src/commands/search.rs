use tauri::{State, WebviewWindow};

use crate::commands::workspace::authorized_token;
use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::SearchResponse;
use crate::services::search_query::{SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET};
use crate::services::SearchIndexService;
use crate::state::{WindowSessions, WorkspaceRegistry};

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub async fn workspace_search<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    workspace_token: String,
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    index: State<'_, SearchIndexService>,
) -> Result<SearchResponse, AppError> {
    let label = window.label().to_string();
    let (_, root) = authorized_token(
        sessions.inner(),
        workspaces.inner(),
        &label,
        &workspace_token,
    )?;
    let index = index.inner().clone();
    let limit = limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);
    let offset = offset.unwrap_or(0).min(SEARCH_MAX_OFFSET);
    tauri::async_runtime::spawn_blocking(move || {
        if !index.is_indexed(&root)
            || index.status(&root).state != crate::ipc::dto::SearchIndexState::Idle
        {
            index.scan_root(&root)?;
        }
        index.search(&root, &query, limit, offset)
    })
    .await
    .map_err(|error| AppError::new(AppErrorCode::Io, format!("search task failed: {error}")))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workspace_search_rebuild<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    workspace_token: String,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
    index: State<'_, SearchIndexService>,
) -> Result<(), AppError> {
    let label = window.label().to_string();
    let (_, root) = authorized_token(
        sessions.inner(),
        workspaces.inner(),
        &label,
        &workspace_token,
    )?;
    let index = index.inner().clone();
    tauri::async_runtime::spawn_blocking(move || index.rebuild(&root))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("search rebuild task failed: {error}"),
            )
        })?
}
