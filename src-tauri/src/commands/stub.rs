use crate::error::AppError;

/// Contract stub. T-012 replaces the body; the name and signature are frozen
/// by `src-tauri/tests/commands_contract.rs`.
#[tauri::command(rename_all = "camelCase")]
#[allow(unused_variables)]
pub fn app_close_confirm(allow: bool) -> Result<(), AppError> {
    Err(AppError::not_implemented("app_close_confirm"))
}
