//! Document-window creation rules.
//!
//! The window builder itself needs a real event loop, so these tests inject a
//! failing build closure and verify the shared rollback/fallback decision.

use std::time::Duration;

use qingmo_lib::commands::document::{
    create_document_window, create_untitled_window, has_editable_window,
};
use qingmo_lib::error::AppErrorCode;
use qingmo_lib::state::{FocusTracker, ShellLocale, StartupWindow, WindowSessions};
use tauri::Manager;

type MockRuntime = tauri::test::MockRuntime;

fn mock_app() -> tauri::App<MockRuntime> {
    tauri::test::mock_builder()
        .manage(ShellLocale::default())
        .manage(WindowSessions::new())
        .manage(StartupWindow::new())
        .manage(FocusTracker::new())
        .build(tauri::generate_context!())
        .expect("mock app must build")
}

fn failing_build(
    _: &tauri::AppHandle<MockRuntime>,
    _: &str,
    _: String,
) -> tauri::Result<tauri::WebviewWindow<MockRuntime>> {
    Err(tauri::Error::AssetNotFound("missing".to_string()))
}

#[test]
fn auxiliary_windows_are_not_editable() {
    let app = mock_app();
    let handle = app.handle();

    tauri::WebviewWindowBuilder::new(&app, "about", Default::default())
        .build()
        .expect("about window");
    assert!(!has_editable_window(handle));

    tauri::WebviewWindowBuilder::new(&app, "doc-existing", Default::default())
        .build()
        .expect("document window");
    assert!(has_editable_window(handle));
}

#[test]
fn a_failed_window_rolls_back_without_adding_the_main_window() {
    let app = mock_app();
    let handle = app.handle().clone();
    let _existing = tauri::WebviewWindowBuilder::new(&app, "doc-existing", Default::default())
        .build()
        .expect("existing window");
    let rolled_back = std::cell::Cell::new(false);

    let error = create_document_window(
        &handle,
        "doc-new".to_string(),
        "title".to_string(),
        failing_build,
        || rolled_back.set(true),
    )
    .expect_err("the injected build must fail");

    assert_eq!(error.code, AppErrorCode::Io);
    assert!(rolled_back.get());
    assert!(handle.get_webview_window("main").is_none());
}

#[test]
fn a_failed_last_window_falls_back_to_the_main_window() {
    let app = mock_app();
    let handle = app.handle().clone();
    let _about = tauri::WebviewWindowBuilder::new(&app, "about", Default::default())
        .build()
        .expect("about window");

    assert!(create_document_window(
        &handle,
        "doc-new".to_string(),
        "title".to_string(),
        failing_build,
        || {},
    )
    .is_err());

    assert!(handle.get_webview_window("main").is_some());
}

#[test]
fn create_untitled_window_marks_the_window_and_has_no_payload() {
    let app = mock_app();
    let handle = app.handle().clone();

    tauri::async_runtime::block_on(create_untitled_window(handle)).expect("New must succeed");

    let windows = app.webview_windows();
    assert_eq!(windows.len(), 1, "New must create exactly one window");
    let (label, window) = windows
        .iter()
        .find(|(label, _)| label.starts_with("doc-"))
        .expect("New must create a document window");
    assert_eq!(
        window.url().expect("mock URL is readable").path(),
        "/index.html"
    );
    assert_eq!(
        window.url().expect("mock URL is readable").query(),
        Some("window=document")
    );

    let sessions = app.state::<WindowSessions>();
    assert!(sessions.is_untitled(label));
    assert!(app.state::<StartupWindow>().was_opened());

    assert!(sessions.take_pending(label).is_none());
    assert!(
        sessions.is_untitled(label),
        "a New window has no payload, but must stay untitled"
    );

    sessions.set_token(label, "token-after-save-as".to_string());
    assert!(!sessions.is_untitled(label));
    assert_eq!(
        sessions.token_for(label).as_deref(),
        Some("token-after-save-as")
    );
}

#[test]
fn new_reuses_a_main_window_claimed_by_the_startup_timer() {
    let app = mock_app();
    let handle = app.handle().clone();
    assert!(app.state::<StartupWindow>().claim_main_if_undecided());
    let _main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main window");
    app.state::<WindowSessions>().mark_untitled("main");

    tauri::async_runtime::block_on(create_untitled_window(handle)).expect("New must succeed");

    assert_eq!(app.webview_windows().len(), 1);
    assert!(app.state::<WindowSessions>().is_untitled("main"));
    assert!(app.state::<StartupWindow>().was_opened());
}

#[test]
fn new_builds_its_own_window_once_the_main_window_is_ready() {
    let app = mock_app();
    let handle = app.handle().clone();
    let startup = app.state::<StartupWindow>();
    assert!(startup.claim_main_if_undecided());
    let _main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main window");
    app.state::<WindowSessions>().mark_untitled("main");
    startup.mark_main_ready();

    tauri::async_runtime::block_on(create_untitled_window(handle)).expect("New must succeed");

    let windows = app.webview_windows();
    assert_eq!(windows.len(), 2, "a ready main must not be reused");
    assert!(windows.contains_key("main"));
    assert!(windows.keys().any(|label| label.starts_with("doc-")));
    assert!(!app.state::<StartupWindow>().is_main_claimed());
}

#[test]
fn new_stops_waiting_as_soon_as_the_main_build_finishes() {
    let app = mock_app();
    let handle = app.handle().clone();
    let startup = app.state::<StartupWindow>();
    assert!(startup.claim_main_if_undecided());

    let release = app.handle().clone();
    let finishing = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        release.state::<StartupWindow>().mark_main_ready();
    });
    let started = std::time::Instant::now();
    tauri::async_runtime::block_on(create_untitled_window(handle)).expect("New must succeed");
    let waited = started.elapsed();
    finishing.join().expect("release thread must finish");

    assert!(
        waited < Duration::from_millis(300),
        "New waited {waited:?} for a main build that already finished"
    );
    let windows = app.webview_windows();
    assert_eq!(windows.len(), 1);
    assert!(windows.keys().any(|label| label.starts_with("doc-")));
}

#[test]
fn new_creates_a_window_when_the_main_claim_never_built() {
    let app = mock_app();
    let handle = app.handle().clone();
    assert!(app.state::<StartupWindow>().claim_main_if_undecided());

    tauri::async_runtime::block_on(create_untitled_window(handle)).expect("New must succeed");

    let windows = app.webview_windows();
    assert_eq!(windows.len(), 1);
    assert!(windows.keys().any(|label| label.starts_with("doc-")));
}
