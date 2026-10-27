use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};
use tracing_subscriber::EnvFilter;

pub mod commands;
pub mod error;
pub mod ipc;
pub mod services;
pub mod state;

use ipc::contract::{
    EVENT_MENU_ACTION, MENU_ACTIONS, MENU_FILE_OPEN, MENU_FILE_SAVE, MENU_PALETTE_OPEN,
    MENU_THEME_DARK, MENU_THEME_LIGHT, MENU_THEME_SYSTEM, MENU_VIEW_TOGGLE_LIVE_PREVIEW,
    MENU_VIEW_TOGGLE_THEME,
};

/// Menu ids handled in Rust instead of being forwarded to the webview.
const MENU_QUIT: &str = "app.quit";
const MENU_CLOSE_WINDOW: &str = "window.close";
const MENU_TOGGLE_FULLSCREEN: &str = "window.toggleFullscreen";

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

const ABOUT_LABEL: &str = "关于青墨";

fn about_metadata<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("青墨".to_string()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    }
}

/// Which platform menu layout to build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuPlatform {
    Mac,
    Other,
}

fn menu_platform() -> MenuPlatform {
    if cfg!(target_os = "macos") {
        MenuPlatform::Mac
    } else {
        MenuPlatform::Other
    }
}

/// Declarative description of the native menu.
///
/// The layout is kept as plain data so both the macOS and the Windows
/// arrangement can be asserted in tests without creating AppKit objects, which
/// must happen on the main thread.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MenuSpec {
    title: &'static str,
    items: Vec<MenuEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MenuEntry {
    Separator,
    About,
    Services(&'static str),
    Hide(&'static str),
    HideOthers(&'static str),
    ShowAll(&'static str),
    Undo(&'static str),
    Redo(&'static str),
    Cut(&'static str),
    Copy(&'static str),
    Paste(&'static str),
    SelectAll(&'static str),
    Minimize(&'static str),
    Maximize(&'static str),
    BringAllToFront(&'static str),
    Action {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
    },
}

fn action(id: &'static str, label: &'static str, accelerator: Option<&'static str>) -> MenuEntry {
    MenuEntry::Action {
        id,
        label,
        accelerator,
    }
}

/// Builds the Chinese application menu for macOS and Windows.
///
/// The default Tauri menu exposes File/Edit/View/Window/Help entries that do
/// not match Qingmo's command surface. This menu keeps only working items:
/// file operations, native editing actions, view/theme toggles and window
/// controls. Custom items are forwarded to the webview through
/// `app://menu-action`; native predefined items (undo/copy/paste) stay in the
/// platform so the first responder keeps handling text editing.
///
/// Platform differences:
/// - macOS keeps the standard application submenu and Window's "Bring All to
///   Front"; Quit lives in the app submenu.
/// - Windows uses the in-window menu bar: Quit lives in 文件 and Help carries
///   the About dialog.
///
/// Quit/close/fullscreen deliberately use custom items: quitting through the
/// platform default (`NSApplication terminate:` / `PostQuitMessage`) bypasses
/// CloseGuard, so both platforms route these actions through the Rust guard.
fn menu_layout(platform: MenuPlatform) -> Vec<MenuSpec> {
    let macos = platform == MenuPlatform::Mac;

    let mut file_items = vec![
        action(MENU_FILE_OPEN, "打开…", Some("CmdOrCtrl+O")),
        action(MENU_FILE_SAVE, "保存", Some("CmdOrCtrl+S")),
        MenuEntry::Separator,
        action(MENU_CLOSE_WINDOW, "关闭窗口", Some("CmdOrCtrl+W")),
    ];
    if !macos {
        file_items.push(MenuEntry::Separator);
        file_items.push(action(MENU_QUIT, "退出青墨", Some("CmdOrCtrl+Q")));
    }

    let mut window_items = vec![
        MenuEntry::Minimize("最小化"),
        MenuEntry::Maximize(if macos { "缩放" } else { "最大化" }),
    ];
    if macos {
        window_items.push(MenuEntry::Separator);
        window_items.push(MenuEntry::BringAllToFront("前置全部窗口"));
    }

    let fullscreen_accel = if macos { "Ctrl+Cmd+F" } else { "F11" };

    let mut menus = Vec::new();
    if macos {
        menus.push(MenuSpec {
            title: "青墨",
            items: vec![
                MenuEntry::About,
                MenuEntry::Separator,
                MenuEntry::Services("服务"),
                MenuEntry::Separator,
                MenuEntry::Hide("隐藏青墨"),
                MenuEntry::HideOthers("隐藏其他"),
                MenuEntry::ShowAll("显示全部"),
                MenuEntry::Separator,
                action(MENU_QUIT, "退出青墨", Some("CmdOrCtrl+Q")),
            ],
        });
    }
    menus.push(MenuSpec {
        title: "文件",
        items: file_items,
    });
    menus.push(MenuSpec {
        title: "编辑",
        items: vec![
            MenuEntry::Undo("撤销"),
            MenuEntry::Redo("重做"),
            MenuEntry::Separator,
            MenuEntry::Cut("剪切"),
            MenuEntry::Copy("复制"),
            MenuEntry::Paste("粘贴"),
            MenuEntry::SelectAll("全选"),
        ],
    });
    menus.push(MenuSpec {
        title: "显示",
        items: vec![
            action(MENU_VIEW_TOGGLE_LIVE_PREVIEW, "实时预览", None),
            action(MENU_PALETTE_OPEN, "命令面板", Some("CmdOrCtrl+K")),
            action(
                MENU_VIEW_TOGGLE_THEME,
                "切换主题",
                Some("CmdOrCtrl+Shift+L"),
            ),
            MenuEntry::Separator,
            action(MENU_TOGGLE_FULLSCREEN, "全屏", Some(fullscreen_accel)),
        ],
    });
    menus.push(MenuSpec {
        title: "主题",
        items: vec![
            action(MENU_THEME_LIGHT, "浅色", None),
            action(MENU_THEME_DARK, "深色", None),
            action(MENU_THEME_SYSTEM, "跟随系统", None),
        ],
    });
    menus.push(MenuSpec {
        title: "窗口",
        items: window_items,
    });
    if !macos {
        menus.push(MenuSpec {
            title: "帮助",
            items: vec![MenuEntry::About],
        });
    }

    menus
}

/// Materializes one declarative menu into native items.
fn build_submenu<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Submenu<R>> {
    let menu = Submenu::new(app, spec.title, true)?;
    for entry in &spec.items {
        match entry {
            MenuEntry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            MenuEntry::About => menu.append(&PredefinedMenuItem::about(
                app,
                Some(ABOUT_LABEL),
                Some(about_metadata(app)),
            )?)?,
            MenuEntry::Services(label) => {
                menu.append(&PredefinedMenuItem::services(app, Some(label))?)?
            }
            MenuEntry::Hide(label) => menu.append(&PredefinedMenuItem::hide(app, Some(label))?)?,
            MenuEntry::HideOthers(label) => {
                menu.append(&PredefinedMenuItem::hide_others(app, Some(label))?)?
            }
            MenuEntry::ShowAll(label) => {
                menu.append(&PredefinedMenuItem::show_all(app, Some(label))?)?
            }
            MenuEntry::Undo(label) => menu.append(&PredefinedMenuItem::undo(app, Some(label))?)?,
            MenuEntry::Redo(label) => menu.append(&PredefinedMenuItem::redo(app, Some(label))?)?,
            MenuEntry::Cut(label) => menu.append(&PredefinedMenuItem::cut(app, Some(label))?)?,
            MenuEntry::Copy(label) => menu.append(&PredefinedMenuItem::copy(app, Some(label))?)?,
            MenuEntry::Paste(label) => {
                menu.append(&PredefinedMenuItem::paste(app, Some(label))?)?
            }
            MenuEntry::SelectAll(label) => {
                menu.append(&PredefinedMenuItem::select_all(app, Some(label))?)?
            }
            MenuEntry::Minimize(label) => {
                menu.append(&PredefinedMenuItem::minimize(app, Some(label))?)?
            }
            MenuEntry::Maximize(label) => {
                menu.append(&PredefinedMenuItem::maximize(app, Some(label))?)?
            }
            MenuEntry::BringAllToFront(label) => {
                menu.append(&PredefinedMenuItem::bring_all_to_front(app, Some(label))?)?
            }
            MenuEntry::Action {
                id,
                label,
                accelerator,
            } => menu.append(&MenuItem::with_id(app, *id, *label, true, *accelerator)?)?,
        }
    }
    Ok(menu)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_menu_for(app, menu_platform())
}

fn build_menu_for<R: Runtime>(
    app: &AppHandle<R>,
    platform: MenuPlatform,
) -> tauri::Result<Menu<R>> {
    let menus = menu_layout(platform)
        .iter()
        .map(|spec| build_submenu(app, spec))
        .collect::<tauri::Result<Vec<_>>>()?;
    let items: Vec<&dyn IsMenuItem<R>> = menus
        .iter()
        .map(|menu| menu as &dyn IsMenuItem<R>)
        .collect();
    Menu::with_items(app, &items)
}

fn toggle_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match window.is_fullscreen() {
        Ok(fullscreen) => {
            if let Err(error) = window.set_fullscreen(!fullscreen) {
                tracing::warn!(%error, "failed to toggle fullscreen");
            }
        }
        Err(error) => tracing::warn!(%error, "failed to read fullscreen state"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == MENU_QUIT {
                commands::close::request_close(app, ipc::dto::CloseReason::Exit);
                return;
            }
            if id == MENU_CLOSE_WINDOW {
                commands::close::request_close(app, ipc::dto::CloseReason::Window);
                return;
            }
            if id == MENU_TOGGLE_FULLSCREEN {
                toggle_fullscreen(app);
                return;
            }

            if MENU_ACTIONS.contains(&id) {
                if let Err(error) = app.emit(EVENT_MENU_ACTION, id) {
                    tracing::error!(menu_action = id, %error, "failed to emit menu action");
                }
            }
        })
        .manage(state::DocumentRegistry::new())
        .manage(state::CloseGuard::new())
        .setup(|app| {
            app.manage(app.handle().clone());
            app.manage(state::UpdateManager::new(
                app.package_info().version.to_string(),
            ));
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

#[cfg(test)]
mod menu_tests {
    use super::*;

    fn titles(layout: &[MenuSpec]) -> Vec<&'static str> {
        layout.iter().map(|menu| menu.title).collect()
    }

    fn menu<'a>(layout: &'a [MenuSpec], title: &str) -> &'a MenuSpec {
        layout
            .iter()
            .find(|menu| menu.title == title)
            .unwrap_or_else(|| panic!("menu {title} must exist"))
    }

    fn action_ids(menu: &MenuSpec) -> Vec<&'static str> {
        menu.items
            .iter()
            .filter_map(|item| match item {
                MenuEntry::Action { id, .. } => Some(*id),
                _ => None,
            })
            .collect()
    }

    fn action<'a>(menu: &'a MenuSpec, id: &str) -> &'a MenuEntry {
        menu.items
            .iter()
            .find(|item| matches!(item, MenuEntry::Action { id: item_id, .. } if *item_id == id))
            .unwrap_or_else(|| panic!("action {id} must exist"))
    }

    fn action_label(entry: &MenuEntry) -> &'static str {
        match entry {
            MenuEntry::Action { label, .. } => label,
            other => panic!("expected an action, got {other:?}"),
        }
    }

    fn action_accelerator(entry: &MenuEntry) -> Option<&'static str> {
        match entry {
            MenuEntry::Action { accelerator, .. } => *accelerator,
            other => panic!("expected an action, got {other:?}"),
        }
    }

    /// Every id used by a custom menu item must have a handler: either the
    /// webview dispatcher or one of the Rust-side window/quit actions.
    fn assert_every_action_has_a_handler(layout: &[MenuSpec]) {
        let rust_handled = [MENU_QUIT, MENU_CLOSE_WINDOW, MENU_TOGGLE_FULLSCREEN];
        for id in layout.iter().flat_map(action_ids) {
            assert!(
                MENU_ACTIONS.contains(&id) || rust_handled.contains(&id),
                "menu action {id} has no handler"
            );
        }
    }

    #[test]
    fn macos_layout_keeps_the_application_submenu() {
        let layout = menu_layout(MenuPlatform::Mac);

        assert_eq!(
            titles(&layout),
            ["青墨", "文件", "编辑", "显示", "主题", "窗口"]
        );

        let app_menu = menu(&layout, "青墨");
        assert!(action_ids(app_menu).contains(&MENU_QUIT));

        let file_menu = menu(&layout, "文件");
        let file_ids = action_ids(file_menu);
        assert!(file_ids.contains(&MENU_FILE_OPEN));
        assert!(file_ids.contains(&MENU_FILE_SAVE));
        assert!(file_ids.contains(&MENU_CLOSE_WINDOW));
        assert!(!file_ids.contains(&MENU_QUIT));
        assert_eq!(action_label(action(file_menu, MENU_FILE_OPEN)), "打开…");

        assert_eq!(
            menu(&layout, "窗口").items.last(),
            Some(&MenuEntry::BringAllToFront("前置全部窗口"))
        );
        assert_eq!(menu(&layout, "窗口").items[1], MenuEntry::Maximize("缩放"));

        let view_menu = menu(&layout, "显示");
        assert_eq!(
            action_accelerator(action(view_menu, MENU_TOGGLE_FULLSCREEN)),
            Some("Ctrl+Cmd+F")
        );

        assert_every_action_has_a_handler(&layout);
    }

    #[test]
    fn windows_layout_puts_quit_in_file_and_adds_help() {
        let layout = menu_layout(MenuPlatform::Other);

        assert_eq!(
            titles(&layout),
            ["文件", "编辑", "显示", "主题", "窗口", "帮助"]
        );

        let file_menu = menu(&layout, "文件");
        let file_ids = action_ids(file_menu);
        assert!(file_ids.contains(&MENU_FILE_OPEN));
        assert!(file_ids.contains(&MENU_FILE_SAVE));
        assert!(file_ids.contains(&MENU_CLOSE_WINDOW));
        assert!(file_ids.contains(&MENU_QUIT));
        assert_eq!(action_label(action(file_menu, MENU_QUIT)), "退出青墨");

        let help_menu = menu(&layout, "帮助");
        assert_eq!(help_menu.items, [MenuEntry::About]);

        assert_eq!(
            menu(&layout, "窗口").items,
            [MenuEntry::Minimize("最小化"), MenuEntry::Maximize("最大化")]
        );

        let view_menu = menu(&layout, "显示");
        assert_eq!(
            action_accelerator(action(view_menu, MENU_TOGGLE_FULLSCREEN)),
            Some("F11")
        );

        assert_every_action_has_a_handler(&layout);
    }

    #[test]
    fn both_layouts_expose_every_webview_action_once() {
        for platform in [MenuPlatform::Mac, MenuPlatform::Other] {
            let layout = menu_layout(platform);
            let ids: Vec<&str> = layout.iter().flat_map(action_ids).collect();
            for expected in MENU_ACTIONS {
                assert_eq!(
                    ids.iter().filter(|id| *id == expected).count(),
                    1,
                    "{expected} must appear exactly once in {platform:?}"
                );
            }
        }
    }
}
