use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::about::ABOUT_WINDOW_LABEL;
use crate::error::{AppError, AppErrorCode};
use crate::ipc::contract::EVENT_CLOSE_REQUESTED;
use crate::ipc::dto::{CloseReason, CloseRequestedPayload};
use crate::state::{CloseGuard, CloseOutcome, DocumentRegistry, WindowSessions};

/// Resolves the windows that must confirm a close.
///
/// The About window holds no document state and is deliberately excluded from
/// app exit: `app.exit` closes it with every other window, and waiting for a
/// close confirmation it cannot send would deadlock quitting.
fn close_targets(reason: CloseReason, target: Option<&str>, open: Vec<String>) -> Vec<String> {
    match reason {
        CloseReason::Window => target.map(str::to_string).into_iter().collect(),
        CloseReason::Exit => open
            .into_iter()
            .filter(|label| label != ABOUT_WINDOW_LABEL)
            .collect(),
    }
}

/// Counts windows that can keep the app alive after one editable window closes.
///
/// The About window is auxiliary: closing the last document while About is
/// open must still follow the app's "last window exits" gesture instead of
/// leaving an About window that can no longer open files.
fn remaining_editable_windows(open: Vec<String>, closing: &str) -> usize {
    open.into_iter()
        .filter(|label| label != closing && label != ABOUT_WINDOW_LABEL)
        .count()
}

/// Emits the CloseGuard event after arming the pending request.
///
/// A window close targets one window; quitting targets every open window so
/// each document flushes before the app exits. Called from the Tauri run
/// callback, so a failed emit must not leave the app permanently unclosable.
pub fn request_close(app: &AppHandle, reason: CloseReason, target: Option<&str>) {
    let guard = app.state::<CloseGuard>();
    let targets = close_targets(
        reason,
        target,
        app.webview_windows().keys().cloned().collect(),
    );

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

            let remaining =
                remaining_editable_windows(app.webview_windows().keys().cloned().collect(), &label);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn exit_ignores_the_about_window() {
        let targets = close_targets(
            CloseReason::Exit,
            None,
            labels(&["main", "doc-1", ABOUT_WINDOW_LABEL]),
        );

        assert_eq!(targets, labels(&["main", "doc-1"]));
    }

    #[test]
    fn an_about_only_exit_resolves_to_no_pending_targets() {
        let targets = close_targets(CloseReason::Exit, None, labels(&[ABOUT_WINDOW_LABEL]));

        assert!(targets.is_empty());
    }

    #[test]
    fn window_close_keeps_its_explicit_target() {
        let targets = close_targets(
            CloseReason::Window,
            Some("doc-1"),
            labels(&["main", "doc-1", ABOUT_WINDOW_LABEL]),
        );

        assert_eq!(targets, labels(&["doc-1"]));
    }

    #[test]
    fn the_about_window_never_keeps_the_app_alive() {
        assert_eq!(
            remaining_editable_windows(labels(&["doc-1", ABOUT_WINDOW_LABEL]), "doc-1"),
            0
        );
        assert_eq!(
            remaining_editable_windows(labels(&["main", "about"]), "main"),
            0
        );
        assert_eq!(
            remaining_editable_windows(labels(&["main", "doc-1", ABOUT_WINDOW_LABEL]), "doc-1"),
            1
        );
    }
}
