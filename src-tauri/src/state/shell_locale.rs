use std::sync::Mutex;

use crate::ipc::dto::{AppLanguage, NativeShellLabels};

#[derive(Debug, Clone)]
struct ShellState {
    language: AppLanguage,
    labels: NativeShellLabels,
}

/// The last locale projection accepted from the webview.
///
/// Rust never stores a translation table: it only keeps the labels the
/// frontend built, so repeated projections can be skipped and new windows can
/// reuse the same strings.
#[derive(Debug, Default)]
pub struct ShellLocale {
    inner: Mutex<Option<ShellState>>,
}

impl ShellLocale {
    pub fn current(&self) -> Option<(AppLanguage, NativeShellLabels)> {
        self.lock()
            .as_ref()
            .map(|state| (state.language, state.labels.clone()))
    }

    pub fn matches(&self, language: AppLanguage, labels: &NativeShellLabels) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|state| state.language == language && state.labels == *labels)
    }

    pub fn replace(&self, language: AppLanguage, labels: NativeShellLabels) {
        *self.lock() = Some(ShellState { language, labels });
    }

    /// Commits the projection only when it differs from the cached one.
    pub fn replace_if_changed(&self, language: AppLanguage, labels: NativeShellLabels) -> bool {
        if self.matches(language, &labels) {
            return false;
        }
        self.replace(language, labels);
        true
    }

    pub fn labels(&self) -> Option<NativeShellLabels> {
        self.current().map(|(_, labels)| labels)
    }

    pub fn untitled_file_name(&self) -> String {
        self.labels()
            .map(|labels| labels.untitled_file_name)
            .unwrap_or_else(|| "Untitled.md".to_string())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ShellState>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(app_name: &str) -> NativeShellLabels {
        let mut labels: NativeShellLabels = serde_json::from_value(serde_json::json!({
            "appName": app_name,
            "about": "about",
            "settings": "settings",
            "services": "services",
            "hideApp": "hide",
            "hideOthers": "hide others",
            "showAll": "show all",
            "quitApp": "quit",
            "file": "file",
            "open": "open",
            "save": "save",
            "closeWindow": "close",
            "edit": "edit",
            "undo": "undo",
            "redo": "redo",
            "cut": "cut",
            "copy": "copy",
            "paste": "paste",
            "selectAll": "select all",
            "view": "view",
            "livePreview": "live preview",
            "commandPalette": "palette",
            "toggleTheme": "theme",
            "logs": "logs",
            "fullscreen": "fullscreen",
            "theme": "theme",
            "themeLight": "light",
            "themeDark": "dark",
            "themeSystem": "system",
            "language": "language",
            "languageZhCN": "简体中文",
            "languageEn": "English",
            "window": "window",
            "minimize": "minimize",
            "zoom": "zoom",
            "maximize": "maximize",
            "bringAllToFront": "front",
            "help": "help",
            "untitledFileName": format!("{app_name}.md"),
        }))
        .expect("test labels must deserialize");
        labels.about = format!("{app_name} about");
        labels
    }

    #[test]
    fn caches_the_last_projection_and_reports_changes() {
        let locale = ShellLocale::default();
        assert_eq!(locale.untitled_file_name(), "Untitled.md");

        assert!(locale.replace_if_changed(AppLanguage::ZhCn, labels("zh")));
        assert_eq!(locale.current().unwrap().0, AppLanguage::ZhCn);
        assert!(locale.matches(AppLanguage::ZhCn, &labels("zh")));

        assert!(!locale.replace_if_changed(AppLanguage::ZhCn, labels("zh")));
        assert!(locale.replace_if_changed(AppLanguage::En, labels("zh")));
        assert!(locale.replace_if_changed(AppLanguage::En, labels("en")));
        assert_eq!(locale.untitled_file_name(), "en.md");
    }
}
