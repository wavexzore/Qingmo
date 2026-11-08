use std::collections::HashSet;
use std::sync::Mutex;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::CloseReason;

/// One armed close request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloseBegin {
    pub generation: u64,
    pub attempt: u32,
}

/// Result of one window confirming or cancelling the pending close request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseOutcome {
    /// Every target must stop closing and re-enable its UI.
    Cancelled {
        reason: CloseReason,
        generation: u64,
        targets: Vec<String>,
    },
    /// This window confirmed, but other windows still have to confirm.
    Waiting {
        reason: CloseReason,
        generation: u64,
        attempt: u32,
    },
    /// Every target confirmed; the caller performs the close/exit.
    Allowed {
        reason: CloseReason,
        generation: u64,
    },
}

/// Result of the 3s/30s watchdog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseExpiry {
    None,
    /// Re-emit the request for the windows that have not acknowledged.
    Resend {
        reason: CloseReason,
        generation: u64,
        attempt: u32,
        targets: Vec<String>,
    },
    /// Force the close after the second deadline.
    Force {
        reason: CloseReason,
        generation: u64,
        targets: Vec<String>,
    },
}

#[derive(Debug)]
struct PendingClose {
    generation: u64,
    attempt: u32,
    reason: CloseReason,
    targets: Vec<String>,
    awaiting: HashSet<String>,
}

#[derive(Debug, Clone, Copy)]
struct AllowedClose {
    generation: u64,
}

#[derive(Debug, Default)]
struct Inner {
    pending: Option<PendingClose>,
    allowed: Option<AllowedClose>,
    installing: bool,
    exiting: bool,
    exit_generation: Option<u64>,
    next_generation: u64,
}

/// Tracks the native close request that is waiting for webview confirmation.
///
/// Generation/attempt make stale confirmations inert; `allowed` separates
/// "everyone confirmed" from "destroy/exit is in progress"; `exiting` is only
/// set for Exit semantics and can be rolled back after a failed/animated exit.
#[derive(Debug, Default)]
pub struct CloseGuard {
    inner: Mutex<Inner>,
}

impl CloseGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms the guard. Returns the generation and attempt for the emitted
    /// event, or `None` when another close/install/exit owns the gate.
    pub fn begin<I>(&self, reason: CloseReason, targets: I) -> Option<CloseBegin>
    where
        I: IntoIterator<Item = String>,
    {
        let mut inner = self.lock();
        if inner.pending.is_some() || inner.installing || inner.exiting {
            return None;
        }
        let targets: Vec<String> = targets.into_iter().collect();
        if targets.is_empty() {
            return None;
        }
        inner.next_generation = inner.next_generation.saturating_add(1);
        let generation = inner.next_generation;
        inner.pending = Some(PendingClose {
            generation,
            attempt: 1,
            reason,
            awaiting: targets.iter().cloned().collect(),
            targets,
        });
        Some(CloseBegin {
            generation,
            attempt: 1,
        })
    }

    pub fn begin_install(&self) -> Result<(), AppError> {
        let mut inner = self.lock();
        if inner.pending.is_some() || inner.installing || inner.exiting {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "a close request or update install is already in progress",
            ));
        }
        inner.installing = true;
        Ok(())
    }

    pub fn end_install(&self) {
        self.lock().installing = false;
    }

    pub fn confirm(
        &self,
        window: &str,
        allow: bool,
        generation: u64,
    ) -> Result<CloseOutcome, AppError> {
        let mut inner = self.lock();
        if inner.installing || inner.exiting {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the application is installing an update or already exiting",
            ));
        }
        let pending = inner.pending.as_mut().ok_or_else(|| {
            AppError::new(AppErrorCode::Busy, "no pending close request to confirm")
        })?;
        if pending.generation != generation {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the close confirmation belongs to a stale request",
            ));
        }
        if !pending.awaiting.contains(window) {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the pending close request belongs to another window",
            ));
        }

        if !allow {
            let pending = inner.pending.take().expect("pending checked above");
            return Ok(CloseOutcome::Cancelled {
                reason: pending.reason,
                generation: pending.generation,
                targets: pending.targets,
            });
        }

        let generation = pending.generation;
        let attempt = pending.attempt;
        let reason = pending.reason;
        pending.awaiting.remove(window);
        if !pending.awaiting.is_empty() {
            return Ok(CloseOutcome::Waiting {
                reason,
                generation,
                attempt,
            });
        }

        inner.pending = None;
        inner.allowed = Some(AllowedClose { generation });
        if reason == CloseReason::Exit {
            inner.exiting = true;
            inner.exit_generation = Some(generation);
        }
        Ok(CloseOutcome::Allowed { reason, generation })
    }

    /// Clears the pending request without confirming it (for example an emit
    /// failure). Returns the targets that should receive a cancel event.
    pub fn cancel(&self) -> Option<CloseOutcome> {
        let pending = self.lock().pending.take()?;
        Some(CloseOutcome::Cancelled {
            reason: pending.reason,
            generation: pending.generation,
            targets: pending.targets,
        })
    }

    /// Advances the watchdog for one generation.
    pub fn expire(&self, generation: u64, attempt: u32) -> CloseExpiry {
        let mut inner = self.lock();
        let Some(pending) = inner.pending.as_mut() else {
            return CloseExpiry::None;
        };
        if pending.generation != generation || pending.attempt != attempt {
            return CloseExpiry::None;
        }
        if attempt == 1 {
            pending.attempt = 2;
            return CloseExpiry::Resend {
                reason: pending.reason,
                generation,
                attempt: 2,
                targets: pending.awaiting.iter().cloned().collect(),
            };
        }
        let pending = inner.pending.take().expect("pending checked above");
        if pending.reason == CloseReason::Exit {
            inner.exiting = true;
            inner.exit_generation = Some(generation);
        }
        CloseExpiry::Force {
            reason: pending.reason,
            generation,
            targets: pending.targets,
        }
    }

    /// Claims the destroy/exit action for an allowed generation.
    pub fn begin_destroy(&self, generation: u64) -> bool {
        let mut inner = self.lock();
        if inner
            .allowed
            .is_some_and(|allowed| allowed.generation == generation)
        {
            inner.allowed = None;
            true
        } else {
            false
        }
    }

    /// Completes a destroy attempt. A failed destroy must re-arm later.
    pub fn end_destroy(&self, success: bool) {
        let mut inner = self.lock();
        if !success {
            inner.allowed = None;
            inner.exiting = false;
            inner.exit_generation = None;
        }
    }

    /// Clears `exiting` if `app.exit` did not terminate within the grace window.
    pub fn rollback_exit(&self, generation: u64) -> bool {
        let mut inner = self.lock();
        if inner.exit_generation == Some(generation) && inner.exiting {
            inner.exiting = false;
            inner.exit_generation = None;
            inner.allowed = None;
            true
        } else {
            false
        }
    }

    pub fn pending(&self) -> Option<CloseReason> {
        self.lock().pending.as_ref().map(|pending| pending.reason)
    }

    /// Generation of the pending request, for command-side validation.
    pub fn pending_generation(&self) -> Option<u64> {
        self.lock()
            .pending
            .as_ref()
            .map(|pending| pending.generation)
    }

    pub fn awaiting(&self) -> Vec<String> {
        self.lock()
            .pending
            .as_ref()
            .map(|pending| pending.awaiting.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn is_installing(&self) -> bool {
        self.lock().installing
    }

    pub fn is_exiting(&self) -> bool {
        self.lock().exiting
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|label| label.to_string()).collect()
    }

    #[test]
    fn allows_only_one_pending_request() {
        let guard = CloseGuard::new();
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_some());
        assert!(guard.begin(CloseReason::Exit, targets(&["main"])).is_none());
        assert_eq!(guard.pending(), Some(CloseReason::Window));
        assert!(matches!(
            guard
                .confirm("main", false, guard.pending_generation().unwrap())
                .unwrap(),
            CloseOutcome::Cancelled {
                reason: CloseReason::Window,
                ..
            }
        ));
        assert_eq!(guard.pending(), None);
    }

    #[test]
    fn cancel_rearms_the_guard_and_returns_targets() {
        let guard = CloseGuard::new();
        let begin = guard
            .begin(CloseReason::Exit, targets(&["main", "doc-1"]))
            .expect("begin");
        let cancelled = guard.cancel().expect("cancel");
        assert!(matches!(
            cancelled,
            CloseOutcome::Cancelled {
                reason: CloseReason::Exit,
                targets,
                ..
            } if targets.len() == 2
        ));
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_some());
        let _ = begin;
    }

    #[test]
    fn quitting_waits_for_every_window_and_sets_exiting() {
        let guard = CloseGuard::new();
        let begin = guard
            .begin(CloseReason::Exit, targets(&["main", "doc-1"]))
            .expect("begin");
        assert!(matches!(
            guard.confirm("main", true, guard.pending_generation().unwrap()).unwrap(),
            CloseOutcome::Waiting {
                reason: CloseReason::Exit,
                generation,
                ..
            } if generation == begin.generation
        ));
        assert_eq!(guard.awaiting(), vec!["doc-1".to_string()]);
        assert!(matches!(
            guard
                .confirm("doc-1", true, guard.pending_generation().unwrap())
                .unwrap(),
            CloseOutcome::Allowed {
                reason: CloseReason::Exit,
                ..
            }
        ));
        assert!(guard.is_exiting());
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_none());
    }

    #[test]
    fn one_window_cancel_stops_the_quit() {
        let guard = CloseGuard::new();
        guard
            .begin(CloseReason::Exit, targets(&["main", "doc-1"]))
            .expect("begin");
        assert!(matches!(
            guard
                .confirm("main", true, guard.pending_generation().unwrap())
                .unwrap(),
            CloseOutcome::Waiting { .. }
        ));
        assert!(matches!(
            guard
                .confirm("doc-1", false, guard.pending_generation().unwrap())
                .unwrap(),
            CloseOutcome::Cancelled {
                reason: CloseReason::Exit,
                ..
            }
        ));
        assert_eq!(guard.pending(), None);
        assert!(!guard.is_exiting());
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_some());
    }

    #[test]
    fn stale_generation_and_attempt_never_advance_the_watchdog() {
        let guard = CloseGuard::new();
        let begin = guard
            .begin(CloseReason::Window, targets(&["doc-1"]))
            .expect("begin");
        assert_eq!(guard.expire(begin.generation + 1, 1), CloseExpiry::None);
        assert_eq!(guard.expire(begin.generation, 2), CloseExpiry::None);
        assert!(matches!(
            guard.expire(begin.generation, 1),
            CloseExpiry::Resend { attempt: 2, .. }
        ));
        assert_eq!(guard.expire(begin.generation, 1), CloseExpiry::None);
        assert!(matches!(
            guard.expire(begin.generation, 2),
            CloseExpiry::Force { .. }
        ));
    }

    #[test]
    fn allowed_generation_is_required_for_destroy_and_can_be_rearmed() {
        let guard = CloseGuard::new();
        let begin = guard
            .begin(CloseReason::Window, targets(&["doc-1"]))
            .expect("begin");
        assert!(matches!(
            guard
                .confirm("doc-1", true, guard.pending_generation().unwrap())
                .unwrap(),
            CloseOutcome::Allowed { .. }
        ));
        assert!(!guard.begin_destroy(begin.generation + 1));
        assert!(guard.begin_destroy(begin.generation));
        guard.end_destroy(false);
        assert!(guard
            .begin(CloseReason::Window, targets(&["doc-1"]))
            .is_some());
    }

    #[test]
    fn exit_can_be_rolled_back_with_the_matching_generation() {
        let guard = CloseGuard::new();
        let begin = guard
            .begin(CloseReason::Exit, targets(&["main"]))
            .expect("begin");
        assert!(matches!(
            guard
                .confirm("main", true, guard.pending_generation().unwrap())
                .unwrap(),
            CloseOutcome::Allowed { .. }
        ));
        assert!(guard.is_exiting());
        assert!(!guard.rollback_exit(begin.generation + 1));
        assert!(guard.rollback_exit(begin.generation));
        assert!(!guard.is_exiting());
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_some());
    }

    #[test]
    fn install_and_close_share_the_same_gate() {
        let guard = CloseGuard::new();
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_some());
        assert!(guard.begin_install().is_err());
        guard.cancel();

        assert!(guard.begin_install().is_ok());
        assert!(guard.is_installing());
        assert!(guard
            .begin(CloseReason::Window, targets(&["main"]))
            .is_none());
        assert_eq!(
            guard
                .confirm("main", true, 1)
                .expect_err("install must block confirm")
                .code,
            AppErrorCode::Busy
        );
        guard.end_install();
        assert!(guard.begin(CloseReason::Exit, targets(&["main"])).is_some());
    }

    #[test]
    fn a_foreign_window_cannot_confirm() {
        let guard = CloseGuard::new();
        guard
            .begin(CloseReason::Window, targets(&["doc-1"]))
            .expect("begin");
        assert_eq!(
            guard
                .confirm("main", true, guard.pending_generation().unwrap())
                .expect_err("foreign window must be rejected")
                .code,
            AppErrorCode::Busy
        );
    }
}
