//! Search index failure modes: corrupt/open failures, stale WAL sidecars,
//! workspace switching and a scan superseded by a newer generation.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::search_index::SearchIndexService;
use tempfile::TempDir;

fn canonical(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical")
}

fn write(root: &std::path::Path, name: &str, text: &str) {
    fs::write(root.join(name), text).expect("fixture");
}

#[test]
fn a_disabled_index_reports_index_disabled_instead_of_panicking() {
    let dir = TempDir::new().expect("temp dir");
    let index = SearchIndexService::disabled();
    let error = index
        .search(&canonical(&dir), "anything", 10, 0)
        .expect_err("disabled search");
    assert_eq!(error.code, AppErrorCode::IndexDisabled);
    assert!(!index.is_ready());
}

#[test]
fn a_path_that_is_a_file_fails_to_open_cleanly() {
    let dir = TempDir::new().expect("temp dir");
    let blocked = dir.path().join("index");
    fs::write(&blocked, b"not a directory").expect("blocked path");
    let error = SearchIndexService::open(blocked).expect_err("open must fail");
    assert_ne!(error.code, AppErrorCode::IndexDisabled);
}

#[cfg(unix)]
#[test]
fn a_read_only_index_directory_fails_to_open_cleanly() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().expect("temp dir");
    // The store chmods its own root to 0700, so the read-only boundary has to
    // be the parent: creating `index/` is the operation that must fail.
    let parent = dir.path().join("read-only-parent");
    fs::create_dir(&parent).expect("parent");
    let mut permissions = fs::metadata(&parent).expect("metadata").permissions();
    permissions.set_mode(0o555);
    fs::set_permissions(&parent, permissions).expect("read-only parent");

    let result = SearchIndexService::open(parent.join("index"));

    let mut permissions = fs::metadata(&parent).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&parent, permissions).expect("restore");
    assert!(result.is_err(), "a read-only index must not report success");
}

#[test]
fn stale_wal_sidecars_are_recovered_or_backed_up() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "a.md", "# A\n\nalpha\n");
    let index_dir = dir.path().join("index");
    let index = SearchIndexService::open(index_dir.clone()).expect("index");
    index.scan_root(&root).expect("scan");
    drop(index);

    fs::write(index_dir.join("index.sqlite-wal"), b"garbage wal").expect("wal");
    fs::write(index_dir.join("index.sqlite-shm"), b"garbage shm").expect("shm");

    let reopened = SearchIndexService::open(index_dir.clone()).expect("reopen");
    assert!(reopened.is_ready());
    reopened.scan_root(&root).expect("rescan");
    let hits = reopened
        .search(&root, "alpha", 10, 0)
        .expect("search after recovery");
    assert_eq!(hits.results.len(), 1, "hits: {hits:?}");
}

#[test]
fn switching_workspaces_keeps_rows_isolated_after_rescans() {
    let first = TempDir::new().expect("first");
    let second = TempDir::new().expect("second");
    let first_root = canonical(&first);
    let second_root = canonical(&second);
    write(&first_root, "one.md", "# One\n\nalpha-only\n");
    write(&second_root, "two.md", "# Two\n\nalpha-only\n");
    let index = SearchIndexService::open(first.path().join("index")).expect("shared index");

    index.scan_root(&first_root).expect("scan first");
    index.scan_root(&second_root).expect("scan second");
    assert_eq!(
        index
            .search(&first_root, "alpha", 10, 0)
            .expect("first search")
            .results
            .len(),
        1
    );
    assert_eq!(
        index
            .search(&second_root, "alpha", 10, 0)
            .expect("second search")
            .results
            .len(),
        1
    );

    // A rescan of the first workspace must not duplicate or drop the second.
    index.scan_root(&first_root).expect("rescan first");
    let first_hits = index
        .search(&first_root, "alpha", 10, 0)
        .expect("first again");
    assert_eq!(first_hits.results.len(), 1);
    assert_eq!(first_hits.results[0].path, "one.md");
    let second_hits = index
        .search(&second_root, "alpha", 10, 0)
        .expect("second again");
    assert_eq!(second_hits.results.len(), 1);
    assert_eq!(second_hits.results[0].path, "two.md");
}

#[test]
fn a_superseded_scan_stops_without_duplicating_rows() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    for index in 0..2_000 {
        write(
            &root,
            &format!("doc-{index:04}.md"),
            &format!("# {index}\n\ncommon token {index}\n"),
        );
    }
    let index = Arc::new(SearchIndexService::open(dir.path().join("index")).expect("index"));
    let first = index.clone();
    let first_root = root.clone();
    let handle = std::thread::spawn(move || first.scan_root(&first_root));

    std::thread::sleep(Duration::from_millis(20));
    // Bumps the generation; the older scan must observe it at its next
    // 100-file checkpoint and return without writing stale state.
    index.scan_root(&root).expect("second scan");
    handle.join().expect("scan thread").expect("first scan");

    let hits = index.search(&root, "common", 30, 0).expect("search");
    assert!(!hits.results.is_empty());
    let mut paths = hits
        .results
        .iter()
        .map(|hit| hit.path.clone())
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), hits.results.len(), "duplicate result paths");
}
