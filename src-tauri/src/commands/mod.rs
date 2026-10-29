pub mod about;
pub mod close;
pub mod document;
pub mod locale;
pub mod logs;
pub mod session;
pub mod settings;
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
        about::app_about_info,
        about::app_about_close,
        about::app_about_open_link,
        settings::app_settings_info,
        settings::app_settings_close,
        update::app_update_status,
        update::app_update_check,
        update::app_update_download,
        update::app_update_install,
        logs::app_logs_list,
        logs::app_logs_stats,
        logs::app_logs_export,
        logs::app_logs_open_dir,
        logs::app_logs_clear,
        locale::app_apply_locale,
        session::session_view_state_get,
        session::session_view_state_set,
        session::session_draft_write,
        session::session_draft_list,
        session::session_draft_read,
        session::session_draft_discard,
    ]
}
