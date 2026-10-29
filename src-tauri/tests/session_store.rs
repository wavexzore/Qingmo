use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::{
    DraftKind, DraftRecord, DraftWriteRequest, EditorViewStateInput, DRAFT_SCHEMA_VERSION,
    VIEW_STATE_SCHEMA_VERSION,
};
use qingmo_lib::services::session_store::{
    SessionStore, DRAFT_TTL_MS, MAX_DRAFT_BYTES, MAX_VIEW_ENTRIES, VIEW_STATE_FILE,
};
use serde_json::json;
use tempfile::TempDir;

fn store() -> (TempDir, SessionStore) {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = SessionStore::open(dir.path().join("session")).expect("store must open");
    (dir, store)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn untitled(text: &str) -> DraftWriteRequest {
    DraftWriteRequest {
        id: None,
        kind: "untitled".to_string(),
        path: None,
        title: "未命名".to_string(),
        text: text.to_string(),
        anchor: 0,
        head: text.encode_utf16().count() as i64,
    }
}

fn record(id: &str, text: &str, updated_at_ms: i64) -> DraftRecord {
    DraftRecord {
        schema_version: DRAFT_SCHEMA_VERSION,
        id: id.to_string(),
        kind: DraftKind::Untitled,
        path: None,
        title: "seed".to_string(),
        text: text.to_string(),
        text_units: text.encode_utf16().count() as u64,
        size_bytes: text.len() as u64,
        anchor: 0,
        head: text.encode_utf16().count() as u32,
        created_at_ms: updated_at_ms,
        updated_at_ms,
        app_version: "test".to_string(),
    }
}

fn seed_draft(root: &Path, record: &DraftRecord) {
    let bytes = serde_json::to_vec(record).expect("seed record");
    fs::write(
        root.join("drafts").join(format!("{}.json", record.id)),
        bytes,
    )
    .expect("seed draft");
}

#[test]
fn view_state_round_trips_and_clamps() {
    let (dir, store) = store();
    store
        .view_set(
            "/docs/a.md",
            EditorViewStateInput {
                anchor: -4,
                head: 12,
                top_pos: i64::from(u32::MAX) + 100,
                top_offset: 2_000_000.0,
                scroll_left: -1.0,
                live_preview_preferred: false,
            },
        )
        .expect("view write");

    let state = store.view_get("/docs/a.md").expect("view state");
    assert_eq!(state.anchor, 0);
    assert_eq!(state.head, 12);
    assert_eq!(state.top_pos, u32::MAX);
    assert_eq!(state.top_offset, 1_000_000.0);
    assert_eq!(state.scroll_left, 0.0);
    assert!(!state.live_preview_preferred);
    assert!(state.updated_at_ms > 0);

    // Reopening the same directory must see the atomically written file.
    let reopened = SessionStore::open(dir.path().join("session")).expect("reopen");
    assert_eq!(reopened.view_get("/docs/a.md"), Some(state));

    // Windows/UNC/Unicode keys are opaque strings, never file paths.
    let windows_key = r"\\?\C:\Users\me\笔记\a.md";
    reopened
        .view_set(
            windows_key,
            EditorViewStateInput {
                anchor: 1,
                head: 1,
                top_pos: 1,
                top_offset: f64::NAN,
                scroll_left: f64::INFINITY,
                live_preview_preferred: true,
            },
        )
        .expect("verbatim key");
    let state = reopened.view_get(windows_key).expect("verbatim view");
    assert_eq!(state.top_offset, 0.0);
    assert_eq!(state.scroll_left, 0.0);
}

#[test]
fn view_state_rejects_invalid_keys() {
    let (_dir, store) = store();
    let input = EditorViewStateInput {
        anchor: 0,
        head: 0,
        top_pos: 0,
        top_offset: 0.0,
        scroll_left: 0.0,
        live_preview_preferred: true,
    };

    for invalid in ["", "a\u{0}b", "\n", "x".repeat(4097).as_str()] {
        let error = store
            .view_set(invalid, input.clone())
            .expect_err("invalid key must fail");
        assert_eq!(error.code, AppErrorCode::InvalidPath, "key {invalid:?}");
        assert_eq!(store.view_get(invalid), None);
    }
}

#[test]
fn view_state_is_capped_at_two_hundred_entries() {
    let (_dir, store) = store();
    let input = EditorViewStateInput {
        anchor: 0,
        head: 0,
        top_pos: 0,
        top_offset: 0.0,
        scroll_left: 0.0,
        live_preview_preferred: true,
    };
    for index in 0..(MAX_VIEW_ENTRIES + 25) {
        store
            .view_set(&format!("/docs/{index}.md"), input.clone())
            .expect("view write");
    }

    let raw =
        fs::read_to_string(_dir.path().join("session").join(VIEW_STATE_FILE)).expect("view file");
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("view json");
    assert_eq!(
        parsed["entries"].as_object().map(serde_json::Map::len),
        Some(MAX_VIEW_ENTRIES)
    );
}

#[test]
fn startup_gc_drops_the_oldest_view_entries() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("session");
    fs::create_dir_all(root.join("drafts")).expect("session dirs");
    let now = now_ms();
    let mut entries = serde_json::Map::new();
    for index in 0..(MAX_VIEW_ENTRIES + 50) {
        entries.insert(
            format!("/docs/{index}.md"),
            json!({
                "anchor": 0,
                "head": 0,
                "topPos": 0,
                "topOffset": 0.0,
                "scrollLeft": 0.0,
                "livePreviewPreferred": true,
                "updatedAtMs": now - index as i64
            }),
        );
    }
    fs::write(
        root.join(VIEW_STATE_FILE),
        serde_json::to_vec(&json!({
            "schemaVersion": VIEW_STATE_SCHEMA_VERSION,
            "entries": entries,
        }))
        .expect("view json"),
    )
    .expect("seed view");

    let store = SessionStore::open(root).expect("store");
    let report = store.gc();
    assert_eq!(report.view_entries_removed, 50);
    assert!(store.view_get("/docs/0.md").is_some(), "newest kept");
    assert!(store.view_get("/docs/249.md").is_none(), "oldest dropped");
}

#[test]
fn draft_round_trip_and_update_preserves_identity() {
    let (_dir, store) = store();
    let meta = store.draft_write(untitled("a😀b")).expect("draft write");
    assert_eq!(meta.kind, DraftKind::Untitled);
    assert_eq!(meta.path, None);
    assert_eq!(meta.text_units, 4);
    assert_eq!(meta.size_bytes, 6);
    assert!(meta.created_at_ms <= meta.updated_at_ms);

    let record = store.draft_read(&meta.id).expect("draft read");
    assert_eq!(record.text, "a😀b");
    assert_eq!(record.schema_version, DRAFT_SCHEMA_VERSION);

    let listed = store.draft_list().expect("draft list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, meta.id);

    let updated = store
        .draft_write(DraftWriteRequest {
            id: Some(meta.id.clone()),
            kind: "named".to_string(),
            path: Some("/docs/a.md".to_string()),
            title: "renamed".to_string(),
            text: "next".to_string(),
            anchor: -1,
            head: 4,
        })
        .expect("draft update");
    assert_eq!(updated.id, meta.id);
    // Identity fields are preserved; only mutable fields change.
    assert_eq!(updated.kind, DraftKind::Untitled);
    assert_eq!(updated.path, None);
    assert_eq!(updated.created_at_ms, meta.created_at_ms);
    assert_eq!(updated.title, "renamed");
    assert_eq!(updated.anchor, 0);
    assert_eq!(updated.head, 4);

    assert!(store.draft_discard(&meta.id).expect("discard"));
    assert!(!store.draft_discard(&meta.id).expect("discard again"));
    assert_eq!(
        store.draft_read(&meta.id).expect_err("gone").code,
        AppErrorCode::NotFound
    );
}

#[test]
fn draft_write_rejects_oversized_text() {
    let (_dir, store) = store();
    let error = store
        .draft_write(untitled(&"x".repeat(MAX_DRAFT_BYTES + 1)))
        .expect_err("oversized draft");
    assert_eq!(error.code, AppErrorCode::FileTooLarge);
    assert!(store.draft_list().expect("list").is_empty());
}

#[test]
fn draft_ids_must_be_uuids() {
    let store = store_for_ids();
    for invalid in ["../escape", "not-a-uuid", "", "0f4f0f9e-6a0f-4d3e-9d1a"] {
        assert_eq!(
            store.draft_read(invalid).expect_err("read").code,
            AppErrorCode::InvalidPath,
            "id {invalid:?}"
        );
        assert_eq!(
            store.draft_discard(invalid).expect_err("discard").code,
            AppErrorCode::InvalidPath
        );
    }

    let mut request = untitled("x");
    request.id = Some("../escape".to_string());
    assert_eq!(
        store.draft_write(request).expect_err("write").code,
        AppErrorCode::InvalidPath
    );
}

fn store_for_ids() -> SessionStore {
    let dir = tempfile::tempdir().expect("temp dir");
    // The TempDir is dropped at the end of this helper, but the store keeps
    // only paths; the directory is recreated on demand by each write attempt
    // that needs it. Reads/discards fail before touching the missing dir.
    SessionStore::open(dir.path().join("session")).expect("store")
}

#[test]
fn draft_update_recreates_a_missing_id() {
    let (dir, store) = store();
    let meta = store.draft_write(untitled("first")).expect("write");
    fs::remove_file(
        dir.path()
            .join("session")
            .join("drafts")
            .join(format!("{}.json", meta.id)),
    )
    .expect("simulate gc");

    let recreated = store
        .draft_write(DraftWriteRequest {
            id: Some(meta.id.clone()),
            ..untitled("second")
        })
        .expect("recreate");
    assert_eq!(recreated.id, meta.id);
    assert!(recreated.created_at_ms >= meta.created_at_ms);
    assert_eq!(store.draft_read(&meta.id).expect("read").text, "second");
}

#[test]
fn gc_removes_expired_and_excess_drafts() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("session");
    let store = SessionStore::open(root.clone()).expect("store");
    let now = now_ms();

    let expired_id = "00000000-0000-4000-8000-000000000001";
    seed_draft(
        &root,
        &record(expired_id, "old", now - DRAFT_TTL_MS - 1_000),
    );
    for index in 0..21 {
        let id = format!("00000000-0000-4000-8000-{:012}", index + 2);
        seed_draft(&root, &record(&id, "body", now - index));
    }

    let report = store.gc();
    assert!(report.drafts_removed >= 2, "expired + over-count removed");
    assert_eq!(
        store.draft_read(expired_id).expect_err("expired").code,
        AppErrorCode::NotFound
    );
    assert!(store.draft_list().expect("list").len() <= 20);
}

#[test]
fn corrupt_view_file_is_backed_up_and_reset() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("session");
    fs::create_dir_all(root.join("drafts")).expect("session dirs");
    fs::write(root.join(VIEW_STATE_FILE), b"{ not json").expect("corrupt view");

    let store = SessionStore::open(root.clone()).expect("store");
    assert!(store.view_get("/docs/a.md").is_none());
    let backups: Vec<_> = fs::read_dir(&root)
        .expect("root")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".corrupt-"))
        .collect();
    assert_eq!(backups.len(), 1, "corrupt file must be preserved once");
}

#[test]
fn corrupt_draft_is_dropped_without_failing_the_list() {
    let (dir, store) = store();
    let drafts = dir.path().join("session").join("drafts");
    fs::write(
        drafts.join("00000000-0000-4000-8000-000000000009.json"),
        b"{ broken",
    )
    .expect("corrupt draft");

    assert!(store.draft_list().expect("list").is_empty());
    assert!(!drafts
        .join("00000000-0000-4000-8000-000000000009.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn unix_permissions_are_private() {
    use std::os::unix::fs::PermissionsExt;

    let (dir, store) = store();
    let root = dir.path().join("session");
    let mode = |path: &Path| fs::metadata(path).expect("metadata").permissions().mode() & 0o777;

    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join("drafts")), 0o700);

    let meta = store.draft_write(untitled("secret")).expect("write");
    assert_eq!(
        mode(&root.join("drafts").join(format!("{}.json", meta.id))),
        0o600
    );
    store
        .view_set(
            "/docs/a.md",
            EditorViewStateInput {
                anchor: 0,
                head: 0,
                top_pos: 0,
                top_offset: 0.0,
                scroll_left: 0.0,
                live_preview_preferred: true,
            },
        )
        .expect("view");
    assert_eq!(mode(&root.join(VIEW_STATE_FILE)), 0o600);
}

#[test]
fn concurrent_writes_and_discards_do_not_deadlock() {
    let (_dir, store) = store();
    let mut handles = Vec::new();
    for worker in 0..4 {
        let store = store.clone();
        handles.push(std::thread::spawn(move || {
            for index in 0..10 {
                let id = format!("00000000-0000-4000-8000-{:012}", worker * 100 + index);
                let mut request = untitled("body");
                request.id = Some(id.clone());
                store.draft_write(request).expect("write");
                let _ = store.draft_read(&id).expect("read");
                let _ = store.draft_discard(&id).expect("discard");
                store
                    .view_set(
                        &format!("/docs/{worker}.md"),
                        EditorViewStateInput {
                            anchor: index,
                            head: index,
                            top_pos: 0,
                            top_offset: 0.0,
                            scroll_left: 0.0,
                            live_preview_preferred: true,
                        },
                    )
                    .expect("view");
            }
        }));
    }
    for handle in handles {
        handle.join().expect("worker must finish");
    }

    assert!(store.view_get("/docs/3.md").is_some());
    let listed = store.draft_list().expect("list");
    assert!(listed.len() <= 20);
}

#[test]
fn discard_after_concurrent_writes_wins() {
    let (_dir, store) = store();
    let id = "00000000-0000-4000-8000-0000000000aa".to_string();

    let writer = {
        let store = store.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for index in 0..50 {
                let mut request = untitled("body");
                request.id = Some(id.clone());
                request.anchor = index;
                store.draft_write(request).expect("write");
            }
        })
    };
    let discarder = {
        let store = store.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for _ in 0..50 {
                let _ = store.draft_discard(&id).expect("discard");
            }
        })
    };
    writer.join().expect("writer");
    discarder.join().expect("discarder");

    // The store serializes both operations; the explicit final discard is the
    // last operation and must not be undone by a queued write.
    let _ = store.draft_discard(&id).expect("final discard");
    assert_eq!(
        store.draft_read(&id).expect_err("discarded").code,
        AppErrorCode::NotFound
    );
}

#[test]
fn disabled_store_reads_empty_and_rejects_writes() {
    let store = SessionStore::disabled();
    assert!(!store.is_ready());
    assert!(store.view_get("/docs/a.md").is_none());
    assert!(store.draft_list().expect("list").is_empty());
    assert_eq!(
        store
            .view_set(
                "/docs/a.md",
                EditorViewStateInput {
                    anchor: 0,
                    head: 0,
                    top_pos: 0,
                    top_offset: 0.0,
                    scroll_left: 0.0,
                    live_preview_preferred: true,
                },
            )
            .expect_err("write")
            .code,
        AppErrorCode::Io
    );
    assert_eq!(
        store.draft_write(untitled("x")).expect_err("write").code,
        AppErrorCode::Io
    );
    assert_eq!(
        store
            .draft_read("00000000-0000-4000-8000-000000000001")
            .expect_err("read")
            .code,
        AppErrorCode::Io
    );
    assert_eq!(store.gc(), Default::default());
}
