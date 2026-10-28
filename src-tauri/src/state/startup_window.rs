use std::sync::atomic::{AtomicBool, Ordering};

/// Tracks whether the OS delivered a document while the app was launching.
///
/// The main window is declared with `create: false`; a short bootstrap delay
/// creates it only when launch was not caused by opening a document. A Finder
/// double-click therefore ends with the document window alone instead of an
/// extra blank window behind it.
#[derive(Debug, Default)]
pub struct StartupWindow {
    opened: AtomicBool,
}

impl StartupWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records that the OS handed at least one supported file to the app.
    pub fn mark_opened(&self) {
        self.opened.store(true, Ordering::SeqCst);
    }

    /// Whether a document open request arrived during launch.
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
}
