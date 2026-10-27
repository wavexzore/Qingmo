use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::ipc::contract::EVENT_CLOSE_REQUESTED;
use crate::ipc::dto::{CloseReason, CloseRequestedPayload};
use crate::state::CloseGuard;

/// Emits the single CloseGuard event after arming the pending flag.
///
/// Called from the Tauri run callback, so a failed emit must not leave the
/// window permanently unclosable.
pub fn request_close(app: &AppHandle, reason: CloseReason) {
    let guard = app.state::<CloseGuard>();
    if !guard.begin(reason) {
        tracing::debug!(
            ?reason,
            pending = ?guard.pending(),
            installing = guard.is_installing(),
            exiting = guard.is_exiting(),
            "close request blocked"
        );
        return;
    }

    if let Err(error) = app.emit(EVENT_CLOSE_REQUESTED, CloseRequestedPayload { reason }) {
        tracing::error!(?error, ?reason, "failed to emit close request");
        guard.cancel();
    }
}

/// Completes or cancels the pending close request.
///
/// `allow=true` is accepted only when a native close request is pending and
/// no install/exit is in progress, so a compromised webview cannot terminate
/// the app without the Rust guard.
#[tauri::command(rename_all = "camelCase")]
pub fn app_close_confirm<R: tauri::Runtime>(
    app: AppHandle<R>,
    guard: State<'_, CloseGuard>,
    allow: bool,
) -> Result<(), AppError> {
    let reason = guard.confirm(allow)?;

    if !allow {
        tracing::info!(?reason, "close request cancelled by user");
        return Ok(());
    }

    tracing::info!(?reason, "close request confirmed; exiting");
    app.exit(0);
    Ok(())
}
