//! Window intent capture and startup restore.
//!
//! `session/windows.json` stores only intent (bounds, workspace root, document
//! path, untitled flag). Tokens, labels, bodies and cursor state are never
//! persisted. Restore reuses the normal document/open-window primitives.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::ipc::dto::{WindowBounds, WindowIntent};
use crate::services::SessionStore;
use crate::state::{DocumentRegistry, StartupWindow, WindowSessions, WorkspaceRegistry};

/// Captures every editable window before `app.exit`.
pub fn capture_windows_before_exit<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(store) = app.try_state::<SessionStore>() else {
        return;
    };
    if !store.is_ready() {
        return;
    }
    let sessions = app.state::<WindowSessions>();
    let documents = app.state::<DocumentRegistry>();
    let workspaces = app.state::<WorkspaceRegistry>();
    let mut intents = Vec::new();
    for (label, window) in app.webview_windows() {
        if crate::commands::close::is_auxiliary_window(&label) {
            continue;
        }
        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        let position = window
            .outer_position()
            .ok()
            .map(|position| position.to_logical::<f64>(scale))
            .unwrap_or(tauri::LogicalPosition::new(100.0, 100.0));
        let size = window
            .inner_size()
            .ok()
            .map(|size| size.to_logical::<f64>(scale))
            .unwrap_or(tauri::LogicalSize::new(1200.0, 800.0));
        let document = sessions
            .token_for(&label)
            .and_then(|token| documents.get(&token).ok());
        let document_path = document.as_ref().and_then(|record| {
            record
                .canonical_target()
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        });
        let document_id = document
            .as_ref()
            .and_then(|record| record.document_id())
            .map(|id| id.to_string());
        let workspace_root = sessions.workspace_for(&label).and_then(|token| {
            workspaces
                .get(&token)
                .ok()
                .map(|record| record.root.to_string_lossy().to_string())
        });
        intents.push(WindowIntent {
            bounds: WindowBounds {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                maximized: window.is_maximized().unwrap_or(false),
                scale_factor: scale,
            },
            workspace_root,
            document_path: document_path.clone(),
            document_id,
            untitled: document_path.is_none(),
        });
    }
    if let Err(error) = store.windows_set(&intents) {
        tracing::warn!(%error, "failed to capture window intent before exit");
    }
}

/// Restores windows from `windows.json` after setup claimed `Restore`.
///
/// Returns true when at least one window was created. Every zero-window exit
/// path falls back to `main`, otherwise the process would stay windowless
/// because the boot timer can no longer claim `Restore`.
pub async fn restore_windows<R: tauri::Runtime>(app: AppHandle<R>) -> bool {
    let Some(store) = app.try_state::<SessionStore>() else {
        return false;
    };
    let startup = app.state::<StartupWindow>();
    if !startup.is_restoring() {
        return false;
    }
    let intents = store.windows_get();
    if intents.is_empty() {
        if startup.mark_restore_failed() {
            crate::ensure_main_window(&app);
        }
        return false;
    }

    let mut restored = 0usize;
    for (index, intent) in intents.iter().take(20).enumerate() {
        // An OS open during restore calls `mark_opened`; stop adding windows.
        if startup.was_opened() {
            break;
        }
        let label = (index == 0).then_some("main");
        if restore_one(&app, intent, label).await.is_ok() {
            restored += 1;
        }
    }
    if restored == 0 {
        if startup.mark_restore_failed() {
            crate::ensure_main_window(&app);
        }
        false
    } else {
        startup.mark_opened();
        true
    }
}

async fn restore_one<R: tauri::Runtime>(
    app: &AppHandle<R>,
    intent: &WindowIntent,
    label: Option<&str>,
) -> Result<(), crate::error::AppError> {
    let before: std::collections::HashSet<String> = app.webview_windows().keys().cloned().collect();
    let workspace_token = intent
        .workspace_root
        .as_deref()
        .and_then(|root| std::fs::canonicalize(root).ok())
        .filter(|root| root.is_dir())
        .map(|root| {
            let registry = app.state::<WorkspaceRegistry>();
            registry.open_canonical(root).0
        });

    let document_path = intent.document_path.as_deref().and_then(|path| {
        let path = PathBuf::from(path);
        let root = workspace_token
            .as_ref()
            .and_then(|token| app.state::<WorkspaceRegistry>().get(token).ok())
            .map(|record| record.root.clone());
        if let Some(root) = root.as_ref() {
            let canonical = std::fs::canonicalize(&path).ok()?;
            if !canonical.starts_with(root) || !canonical.is_file() {
                return None;
            }
            Some(canonical)
        } else if path.is_file() {
            Some(path)
        } else {
            None
        }
    });

    let result = match document_path {
        Some(path) => {
            crate::commands::document::open_path_in_window_with_label(
                app.clone(),
                path,
                workspace_token.clone(),
                false,
                label.map(str::to_string),
            )
            .await
        }
        None => {
            crate::commands::document::create_untitled_window_with_label(
                app.clone(),
                workspace_token.clone(),
                label.map(str::to_string),
            )
            .await
        }
    };

    if let Some(token) = workspace_token {
        app.state::<WorkspaceRegistry>().release(&token);
    }
    result?;

    let after = app.webview_windows();
    let new_label = after
        .keys()
        .find(|candidate| !before.contains(*candidate))
        .cloned()
        .or_else(|| {
            label
                .map(str::to_string)
                .filter(|label| after.contains_key(label))
        });
    if let Some(label) = new_label {
        if let Some(window) = after.get(&label) {
            apply_bounds(app, window, &intent.bounds);
        }
    }
    Ok(())
}

fn apply_bounds<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    bounds: &WindowBounds,
) {
    if bounds.width.is_finite() && bounds.height.is_finite() {
        let width = bounds.width.max(400.0);
        let height = bounds.height.max(300.0);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
    }
    let target = if intersects_a_monitor(app, bounds) {
        tauri::LogicalPosition::new(bounds.x, bounds.y)
    } else {
        centered_on_primary(app, bounds).unwrap_or(tauri::LogicalPosition::new(100.0, 100.0))
    };
    let _ = window.set_position(target);
    if bounds.maximized {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
}

fn intersects_a_monitor<R: tauri::Runtime>(app: &AppHandle<R>, bounds: &WindowBounds) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        if scale <= 0.0 {
            return false;
        }
        let position = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        bounds.x < position.x + size.width
            && bounds.x + bounds.width > position.x
            && bounds.y < position.y + size.height
            && bounds.y + bounds.height > position.y
    })
}

fn centered_on_primary<R: tauri::Runtime>(
    app: &AppHandle<R>,
    bounds: &WindowBounds,
) -> Option<tauri::LogicalPosition<f64>> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    Some(tauri::LogicalPosition::new(
        position.x + (size.width - bounds.width).max(0.0) / 2.0,
        position.y + (size.height - bounds.height).max(0.0) / 2.0,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_are_logical_and_never_negative_sized() {
        let bounds = WindowBounds {
            x: -100.0,
            y: 20.0,
            width: 1200.0,
            height: 800.0,
            maximized: false,
            scale_factor: 2.0,
        };
        assert!(bounds.width > 0.0);
        assert_eq!(bounds.scale_factor, 2.0);
    }
}
