//! Application-owned trash under `app_local_data_dir/trash/<workspaceKey>/`.
//!
//! A delete is committed only after the payload is complete. Every failure
//! path keeps the only copy in `payload`; a source file is never removed before
//! its replacement has been verified. Recovery is streaming and only trusts a
//! workspace root that the caller explicitly names.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{TrashEntry, TrashEntryState, TrashRestoreMode, TrashRestoreResult};
use crate::services::file_lock::FileLockStore;
use crate::services::workspace_service::{resolve_relative_target, validate_segment, MAX_SEGMENTS};

pub const TRASH_SCHEMA_VERSION: u32 = 1;
pub const TRASH_MAX_ENTRIES: usize = 200;
pub const TRASH_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const TRASH_MAX_BYTES: u64 = 512 * 1024 * 1024;

const COPY_BUFFER_BYTES: usize = 64 * 1024;

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

    /// Moves one file or symlink into the trash.
    ///
    /// `source` must already be inside the canonical `root`; the command
    /// performs that jail check. For a symlink only the link itself moves —
    /// the target is never read through or deleted.
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
        ensure_canonical_root(root)?;
        let relative = source.strip_prefix(root).map_err(|_| {
            AppError::new(AppErrorCode::OutsideScope, "path is outside the workspace")
        })?;
        let relative_key = normalized_relative(relative)?;

        let _state = self.lock()?;
        let _guard = locks.map(|store| store.acquire(source)).transpose()?;
        if is_open(source) {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the document is open in another window",
            ));
        }

        let link_meta = fs::symlink_metadata(source).map_err(|error| AppError::from_io(&error))?;
        let kind = if link_meta.file_type().is_symlink() {
            "symlink"
        } else if link_meta.is_file() {
            "file"
        } else {
            return Err(AppError::new(
                AppErrorCode::NotAFile,
                "only files and symlinks can be moved to trash",
            ));
        };

        let (hash, size_bytes, link_target) = if kind == "symlink" {
            let target = fs::read_link(source).map_err(|error| AppError::from_io(&error))?;
            (
                hash_link_text(&target),
                target.as_os_str().as_encoded_bytes().len() as u64,
                Some(target),
            )
        } else {
            let (hash, size) = hash_file_stream(source)?;
            (hash, size, None)
        };

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
            relative_path: relative_key,
            deleted_at_ms: now_ms(),
            size_bytes,
            hash: hash.clone(),
            kind: kind.to_string(),
            state: StoredState::Pending,
            last_error: None,
        };
        if let Err(error) = self.write_entry(&entry_dir, &entry) {
            let _ = fs::remove_dir_all(&entry_dir);
            return Err(error);
        }

        let moved = if kind == "symlink" {
            move_symlink_to_payload(source, &payload, &entry_dir, link_target.as_deref(), &hash)
        } else {
            move_file_to_payload(source, &payload, &entry_dir, &hash)
        };
        if let Err(error) = moved {
            let _ = fs::remove_dir_all(&entry_dir);
            return Err(error);
        }

        // A same-volume rename preserves the inode but another writer may have
        // changed its bytes before the rename. The payload is now the only
        // copy, so its streamed hash is authoritative.
        if kind == "file" {
            match hash_file_stream(&payload) {
                Ok((payload_hash, payload_size)) => {
                    entry.hash = payload_hash;
                    entry.size_bytes = payload_size;
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(&entry_dir);
                    return Err(error);
                }
            }
        }
        if let Err(error) = self.write_entry(&entry_dir, &entry) {
            let _ = fs::remove_dir_all(&entry_dir);
            return Err(error);
        }

        if let Err(error) = self.mark_active(&entry_dir, &mut entry) {
            // The payload already holds the only copy. Put it back only when
            // the source path is still absent; never overwrite a new file.
            if fs::symlink_metadata(source).is_err() {
                match restore_payload_to(&entry_dir, &entry, source) {
                    Ok(()) => {
                        let _ = fs::remove_dir_all(&entry_dir);
                    }
                    Err(_) => {
                        entry.state = StoredState::Orphaned;
                        entry.last_error = Some("could not commit the trash entry".to_string());
                        let _ = self.write_entry(&entry_dir, &entry);
                    }
                }
            } else {
                entry.state = StoredState::Orphaned;
                entry.last_error = Some("a new file appeared at the deleted path".to_string());
                let _ = self.write_entry(&entry_dir, &entry);
            }
            return Err(error);
        }
        Ok(entry.public())
    }

    pub fn list(&self, root: &Path) -> Vec<TrashEntry> {
        if !self.inner.ready || ensure_canonical_root(root).is_err() {
            return Vec::new();
        }
        let Ok(_state) = self.lock() else {
            return Vec::new();
        };
        let dir = self.inner.root.join(workspace_key(root));
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let trusted = [root.to_path_buf()];
        let mut result = Vec::new();
        for entry in entries.flatten() {
            let entry_dir = entry.path();
            if !entry_dir.is_dir() {
                continue;
            }
            let Some(stored) = self.load_entry(&entry_dir) else {
                cleanup_staging(&entry_dir);
                continue;
            };
            if !root_allowed(&stored.root, &trusted) {
                continue;
            }
            if stored.state != StoredState::Active {
                let _ = self.try_recover_locked(&trusted, &entry_dir, &stored, None);
            }
            if let Some(stored) = self.load_entry(&entry_dir) {
                result.push(stored.public());
            }
        }
        result.sort_by(|left, right| right.deleted_at_ms.cmp(&left.deleted_at_ms));
        result
    }

    /// Restores one entry with an explicit mode.
    ///
    /// The payload hash is verified before anything is linked or created, for
    /// both same-volume and cross-volume restores. The destination is never
    /// overwritten, including a broken symlink.
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
        ensure_canonical_root(root)?;
        validate_entry_id(entry_id)?;
        let _state = self.lock()?;
        let entry_dir = self.inner.root.join(workspace_key(root)).join(entry_id);
        let entry = self
            .load_entry(&entry_dir)
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "trash entry not found"))?;
        if !root_allowed(&entry.root, &[root.to_path_buf()]) {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "the trash entry belongs to another workspace",
            ));
        }
        let payload = entry_dir.join("payload");
        let payload_meta = fs::symlink_metadata(&payload)
            .map_err(|_| AppError::new(AppErrorCode::NotFound, "the trash payload is missing"))?;

        let original = resolve_relative_target(root, &entry.relative_path)?;
        let target = match mode {
            TrashRestoreMode::Original => original,
            TrashRestoreMode::Copy => reserve_copy(root, &original)?,
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
        if fs::symlink_metadata(&target).is_ok() {
            return Err(AppError::new(
                AppErrorCode::Conflict,
                "the restore destination already exists",
            ));
        }

        match entry.kind.as_str() {
            "symlink" => restore_symlink_payload(&payload, &payload_meta, &target, &entry)?,
            "file" => restore_file_payload(&payload, &payload_meta, &target, &entry)?,
            _ => {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "unknown trash entry kind",
                ))
            }
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
        ensure_canonical_root(root)?;
        validate_entry_id(entry_id)?;
        let _state = self.lock()?;
        let entry_dir = self.inner.root.join(workspace_key(root)).join(entry_id);
        let entry = self
            .load_entry(&entry_dir)
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "trash entry not found"))?;
        if !root_allowed(&entry.root, &[root.to_path_buf()]) {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "the trash entry belongs to another workspace",
            ));
        }
        fs::remove_dir_all(&entry_dir).map_err(|error| AppError::from_io(&error))
    }

    /// Retries Pending/Orphaned entries for one workspace root.
    ///
    /// This is the only external recovery entry point. It takes the store
    /// mutex itself and calls the lock-free recovery helper, so it never
    /// self-deadlocks. `roots=[]` never recovers.
    pub fn recover_for_root(&self, root: &Path, locks: Option<&FileLockStore>) -> TrashGcReport {
        let mut report = TrashGcReport::default();
        if !self.inner.ready || ensure_canonical_root(root).is_err() {
            return report;
        }
        let Ok(_state) = self.lock() else {
            return report;
        };
        let dir = self.inner.root.join(workspace_key(root));
        let Ok(entries) = fs::read_dir(dir) else {
            return report;
        };
        let trusted = [root.to_path_buf()];
        for entry in entries.flatten() {
            let entry_dir = entry.path();
            if !entry_dir.is_dir() {
                continue;
            }
            let Some(stored) = self.load_entry(&entry_dir) else {
                cleanup_staging(&entry_dir);
                continue;
            };
            if stored.state == StoredState::Active || !root_allowed(&stored.root, &trusted) {
                continue;
            }
            match self.try_recover_locked(&trusted, &entry_dir, &stored, locks) {
                Ok(true) => report.recovered += 1,
                Ok(false) => {}
                Err(_) => report.orphaned += 1,
            }
        }
        report
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
        // Capacity is evaluated across all entries, oldest first.
        let mut retained = Vec::new();
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
                    cleanup_staging(&entry_dir);
                    continue;
                };
                let trusted = root_allowed(&stored.root, roots);
                match stored.state {
                    StoredState::Pending => {
                        // A pending entry may only recover while its root is
                        // explicitly trusted. Without one it must not expire:
                        // it may still be the only copy of the file.
                        if trusted {
                            match self.try_recover_locked(roots, &entry_dir, &stored, locks) {
                                Ok(true) => report.recovered += 1,
                                Ok(false) => {}
                                Err(_) => report.orphaned += 1,
                            }
                        }
                        if entry_dir.exists() {
                            retained.push((stored.deleted_at_ms, stored.size_bytes, entry_dir));
                        }
                        continue;
                    }
                    StoredState::Orphaned => {
                        if trusted {
                            let _ = self.try_recover_locked(roots, &entry_dir, &stored, locks);
                        }
                        if entry_dir.exists() {
                            // An orphaned payload may still be the only copy;
                            // like Pending it is capacity-governed, not
                            // silently expired.
                            retained.push((stored.deleted_at_ms, stored.size_bytes, entry_dir));
                        }
                        continue;
                    }
                    StoredState::Active => {}
                }
                if now.saturating_sub(stored.deleted_at_ms) > TRASH_TTL_MS {
                    if fs::remove_dir_all(&entry_dir).is_ok() {
                        report.removed += 1;
                    }
                    continue;
                }
                retained.push((stored.deleted_at_ms, stored.size_bytes, entry_dir));
            }
        }
        retained.sort_by_key(|(deleted_at_ms, _, _)| *deleted_at_ms);
        let mut total: u64 = retained.iter().map(|(_, size, _)| *size).sum();
        let mut count = retained.len();
        for (_, size, dir) in retained {
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

    /// Recovery helper. Callers already hold the store mutex.
    fn try_recover_locked(
        &self,
        trusted_roots: &[PathBuf],
        entry_dir: &Path,
        entry: &EntryFile,
        locks: Option<&FileLockStore>,
    ) -> Result<bool, AppError> {
        if entry.state == StoredState::Active {
            return Ok(false);
        }
        let Some(root) = trusted_roots
            .iter()
            .find(|root| root_allowed(&entry.root, std::slice::from_ref(*root)))
            .cloned()
        else {
            return Ok(false);
        };
        let payload = entry_dir.join("payload");
        let payload_meta = match fs::symlink_metadata(&payload) {
            Ok(meta) => meta,
            Err(_) => {
                // Nothing to restore: the move never completed.
                let _ = fs::remove_dir_all(entry_dir);
                return Ok(false);
            }
        };
        let target = match resolve_relative_target(&root, &entry.relative_path) {
            Ok(target) => target,
            Err(error) => {
                self.mark_orphaned(entry_dir, entry, &error.to_string());
                return Err(error);
            }
        };

        let target_exists = fs::symlink_metadata(&target).is_ok();
        let _guard = match (locks, target_exists) {
            (Some(store), true) => match store.acquire_target(&target) {
                Ok(guard) => Some(guard),
                Err(error) => {
                    self.mark_orphaned(entry_dir, entry, &error.to_string());
                    return Err(error);
                }
            },
            _ => None,
        };

        if target_exists {
            let matches = match entry.kind.as_str() {
                "symlink" => fs::read_link(&target)
                    .map(|target| hash_link_text(&target) == entry.hash)
                    .unwrap_or(false),
                "file" => hash_file_stream(&target)
                    .map(|(hash, _)| hash == entry.hash)
                    .unwrap_or(false),
                _ => false,
            };
            if matches {
                let _ = fs::remove_dir_all(entry_dir);
                return Ok(true);
            }
            self.mark_orphaned(entry_dir, entry, "restore target already exists");
            return Ok(false);
        }

        let result = match entry.kind.as_str() {
            "symlink" => recover_symlink_payload(&payload, &payload_meta, &target, entry),
            "file" => recover_file_payload(&payload, &payload_meta, &target, entry),
            _ => Err(AppError::new(
                AppErrorCode::Conflict,
                "unknown trash entry kind",
            )),
        };
        match result {
            Ok(()) => {
                fsync_parent(&target);
                let _ = fs::remove_dir_all(entry_dir);
                Ok(true)
            }
            Err(error) => {
                self.mark_orphaned(entry_dir, entry, &error.to_string());
                Err(error)
            }
        }
    }

    fn mark_orphaned(&self, entry_dir: &Path, entry: &EntryFile, reason: &str) {
        let mut orphaned = entry.clone();
        orphaned.state = StoredState::Orphaned;
        orphaned.last_error = Some(reason.to_string());
        let _ = self.write_entry(entry_dir, &orphaned);
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

fn ensure_canonical_root(root: &Path) -> Result<(), AppError> {
    let metadata = fs::metadata(root).map_err(|error| AppError::from_io(&error))?;
    if !metadata.is_dir() {
        return Err(AppError::new(
            AppErrorCode::OutsideScope,
            "the workspace root is not a directory",
        ));
    }
    Ok(())
}

fn normalized_relative(relative: &Path) -> Result<String, AppError> {
    let mut segments = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                let Some(name) = name.to_str() else {
                    return Err(AppError::new(
                        AppErrorCode::InvalidPath,
                        "the trash path is not valid UTF-8",
                    ));
                };
                validate_segment(name)?;
                segments.push(name.to_string());
            }
            _ => {
                return Err(AppError::new(
                    AppErrorCode::InvalidPath,
                    "the trash path contains an invalid component",
                ))
            }
        }
    }
    if segments.is_empty() || segments.len() > MAX_SEGMENTS {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "the trash path is empty or too deep",
        ));
    }
    Ok(segments.join("/"))
}

/// Whether a stored entry root is one of the caller-trusted canonical roots.
fn root_allowed(stored: &str, trusted_roots: &[PathBuf]) -> bool {
    let stored_path = Path::new(stored);
    trusted_roots.iter().any(|root| {
        if root.to_string_lossy() == stored {
            return true;
        }
        match (fs::canonicalize(stored_path), fs::canonicalize(root)) {
            (Ok(stored), Ok(root)) => stored == root,
            _ => false,
        }
    })
}

fn hash_link_text(target: &Path) -> String {
    blake3::hash(target.as_os_str().as_encoded_bytes())
        .to_hex()
        .to_string()
}

fn hash_reader(mut reader: impl Read) -> Result<(String, u64), AppError> {
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    let mut total = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| AppError::from_io(&error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((hasher.finalize().to_hex().to_string(), total))
}

fn hash_file_stream(path: &Path) -> Result<(String, u64), AppError> {
    let file = fs::File::open(path).map_err(|error| AppError::from_io(&error))?;
    hash_reader(file)
}

/// Copies exactly the source bytes into a new file and returns their hash.
fn copy_stream(source: &Path, target: &Path) -> Result<(String, u64), AppError> {
    let mut input = fs::File::open(source).map_err(|error| AppError::from_io(&error))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|error| AppError::from_io(&error))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    let mut total = 0u64;
    let copied = (|| -> std::io::Result<()> {
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            total += read as u64;
        }
        output.sync_all()
    })();
    if let Err(error) = copied {
        drop(output);
        let _ = fs::remove_file(target);
        return Err(AppError::from_io(&error));
    }
    drop(output);
    if let Ok(metadata) = fs::metadata(source) {
        let _ = fs::set_permissions(target, metadata.permissions());
    }
    Ok((hasher.finalize().to_hex().to_string(), total))
}

fn is_cross_device(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::CrossesDevices {
        return true;
    }
    #[cfg(unix)]
    {
        const EXDEV: i32 = 18;
        error.raw_os_error() == Some(EXDEV)
    }
    #[cfg(windows)]
    {
        const ERROR_NOT_SAME_DEVICE: i32 = 17;
        error.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE)
    }
    #[cfg(not(any(unix, windows)))]
    false
}

fn link_unsupported(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        // EPERM (1) and ENOTSUP/EOPNOTSUPP (45/95/102 depending on the OS).
        matches!(error.raw_os_error(), Some(1 | 45 | 95 | 102))
    }
    #[cfg(windows)]
    {
        // ERROR_ACCESS_DENIED / ERROR_INVALID_FUNCTION on FAT-like volumes.
        matches!(error.raw_os_error(), Some(1 | 5 | 50))
    }
    #[cfg(not(any(unix, windows)))]
    false
}

fn move_file_to_payload(
    source: &Path,
    payload: &Path,
    entry_dir: &Path,
    expected_hash: &str,
) -> Result<(), AppError> {
    match fs::rename(source, payload) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device(&error) => {
            let staging = entry_dir.join("payload.tmp");
            let (copied_hash, _) = copy_stream(source, &staging)?;
            if copied_hash != expected_hash {
                let _ = fs::remove_file(&staging);
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "trash copy failed its hash check",
                ));
            }
            // An external writer may change the source while we copy it.
            let (current_hash, _) = hash_file_stream(source)?;
            if current_hash != expected_hash {
                let _ = fs::remove_file(&staging);
                return Err(AppError::new(
                    AppErrorCode::Busy,
                    "the source changed while it was copied to trash",
                ));
            }
            fs::rename(&staging, payload).map_err(|error| AppError::from_io(&error))?;
            fs::remove_file(source).map_err(|error| AppError::from_io(&error))?;
            Ok(())
        }
        Err(error) => Err(AppError::from_io(&error)),
    }
}

fn move_symlink_to_payload(
    source: &Path,
    payload: &Path,
    entry_dir: &Path,
    link_target: Option<&Path>,
    expected_hash: &str,
) -> Result<(), AppError> {
    match fs::rename(source, payload) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device(&error) => {
            let Some(link_target) = link_target else {
                return Err(AppError::new(
                    AppErrorCode::Io,
                    "the symlink target is unavailable",
                ));
            };
            if hash_link_text(link_target) != expected_hash {
                return Err(AppError::new(
                    AppErrorCode::Busy,
                    "the symlink changed while it was copied to trash",
                ));
            }
            let staging = entry_dir.join("payload.tmp");
            let target_is_dir = fs::metadata(source)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            create_symlink(link_target, &staging, target_is_dir)?;
            if fs::read_link(&staging)
                .map(|target| hash_link_text(&target) != expected_hash)
                .unwrap_or(true)
            {
                let _ = fs::remove_file(&staging);
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the symlink copy failed its hash check",
                ));
            }
            fs::rename(&staging, payload).map_err(|error| AppError::from_io(&error))?;
            fs::remove_file(source).map_err(|error| AppError::from_io(&error))?;
            Ok(())
        }
        Err(error) => Err(AppError::from_io(&error)),
    }
}

fn create_symlink(target_text: &Path, link: &Path, target_is_dir: bool) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        let _ = target_is_dir;
        std::os::unix::fs::symlink(target_text, link).map_err(|error| AppError::from_io(&error))
    }
    #[cfg(windows)]
    {
        if target_is_dir {
            std::os::windows::fs::symlink_dir(target_text, link)
        } else {
            std::os::windows::fs::symlink_file(target_text, link)
        }
        .map_err(|error| AppError::from_io(&error))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target_text, link, target_is_dir);
        Err(AppError::new(
            AppErrorCode::Io,
            "symlinks are unsupported on this platform",
        ))
    }
}

fn fsync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Creates the destination from a verified payload without overwriting it.
fn restore_file_payload(
    payload: &Path,
    payload_meta: &fs::Metadata,
    target: &Path,
    entry: &EntryFile,
) -> Result<(), AppError> {
    if !payload_meta.is_file() {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash payload is not a regular file",
        ));
    }
    let (hash, _) = hash_file_stream(payload)?;
    if hash != entry.hash {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash payload failed its integrity check",
        ));
    }
    link_verified_payload(payload, target)?;
    fsync_parent(target);
    let _ = fs::remove_file(payload);
    Ok(())
}

fn restore_symlink_payload(
    payload: &Path,
    payload_meta: &fs::Metadata,
    target: &Path,
    entry: &EntryFile,
) -> Result<(), AppError> {
    if !payload_meta.file_type().is_symlink() {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash payload is not a symlink",
        ));
    }
    let link_target = fs::read_link(payload).map_err(|error| AppError::from_io(&error))?;
    if hash_link_text(&link_target) != entry.hash {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash symlink failed its integrity check",
        ));
    }
    let target_is_dir = fs::metadata(payload)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    create_symlink(&link_target, target, target_is_dir)?;
    fsync_parent(target);
    let _ = fs::remove_file(payload);
    Ok(())
}

fn recover_file_payload(
    payload: &Path,
    payload_meta: &fs::Metadata,
    target: &Path,
    entry: &EntryFile,
) -> Result<(), AppError> {
    if !payload_meta.is_file() {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash payload is not a regular file",
        ));
    }
    let (hash, _) = hash_file_stream(payload)?;
    if hash != entry.hash {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash payload failed its integrity check",
        ));
    }
    link_verified_payload(payload, target)
}

fn recover_symlink_payload(
    payload: &Path,
    payload_meta: &fs::Metadata,
    target: &Path,
    entry: &EntryFile,
) -> Result<(), AppError> {
    if !payload_meta.file_type().is_symlink() {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash payload is not a symlink",
        ));
    }
    let link_target = fs::read_link(payload).map_err(|error| AppError::from_io(&error))?;
    if hash_link_text(&link_target) != entry.hash {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the trash symlink failed its integrity check",
        ));
    }
    let target_is_dir = fs::metadata(payload)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    create_symlink(&link_target, target, target_is_dir)
}

/// Hard-links a verified payload to a fresh target, falling back to a verified
/// staging copy on another volume and finally to a checked rename.
fn link_verified_payload(payload: &Path, target: &Path) -> Result<(), AppError> {
    match fs::hard_link(payload, target) {
        Ok(()) => return Ok(()),
        Err(error) if is_cross_device(&error) => {
            let parent = target
                .parent()
                .ok_or_else(|| AppError::new(AppErrorCode::InvalidPath, "path has no parent"))?;
            let staging = parent.join(format!(".restore-{}", Uuid::new_v4()));
            let (staged_hash, _) = copy_stream(payload, &staging)?;
            let entry_hash = hash_file_stream(payload)
                .map(|(hash, _)| hash)
                .inspect_err(|_| {
                    let _ = fs::remove_file(&staging);
                })?;
            if staged_hash != entry_hash {
                let _ = fs::remove_file(&staging);
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the restore copy failed its hash check",
                ));
            }
            fs::hard_link(&staging, target)
                .inspect_err(|_| {
                    let _ = fs::remove_file(&staging);
                })
                .map_err(|error| AppError::from_io(&error))?;
            fsync_parent(target);
            let _ = fs::remove_file(&staging);
            return Ok(());
        }
        Err(error) if link_unsupported(&error) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AppError::new(
                AppErrorCode::Conflict,
                "the restore destination already exists",
            ));
        }
        Err(error) => return Err(AppError::from_io(&error)),
    }
    // Hard links are unsupported on this volume. Re-check immediately before
    // the rename; a residual race remains on platforms without no-clobber
    // rename (documented in the design).
    if fs::symlink_metadata(target).is_ok() {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "the restore destination already exists",
        ));
    }
    fs::rename(payload, target).map_err(|error| AppError::from_io(&error))
}

fn restore_payload_to(entry_dir: &Path, entry: &EntryFile, source: &Path) -> Result<(), AppError> {
    let payload = entry_dir.join("payload");
    match entry.kind.as_str() {
        "symlink" => {
            let link_target = fs::read_link(&payload).map_err(|error| AppError::from_io(&error))?;
            if hash_link_text(&link_target) != entry.hash {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the trash symlink failed its integrity check",
                ));
            }
            let target_is_dir = fs::metadata(&payload)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            create_symlink(&link_target, source, target_is_dir)
        }
        "file" => {
            let (hash, _) = copy_stream(&payload, source)?;
            if hash != entry.hash {
                let _ = fs::remove_file(source);
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the restored copy failed its hash check",
                ));
            }
            fsync_parent(source);
            Ok(())
        }
        _ => Err(AppError::new(
            AppErrorCode::Conflict,
            "unknown trash entry kind",
        )),
    }
}

fn reserve_copy(root: &Path, original: &Path) -> Result<PathBuf, AppError> {
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
        // A broken symlink still occupies the name.
        if fs::symlink_metadata(&candidate).is_err() {
            let canonical_parent = parent
                .canonicalize()
                .map_err(|error| AppError::from_io(&error))?;
            if !canonical_parent.starts_with(root) {
                return Err(AppError::new(
                    AppErrorCode::OutsideScope,
                    "the restore path escapes the workspace",
                ));
            }
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        AppErrorCode::Busy,
        "could not reserve a restore filename",
    ))
}

fn cleanup_staging(entry_dir: &Path) {
    let _ = fs::remove_file(entry_dir.join("payload.tmp"));
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

    #[test]
    fn cross_device_detection_uses_the_platform_error_code() {
        #[cfg(unix)]
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
        #[cfg(windows)]
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(17)));
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(2)));
    }
}
