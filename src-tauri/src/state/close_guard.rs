use std::sync::Mutex;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::CloseReason;

#[derive(Debug, Default)]
struct Inner {
    pending: Option<CloseReason>,
    installing: bool,
    exiting: bool,
}

/// Tracks the single native close request that is waiting for the webview.
///
/// `pending`, `installing`, and `exiting` share one mutex so a close request
/// cannot be inserted between an install gate check and the state transition.
#[derive(Debug, Default)]
pub struct CloseGuard {
    inner: Mutex<Inner>,
}

impl CloseGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms the guard. Returns false when a request/install/exit already owns the gate.
    pub fn begin(&self, reason: CloseReason) -> bool {
        let mut inner = self.lock();
        if inner.pending.is_some() || inner.installing || inner.exiting {
            return false;
        }
        inner.pending = Some(reason);
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

    /// Completes a pending close request.
    ///
    /// `allow=true` moves the guard into its terminal exiting state. Installing
    /// or exiting always wins, so a close can never race an install/restart.
    pub fn confirm(&self, allow: bool) -> Result<CloseReason, AppError> {
        let mut inner = self.lock();
        if inner.installing || inner.exiting {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the application is installing an update or already exiting",
            ));
        }
        let reason = inner.pending.take().ok_or_else(|| {
            AppError::new(AppErrorCode::Busy, "no pending close request to confirm")
        })?;
        if allow {
            inner.exiting = true;
        }
        Ok(reason)
    }

    /// Clears the pending request without confirming it (event emit failure).
    pub fn cancel(&self) {
        self.lock().pending = None;
    }

    pub fn pending(&self) -> Option<CloseReason> {
        self.lock().pending
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

    #[test]
    fn allows_only_one_pending_request() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Window));
        assert!(!guard.begin(CloseReason::Exit));
        assert_eq!(guard.pending(), Some(CloseReason::Window));
        assert_eq!(guard.confirm(false).unwrap(), CloseReason::Window);
        assert_eq!(guard.pending(), None);
    }

    #[test]
    fn cancel_rearms_the_guard() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Exit));
        guard.cancel();
        assert!(guard.begin(CloseReason::Window));
        assert_eq!(guard.confirm(false).unwrap(), CloseReason::Window);
    }

    #[test]
    fn install_and_close_share_the_same_gate() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Window));
        assert!(guard.begin_install().is_err());
        guard.cancel();

        assert!(guard.begin_install().is_ok());
        assert!(guard.is_installing());
        assert!(!guard.begin(CloseReason::Window));
        assert_eq!(
            guard
                .confirm(true)
                .expect_err("install must block confirm")
                .code,
            AppErrorCode::Busy
        );

        guard.end_install();
        assert!(guard.begin(CloseReason::Exit));
        assert_eq!(guard.confirm(true).unwrap(), CloseReason::Exit);
        assert!(guard.is_exiting());
        assert!(!guard.begin(CloseReason::Window));
        assert_eq!(guard.confirm(true).unwrap_err().code, AppErrorCode::Busy);
    }
}
