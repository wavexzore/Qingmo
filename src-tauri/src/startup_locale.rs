use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

use crate::ipc::dto::{AppLanguage, NativeShellLabels};

/// The menu copy lives beside the other frontend resources, so the native
/// startup menu and the webview projection read the same strings.
const MENU_ZH_CN: &str = include_str!("../../apps/desktop/src/i18n/locales/menu.zh-CN.json");
const MENU_EN: &str = include_str!("../../apps/desktop/src/i18n/locales/menu.en.json");

/// Last language projected by the webview. This is only a startup hint; the
/// webview localStorage remains authoritative and corrects a stale file.
const LANGUAGE_HINT_FILE: &str = "shell-language";

fn menu_resource(language: AppLanguage) -> &'static str {
    match language {
        AppLanguage::ZhCn => MENU_ZH_CN,
        AppLanguage::En => MENU_EN,
    }
}

fn app_name(language: AppLanguage) -> &'static str {
    match language {
        AppLanguage::ZhCn => "青墨",
        AppLanguage::En => "Qingmo",
    }
}

fn language_tag(language: AppLanguage) -> &'static str {
    match language {
        AppLanguage::ZhCn => "zh-CN",
        AppLanguage::En => "en",
    }
}

fn language_from_tag(value: &str) -> Option<AppLanguage> {
    match value {
        "zh-CN" => Some(AppLanguage::ZhCn),
        "en" => Some(AppLanguage::En),
        _ => None,
    }
}

/// Builds the complete native label set before the webview can project one.
///
/// `menu.*.json` stores the same `{{appName}}` placeholders i18next resolves
/// in the webview; Rust only fills that one shared placeholder.
pub(crate) fn labels_for(language: AppLanguage) -> Option<NativeShellLabels> {
    let mut value: serde_json::Value = serde_json::from_str(menu_resource(language)).ok()?;
    let name = app_name(language);
    let object = value.as_object_mut()?;

    for key in ["about", "hideApp", "quitApp"] {
        let template = object.get(key)?.as_str()?;
        let resolved = template.replace("{{appName}}", name);
        object.insert(key.to_owned(), serde_json::Value::String(resolved));
    }
    object.insert(
        "appName".to_owned(),
        serde_json::Value::String(name.to_owned()),
    );

    serde_json::from_value(value).ok()
}

fn hint_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(LANGUAGE_HINT_FILE))
}

/// Reads the last successfully projected language.
///
/// A missing, unreadable or invalid hint falls back to the product default so
/// a partial write can never block startup.
pub(crate) fn language<R: Runtime>(app: &AppHandle<R>) -> AppLanguage {
    hint_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|value| language_from_tag(value.trim()))
        .unwrap_or(AppLanguage::ZhCn)
}

/// Remembers the language only after the native projection succeeded.
pub(crate) fn remember_language<R: Runtime>(app: &AppHandle<R>, language: AppLanguage) {
    let Some(path) = hint_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(dir) {
            tracing::warn!(%error, "failed to create the startup-language directory");
            return;
        }
    }
    if let Err(error) = std::fs::write(&path, language_tag(language)) {
        tracing::warn!(%error, "failed to persist the startup language");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_complete_labels_from_the_shared_menu_resource() {
        for language in [AppLanguage::ZhCn, AppLanguage::En] {
            let labels = labels_for(language).expect("the bundled menu resource must parse");
            labels
                .validate()
                .expect("startup labels must satisfy IPC rules");
            assert_eq!(labels.app_name, app_name(language));
            for (field, value) in labels.fields() {
                assert!(
                    !value.contains("{{"),
                    "{field} still contains an unresolved placeholder"
                );
            }
            assert!(labels.about.contains(&labels.app_name));
        }
    }

    #[test]
    fn language_tags_round_trip() {
        for language in [AppLanguage::ZhCn, AppLanguage::En] {
            assert_eq!(language_from_tag(language_tag(language)), Some(language));
        }
        assert_eq!(language_from_tag("fr"), None);
    }
}
