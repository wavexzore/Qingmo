use tauri::menu::Menu;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};
use tracing_subscriber::EnvFilter;

pub mod commands;
pub mod error;
pub mod ipc;
pub mod services;
pub mod state;

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

/// Replaces only the default macOS Quit menu item.
///
/// macOS handles Cmd+Q through `NSApplication terminate:`, which bypasses
/// `RunEvent::ExitRequested`; tao only reports `applicationWillTerminate`
/// after the decision is already made. A custom item with the same shortcut
/// routes the request through CloseGuard instead, without adding a user-facing
/// native menu surface beyond the existing default app menu.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    #[cfg(target_os = "macos")]
    {
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
            // `Menu::default` lays the app submenu out as about/services/hide/
            // quit; quit is deliberately the final item in Tauri 2.12.
            let last = app_menu.items()?.len().saturating_sub(1);
            if matches!(
                app_menu.items()?.get(last),
                Some(MenuItemKind::Predefined(_))
            ) {
                let _ = app_menu.remove_at(last);
                let quit = MenuItem::with_id(app, "quit", "退出青墨", true, Some("CmdOrCtrl+Q"))?;
                app_menu.insert(&quit, last)?;
            }
        }
    }

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                commands::close::request_close(app, ipc::dto::CloseReason::Exit);
            }
        })
        .manage(state::DocumentRegistry::new())
        .manage(state::CloseGuard::new())
        .setup(|app| {
            app.manage(app.handle().clone());
            Ok(())
        })
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("error while building Qingmo");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            commands::close::request_close(app_handle, ipc::dto::CloseReason::Window);
        }
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            commands::close::request_close(app_handle, ipc::dto::CloseReason::Exit);
        }
        _ => {}
    });
}
