use std::collections::HashMap;
use std::sync::Mutex;

/// Remembers each window's Live Preview mode for the shared native menu.
///
/// The menu bar belongs to the application, not to one window, so the check
/// state must follow whichever window has focus. Each webview reports its mode
/// after startup and after every toggle; focus changes re-apply that value.
#[derive(Debug, Default)]
pub struct PreviewModes {
    modes: Mutex<HashMap<String, bool>>,
}

impl PreviewModes {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, label: &str, live_preview: bool) {
        self.lock().insert(label.to_string(), live_preview);
    }

    pub fn get(&self, label: &str) -> Option<bool> {
        self.lock().get(label).copied()
    }

    pub fn clear(&self, label: &str) {
        self.lock().remove(label);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.modes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_modes_per_window_and_clears_them() {
        let modes = PreviewModes::new();
        assert_eq!(modes.get("main"), None);

        modes.set("main", false);
        modes.set("doc-1", true);
        assert_eq!(modes.get("main"), Some(false));
        assert_eq!(modes.get("doc-1"), Some(true));

        modes.clear("main");
        assert_eq!(modes.get("main"), None);
        assert_eq!(modes.get("doc-1"), Some(true));
    }
}
