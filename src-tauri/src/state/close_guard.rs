use std::sync::Mutex;

use crate::ipc::dto::CloseReason;

/// Tracks the single native close request that is waiting for the webview.
///
/// Only one request may be in flight: repeated red-button/Cmd+Q events while
/// the frontend is flushing must not emit a second event or race two confirms.
#[derive(Debug, Default)]
pub struct CloseGuard {
    pending: Mutex<Option<CloseReason>>,
}

impl CloseGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms the guard. Returns false when a request is already pending.
    pub fn begin(&self, reason: CloseReason) -> bool {
        let mut pending = self.lock();
        if pending.is_some() {
            return false;
        }
        *pending = Some(reason);
        true
    }

    /// Clears the pending request and returns its reason.
    pub fn take(&self) -> Option<CloseReason> {
        self.lock().take()
    }

    /// Clears the pending request without confirming it (event emit failure).
    pub fn cancel(&self) {
        *self.lock() = None;
    }

    pub fn pending(&self) -> Option<CloseReason> {
        *self.lock()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<CloseReason>> {
        self.pending
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
        assert_eq!(guard.take(), Some(CloseReason::Window));
        assert_eq!(guard.pending(), None);
    }

    #[test]
    fn cancel_and_take_rearm_the_guard() {
        let guard = CloseGuard::new();
        assert!(guard.begin(CloseReason::Exit));
        guard.cancel();
        assert!(guard.begin(CloseReason::Window));
        assert_eq!(guard.take(), Some(CloseReason::Window));
        assert!(guard.begin(CloseReason::Exit));
    }
}
