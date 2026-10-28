use std::path::PathBuf;
use std::time::Duration;

use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

pub mod commands;
pub mod error;
pub mod ipc;
pub mod services;
pub mod state;

use commands::about::{open_about, ABOUT_WINDOW_LABEL};
use ipc::contract::{
    EVENT_MENU_ACTION, MENU_ACTIONS, MENU_FILE_OPEN, MENU_FILE_SAVE, MENU_PALETTE_OPEN,
    MENU_THEME_DARK, MENU_THEME_LIGHT, MENU_THEME_SYSTEM, MENU_VIEW_TOGGLE_LIVE_PREVIEW,
    MENU_VIEW_TOGGLE_THEME,
};
use ipc::dto::MenuActionPayload;

/// Menu ids handled in Rust instead of being forwarded to the webview.
const MENU_ABOUT: &str = "app.about";
const MENU_LOGS: &str = "app.openLogs";
const MENU_QUIT: &str = "app.quit";
const MENU_CLOSE_WINDOW: &str = "window.close";
const MENU_TOGGLE_FULLSCREEN: &str = "window.toggleFullscreen";

fn file_appender(dir: &PathBuf) -> Option<RollingFileAppender> {
    match tracing_appender::rolling::Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("qingmo")
        .filename_suffix("log")
        .max_log_files(services::logging::RETENTION_DAYS as usize)
        .build(dir)
    {
        Ok(appender) => Some(appender),
        Err(error) => {
            eprintln!("failed to open the log file appender: {error}");
            None
        }
    }
}

/// Console plus a daily rolling file. The file layer never uses ANSI colours
/// so exported logs stay readable, and keeps at most seven days.
fn init_tracing(log_dir: Option<&PathBuf>) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let init = |appender: Option<RollingFileAppender>| {
        let console = tracing_subscriber::fmt::layer().with_target(false);
        match appender {
            Some(appender) => {
                let _ = tracing_subscriber::registry()
                    .with(filter)
                    .with(console)
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_ansi(false)
                            .with_writer(appender),
                    )
                    .try_init();
            }
            None => {
                let _ = tracing_subscriber::registry()
                    .with(filter)
                    .with(console)
                    .try_init();
            }
        }
    };

    init(log_dir.and_then(file_appender));
}

const ABOUT_LABEL: &str = "关于青墨";

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
    /// A toggle that shows a checkmark while the mode is active.
    Checked {
        id: &'static str,
        label: &'static str,
        checked: bool,
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
    let logs_accel = if macos { "Cmd+Alt+L" } else { "Ctrl+Alt+L" };

    let mut menus = Vec::new();
    if macos {
        menus.push(MenuSpec {
            title: "青墨",
            items: vec![
                action(MENU_ABOUT, ABOUT_LABEL, None),
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
            MenuEntry::Checked {
                id: MENU_VIEW_TOGGLE_LIVE_PREVIEW,
                label: "实时预览",
                checked: true,
            },
            action(MENU_PALETTE_OPEN, "命令面板", Some("CmdOrCtrl+K")),
            action(
                MENU_VIEW_TOGGLE_THEME,
                "切换主题",
                Some("CmdOrCtrl+Shift+L"),
            ),
            MenuEntry::Separator,
            action(MENU_LOGS, "日志…", Some(logs_accel)),
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
            items: vec![action(MENU_ABOUT, ABOUT_LABEL, None)],
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
            MenuEntry::Checked { id, label, checked } => menu.append(&CheckMenuItem::with_id(
                app,
                *id,
                *label,
                true,
                *checked,
                None::<&str>,
            )?)?,
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

/// Mirrors a window's Live Preview mode in the shared native menu.
///
/// The menu bar is app-wide, so each mode change (menu, palette, or a new
/// document window) must update the same check item.
pub(crate) fn set_live_preview_checked<R: Runtime>(
    app: &AppHandle<R>,
    checked: bool,
) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    // The toggle lives inside the "显示" submenu, so a top-level lookup alone
    // would never find it.
    for item in menu.items()? {
        let target = match &item {
            MenuItemKind::Check(target)
                if target.id().as_ref() == MENU_VIEW_TOGGLE_LIVE_PREVIEW =>
            {
                Some(target.clone())
            }
            MenuItemKind::Submenu(submenu) => match submenu.get(MENU_VIEW_TOGGLE_LIVE_PREVIEW) {
                Some(MenuItemKind::Check(target)) => Some(target),
                _ => None,
            },
            _ => None,
        };
        if let Some(target) = target {
            target.set_checked(checked)?;
            break;
        }
    }
    Ok(())
}

/// The window that owns the menu action.
///
/// A menu action is delivered while the native menu bar owns focus, so
/// `is_focused()` can be false for every window. The last focus event is the
/// stable source of truth; live focus and `main` are fallbacks for the first
/// event after startup.
fn focused_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.state::<state::FocusTracker>()
        .get()
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| {
            app.webview_windows()
                .values()
                .find(|window| window.is_focused().unwrap_or(false))
                .cloned()
        })
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().values().next().cloned())
}

/// The window that should receive a document-level menu command.
///
/// The About window owns focus while it is open, but File/Edit/theme actions
/// must keep operating on the last editable window.
fn command_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.state::<state::FocusTracker>()
        .get_command_target()
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| {
            app.webview_windows()
                .values()
                .find(|window| window.label() != ABOUT_WINDOW_LABEL)
                .cloned()
        })
}

/// How long the launch waits for an OS open request before creating the blank
/// main window.
///
/// Finder and `open(1)` deliver the Apple event while the app is still
/// launching, well inside this budget, so a document open never leaves an
/// extra empty window behind.
const MAIN_WINDOW_BOOT_DELAY: Duration = Duration::from_millis(300);

/// Creates the configured `main` window when it does not exist yet.
///
/// The window is declared with `create: false` so a launch caused by opening a
/// document can skip it. A failed open falls back to it instead of ending the
/// launch with no window at all.
fn ensure_main_window(app: &AppHandle) {
    if app.get_webview_window("main").is_some() {
        return;
    }

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        tracing::error!("the main window config is missing");
        return;
    };

    if let Err(error) =
        WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build())
    {
        tracing::error!(%error, "failed to create the main window");
    }
}

fn toggle_fullscreen<R: Runtime>(window: &WebviewWindow<R>) {
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            let target = focused_window(app);
            let target_label = target.as_ref().map(|window| window.label().to_string());

            if id == MENU_ABOUT {
                if let Err(error) = open_about(app) {
                    tracing::error!(%error, "failed to open the About window");
                }
                return;
            }
            if id == MENU_QUIT {
                commands::close::request_close(
                    app,
                    ipc::dto::CloseReason::Exit,
                    target_label.as_deref(),
                );
                return;
            }
            if id == MENU_CLOSE_WINDOW {
                if let Some(window) = target.as_ref() {
                    if window.label() == ABOUT_WINDOW_LABEL {
                        // The About window has no unsaved state; destroying it
                        // directly keeps Cmd+W and the red dot symmetrical.
                        if let Err(error) = window.destroy() {
                            tracing::warn!(%error, "failed to close the About window");
                        }
                    } else {
                        commands::close::request_close(
                            app,
                            ipc::dto::CloseReason::Window,
                            Some(window.label()),
                        );
                    }
                }
                return;
            }
            if id == MENU_TOGGLE_FULLSCREEN {
                if let Some(window) = target.as_ref() {
                    if window.label() != ABOUT_WINDOW_LABEL {
                        toggle_fullscreen(window);
                    }
                }
                return;
            }

            if MENU_ACTIONS.contains(&id) {
                match command_window(app) {
                    Some(window) => {
                        // `Emitter::emit` is global; target only the editable
                        // window or every window would run the same command.
                        if let Err(error) = window.emit_to(
                            window.label(),
                            EVENT_MENU_ACTION,
                            MenuActionPayload {
                                action: id.to_string(),
                                target: window.label().to_string(),
                            },
                        ) {
                            tracing::error!(menu_action = id, %error, "failed to emit menu action");
                        }
                    }
                    None => tracing::warn!(menu_action = id, "no window to receive menu action"),
                }
            }
        })
        .manage(state::DocumentRegistry::new())
        .manage(state::WindowSessions::new())
        .manage(state::CloseGuard::new())
        .manage(state::FocusTracker::new())
        .manage(state::PreviewModes::new())
        .manage(state::StartupWindow::new())
        .setup(|app| {
            app.manage(app.handle().clone());
            let registry = app.state::<state::DocumentRegistry>().inner().clone();
            app.manage(state::DocumentWatcher::start(
                app.handle().clone(),
                registry,
            ));
            let log_dir = app.path().app_log_dir().ok();
            if let Some(dir) = log_dir.as_ref() {
                if let Err(error) = services::logging::init(dir.clone()) {
                    eprintln!("failed to initialize the log directory: {error}");
                }
            }
            services::logging::install_panic_hook();
            init_tracing(log_dir.as_ref());
            tracing::info!(
                version = %app.package_info().version,
                log_dir = %services::logging::dir().display(),
                "Qingmo started"
            );
            app.manage(state::UpdateManager::new(
                app.package_info().version.to_string(),
            ));
            // The main window is opt-in: give an OS open request the chance to
            // become the only window before falling back to an empty editor.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(MAIN_WINDOW_BOOT_DELAY).await;
                if !handle.state::<state::StartupWindow>().was_opened() {
                    ensure_main_window(&handle);
                }
            });
            Ok(())
        })
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("error while building Qingmo");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Focused(true),
            ..
        } => {
            let tracker = app_handle.state::<state::FocusTracker>();
            if label == ABOUT_WINDOW_LABEL {
                // Keep the last document as the menu command target.
                tracker.set_auxiliary(&label);
            } else {
                tracker.set(&label);
                // The menu is shared: show the newly focused window's mode.
                let checked = app_handle
                    .state::<state::PreviewModes>()
                    .get(&label)
                    .unwrap_or(true);
                if let Err(error) = set_live_preview_checked(app_handle, checked) {
                    tracing::warn!(%error, "failed to sync the live preview menu state");
                }
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } => {
            app_handle.state::<state::FocusTracker>().clear(&label);
            app_handle.state::<state::PreviewModes>().clear(&label);
            // A window can be destroyed without the normal close handshake
            // (for example a crashed webview); release the document and its
            // watcher so the registry does not outlive the window.
            if let Some(token) = app_handle.state::<state::WindowSessions>().release(&label) {
                app_handle
                    .state::<state::DocumentRegistry>()
                    .release(&token);
                if let Some(watcher) = app_handle.try_state::<state::DocumentWatcher>() {
                    watcher.unwatch(&token);
                }
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if label == ABOUT_WINDOW_LABEL {
                // No document state to flush; let the native close proceed.
                return;
            }
            api.prevent_close();
            commands::close::request_close(
                app_handle,
                ipc::dto::CloseReason::Window,
                Some(label.as_str()),
            );
        }
        // Finder, `open(1)` and Dock drops deliver documents through the OS
        // open event instead of the in-app dialog. Each supported file gets the
        // same new-window path as `file.open`, so the platform never depends on
        // the dialog having run.
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = commands::document::opened_paths(&urls);
            if paths.is_empty() {
                return;
            }
            // Skip the blank main window even if it has not started building.
            app_handle.state::<state::StartupWindow>().mark_opened();
            for path in paths {
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        commands::document::open_path_in_new_window(app.clone(), path).await
                    {
                        tracing::warn!(%error, "failed to open a file from the operating system");
                        // A launch open that failed must not end windowless.
                        if app.webview_windows().is_empty() {
                            ensure_main_window(&app);
                        }
                    }
                });
            }
        }
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            commands::close::request_close(app_handle, ipc::dto::CloseReason::Exit, None);
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
                MenuEntry::Action { id, .. } | MenuEntry::Checked { id, .. } => Some(*id),
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
        let rust_handled = [
            MENU_ABOUT,
            MENU_QUIT,
            MENU_CLOSE_WINDOW,
            MENU_TOGGLE_FULLSCREEN,
        ];
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
        assert!(action_ids(app_menu).contains(&MENU_ABOUT));
        assert!(action_ids(app_menu).contains(&MENU_QUIT));
        assert_eq!(action_label(action(app_menu, MENU_ABOUT)), "关于青墨");

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
        assert!(view_menu.items.contains(&MenuEntry::Checked {
            id: MENU_VIEW_TOGGLE_LIVE_PREVIEW,
            label: "实时预览",
            checked: true,
        }));

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
        assert_eq!(action_ids(help_menu), [MENU_ABOUT]);
        assert_eq!(action_label(action(help_menu, MENU_ABOUT)), "关于青墨");

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
