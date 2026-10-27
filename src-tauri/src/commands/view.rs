use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::state::PreviewModes;

/// Records this window's Live Preview mode and updates the native checkmark.
///
/// The webview reports the effective mode (startup default, menu toggle, or
/// command palette); Rust never infers it from a click, so all entry points
/// keep the "显示 → 实时预览" item in sync. Failure to update the menu is not a
/// document error, so it is logged rather than surfaced to the editor.
#[tauri::command]
pub fn app_set_live_preview<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    live_preview: bool,
) {
    app.state::<PreviewModes>()
        .set(window.label(), live_preview);
    if let Err(error) = crate::set_live_preview_checked(&app, live_preview) {
        tracing::warn!(%error, "failed to update the live preview menu state");
    }
}
