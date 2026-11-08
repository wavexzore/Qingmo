//! HistoryStore retention, merge and crash-staging cleanup.

use std::fs;
use std::path::{Path, PathBuf};

use qingmo_lib::services::history_store::{HistoryStore, HISTORY_MAX_ENTRIES_PER_DOC};
use serde_json::Value;
use tempfile::TempDir;

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn doc_dir(store_root: &Path, document: &Path) -> PathBuf {
    let key = blake3::hash(document.to_string_lossy().as_bytes())
        .to_hex()
        .to_string();
    store_root.join(&key[..32])
}

#[test]
fn keeps_at_most_fifty_entries_per_document() {
    let dir = TempDir::new().expect("temp dir");
    let root = dir.path().join("history");
    let store = HistoryStore::open(root.clone()).expect("store");
    let document = dir.path().join("note.md");

    for index in 0..(HISTORY_MAX_ENTRIES_PER_DOC + 5) {
        let bytes = format!("version {index}\n");
        store
            .capture(&document, bytes.as_bytes(), &hash(bytes.as_bytes()), true)
            .expect("capture");
    }

    let entries = store.list(&document, 100, 0);
    assert_eq!(entries.len(), HISTORY_MAX_ENTRIES_PER_DOC);
    // Newest first: the last written version survives, the oldest was pruned.
    assert_eq!(
        entries[0].hash,
        hash(format!("version {}\n", HISTORY_MAX_ENTRIES_PER_DOC + 4).as_bytes())
    );
}

#[test]
fn gc_removes_expired_entries_staging_files_and_orphan_payloads() {
    let dir = TempDir::new().expect("temp dir");
    let root = dir.path().join("history");
    let store = HistoryStore::open(root.clone()).expect("store");
    let document = dir.path().join("note.md");
    let bytes = b"old\n";
    let entry = store
        .capture(&document, bytes, &hash(bytes), true)
        .expect("capture")
        .expect("entry");

    let doc = doc_dir(&root, &document);
    fs::write(doc.join(".staging-crash.bin"), b"partial").expect("staging fixture");
    fs::write(doc.join("orphan.bin"), b"orphan").expect("orphan fixture");

    let path = doc.join("entries.json");
    let mut file: Value =
        serde_json::from_slice(&fs::read(&path).expect("read entries")).expect("json");
    file["entries"][0]["createdAtMs"] = Value::from(0);
    fs::write(&path, serde_json::to_vec(&file).expect("encode")).expect("write entries");

    let report = store.gc();
    assert!(report.entries_removed >= 1);
    assert_eq!(report.staging_removed, 1);
    assert!(!doc.join(format!("{}.bin", entry.id)).exists());
    assert!(!doc.join("orphan.bin").exists());
    assert!(store.list(&document, 50, 0).is_empty());
}

#[test]
fn corrupt_entries_file_is_backed_up_and_treated_as_empty() {
    let dir = TempDir::new().expect("temp dir");
    let root = dir.path().join("history");
    let store = HistoryStore::open(root.clone()).expect("store");
    let document = dir.path().join("note.md");
    let doc = doc_dir(&root, &document);
    fs::create_dir_all(&doc).expect("doc dir");
    fs::write(doc.join("entries.json"), b"{ not json").expect("corrupt fixture");

    assert!(store.list(&document, 50, 0).is_empty());
    let backups = fs::read_dir(&doc)
        .expect("read dir")
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("entries.corrupt-")
        })
        .count();
    assert_eq!(backups, 1);
}

#[test]
fn read_rejects_traversal_ids() {
    let dir = TempDir::new().expect("temp dir");
    let store = HistoryStore::open(dir.path().join("history")).expect("store");
    let document = dir.path().join("note.md");
    assert!(store.read(&document, "../../etc/passwd").is_err());
    assert!(store.read_raw(&document, "not-an-id").is_err());
}
