//! CloseGuard generation/attempt lifecycle.
//!
//! These tests drive the state machine directly (no timers): the UI-visible
//! contract is generation-scoped confirmation, a 3s resend and a 30s force.

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::CloseReason;
use qingmo_lib::state::{CloseExpiry, CloseGuard, CloseOutcome};

fn targets(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|label| label.to_string()).collect()
}

#[test]
fn quit_waits_for_every_window_and_keeps_one_generation() {
    let guard = CloseGuard::new();
    let begin = guard
        .begin(CloseReason::Exit, targets(&["main", "doc-1"]))
        .expect("begin");

    assert!(matches!(
        guard.confirm("main", true, begin.generation).unwrap(),
        CloseOutcome::Waiting {
            reason: CloseReason::Exit,
            generation,
            attempt: 1,
        } if generation == begin.generation
    ));
    assert_eq!(guard.awaiting(), vec!["doc-1".to_string()]);

    assert!(matches!(
        guard.confirm("doc-1", true, begin.generation).unwrap(),
        CloseOutcome::Allowed {
            reason: CloseReason::Exit,
            generation,
        } if generation == begin.generation
    ));
    assert!(guard.is_exiting());
    assert_eq!(guard.pending(), None);
}

#[test]
fn a_stale_generation_cannot_confirm_the_next_request() {
    let guard = CloseGuard::new();
    let first = guard
        .begin(CloseReason::Window, targets(&["main"]))
        .expect("first");
    guard.confirm("main", false, first.generation).unwrap();

    let second = guard
        .begin(CloseReason::Window, targets(&["main"]))
        .expect("second");
    assert_ne!(first.generation, second.generation);
    assert_eq!(
        guard
            .confirm("main", true, first.generation)
            .expect_err("stale generation must be rejected")
            .code,
        AppErrorCode::Busy
    );
    assert!(matches!(
        guard.confirm("main", true, second.generation).unwrap(),
        CloseOutcome::Allowed { .. }
    ));
}

#[test]
fn watchdog_resends_only_to_awaiting_windows_then_forces() {
    let guard = CloseGuard::new();
    let begin = guard
        .begin(CloseReason::Exit, targets(&["main", "doc-1"]))
        .expect("begin");
    guard.confirm("main", true, begin.generation).unwrap();

    assert!(matches!(
        guard.expire(begin.generation, 1),
        CloseExpiry::Resend {
            generation,
            attempt: 2,
            targets,
            ..
        } if generation == begin.generation && targets == vec!["doc-1".to_string()]
    ));
    assert_eq!(guard.expire(begin.generation, 1), CloseExpiry::None);
    assert!(matches!(
        guard.expire(begin.generation, 2),
        CloseExpiry::Force {
            reason: CloseReason::Exit,
            generation,
            targets,
        } if generation == begin.generation && targets.len() == 2
    ));
    assert!(guard.is_exiting());
}

#[test]
fn cancel_returns_all_targets_and_rearms_the_guard() {
    let guard = CloseGuard::new();
    let begin = guard
        .begin(CloseReason::Exit, targets(&["main", "doc-1"]))
        .expect("begin");
    let cancelled = guard.cancel().expect("cancel");
    assert!(matches!(
        cancelled,
        CloseOutcome::Cancelled {
            reason: CloseReason::Exit,
            generation,
            targets,
        } if generation == begin.generation
            && targets == vec!["main".to_string(), "doc-1".to_string()]
    ));
    assert!(guard
        .begin(CloseReason::Window, targets(&["main"]))
        .is_some());
}

#[test]
fn a_failed_destroy_rearms_so_the_user_can_retry() {
    let guard = CloseGuard::new();
    let begin = guard
        .begin(CloseReason::Window, targets(&["doc-1"]))
        .expect("begin");
    guard.confirm("doc-1", true, begin.generation).unwrap();
    assert!(guard.begin_destroy(begin.generation));
    guard.end_destroy(false);

    // The failed destroy must not leave `allowed` armed: a new request needs a
    // fresh generation, which is what the command re-emits.
    assert!(!guard.begin_destroy(begin.generation));
    assert!(guard
        .begin(CloseReason::Window, targets(&["doc-1"]))
        .is_some());
}

#[test]
fn an_exit_that_does_not_terminate_is_rolled_back() {
    let guard = CloseGuard::new();
    let begin = guard
        .begin(CloseReason::Exit, targets(&["main"]))
        .expect("begin");
    guard.confirm("main", true, begin.generation).unwrap();
    assert!(guard.is_exiting());
    assert!(!guard.rollback_exit(begin.generation + 1));
    assert!(guard.rollback_exit(begin.generation));
    assert!(!guard.is_exiting());
    assert!(guard.begin(CloseReason::Exit, targets(&["main"])).is_some());
}

#[test]
fn the_install_gate_blocks_close_and_recovers() {
    let guard = CloseGuard::new();
    guard.begin_install().expect("install gate");
    assert!(guard.begin(CloseReason::Exit, targets(&["main"])).is_none());
    assert_eq!(
        guard
            .confirm("main", true, 1)
            .expect_err("install blocks confirm")
            .code,
        AppErrorCode::Busy
    );
    guard.end_install();
    assert!(guard.begin(CloseReason::Exit, targets(&["main"])).is_some());
}

#[test]
fn a_foreign_window_cannot_acknowledge() {
    let guard = CloseGuard::new();
    let begin = guard
        .begin(CloseReason::Window, targets(&["doc-1"]))
        .expect("begin");
    assert_eq!(
        guard
            .confirm("main", true, begin.generation)
            .expect_err("foreign window")
            .code,
        AppErrorCode::Busy
    );
    assert_eq!(guard.awaiting(), vec!["doc-1".to_string()]);
}
