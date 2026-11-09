use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::thread;

use qingmo_lib::services::document_identity::{
    DocumentId, DocumentIdentityStore, EntryState, FileState, IdentityStatus, LiveDocuments,
    ResolveOutcome, TombstoneOutcome,
};
use qingmo_lib::services::file_identity::{file_identity, FileIdentity, FileObservation};

fn open_store(root: &Path) -> DocumentIdentityStore {
    DocumentIdentityStore::open(root.join("identity")).expect("open identity store")
}

fn present(path: &Path) -> FileObservation {
    FileObservation::Present(file_identity(path).expect("identity").expect("supported"))
}

fn identity(path: &Path) -> FileIdentity {
    file_identity(path).expect("identity").expect("supported")
}

fn write(path: &Path, text: &str) {
    fs::write(path, text).expect("write fixture");
}

fn id_of(outcome: ResolveOutcome) -> DocumentId {
    match outcome {
        ResolveOutcome::Existing { id, .. } | ResolveOutcome::Created { id } => id,
        ResolveOutcome::Unmanaged => panic!("unexpected unmanaged outcome"),
    }
}

#[test]
fn creates_a_new_id_and_persists_it_before_returning() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());

    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );

    let bytes = fs::read(dir.path().join("identity/documents.json")).expect("persisted");
    let json: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(json["schemaVersion"], 3);
    assert_eq!(json["entries"][id.to_string()]["fileState"], "present");
    assert_eq!(json["entries"][id.to_string()]["state"], "active");

    let reopened = open_store(dir.path());
    let same = id_of(
        reopened
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("reopen"),
    );
    assert_eq!(id, same);
}

#[test]
fn path_hit_survives_an_atomic_save() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "first");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );

    let replacement = dir.path().join("replacement.md");
    write(&replacement, "second");
    fs::rename(&replacement, &doc).expect("atomic replace");

    let same = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve after save"),
    );
    assert_eq!(id, same);
}

#[test]
fn path_and_file_identity_conflict_is_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let store = open_store(dir.path());
    store
        .resolve_open(&first, present(&first), &LiveDocuments::default())
        .expect("first");
    store
        .resolve_open(&second, present(&second), &LiveDocuments::default())
        .expect("second");

    let second_identity = identity(&second);
    let error = store
        .resolve_open(
            &first,
            FileObservation::Present(second_identity),
            &LiveDocuments::default(),
        )
        .expect_err("path hit with another file's identity must conflict");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::Conflict);
}

#[test]
fn file_hit_adopts_the_id_after_a_rename() {
    let dir = tempfile::tempdir().expect("tempdir");
    let old = dir.path().join("old.md");
    let new = dir.path().join("new.md");
    write(&old, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&old, present(&old), &LiveDocuments::default())
            .expect("resolve"),
    );

    fs::rename(&old, &new).expect("rename");
    let outcome = store
        .resolve_open(&new, present(&new), &LiveDocuments::default())
        .expect("resolve rename");
    assert_eq!(
        outcome,
        ResolveOutcome::Existing {
            id,
            path_changed: true
        }
    );
    assert!(store.legacy_paths(&id).contains(&old));
}

#[test]
fn hard_link_does_not_reuse_the_id_while_the_old_path_exists() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("first.md");
    let second = dir.path().join("second.md");
    write(&first, "hello");
    fs::hard_link(&first, &second).expect("hard link");
    let store = open_store(dir.path());
    let first_id = id_of(
        store
            .resolve_open(&first, present(&first), &LiveDocuments::default())
            .expect("first"),
    );
    let second_id = id_of(
        store
            .resolve_open(&second, present(&second), &LiveDocuments::default())
            .expect("second"),
    );
    assert_ne!(first_id, second_id);
}

#[test]
fn live_id_is_never_rebound() {
    let dir = tempfile::tempdir().expect("tempdir");
    let old = dir.path().join("old.md");
    let new = dir.path().join("new.md");
    write(&old, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&old, present(&old), &LiveDocuments::default())
            .expect("resolve"),
    );

    fs::rename(&old, &new).expect("rename");
    let mut live = LiveDocuments::default();
    live.insert(&old, id);
    let new_id = id_of(
        store
            .resolve_open(&new, present(&new), &live)
            .expect("resolve"),
    );
    assert_ne!(new_id, id);
}

#[test]
fn unavailable_path_still_gets_a_stable_id() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(
                &doc,
                FileObservation::Unavailable,
                &LiveDocuments::default(),
            )
            .expect("resolve"),
    );
    let same = id_of(
        store
            .resolve_open(
                &doc,
                FileObservation::Unavailable,
                &LiveDocuments::default(),
            )
            .expect("resolve again"),
    );
    assert_eq!(id, same);
    let record = store.resolve_path(&id).expect("record");
    assert_eq!(record.file_state, FileState::Unavailable);
    assert!(record.file.is_none());
}

#[test]
fn absent_path_is_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("missing.md");
    let store = open_store(dir.path());
    let error = store
        .resolve_open(&doc, FileObservation::Absent, &LiveDocuments::default())
        .expect_err("absent");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::NotFound);
}

#[test]
fn batch_resolution_persists_once_and_returns_ids() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let store = open_store(dir.path());
    let ids = store
        .resolve_open_batch(
            &[
                (first.clone(), present(&first)),
                (second.clone(), present(&second)),
            ],
            &LiveDocuments::default(),
        )
        .expect("batch");
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);

    let bytes = fs::read(dir.path().join("identity/documents.json")).expect("persisted");
    let json: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(json["entries"].as_object().expect("entries").len(), 2);
}

#[test]
fn resolve_open_new_rebinds_a_non_live_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    let old_id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );

    let new_id = store
        .resolve_open_new(&doc, present(&doc), &LiveDocuments::default())
        .expect("new id");
    assert_ne!(old_id, new_id);
    assert_eq!(
        store.resolve_path(&old_id).expect("old").entry_state,
        EntryState::Tombstone
    );
}

#[test]
fn resolve_open_new_refuses_a_live_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );
    let mut live = LiveDocuments::default();
    live.insert(&doc, id);
    let error = store
        .resolve_open_new(&doc, present(&doc), &live)
        .expect_err("live must conflict");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::Conflict);
}

#[test]
fn adopt_many_keeps_ids_and_writes_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let store = open_store(dir.path());
    let first_id = id_of(
        store
            .resolve_open(&first, present(&first), &LiveDocuments::default())
            .expect("first"),
    );
    let second_id = id_of(
        store
            .resolve_open(&second, present(&second), &LiveDocuments::default())
            .expect("second"),
    );

    let first_new = dir.path().join("a2.md");
    let second_new = dir.path().join("b2.md");
    fs::rename(&first, &first_new).expect("rename first");
    fs::rename(&second, &second_new).expect("rename second");
    store
        .adopt_many(&[
            (first_id, first_new.clone(), present(&first_new)),
            (second_id, second_new.clone(), present(&second_new)),
        ])
        .expect("adopt many");
    assert_eq!(
        store.resolve_path(&first_id).expect("first").path,
        first_new
    );
    assert_eq!(
        store.resolve_path(&second_id).expect("second").path,
        second_new
    );
}

#[test]
fn bind_save_keeps_the_id_and_updates_the_file_hint() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "first");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );

    let replacement = dir.path().join("replacement.md");
    write(&replacement, "second");
    fs::rename(&replacement, &doc).expect("replace");
    store
        .bind_save(&id, &doc, present(&doc))
        .expect("bind save");
    store.flush().expect("flush");
    assert_eq!(store.resolve_path(&id).expect("record").path, doc);
}

#[test]
fn tombstone_refuses_live_ids() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );
    let mut live = LiveDocuments::default();
    live.insert(&doc, id);
    assert_eq!(
        store.tombstone(&id, &live).expect("tombstone"),
        TombstoneOutcome::RefusedLive
    );
    assert_eq!(
        store
            .tombstone(&id, &LiveDocuments::default())
            .expect("tombstone"),
        TombstoneOutcome::Tombstoned
    );
}

#[test]
fn missing_and_recovered_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );
    fd_remove(&doc);
    store.mark_missing(&id).expect("mark missing");
    assert_eq!(
        store.resolve_path(&id).expect("record").entry_state,
        EntryState::Missing
    );
    assert!(store.resolve_path(&id).expect("record").file.is_some());

    write(&doc, "recovered");
    store.mark_recovered(&id, &doc).expect("mark recovered");
    assert_eq!(
        store.resolve_path(&id).expect("record").entry_state,
        EntryState::Active
    );
}

fn fd_remove(path: &Path) {
    fs::remove_file(path).expect("remove");
}

#[test]
fn gc_removes_expired_and_retains_live_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let store = open_store(dir.path());
    let first_id = id_of(
        store
            .resolve_open(&first, present(&first), &LiveDocuments::default())
            .expect("first"),
    );
    let second_id = id_of(
        store
            .resolve_open(&second, present(&second), &LiveDocuments::default())
            .expect("second"),
    );
    let mut live = LiveDocuments::default();
    live.insert(&first, first_id);
    let report = store.gc(i64::MAX / 2, &live);
    assert!(report.removed >= 1);
    assert!(store.resolve_path(&first_id).is_some());
    assert!(store.resolve_path(&second_id).is_none());
}

#[test]
fn corrupt_store_degrades_and_rebuilds_from_history() {
    let dir = tempfile::tempdir().expect("tempdir");
    let identity_root = dir.path().join("identity");
    let history_root = dir.path().join("history");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let id = DocumentId::new();
    let bucket = history_root.join(id.to_string());
    fs::create_dir_all(&bucket).expect("bucket");
    fs::write(
        bucket.join("entries.json"),
        serde_json::json!({
            "schemaVersion": 1,
            "path": doc.to_string_lossy(),
            "entries": []
        })
        .to_string(),
    )
    .expect("history fixture");
    fs::create_dir_all(&identity_root).expect("identity root");
    fs::write(identity_root.join("documents.json"), b"{not json").expect("corrupt");

    let store =
        DocumentIdentityStore::open_with_recovery(identity_root.clone(), Some(history_root), None)
            .expect("degraded store");
    assert_eq!(store.status(), IdentityStatus::DegradedReadOnly);
    assert_eq!(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("read existing"),
        ResolveOutcome::Existing {
            id,
            path_changed: false
        }
    );
    let error = store
        .resolve_open_batch(&[(doc.clone(), present(&doc))], &LiveDocuments::default())
        .expect_err("degraded write");
    assert_eq!(
        error.code,
        qingmo_lib::error::AppErrorCode::IdentityDegraded
    );
    assert!(identity_root
        .read_dir()
        .expect("read dir")
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-")));
}

#[test]
fn corrupt_store_without_recovery_fails_to_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    let identity_root = dir.path().join("identity");
    fs::create_dir_all(&identity_root).expect("identity root");
    fs::write(identity_root.join("documents.json"), b"{not json").expect("corrupt");
    let error = DocumentIdentityStore::open(identity_root).expect_err("must fail");
    assert_eq!(
        error.code,
        qingmo_lib::error::AppErrorCode::IdentityDegraded
    );
}

#[test]
fn legacy_paths_are_bounded_and_mru() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    let id = id_of(
        store
            .resolve_open(&doc, present(&doc), &LiveDocuments::default())
            .expect("resolve"),
    );
    let mut current = doc.clone();
    for index in 0..12 {
        let next = dir.path().join(format!("a{index}.md"));
        fs::rename(&current, &next).expect("rename");
        store.adopt(&id, &next, present(&next)).expect("adopt");
        current = next;
    }
    let legacy = store.legacy_paths(&id);
    assert_eq!(legacy.len(), 8);
    assert!(legacy.contains(&dir.path().join("a10.md")));
}

#[test]
fn concurrent_resolve_returns_one_id() {
    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = Arc::new(open_store(dir.path()));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let store = Arc::clone(&store);
        let doc = doc.clone();
        handles.push(thread::spawn(move || {
            id_of(
                store
                    .resolve_open(&doc, present(&doc), &LiveDocuments::default())
                    .expect("resolve"),
            )
        }));
    }
    let ids: Vec<DocumentId> = handles
        .into_iter()
        .map(|handle| handle.join().expect("join"))
        .collect();
    assert!(ids.iter().all(|id| *id == ids[0]));
}

#[cfg(unix)]
#[test]
fn identity_file_and_directory_are_private() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("tempdir");
    let doc = dir.path().join("a.md");
    write(&doc, "hello");
    let store = open_store(dir.path());
    store
        .resolve_open(&doc, present(&doc), &LiveDocuments::default())
        .expect("resolve");
    let root_mode = fs::metadata(dir.path().join("identity"))
        .expect("root metadata")
        .permissions()
        .mode()
        & 0o777;
    let file_mode = fs::metadata(dir.path().join("identity/documents.json"))
        .expect("file metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(root_mode, 0o700);
    assert_eq!(file_mode, 0o600);
}

fn registry_with_identity(
    root: &Path,
) -> (qingmo_lib::state::DocumentRegistry, DocumentIdentityStore) {
    let store = open_store(root);
    let registry = qingmo_lib::state::DocumentRegistry::new();
    registry.configure_services(None, None, Some(store.clone()));
    (registry, store)
}

#[test]
fn registry_keeps_the_document_id_across_save_and_rename() {
    let dir = tempfile::tempdir().expect("tempdir");
    let original = dir.path().join("a.md");
    write(&original, "body");
    let (registry, _store) = registry_with_identity(dir.path());

    let payload = registry.open_path(original.clone()).expect("open");
    let record = registry.get(&payload.doc_token).expect("record");
    let id = record.document_id().expect("document id");
    registry
        .write_atomic(&payload.doc_token, "body\n", None)
        .expect("save");
    assert_eq!(
        registry
            .get(&payload.doc_token)
            .expect("record")
            .document_id(),
        Some(id)
    );

    let renamed = dir.path().join("b.md");
    assert!(
        registry.is_path_open(&original),
        "original must be open before rename"
    );
    fs::rename(&original, &renamed).expect("rename");
    let outcome = registry
        .rekey_path(&original, &renamed, dir.path())
        .expect("rekey");
    assert_eq!(outcome.relocated.len(), 1);
    let record = registry.get(&payload.doc_token).expect("record");
    assert_eq!(record.document_id(), Some(id));
    let paths = record.paths().expect("paths");
    assert_eq!(
        paths.canonical_target,
        fs::canonicalize(&renamed).expect("canonical renamed")
    );
    registry
        .write_atomic(&payload.doc_token, "renamed\n", None)
        .expect("save after rename");
}

#[test]
fn directory_rename_rekeys_open_documents_by_prefix() {
    let dir = tempfile::tempdir().expect("tempdir");
    let docs = dir.path().join("docs");
    fs::create_dir(&docs).expect("docs");
    let original = docs.join("a.md");
    write(&original, "body");
    let (registry, _store) = registry_with_identity(dir.path());
    let payload = registry.open_path(original.clone()).expect("open");
    let id = registry
        .get(&payload.doc_token)
        .expect("record")
        .document_id();
    assert!(id.is_some());

    let renamed_dir = dir.path().join("docs2");
    fs::rename(&docs, &renamed_dir).expect("rename dir");
    let outcome = registry
        .rekey_prefix(&docs, &renamed_dir, dir.path())
        .expect("rekey prefix");
    assert_eq!(outcome.relocated.len(), 1);
    let record = registry.get(&payload.doc_token).expect("record");
    assert_eq!(
        record.paths().expect("paths").canonical_target,
        fs::canonicalize(renamed_dir.join("a.md")).expect("canonical dir file")
    );
    registry
        .write_atomic(&payload.doc_token, "after dir rename\n", None)
        .expect("save after directory rename");
}

#[test]
fn rekey_refuses_a_target_owned_by_another_open_document() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let (registry, _store) = registry_with_identity(dir.path());
    let first_payload = registry.open_path(first.clone()).expect("first");
    let second_payload = registry.open_path(second.clone()).expect("second");

    let error = registry
        .rekey_path(&first, &second, dir.path())
        .expect_err("target owns another token");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::Conflict);
    assert_eq!(
        registry
            .get(&first_payload.doc_token)
            .expect("first record")
            .paths()
            .expect("paths")
            .canonical_target,
        fs::canonicalize(&first).expect("canonical first")
    );
    assert!(registry.get(&second_payload.doc_token).is_ok());
}

#[cfg(windows)]
#[test]
fn path_key_folds_case_and_strips_verbatim_prefixes() {
    use qingmo_lib::services::document_identity::PathKey;
    use std::path::Path;

    let verbatim = PathKey::from_path(Path::new(r"\\?\C:\Docs\Note.MD"));
    let plain = PathKey::from_path(Path::new(r"c:/docs/note.md"));
    let dotted = PathKey::from_path(Path::new(r"\\.\C:\Docs\Note.MD"));
    assert_eq!(verbatim, plain);
    assert_eq!(dotted, plain);
}
