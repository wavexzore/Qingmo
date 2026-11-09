//! Rebuildable SQLite/FTS5 workspace search index.
//!
//! The database is a cache: deleting `index/` loses no user data. Writes are
//! serialized on one connection; queries use a second WAL connection. The
//! `documents` table drives every query and always filters `workspace_key`, so
//! orphaned FTS rows or another workspace can never leak into results.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{SearchHit, SearchIndexState, SearchResponse, SearchStatus};
use crate::services::file_service::MAX_DOCUMENT_BYTES;
use crate::services::search_query::{self, plain_snippet, title_from_body, TermTable};
use crate::services::workspace_service::is_ignored_relative_path;

pub const INDEX_SCHEMA_VERSION: u32 = 2;
pub const INDEX_MAX_FILES: usize = 100_000;
pub const INDEX_MAX_BODY_BYTES: u64 = 512 * 1024 * 1024;
pub const INDEX_MAX_FILE_BYTES: u64 = MAX_DOCUMENT_BYTES;
pub const INDEX_SHORT_TERMS_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const INDEX_QUERY_TIMEOUT_MS: u64 = 500;
pub const SEARCH_SCORE_LIMIT: usize = 2_000;

struct Ready {
    write: Mutex<Connection>,
    read: Mutex<Connection>,
}

struct Inner {
    root: PathBuf,
    ready: Option<Ready>,
    indexed_roots: Mutex<HashSet<PathBuf>>,
    generation: AtomicU64,
    status: Mutex<std::collections::HashMap<PathBuf, SearchStatus>>,
    truncated: AtomicBool,
}

#[derive(Clone)]
pub struct SearchIndexService {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SearchIndexService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SearchIndexService")
            .field("root", &self.inner.root)
            .field("ready", &self.inner.ready.is_some())
            .finish()
    }
}

impl SearchIndexService {
    pub fn open(root: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&root).map_err(|error| AppError::from_io(&error))?;
        private_dir(&root)?;
        let db = root.join("index.sqlite");
        let write = match open_connection(&db, true) {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!(%error, "search index cannot be opened; rebuilding");
                backup_corrupt(&db);
                open_connection(&db, true)?
            }
        };
        if let Err(error) = initialize(&write) {
            tracing::warn!(%error, "search index is corrupt; rebuilding");
            drop(write);
            backup_corrupt(&db);
            let write = open_connection(&db, true)?;
            initialize(&write)?;
            let read = open_connection(&db, false)?;
            return Ok(Self::from_connections(root, write, read));
        }
        let read = open_connection(&db, false)?;
        Ok(Self::from_connections(root, write, read))
    }

    fn from_connections(root: PathBuf, write: Connection, read: Connection) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
                ready: Some(Ready {
                    write: Mutex::new(write),
                    read: Mutex::new(read),
                }),
                indexed_roots: Mutex::new(HashSet::new()),
                generation: AtomicU64::new(1),
                status: Mutex::new(std::collections::HashMap::new()),
                truncated: AtomicBool::new(false),
            }),
        }
    }

    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(Inner {
                root: PathBuf::new(),
                ready: None,
                indexed_roots: Mutex::new(HashSet::new()),
                generation: AtomicU64::new(1),
                status: Mutex::new(std::collections::HashMap::new()),
                truncated: AtomicBool::new(false),
            }),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.inner.ready.is_some()
    }

    pub fn is_indexed(&self, root: &Path) -> bool {
        self.inner
            .indexed_roots
            .lock()
            .map(|roots| roots.contains(root))
            .unwrap_or(false)
    }

    pub fn status(&self, root: &Path) -> SearchStatus {
        self.inner
            .status
            .lock()
            .ok()
            .and_then(|status| status.get(root).cloned())
            .unwrap_or(SearchStatus {
                root: root.to_string_lossy().to_string(),
                state: SearchIndexState::Idle,
                indexed: 0,
                total: 0,
                truncated: false,
                error: None,
            })
    }

    /// Registers all live workspace roots. New roots get a background scan;
    /// removed roots stop receiving work but their rows stay for fast reopen.
    pub fn sync_roots(&self, roots: HashSet<PathBuf>) {
        if self.inner.ready.is_none() {
            return;
        }
        for root in roots {
            let should_scan = self
                .inner
                .indexed_roots
                .lock()
                .map(|mut indexed| indexed.insert(root.clone()))
                .unwrap_or(false);
            if should_scan {
                let service = self.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = service.scan_root(&root) {
                        tracing::warn!(%error, "background search index scan failed");
                    }
                });
            }
        }
    }

    /// Scans one root, using mtime/size as a fast path.
    pub fn scan_root(&self, root: &Path) -> Result<(), AppError> {
        let ready = self.ready()?;
        let started = Instant::now();
        let workspace_key = workspace_key(root);
        self.set_status(
            root,
            SearchStatus {
                root: root.to_string_lossy().to_string(),
                state: SearchIndexState::Indexing,
                indexed: 0,
                total: 0,
                truncated: false,
                error: None,
            },
        );
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut files = Vec::new();
        let mut total_bytes = 0u64;
        let mut truncated = false;
        walk(root, &mut files, &mut total_bytes, &mut truncated, 0)?;
        let total = files.len() as u64;

        {
            let write = ready
                .write
                .lock()
                .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
            write
                .execute(
                    "INSERT INTO workspaces(key, root, last_seen_ms) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET root=excluded.root, last_seen_ms=excluded.last_seen_ms",
                    params![workspace_key, root.to_string_lossy(), now_ms()],
                )
                .map_err(index_error)?;
        }

        let mut seen = HashSet::new();
        let mut indexed = 0u64;
        for (index, path) in files.iter().enumerate() {
            if self.inner.generation.load(Ordering::SeqCst) != generation {
                return Ok(());
            }
            if index % 100 == 0 && started.elapsed().as_millis() > 60_000 {
                truncated = true;
                break;
            }
            let Ok(metadata) = fs::metadata(path) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > INDEX_MAX_FILE_BYTES {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            seen.insert(relative.clone());
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            if self.is_fresh(ready, &workspace_key, &relative, mtime, metadata.len())? {
                indexed += 1;
                continue;
            }
            if let Some(prepared) = prepare_upsert(root, path) {
                if self
                    .upsert_prepared(ready, &workspace_key, &prepared)
                    .is_ok()
                {
                    indexed += 1;
                }
            } else {
                continue;
            }
        }

        if !truncated {
            self.remove_stale(ready, &workspace_key, &seen)?;
        }
        let _ = self.optimize(ready);
        if !truncated {
            let _ = self.compact(ready);
        }
        self.set_status(
            root,
            SearchStatus {
                root: root.to_string_lossy().to_string(),
                state: SearchIndexState::Idle,
                indexed,
                total,
                truncated,
                error: None,
            },
        );
        self.inner.truncated.store(truncated, Ordering::SeqCst);
        Ok(())
    }

    pub fn notify_rescan(&self, root: PathBuf) {
        if self.inner.ready.is_none() {
            return;
        }
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = service.scan_root(&root) {
                tracing::warn!(%error, "search index rescan failed");
            }
        });
    }

    /// Index one saved path without blocking the save path.
    pub fn notify_upsert(&self, root: PathBuf, path: PathBuf) {
        if self.inner.ready.is_none() {
            return;
        }
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = service.upsert_path(&root, &path) {
                tracing::warn!(%error, "search index upsert failed");
            }
        });
    }

    pub fn upsert_path(&self, root: &Path, path: &Path) -> Result<(), AppError> {
        let ready = self.ready()?;
        let workspace_key = workspace_key(root);
        let relative = relative_key(root, path)?;
        self.ensure_workspace(ready, root, &workspace_key)?;
        match prepare_upsert(root, path) {
            Some(prepared) => self.upsert_prepared(ready, &workspace_key, &prepared),
            None => {
                // A saved file that is no longer indexable (md -> txt, moved
                // out of the root, oversized) must not leave its old row.
                self.remove_path_or_prefix(root, &relative)
            }
        }
    }

    pub fn remove_path(&self, root: &Path, path: &Path) {
        let Ok(ready) = self.ready() else {
            return;
        };
        let workspace_key = workspace_key(root);
        let Ok(relative) = path.strip_prefix(root) else {
            return;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if let Ok(write) = ready.write.lock() {
            let _ = delete_document_tx(&write, &workspace_key, &relative);
        }
    }

    /// Deletes the exact row and every row below it.
    ///
    /// A directory rename/removal must not leave `docs/a.md` indexed after
    /// `docs` disappears.
    pub fn remove_path_or_prefix(&self, root: &Path, relative: &str) -> Result<(), AppError> {
        let ready = self.ready()?;
        let workspace_key = workspace_key(root);
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        write
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(index_error)?;
        let result = delete_path_or_prefix_tx(&write, &workspace_key, relative);
        match result {
            Ok(()) => write.execute_batch("COMMIT").map_err(index_error),
            Err(error) => {
                let _ = write.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Atomically moves one file row (or a directory prefix) to its new path.
    ///
    /// The replacement file is read and decoded before the transaction so the
    /// database lock is never held during disk I/O. A non-indexable target
    /// deletes the old row and reports `requires_rescan = false`; a directory
    /// rename updates every row below it in one transaction.
    pub fn rename_path(
        &self,
        root: &Path,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<RenameResult, AppError> {
        let ready = self.ready()?;
        let workspace_key = workspace_key(root);
        let old_relative = relative_key(root, old_path)?;
        let new_relative = relative_key(root, new_path)?;
        self.ensure_workspace(ready, root, &workspace_key)?;

        if fs::metadata(new_path).is_ok_and(|metadata| metadata.is_dir()) {
            self.rename_prefix_rows(ready, &workspace_key, &old_relative, &new_relative, root)?;
            return Ok(RenameResult {
                renamed: true,
                requires_rescan: false,
            });
        }

        let prepared = prepare_upsert(root, new_path);
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        write
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(index_error)?;
        let result = (|| -> Result<(), AppError> {
            delete_path_or_prefix_tx(&write, &workspace_key, &old_relative)?;
            if let Some(prepared) = prepared.as_ref() {
                insert_prepared_tx(&write, &workspace_key, prepared)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                write.execute_batch("COMMIT").map_err(index_error)?;
                Ok(RenameResult {
                    renamed: prepared.is_some(),
                    requires_rescan: false,
                })
            }
            Err(error) => {
                let _ = write.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn rename_prefix_rows(
        &self,
        ready: &Ready,
        workspace_key: &str,
        old_relative: &str,
        new_relative: &str,
        root: &Path,
    ) -> Result<(), AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        write
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(index_error)?;
        let result = (|| -> Result<(), AppError> {
            let rows: Vec<(i64, String)> = {
                let pattern = format!("{}/%", escape_like(old_relative));
                let mut statement = write
                    .prepare(
                        "SELECT id, path FROM documents
                         WHERE workspace_key = ?1 AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')",
                    )
                    .map_err(index_error)?;
                let rows = statement
                    .query_map(params![workspace_key, old_relative, pattern], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(index_error)?;
                rows.filter_map(Result::ok).collect()
            };
            for (id, relative) in rows {
                let suffix = relative.strip_prefix(old_relative).unwrap_or("");
                let next = format!("{new_relative}{suffix}");
                let abs_path = root.join(&next).to_string_lossy().into_owned();
                write
                    .execute(
                        "UPDATE documents SET path = ?1, abs_path = ?2 WHERE id = ?3",
                        params![next, abs_path, id],
                    )
                    .map_err(index_error)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => write.execute_batch("COMMIT").map_err(index_error),
            Err(error) => {
                let _ = write.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Rebuilds one workspace from disk.
    pub fn rebuild(&self, root: &Path) -> Result<(), AppError> {
        let ready = self.ready()?;
        let workspace_key = workspace_key(root);
        {
            let write = ready
                .write
                .lock()
                .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
            delete_workspace_tx(&write, &workspace_key)?;
        }
        self.inner
            .indexed_roots
            .lock()
            .ok()
            .map(|mut roots| roots.remove(root));
        self.scan_root(root)
    }

    pub fn search(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Result<SearchResponse, AppError> {
        let started = Instant::now();
        let ready = self.ready()?;
        let parsed = search_query::parse(query)?;
        if parsed.is_empty() {
            return Ok(SearchResponse {
                results: Vec::new(),
                has_more: false,
                indexing: false,
                truncated: false,
                took_ms: 0,
                mode: parsed.mode,
                error: Some("请输入至少一个关键词".to_string()),
            });
        }
        let workspace_key = workspace_key(root);
        let read = ready
            .read
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;

        // A broad or adversarial query must never hold the UI for an
        // unbounded time. SQLite invokes this every 1000 VM steps; the guard
        // clears it on every return path.
        let deadline = Instant::now() + Duration::from_millis(INDEX_QUERY_TIMEOUT_MS);
        read.progress_handler(1_000, Some(move || Instant::now() > deadline));
        let _deadline = ProgressGuard(&read);

        let limit = limit.min(search_query::SEARCH_MAX_LIMIT);
        let mut tables: Vec<TableMatches> = Vec::new();
        for table in [TermTable::Trigram, TermTable::Short] {
            let Some(expression) = include_expression(table, &parsed) else {
                continue;
            };
            let ids = query_document_ids(&read, table, &expression, &workspace_key)?;
            // bm25 forces FTS5 to score every matching row. Broad terms (a
            // single common CJK character) are therefore used as filters and
            // ranking falls back to recency for them.
            let scores = if ids.len() <= SEARCH_SCORE_LIMIT {
                query_scores(&read, table, &expression, &workspace_key)?
            } else {
                HashMap::new()
            };
            tables.push(TableMatches { table, ids, scores });
        }
        debug_assert!(!tables.is_empty());

        let mut candidates: HashMap<i64, (i64, f64)> = tables[0]
            .ids
            .iter()
            .map(|(id, mtime)| (*id, (*mtime, 0.0)))
            .collect();
        for matches in tables.iter().skip(1) {
            candidates.retain(|id, _| matches.ids.contains_key(id));
        }
        for matches in &tables {
            let weight = match matches.table {
                TermTable::Trigram => 1.0,
                TermTable::Short => 0.5,
            };
            for (id, score) in &matches.scores {
                if let Some(entry) = candidates.get_mut(id) {
                    entry.1 += weight * score;
                }
            }
        }

        // An exclude term living in the other table was not part of that
        // table's NOT expression, so remove its matches now.
        for table in [TermTable::Trigram, TermTable::Short] {
            if tables.iter().any(|matches| matches.table == table) {
                continue;
            }
            let Some(expression) = combine_expressions(&parsed.exclude, table) else {
                continue;
            };
            let excluded = query_document_ids(&read, table, &expression, &workspace_key)?;
            candidates.retain(|id, _| !excluded.contains_key(id));
        }

        let mut ranked = candidates.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            left.1
                 .1
                .partial_cmp(&right.1 .1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.1 .0.cmp(&left.1 .0))
        });
        let has_more = ranked.len() > offset.saturating_add(limit);
        let page = ranked
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let page_ids = page.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        let metadata = fetch_metadata(&read, &page_ids)?;
        let bodies = fetch_bodies(&read, &page_ids)?;
        let results = page
            .into_iter()
            .filter_map(|(id, (mtime_ms, score))| {
                let (path, title) = metadata.get(&id)?.clone();
                Some(SearchHit {
                    path,
                    title,
                    snippet: bodies
                        .get(&id)
                        .map(|body| plain_snippet(body, &parsed.include))
                        .unwrap_or_default(),
                    score,
                    mtime_ms,
                })
            })
            .collect();
        Ok(SearchResponse {
            results,
            has_more,
            indexing: false,
            truncated: false,
            took_ms: started.elapsed().as_millis() as u64,
            mode: parsed.mode,
            error: None,
        })
    }

    pub fn gc(&self) -> Result<usize, AppError> {
        let Some(ready) = self.inner.ready.as_ref() else {
            // A disabled index is not a failure: there is nothing to govern.
            return Ok(0);
        };
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        let cutoff = now_ms().saturating_sub(90 * 24 * 60 * 60 * 1000);
        let stale = {
            let mut statement = write
                .prepare("SELECT key FROM workspaces WHERE last_seen_ms < ?1")
                .map_err(index_error)?;
            let rows = statement
                .query_map(params![cutoff], |row| row.get::<_, String>(0))
                .map_err(index_error)?;
            rows.filter_map(Result::ok).collect::<Vec<_>>()
        };
        let mut removed = 0;
        for key in stale {
            delete_workspace_tx(&write, &key)?;
            removed += 1;
        }
        Ok(removed)
    }

    fn ready(&self) -> Result<&Ready, AppError> {
        self.inner.ready.as_ref().ok_or_else(|| {
            AppError::new(AppErrorCode::IndexDisabled, "search index is unavailable")
        })
    }

    fn set_status(&self, root: &Path, status: SearchStatus) {
        if let Ok(mut map) = self.inner.status.lock() {
            map.insert(root.to_path_buf(), status);
        }
    }

    fn ensure_workspace(&self, ready: &Ready, root: &Path, key: &str) -> Result<(), AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        write
            .execute(
                "INSERT INTO workspaces(key, root, last_seen_ms) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET root=excluded.root, last_seen_ms=excluded.last_seen_ms",
                params![key, root.to_string_lossy(), now_ms()],
            )
            .map_err(index_error)?;
        Ok(())
    }

    fn is_fresh(
        &self,
        ready: &Ready,
        workspace_key: &str,
        relative: &str,
        mtime: i64,
        size: u64,
    ) -> Result<bool, AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        let existing = write
            .query_row(
                "SELECT mtime_ms, size_bytes FROM documents WHERE workspace_key = ?1 AND path = ?2",
                params![workspace_key, relative],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, u64>(1)?)),
            )
            .optional()
            .map_err(index_error)?;
        Ok(existing == Some((mtime, size)))
    }

    fn upsert_prepared(
        &self,
        ready: &Ready,
        workspace_key: &str,
        prepared: &PreparedUpsert,
    ) -> Result<(), AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        write
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(index_error)?;
        let result = (|| -> Result<(), AppError> {
            insert_prepared_tx(&write, workspace_key, prepared)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                write.execute_batch("COMMIT").map_err(index_error)?;
                if !prepared.short_ok {
                    self.inner.truncated.store(true, Ordering::SeqCst);
                }
                Ok(())
            }
            Err(error) => {
                let _ = write.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn remove_stale(
        &self,
        ready: &Ready,
        workspace_key: &str,
        seen: &HashSet<String>,
    ) -> Result<(), AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        let existing = {
            let mut statement = write
                .prepare("SELECT path FROM documents WHERE workspace_key = ?1")
                .map_err(index_error)?;
            let rows = statement
                .query_map(params![workspace_key], |row| row.get::<_, String>(0))
                .map_err(index_error)?;
            rows.filter_map(Result::ok).collect::<Vec<_>>()
        };
        for path in existing {
            if !seen.contains(&path) {
                delete_document_tx(&write, workspace_key, &path)?;
            }
        }
        Ok(())
    }

    fn optimize(&self, ready: &Ready) -> Result<(), AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        write
            .execute_batch(
                "INSERT INTO documents_fts(documents_fts) VALUES('optimize');
                 INSERT INTO documents_fts_short(documents_fts_short) VALUES('optimize');",
            )
            .map_err(index_error)?;
        Ok(())
    }

    /// Reclaims pages left by FTS segment merges and deletes.
    ///
    /// A full scan can leave several MiB free; `VACUUM` keeps the index near
    /// its corpus-proportional size. It runs only when enough pages are free,
    /// so ordinary incremental scans stay cheap.
    fn compact(&self, ready: &Ready) -> Result<(), AppError> {
        let write = ready
            .write
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::IndexDisabled, "index lock poisoned"))?;
        let free: i64 = write
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .map_err(index_error)?;
        if free < 256 {
            return Ok(());
        }
        write.execute_batch("VACUUM").map_err(index_error)?;
        write
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(index_error)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameResult {
    pub renamed: bool,
    pub requires_rescan: bool,
}

#[derive(Debug, Clone)]
struct PreparedUpsert {
    relative: String,
    abs_path: String,
    title: String,
    body: String,
    terms: String,
    short_ok: bool,
    mtime: i64,
    size: u64,
    hash: String,
}

fn relative_key(root: &Path, path: &Path) -> Result<String, AppError> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::new(AppErrorCode::OutsideScope, "path is outside workspace"))
}

/// Reads and validates one indexable file before the database transaction.
fn prepare_upsert(root: &Path, path: &Path) -> Option<PreparedUpsert> {
    let relative = path.strip_prefix(root).ok()?;
    if is_ignored_relative_path(relative) || !is_markdown(path) {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > INDEX_MAX_FILE_BYTES {
        return None;
    }
    if let Ok(link_metadata) = fs::symlink_metadata(path) {
        if link_metadata.file_type().is_symlink() {
            let target = fs::canonicalize(path).ok()?;
            if !target.starts_with(root) {
                return None;
            }
        }
    }
    let bytes = fs::read(path).ok()?;
    let decoded = crate::services::encoding::decode(&bytes).ok()?;
    if decoded.mixed_eol {
        return None;
    }
    let title = title_from_body(
        &decoded.text,
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Untitled"),
    );
    let terms = search_query::short_terms(&decoded.text);
    let short_ok = terms.len() <= INDEX_SHORT_TERMS_MAX_BYTES;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Some(PreparedUpsert {
        relative: relative.to_string_lossy().replace('\\', "/"),
        abs_path: path.to_string_lossy().into_owned(),
        title,
        body: decoded.text,
        terms,
        short_ok,
        mtime,
        size: metadata.len(),
        hash: blake3::hash(&bytes).to_hex().to_string(),
    })
}

fn insert_prepared_tx(
    write: &Connection,
    workspace_key: &str,
    prepared: &PreparedUpsert,
) -> Result<(), AppError> {
    let id: i64 = write
        .query_row(
            "INSERT INTO documents(workspace_key, path, abs_path, title, mtime_ms, size_bytes, hash, indexed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(workspace_key, path) DO UPDATE SET
               abs_path=excluded.abs_path, title=excluded.title, mtime_ms=excluded.mtime_ms,
               size_bytes=excluded.size_bytes, hash=excluded.hash, indexed_at_ms=excluded.indexed_at_ms
             RETURNING id",
            params![
                workspace_key,
                prepared.relative,
                prepared.abs_path,
                prepared.title,
                prepared.mtime,
                prepared.size,
                prepared.hash,
                now_ms()
            ],
            |row| row.get(0),
        )
        .map_err(index_error)?;
    write
        .execute("DELETE FROM documents_fts WHERE rowid = ?1", params![id])
        .map_err(index_error)?;
    write
        .execute(
            "DELETE FROM documents_fts_short WHERE rowid = ?1",
            params![id],
        )
        .map_err(index_error)?;
    write
        .execute(
            "INSERT INTO documents_fts(rowid, title, body) VALUES (?1, ?2, ?3)",
            params![id, prepared.title, prepared.body],
        )
        .map_err(index_error)?;
    if prepared.short_ok {
        write
            .execute(
                "INSERT INTO documents_fts_short(rowid, terms) VALUES (?1, ?2)",
                params![id, prepared.terms],
            )
            .map_err(index_error)?;
    }
    Ok(())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Deletes the exact row and all rows below a prefix without opening a
/// transaction; callers own BEGIN/COMMIT/ROLLBACK.
fn delete_path_or_prefix_tx(
    write: &Connection,
    workspace_key: &str,
    relative: &str,
) -> Result<(), AppError> {
    let ids: Vec<i64> = {
        let pattern = format!("{}/%", escape_like(relative));
        let mut statement = write
            .prepare(
                "SELECT id FROM documents
                 WHERE workspace_key = ?1 AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')",
            )
            .map_err(index_error)?;
        let rows = statement
            .query_map(params![workspace_key, relative, pattern], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(index_error)?;
        rows.filter_map(Result::ok).collect()
    };
    for id in ids {
        delete_row_tx(write, id)?;
    }
    Ok(())
}

fn delete_row_tx(write: &Connection, id: i64) -> Result<(), AppError> {
    write
        .execute("DELETE FROM documents_fts WHERE rowid = ?1", params![id])
        .map_err(index_error)?;
    write
        .execute(
            "DELETE FROM documents_fts_short WHERE rowid = ?1",
            params![id],
        )
        .map_err(index_error)?;
    write
        .execute("DELETE FROM documents WHERE id = ?1", params![id])
        .map_err(index_error)?;
    Ok(())
}

fn delete_document_tx(
    write: &Connection,
    workspace_key: &str,
    relative: &str,
) -> Result<(), AppError> {
    write
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(index_error)?;
    let result = (|| -> Result<(), AppError> {
        let id = write
            .query_row(
                "SELECT id FROM documents WHERE workspace_key = ?1 AND path = ?2",
                params![workspace_key, relative],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(index_error)?;
        if let Some(id) = id {
            write
                .execute("DELETE FROM documents_fts WHERE rowid = ?1", params![id])
                .map_err(index_error)?;
            write
                .execute(
                    "DELETE FROM documents_fts_short WHERE rowid = ?1",
                    params![id],
                )
                .map_err(index_error)?;
            write
                .execute("DELETE FROM documents WHERE id = ?1", params![id])
                .map_err(index_error)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => write.execute_batch("COMMIT").map_err(index_error),
        Err(error) => {
            let _ = write.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn delete_workspace_tx(write: &Connection, workspace_key: &str) -> Result<(), AppError> {
    write
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(index_error)?;
    let result = (|| -> Result<(), AppError> {
        let ids = {
            let mut statement = write
                .prepare("SELECT id FROM documents WHERE workspace_key = ?1")
                .map_err(index_error)?;
            let rows = statement
                .query_map(params![workspace_key], |row| row.get::<_, i64>(0))
                .map_err(index_error)?;
            rows.filter_map(Result::ok).collect::<Vec<_>>()
        };
        for id in ids {
            write
                .execute("DELETE FROM documents_fts WHERE rowid = ?1", params![id])
                .map_err(index_error)?;
            write
                .execute(
                    "DELETE FROM documents_fts_short WHERE rowid = ?1",
                    params![id],
                )
                .map_err(index_error)?;
        }
        write
            .execute(
                "DELETE FROM documents WHERE workspace_key = ?1",
                params![workspace_key],
            )
            .map_err(index_error)?;
        write
            .execute(
                "DELETE FROM workspaces WHERE key = ?1",
                params![workspace_key],
            )
            .map_err(index_error)?;
        Ok(())
    })();
    match result {
        Ok(()) => write.execute_batch("COMMIT").map_err(index_error),
        Err(error) => {
            let _ = write.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

struct TableMatches {
    table: TermTable,
    ids: HashMap<i64, i64>,
    scores: HashMap<i64, f64>,
}

fn table_sql_name(table: TermTable) -> &'static str {
    match table {
        TermTable::Trigram => "documents_fts",
        TermTable::Short => "documents_fts_short",
    }
}

fn combine_expressions(terms: &[search_query::QueryTerm], table: TermTable) -> Option<String> {
    let expressions = terms
        .iter()
        .filter(|term| term.table == table)
        .map(|term| term.expression.clone())
        .collect::<Vec<_>>();
    if expressions.is_empty() {
        None
    } else {
        Some(expressions.join(" AND "))
    }
}

fn include_expression(table: TermTable, parsed: &search_query::ParsedQuery) -> Option<String> {
    let include = combine_expressions(&parsed.include, table)?;
    Some(match combine_expressions(&parsed.exclude, table) {
        Some(exclude) => format!("({include}) NOT ({exclude})"),
        None => include,
    })
}

fn query_document_ids(
    read: &Connection,
    table: TermTable,
    expression: &str,
    workspace_key: &str,
) -> Result<HashMap<i64, i64>, AppError> {
    let name = table_sql_name(table);
    let sql = format!(
        "SELECT {name}.rowid, d.mtime_ms FROM {name} \
         JOIN documents d ON d.id = {name}.rowid \
         WHERE {name} MATCH ?1 AND d.workspace_key = ?2"
    );
    let mut statement = read.prepare(&sql).map_err(query_error)?;
    let mut rows = statement
        .query(params![expression, workspace_key])
        .map_err(query_error)?;
    let mut ids = HashMap::new();
    while let Some(row) = rows.next().map_err(query_error)? {
        ids.insert(
            row.get(0).map_err(query_error)?,
            row.get(1).map_err(query_error)?,
        );
    }
    Ok(ids)
}

fn query_scores(
    read: &Connection,
    table: TermTable,
    expression: &str,
    workspace_key: &str,
) -> Result<HashMap<i64, f64>, AppError> {
    let name = table_sql_name(table);
    let score = match table {
        TermTable::Trigram => "bm25(documents_fts, 10.0, 1.0)",
        TermTable::Short => "bm25(documents_fts_short)",
    };
    let sql = format!(
        "SELECT {name}.rowid, {score} AS score FROM {name} \
         JOIN documents d ON d.id = {name}.rowid \
         WHERE {name} MATCH ?1 AND d.workspace_key = ?2 \
         ORDER BY score ASC"
    );
    let mut statement = read.prepare(&sql).map_err(query_error)?;
    let mut rows = statement
        .query(params![expression, workspace_key])
        .map_err(query_error)?;
    let mut scores = HashMap::new();
    while let Some(row) = rows.next().map_err(query_error)? {
        scores.insert(
            row.get(0).map_err(query_error)?,
            row.get(1).map_err(query_error)?,
        );
    }
    Ok(scores)
}

fn row_id_chunks(ids: &[i64]) -> impl Iterator<Item = (&[i64], String)> {
    ids.chunks(400).map(|chunk| {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        (chunk, placeholders)
    })
}

fn fetch_metadata(
    read: &Connection,
    ids: &[i64],
) -> Result<HashMap<i64, (String, String)>, AppError> {
    let mut metadata = HashMap::new();
    for (chunk, placeholders) in row_id_chunks(ids) {
        let sql = format!("SELECT id, path, title FROM documents WHERE id IN ({placeholders})");
        let mut statement = read.prepare(&sql).map_err(query_error)?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(chunk.iter().copied()))
            .map_err(query_error)?;
        while let Some(row) = rows.next().map_err(query_error)? {
            metadata.insert(
                row.get(0).map_err(query_error)?,
                (
                    row.get(1).map_err(query_error)?,
                    row.get(2).map_err(query_error)?,
                ),
            );
        }
    }
    Ok(metadata)
}

fn fetch_bodies(read: &Connection, ids: &[i64]) -> Result<HashMap<i64, String>, AppError> {
    let mut bodies = HashMap::new();
    for (chunk, placeholders) in row_id_chunks(ids) {
        let sql = format!("SELECT rowid, body FROM documents_fts WHERE rowid IN ({placeholders})");
        let mut statement = read.prepare(&sql).map_err(query_error)?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(chunk.iter().copied()))
            .map_err(query_error)?;
        while let Some(row) = rows.next().map_err(query_error)? {
            bodies.insert(
                row.get(0).map_err(query_error)?,
                row.get(1).map_err(query_error)?,
            );
        }
    }
    Ok(bodies)
}

/// Clears the per-query SQLite progress handler even on early returns.
struct ProgressGuard<'a>(&'a Connection);

impl Drop for ProgressGuard<'_> {
    fn drop(&mut self) {
        self.0.progress_handler(0, None::<fn() -> bool>);
    }
}

fn query_error(error: rusqlite::Error) -> AppError {
    if matches!(
        &error,
        rusqlite::Error::SqliteFailure(inner, _)
            if matches!(
                inner.code,
                rusqlite::ErrorCode::OperationAborted | rusqlite::ErrorCode::OperationInterrupted
            )
    ) {
        return AppError::new(AppErrorCode::SearchTimeout, "search timed out")
            .with_details(serde_json::json!({ "timeoutMs": INDEX_QUERY_TIMEOUT_MS }));
    }
    index_error(error)
}

fn open_connection(path: &Path, writer: bool) -> Result<Connection, AppError> {
    let connection = Connection::open(path).map_err(index_error)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(index_error)?;
    if writer {
        connection
            .execute_batch("PRAGMA wal_autocheckpoint = 1000")
            .map_err(index_error)?;
    }
    Ok(connection)
}

fn initialize(connection: &Connection) -> Result<(), AppError> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(index_error)?;
    if version > INDEX_SCHEMA_VERSION {
        return Err(AppError::new(
            AppErrorCode::IndexDisabled,
            "search index schema is newer than this app",
        ));
    }
    if version < INDEX_SCHEMA_VERSION {
        // The index is a cache. Dropping it forces a clean rebuild rather
        // than leaving rows that use the previous tokenization.
        connection
            .execute_batch(
                "DROP TABLE IF EXISTS documents_fts;
                 DROP TABLE IF EXISTS documents_fts_short;
                 DROP TABLE IF EXISTS documents;
                 DROP TABLE IF EXISTS workspaces;",
            )
            .map_err(index_error)?;
    }
    let check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(index_error)?;
    if !check.eq_ignore_ascii_case("ok") {
        return Err(AppError::new(
            AppErrorCode::IndexDisabled,
            "search index failed quick_check",
        ));
    }
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS index_meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS workspaces (
               key TEXT PRIMARY KEY,
               root TEXT NOT NULL,
               last_seen_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS documents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               workspace_key TEXT NOT NULL REFERENCES workspaces(key) ON DELETE CASCADE,
               path TEXT NOT NULL,
               abs_path TEXT NOT NULL,
               title TEXT NOT NULL,
               mtime_ms INTEGER NOT NULL,
               size_bytes INTEGER NOT NULL,
               hash TEXT NOT NULL,
               indexed_at_ms INTEGER NOT NULL,
               UNIQUE(workspace_key, path)
             );
             CREATE INDEX IF NOT EXISTS documents_workspace_idx ON documents(workspace_key);
             CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
               title,
               body,
               tokenize = 'trigram'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts_short USING fts5(
               terms,
               tokenize = 'unicode61',
               content = '',
               contentless_delete = 1
             );
             PRAGMA user_version = {INDEX_SCHEMA_VERSION};"
        ))
        .map_err(index_error)?;
    // Orphan FTS rows can survive an interrupted delete on old databases.
    let _ = connection.execute_batch(
        "DELETE FROM documents_fts WHERE rowid NOT IN (SELECT id FROM documents);
         DELETE FROM documents_fts_short WHERE rowid NOT IN (SELECT id FROM documents);",
    );
    Ok(())
}

fn walk(
    root: &Path,
    files: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
    truncated: &mut bool,
    depth: usize,
) -> Result<(), AppError> {
    if depth > 64 {
        *truncated = true;
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        if is_ignored_relative_path(relative) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            // Never expand a symlink directory (Q-004). An inside file link is
            // indexed by its link path so the visible name stays searchable.
            let Ok(target) = fs::canonicalize(&path) else {
                continue;
            };
            if target.starts_with(root) && target.is_file() && is_markdown(&path) {
                let Ok(target_meta) = fs::metadata(&target) else {
                    continue;
                };
                if target_meta.len() > INDEX_MAX_FILE_BYTES {
                    continue;
                }
                if !push_file(files, total_bytes, path, target_meta.len(), truncated) {
                    return Ok(());
                }
            }
            continue;
        }
        if file_type.is_dir() {
            walk(&path, files, total_bytes, truncated, depth + 1)?;
        } else if file_type.is_file() && is_markdown(&path) {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let size = metadata.len();
            if size > INDEX_MAX_FILE_BYTES {
                *truncated = true;
                continue;
            }
            if !push_file(files, total_bytes, path, size, truncated) {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Reserves room for one file. Exactly `INDEX_MAX_FILES`/the byte cap is not
/// truncation: only a file that would exceed the cap is dropped.
fn push_file(
    files: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
    path: PathBuf,
    size: u64,
    truncated: &mut bool,
) -> bool {
    if files.len() >= INDEX_MAX_FILES || *total_bytes + size > INDEX_MAX_BODY_BYTES {
        *truncated = true;
        return false;
    }
    *total_bytes += size;
    files.push(path);
    true
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md")
                || extension.eq_ignore_ascii_case("markdown")
                || extension.eq_ignore_ascii_case("mdx")
        })
}

pub fn workspace_key(root: &Path) -> String {
    let key = blake3::hash(root.to_string_lossy().as_bytes())
        .to_hex()
        .to_string();
    key[..32].to_string()
}

fn index_error(error: rusqlite::Error) -> AppError {
    AppError::new(AppErrorCode::IndexDisabled, error.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn backup_corrupt(path: &Path) {
    let backup = path.with_extension(format!("corrupt-{}", now_ms()));
    if fs::rename(path, backup).is_ok() {
        // A renamed database must not inherit the old WAL/SHM sidecars.
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}

fn private_dir(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| AppError::from_io(&error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root(dir: &TempDir) -> PathBuf {
        fs::canonicalize(dir.path()).expect("canonical")
    }

    #[test]
    fn scans_and_searches_cjk_and_latin() {
        let dir = TempDir::new().expect("temp dir");
        let root = root(&dir);
        fs::write(root.join("a.md"), "# 中文标题\n\n正文 hello world\n").expect("fixture");
        fs::write(root.join("b.md"), "# Other\n\nunrelated\n").expect("fixture");
        let index = SearchIndexService::open(dir.path().join("index")).expect("index");

        index.scan_root(&root).expect("scan");
        let response = index.search(&root, "中文", 10, 0).expect("search");
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].title, "中文标题");
        let response = index.search(&root, "hello", 10, 0).expect("search");
        assert_eq!(response.results.len(), 1);
    }

    #[test]
    fn excludes_and_workspace_isolation() {
        let first = TempDir::new().expect("first");
        let second = TempDir::new().expect("second");
        let first_root = root(&first);
        let second_root = root(&second);
        fs::write(first_root.join("a.md"), "# A\n\nalpha beta\n").expect("fixture");
        fs::write(second_root.join("b.md"), "# B\n\nalpha gamma\n").expect("fixture");
        let index = SearchIndexService::open(first.path().join("index")).expect("index");
        index.scan_root(&first_root).expect("scan");
        index.scan_root(&second_root).expect("scan");

        let response = index
            .search(&first_root, "alpha -beta", 10, 0)
            .expect("search");
        assert!(response.results.is_empty());
        let response = index.search(&first_root, "alpha", 10, 0).expect("search");
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].path, "a.md");
    }

    #[test]
    fn an_interrupted_query_maps_to_search_timeout() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection.progress_handler(1, Some(|| true));
        let error = connection
            .query_row(
                "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000)
                 SELECT count(*) FROM n",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(query_error)
            .expect_err("the progress handler must abort the query");
        assert_eq!(error.code, AppErrorCode::SearchTimeout);
        let details = error.details.expect("timeout details");
        assert_eq!(details["timeoutMs"], INDEX_QUERY_TIMEOUT_MS);
    }

    #[test]
    fn rebuild_removes_stale_rows() {
        let dir = TempDir::new().expect("temp dir");
        let root = root(&dir);
        let file = root.join("a.md");
        fs::write(&file, "# A\n\nalpha\n").expect("fixture");
        let index = SearchIndexService::open(dir.path().join("index")).expect("index");
        index.scan_root(&root).expect("scan");
        fs::remove_file(&file).expect("remove");
        index.rebuild(&root).expect("rebuild");
        assert!(index
            .search(&root, "alpha", 10, 0)
            .expect("search")
            .results
            .is_empty());
    }
}
