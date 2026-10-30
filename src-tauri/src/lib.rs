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
mod startup_locale;
pub mod state;

use commands::about::{open_about, ABOUT_WINDOW_LABEL};
use commands::settings::{open_settings, SETTINGS_WINDOW_LABEL};
use ipc::contract::{
    EVENT_MENU_ACTION, MENU_ACTIONS, MENU_FILE_OPEN, MENU_FILE_SAVE, MENU_LANGUAGE_EN,
    MENU_LANGUAGE_ZH_CN, MENU_PALETTE_OPEN, MENU_THEME_DARK, MENU_THEME_LIGHT, MENU_THEME_SYSTEM,
    MENU_VIEW_TOGGLE_LIVE_PREVIEW, MENU_VIEW_TOGGLE_OUTLINE, MENU_VIEW_TOGGLE_THEME,
};
use ipc::dto::{AppLanguage, MenuActionPayload, NativeShellLabels};

/// Menu ids handled in Rust instead of being forwarded to the webview.
const MENU_ABOUT: &str = "app.about";
const MENU_SETTINGS: &str = "app.openSettings";
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
struct MenuSpec<'a> {
    title: &'a str,
    items: Vec<MenuEntry<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MenuEntry<'a> {
    Separator,
    Services(&'a str),
    Hide(&'a str),
    HideOthers(&'a str),
    ShowAll(&'a str),
    Undo(&'a str),
    Redo(&'a str),
    Cut(&'a str),
    Copy(&'a str),
    Paste(&'a str),
    SelectAll(&'a str),
    Minimize(&'a str),
    Maximize(&'a str),
    BringAllToFront(&'a str),
    Action {
        id: &'static str,
        label: &'a str,
        accelerator: Option<&'a str>,
    },
    /// A toggle that shows a checkmark while the mode is active.
    Checked {
        id: &'static str,
        label: &'a str,
        checked: bool,
    },
    Submenu(MenuSpec<'a>),
}

fn action<'a>(id: &'static str, label: &'a str, accelerator: Option<&'a str>) -> MenuEntry<'a> {
    MenuEntry::Action {
        id,
        label,
        accelerator,
    }
}

/// Builds the localized application menu for macOS and Windows.
///
/// Rust owns no copy: every title and label comes from the frontend-projected
/// `NativeShellLabels`. The default Tauri menu exposes File/Edit/View/Window/
/// Help entries that do not match Qingmo's command surface, so this layout
/// keeps only working items: file operations, native editing actions,
/// view/theme/language toggles and window controls. Custom items are forwarded
/// to the webview through `app://menu-action`; native predefined items
/// (undo/copy/paste) stay in the platform so the first responder keeps handling
/// text editing.
///
/// Platform differences:
/// - macOS keeps the standard application submenu and Window's "Bring All to
///   Front"; Quit lives in the app submenu.
/// - Windows uses the in-window menu bar: Quit lives in File and Help carries
///   the About dialog.
///
/// Quit/close/fullscreen deliberately use custom items: quitting through the
/// platform default (`NSApplication terminate:` / `PostQuitMessage`) bypasses
/// CloseGuard, so both platforms route these actions through the Rust guard.
fn menu_layout<'a>(
    platform: MenuPlatform,
    labels: &'a NativeShellLabels,
    language: AppLanguage,
    live_preview: bool,
) -> Vec<MenuSpec<'a>> {
    let macos = platform == MenuPlatform::Mac;

    let mut file_items = vec![
        action(MENU_FILE_OPEN, &labels.open, Some("CmdOrCtrl+O")),
        action(MENU_FILE_SAVE, &labels.save, Some("CmdOrCtrl+S")),
    ];
    if !macos {
        file_items.push(MenuEntry::Separator);
        file_items.push(action(MENU_SETTINGS, &labels.settings, Some("CmdOrCtrl+,")));
    }
    file_items.push(MenuEntry::Separator);
    file_items.push(action(
        MENU_CLOSE_WINDOW,
        &labels.close_window,
        Some("CmdOrCtrl+W"),
    ));
    if !macos {
        file_items.push(MenuEntry::Separator);
        file_items.push(action(MENU_QUIT, &labels.quit_app, Some("CmdOrCtrl+Q")));
    }

    let mut window_items = vec![
        MenuEntry::Minimize(&labels.minimize),
        MenuEntry::Maximize(if macos {
            &labels.zoom
        } else {
            &labels.maximize
        }),
    ];
    if macos {
        window_items.push(MenuEntry::Separator);
        window_items.push(MenuEntry::BringAllToFront(&labels.bring_all_to_front));
    }

    let fullscreen_accel = if macos { "Ctrl+Cmd+F" } else { "F11" };
    let logs_accel = if macos { "Cmd+Alt+L" } else { "Ctrl+Alt+L" };

    let language_menu = MenuEntry::Submenu(MenuSpec {
        title: &labels.language,
        items: vec![
            MenuEntry::Checked {
                id: MENU_LANGUAGE_ZH_CN,
                label: &labels.language_zh_cn,
                checked: language == AppLanguage::ZhCn,
            },
            MenuEntry::Checked {
                id: MENU_LANGUAGE_EN,
                label: &labels.language_en,
                checked: language == AppLanguage::En,
            },
        ],
    });

    let mut menus = Vec::new();
    if macos {
        menus.push(MenuSpec {
            title: &labels.app_name,
            items: vec![
                action(MENU_ABOUT, &labels.about, None),
                action(MENU_SETTINGS, &labels.settings, Some("CmdOrCtrl+,")),
                MenuEntry::Separator,
                MenuEntry::Services(&labels.services),
                MenuEntry::Separator,
                MenuEntry::Hide(&labels.hide_app),
                MenuEntry::HideOthers(&labels.hide_others),
                MenuEntry::ShowAll(&labels.show_all),
                MenuEntry::Separator,
                action(MENU_QUIT, &labels.quit_app, Some("CmdOrCtrl+Q")),
            ],
        });
    }
    menus.push(MenuSpec {
        title: &labels.file,
        items: file_items,
    });
    menus.push(MenuSpec {
        title: &labels.edit,
        items: vec![
            MenuEntry::Undo(&labels.undo),
            MenuEntry::Redo(&labels.redo),
            MenuEntry::Separator,
            MenuEntry::Cut(&labels.cut),
            MenuEntry::Copy(&labels.copy),
            MenuEntry::Paste(&labels.paste),
            MenuEntry::SelectAll(&labels.select_all),
        ],
    });
    menus.push(MenuSpec {
        title: &labels.view,
        items: vec![
            MenuEntry::Checked {
                id: MENU_VIEW_TOGGLE_LIVE_PREVIEW,
                label: &labels.live_preview,
                checked: live_preview,
            },
            action(MENU_VIEW_TOGGLE_OUTLINE, &labels.outline, None),
            action(
                MENU_PALETTE_OPEN,
                &labels.command_palette,
                Some("CmdOrCtrl+K"),
            ),
            action(
                MENU_VIEW_TOGGLE_THEME,
                &labels.toggle_theme,
                Some("CmdOrCtrl+Shift+L"),
            ),
            MenuEntry::Separator,
            language_menu,
            MenuEntry::Separator,
            action(MENU_LOGS, &labels.logs, Some(logs_accel)),
            action(
                MENU_TOGGLE_FULLSCREEN,
                &labels.fullscreen,
                Some(fullscreen_accel),
            ),
        ],
    });
    menus.push(MenuSpec {
        title: &labels.theme,
        items: vec![
            action(MENU_THEME_LIGHT, &labels.theme_light, None),
            action(MENU_THEME_DARK, &labels.theme_dark, None),
            action(MENU_THEME_SYSTEM, &labels.theme_system, None),
        ],
    });
    menus.push(MenuSpec {
        title: &labels.window,
        items: window_items,
    });
    if !macos {
        menus.push(MenuSpec {
            title: &labels.help,
            items: vec![action(MENU_ABOUT, &labels.about, None)],
        });
    }

    menus
}

/// Last-resort fallback when the bundled startup labels cannot be parsed.
///
/// The normal startup path builds the complete localized menu from the shared
/// frontend menu resources, so the menu never changes when the webview sends
/// its first projection. If that resource is damaged, this minimal neutral
/// menu still keeps Quit on the CloseGuard path and text editing usable. It
/// must never fall back to `Menu::default`, whose platform Quit bypasses the
/// guard and whose About item would add a second copy source.
fn startup_layout(platform: MenuPlatform) -> Vec<MenuSpec<'static>> {
    let macos = platform == MenuPlatform::Mac;
    let mut file_items = vec![action(
        MENU_CLOSE_WINDOW,
        "Close Window",
        Some("CmdOrCtrl+W"),
    )];
    if !macos {
        file_items.push(MenuEntry::Separator);
        file_items.push(action(MENU_QUIT, "Quit", Some("CmdOrCtrl+Q")));
    }

    let mut menus = Vec::new();
    if macos {
        menus.push(MenuSpec {
            title: "青墨",
            items: vec![
                MenuEntry::Separator,
                action(MENU_QUIT, "Quit", Some("CmdOrCtrl+Q")),
            ],
        });
    }
    menus.push(MenuSpec {
        title: "File",
        items: file_items,
    });
    menus.push(MenuSpec {
        title: "Edit",
        items: vec![
            MenuEntry::Undo("Undo"),
            MenuEntry::Redo("Redo"),
            MenuEntry::Separator,
            MenuEntry::Cut("Cut"),
            MenuEntry::Copy("Copy"),
            MenuEntry::Paste("Paste"),
            MenuEntry::SelectAll("Select All"),
        ],
    });
    menus
}

/// Materializes one declarative menu into native items.
fn build_submenu<'a, R: Runtime>(
    app: &AppHandle<R>,
    spec: &MenuSpec<'a>,
) -> tauri::Result<Submenu<R>> {
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
            MenuEntry::Submenu(spec) => menu.append(&build_submenu(app, spec)?)?,
        }
    }
    Ok(menu)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let language = startup_locale::language(app);
    if let Some(labels) = startup_locale::labels_for(language) {
        let layout = menu_layout(menu_platform(), &labels, language, true);
        return build_menu_with_layout(app, &layout);
    }

    // The bundled JSON is verified by unit tests; this branch only protects a
    // damaged build from starting without any menu.
    eprintln!("startup menu labels could not be parsed; using the neutral fallback");
    let layout = startup_layout(menu_platform());
    build_menu_with_layout(app, &layout)
}

/// Builds the first localized menu from the frontend projection.
fn build_menu_for<R: Runtime>(
    app: &AppHandle<R>,
    platform: MenuPlatform,
    labels: &NativeShellLabels,
    language: AppLanguage,
    live_preview: bool,
) -> tauri::Result<Menu<R>> {
    let layout = menu_layout(platform, labels, language, live_preview);
    build_menu_with_layout(app, &layout)
}

fn build_menu_with_layout<'a, R: Runtime>(
    app: &AppHandle<R>,
    layout: &[MenuSpec<'a>],
) -> tauri::Result<Menu<R>> {
    let menus = layout
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

/// The checkmark for "Live Preview" on the shared menu.
///
/// About can own keyboard focus while a locale projection arrives; using the
/// command target keeps the last editable window's mode instead of resetting
/// the toggle to the startup default.
fn current_live_preview_checked<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<state::FocusTracker>()
        .get_command_target()
        .and_then(|label| app.state::<state::PreviewModes>().get(&label))
        .unwrap_or(true)
}

/// Resolves the title for one window from the current projection.
///
/// A token without a registry entry means the document is closing or being
/// saved across a race: keep the current title instead of falling back to the
/// application name.
fn resolve_window_title(
    label: &str,
    labels: &NativeShellLabels,
    sessions: &state::WindowSessions,
    registry: &state::DocumentRegistry,
) -> Option<String> {
    if label == ABOUT_WINDOW_LABEL {
        return Some(labels.about.clone());
    }
    if label == SETTINGS_WINDOW_LABEL {
        return Some(labels.settings.clone());
    }
    if let Some(path) = sessions.pending_path(label) {
        return Some(commands::document::window_title_for(
            &path,
            &labels.app_name,
        ));
    }
    if let Some(token) = sessions.token_for(label) {
        return registry.get(&token).ok().map(|record| {
            commands::document::window_title_for(&record.canonical_target, &labels.app_name)
        });
    }
    Some(labels.app_name.clone())
}

/// Applies the projected labels to every open native window title.
fn apply_window_titles<R: Runtime>(app: &AppHandle<R>, labels: &NativeShellLabels) {
    let sessions = app.state::<state::WindowSessions>();
    let registry = app.state::<state::DocumentRegistry>();
    for window in app.webview_windows().values() {
        if let Some(title) = resolve_window_title(window.label(), labels, &sessions, &registry) {
            if let Err(error) = window.set_title(&title) {
                tracing::warn!(
                    %error,
                    label = window.label(),
                    "failed to update the window title"
                );
            }
        }
    }
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

    let labels = app.state::<state::ShellLocale>().labels();
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| {
        let builder = match labels.as_ref() {
            // The config title is the product default; use the startup
            // projection so an English launch does not briefly show it.
            Some(labels) => builder.title(labels.app_name.clone()),
            None => builder,
        };
        builder.build()
    });
    if let Err(error) = built {
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
            if id == MENU_SETTINGS {
                if let Err(error) = open_settings(app) {
                    tracing::error!(%error, "failed to open the settings window");
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
                    if window.label() == ABOUT_WINDOW_LABEL
                        || window.label() == SETTINGS_WINDOW_LABEL
                    {
                        // Auxiliary windows have no unsaved state; destroying
                        // them directly keeps Cmd+W and the red dot symmetrical.
                        if let Err(error) = window.destroy() {
                            tracing::warn!(%error, label = window.label(), "failed to close an auxiliary window");
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
                    if window.label() != ABOUT_WINDOW_LABEL
                        && window.label() != SETTINGS_WINDOW_LABEL
                    {
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
        .manage(state::ShellLocale::default())
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
            // Session storage is optional: a broken data directory disables
            // drafts/view state but must never block startup or fall back to
            // /tmp, which would leak plaintext drafts outside the app sandbox.
            let session_store = match app.path().app_local_data_dir() {
                Ok(dir) => match services::SessionStore::open(dir.join("session")) {
                    Ok(store) => store,
                    Err(error) => {
                        tracing::warn!(%error, "session storage is unavailable; drafts and view state are disabled");
                        services::SessionStore::disabled()
                    }
                },
                Err(error) => {
                    tracing::warn!(%error, "application data directory is unavailable; session storage is disabled");
                    services::SessionStore::disabled()
                }
            };
            if session_store.is_ready() {
                let gc_store = session_store.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let report = gc_store.gc();
                    if report.drafts_removed > 0
                        || report.view_entries_removed > 0
                        || report.corrupt_files_removed > 0
                    {
                        tracing::info!(
                            drafts = report.drafts_removed,
                            view_entries = report.view_entries_removed,
                            corrupt = report.corrupt_files_removed,
                            "session storage garbage-collected"
                        );
                    }
                });
            }
            app.manage(session_store);
            tracing::info!(
                version = %app.package_info().version,
                log_dir = %services::logging::dir().display(),
                "Qingmo started"
            );
            // Seed the shell projection before any window can be created. The
            // first webview projection then matches the startup menu and does
            // not rebuild it, so the menu bar never visibly changes on load.
            let startup_language = startup_locale::language(app.handle());
            if let Some(labels) = startup_locale::labels_for(startup_language) {
                app.state::<state::ShellLocale>()
                    .replace(startup_language, labels);
            }
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

    // Windows passes a file association as a command-line argument; macOS
    // delivers it through `RunEvent::Opened` instead.
    #[cfg(windows)]
    let mut startup_documents = commands::document::startup_paths(std::env::args_os());

    app.run(move |app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Focused(true),
            ..
        } => {
            let tracker = app_handle.state::<state::FocusTracker>();
            if label == ABOUT_WINDOW_LABEL || label == SETTINGS_WINDOW_LABEL {
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
            if label == ABOUT_WINDOW_LABEL || label == SETTINGS_WINDOW_LABEL {
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
        #[cfg(windows)]
        RunEvent::Ready => {
            if startup_documents.is_empty() {
                return;
            }
            let paths = std::mem::take(&mut startup_documents);
            // Skip the blank main window even if it has not started building.
            app_handle.state::<state::StartupWindow>().mark_opened();
            tracing::info!(
                count = paths.len(),
                "opening documents from the command line"
            );
            for path in paths {
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        commands::document::open_path_in_new_window(app.clone(), path).await
                    {
                        tracing::warn!(%error, "failed to open a file from the command line");
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

    fn labels(prefix: &str) -> NativeShellLabels {
        NativeShellLabels {
            app_name: format!("{prefix}-app"),
            about: format!("{prefix}-about"),
            settings: format!("{prefix}-settings"),
            services: format!("{prefix}-services"),
            hide_app: format!("{prefix}-hide"),
            hide_others: format!("{prefix}-hide-others"),
            show_all: format!("{prefix}-show-all"),
            quit_app: format!("{prefix}-quit"),
            file: format!("{prefix}-file"),
            open: format!("{prefix}-open"),
            save: format!("{prefix}-save"),
            close_window: format!("{prefix}-close"),
            edit: format!("{prefix}-edit"),
            undo: format!("{prefix}-undo"),
            redo: format!("{prefix}-redo"),
            cut: format!("{prefix}-cut"),
            copy: format!("{prefix}-copy"),
            paste: format!("{prefix}-paste"),
            select_all: format!("{prefix}-select-all"),
            view: format!("{prefix}-view"),
            live_preview: format!("{prefix}-live-preview"),
            outline: format!("{prefix}-outline"),
            command_palette: format!("{prefix}-palette"),
            toggle_theme: format!("{prefix}-toggle-theme"),
            logs: format!("{prefix}-logs"),
            fullscreen: format!("{prefix}-fullscreen"),
            theme: format!("{prefix}-theme"),
            theme_light: format!("{prefix}-light"),
            theme_dark: format!("{prefix}-dark"),
            theme_system: format!("{prefix}-system"),
            language: format!("{prefix}-language"),
            language_zh_cn: format!("{prefix}-zh"),
            language_en: format!("{prefix}-en"),
            window: format!("{prefix}-window"),
            minimize: format!("{prefix}-minimize"),
            zoom: format!("{prefix}-zoom"),
            maximize: format!("{prefix}-maximize"),
            bring_all_to_front: format!("{prefix}-bring-all"),
            help: format!("{prefix}-help"),
            untitled_file_name: format!("{prefix}.md"),
        }
    }

    fn titles<'a>(layout: &'a [MenuSpec<'a>]) -> Vec<&'a str> {
        layout.iter().map(|menu| menu.title).collect()
    }

    fn menu<'a>(layout: &'a [MenuSpec<'a>], title: &str) -> &'a MenuSpec<'a> {
        layout
            .iter()
            .find(|menu| menu.title == title)
            .unwrap_or_else(|| panic!("menu {title} must exist"))
    }

    fn submenu<'a>(menu: &'a MenuSpec<'a>, title: &str) -> &'a MenuSpec<'a> {
        menu.items
            .iter()
            .find_map(|item| match item {
                MenuEntry::Submenu(spec) if spec.title == title => Some(spec),
                _ => None,
            })
            .unwrap_or_else(|| panic!("submenu {title} must exist"))
    }

    fn action_ids<'a>(menu: &'a MenuSpec<'a>) -> Vec<&'a str> {
        menu.items
            .iter()
            .flat_map(|item| match item {
                MenuEntry::Action { id, .. } | MenuEntry::Checked { id, .. } => vec![*id],
                MenuEntry::Submenu(spec) => action_ids(spec),
                _ => Vec::new(),
            })
            .collect()
    }

    fn layout_action_ids<'a>(layout: &'a [MenuSpec<'a>]) -> Vec<&'a str> {
        layout.iter().flat_map(action_ids).collect()
    }

    fn action<'a>(menu: &'a MenuSpec<'a>, id: &str) -> &'a MenuEntry<'a> {
        menu.items
            .iter()
            .find(|item| matches!(item, MenuEntry::Action { id: item_id, .. } if *item_id == id))
            .unwrap_or_else(|| panic!("action {id} must exist"))
    }

    fn action_label<'a>(entry: &'a MenuEntry<'a>) -> &'a str {
        match entry {
            MenuEntry::Action { label, .. } => label,
            other => panic!("expected an action, got {other:?}"),
        }
    }

    fn action_accelerator<'a>(entry: &'a MenuEntry<'a>) -> Option<&'a str> {
        match entry {
            MenuEntry::Action { accelerator, .. } => *accelerator,
            other => panic!("expected an action, got {other:?}"),
        }
    }

    /// Every id used by a custom menu item must have a handler: either the
    /// webview dispatcher or one of the Rust-side window/quit actions.
    fn assert_every_action_has_a_handler(layout: &[MenuSpec<'_>]) {
        let rust_handled = [
            MENU_ABOUT,
            MENU_SETTINGS,
            MENU_QUIT,
            MENU_CLOSE_WINDOW,
            MENU_TOGGLE_FULLSCREEN,
        ];
        for id in layout_action_ids(layout) {
            assert!(
                MENU_ACTIONS.contains(&id) || rust_handled.contains(&id),
                "menu action {id} has no handler"
            );
        }
    }

    #[test]
    fn macos_layout_uses_the_projected_labels() {
        let labels = labels("zh");
        let layout = menu_layout(MenuPlatform::Mac, &labels, AppLanguage::ZhCn, true);

        assert_eq!(
            titles(&layout),
            [
                "zh-app",
                "zh-file",
                "zh-edit",
                "zh-view",
                "zh-theme",
                "zh-window"
            ]
        );

        let app_menu = menu(&layout, "zh-app");
        assert_eq!(action_label(action(app_menu, MENU_ABOUT)), "zh-about");
        assert_eq!(action_label(action(app_menu, MENU_SETTINGS)), "zh-settings");
        assert_eq!(
            action_accelerator(action(app_menu, MENU_SETTINGS)),
            Some("CmdOrCtrl+,")
        );
        assert!(action_ids(app_menu).contains(&MENU_QUIT));
        assert_eq!(
            action_accelerator(action(app_menu, MENU_QUIT)),
            Some("CmdOrCtrl+Q")
        );

        let file_menu = menu(&layout, "zh-file");
        let file_ids = action_ids(file_menu);
        assert!(file_ids.contains(&MENU_FILE_OPEN));
        assert!(file_ids.contains(&MENU_FILE_SAVE));
        assert!(file_ids.contains(&MENU_CLOSE_WINDOW));
        assert!(!file_ids.contains(&MENU_QUIT));
        assert!(
            !file_ids.contains(&MENU_SETTINGS),
            "macOS keeps settings in the application menu"
        );
        assert_eq!(action_label(action(file_menu, MENU_FILE_OPEN)), "zh-open");

        assert_eq!(
            menu(&layout, "zh-window").items.last(),
            Some(&MenuEntry::BringAllToFront("zh-bring-all"))
        );
        assert_eq!(
            menu(&layout, "zh-window").items[1],
            MenuEntry::Maximize("zh-zoom")
        );

        let view_menu = menu(&layout, "zh-view");
        assert_eq!(
            action_accelerator(action(view_menu, MENU_TOGGLE_FULLSCREEN)),
            Some("Ctrl+Cmd+F")
        );
        assert!(view_menu.items.contains(&MenuEntry::Checked {
            id: MENU_VIEW_TOGGLE_LIVE_PREVIEW,
            label: "zh-live-preview",
            checked: true,
        }));
        assert_eq!(
            action_label(action(view_menu, MENU_VIEW_TOGGLE_OUTLINE)),
            "zh-outline"
        );

        let language_menu = submenu(view_menu, "zh-language");
        assert_eq!(
            action_ids(language_menu),
            [MENU_LANGUAGE_ZH_CN, MENU_LANGUAGE_EN]
        );
        assert_eq!(
            language_menu.items[0],
            MenuEntry::Checked {
                id: MENU_LANGUAGE_ZH_CN,
                label: "zh-zh",
                checked: true,
            }
        );
        assert_eq!(
            language_menu.items[1],
            MenuEntry::Checked {
                id: MENU_LANGUAGE_EN,
                label: "zh-en",
                checked: false,
            }
        );

        assert_every_action_has_a_handler(&layout);
    }

    #[test]
    fn windows_layout_puts_quit_in_file_and_help_uses_the_labels() {
        let labels = labels("en");
        let layout = menu_layout(MenuPlatform::Other, &labels, AppLanguage::En, false);

        assert_eq!(
            titles(&layout),
            [
                "en-file",
                "en-edit",
                "en-view",
                "en-theme",
                "en-window",
                "en-help"
            ]
        );

        let file_menu = menu(&layout, "en-file");
        let file_ids = action_ids(file_menu);
        assert!(file_ids.contains(&MENU_QUIT));
        assert!(file_ids.contains(&MENU_SETTINGS));
        assert_eq!(
            action_label(action(file_menu, MENU_SETTINGS)),
            "en-settings"
        );
        assert_eq!(
            action_accelerator(action(file_menu, MENU_SETTINGS)),
            Some("CmdOrCtrl+,")
        );
        assert_eq!(action_label(action(file_menu, MENU_QUIT)), "en-quit");
        assert_eq!(
            action_accelerator(action(file_menu, MENU_QUIT)),
            Some("CmdOrCtrl+Q")
        );

        let help_menu = menu(&layout, "en-help");
        assert_eq!(action_ids(help_menu), [MENU_ABOUT]);
        assert_eq!(action_label(action(help_menu, MENU_ABOUT)), "en-about");

        assert_eq!(
            menu(&layout, "en-window").items,
            [
                MenuEntry::Minimize("en-minimize"),
                MenuEntry::Maximize("en-maximize")
            ]
        );

        let view_menu = menu(&layout, "en-view");
        assert_eq!(
            action_accelerator(action(view_menu, MENU_TOGGLE_FULLSCREEN)),
            Some("F11")
        );
        let language_menu = submenu(view_menu, "en-language");
        assert_eq!(
            language_menu.items[0],
            MenuEntry::Checked {
                id: MENU_LANGUAGE_ZH_CN,
                label: "en-zh",
                checked: false,
            }
        );
        assert!(matches!(
            language_menu.items[1],
            MenuEntry::Checked {
                id: MENU_LANGUAGE_EN,
                checked: true,
                ..
            }
        ));

        assert_every_action_has_a_handler(&layout);
    }

    #[test]
    fn both_layouts_expose_every_webview_action_once() {
        for platform in [MenuPlatform::Mac, MenuPlatform::Other] {
            let labels = labels("test");
            let layout = menu_layout(platform, &labels, AppLanguage::ZhCn, true);
            let ids = layout_action_ids(&layout);
            for expected in MENU_ACTIONS {
                assert_eq!(
                    ids.iter().filter(|id| *id == expected).count(),
                    1,
                    "{expected} must appear exactly once in {platform:?}"
                );
            }
            assert_eq!(
                ids.iter().filter(|id| **id == MENU_SETTINGS).count(),
                1,
                "the Rust-handled settings item must appear exactly once in {platform:?}"
            );
        }
    }

    #[test]
    fn startup_menu_keeps_quit_on_the_close_guard_path() {
        for platform in [MenuPlatform::Mac, MenuPlatform::Other] {
            let layout = startup_layout(platform);
            let ids = layout_action_ids(&layout);
            assert_eq!(
                ids.iter().filter(|id| **id == MENU_QUIT).count(),
                1,
                "startup menu must expose exactly one custom Quit on {platform:?}"
            );
            assert!(ids.contains(&MENU_CLOSE_WINDOW));
            assert!(!ids.contains(&MENU_ABOUT));
            assert!(!ids.contains(&MENU_SETTINGS));
            assert_every_action_has_a_handler(&layout);
        }
    }

    #[test]
    fn startup_quit_routes_through_the_close_guard() {
        let source = include_str!("lib.rs");
        let arm = source
            .split("if id == MENU_QUIT")
            .nth(1)
            .expect("the menu handler must special-case MENU_QUIT");
        assert!(
            arm[..arm.len().min(400)].contains("commands::close::request_close"),
            "MENU_QUIT must route through CloseGuard, not the platform default"
        );
    }

    #[test]
    fn window_titles_resolve_pending_tokens_and_missing_records() {
        use crate::ipc::dto::{FilePayload, LineEnding, TextEncoding, TextFormat};

        fn payload(path: &str, token: &str) -> FilePayload {
            FilePayload {
                doc_token: token.to_string(),
                path: path.to_string(),
                text: "hello\n".to_string(),
                format: TextFormat {
                    encoding: TextEncoding::Utf8,
                    has_bom: false,
                    eol: LineEnding::Lf,
                },
                mixed_eol: false,
                hash: "a".repeat(64),
                size: 6,
                text_units: 6,
                mtime_ms: 1_700_000_000_000,
                read_only: false,
                read_only_reason: None,
            }
        }

        let labels = labels("zh");
        let sessions = state::WindowSessions::new();
        let registry = state::DocumentRegistry::new();

        assert_eq!(
            resolve_window_title("main", &labels, &sessions, &registry).as_deref(),
            Some("zh-app")
        );
        assert_eq!(
            resolve_window_title(ABOUT_WINDOW_LABEL, &labels, &sessions, &registry).as_deref(),
            Some("zh-about")
        );
        assert_eq!(
            resolve_window_title(SETTINGS_WINDOW_LABEL, &labels, &sessions, &registry).as_deref(),
            Some("zh-settings")
        );

        sessions.stage("doc-pending", payload("/docs/pending.md", "pending-token"));
        assert_eq!(
            resolve_window_title("doc-pending", &labels, &sessions, &registry).as_deref(),
            Some("pending.md — zh-app")
        );

        sessions.set_token("doc-missing", "missing-token".to_string());
        assert_eq!(
            resolve_window_title("doc-missing", &labels, &sessions, &registry),
            None,
            "a token without a registry record must keep the current title"
        );

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("note.md");
        std::fs::write(&path, "hello\n").expect("fixture");
        let opened = registry.open_path(path).expect("fixture must open");
        sessions.set_token("doc-token", opened.doc_token.clone());
        assert_eq!(
            resolve_window_title("doc-token", &labels, &sessions, &registry).as_deref(),
            Some("note.md — zh-app")
        );
    }
}
