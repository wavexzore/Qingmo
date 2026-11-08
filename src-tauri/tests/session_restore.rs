//! `windows.json` validation and the Restore/Main launch ownership CAS.

use std::fs;

use qingmo_lib::ipc::dto::{WindowBounds, WindowIntent};
use qingmo_lib::services::session_store::{
    SessionStore, WINDOWS_FILE, WINDOWS_FILE_MAX_BYTES, WINDOWS_MAX,
};
use qingmo_lib::state::StartupWindow;
use tempfile::TempDir;

fn bounds() -> WindowBounds {
    WindowBounds {
        x: 10.0,
        y: 20.0,
        width: 1200.0,
        height: 800.0,
        maximized: false,
        scale_factor: 2.0,
    }
}

fn intent(root: &std::path::Path, index: usize) -> WindowIntent {
    WindowIntent {
        bounds: bounds(),
        workspace_root: Some(root.to_string_lossy().to_string()),
        document_path: Some(
            root.join(format!("doc-{index}.md"))
                .to_string_lossy()
                .to_string(),
        ),
        untitled: false,
    }
}

#[test]
fn windows_round_trip_and_are_capped_at_twenty() {
    let dir = TempDir::new().expect("temp dir");
    let store = SessionStore::open(dir.path().join("session")).expect("store");
    let root = dir.path().to_path_buf();
    let windows = (0..(WINDOWS_MAX + 5))
        .map(|index| intent(&root, index))
        .collect::<Vec<_>>();
    store.windows_set(&windows).expect("write windows");

    let read = store.windows_get();
    assert_eq!(read.len(), WINDOWS_MAX);
    assert_eq!(read[0].document_path, windows[0].document_path);
}

#[test]
fn invalid_intents_are_filtered_before_writing() {
    let dir = TempDir::new().expect("temp dir");
    let store = SessionStore::open(dir.path().join("session")).expect("store");
    let root = dir.path().to_path_buf();
    let mut invalid = intent(&root, 0);
    invalid.document_path = Some("relative.md".to_string());
    let mut outside = intent(&root, 1);
    outside.document_path = Some("/elsewhere/note.md".to_string());
    let mut untitled = intent(&root, 2);
    untitled.untitled = true;
    untitled.document_path = Some(root.join("wrong.md").to_string_lossy().to_string());
    let mut zero_width = intent(&root, 3);
    zero_width.bounds.width = 0.0;

    store
        .windows_set(&[invalid, outside, untitled, zero_width, intent(&root, 4)])
        .expect("write windows");
    let read = store.windows_get();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].document_path, intent(&root, 4).document_path);
}

#[test]
fn an_oversized_windows_file_is_backed_up_and_treated_as_empty() {
    let dir = TempDir::new().expect("temp dir");
    let store = SessionStore::open(dir.path().join("session")).expect("store");
    let path = dir.path().join("session").join(WINDOWS_FILE);
    let mut json = serde_json::to_string(&serde_json::json!({
        "schemaVersion": 1,
        "savedAtMs": 0,
        "windows": []
    }))
    .expect("json");
    json.push_str(&" ".repeat(WINDOWS_FILE_MAX_BYTES as usize + 1));
    fs::write(&path, json).expect("oversized fixture");

    assert!(store.windows_get().is_empty());
    let backups = fs::read_dir(dir.path().join("session"))
        .expect("read session")
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("windows.corrupt-")
        })
        .count();
    assert_eq!(backups, 1);
}

#[test]
fn a_corrupt_windows_file_is_backed_up_and_treated_as_empty() {
    let dir = TempDir::new().expect("temp dir");
    let store = SessionStore::open(dir.path().join("session")).expect("store");
    fs::write(dir.path().join("session").join(WINDOWS_FILE), b"{ not json")
        .expect("corrupt fixture");
    assert!(store.windows_get().is_empty());
    assert!(fs::read_dir(dir.path().join("session"))
        .expect("read session")
        .flatten()
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("windows.corrupt-")));
}

#[test]
fn restore_claim_blocks_the_boot_timer_and_failure_moves_to_main() {
    let startup = StartupWindow::new();
    assert!(startup.claim_restore_if_undecided());
    assert!(startup.is_restoring());
    assert!(!startup.claim_main_if_undecided());
    assert!(!startup.claim_document_if_undecided());

    assert!(startup.mark_restore_failed());
    assert!(!startup.is_restoring());
    assert!(!startup.claim_main_if_undecided());
    assert!(!startup.mark_restore_failed());
}

#[test]
fn an_os_open_wins_the_restore_claim() {
    let startup = StartupWindow::new();
    startup.mark_opened();
    assert!(!startup.claim_restore_if_undecided());
    assert!(startup.was_opened());
    assert!(!startup.mark_restore_failed());
}
