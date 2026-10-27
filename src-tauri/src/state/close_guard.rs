use std::collections::HashSet;
use std::sync::Mutex;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::CloseReason;

/// Result of one window confirming or cancelling the pending close request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseOutcome {
    /// The request was cancelled; nothing closes.
    Cancelled(CloseReason),
    /// This window confirmed, but other windows still have to confirm.
    Waiting(CloseReason),
    /// Every target confirmed; the caller performs the close/exit.
    Allowed(CloseReason),
}

#[derive(Debug)]
struct PendingClose {
    reason: CloseReason,
    awaiting: HashSet<String>,
}

#[derive(Debug, Default)]
struct Inner {
    pending: Option<PendingClose>,
    installing: bool,
    exiting: bool,
}

/// Tracks the native close request that is waiting for one or more webviews.
///
/// A window close targets one label; quitting targets every open window so no
/// document is skipped. `pending`, `installing`, and `exiting` share one mutex
/// so a close request cannot be inserted between an install gate check and the
/// state transition.
#[derive(Debug, Default)]
pub struct CloseGuard {
    inner: Mutex<Inner>,
}

impl CloseGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms the guard for a window close or an application quit.
    ///
    /// Returns false when a request/install/exit already owns the gate.
    pub fn begin<I>(&self, reason: CloseReason, targets: I) -> bool
    where
        I: IntoIterator<Item = String>,
    {
        let mut inner = self.lock();
        if inner.pending.is_some() || inner.installing || inner.exiting {
            return false;
        }
        let awaiting: HashSet<String> = targets.into_iter().collect();
        if awaiting.is_empty() {
            return false;
        }
        inner.pending = Some(PendingClose { reason, awaiting });
        true
    }

    /// Arms the install gate. A pending close request or an existing install wins.
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

    /// Releases the install gate after a failed install.
    pub fn end_install(&self) {
        self.lock().installing = false;
    }

    /// Completes the pending close request for one window.
    ///
    /// `allow=false` clears the request for every window. `allow=true` waits
    /// for the remaining targets; only the last confirmation becomes
    /// [`CloseOutcome::Allowed`].
    pub fn confirm(&self, window: &str, allow: bool) -> Result<CloseOutcome, AppError> {
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
        if !pending.awaiting.contains(window) {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the pending close request belongs to another window",
            ));
        }

        if !allow {
            let reason = pending.reason;
            inner.pending = None;
            return Ok(CloseOutcome::Cancelled(reason));
        }

        let reason = pending.reason;
        pending.awaiting.remove(window);
        if !pending.awaiting.is_empty() {
            return Ok(CloseOutcome::Waiting(reason));
        }

        inner.pending = None;
        if reason == CloseReason::Exit {
            inner.exiting = true;
        }
        Ok(CloseOutcome::Allowed(reason))
    }

    /// Clears the pending request without confirming it (event emit failure).
    pub fn cancel(&self) {
        self.lock().pending = None;
    }

    pub fn pending(&self) -> Option<CloseReason> {
        self.lock().pending.as_ref().map(|pending| pending.reason)
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
        assert!(guard.begin(CloseReason::Window, targets(&["main"])));
        assert!(!guard.begin(CloseReason::Exit, targets(&["main"])));
        assert_eq!(guard.pending(), Some(CloseReason::Window));
        assert_eq!(
            guard.confirm("main", false).unwrap(),
            CloseOutcome::Cancelled(CloseReason::Window)
        );
        assert_eq!(guard.pending(), None);
    }

    #[test]
    fn cancel_rearms_the_guard() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Exit, targets(&["main"])));
        guard.cancel();
        assert!(guard.begin(CloseReason::Window, targets(&["main"])));
        assert_eq!(
            guard.confirm("main", false).unwrap(),
            CloseOutcome::Cancelled(CloseReason::Window)
        );
    }

    #[test]
    fn quitting_waits_for_every_window() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Exit, targets(&["main", "doc-1"])));

        assert_eq!(
            guard.confirm("main", true).unwrap(),
            CloseOutcome::Waiting(CloseReason::Exit)
        );
        assert_eq!(guard.awaiting(), vec!["doc-1".to_string()]);
        assert_eq!(
            guard.confirm("doc-1", true).unwrap(),
            CloseOutcome::Allowed(CloseReason::Exit)
        );
        assert!(guard.is_exiting());
        assert!(!guard.begin(CloseReason::Window, targets(&["main"])));
    }

    #[test]
    fn one_window_cancel_stops_the_quit() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Exit, targets(&["main", "doc-1"])));
        assert_eq!(
            guard.confirm("main", true).unwrap(),
            CloseOutcome::Waiting(CloseReason::Exit)
        );
        assert_eq!(
            guard.confirm("doc-1", false).unwrap(),
            CloseOutcome::Cancelled(CloseReason::Exit)
        );
        assert_eq!(guard.pending(), None);
        assert!(!guard.is_exiting());
        assert!(guard.begin(CloseReason::Window, targets(&["main"])));
    }

    #[test]
    fn a_window_that_is_not_a_target_cannot_confirm() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Window, targets(&["doc-1"])));
        assert_eq!(
            guard
                .confirm("main", true)
                .expect_err("foreign window must be rejected")
                .code,
            AppErrorCode::Busy
        );
        assert_eq!(
            guard.confirm("doc-1", true).unwrap(),
            CloseOutcome::Allowed(CloseReason::Window)
        );
    }

    #[test]
    fn install_and_close_share_the_same_gate() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Window, targets(&["main"])));
        assert!(guard.begin_install().is_err());
        guard.cancel();

        assert!(guard.begin_install().is_ok());
        assert!(guard.is_installing());
        assert!(!guard.begin(CloseReason::Window, targets(&["main"])));
        assert_eq!(
            guard
                .confirm("main", true)
                .expect_err("install must block confirm")
                .code,
            AppErrorCode::Busy
        );

        guard.end_install();
        assert!(guard.begin(CloseReason::Exit, targets(&["main"])));
        assert_eq!(
            guard.confirm("main", true).unwrap(),
            CloseOutcome::Allowed(CloseReason::Exit)
        );
        assert!(guard.is_exiting());
        assert!(!guard.begin(CloseReason::Window, targets(&["main"])));
        assert_eq!(
            guard.confirm("main", true).unwrap_err().code,
            AppErrorCode::Busy
        );
    }
}
