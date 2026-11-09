//! Workspace registry, jail and command-entry integration tests.

use std::path::{Path, PathBuf};

use qingmo_lib::commands::document::{document_activate, open_path_with_document_workspace};
use qingmo_lib::commands::workspace::{
    workspace_current, workspace_list, workspace_locate_document, workspace_open_document,
};
use qingmo_lib::error::AppErrorCode;
use qingmo_lib::state::{
    DocumentRegistry, FocusTracker, ShellLocale, StartupWindow, WindowSessions, WorkspaceRegistry,
    WorkspaceToken,
};
use tauri::Manager;

type MockRuntime = tauri::test::MockRuntime;

fn mock_app() -> tauri::App<MockRuntime> {
    tauri::test::mock_builder()
        .manage(DocumentRegistry::new())
        .manage(WindowSessions::new())
        .manage(WorkspaceRegistry::new())
        .manage(FocusTracker::new())
        .manage(StartupWindow::new())
        .manage(ShellLocale::default())
        .build(tauri::generate_context!())
        .expect("mock app must build")
}

fn window(app: &tauri::App<MockRuntime>, label: &str) -> tauri::WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .expect("mock window must build")
}

fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = std::fs::canonicalize(dir.path()).expect("canonical root");
    (dir, root)
}

fn attach(app: &tauri::App<MockRuntime>, label: &str, root: PathBuf) -> WorkspaceToken {
    let (token, _) = app.state::<WorkspaceRegistry>().open_canonical(root);
    let sessions = app.state::<WindowSessions>();
    sessions
        .set_workspace(label, token.clone(), sessions.epoch(label))
        .expect("attach workspace");
    token
}

#[test]
fn workspace_list_is_scoped_to_the_owning_window_and_jailed() {
    let (_dir, root) = canonical_tempdir();
    std::fs::create_dir(root.join("docs")).expect("docs");
    std::fs::write(root.join("note.md"), "body").expect("note");
    let app = mock_app();
    let owner = window(&app, "doc-1");
    let other = window(&app, "doc-2");
    let token = attach(&app, "doc-1", root.clone());

    let listing = tauri::async_runtime::block_on(workspace_list(
        owner.clone(),
        app.handle().clone(),
        token.as_str().to_string(),
        Vec::new(),
        app.state(),
        app.state(),
    ))
    .expect("owner can list");
    assert_eq!(listing.entries.len(), 2);

    let error = tauri::async_runtime::block_on(workspace_list(
        other,
        app.handle().clone(),
        token.as_str().to_string(),
        Vec::new(),
        app.state(),
        app.state(),
    ))
    .expect_err("another window cannot use the token");
    assert_eq!(error.code, AppErrorCode::InvalidPath);

    let error = tauri::async_runtime::block_on(workspace_list(
        owner,
        app.handle().clone(),
        token.as_str().to_string(),
        vec!["..".to_string()],
        app.state(),
        app.state(),
    ))
    .expect_err("escaping segments must be rejected");
    assert_eq!(error.code, AppErrorCode::InvalidPath);
}

#[test]
fn workspace_current_clears_a_stale_token_without_touching_a_new_one() {
    let (_dir, root) = canonical_tempdir();
    let app = mock_app();
    let owner = window(&app, "doc-1");
    let token = attach(&app, "doc-1", root);

    // Simulate a registry entry disappearing behind the session's back.
    app.state::<WorkspaceRegistry>().release(&token);
    let current = workspace_current(
        owner.clone(),
        app.handle().clone(),
        app.state(),
        app.state(),
    )
    .expect("a stale token resolves to null");
    assert!(current.is_none());
    assert!(app
        .state::<WindowSessions>()
        .workspace_for("doc-1")
        .is_none());

    // A concurrent switch is unaffected by the stale cleanup path.
    let (_dir2, root2) = canonical_tempdir();
    let second = attach(&app, "doc-1", root2);
    let current = workspace_current(owner, app.handle().clone(), app.state(), app.state())
        .expect("the new workspace is valid");
    assert_eq!(current.expect("info").token, second.as_str());
}

#[test]
fn tree_open_returns_a_payload_and_activation_switches_in_place() {
    let (_dir, root) = canonical_tempdir();
    let first_path = root.join("first.md");
    let second_path = root.join("second.md");
    std::fs::write(&first_path, "first").expect("first");
    std::fs::write(&second_path, "second").expect("second");
    let app = mock_app();
    let owner = window(&app, "doc-1");
    let token = attach(&app, "doc-1", root.clone());

    let first = tauri::async_runtime::block_on(workspace_open_document(
        owner.clone(),
        app.handle().clone(),
        token.as_str().to_string(),
        vec!["first.md".to_string()],
        app.state(),
        app.state(),
        app.state(),
    ))
    .expect("tree open returns a payload");
    assert_eq!(
        Path::new(&first.path),
        std::fs::canonicalize(&first_path).expect("canonical first")
    );
    assert_eq!(
        app.webview_windows().len(),
        1,
        "a tree open must not create another window"
    );
    assert!(
        app.state::<WindowSessions>().token_for("doc-1").is_none(),
        "the payload stays unowned until the webview adopts it"
    );

    document_activate(
        owner.clone(),
        app.handle().clone(),
        first.doc_token.clone(),
        app.state(),
        app.state(),
    )
    .expect("first activation");
    assert_eq!(
        app.state::<WindowSessions>().token_for("doc-1").as_deref(),
        Some(first.doc_token.as_str())
    );

    let second = tauri::async_runtime::block_on(workspace_open_document(
        owner.clone(),
        app.handle().clone(),
        token.as_str().to_string(),
        vec!["second.md".to_string()],
        app.state(),
        app.state(),
        app.state(),
    ))
    .expect("second tree open");
    document_activate(
        owner.clone(),
        app.handle().clone(),
        second.doc_token.clone(),
        app.state(),
        app.state(),
    )
    .expect("second activation");
    assert_eq!(
        app.state::<WindowSessions>().token_for("doc-1").as_deref(),
        Some(second.doc_token.as_str())
    );

    let released = app.state::<WindowSessions>().release("doc-1");
    assert_eq!(
        released.doc_token.as_deref(),
        Some(second.doc_token.as_str())
    );
    assert_eq!(
        released.previous_doc_token.as_deref(),
        Some(first.doc_token.as_str()),
        "the replaced document is retained for rollback and released on close"
    );
}

#[test]
fn another_window_cannot_activate_an_owned_document_token() {
    let (_dir, root) = canonical_tempdir();
    let note = root.join("note.md");
    std::fs::write(&note, "body").expect("note");
    let app = mock_app();
    let _owner = window(&app, "doc-1");
    let other = window(&app, "doc-2");
    let payload = app
        .state::<DocumentRegistry>()
        .open_path(note)
        .expect("open document");
    assert!(app
        .state::<WindowSessions>()
        .set_token("doc-1", payload.doc_token.clone()));

    let error = document_activate(
        other,
        app.handle().clone(),
        payload.doc_token.clone(),
        app.state(),
        app.state(),
    )
    .expect_err("a token owned by another window must be rejected");
    assert_eq!(error.code, AppErrorCode::InvalidPath);
    assert_eq!(
        app.state::<WindowSessions>().token_for("doc-1").as_deref(),
        Some(payload.doc_token.as_str())
    );
    assert!(app.state::<WindowSessions>().token_for("doc-2").is_none());
}

#[test]
fn locate_requires_both_the_workspace_and_document_token() {
    let (_dir, root) = canonical_tempdir();
    std::fs::create_dir(root.join("docs")).expect("docs");
    let note = root.join("docs").join("note.md");
    std::fs::write(&note, "body").expect("note");

    let app = mock_app();
    let owner = window(&app, "doc-1");
    let other = window(&app, "doc-2");
    let owner_token = attach(&app, "doc-1", root.clone());
    let other_token = app
        .state::<WorkspaceRegistry>()
        .fork(&owner_token)
        .expect("fork")
        .0;
    app.state::<WindowSessions>()
        .set_workspace(
            "doc-2",
            other_token.clone(),
            app.state::<WindowSessions>().epoch("doc-2"),
        )
        .expect("attach fork");

    let payload = app
        .state::<DocumentRegistry>()
        .open_path(note)
        .expect("open document");
    assert!(app
        .state::<WindowSessions>()
        .set_token("doc-1", payload.doc_token.clone()));

    let located = workspace_locate_document(
        owner.clone(),
        owner_token.as_str().to_string(),
        payload.doc_token.clone(),
        app.state(),
        app.state(),
        app.state(),
    )
    .expect("owner can locate");
    assert_eq!(
        located,
        Some(vec!["docs".to_string(), "note.md".to_string()])
    );

    let error = workspace_locate_document(
        other.clone(),
        owner_token.as_str().to_string(),
        payload.doc_token.clone(),
        app.state(),
        app.state(),
        app.state(),
    )
    .expect_err("another window cannot use the owner's workspace token");
    assert_eq!(error.code, AppErrorCode::InvalidPath);

    let cannot_probe = workspace_locate_document(
        other,
        other_token.as_str().to_string(),
        payload.doc_token.clone(),
        app.state(),
        app.state(),
        app.state(),
    )
    .expect("a foreign doc token is not an error");
    assert!(cannot_probe.is_none());
}

#[cfg(unix)]
#[test]
fn document_reads_reject_a_symlink_swapped_in_after_resolution() {
    let (_dir, root) = canonical_tempdir();
    let outside = tempfile::tempdir().expect("outside");
    let outside_root = std::fs::canonicalize(outside.path()).expect("outside canonical");
    let outside_file = outside_root.join("outside.md");
    std::fs::write(&outside_file, "outside").expect("outside file");
    std::os::unix::fs::symlink(&outside_file, root.join("escape.md")).expect("symlink");

    let registry = DocumentRegistry::new();
    let error = registry
        .open_path_with_root(root.join("escape.md"), &root)
        .expect_err("the read-time jail must reject the escape");
    assert_eq!(error.code, AppErrorCode::OutsideScope);
    assert!(registry.is_empty(), "no document token may be registered");
}

#[test]
fn tree_open_with_an_unknown_parent_token_fails_closed() {
    let (_dir, root) = canonical_tempdir();
    let note = root.join("note.md");
    std::fs::write(&note, "body").expect("note");
    let app = mock_app();

    let error = tauri::async_runtime::block_on(
        qingmo_lib::commands::document::open_path_in_new_window_with_workspace(
            app.handle().clone(),
            note,
            Some(WorkspaceToken::new()),
            true,
        ),
    )
    .expect_err("tree opens require a live parent workspace");
    assert_eq!(error.code, AppErrorCode::OutsideScope);
    assert!(app.state::<DocumentRegistry>().is_empty());
}

#[test]
fn menu_open_outside_the_root_still_inherits_a_forked_workspace() {
    let (_dir, root) = canonical_tempdir();
    let outside = tempfile::tempdir().expect("outside");
    let outside_root = std::fs::canonicalize(outside.path()).expect("outside canonical");
    let note = outside_root.join("note.md");
    std::fs::write(&note, "body").expect("note");
    let app = mock_app();
    let token = attach(&app, "doc-1", root);
    let before = app.state::<WorkspaceRegistry>().len();

    tauri::async_runtime::block_on(
        qingmo_lib::commands::document::open_path_in_new_window_with_workspace(
            app.handle().clone(),
            note,
            Some(token),
            false,
        ),
    )
    .expect("a menu open may target a file outside the workspace");

    assert_eq!(app.state::<WorkspaceRegistry>().len(), before + 1);
    let sessions = app.state::<WindowSessions>();
    let entries = sessions.workspace_entries();
    assert_eq!(entries.len(), 2);
    let child = entries
        .iter()
        .find(|(label, _)| label != "doc-1")
        .expect("the new window owns a fork");
    assert!(child.0.starts_with("doc-"));
}

#[test]
fn menu_open_outside_the_workspace_roots_the_new_window_at_the_file_parent() {
    let (_dir, root) = canonical_tempdir();
    let outside = tempfile::tempdir().expect("outside");
    let outside_root = std::fs::canonicalize(outside.path()).expect("outside canonical");
    let note = outside_root.join("note.md");
    std::fs::write(&note, "body").expect("note");

    let app = mock_app();
    let token = attach(&app, "doc-1", root);
    let before = app.state::<WorkspaceRegistry>().len();

    tauri::async_runtime::block_on(open_path_with_document_workspace(
        app.handle().clone(),
        note,
        Some(token),
    ))
    .expect("menu open");

    // The temporary parent-root token is released; only the new window's
    // forked token remains.
    assert_eq!(app.state::<WorkspaceRegistry>().len(), before + 1);
    let sessions = app.state::<WindowSessions>();
    let (label, child_token) = sessions
        .workspace_entries()
        .into_iter()
        .find(|(label, _)| label != "doc-1")
        .expect("the new window owns a workspace");
    assert!(label.starts_with("doc-"));
    let child = app
        .state::<WorkspaceRegistry>()
        .get(&child_token)
        .expect("child workspace");
    assert_eq!(child.root, outside_root);
}

#[test]
fn failed_menu_open_releases_the_temporary_workspace_root() {
    let (_dir, root) = canonical_tempdir();
    let outside = tempfile::tempdir().expect("outside");
    let outside_root = std::fs::canonicalize(outside.path()).expect("outside canonical");
    let text = outside_root.join("note.txt");
    std::fs::write(&text, "body").expect("text");

    let app = mock_app();
    let token = attach(&app, "doc-1", root);
    let before = app.state::<WorkspaceRegistry>().len();

    let error = tauri::async_runtime::block_on(open_path_with_document_workspace(
        app.handle().clone(),
        text,
        Some(token),
    ))
    .expect_err("an unsupported file must fail after the temporary root was created");
    assert_eq!(error.code, AppErrorCode::UnsupportedExtension);
    assert_eq!(
        app.state::<WorkspaceRegistry>().len(),
        before,
        "the temporary root token must not leak when opening fails"
    );
}

#[test]
fn open_path_with_root_accepts_a_file_inside_the_root() {
    let (_dir, root) = canonical_tempdir();
    let note = root.join("note.md");
    std::fs::write(&note, "body").expect("note");

    let registry = DocumentRegistry::new();
    let payload = registry
        .open_path_with_root(note, &root)
        .expect("inside file must open");
    assert_eq!(registry.len(), 1);
    assert_eq!(
        Path::new(&payload.path),
        std::fs::canonicalize(&payload.path).expect("canonical payload path")
    );
}

#[test]
fn resolve_delete_keeps_the_link_path_and_rejects_a_symlink_parent() {
    use qingmo_lib::services::workspace_service::{
        resolve_delete, resolve_relative_target, DeleteKind,
    };

    let (_dir, root) = canonical_tempdir();
    let target = root.join("target.md");
    std::fs::write(&target, "body").expect("target");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("target.md", root.join("link.md")).expect("link");
        let resolved =
            resolve_delete(&root, &["link.md".to_string()]).expect("resolve link delete");
        assert_eq!(resolved.kind, DeleteKind::Symlink);
        assert_eq!(resolved.raw_path, root.join("link.md"));
        assert_eq!(
            resolved.canonical_target,
            std::fs::canonicalize(&target).unwrap()
        );

        let file = resolve_delete(&root, &["target.md".to_string()]).expect("resolve file delete");
        assert_eq!(file.kind, DeleteKind::File);

        let outside = tempfile::tempdir().expect("outside");
        let outside_root = std::fs::canonicalize(outside.path()).expect("canonical outside");
        std::fs::write(outside_root.join("secret.md"), "secret").expect("secret");
        std::os::unix::fs::symlink(&outside_root, root.join("linked")).expect("parent link");
        let error = resolve_delete(&root, &["linked".to_string(), "secret.md".to_string()])
            .expect_err("a symlinked parent is outside the visible tree");
        assert_eq!(error.code, AppErrorCode::OutsideScope);
    }

    let error =
        resolve_relative_target(&root, "../escaped.md").expect_err("dotdot must be rejected");
    assert!(matches!(
        error.code,
        AppErrorCode::InvalidPath | AppErrorCode::OutsideScope
    ));
    assert!(resolve_relative_target(&root, "missing/child.md").is_err());
    assert_eq!(
        resolve_relative_target(&root, "later.md").expect("fresh target"),
        root.join("later.md")
    );
}
