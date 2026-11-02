//! Document-window creation rules.
//!
//! The window builder itself needs a real event loop, so these tests inject a
//! failing build closure and verify the shared rollback/fallback decision.

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
    let (label, _window) = windows
        .iter()
        .find(|(label, _)| label.starts_with("doc-"))
        .expect("New must create a document window");

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
