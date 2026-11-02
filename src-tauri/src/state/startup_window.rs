use std::sync::atomic::{AtomicBool, Ordering};

/// Tracks whether the launch already settled on a document window.
///
/// The main window is declared with `create: false`; a short bootstrap delay
/// creates it only when launch was not caused by opening a document or by a
/// New request. `claim_if_unopened` makes the 300ms fallback decision atomic,
/// so a New at the boundary cannot race it into an extra blank window.
#[derive(Debug, Default)]
pub struct StartupWindow {
    opened: AtomicBool,
}

impl StartupWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records that a document (OS open or New) already claimed the launch.
    pub fn mark_opened(&self) {
        self.opened.store(true, Ordering::SeqCst);
    }

    /// Atomically claims the fallback main window when nothing did so yet.
    ///
    /// Returns `true` for the single caller allowed to create the main window.
    pub fn claim_if_unopened(&self) -> bool {
        self.opened
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Whether a document open or New request already claimed the launch.
    pub fn was_opened(&self) -> bool {
        self.opened.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::StartupWindow;

    #[test]
    fn starts_without_an_open_request() {
        assert!(!StartupWindow::new().was_opened());
    }

    #[test]
    fn remembers_a_launch_open() {
        let state = StartupWindow::new();
        state.mark_opened();
        assert!(state.was_opened());
    }

    #[test]
    fn only_one_fallback_claim_wins() {
        let state = StartupWindow::new();
        assert!(state.claim_if_unopened());
        assert!(!state.claim_if_unopened());
        assert!(!state.claim_if_unopened());
    }

    #[test]
    fn a_document_claim_blocks_the_fallback() {
        let state = StartupWindow::new();
        state.mark_opened();
        assert!(!state.claim_if_unopened());
    }
}
