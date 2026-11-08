//! Unified startup storage GC across session/history/trash/index.

use std::fs;
use std::path::Path;

use qingmo_lib::services::history_store::HistoryStore;
use qingmo_lib::services::search_index::SearchIndexService;
use qingmo_lib::services::session_store::SessionStore;
use qingmo_lib::services::storage_gc;
use qingmo_lib::services::trash_store::{workspace_key, TrashStore};
use qingmo_lib::services::FileLockStore;
use serde_json::Value;
use tempfile::TempDir;

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[test]
fn one_startup_pass_cleans_every_store_independently() {
    let dir = TempDir::new().expect("temp dir");
    let workspace = dir.path().join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    fs::write(workspace.join("a.md"), "# A\n\nalpha\n").expect("fixture");

    // Session: one unreadable draft is removed.
    let session = SessionStore::open(dir.path().join("session")).expect("session");
    fs::create_dir_all(dir.path().join("session").join("drafts")).expect("drafts");
    fs::write(
        dir.path()
            .join("session")
            .join("drafts")
            .join("broken.json"),
        b"{ not json",
    )
    .expect("corrupt draft");

    // History: an entry older than TTL plus a crash staging file.
    let history = HistoryStore::open(dir.path().join("history")).expect("history");
    let document = workspace.join("a.md");
    let bytes = b"old\n";
    let entry = history
        .capture(&document, bytes, &hash(bytes), true)
        .expect("capture")
        .expect("entry");
    let key = blake3::hash(document.to_string_lossy().as_bytes())
        .to_hex()
        .to_string();
    let history_dir = dir.path().join("history").join(&key[..32]);
    let entries_path = history_dir.join("entries.json");
    let mut entries: Value =
        serde_json::from_slice(&fs::read(&entries_path).expect("entries")).expect("json");
    entries["entries"][0]["createdAtMs"] = Value::from(0);
    fs::write(&entries_path, serde_json::to_vec(&entries).unwrap()).expect("aged history");
    fs::write(history_dir.join(".staging-crash.bin"), b"partial").expect("staging");

    // Trash: one active entry aged past TTL.
    let trash = TrashStore::open(dir.path().join("trash")).expect("trash");
    let source = workspace.join("gone.md");
    fs::write(&source, "body").expect("fixture");
    let trash_entry = trash
        .delete(&workspace, &source, None, |_| false)
        .expect("delete");
    let entry_path = dir
        .path()
        .join("trash")
        .join(workspace_key(&workspace))
        .join(&trash_entry.id)
        .join("entry.json");
    let mut trash_json: Value = serde_json::from_slice(&fs::read(&entry_path).unwrap()).unwrap();
    trash_json["deletedAtMs"] = Value::from(0);
    fs::write(&entry_path, serde_json::to_vec(&trash_json).unwrap()).unwrap();

    // Index: one workspace row aged past the 90-day index TTL.
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&workspace).expect("scan");
    let connection =
        rusqlite::Connection::open(dir.path().join("index").join("index.sqlite")).expect("sqlite");
    connection
        .execute("UPDATE workspaces SET last_seen_ms = 0", [])
        .expect("age workspace");
    drop(connection);

    let locks = FileLockStore::open(dir.path().join("locks")).expect("locks");
    let report = storage_gc::run(&session, &history, &trash, &index, &[], Some(&locks));

    assert!(report.session_corrupt_removed >= 1);
    assert!(report.history_entries_removed >= 1);
    assert!(report.history_staging_removed >= 1);
    assert!(report.trash_removed >= 1);
    assert_eq!(report.index_workspaces_removed, 1);
    assert!(!entry_dir_exists(&history_dir, &entry.id));
    assert!(report.errors.is_empty(), "errors: {:?}", report.errors);
}

fn entry_dir_exists(history_dir: &Path, id: &str) -> bool {
    history_dir.join(format!("{id}.bin")).exists()
}

#[test]
fn disabled_stores_report_zero_instead_of_failing() {
    let session = SessionStore::disabled();
    let history = HistoryStore::disabled();
    let trash = TrashStore::disabled();
    let index = SearchIndexService::disabled();
    let report = storage_gc::run(&session, &history, &trash, &index, &[], None);
    assert_eq!(report.drafts_removed, 0);
    assert_eq!(report.history_entries_removed, 0);
    assert_eq!(report.trash_removed, 0);
    assert_eq!(report.index_workspaces_removed, 0);
    assert!(report.errors.is_empty());
}
