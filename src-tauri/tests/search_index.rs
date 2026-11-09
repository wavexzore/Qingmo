//! SQLite/FTS5 index lifecycle: scanning, routing, isolation and corruption.

use std::fs;
use std::path::PathBuf;

use qingmo_lib::services::search_index::{workspace_key, SearchIndexService, INDEX_SCHEMA_VERSION};
use tempfile::TempDir;

fn canonical(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical")
}

fn write(root: &std::path::Path, relative: &str, text: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(path, text).expect("fixture");
}

#[test]
fn scans_and_searches_latin_cjk_and_short_terms() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "a.md", "# 中文标题\n\n正文 hello world\n");
    write(&root, "b.md", "# Other\n\nunrelated\n");
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");

    let latin = index.search(&root, "hello", 10, 0).expect("latin");
    assert_eq!(latin.results.len(), 1);
    assert_eq!(latin.results[0].path, "a.md");
    assert_eq!(latin.results[0].title, "中文标题");

    let cjk = index.search(&root, "中文", 10, 0).expect("cjk");
    assert_eq!(cjk.results.len(), 1);
    assert_eq!(cjk.results[0].path, "a.md");

    let single = index.search(&root, "文", 10, 0).expect("single cjk");
    assert_eq!(single.results.len(), 1);
    assert!(!single.results[0].snippet.is_empty());
}

#[test]
fn excludes_terms_and_never_leaks_across_workspaces() {
    let first = TempDir::new().expect("first");
    let second = TempDir::new().expect("second");
    let first_root = canonical(&first);
    let second_root = canonical(&second);
    write(&first_root, "a.md", "# A\n\nalpha beta\n");
    write(&second_root, "b.md", "# B\n\nalpha gamma\n");
    let index = SearchIndexService::open(first.path().join("index")).expect("index");
    index.scan_root(&first_root).expect("scan first");
    index.scan_root(&second_root).expect("scan second");

    let filtered = index
        .search(&first_root, "alpha -beta", 10, 0)
        .expect("exclude");
    assert!(filtered.results.is_empty());
    let scoped = index.search(&first_root, "alpha", 10, 0).expect("scoped");
    assert_eq!(scoped.results.len(), 1);
    assert_eq!(scoped.results[0].path, "a.md");
}

#[test]
fn rebuild_and_incremental_upsert_and_remove_keep_the_table_consistent() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    let file = root.join("a.md");
    write(&root, "a.md", "# A\n\nfirst\n");
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");
    assert_eq!(
        index
            .search(&root, "first", 10, 0)
            .expect("search")
            .results
            .len(),
        1
    );

    fs::write(&file, "# A\n\nsecond\n").expect("edit");
    index.upsert_path(&root, &file).expect("upsert");
    assert!(index
        .search(&root, "first", 10, 0)
        .expect("old search")
        .results
        .is_empty());
    assert_eq!(
        index
            .search(&root, "second", 10, 0)
            .expect("new search")
            .results
            .len(),
        1
    );

    fs::remove_file(&file).expect("remove");
    index.remove_path(&root, &file);
    assert!(index
        .search(&root, "second", 10, 0)
        .expect("removed search")
        .results
        .is_empty());
    index.rebuild(&root).expect("rebuild empty");
    assert!(index
        .search(&root, "first", 10, 0)
        .expect("rebuild search")
        .results
        .is_empty());
}

#[test]
fn a_corrupt_database_is_backed_up_and_recreated() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "a.md", "# A\n\nsurvives\n");
    let index_dir = dir.path().join("index");
    fs::create_dir_all(&index_dir).expect("index dir");
    fs::write(index_dir.join("index.sqlite"), vec![0u8; 4096]).expect("corrupt db");

    let index = SearchIndexService::open(index_dir.clone()).expect("recover index");
    assert!(index.is_ready());
    index.scan_root(&root).expect("scan");
    assert_eq!(
        index
            .search(&root, "survives", 10, 0)
            .expect("search")
            .results
            .len(),
        1
    );
    assert!(fs::read_dir(&index_dir)
        .expect("read index dir")
        .flatten()
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("index.corrupt-")));
}

#[test]
fn the_schema_version_and_workspace_key_are_stable() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "a.md", "# A\n\nbody\n");
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");

    let connection =
        rusqlite::Connection::open(dir.path().join("index").join("index.sqlite")).expect("sqlite");
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, INDEX_SCHEMA_VERSION);
    let key: String = connection
        .query_row("SELECT key FROM workspaces", [], |row| row.get(0))
        .expect("workspace row");
    assert_eq!(key, workspace_key(&root));
}

#[test]
fn an_empty_query_returns_a_hint_instead_of_a_database_error() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    let response = index.search(&root, "   ", 10, 0).expect("empty query");
    assert!(response.results.is_empty());
    assert!(response.error.is_some());
}

#[test]
fn rename_path_moves_one_row_and_reprefixes_directories() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "docs/a.md", "# A\n\nneedle one\n");
    write(&root, "docs/b.md", "# B\n\nneedle two\n");
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");

    let old = root.join("docs/a.md");
    let new = root.join("docs/a-renamed.md");
    fs::rename(&old, &new).expect("rename file");
    index.rename_path(&root, &old, &new).expect("rename index");
    let hits = index.search(&root, "needle", 10, 0).expect("search");
    let paths: Vec<&str> = hits.results.iter().map(|hit| hit.path.as_str()).collect();
    assert!(paths.contains(&"docs/a-renamed.md"));
    assert!(!paths.contains(&"docs/a.md"));

    let old_dir = root.join("docs");
    let new_dir = root.join("docs2");
    fs::rename(&old_dir, &new_dir).expect("rename dir");
    index
        .rename_path(&root, &old_dir, &new_dir)
        .expect("rename prefix");
    let hits = index
        .search(&root, "needle", 10, 0)
        .expect("search after dir");
    let paths: Vec<&str> = hits.results.iter().map(|hit| hit.path.as_str()).collect();
    assert!(paths.iter().all(|path| path.starts_with("docs2/")));
    assert_eq!(paths.len(), 2);
}

#[test]
fn rename_to_a_non_markdown_name_removes_the_old_row() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "note.md", "# Note\n\nunique-token\n");
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");

    let old = root.join("note.md");
    let new = root.join("note.txt");
    fs::rename(&old, &new).expect("rename");
    let result = index.rename_path(&root, &old, &new).expect("rename index");
    assert!(!result.renamed);
    assert!(index
        .search(&root, "unique-token", 10, 0)
        .expect("search")
        .results
        .is_empty());
}

#[test]
fn upsert_path_removes_a_row_when_the_path_is_no_longer_indexable() {
    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    write(&root, "note.md", "# Note\n\nstale-token\n");
    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");
    assert_eq!(
        index
            .search(&root, "stale-token", 10, 0)
            .expect("search")
            .results
            .len(),
        1
    );

    fs::remove_file(root.join("note.md")).expect("remove file");
    fs::create_dir(root.join("note.md")).expect("replace with dir");
    index
        .upsert_path(&root, &root.join("note.md"))
        .expect("upsert");
    assert!(index
        .search(&root, "stale-token", 10, 0)
        .expect("search")
        .results
        .is_empty());
}

#[cfg(unix)]
#[test]
fn symlinks_are_indexed_by_link_name_only_inside_the_root() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new().expect("temp dir");
    let root = canonical(&dir);
    let outside = TempDir::new().expect("outside");
    let outside_root = fs::canonicalize(outside.path()).expect("outside canonical");
    write(&root, "target.md", "# Target\n\ninside-token\n");
    write(&outside_root, "outside.md", "# Outside\n\noutside-token\n");
    symlink(root.join("target.md"), root.join("link.md")).expect("inside link");
    symlink(
        outside_root.join("outside.md"),
        root.join("outside-link.md"),
    )
    .expect("outside link");

    let index = SearchIndexService::open(dir.path().join("index")).expect("index");
    index.scan_root(&root).expect("scan");

    let inside = index.search(&root, "inside-token", 10, 0).expect("inside");
    let paths: Vec<&str> = inside.results.iter().map(|hit| hit.path.as_str()).collect();
    assert!(paths.contains(&"link.md"), "link name must be searchable");
    assert!(
        paths.contains(&"target.md"),
        "the target itself is also a real file"
    );
    assert!(index
        .search(&root, "outside-token", 10, 0)
        .expect("outside")
        .results
        .is_empty());
}
