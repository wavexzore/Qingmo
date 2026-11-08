//! Application trash: delete/restore, pending recovery and retention.

use std::fs;
use std::path::{Path, PathBuf};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::TrashRestoreMode;
use qingmo_lib::services::trash_store::{workspace_key, TrashStore, TRASH_MAX_ENTRIES};
use qingmo_lib::services::FileLockStore;
use serde_json::{json, Value};
use tempfile::TempDir;

fn canonical(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical")
}

fn write_entry(root: &Path, id: &str, payload: &[u8], entry: Value) -> PathBuf {
    let entry_dir = root
        .join(workspace_key(Path::new(
            entry["root"].as_str().expect("root"),
        )))
        .join(id);
    fs::create_dir_all(&entry_dir).expect("entry dir");
    fs::write(entry_dir.join("payload"), payload).expect("payload");
    fs::write(
        entry_dir.join("entry.json"),
        serde_json::to_vec(&entry).expect("entry json"),
    )
    .expect("entry file");
    entry_dir
}

fn entry_json(id: &str, root: &Path, relative: &str, state: &str, deleted_at_ms: i64) -> Value {
    json!({
        "schemaVersion": 1,
        "id": id,
        "root": root.to_string_lossy(),
        "relativePath": relative,
        "deletedAtMs": deleted_at_ms,
        "sizeBytes": 4,
        "hash": blake3::hash(b"body").to_hex().to_string(),
        "kind": "file",
        "state": state,
    })
}

#[test]
fn delete_restore_copy_and_purge_keep_data_accounted_for() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    let source = root.join("note.md");
    fs::write(&source, "body").expect("fixture");
    let store = TrashStore::open(root.join("trash")).expect("store");

    let entry = store
        .delete(&root, &source, None, |_| false)
        .expect("delete");
    assert!(!source.exists());
    assert_eq!(store.list(&root)[0].relative_path, "note.md");

    fs::write(&source, "replacement").expect("replacement");
    let restored = store
        .restore(&root, &entry.id, TrashRestoreMode::Copy, None, |_| false)
        .expect("copy restore");
    assert_eq!(restored.relative_path, "note (restored).md");
    assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
    assert_eq!(
        fs::read_to_string(root.join("note (restored).md")).unwrap(),
        "body"
    );

    let second = store
        .delete(&root, &source, None, |_| false)
        .expect("second delete");
    store.purge(&root, &second.id).expect("purge");
    assert!(store.list(&root).is_empty());
}

#[test]
fn deleting_an_open_document_is_busy_and_keeps_the_file() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    let source = root.join("note.md");
    fs::write(&source, "body").expect("fixture");
    let store = TrashStore::open(root.join("trash")).expect("store");

    let error = store
        .delete(&root, &source, None, |path| path == source)
        .expect_err("open document");
    assert_eq!(error.code, AppErrorCode::Busy);
    assert!(source.exists());
}

#[test]
fn gc_recovers_a_pending_entry_into_its_original_path() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    let trash_dir = workspace.path().join("trash");
    let store = TrashStore::open(trash_dir.clone()).expect("store");
    let id = uuid::Uuid::new_v4().to_string();
    let entry_dir = write_entry(
        &trash_dir,
        &id,
        b"body",
        entry_json(&id, &root, "recovered.md", "pending", 0),
    );

    let report = store.gc(
        std::slice::from_ref(&root),
        Some(&FileLockStore::disabled()),
    );
    assert_eq!(report.recovered, 1);
    assert!(!entry_dir.exists());
    assert_eq!(
        fs::read_to_string(root.join("recovered.md")).expect("restored"),
        "body"
    );
}

#[test]
fn gc_expires_active_entries_but_keeps_orphaned_payloads() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    let trash_dir = workspace.path().join("trash");
    let store = TrashStore::open(trash_dir.clone()).expect("store");
    let source = root.join("old.md");
    fs::write(&source, "body").expect("fixture");
    let active = store
        .delete(&root, &source, None, |_| false)
        .expect("delete");

    // Age the active entry past TTL by editing its metadata.
    let active_dir = trash_dir.join(workspace_key(&root)).join(&active.id);
    let mut file: Value =
        serde_json::from_slice(&fs::read(active_dir.join("entry.json")).unwrap()).unwrap();
    file["deletedAtMs"] = Value::from(0);
    fs::write(
        active_dir.join("entry.json"),
        serde_json::to_vec(&file).unwrap(),
    )
    .unwrap();

    // An orphaned entry for a root that no longer exists must survive.
    let orphan_root = PathBuf::from("/nonexistent/qingmo-trash-test");
    let orphan_id = uuid::Uuid::new_v4().to_string();
    let orphan_dir = write_entry(
        &trash_dir,
        &orphan_id,
        b"body",
        entry_json(&orphan_id, &orphan_root, "lost.md", "orphaned", 0),
    );

    let report = store.gc(&[], None);
    assert!(report.removed >= 1);
    assert!(!active_dir.exists());
    assert!(orphan_dir.exists());
}

#[test]
fn gc_caps_the_number_of_active_entries() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    let store = TrashStore::open(workspace.path().join("trash")).expect("store");
    let extra = 3;
    for index in 0..(TRASH_MAX_ENTRIES + extra) {
        let path = root.join(format!("note-{index}.md"));
        fs::write(&path, "body").expect("fixture");
        store.delete(&root, &path, None, |_| false).expect("delete");
    }

    let report = store.gc(std::slice::from_ref(&root), None);
    assert_eq!(report.removed, extra);
    assert_eq!(store.list(&root).len(), TRASH_MAX_ENTRIES);
}

#[test]
fn a_trash_entry_cannot_be_restored_into_another_workspace() {
    let first = TempDir::new().expect("first");
    let second = TempDir::new().expect("second");
    let first_root = canonical(&first);
    let second_root = canonical(&second);
    let source = first_root.join("note.md");
    fs::write(&source, "body").expect("fixture");
    let store = TrashStore::open(first.path().join("trash")).expect("store");
    let entry = store
        .delete(&first_root, &source, None, |_| false)
        .expect("delete");

    let error = store
        .restore(
            &second_root,
            &entry.id,
            TrashRestoreMode::Original,
            None,
            |_| false,
        )
        .expect_err("cross-workspace restore");
    assert_eq!(error.code, AppErrorCode::NotFound);
}
