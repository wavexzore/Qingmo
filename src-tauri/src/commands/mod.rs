pub mod close;
pub mod document;
pub mod update;
pub mod view;

/// The single invoke handler registered by the app and by contract tests.
pub fn handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
{
    tauri::generate_handler![
        document::document_open,
        document::document_take_pending,
        document::document_reload,
        document::document_save_as,
        document::document_write_atomic,
        close::app_close_confirm,
        view::app_set_live_preview,
        update::app_update_status,
        update::app_update_check,
        update::app_update_download,
        update::app_update_install,
    ]
}
