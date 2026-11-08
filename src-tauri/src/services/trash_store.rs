//! Application-owned trash under `app_local_data_dir/trash/<workspaceKey>/`.
//!
//! A delete is committed only after the payload is complete. Every failure
//! path keeps the only copy in `payload`; a source file is never removed before
//! its replacement has been verified.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{TrashEntry, TrashEntryState, TrashRestoreMode, TrashRestoreResult};
use crate::services::file_lock::FileLockStore;

pub const TRASH_SCHEMA_VERSION: u32 = 1;
pub const TRASH_MAX_ENTRIES: usize = 200;
pub const TRASH_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const TRASH_MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StoredState {
    Pending,
    Active,
    Orphaned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryFile {
    schema_version: u32,
    id: String,
    root: String,
    relative_path: String,
    deleted_at_ms: i64,
    size_bytes: u64,
    hash: String,
    kind: String,
    state: StoredState,
    #[serde(default)]
    last_error: Option<String>,
}

impl EntryFile {
    fn public(&self) -> TrashEntry {
        TrashEntry {
            id: self.id.clone(),
            relative_path: self.relative_path.clone(),
            deleted_at_ms: self.deleted_at_ms,
            size_bytes: self.size_bytes,
            state: match self.state {
                StoredState::Orphaned => TrashEntryState::Orphaned,
                _ => TrashEntryState::Active,
            },
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TrashGcReport {
    pub removed: usize,
    pub recovered: usize,
    pub orphaned: usize,
}

struct Inner {
    root: PathBuf,
    ready: bool,
    state: Mutex<()>,
}

#[derive(Clone)]
pub struct TrashStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for TrashStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TrashStore")
            .field("root", &self.inner.root)
            .field("ready", &self.inner.ready)
            .finish()
    }
}

impl TrashStore {
    pub fn open(root: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&root).map_err(|error| AppError::from_io(&error))?;
        private_dir(&root)?;
        Ok(Self {
            inner: Arc::new(Inner {
                root,
                ready: true,
                state: Mutex::new(()),
            }),
        })
    }

    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(Inner {
                root: PathBuf::new(),
                ready: false,
                state: Mutex::new(()),
            }),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.inner.ready
    }

    /// Moves one file into the trash. `source` must already be canonical and
    /// inside `root`; the command performs that jail check.
    pub fn delete(
        &self,
        root: &Path,
        source: &Path,
        locks: Option<&FileLockStore>,
        is_open: impl Fn(&Path) -> bool,
    ) -> Result<TrashEntry, AppError> {
        if !self.inner.ready {
            return Err(disabled_error());
        }
        let relative = source
            .strip_prefix(root)
            .map_err(|_| {
                AppError::new(AppErrorCode::OutsideScope, "path is outside the workspace")
            })?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.is_empty() {
            return Err(AppError::new(
                AppErrorCode::InvalidPath,
                "workspace root cannot be deleted",
            ));
        }

        let _guard = locks.map(|store| store.acquire(source)).transpose()?;
        if is_open(source) {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the document is open in another window",
            ));
        }

        let metadata = fs::metadata(source).map_err(|error| AppError::from_io(&error))?;
        if !metadata.is_file() {
            return Err(AppError::new(
                AppErrorCode::NotAFile,
                "only files can be moved to trash",
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(source)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|error| AppError::from_io(&error))?;
        let hash = blake3::hash(&bytes).to_hex().to_string();

        let workspace_key = workspace_key(root);
        let entry_id = Uuid::new_v4().to_string();
        let entry_dir = self.inner.root.join(&workspace_key).join(&entry_id);
        fs::create_dir_all(&entry_dir).map_err(|error| AppError::from_io(&error))?;
        private_dir(&entry_dir)?;
        let payload = entry_dir.join("payload");
        let mut entry = EntryFile {
            schema_version: TRASH_SCHEMA_VERSION,
            id: entry_id,
            root: root.to_string_lossy().to_string(),
            relative_path: relative,
            deleted_at_ms: now_ms(),
            size_bytes: metadata.len(),
            hash: hash.clone(),
            kind: "file".to_string(),
            state: StoredState::Pending,
            last_error: None,
        };
        self.write_entry(&entry_dir, &entry)?;

        match fs::rename(source, &payload) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(18) => {
                // EXDEV: copy, verify, fsync, rename into place, then remove
                // the source. An external writer may change the source while
                // we copy, so re-hash before deleting it.
                let staging = entry_dir.join("payload.tmp");
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&staging)
                    .map_err(|error| AppError::from_io(&error))?;
                output
                    .write_all(&bytes)
                    .map_err(|error| AppError::from_io(&error))?;
                output
                    .sync_all()
                    .map_err(|error| AppError::from_io(&error))?;
                drop(output);
                let copied = fs::read(&staging).map_err(|error| AppError::from_io(&error))?;
                if blake3::hash(&copied).to_hex().to_string() != hash {
                    let _ = fs::remove_file(&staging);
                    let _ = fs::remove_dir_all(&entry_dir);
                    return Err(AppError::new(
                        AppErrorCode::Io,
                        "trash copy failed its hash check",
                    ));
                }
                let mut current = Vec::new();
                fs::File::open(source)
                    .and_then(|mut file| file.read_to_end(&mut current))
                    .map_err(|error| AppError::from_io(&error))?;
                if blake3::hash(&current).to_hex().to_string() != hash {
                    let _ = fs::remove_file(&staging);
                    let _ = fs::remove_dir_all(&entry_dir);
                    return Err(AppError::new(
                        AppErrorCode::Busy,
                        "the source changed while it was copied to trash",
                    ));
                }
                fs::rename(&staging, &payload).map_err(|error| AppError::from_io(&error))?;
                fs::remove_file(source).map_err(|error| AppError::from_io(&error))?;
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&entry_dir);
                return Err(AppError::from_io(&error));
            }
        }

        if let Err(error) = self.mark_active(&entry_dir, &mut entry) {
            match copy_payload(&payload, source) {
                Ok(()) => {
                    let _ = fs::remove_dir_all(&entry_dir);
                }
                Err(_) => {
                    entry.state = StoredState::Orphaned;
                    entry.last_error = Some("could not commit the trash entry".to_string());
                    let _ = self.write_entry(&entry_dir, &entry);
                }
            }
            return Err(error);
        }
        Ok(entry.public())
    }

    pub fn list(&self, root: &Path) -> Vec<TrashEntry> {
        if !self.inner.ready {
            return Vec::new();
        }
        let Ok(_state) = self.lock() else {
            return Vec::new();
        };
        let dir = self.inner.root.join(workspace_key(root));
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut result = Vec::new();
        for entry in entries.flatten() {
            let entry_dir = entry.path();
            if !entry_dir.is_dir() {
                continue;
            }
            let Some(stored) = self.load_entry(&entry_dir) else {
                continue;
            };
            if stored.root != root.to_string_lossy() {
                continue;
            }
            if stored.state == StoredState::Pending {
                let _ = self.try_recover(&entry_dir, &stored, None);
            }
            if let Some(stored) = self.load_entry(&entry_dir) {
                result.push(stored.public());
            }
        }
        result.sort_by(|left, right| right.deleted_at_ms.cmp(&left.deleted_at_ms));
        result
    }

    pub fn restore(
        &self,
        root: &Path,
        entry_id: &str,
        mode: TrashRestoreMode,
        locks: Option<&FileLockStore>,
        is_open: impl Fn(&Path) -> bool,
    ) -> Result<TrashRestoreResult, AppError> {
        if !self.inner.ready {
            return Err(disabled_error());
        }
        validate_entry_id(entry_id)?;
        let entry_dir = self.inner.root.join(workspace_key(root)).join(entry_id);
        let entry = self
            .load_entry(&entry_dir)
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "trash entry not found"))?;
        if entry.root != root.to_string_lossy() {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "the trash entry belongs to another workspace",
            ));
        }
        let payload = entry_dir.join("payload");
        if !payload.is_file() {
            return Err(AppError::new(
                AppErrorCode::NotFound,
                "the trash payload is missing",
            ));
        }
        let original = root.join(&entry.relative_path);
        let target = match mode {
            TrashRestoreMode::Original => original,
            TrashRestoreMode::Copy => reserve_copy(&original)?,
        };
        let _guard = locks
            .map(|store| store.acquire_target(&target))
            .transpose()?;
        if is_open(&target) {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the destination is open in another window",
            ));
        }
        if target.exists() {
            return Err(AppError::new(
                AppErrorCode::Conflict,
                "the restore destination already exists",
            ));
        }
        let parent = target.parent().ok_or_else(|| {
            AppError::new(AppErrorCode::InvalidPath, "restore path has no parent")
        })?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| AppError::from_io(&error))?;
        if !canonical_parent.starts_with(root) {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "restore path escapes the workspace",
            ));
        }
        let placeholder = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::new(
                        AppErrorCode::Conflict,
                        "the restore destination already exists",
                    )
                } else {
                    AppError::from_io(&error)
                }
            })?;
        drop(placeholder);
        if let Err(error) = fs::rename(&payload, &target) {
            let _ = fs::remove_file(&target);
            return Err(AppError::from_io(&error));
        }
        let restored_relative = target
            .strip_prefix(root)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| entry.relative_path.clone());
        let _ = fs::remove_dir_all(&entry_dir);
        Ok(TrashRestoreResult {
            relative_path: restored_relative,
            mode,
        })
    }

    pub fn purge(&self, root: &Path, entry_id: &str) -> Result<(), AppError> {
        if !self.inner.ready {
            return Err(disabled_error());
        }
        validate_entry_id(entry_id)?;
        let entry_dir = self.inner.root.join(workspace_key(root)).join(entry_id);
        let entry = self
            .load_entry(&entry_dir)
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "trash entry not found"))?;
        if entry.root != root.to_string_lossy() {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "the trash entry belongs to another workspace",
            ));
        }
        fs::remove_dir_all(&entry_dir).map_err(|error| AppError::from_io(&error))
    }

    pub fn gc(&self, roots: &[PathBuf], locks: Option<&FileLockStore>) -> TrashGcReport {
        if !self.inner.ready {
            return TrashGcReport::default();
        }
        let Ok(_state) = self.lock() else {
            return TrashGcReport::default();
        };
        let mut report = TrashGcReport::default();
        let now = now_ms();
        let Ok(workspaces) = fs::read_dir(&self.inner.root) else {
            return report;
        };
        // Capacity is evaluated across all active entries, oldest first.
        let mut active = Vec::new();
        for workspace in workspaces.flatten() {
            if !workspace.path().is_dir() {
                continue;
            }
            let Ok(entries) = fs::read_dir(workspace.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let entry_dir = entry.path();
                if !entry_dir.is_dir() {
                    continue;
                }
                let Some(stored) = self.load_entry(&entry_dir) else {
                    continue;
                };
                // A pending/orphaned entry may belong to a workspace that is
                // not open in this session; retry it whenever the root still
                // exists on disk. Active entries are TTL/capacity governed
                // regardless of whether the workspace is open.
                let root_available = roots
                    .iter()
                    .any(|root| root.to_string_lossy() == stored.root)
                    || Path::new(&stored.root).is_dir();
                match stored.state {
                    StoredState::Pending | StoredState::Orphaned => {
                        if root_available {
                            match self.try_recover(&entry_dir, &stored, locks) {
                                Ok(true) => report.recovered += 1,
                                Ok(false) => {}
                                Err(_) => report.orphaned += 1,
                            }
                        }
                        continue;
                    }
                    StoredState::Active => {}
                }
                let age = now.saturating_sub(stored.deleted_at_ms);
                if age > TRASH_TTL_MS {
                    if fs::remove_dir_all(&entry_dir).is_ok() {
                        report.removed += 1;
                    }
                    continue;
                }
                active.push((stored.deleted_at_ms, stored.size_bytes, entry_dir));
            }
        }
        active.sort_by_key(|(deleted_at_ms, _, _)| *deleted_at_ms);
        let mut total: u64 = active.iter().map(|(_, size, _)| *size).sum();
        let mut count = active.len();
        for (_, size, dir) in active {
            if count <= TRASH_MAX_ENTRIES && total <= TRASH_MAX_BYTES {
                break;
            }
            if fs::remove_dir_all(&dir).is_ok() {
                report.removed += 1;
                count = count.saturating_sub(1);
                total = total.saturating_sub(size);
            }
        }
        report
    }

    fn try_recover(
        &self,
        entry_dir: &Path,
        entry: &EntryFile,
        locks: Option<&FileLockStore>,
    ) -> Result<bool, AppError> {
        if entry.state == StoredState::Active {
            return Ok(false);
        }
        let payload = entry_dir.join("payload");
        if !payload.is_file() {
            let _ = fs::remove_dir_all(entry_dir);
            return Ok(false);
        }
        let target = Path::new(&entry.root).join(&entry.relative_path);
        let _guard = match (locks, target.exists()) {
            (Some(store), true) => Some(store.acquire(&target)?),
            _ => None,
        };
        if target.exists() {
            let mut current = Vec::new();
            fs::File::open(&target)
                .and_then(|mut file| file.read_to_end(&mut current))
                .map_err(|error| AppError::from_io(&error))?;
            if blake3::hash(&current).to_hex().to_string() == entry.hash {
                let _ = fs::remove_dir_all(entry_dir);
                return Ok(true);
            }
            let mut orphaned = entry.clone();
            orphaned.state = StoredState::Orphaned;
            orphaned.last_error = Some("restore target already exists".to_string());
            let _ = self.write_entry(entry_dir, &orphaned);
            return Ok(false);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| AppError::from_io(&error))?;
        }
        match fs::rename(&payload, &target) {
            Ok(()) => {
                let _ = fs::remove_dir_all(entry_dir);
                Ok(true)
            }
            Err(_) => {
                let mut orphaned = entry.clone();
                orphaned.state = StoredState::Orphaned;
                orphaned.last_error = Some("restore failed".to_string());
                let _ = self.write_entry(entry_dir, &orphaned);
                Err(AppError::new(AppErrorCode::Io, "restore failed"))
            }
        }
    }

    fn mark_active(&self, entry_dir: &Path, entry: &mut EntryFile) -> Result<(), AppError> {
        entry.state = StoredState::Active;
        entry.last_error = None;
        self.write_entry(entry_dir, entry)
    }

    fn load_entry(&self, entry_dir: &Path) -> Option<EntryFile> {
        let bytes = fs::read(entry_dir.join("entry.json")).ok()?;
        serde_json::from_slice::<EntryFile>(&bytes)
            .ok()
            .filter(|entry| entry.schema_version == TRASH_SCHEMA_VERSION)
    }

    fn write_entry(&self, entry_dir: &Path, entry: &EntryFile) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(entry)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        write_private_atomic(&entry_dir.join("entry.json"), &bytes)
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.inner
            .state
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "trash store lock poisoned"))
    }
}

fn reserve_copy(original: &Path) -> Result<PathBuf, AppError> {
    let parent = original
        .parent()
        .ok_or_else(|| AppError::new(AppErrorCode::InvalidPath, "path has no parent"))?;
    let stem = original
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("restored");
    let extension = original.extension().and_then(|ext| ext.to_str());
    for index in 0..100 {
        let suffix = if index == 0 {
            " (restored)".to_string()
        } else {
            format!(" (restored) ({})", index + 1)
        };
        let name = match extension {
            Some(extension) => format!("{stem}{suffix}.{extension}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        AppErrorCode::Busy,
        "could not reserve a restore filename",
    ))
}

fn copy_payload(payload: &Path, target: &Path) -> Result<(), AppError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| AppError::from_io(&error))?;
    }
    fs::copy(payload, target)
        .map(|_| ())
        .map_err(|error| AppError::from_io(&error))
}

fn validate_entry_id(id: &str) -> Result<(), AppError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AppError::new(AppErrorCode::InvalidPath, "invalid trash entry id"))
}

pub fn workspace_key(root: &Path) -> String {
    let key = blake3::hash(root.to_string_lossy().as_bytes())
        .to_hex()
        .to_string();
    key[..32].to_string()
}

fn disabled_error() -> AppError {
    AppError::new(AppErrorCode::Io, "trash storage is unavailable")
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

    fn canonical_dir(dir: &TempDir) -> PathBuf {
        fs::canonicalize(dir.path()).expect("canonical")
    }

    #[test]
    fn delete_moves_the_file_and_restore_puts_it_back() {
        let dir = TempDir::new().expect("temp dir");
        let root = canonical_dir(&dir);
        let source = root.join("note.md");
        fs::write(&source, "body\n").expect("fixture");
        let store = TrashStore::open(dir.path().join("trash")).expect("store");

        let entry = store
            .delete(&root, &source, None, |_| false)
            .expect("delete");
        assert!(!source.exists());
        assert_eq!(entry.relative_path, "note.md");
        assert_eq!(store.list(&root).len(), 1);

        let restored = store
            .restore(&root, &entry.id, TrashRestoreMode::Original, None, |_| {
                false
            })
            .expect("restore");
        assert_eq!(restored.relative_path, "note.md");
        assert_eq!(fs::read_to_string(&source).expect("restored"), "body\n");
        assert!(store.list(&root).is_empty());
    }

    #[test]
    fn refuses_to_delete_an_open_document() {
        let dir = TempDir::new().expect("temp dir");
        let root = canonical_dir(&dir);
        let source = root.join("note.md");
        fs::write(&source, "body\n").expect("fixture");
        let store = TrashStore::open(dir.path().join("trash")).expect("store");

        let error = store
            .delete(&root, &source, None, |_| true)
            .expect_err("open document must be busy");
        assert_eq!(error.code, AppErrorCode::Busy);
        assert!(source.exists());
    }

    #[test]
    fn copy_restore_never_overwrites() {
        let dir = TempDir::new().expect("temp dir");
        let root = canonical_dir(&dir);
        let source = root.join("note.md");
        fs::write(&source, "old\n").expect("fixture");
        let store = TrashStore::open(dir.path().join("trash")).expect("store");
        let entry = store
            .delete(&root, &source, None, |_| false)
            .expect("delete");
        fs::write(&source, "new\n").expect("replacement");

        let restored = store
            .restore(&root, &entry.id, TrashRestoreMode::Copy, None, |_| false)
            .expect("copy restore");
        assert_eq!(restored.relative_path, "note (restored).md");
        assert_eq!(fs::read_to_string(&source).expect("original"), "new\n");
        assert_eq!(
            fs::read_to_string(root.join("note (restored).md")).expect("copy"),
            "old\n"
        );
    }

    #[test]
    fn purge_removes_payload() {
        let dir = TempDir::new().expect("temp dir");
        let root = canonical_dir(&dir);
        let source = root.join("note.md");
        fs::write(&source, "body\n").expect("fixture");
        let store = TrashStore::open(dir.path().join("trash")).expect("store");
        let entry = store
            .delete(&root, &source, None, |_| false)
            .expect("delete");
        store.purge(&root, &entry.id).expect("purge");
        assert!(store.list(&root).is_empty());
    }
}
