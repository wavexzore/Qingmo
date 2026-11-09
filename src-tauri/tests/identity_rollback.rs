//! Identity/history/view rollback mapping tests.

use std::fs;
use std::path::{Path, PathBuf};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::identity_rollback::{
    legacy_history_key, run, HISTORY_SUBDIR, IDENTITY_SUBDIR, SESSION_SUBDIR,
};
use serde_json::{json, Value};
use tempfile::TempDir;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/identity_rollback"
);
const DOC_A: &str = "11111111-1111-4111-8111-111111111111";
const DOC_B: &str = "22222222-2222-4222-8222-222222222222";

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).expect("target dir");
    for entry in fs::read_dir(source).expect("read source") {
        let entry = entry.expect("dir entry");
        let destination = target.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).expect("copy file");
        }
    }
}

fn data_copy() -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("temp dir");
    let root = dir.path().join("data");
    copy_tree(Path::new(FIXTURE), &root);
    (dir, root)
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).expect("read json")).expect("valid json")
}

fn view_legacy(root: &Path) -> Value {
    read_json(&root.join(SESSION_SUBDIR).join("view-state.json"))["legacy"].clone()
}

fn history_target(root: &Path, alias: &str) -> PathBuf {
    root.join(HISTORY_SUBDIR).join(legacy_history_key(alias))
}

#[test]
fn dry_run_reports_every_mapping_and_writes_nothing() {
    let (_dir, root) = data_copy();
    let before = read_json(&root.join(SESSION_SUBDIR).join("view-state.json"));

    let report = run(&root, false).expect("dry run");
    assert_eq!(report.mode, "dry-run");
    assert_eq!(report.summary.documents, 2);
    assert_eq!(report.summary.history_mappings, 3);
    assert_eq!(report.summary.history_copied_entries, 3);
    assert_eq!(report.summary.view_inserted, 3);
    assert!(report.problems.is_empty(), "{:?}", report.problems);

    assert!(!history_target(&root, "/work/notes/a.md").exists());
    assert!(!history_target(&root, "/work/notes/old-a.md").exists());
    assert!(!history_target(&root, "/work/b.md").exists());
    assert_eq!(
        read_json(&root.join(SESSION_SUBDIR).join("view-state.json")),
        before,
        "dry-run must not touch view-state.json"
    );
    assert!(!root.join("rollback-report.json").exists());
}

#[test]
fn apply_copies_history_and_view_for_the_primary_path_and_legacy_aliases() {
    let (_dir, root) = data_copy();

    let report = run(&root, true).expect("apply");
    assert_eq!(report.mode, "apply");
    assert_eq!(report.summary.history_copied_entries, 3);
    assert_eq!(report.summary.view_inserted, 3);

    // Source identity/history buckets are never removed.
    assert!(root.join(IDENTITY_SUBDIR).join("documents.json").is_file());
    for id in [DOC_A, DOC_B] {
        assert!(root.join(HISTORY_SUBDIR).join(id).is_dir());
    }
    assert_eq!(
        fs::read(root.join(HISTORY_SUBDIR).join(DOC_A).join("entry-a.bin")).expect("source bin"),
        b"old a\n"
    );

    for (alias, id) in [
        ("/work/notes/a.md", "entry-a"),
        ("/work/notes/old-a.md", "entry-a"),
        ("/work/b.md", "entry-b"),
    ] {
        let target = history_target(&root, alias);
        let entries = read_json(&target.join("entries.json"));
        assert_eq!(entries["path"], alias);
        assert_eq!(entries["entries"][0]["id"], id);
        assert!(target.join(format!("{id}.bin")).is_file());
    }

    let legacy = view_legacy(&root);
    assert_eq!(legacy["/work/notes/a.md"]["head"], 2);
    assert_eq!(legacy["/work/notes/old-a.md"]["head"], 2);
    assert_eq!(legacy["/work/b.md"]["head"], 5);
}

#[test]
fn applying_twice_merges_without_duplicating_entries() {
    let (_dir, root) = data_copy();
    run(&root, true).expect("first apply");

    let second = run(&root, true).expect("second apply");
    assert!(second
        .history
        .iter()
        .all(|mapping| mapping.action == "merge"));
    assert!(second
        .history
        .iter()
        .all(|mapping| mapping.copied_entries == 0 && mapping.kept_entries == 1));
    let target = history_target(&root, "/work/b.md");
    let entries = read_json(&target.join("entries.json"));
    assert_eq!(entries["entries"].as_array().expect("entries").len(), 1);
}

#[test]
fn an_existing_target_keeps_its_rows_and_merges_new_ones() {
    let (_dir, root) = data_copy();
    let target = history_target(&root, "/work/notes/a.md");
    fs::create_dir_all(&target).expect("target dir");
    fs::write(
        target.join("entries.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "path": "/work/notes/a.md",
            "entries": [{
                "id": "existing",
                "hash": "00",
                "size": 1,
                "createdAtMs": 1600000000000i64,
                "lastSeenAtMs": 1600000000000i64,
                "appVersion": "0.1.3"
            }]
        }))
        .expect("json"),
    )
    .expect("existing entries");
    fs::write(target.join("existing.bin"), b"x").expect("existing bin");

    let report = run(&root, true).expect("apply");
    let mapping = report
        .history
        .iter()
        .find(|mapping| mapping.alias == "/work/notes/a.md")
        .expect("primary mapping");
    assert_eq!(mapping.action, "merge");
    assert_eq!(mapping.kept_entries, 0);
    assert_eq!(mapping.copied_entries, 1);
    let entries = read_json(&target.join("entries.json"));
    let ids: Vec<&str> = entries["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect();
    assert!(ids.contains(&"existing"));
    assert!(ids.contains(&"entry-a"));
}

#[test]
fn invalid_paths_are_reported_and_skipped() {
    let dir = TempDir::new().expect("temp dir");
    let root = dir.path().join("data");
    fs::create_dir_all(root.join(IDENTITY_SUBDIR)).expect("identity dir");
    fs::write(
        root.join(IDENTITY_SUBDIR).join("documents.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 3,
            "entries": {
                DOC_A: {"path": "../escape.md", "legacyPaths": []}
            }
        }))
        .expect("json"),
    )
    .expect("identity");

    let report = run(&root, false).expect("dry run");
    assert_eq!(report.summary.documents, 0);
    assert!(report
        .problems
        .iter()
        .any(|problem| problem.contains("invalid primary path")));
}

#[test]
fn a_missing_identity_file_fails_instead_of_silently_doing_nothing() {
    let dir = TempDir::new().expect("temp dir");
    let error = run(dir.path(), false).expect_err("missing identity");
    assert_eq!(error.code, AppErrorCode::NotFound);
}

#[test]
fn a_v1_view_state_is_converted_to_schema_two_without_losing_paths() {
    let (_dir, root) = data_copy();
    let view_path = root.join(SESSION_SUBDIR).join("view-state.json");
    fs::write(
        &view_path,
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "entries": {
                "/work/notes/a.md": {
                    "anchor": 9,
                    "head": 9,
                    "topPos": 0,
                    "topOffset": 0.0,
                    "scrollLeft": 0.0,
                    "livePreviewPreferred": false,
                    "updatedAtMs": 1700000000000i64
                }
            }
        }))
        .expect("json"),
    )
    .expect("v1 view");

    run(&root, true).expect("apply");
    let view = read_json(&view_path);
    assert_eq!(view["schemaVersion"], 2);
    assert_eq!(view["legacy"]["/work/notes/a.md"]["head"], 9);
    assert!(view["entries"].as_object().expect("entries").is_empty());
}

#[test]
fn report_is_serializable_and_contains_all_sections() {
    let (_dir, root) = data_copy();
    let report = run(&root, false).expect("dry run");
    let text = serde_json::to_string(&report).expect("serialize");
    let parsed: Value = serde_json::from_str(&text).expect("deserialize");
    assert_eq!(
        parsed["history"].as_array().expect("history").len(),
        report.history.len()
    );
    assert_eq!(
        parsed["view"].as_array().expect("view").len(),
        report.view.len()
    );
}
