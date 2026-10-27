use std::sync::Mutex;

/// Remembers the last window the user focused.
///
/// A native menu action is delivered while the menu bar owns focus, so
/// `is_focused()` can be false for every window. Tracking focus events gives
/// menu actions a stable target on macOS and Windows.
///
/// The About window is auxiliary: it can own keyboard focus, but document
/// commands must keep targeting the window the user was editing before.
#[derive(Debug, Default)]
pub struct FocusTracker {
    last: Mutex<Option<String>>,
    command_target: Mutex<Option<String>>,
}

impl FocusTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tracks an editable window for both window events and menu commands.
    pub fn set(&self, label: &str) {
        *self
            .command_target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(label.to_string());
        *self.lock() = Some(label.to_string());
    }

    /// Tracks an auxiliary window without taking over document menu commands.
    pub fn set_auxiliary(&self, label: &str) {
        *self.lock() = Some(label.to_string());
    }

    pub fn clear(&self, label: &str) {
        let mut last = self.lock();
        if last.as_deref() == Some(label) {
            *last = None;
        }
        drop(last);

        let mut command_target = self
            .command_target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if command_target.as_deref() == Some(label) {
            *command_target = None;
        }
    }

    pub fn get(&self) -> Option<String> {
        self.lock().clone()
    }

    /// The last window that should receive a document-level menu command.
    pub fn get_command_target(&self) -> Option<String> {
        self.command_target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
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
        assert_eq!(tracker.get_command_target().as_deref(), Some("doc-1"));
        tracker.clear("main");
        assert_eq!(tracker.get().as_deref(), Some("doc-1"));
        tracker.clear("doc-1");
        assert_eq!(tracker.get(), None);
        assert_eq!(tracker.get_command_target(), None);
    }

    #[test]
    fn auxiliary_windows_do_not_steal_menu_commands() {
        let tracker = FocusTracker::new();
        tracker.set("doc-1");
        tracker.set_auxiliary("about");

        assert_eq!(tracker.get().as_deref(), Some("about"));
        assert_eq!(tracker.get_command_target().as_deref(), Some("doc-1"));

        tracker.clear("about");
        assert_eq!(tracker.get(), None);
        assert_eq!(tracker.get_command_target().as_deref(), Some("doc-1"));
    }
}
