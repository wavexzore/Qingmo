use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{AboutInfo, AboutLink};

/// Stable label and size for the custom About window.
pub const ABOUT_WINDOW_LABEL: &str = "about";
const ABOUT_WINDOW_WIDTH: f64 = 640.0;
const ABOUT_WINDOW_HEIGHT: f64 = 400.0;

const LICENSE: &str = "Apache-2.0";
const COPYRIGHT: &str = "© 2026 Qingmo Contributors";

fn arch_label() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        "x86" => "x86",
        other => other,
    }
}

fn platform_label() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

/// The About window has no document state, so every command is scoped to it.
fn ensure_about_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    if window.label() == ABOUT_WINDOW_LABEL {
        Ok(())
    } else {
        Err(AppError::new(
            AppErrorCode::PermissionDenied,
            "this command is only available to the About window",
        ))
    }
}

pub(crate) fn about_info(version: &str) -> AboutInfo {
    AboutInfo {
        version: version.to_string(),
        build: format!("{version} · {}", arch_label()),
        platform: platform_label().to_string(),
        license: LICENSE.to_string(),
        copyright: COPYRIGHT.to_string(),
    }
}

impl AboutLink {
    fn url(self) -> &'static str {
        match self {
            Self::Docs => "https://github.com/wavexzore/Qingmo#readme",
            Self::Github => "https://github.com/wavexzore/Qingmo",
            Self::Changelog => "https://github.com/wavexzore/Qingmo/releases",
            Self::License => "https://github.com/wavexzore/Qingmo/blob/main/LICENSE",
        }
    }
}

fn about_window_title(labels: Option<crate::ipc::dto::NativeShellLabels>) -> String {
    labels
        .map(|labels| labels.about)
        .unwrap_or_else(|| "Qingmo".to_string())
}

/// Opens the About window, or focuses it when it is already open.
///
/// The window mirrors the Colophon prototype: fixed 640 × 400, no native
/// decorations, transparent corners and a webview-drawn title bar. Keeping it
/// out of the taskbar matches how macOS and Windows About windows behave.
pub fn open_about<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window(ABOUT_WINDOW_LABEL) {
        window.show().map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("failed to show the About window: {error}"),
            )
        })?;
        let _ = window.unminimize();
        window.set_focus().map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("failed to focus the About window: {error}"),
            )
        })?;
        return Ok(());
    }

    let about_title = about_window_title(app.state::<crate::state::ShellLocale>().labels());
    let window = WebviewWindowBuilder::new(
        app,
        ABOUT_WINDOW_LABEL,
        WebviewUrl::App("about.html".into()),
    )
    .title(about_title)
    .inner_size(ABOUT_WINDOW_WIDTH, ABOUT_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(true)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .skip_taskbar(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .center()
    .focused(true)
    .build()
    .map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("failed to create the About window: {error}"),
        )
    })?;

    if let Err(error) = window.set_focus() {
        tracing::warn!(%error, "failed to focus the About window");
    }
    Ok(())
}

#[tauri::command]
pub fn app_about_info<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<AboutInfo, AppError> {
    ensure_about_window(&window)?;
    Ok(about_info(&app.package_info().version.to_string()))
}

#[tauri::command]
pub fn app_about_close<R: Runtime>(window: WebviewWindow<R>) -> Result<(), AppError> {
    ensure_about_window(&window)?;
    window.destroy().map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("failed to close the About window: {error}"),
        )
    })
}

#[tauri::command]
pub fn app_about_open_link<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    link: AboutLink,
) -> Result<(), AppError> {
    ensure_about_window(&window)?;
    app.opener()
        .open_url(link.url(), None::<&str>)
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("failed to open {}: {error}", link.url()),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_uses_real_build_metadata() {
        let info = about_info("0.1.0");

        assert_eq!(info.version, "0.1.0");
        assert!(
            info.build.starts_with("0.1.0 · "),
            "build must include the architecture: {}",
            info.build
        );
        assert_eq!(info.platform, platform_label());
        assert_eq!(info.license, "Apache-2.0");
        assert_eq!(info.copyright, "© 2026 Qingmo Contributors");
    }

    #[test]
    fn about_title_falls_back_to_a_neutral_name() {
        assert_eq!(about_window_title(None), "Qingmo");

        let labels = crate::ipc::dto::test_native_labels("青墨");
        assert_eq!(about_window_title(Some(labels.clone())), "About 青墨");
        assert_eq!(labels.about, "About 青墨");
    }

    #[test]
    fn every_about_link_is_https_and_distinct() {
        let urls = [
            AboutLink::Docs,
            AboutLink::Github,
            AboutLink::Changelog,
            AboutLink::License,
        ];
        let mut resolved = [""; 4];
        for (index, link) in urls.iter().enumerate() {
            let url = link.url();
            assert!(url.starts_with("https://"), "unsafe About link: {url}");
            resolved[index] = url;
        }
        let unique: std::collections::HashSet<_> = resolved.iter().collect();
        assert_eq!(unique.len(), resolved.len());
    }
}
