//! Session view-state and crash-draft commands.
//!
//! Every command clones the shared `SessionStore` before awaiting
//! `spawn_blocking`; no `State<'_, T>` borrow is held across an await point.
//! The store owns validation, atomic writes, GC and permissions.

use std::path::Path;

use tauri::{State, WebviewWindow};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{
    DraftMeta, DraftRecord, DraftWriteRequest, EditorViewState, EditorViewStateInput,
};
use crate::services::document_identity::{DocumentId, PathKey};
use crate::services::session_store::SessionStore;
use crate::state::{DocumentRegistry, WindowSessions, WorkspaceRegistry};

fn join_error(error: tauri::Error) -> AppError {
    AppError::new(
        AppErrorCode::Io,
        format!("session storage task failed: {error}"),
    )
}

fn invalid_token() -> AppError {
    AppError::new(AppErrorCode::InvalidPath, "invalid or expired docToken")
}

fn outside_scope() -> AppError {
    AppError::new(
        AppErrorCode::OutsideScope,
        "the view-state path is outside the window's document scope",
    )
}

/// Authorizes one view-state path.
///
/// With a `docToken`, the window must own that exact document and the path
/// must be its canonical target. Without one (legacy callers), the path must
/// be the window's current canonical target or inside its workspace root.
fn authorize_view_path(
    label: &str,
    path: &str,
    doc_token: Option<&str>,
    sessions: &WindowSessions,
    workspaces: &WorkspaceRegistry,
    documents: &DocumentRegistry,
) -> Result<Option<DocumentId>, AppError> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(outside_scope());
    }
    let target_key = PathKey::from_path(target);

    if let Some(token) = doc_token {
        if !sessions.owns_current_document(label, token) {
            return Err(invalid_token());
        }
        let record = documents.get(token)?;
        if !record.is_active() {
            return Err(invalid_token());
        }
        let canonical = record.canonical_target()?;
        if PathKey::from_path(&canonical) != target_key {
            return Err(invalid_token());
        }
        return Ok(record.document_id());
    }

    if let Some(token) = sessions.token_for(label) {
        if let Ok(record) = documents.get(&token) {
            if record
                .canonical_target()
                .map(|canonical| PathKey::from_path(&canonical) == target_key)
                .unwrap_or(false)
            {
                return Ok(record.document_id());
            }
        }
    }

    if let Some(workspace_token) = sessions.workspace_for(label) {
        if let Ok(workspace) = workspaces.get(&workspace_token) {
            let root = PathKey::from_path(&workspace.root);
            if root.is_prefix_of(&target_key) {
                return Ok(None);
            }
        }
    }

    Err(outside_scope())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn session_view_state_get<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    store: State<'_, SessionStore>,
    path: String,
    doc_token: Option<String>,
    registry: State<'_, DocumentRegistry>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
) -> Result<Option<EditorViewState>, AppError> {
    let document_id = authorize_view_path(
        window.label(),
        &path,
        doc_token.as_deref(),
        sessions.inner(),
        workspaces.inner(),
        registry.inner(),
    )?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(
        move || Ok(store.view_get_for(&path, document_id.as_ref())),
    )
    .await
    .map_err(join_error)?
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub async fn session_view_state_set<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    store: State<'_, SessionStore>,
    path: String,
    state: EditorViewStateInput,
    doc_token: Option<String>,
    registry: State<'_, DocumentRegistry>,
    sessions: State<'_, WindowSessions>,
    workspaces: State<'_, WorkspaceRegistry>,
) -> Result<(), AppError> {
    let document_id = authorize_view_path(
        window.label(),
        &path,
        doc_token.as_deref(),
        sessions.inner(),
        workspaces.inner(),
        registry.inner(),
    )?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.view_set_for(&path, document_id.as_ref(), state)
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn view_path_requires_the_owned_token_and_its_canonical_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.md");
        fs::write(&path, "body").expect("fixture");
        let registry = DocumentRegistry::new();
        let sessions = WindowSessions::new();
        let workspaces = WorkspaceRegistry::new();
        let payload = registry.open_path(path).expect("open");
        sessions.set_token("main", payload.doc_token.clone());

        assert!(authorize_view_path(
            "main",
            &payload.path,
            Some(&payload.doc_token),
            &sessions,
            &workspaces,
            &registry
        )
        .is_ok());

        let wrong_window = authorize_view_path(
            "doc-2",
            &payload.path,
            Some(&payload.doc_token),
            &sessions,
            &workspaces,
            &registry,
        )
        .expect_err("another window must not use the token");
        assert_eq!(wrong_window.code, AppErrorCode::InvalidPath);

        let wrong_path = authorize_view_path(
            "main",
            "/etc/passwd.md",
            Some(&payload.doc_token),
            &sessions,
            &workspaces,
            &registry,
        )
        .expect_err("a token only authorizes its own canonical path");
        assert_eq!(wrong_path.code, AppErrorCode::InvalidPath);
    }

    #[test]
    fn legacy_view_path_is_confined_to_the_window_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        let outside = tempfile::tempdir().expect("outside");
        let outside = fs::canonicalize(outside.path()).expect("canonical outside");
        let registry = DocumentRegistry::new();
        let sessions = WindowSessions::new();
        let workspaces = WorkspaceRegistry::new();

        let outside_path = outside.join("other.md");
        let error = authorize_view_path(
            "main",
            &outside_path.to_string_lossy(),
            None,
            &sessions,
            &workspaces,
            &registry,
        )
        .expect_err("an untokened window cannot write outside its workspace");
        assert_eq!(error.code, AppErrorCode::OutsideScope);

        let (workspace, _) = workspaces.open_canonical(root.clone());
        sessions
            .set_workspace("main", workspace, 0)
            .expect("workspace");
        assert!(authorize_view_path(
            "main",
            &root.join("inside.md").to_string_lossy(),
            None,
            &sessions,
            &workspaces,
            &registry
        )
        .is_ok());
    }
}
