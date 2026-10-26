use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{CloseReason, CloseRequestedPayload};
use crate::ipc::EVENTS;
use crate::state::CloseGuard;

/// Emits the single CloseGuard event after arming the pending flag.
///
/// Called from the Tauri run callback, so a failed emit must not leave the
/// window permanently unclosable.
pub fn request_close(app: &AppHandle, reason: CloseReason) {
    let guard = app.state::<CloseGuard>();
    if !guard.begin(reason) {
        tracing::debug!(?reason, "close request already pending");
        return;
    }

    if let Err(error) = app.emit(EVENTS[0], CloseRequestedPayload { reason }) {
        tracing::error!(?error, ?reason, "failed to emit close request");
        guard.cancel();
    }
}

/// Completes or cancels the pending close request.
///
/// `allow=true` is accepted only when a native close request is pending, so a
/// compromised webview cannot terminate the app without the Rust guard.
#[tauri::command(rename_all = "camelCase")]
pub fn app_close_confirm<R: tauri::Runtime>(
    app: AppHandle<R>,
    guard: State<'_, CloseGuard>,
    allow: bool,
) -> Result<(), AppError> {
    let reason = guard
        .take()
        .ok_or_else(|| AppError::new(AppErrorCode::Busy, "no pending close request to confirm"))?;

    if !allow {
        tracing::info!(?reason, "close request cancelled by user");
        return Ok(());
    }

    tracing::info!(?reason, "close request confirmed; exiting");
    app.exit(0);
    Ok(())
}
