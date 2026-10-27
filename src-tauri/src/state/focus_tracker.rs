use std::sync::Mutex;

/// Remembers the last window the user focused.
///
/// A native menu action is delivered while the menu bar owns focus, so
/// `is_focused()` can be false for every window. Tracking focus events gives
/// menu actions a stable target on macOS and Windows.
#[derive(Debug, Default)]
pub struct FocusTracker {
    last: Mutex<Option<String>>,
}

impl FocusTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, label: &str) {
        *self.lock() = Some(label.to_string());
    }

    pub fn clear(&self, label: &str) {
        let mut last = self.lock();
        if last.as_deref() == Some(label) {
            *last = None;
        }
    }

    pub fn get(&self) -> Option<String> {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_and_clears_the_last_focused_window() {
        let tracker = FocusTracker::new();
        assert_eq!(tracker.get(), None);
        tracker.set("main");
        tracker.set("doc-1");
        assert_eq!(tracker.get().as_deref(), Some("doc-1"));
        tracker.clear("main");
        assert_eq!(tracker.get().as_deref(), Some("doc-1"));
        tracker.clear("doc-1");
        assert_eq!(tracker.get(), None);
    }
}
