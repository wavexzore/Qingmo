//! Bounded raw-byte snapshot history for saved documents.
//!
//! Snapshots are captured from the same bytes `AtomicWriter` already read for
//! conflict detection. The store keeps the original encoding/BOM/EOL so a
//! restore is byte-faithful, and never blocks a save: callers treat every
//! error as a warning.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{HistoryEntry, HistoryRecord, TextFormat};
use crate::services::document_identity::{DocumentId, DocumentIdentityStore};
use crate::services::encoding;
use crate::services::file_service::MAX_DOCUMENT_BYTES;

pub const HISTORY_SCHEMA_VERSION: u32 = 1;
pub const HISTORY_MERGE_MS: i64 = 10_000;
pub const HISTORY_MAX_ENTRIES_PER_DOC: usize = 50;
pub const HISTORY_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const HISTORY_MAX_BYTES_PER_DOC: u64 = 64 * 1024 * 1024;
pub const HISTORY_MAX_BYTES_TOTAL: u64 = 512 * 1024 * 1024;

const STAGING_PREFIX: &str = ".staging-";
const MIGRATION_FILE: &str = "migration.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationMarker {
    schema_version: u32,
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    id: String,
    hash: String,
    size: u64,
    created_at_ms: i64,
    last_seen_at_ms: i64,
    app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntriesFile {
    schema_version: u32,
    path: String,
    entries: Vec<StoredEntry>,
}

impl EntriesFile {
    fn new(path: &Path) -> Self {
        Self {
            schema_version: HISTORY_SCHEMA_VERSION,
            path: path.to_string_lossy().to_string(),
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct HistoryGcReport {
    pub entries_removed: usize,
    pub staging_removed: usize,
    pub corrupt_removed: usize,
}

struct Inner {
    root: PathBuf,
    ready: bool,
    state: Mutex<()>,
    identity: Mutex<Option<DocumentIdentityStore>>,
}

/// Shared handle; cloning is cheap and safe across blocking tasks.
#[derive(Clone)]
pub struct HistoryStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for HistoryStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HistoryStore")
            .field("root", &self.inner.root)
            .field("ready", &self.inner.ready)
            .finish()
    }
}

impl HistoryStore {
    pub fn open(root: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&root).map_err(|error| AppError::from_io(&error))?;
        private_dir(&root)?;
        Ok(Self {
            inner: Arc::new(Inner {
                root,
                ready: true,
                state: Mutex::new(()),
                identity: Mutex::new(None),
            }),
        })
    }

    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(Inner {
                root: PathBuf::new(),
                ready: false,
                state: Mutex::new(()),
                identity: Mutex::new(None),
            }),
        }
    }

    /// Installs the identity store used for `DocumentId` buckets and legacy
    /// path migration. History remains usable without it (legacy path hash).
    pub fn configure_identity(&self, identity: Option<DocumentIdentityStore>) {
        if let Ok(mut guard) = self.inner.identity.lock() {
            *guard = identity;
        }
    }

    pub fn is_ready(&self) -> bool {
        self.inner.ready
    }

    /// Captures the pre-save bytes into the legacy path-hash bucket.
    ///
    /// `force_new` is used by Restore: the current version must get its own
    /// entry even when it falls inside the normal 10s merge window.
    pub fn capture(
        &self,
        path: &Path,
        bytes: &[u8],
        hash: &str,
        force_new: bool,
    ) -> Result<Option<HistoryEntry>, AppError> {
        self.capture_for(None, path, bytes, hash, force_new)
    }

    /// Captures into a stable `DocumentId` bucket, migrating the legacy path
    /// buckets first. `None` keeps the legacy path-hash behavior.
    pub fn capture_for(
        &self,
        document_id: Option<&DocumentId>,
        path: &Path,
        bytes: &[u8],
        hash: &str,
        force_new: bool,
    ) -> Result<Option<HistoryEntry>, AppError> {
        if !self.inner.ready {
            return Ok(None);
        }
        let _state = self.lock()?;
        if let Some(id) = document_id {
            self.ensure_migrated(id, path)?;
        }
        self.capture_in(document_id, path, bytes, hash, force_new)
    }

    fn capture_in(
        &self,
        document_id: Option<&DocumentId>,
        path: &Path,
        bytes: &[u8],
        hash: &str,
        force_new: bool,
    ) -> Result<Option<HistoryEntry>, AppError> {
        let now = now_ms();
        let doc_dir = self.doc_dir(path, document_id);
        fs::create_dir_all(&doc_dir).map_err(|error| AppError::from_io(&error))?;
        private_dir(&doc_dir)?;

        let mut entries = self.load_entries(&doc_dir, path);
        if let Some(newest) = entries.entries.first_mut() {
            if newest.hash == hash {
                return Ok(None);
            }
            if !force_new && now.saturating_sub(newest.created_at_ms) <= HISTORY_MERGE_MS {
                newest.last_seen_at_ms = now;
                self.save_entries(&doc_dir, &entries)?;
                return Ok(None);
            }
        }

        let id = format!("{now}-{}", &hash[..hash.len().min(8)]);
        let file_name = format!("{id}.bin");
        let target = doc_dir.join(&file_name);
        let staging = doc_dir.join(format!("{STAGING_PREFIX}{}.bin", uuid::Uuid::new_v4()));
        write_private_atomic(&staging, bytes)?;
        fs::rename(&staging, &target).map_err(|error| AppError::from_io(&error))?;

        let entry = StoredEntry {
            id: id.clone(),
            hash: hash.to_string(),
            size: bytes.len() as u64,
            created_at_ms: now,
            last_seen_at_ms: now,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        entries.entries.insert(0, entry.clone());
        prune_doc(&mut entries);
        self.save_entries(&doc_dir, &entries)?;
        self.prune_global(&doc_dir);
        Ok(Some(HistoryEntry {
            id,
            hash: entry.hash,
            size_bytes: entry.size,
            created_at_ms: entry.created_at_ms,
            app_version: entry.app_version,
        }))
    }

    pub fn list(&self, path: &Path, limit: usize, offset: usize) -> Vec<HistoryEntry> {
        self.list_for(None, path, limit, offset)
    }

    pub fn list_for(
        &self,
        document_id: Option<&DocumentId>,
        path: &Path,
        limit: usize,
        offset: usize,
    ) -> Vec<HistoryEntry> {
        if !self.inner.ready {
            return Vec::new();
        }
        let Ok(_state) = self.lock() else {
            return Vec::new();
        };
        if let Some(id) = document_id {
            let _ = self.ensure_migrated(id, path);
        }
        let doc_dir = self.doc_dir(path, document_id);
        let mut entries = self.load_entries(&doc_dir, path);
        entries.entries.retain(|entry| {
            doc_dir.join(format!("{}.bin", entry.id)).is_file()
                && now_ms().saturating_sub(entry.created_at_ms) <= HISTORY_TTL_MS
        });
        entries
            .entries
            .into_iter()
            .skip(offset)
            .take(limit.min(HISTORY_MAX_ENTRIES_PER_DOC))
            .map(|entry| HistoryEntry {
                id: entry.id,
                hash: entry.hash,
                size_bytes: entry.size,
                created_at_ms: entry.created_at_ms,
                app_version: entry.app_version,
            })
            .collect()
    }

    pub fn read(&self, path: &Path, entry_id: &str) -> Result<HistoryRecord, AppError> {
        self.read_for(None, path, entry_id)
    }

    pub fn read_for(
        &self,
        document_id: Option<&DocumentId>,
        path: &Path,
        entry_id: &str,
    ) -> Result<HistoryRecord, AppError> {
        if !self.inner.ready {
            return Err(disabled_error());
        }
        validate_entry_id(entry_id)?;
        let _state = self.lock()?;
        if let Some(id) = document_id {
            self.ensure_migrated(id, path)?;
        }
        let doc_dir = self.doc_dir(path, document_id);
        let entries = self.load_entries(&doc_dir, path);
        let entry = entries
            .entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "history entry not found"))?;
        let bytes = read_entry_bytes(&doc_dir, entry)?;
        let decoded = encoding::decode(&bytes)?;
        Ok(HistoryRecord {
            id: entry.id.clone(),
            text: decoded.text,
            format: decoded.format,
            hash: entry.hash.clone(),
            created_at_ms: entry.created_at_ms,
        })
    }

    /// Reads the raw snapshot for Restore; the caller writes it through the
    /// normal AtomicWriter path and updates the document format.
    pub fn read_raw(&self, path: &Path, entry_id: &str) -> Result<(Vec<u8>, TextFormat), AppError> {
        self.read_raw_for(None, path, entry_id)
    }

    pub fn read_raw_for(
        &self,
        document_id: Option<&DocumentId>,
        path: &Path,
        entry_id: &str,
    ) -> Result<(Vec<u8>, TextFormat), AppError> {
        if !self.inner.ready {
            return Err(disabled_error());
        }
        validate_entry_id(entry_id)?;
        let _state = self.lock()?;
        if let Some(id) = document_id {
            self.ensure_migrated(id, path)?;
        }
        let doc_dir = self.doc_dir(path, document_id);
        let entries = self.load_entries(&doc_dir, path);
        let entry = entries
            .entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "history entry not found"))?;
        let bytes = read_entry_bytes(&doc_dir, entry)?;
        let decoded = encoding::decode(&bytes)?;
        Ok((bytes, decoded.format))
    }

    pub fn gc(&self) -> HistoryGcReport {
        if !self.inner.ready {
            return HistoryGcReport::default();
        }
        let Ok(_state) = self.lock() else {
            return HistoryGcReport::default();
        };
        let mut report = HistoryGcReport::default();
        let Ok(dirs) = fs::read_dir(&self.inner.root) else {
            return report;
        };
        let now = now_ms();
        for dir in dirs.flatten() {
            let path = dir.path();
            if !path.is_dir() || migration_pending(&path) {
                continue;
            }
            let mut entries = self.load_entries(&path, &path);
            let before = entries.entries.len();
            entries.entries.retain(|entry| {
                now.saturating_sub(entry.created_at_ms) <= HISTORY_TTL_MS
                    && path.join(format!("{}.bin", entry.id)).is_file()
            });
            prune_doc(&mut entries);
            report.entries_removed += before.saturating_sub(entries.entries.len());
            let kept = entries
                .entries
                .iter()
                .map(|entry| entry.id.clone())
                .collect::<std::collections::HashSet<_>>();
            if let Ok(files) = fs::read_dir(&path) {
                for file in files.flatten() {
                    let file_name = file.file_name();
                    let Some(name) = file_name.to_str() else {
                        continue;
                    };
                    if name.starts_with(STAGING_PREFIX) {
                        if fs::remove_file(file.path()).is_ok() {
                            report.staging_removed += 1;
                        }
                    } else if let Some(stem) = name.strip_suffix(".bin") {
                        // Entries pruned above, and crash-orphaned payloads,
                        // must not accumulate forever.
                        if !kept.contains(stem) && fs::remove_file(file.path()).is_ok() {
                            report.entries_removed += 1;
                        }
                    }
                }
            }
            let _ = self.save_entries(&path, &entries);
        }
        self.prune_global_root();
        report
    }

    fn doc_dir(&self, path: &Path, document_id: Option<&DocumentId>) -> PathBuf {
        match document_id {
            Some(id) => self.inner.root.join(id.to_string()),
            None => self.legacy_dir(path),
        }
    }

    fn legacy_dir(&self, path: &Path) -> PathBuf {
        let key = blake3::hash(path.to_string_lossy().as_bytes())
            .to_hex()
            .to_string();
        self.inner.root.join(&key[..32])
    }

    /// Copies/merges the legacy path buckets into the stable id bucket once.
    /// The marker is written `pending` before any merge and `done` only after
    /// every alias has been processed, so a crash retries instead of silently
    /// losing entries.
    fn ensure_migrated(&self, id: &DocumentId, path: &Path) -> Result<(), AppError> {
        let target = self.inner.root.join(id.to_string());
        fs::create_dir_all(&target).map_err(|error| AppError::from_io(&error))?;
        private_dir(&target)?;
        if migration_done(&target) {
            return Ok(());
        }
        write_migration(&target, "pending")?;

        let mut aliases = vec![path.to_path_buf()];
        if let Ok(guard) = self.inner.identity.lock() {
            if let Some(identity) = guard.as_ref() {
                aliases.extend(identity.legacy_paths(id));
            }
        }
        aliases.sort_by(|left, right| left.as_os_str().cmp(right.as_os_str()));
        aliases.dedup_by(|left, right| left == right);

        let mut entries = self.load_entries(&target, path);
        for alias in aliases {
            let source = self.legacy_dir(&alias);
            if source == target || !source.is_dir() {
                continue;
            }
            let source_entries = self.load_entries(&source, &alias);
            for entry in source_entries.entries {
                if entries
                    .entries
                    .iter()
                    .any(|candidate| candidate.id == entry.id)
                {
                    continue;
                }
                let source_file = source.join(format!("{}.bin", entry.id));
                let target_file = target.join(format!("{}.bin", entry.id));
                if !source_file.is_file() || target_file.exists() {
                    continue;
                }
                fs::copy(&source_file, &target_file).map_err(|error| AppError::from_io(&error))?;
                entries.entries.push(entry);
            }
        }
        entries.entries.sort_by(|left, right| {
            right
                .created_at_ms
                .cmp(&left.created_at_ms)
                .then_with(|| right.last_seen_at_ms.cmp(&left.last_seen_at_ms))
        });
        entries.path = path.to_string_lossy().into_owned();
        self.save_entries(&target, &entries)?;
        write_migration(&target, "done")?;
        Ok(())
    }

    fn load_entries(&self, dir: &Path, path: &Path) -> EntriesFile {
        let file = dir.join("entries.json");
        let Ok(bytes) = fs::read(&file) else {
            return EntriesFile::new(path);
        };
        let parsed = serde_json::from_slice::<EntriesFile>(&bytes)
            .ok()
            .filter(|entries| entries.schema_version == HISTORY_SCHEMA_VERSION);
        parsed.unwrap_or_else(|| {
            let _ = backup_corrupt(&file);
            EntriesFile::new(path)
        })
    }

    fn save_entries(&self, dir: &Path, entries: &EntriesFile) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(entries)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        write_private_atomic(&dir.join("entries.json"), &bytes)
    }

    fn prune_global(&self, current_doc: &Path) {
        let mut total = 0u64;
        let mut docs = Vec::new();
        let Ok(dirs) = fs::read_dir(&self.inner.root) else {
            return;
        };
        for dir in dirs.flatten() {
            let path = dir.path();
            if !path.is_dir() || !path.join("entries.json").is_file() || migration_pending(&path) {
                continue;
            }
            let entries = self.load_entries(&path, &path);
            let bytes = entries.entries.iter().map(|entry| entry.size).sum::<u64>();
            total = total.saturating_add(bytes);
            if path != current_doc {
                docs.push((path, entries, bytes));
            }
        }
        if total <= HISTORY_MAX_BYTES_TOTAL {
            return;
        }
        for (path, mut entries, bytes) in docs {
            if total <= HISTORY_MAX_BYTES_TOTAL {
                break;
            }
            let before = entries.entries.len();
            while total > HISTORY_MAX_BYTES_TOTAL {
                let Some(removed) = entries.entries.pop() else {
                    break;
                };
                total = total.saturating_sub(removed.size);
                let _ = fs::remove_file(path.join(format!("{}.bin", removed.id)));
            }
            if entries.entries.len() != before {
                let _ = self.save_entries(&path, &entries);
                let _ = bytes;
            }
        }
    }

    fn prune_global_root(&self) {
        self.prune_global(Path::new(""));
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, AppError> {
        self.inner
            .state
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "history store lock poisoned"))
    }
}

fn prune_doc(entries: &mut EntriesFile) {
    let now = now_ms();
    entries
        .entries
        .retain(|entry| now.saturating_sub(entry.created_at_ms) <= HISTORY_TTL_MS);
    while entries.entries.len() > HISTORY_MAX_ENTRIES_PER_DOC {
        entries.entries.pop();
    }
    let mut total = 0u64;
    entries.entries.retain(|entry| {
        if total.saturating_add(entry.size) > HISTORY_MAX_BYTES_PER_DOC {
            return false;
        }
        total = total.saturating_add(entry.size);
        true
    });
}

fn validate_entry_id(id: &str) -> Result<(), AppError> {
    let Some((timestamp, hash)) = id.split_once('-') else {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "invalid history entry id",
        ));
    };
    if timestamp.len() < 13 || !timestamp.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "invalid history entry id",
        ));
    }
    if hash.len() != 8 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "invalid history entry id",
        ));
    }
    Ok(())
}

fn read_entry_bytes(dir: &Path, entry: &StoredEntry) -> Result<Vec<u8>, AppError> {
    if entry.size > MAX_DOCUMENT_BYTES {
        return Err(AppError::new(
            AppErrorCode::FileTooLarge,
            "history entry exceeds the document limit",
        ));
    }
    let file = dir.join(format!("{}.bin", entry.id));
    let metadata = fs::symlink_metadata(&file).map_err(|error| AppError::from_io(&error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "history entry is not a regular file",
        ));
    }
    if metadata.len() != entry.size {
        return Err(AppError::new(
            AppErrorCode::Io,
            "history entry is incomplete",
        ));
    }
    let bytes = fs::read(&file).map_err(|error| AppError::from_io(&error))?;
    let hash = blake3::hash(&bytes).to_hex().to_string();
    if hash != entry.hash {
        return Err(AppError::new(
            AppErrorCode::Io,
            "history entry failed its hash check",
        ));
    }
    Ok(bytes)
}

fn migration_done(dir: &Path) -> bool {
    let Ok(bytes) = fs::read(dir.join(MIGRATION_FILE)) else {
        return false;
    };
    serde_json::from_slice::<MigrationMarker>(&bytes)
        .is_ok_and(|marker| marker.status == "done" && marker.schema_version == 1)
}

fn migration_pending(dir: &Path) -> bool {
    let Ok(bytes) = fs::read(dir.join(MIGRATION_FILE)) else {
        return false;
    };
    serde_json::from_slice::<MigrationMarker>(&bytes).is_ok_and(|marker| marker.status == "pending")
}

fn write_migration(dir: &Path, status: &str) -> Result<(), AppError> {
    let marker = MigrationMarker {
        schema_version: 1,
        status: status.to_string(),
    };
    let bytes = serde_json::to_vec(&marker)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
    write_private_atomic(&dir.join(MIGRATION_FILE), &bytes)
}

fn disabled_error() -> AppError {
    AppError::new(AppErrorCode::Io, "history storage is unavailable")
}

fn backup_corrupt(path: &Path) -> std::io::Result<()> {
    let backup = path.with_extension(format!("corrupt-{}", now_ms()));
    let _ = fs::rename(path, backup);
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| AppError::from_io(&error))?;
    file.write_all(bytes)
        .map_err(|error| AppError::from_io(&error))?;
    file.commit().map_err(|error| AppError::from_io(&error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| AppError::from_io(&error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn hash(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    #[test]
    fn captures_raw_bytes_and_lists_newest_first() {
        let dir = TempDir::new().expect("temp dir");
        let store = HistoryStore::open(dir.path().join("history")).expect("store");
        let doc = dir.path().join("note.md");
        std::fs::write(&doc, b"v1\n").expect("fixture");

        let first = store
            .capture(&doc, b"v1\n", &hash(b"v1\n"), true)
            .expect("capture")
            .expect("entry");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = store
            .capture(&doc, b"v2\n", &hash(b"v2\n"), true)
            .expect("capture")
            .expect("entry");
        assert_ne!(first.id, second.id);

        let list = store.list(&doc, 50, 0);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].hash, hash(b"v2\n"));
        let read = store.read(&doc, &second.id).expect("read");
        assert_eq!(read.text, "v2\n");
    }

    #[test]
    fn merges_close_captures_but_force_new_always_adds() {
        let dir = TempDir::new().expect("temp dir");
        let store = HistoryStore::open(dir.path().join("history")).expect("store");
        let doc = dir.path().join("note.md");

        store
            .capture(&doc, b"a\n", &hash(b"a\n"), false)
            .expect("capture");
        store
            .capture(&doc, b"b\n", &hash(b"b\n"), false)
            .expect("capture");
        assert_eq!(store.list(&doc, 50, 0).len(), 1);

        store
            .capture(&doc, b"c\n", &hash(b"c\n"), true)
            .expect("capture");
        assert_eq!(store.list(&doc, 50, 0).len(), 2);
    }

    #[test]
    fn rejects_path_traversal_entry_ids() {
        let dir = TempDir::new().expect("temp dir");
        let store = HistoryStore::open(dir.path().join("history")).expect("store");
        let doc = dir.path().join("note.md");
        assert!(store.read(&doc, "../../etc/passwd").is_err());
    }

    #[test]
    fn preserves_utf16_bytes_for_restore() {
        let dir = TempDir::new().expect("temp dir");
        let store = HistoryStore::open(dir.path().join("history")).expect("store");
        let doc = dir.path().join("note.md");
        let bytes = [0xFF, 0xFE, b'h', 0, b'i', 0];
        let entry = store
            .capture(&doc, &bytes, &hash(&bytes), true)
            .expect("capture")
            .expect("entry");
        let record = store.read(&doc, &entry.id).expect("read");
        assert_eq!(record.text, "hi");
        let (raw, format) = store.read_raw(&doc, &entry.id).expect("raw");
        assert_eq!(raw, bytes);
        assert_eq!(format.encoding, crate::ipc::dto::TextEncoding::Utf16Le);
    }
}
