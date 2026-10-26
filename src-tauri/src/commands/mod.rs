pub mod stub;

/// The single invoke handler registered by the app and by contract tests.
pub fn handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
{
    tauri::generate_handler![
        stub::document_open,
        stub::document_reload,
        stub::document_write_atomic,
        stub::app_close_confirm,
    ]
}
