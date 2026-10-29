//! Session view-state and crash-draft commands.
//!
//! Every command clones the shared `SessionStore` before awaiting
//! `spawn_blocking`; no `State<'_, T>` borrow is held across an await point.
//! The store owns validation, atomic writes, GC and permissions.

use tauri::State;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{
    DraftMeta, DraftRecord, DraftWriteRequest, EditorViewState, EditorViewStateInput,
};
use crate::services::session_store::SessionStore;

fn join_error(error: tauri::Error) -> AppError {
    AppError::new(
        AppErrorCode::Io,
        format!("session storage task failed: {error}"),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_view_state_get(
    store: State<'_, SessionStore>,
    path: String,
) -> Result<Option<EditorViewState>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Ok(store.view_get(&path)))
        .await
        .map_err(join_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_view_state_set(
    store: State<'_, SessionStore>,
    path: String,
    state: EditorViewStateInput,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.view_set(&path, state))
        .await
        .map_err(join_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_draft_write(
    store: State<'_, SessionStore>,
    request: DraftWriteRequest,
) -> Result<DraftMeta, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.draft_write(request))
        .await
        .map_err(join_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_draft_list(
    store: State<'_, SessionStore>,
) -> Result<Vec<DraftMeta>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.draft_list())
        .await
        .map_err(join_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_draft_read(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<DraftRecord, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.draft_read(&id))
        .await
        .map_err(join_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_draft_discard(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<bool, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.draft_discard(&id))
        .await
        .map_err(join_error)?
}
