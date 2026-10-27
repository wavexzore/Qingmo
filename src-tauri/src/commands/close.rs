use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::contract::EVENT_CLOSE_REQUESTED;
use crate::ipc::dto::{CloseReason, CloseRequestedPayload};
use crate::state::{CloseGuard, CloseOutcome, DocumentRegistry, WindowSessions};

/// Emits the CloseGuard event after arming the pending request.
///
/// A window close targets one window; quitting targets every open window so
/// each document flushes before the app exits. Called from the Tauri run
/// callback, so a failed emit must not leave the app permanently unclosable.
pub fn request_close(app: &AppHandle, reason: CloseReason, target: Option<&str>) {
    let guard = app.state::<CloseGuard>();
    let targets: Vec<String> = match reason {
        CloseReason::Window => target.map(str::to_string).into_iter().collect(),
        CloseReason::Exit => app.webview_windows().keys().cloned().collect(),
    };

    if targets.is_empty() {
        if reason == CloseReason::Exit {
            app.exit(0);
        }
        return;
    }

    tracing::info!(?reason, ?target, targets = ?targets, "arming close request");

    if !guard.begin(reason, targets.clone()) {
        tracing::debug!(
            ?reason,
            ?target,
            pending = ?guard.pending(),
            awaiting = ?guard.awaiting(),
            installing = guard.is_installing(),
            exiting = guard.is_exiting(),
            "close request blocked"
        );
        return;
    }

    let mut emitted = true;
    for label in &targets {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        if let Err(error) = window.emit_to(
            label.as_str(),
            EVENT_CLOSE_REQUESTED,
            CloseRequestedPayload {
                reason,
                target: label.clone(),
            },
        ) {
            tracing::error!(
                ?error,
                ?reason,
                window = label,
                "failed to emit close request"
            );
            emitted = false;
        }
    }

    if !emitted {
        guard.cancel();
    }
}

/// Completes or cancels the pending close request for the calling window.
///
/// `allow=true` is accepted only when a native close request is pending for
/// this window and no install/exit is in progress, so a compromised webview
/// cannot terminate the app without the Rust guard.
#[tauri::command]
pub fn app_close_confirm<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    guard: State<'_, CloseGuard>,
    sessions: State<'_, WindowSessions>,
    registry: State<'_, DocumentRegistry>,
    allow: bool,
) -> Result<(), AppError> {
    let label = window.label().to_string();
    tracing::info!(
        window = label,
        allow,
        awaiting = ?guard.awaiting(),
        pending = ?guard.pending(),
        "close confirmation received"
    );
    let outcome = guard.confirm(&label, allow).map_err(|error| {
        tracing::warn!(
            window = label,
            allow,
            awaiting = ?guard.awaiting(),
            ?error,
            "close confirmation rejected"
        );
        error
    })?;
    match outcome {
        CloseOutcome::Cancelled(reason) => {
            tracing::info!(?reason, window = label, "close request cancelled by user");
            Ok(())
        }
        CloseOutcome::Waiting(reason) => {
            tracing::info!(
                ?reason,
                window = label,
                "window confirmed the quit; waiting"
            );
            Ok(())
        }
        CloseOutcome::Allowed(reason) => {
            tracing::info!(?reason, window = label, "close request confirmed");
            if let Some(token) = sessions.release(&label) {
                registry.release(&token);
            }

            if reason == CloseReason::Exit {
                app.exit(0);
                return Ok(());
            }

            let remaining = app
                .webview_windows()
                .keys()
                .filter(|candidate| *candidate != &label)
                .count();
            if remaining == 0 {
                // Closing the last window is the app's exit gesture on both
                // platforms, matching the pre-multi-window behavior.
                app.exit(0);
                return Ok(());
            }

            window.destroy().map_err(|error| {
                AppError::new(
                    AppErrorCode::Io,
                    format!("failed to close the window: {error}"),
                )
            })
        }
    }
}
