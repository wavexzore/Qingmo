use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::about::ABOUT_WINDOW_LABEL;
use crate::commands::settings::SETTINGS_WINDOW_LABEL;
use crate::error::AppError;
use crate::ipc::contract::{EVENT_CLOSE_CANCELLED, EVENT_CLOSE_REQUESTED};
use crate::ipc::dto::{CloseCancelledPayload, CloseReason, CloseRequestedPayload};
use crate::state::{
    CloseBegin, CloseExpiry, CloseGuard, CloseOutcome, DocumentRegistry, DocumentWatcher,
    WindowSessions, WorkspaceRegistry,
};

pub const CLOSE_RESEND_MS: u64 = 3_000;
pub const CLOSE_FORCE_MS: u64 = 30_000;
pub const CLOSE_EXIT_GRACE_MS: u64 = 2_000;

/// Windows that never hold document state.
pub(crate) fn is_auxiliary_window(label: &str) -> bool {
    label == ABOUT_WINDOW_LABEL || label == SETTINGS_WINDOW_LABEL
}

fn close_targets(reason: CloseReason, target: Option<&str>, open: Vec<String>) -> Vec<String> {
    match reason {
        CloseReason::Window => target.map(str::to_string).into_iter().collect(),
        CloseReason::Exit => open
            .into_iter()
            .filter(|label| !is_auxiliary_window(label))
            .collect(),
    }
}

fn remaining_editable_windows(open: Vec<String>, closing: &str) -> usize {
    open.into_iter()
        .filter(|label| label != closing && !is_auxiliary_window(label))
        .count()
}

fn emit_close_request<R: tauri::Runtime>(
    app: &AppHandle<R>,
    targets: &[String],
    reason: CloseReason,
    generation: u64,
    attempt: u32,
) -> bool {
    let mut emitted = true;
    for label in targets {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        if let Err(error) = window.emit_to(
            label.as_str(),
            EVENT_CLOSE_REQUESTED,
            CloseRequestedPayload {
                reason,
                target: label.clone(),
                generation,
                attempt,
            },
        ) {
            tracing::error!(
                ?error,
                ?reason,
                window = label,
                generation,
                attempt,
                "failed to emit close request"
            );
            emitted = false;
        }
    }
    emitted
}

fn emit_cancelled<R: tauri::Runtime>(
    app: &AppHandle<R>,
    targets: &[String],
    reason: CloseReason,
    generation: u64,
) {
    for label in targets {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.emit_to(
                label.as_str(),
                EVENT_CLOSE_CANCELLED,
                CloseCancelledPayload { reason, generation },
            ) {
                tracing::warn!(?error, window = label, "failed to emit close cancellation");
            }
        }
    }
}

/// Emits the first CloseGuard event and arms the 3s/30s watchdog.
pub fn request_close<R: tauri::Runtime>(
    app: &AppHandle<R>,
    reason: CloseReason,
    target: Option<&str>,
) {
    let guard = app.state::<CloseGuard>();
    let targets = close_targets(
        reason,
        target,
        app.webview_windows().keys().cloned().collect(),
    );

    if targets.is_empty() {
        if reason == CloseReason::Exit {
            crate::state::session_restore::capture_windows_before_exit(app);
            app.exit(0);
        }
        return;
    }

    tracing::info!(?reason, ?target, targets = ?targets, "arming close request");
    let Some(begin) = guard.begin(reason, targets.clone()) else {
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
    };

    if !emit_close_request(app, &targets, reason, begin.generation, begin.attempt) {
        if let Some(CloseOutcome::Cancelled {
            reason,
            generation,
            targets,
        }) = guard.cancel()
        {
            emit_cancelled(app, &targets, reason, generation);
        }
        return;
    }
    spawn_close_watchdog(app.clone(), begin);
}

fn spawn_close_watchdog<R: tauri::Runtime>(app: AppHandle<R>, begin: CloseBegin) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(CLOSE_RESEND_MS)).await;
        let expiry = app
            .state::<CloseGuard>()
            .expire(begin.generation, begin.attempt);
        if let CloseExpiry::Resend {
            reason,
            generation,
            attempt,
            targets,
        } = expiry
        {
            tracing::warn!(reason = ?reason, generation, attempt, "close request timed out; resending");
            let _ = emit_close_request(&app, &targets, reason, generation, attempt);
        }

        tokio::time::sleep(Duration::from_millis(
            CLOSE_FORCE_MS.saturating_sub(CLOSE_RESEND_MS),
        ))
        .await;
        let expiry = app
            .state::<CloseGuard>()
            .expire(begin.generation, begin.attempt + 1);
        if let CloseExpiry::Force {
            reason,
            generation,
            targets,
        } = expiry
        {
            tracing::error!(reason = ?reason, generation, "forcing close after watchdog deadline");
            force_close(&app, reason, &targets, generation);
        }
    });
}

fn force_close<R: tauri::Runtime>(
    app: &AppHandle<R>,
    reason: CloseReason,
    targets: &[String],
    generation: u64,
) {
    match reason {
        CloseReason::Exit => {
            crate::state::session_restore::capture_windows_before_exit(app);
            app.exit(0);
            spawn_exit_rollback(app.clone(), Some(generation));
        }
        CloseReason::Window => {
            for label in targets {
                if let Some(window) = app.get_webview_window(label) {
                    if let Err(error) = window.destroy() {
                        tracing::error!(%error, window = label, "forced window destroy failed");
                    }
                }
            }
        }
    }
}

fn spawn_exit_rollback<R: tauri::Runtime>(app: AppHandle<R>, generation: Option<u64>) {
    let Some(generation) = generation else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(CLOSE_EXIT_GRACE_MS)).await;
        if app.state::<CloseGuard>().rollback_exit(generation) {
            tracing::warn!(generation, "app.exit did not terminate; close guard reset");
            if app.webview_windows().is_empty() {
                crate::ensure_main_window(&app);
            }
        }
    });
}

/// Releases every token owned by a window and stops its watchers.
pub(crate) fn release_window_state<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) {
    let released = app.state::<WindowSessions>().release(label);
    for token in [released.doc_token, released.previous_doc_token]
        .into_iter()
        .flatten()
    {
        app.state::<DocumentRegistry>().release(&token);
        if let Some(watcher) = app.try_state::<DocumentWatcher>() {
            watcher.unwatch(&token);
        }
    }
    if let Some(token) = released.workspace_token {
        app.state::<WorkspaceRegistry>().release(&token);
    }
    crate::commands::workspace::sync_workspace_watchers(app);
}

/// Completes or cancels the pending close request for the calling window.
#[tauri::command]
pub fn app_close_confirm<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    guard: State<'_, CloseGuard>,
    allow: bool,
    generation: u64,
) -> Result<(), AppError> {
    let label = window.label().to_string();
    tracing::info!(
        window = label,
        allow,
        generation,
        awaiting = ?guard.awaiting(),
        pending = ?guard.pending(),
        "close confirmation received"
    );
    let outcome = guard.confirm(&label, allow, generation).map_err(|error| {
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
        CloseOutcome::Cancelled {
            reason,
            generation,
            targets,
        } => {
            tracing::info!(?reason, window = label, "close request cancelled by user");
            emit_cancelled(&app, &targets, reason, generation);
            Ok(())
        }
        CloseOutcome::Waiting {
            reason,
            generation,
            attempt,
        } => {
            tracing::info!(
                ?reason,
                window = label,
                generation,
                attempt,
                "window confirmed the quit; waiting"
            );
            Ok(())
        }
        CloseOutcome::Allowed { reason, generation } => {
            tracing::info!(
                ?reason,
                window = label,
                generation,
                "close request confirmed"
            );
            let remaining =
                remaining_editable_windows(app.webview_windows().keys().cloned().collect(), &label);
            if reason == CloseReason::Exit || remaining == 0 {
                // Capture intent before app.exit; do not release the last
                // window first, or the snapshot would be empty.
                crate::state::session_restore::capture_windows_before_exit(&app);
                app.exit(0);
                spawn_exit_rollback(app.clone(), Some(generation));
                return Ok(());
            }

            if !guard.begin_destroy(generation) {
                return Ok(());
            }
            match window.destroy() {
                Ok(()) => guard.end_destroy(true),
                Err(error) => {
                    // The window is still alive; re-arm so the user can retry.
                    guard.end_destroy(false);
                    tracing::warn!(%error, window = label, "window destroy failed; re-arming");
                    request_close(&app, CloseReason::Window, Some(label.as_str()));
                }
            }
            Ok(())
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
    fn exit_ignores_auxiliary_windows() {
        let targets = close_targets(
            CloseReason::Exit,
            None,
            labels(&["main", "doc-1", ABOUT_WINDOW_LABEL, SETTINGS_WINDOW_LABEL]),
        );
        assert_eq!(targets, labels(&["main", "doc-1"]));
    }

    #[test]
    fn an_auxiliary_only_exit_resolves_to_no_pending_targets() {
        let targets = close_targets(
            CloseReason::Exit,
            None,
            labels(&[ABOUT_WINDOW_LABEL, SETTINGS_WINDOW_LABEL]),
        );
        assert!(targets.is_empty());
    }

    #[test]
    fn window_close_keeps_its_explicit_target() {
        let targets = close_targets(
            CloseReason::Window,
            Some("doc-1"),
            labels(&["main", "doc-1", ABOUT_WINDOW_LABEL, SETTINGS_WINDOW_LABEL]),
        );
        assert_eq!(targets, labels(&["doc-1"]));
    }

    #[test]
    fn auxiliary_windows_never_keep_the_app_alive() {
        assert_eq!(
            remaining_editable_windows(labels(&["doc-1", ABOUT_WINDOW_LABEL]), "doc-1"),
            0
        );
        assert_eq!(
            remaining_editable_windows(labels(&["doc-1", SETTINGS_WINDOW_LABEL]), "doc-1"),
            0
        );
        assert_eq!(
            remaining_editable_windows(labels(&["main", "about"]), "main"),
            0
        );
        assert_eq!(
            remaining_editable_windows(
                labels(&["main", "doc-1", ABOUT_WINDOW_LABEL, SETTINGS_WINDOW_LABEL]),
                "doc-1"
            ),
            1
        );
    }
}
