use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum LaunchState {
    #[default]
    Undecided,
    /// The fallback timer won and is creating the blank main window.
    Main,
    /// A document (OS open or New) owns the launch.
    Document,
}

/// Decides who creates the first window.
///
/// The main window is declared with `create: false`; a short bootstrap delay
/// creates it only when launch was not caused by opening a document or by a
/// New request. Both sides claim the launch exactly once, so a New landing on
/// the 300ms boundary cannot add a second empty window: if the timer already
/// claimed the main window, New waits for it and reuses it.
#[derive(Debug, Default)]
pub struct StartupWindow {
    state: Mutex<LaunchState>,
}

impl StartupWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records that a document already owns the launch.
    pub fn mark_opened(&self) {
        *self.lock() = LaunchState::Document;
    }

    /// Claims the fallback main window when nothing did so yet.
    ///
    /// Returns `true` for the single caller allowed to create it.
    pub fn claim_main_if_undecided(&self) -> bool {
        let mut state = self.lock();
        if *state != LaunchState::Undecided {
            return false;
        }
        *state = LaunchState::Main;
        true
    }

    /// Claims the launch for a New document window when still undecided.
    ///
    /// `false` means either the main window is being created (`is_main_claimed`)
    /// or another document already owns the launch.
    pub fn claim_document_if_undecided(&self) -> bool {
        let mut state = self.lock();
        if *state != LaunchState::Undecided {
            return false;
        }
        *state = LaunchState::Document;
        true
    }

    pub fn is_main_claimed(&self) -> bool {
        *self.lock() == LaunchState::Main
    }

    /// Whether a document open or New request already owns the launch.
    pub fn was_opened(&self) -> bool {
        *self.lock() == LaunchState::Document
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LaunchState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_undecided() {
        let state = StartupWindow::new();
        assert!(!state.was_opened());
        assert!(!state.is_main_claimed());
    }

    #[test]
    fn remembers_a_launch_open() {
        let state = StartupWindow::new();
        state.mark_opened();
        assert!(state.was_opened());
        assert!(!state.claim_main_if_undecided());
    }

    #[test]
    fn only_one_fallback_claim_wins() {
        let state = StartupWindow::new();
        assert!(state.claim_main_if_undecided());
        assert!(!state.claim_main_if_undecided());
        assert!(state.is_main_claimed());
        assert!(!state.was_opened());
    }

    #[test]
    fn the_main_claim_blocks_a_document_claim() {
        let state = StartupWindow::new();
        assert!(state.claim_main_if_undecided());
        assert!(!state.claim_document_if_undecided());
        assert!(!state.was_opened());
    }

    #[test]
    fn a_document_claim_blocks_the_fallback() {
        let state = StartupWindow::new();
        assert!(state.claim_document_if_undecided());
        assert!(!state.claim_main_if_undecided());
        assert!(state.was_opened());
        assert!(!state.is_main_claimed());
    }
}
