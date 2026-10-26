use crate::error::AppError;
use crate::ipc::dto::{FilePayload, SaveResult};

/// Contract stubs. T-005/T-006/T-012 replace the bodies; names and signatures
/// are frozen by `src-tauri/tests/commands_contract.rs`.
#[tauri::command]
pub fn document_open() -> Result<FilePayload, AppError> {
    Err(AppError::not_implemented("document_open"))
}

#[tauri::command(rename_all = "camelCase")]
#[allow(unused_variables)]
pub fn document_reload(doc_token: String) -> Result<FilePayload, AppError> {
    Err(AppError::not_implemented("document_reload"))
}

#[tauri::command(rename_all = "camelCase")]
#[allow(unused_variables)]
pub fn document_write_atomic(
    doc_token: String,
    text: String,
    expected_current_hash: Option<String>,
) -> Result<SaveResult, AppError> {
    Err(AppError::not_implemented("document_write_atomic"))
}

#[tauri::command(rename_all = "camelCase")]
#[allow(unused_variables)]
pub fn app_close_confirm(allow: bool) -> Result<(), AppError> {
    Err(AppError::not_implemented("app_close_confirm"))
}
