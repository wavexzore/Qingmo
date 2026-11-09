//! Persistent document identity.
//!
//! `DocumentId` is a UUID stored in `app_local_data_dir/identity/documents.json`.
//! It is deliberately independent from the path and from the short-lived
//! [`FileIdentity`]: an atomic save replaces the inode, and an external rename
//! changes the path, but neither may change the document identity.
//!
//! The store is the only code that writes the identity file. It never calls
//! back into `DocumentRegistry`; callers pass a [`LiveDocuments`] snapshot so
//! the lock order stays `registry -> identity` and never the reverse.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppErrorCode};
use crate::services::file_identity::{FileIdentity, FileKey, FileObservation};

pub const IDENTITY_SCHEMA_VERSION: u32 = 3;
pub const IDENTITY_FILE: &str = "documents.json";
pub const IDENTITY_MAX_ENTRIES: usize = 20_000;
pub const IDENTITY_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const IDENTITY_TTL_MS: i64 = 180 * 24 * 60 * 60 * 1000;
pub const IDENTITY_TOMBSTONE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const IDENTITY_LEGACY_PATHS_MAX: usize = 8;
pub const IDENTITY_FILE_DEBOUNCE_MS: i64 = 5_000;

/// Persistent document identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(Uuid);

impl DocumentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }

    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for DocumentId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for DocumentId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::str::FromStr for DocumentId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

/// Normalized comparison key for a path.
///
/// Windows strips verbatim prefixes, normalizes separators and case-folds.
/// macOS case-folds only on a case-insensitive volume. Other platforms keep
/// the canonical spelling. Display/index code keeps the original spelling.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PathKey(String);

impl PathKey {
    pub fn from_path(path: &Path) -> Self {
        let raw = path.to_string_lossy();
        #[cfg(windows)]
        {
            let mut value = raw.replace('/', "\\");
            if let Some(stripped) = value.strip_prefix(r"\\?\") {
                value = stripped.to_string();
            } else if let Some(stripped) = value.strip_prefix(r"\\.\") {
                value = stripped.to_string();
            }
            Self(value.to_lowercase())
        }
        #[cfg(target_os = "macos")]
        {
            let mut value = raw.into_owned();
            if !macos_case_sensitive(path) {
                value = value.to_lowercase();
            }
            Self(value)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Self(raw.into_owned())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Component-wise strict prefix check: `docs` is a prefix of `docs/a.md`
    /// but not of `docs2/a.md`.
    pub fn is_prefix_of(&self, child: &PathKey) -> bool {
        let parent = path_components(&self.0);
        let child = path_components(&child.0);
        parent.len() < child.len() && child[..parent.len()] == parent[..]
    }

    pub fn strip_prefix_key<'a>(&self, child: &'a PathKey) -> Option<&'a str> {
        if !self.is_prefix_of(child) {
            return None;
        }
        let offset = self.0.len();
        let remainder = child.0.get(offset..)?;
        Some(remainder.trim_start_matches(['/', '\\']))
    }
}

impl std::fmt::Display for PathKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn path_components(value: &str) -> Vec<&str> {
    value
        .split(['/', '\\'])
        .filter(|component| !component.is_empty())
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_case_sensitive(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    // `pathconf` on a path that no longer exists fails. Climb to the nearest
    // existing ancestor so a rename cannot change a path's normalization.
    let mut current = path;
    loop {
        if let Ok(value) = CString::new(current.as_os_str().as_bytes()) {
            let result = unsafe { libc::pathconf(value.as_ptr(), libc::_PC_CASE_SENSITIVE) };
            if result != -1 {
                return result != 0;
            }
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return true,
        }
    }
}

/// Live documents supplied by the registry. The identity store never calls
/// back into the registry and never holds its lock.
#[derive(Debug, Default, Clone)]
pub struct LiveDocuments {
    pub ids: HashSet<DocumentId>,
    /// Every live path (raw + canonical) for each ID.
    pub paths: HashMap<PathKey, BTreeSet<DocumentId>>,
}

impl LiveDocuments {
    pub fn insert(&mut self, path: &Path, id: DocumentId) {
        self.ids.insert(id);
        self.paths
            .entry(PathKey::from_path(path))
            .or_default()
            .insert(id);
    }

    pub fn is_live(&self, id: DocumentId) -> bool {
        self.ids.contains(&id)
    }

    pub fn path_has_live_id(&self, path: &Path, id: DocumentId) -> bool {
        self.paths
            .get(&PathKey::from_path(path))
            .is_some_and(|ids| ids.contains(&id))
    }

    pub fn id_lives_at_other_path(&self, path: &Path, id: DocumentId) -> bool {
        let key = PathKey::from_path(path);
        self.paths
            .iter()
            .any(|(candidate, ids)| candidate != &key && ids.contains(&id))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    Present,
    #[default]
    Unavailable,
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EntryState {
    #[default]
    Active,
    Missing,
    Tombstone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityStatus {
    Enabled,
    DegradedReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveOutcome {
    Existing { id: DocumentId, path_changed: bool },
    Created { id: DocumentId },
    Unmanaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TombstoneOutcome {
    Tombstoned,
    RefusedLive,
    NotFound,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IdentityGcReport {
    pub removed: usize,
    pub retained: usize,
    pub tombstoned: usize,
}

#[derive(Debug, Clone)]
pub struct PathRecord {
    pub path: PathBuf,
    pub entry_state: EntryState,
    pub file_state: FileState,
    pub file: Option<FileIdentity>,
    pub legacy_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    path: String,
    #[serde(default)]
    legacy_paths: Vec<String>,
    #[serde(default)]
    file: Option<FileIdentity>,
    #[serde(default)]
    file_state: Option<FileState>,
    #[serde(default)]
    last_seen_ms: i64,
    #[serde(default)]
    state: EntryState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentsFile {
    schema_version: u32,
    entries: BTreeMap<String, StoredEntry>,
}

impl Default for DocumentsFile {
    fn default() -> Self {
        Self {
            schema_version: IDENTITY_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct IdentityEntry {
    path: PathBuf,
    legacy_paths: Vec<PathBuf>,
    file: Option<FileIdentity>,
    file_state: FileState,
    last_seen_ms: i64,
    state: EntryState,
}

#[derive(Debug, Clone, Default)]
struct IdentityState {
    entries: BTreeMap<DocumentId, IdentityEntry>,
    by_path: HashMap<PathKey, DocumentId>,
    by_file: HashMap<FileKey, BTreeSet<DocumentId>>,
    dirty_file_identity: BTreeSet<DocumentId>,
    dirty_mapping: bool,
    last_flush_ms: i64,
}

struct IdentityInner {
    root: PathBuf,
    status: IdentityStatus,
    state: Mutex<IdentityState>,
}

/// Shared persistent identity store.
#[derive(Clone)]
pub struct DocumentIdentityStore {
    inner: Arc<IdentityInner>,
}

impl std::fmt::Debug for DocumentIdentityStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DocumentIdentityStore")
            .field("root", &self.inner.root)
            .field("status", &self.inner.status)
            .finish()
    }
}

impl DocumentIdentityStore {
    pub fn open(root: PathBuf) -> Result<Self, AppError> {
        Self::open_with_recovery(root, None, None)
    }

    pub fn open_with_recovery(
        root: PathBuf,
        history_root: Option<PathBuf>,
        session_root: Option<PathBuf>,
    ) -> Result<Self, AppError> {
        fs::create_dir_all(&root).map_err(|error| AppError::from_io(&error))?;
        private_dir(&root)?;

        let path = root.join(IDENTITY_FILE);
        let (state, status) = match fs::read(&path) {
            Ok(bytes) => match load_documents(&bytes) {
                Ok((file, migrated)) => {
                    let mut state = state_from_file(file);
                    if migrated {
                        state.dirty_mapping = true;
                    }
                    (state, IdentityStatus::Enabled)
                }
                Err(_) => {
                    backup_corrupt(&path);
                    match rebuild_from_legacy(history_root.as_deref(), session_root.as_deref()) {
                        Some(state) => (state, IdentityStatus::DegradedReadOnly),
                        None => {
                            return Err(AppError::new(
                                AppErrorCode::IdentityDegraded,
                                "document identity store is unreadable and could not be rebuilt",
                            ))
                        }
                    }
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (IdentityState::default(), IdentityStatus::Enabled)
            }
            Err(error) => return Err(AppError::from_io(&error)),
        };

        let store = Self {
            inner: Arc::new(IdentityInner {
                root,
                status,
                state: Mutex::new(state),
            }),
        };
        if store.status() == IdentityStatus::Enabled {
            store.flush()?;
        }
        Ok(store)
    }

    pub fn status(&self) -> IdentityStatus {
        self.inner.status
    }

    pub fn is_enabled(&self) -> bool {
        matches!(self.inner.status, IdentityStatus::Enabled)
    }

    pub fn resolve_open(
        &self,
        path: &Path,
        observation: FileObservation,
        live: &LiveDocuments,
    ) -> Result<ResolveOutcome, AppError> {
        let mut state = self.lock()?;
        if self.inner.status != IdentityStatus::Enabled {
            return Ok(match state.by_path.get(&PathKey::from_path(path)) {
                Some(id) => ResolveOutcome::Existing {
                    id: *id,
                    path_changed: false,
                },
                None => ResolveOutcome::Unmanaged,
            });
        }
        let mut candidate = (*state).clone();
        let (outcome, changed, _file_only) =
            resolve_open_locked(&mut candidate, path, observation, live)?;
        if changed {
            self.persist_state(&candidate)?;
        }
        *state = candidate;
        Ok(outcome)
    }

    pub fn resolve_open_batch(
        &self,
        items: &[(PathBuf, FileObservation)],
        live: &LiveDocuments,
    ) -> Result<Vec<DocumentId>, AppError> {
        self.require_enabled()?;
        let mut state = self.lock()?;
        let mut candidate = (*state).clone();
        let mut ids = Vec::with_capacity(items.len());
        let mut changed = false;
        for (path, observation) in items {
            let (outcome, item_changed, _file_only) =
                resolve_open_locked(&mut candidate, path, observation.clone(), live)?;
            match outcome {
                ResolveOutcome::Existing { id, .. } => {
                    changed |= item_changed;
                    ids.push(id);
                }
                ResolveOutcome::Created { id } => {
                    changed = true;
                    ids.push(id);
                }
                ResolveOutcome::Unmanaged => {
                    return Err(AppError::new(
                        AppErrorCode::IdentityDegraded,
                        "document identity store is read-only",
                    ))
                }
            }
        }
        if changed {
            candidate.dirty_mapping = true;
            self.persist_state(&candidate)?;
        }
        *state = candidate;
        Ok(ids)
    }

    pub fn resolve_open_new(
        &self,
        path: &Path,
        observation: FileObservation,
        live: &LiveDocuments,
    ) -> Result<DocumentId, AppError> {
        self.require_enabled()?;
        if matches!(observation, FileObservation::Absent) {
            return Err(not_found(path));
        }
        let mut state = self.lock()?;
        let mut candidate = (*state).clone();
        if let Some(existing) = candidate.by_path.get(&PathKey::from_path(path)).copied() {
            if live.is_live(existing) {
                return Err(conflict(path, "the path is open in another window"));
            }
            remove_mapping(&mut candidate, existing);
            if let Some(entry) = candidate.entries.get_mut(&existing) {
                entry.state = EntryState::Tombstone;
                entry.last_seen_ms = now_ms();
            }
        }

        let id = DocumentId::new();
        let entry = entry_from_observation(path, &observation, now_ms());
        candidate.entries.insert(id, entry);
        insert_mapping(&mut candidate, id, path, observation.identity());
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        *state = candidate;
        Ok(id)
    }

    pub fn adopt(
        &self,
        id: &DocumentId,
        path: &Path,
        observation: FileObservation,
    ) -> Result<(), AppError> {
        self.require_enabled()?;
        let mut state = self.lock()?;
        if !state.entries.contains_key(id) {
            return Err(not_found(path));
        }
        let mut candidate = (*state).clone();
        apply_adopt(&mut candidate, *id, path, &observation)?;
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        *state = candidate;
        Ok(())
    }

    pub fn adopt_many(
        &self,
        changes: &[(DocumentId, PathBuf, FileObservation)],
    ) -> Result<(), AppError> {
        self.require_enabled()?;
        let mut state = self.lock()?;
        let mut candidate = (*state).clone();
        let mut last_by_id: BTreeMap<DocumentId, usize> = BTreeMap::new();
        for (index, (id, _, _)) in changes.iter().enumerate() {
            last_by_id.insert(*id, index);
        }
        for (index, (id, path, observation)) in changes.iter().enumerate() {
            if last_by_id.get(id) != Some(&index) {
                continue;
            }
            apply_adopt(&mut candidate, *id, path, observation)?;
        }
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        *state = candidate;
        Ok(())
    }

    pub fn bind_save(
        &self,
        id: &DocumentId,
        path: &Path,
        observation: FileObservation,
    ) -> Result<(), AppError> {
        self.require_enabled()?;
        let mut state = self.lock()?;
        let Some(existing) = state.entries.get(id) else {
            return Err(not_found(path));
        };
        let path_changed = PathKey::from_path(&existing.path) != PathKey::from_path(path);
        let mut candidate = (*state).clone();
        apply_file_update(&mut candidate, *id, path, &observation)?;
        if path_changed {
            candidate.dirty_mapping = true;
            self.persist_state(&candidate)?;
        } else {
            self.defer_file_write(&mut candidate);
        }
        *state = candidate;
        Ok(())
    }

    pub fn tombstone(
        &self,
        id: &DocumentId,
        live: &LiveDocuments,
    ) -> Result<TombstoneOutcome, AppError> {
        self.require_enabled()?;
        if live.is_live(*id) {
            return Ok(TombstoneOutcome::RefusedLive);
        }
        let mut state = self.lock()?;
        if !state.entries.contains_key(id) {
            return Ok(TombstoneOutcome::NotFound);
        }
        let mut candidate = (*state).clone();
        remove_mapping(&mut candidate, *id);
        if let Some(entry) = candidate.entries.get_mut(id) {
            entry.state = EntryState::Tombstone;
            entry.last_seen_ms = now_ms();
        }
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        *state = candidate;
        Ok(TombstoneOutcome::Tombstoned)
    }

    pub fn mark_missing(&self, id: &DocumentId) -> Result<(), AppError> {
        self.require_enabled()?;
        let mut state = self.lock()?;
        let Some(entry) = state.entries.get(id) else {
            return Ok(());
        };
        let key = PathKey::from_path(&entry.path);
        let mut candidate = (*state).clone();
        if let Some(entry) = candidate.entries.get_mut(id) {
            entry.state = EntryState::Missing;
            entry.last_seen_ms = now_ms();
        }
        if candidate.by_path.get(&key) == Some(id) {
            candidate.by_path.remove(&key);
        }
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        *state = candidate;
        Ok(())
    }

    pub fn mark_recovered(&self, id: &DocumentId, path: &Path) -> Result<(), AppError> {
        self.require_enabled()?;
        let observation = crate::services::file_identity::observe_path(path)?;
        let mut state = self.lock()?;
        if let Some(existing) = state.by_path.get(&PathKey::from_path(path)) {
            if existing != id {
                return Err(conflict(
                    path,
                    "the path is already owned by another document",
                ));
            }
        }
        let Some(entry) = state.entries.get(id) else {
            return Err(not_found(path));
        };
        let old_path = entry.path.clone();
        let mut candidate = (*state).clone();
        if let Some(entry) = candidate.entries.get_mut(id) {
            if PathKey::from_path(&old_path) != PathKey::from_path(path) {
                push_legacy(&mut entry.legacy_paths, &old_path);
            }
            entry.path = path.to_path_buf();
            entry.state = EntryState::Active;
            entry.last_seen_ms = now_ms();
        }
        candidate.by_path.insert(PathKey::from_path(path), *id);
        update_file_hint(&mut candidate, *id, observation.identity(), &observation);
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        *state = candidate;
        Ok(())
    }

    pub fn resolve_path(&self, id: &DocumentId) -> Option<PathRecord> {
        let state = self.lock().ok()?;
        let entry = state.entries.get(id)?;
        Some(PathRecord {
            path: entry.path.clone(),
            entry_state: entry.state,
            file_state: entry.file_state,
            file: entry.file.clone(),
            legacy_paths: entry.legacy_paths.clone(),
        })
    }

    pub fn legacy_paths(&self, id: &DocumentId) -> Vec<PathBuf> {
        self.resolve_path(id)
            .map(|record| record.legacy_paths)
            .unwrap_or_default()
    }

    pub fn flush(&self) -> Result<(), AppError> {
        if self.inner.status != IdentityStatus::Enabled {
            return Ok(());
        }
        let mut state = self.lock()?;
        if !state.dirty_mapping && state.dirty_file_identity.is_empty() {
            return Ok(());
        }
        let mut candidate = (*state).clone();
        candidate.dirty_mapping = true;
        self.persist_state(&candidate)?;
        candidate.dirty_mapping = false;
        candidate.dirty_file_identity.clear();
        candidate.last_flush_ms = now_ms();
        *state = candidate;
        Ok(())
    }

    pub fn gc(&self, now_ms: i64, live: &LiveDocuments) -> IdentityGcReport {
        if self.inner.status != IdentityStatus::Enabled {
            return IdentityGcReport::default();
        }
        let Ok(mut state) = self.lock() else {
            return IdentityGcReport::default();
        };
        let mut candidate = (*state).clone();
        let mut report = IdentityGcReport::default();
        let mut remove = Vec::new();
        for (id, entry) in candidate.entries.iter() {
            if live.is_live(*id) {
                report.retained += 1;
                continue;
            }
            let expired = match entry.state {
                EntryState::Tombstone => {
                    now_ms.saturating_sub(entry.last_seen_ms) > IDENTITY_TOMBSTONE_TTL_MS
                }
                EntryState::Active | EntryState::Missing => {
                    now_ms.saturating_sub(entry.last_seen_ms) > IDENTITY_TTL_MS
                }
            };
            if expired {
                remove.push(*id);
            } else {
                report.retained += 1;
            }
        }

        let over_limit = candidate
            .entries
            .len()
            .saturating_sub(remove.len())
            .saturating_sub(IDENTITY_MAX_ENTRIES);
        if over_limit > 0 {
            let mut candidates: Vec<(DocumentId, i64)> = candidate
                .entries
                .iter()
                .filter(|(id, entry)| {
                    !live.is_live(**id)
                        && entry.state != EntryState::Tombstone
                        && !remove.contains(id)
                })
                .map(|(id, entry)| (*id, entry.last_seen_ms))
                .collect();
            candidates.sort_by_key(|(_, last_seen)| *last_seen);
            for (id, _) in candidates.into_iter().take(over_limit) {
                remove.push(id);
            }
        }

        for id in remove {
            if let Some(entry) = candidate.entries.remove(&id) {
                if entry.state == EntryState::Tombstone {
                    report.tombstoned += 1;
                }
                remove_mapping(&mut candidate, id);
                report.removed += 1;
            }
        }
        if report.removed > 0 {
            candidate.dirty_mapping = true;
            if let Err(error) = self.persist_state(&candidate) {
                tracing::warn!(%error, "failed to persist identity GC");
                return IdentityGcReport::default();
            }
            *state = candidate;
        }
        report
    }

    fn require_enabled(&self) -> Result<(), AppError> {
        if self.inner.status == IdentityStatus::Enabled {
            Ok(())
        } else {
            Err(AppError::new(
                AppErrorCode::IdentityDegraded,
                "document identity store is read-only",
            ))
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, IdentityState>, AppError> {
        self.inner
            .state
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "identity lock poisoned"))
    }

    fn defer_file_write(&self, state: &mut IdentityState) {
        // Only file identities changed; the mapping is already durable. The
        // write is deferred and coalesced until `flush`/GC, keeping a save
        // from rewriting a multi-megabyte JSON file.
        state.dirty_mapping = true;
        if now_ms().saturating_sub(state.last_flush_ms) >= IDENTITY_FILE_DEBOUNCE_MS {
            state.last_flush_ms = now_ms();
        }
    }

    fn persist_state(&self, state: &IdentityState) -> Result<(), AppError> {
        let mut file = DocumentsFile {
            schema_version: IDENTITY_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        };
        for (id, entry) in &state.entries {
            file.entries.insert(
                id.to_string(),
                StoredEntry {
                    path: entry.path.to_string_lossy().into_owned(),
                    legacy_paths: entry
                        .legacy_paths
                        .iter()
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect(),
                    file: entry.file.clone(),
                    file_state: Some(entry.file_state),
                    last_seen_ms: entry.last_seen_ms,
                    state: entry.state,
                },
            );
        }
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        if bytes.len() as u64 > IDENTITY_FILE_MAX_BYTES {
            return Err(AppError::new(
                AppErrorCode::Io,
                "document identity store exceeds the 8 MiB limit",
            ));
        }
        let path = self.inner.root.join(IDENTITY_FILE);
        let mut atomic = AtomicWriteFile::options()
            .open(&path)
            .map_err(|error| AppError::from_io(&error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = atomic
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600));
        }
        atomic
            .write_all(&bytes)
            .map_err(|error| AppError::from_io(&error))?;
        atomic.commit().map_err(|error| AppError::from_io(&error))?;
        Ok(())
    }
}

fn resolve_open_locked(
    state: &mut IdentityState,
    path: &Path,
    observation: FileObservation,
    live: &LiveDocuments,
) -> Result<(ResolveOutcome, bool, bool), AppError> {
    let key = PathKey::from_path(path);
    let path_hit = state.by_path.get(&key).copied();
    match observation {
        FileObservation::Absent => Err(not_found(path)),
        FileObservation::Present(identity) => {
            let file_key = identity.file_hex();
            let file_hits: Vec<DocumentId> = state
                .by_file
                .get(&file_key)
                .map(|ids| {
                    ids.iter()
                        .copied()
                        .filter(|id| {
                            state
                                .entries
                                .get(id)
                                .and_then(|entry| entry.file.as_ref())
                                .is_some_and(|stored| {
                                    crate::services::file_identity::same_identity(stored, &identity)
                                })
                        })
                        .collect()
                })
                .unwrap_or_default();

            if let Some(path_id) = path_hit {
                if file_hits.iter().any(|other| *other != path_id) {
                    return Err(conflict(
                        path,
                        "the path and file identity belong to different documents",
                    ));
                }
                let old_file = state.entries[&path_id].file.clone();
                if let Some(entry) = state.entries.get_mut(&path_id) {
                    entry.file = Some(identity.clone());
                    entry.file_state = FileState::Present;
                    entry.last_seen_ms = now_ms();
                    entry.state = EntryState::Active;
                }
                if old_file.as_ref().map(|value| value.file_hex()) != Some(file_key.clone()) {
                    remove_by_file(state, path_id, old_file.as_ref());
                    state.by_file.entry(file_key).or_default().insert(path_id);
                    state.dirty_file_identity.insert(path_id);
                }
                return Ok((
                    ResolveOutcome::Existing {
                        id: path_id,
                        path_changed: false,
                    },
                    false,
                    true,
                ));
            }

            if let Some(file_id) = adopt_candidate(state, &file_hits, path, &identity, live) {
                apply_adopt(state, file_id, path, &FileObservation::Present(identity))?;
                return Ok((
                    ResolveOutcome::Existing {
                        id: file_id,
                        path_changed: true,
                    },
                    true,
                    false,
                ));
            }

            let id = DocumentId::new();
            let entry =
                entry_from_observation(path, &FileObservation::Present(identity.clone()), now_ms());
            state.entries.insert(id, entry);
            insert_mapping(state, id, path, Some(&identity));
            state.dirty_mapping = true;
            state.dirty_file_identity.remove(&id);
            Ok((ResolveOutcome::Created { id }, true, false))
        }
        FileObservation::Unavailable => {
            if let Some(path_id) = path_hit {
                let old_file = state
                    .entries
                    .get_mut(&path_id)
                    .and_then(|entry| entry.file.take());
                if let Some(entry) = state.entries.get_mut(&path_id) {
                    entry.file_state = FileState::Unavailable;
                    entry.last_seen_ms = now_ms();
                }
                remove_by_file(state, path_id, old_file.as_ref());
                state.dirty_file_identity.insert(path_id);
                return Ok((
                    ResolveOutcome::Existing {
                        id: path_id,
                        path_changed: false,
                    },
                    false,
                    true,
                ));
            }
            let id = DocumentId::new();
            let entry = entry_from_observation(path, &observation, now_ms());
            state.entries.insert(id, entry);
            insert_mapping(state, id, path, None);
            state.dirty_mapping = true;
            Ok((ResolveOutcome::Created { id }, true, false))
        }
    }
}

fn adopt_candidate(
    state: &IdentityState,
    file_hits: &[DocumentId],
    path: &Path,
    identity: &FileIdentity,
    live: &LiveDocuments,
) -> Option<DocumentId> {
    if file_hits.len() != 1 {
        return None;
    }
    let id = file_hits[0];
    let entry = state.entries.get(&id)?;
    if entry.state == EntryState::Tombstone {
        return None;
    }
    if live.is_live(id) {
        return None;
    }
    // A hard link has the same inode but a path that still exists. Only a
    // missing old path can be a rename.
    match std::fs::metadata(&entry.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return None,
    }
    // Weak birth matches (one side zero) are only allowed in the same
    // directory; a cross-directory weak match is not enough evidence.
    if (identity.birth_ns() == 0 || entry.file.as_ref().is_some_and(|file| file.birth_ns() == 0))
        && entry.path.parent() != path.parent()
    {
        return None;
    }
    if let Some(file) = entry.file.as_ref() {
        if !crate::services::file_identity::same_identity(file, identity) {
            return None;
        }
    }
    Some(id)
}

fn apply_adopt(
    state: &mut IdentityState,
    id: DocumentId,
    path: &Path,
    observation: &FileObservation,
) -> Result<(), AppError> {
    let key = PathKey::from_path(path);
    if let Some(existing) = state.by_path.get(&key).copied() {
        if existing != id {
            return Err(conflict(
                path,
                "the path is already owned by another document",
            ));
        }
    }
    let Some(entry) = state.entries.get(&id) else {
        return Err(not_found(path));
    };
    let old_path = entry.path.clone();
    remove_mapping(state, id);
    if let Some(entry) = state.entries.get_mut(&id) {
        if PathKey::from_path(&old_path) != key {
            push_legacy(&mut entry.legacy_paths, &old_path);
        }
        entry.path = path.to_path_buf();
        entry.state = EntryState::Active;
        entry.last_seen_ms = now_ms();
        match observation {
            FileObservation::Present(identity) => {
                entry.file = Some(identity.clone());
                entry.file_state = FileState::Present;
            }
            FileObservation::Unavailable => {
                entry.file = None;
                entry.file_state = FileState::Unavailable;
            }
            FileObservation::Absent => {
                entry.file_state = FileState::Absent;
            }
        }
    }
    state.by_path.insert(key, id);
    match observation {
        FileObservation::Present(identity) => {
            state
                .by_file
                .entry(identity.file_hex())
                .or_default()
                .insert(id);
        }
        FileObservation::Unavailable | FileObservation::Absent => {}
    }
    state.dirty_file_identity.remove(&id);
    Ok(())
}

fn apply_file_update(
    state: &mut IdentityState,
    id: DocumentId,
    path: &Path,
    observation: &FileObservation,
) -> Result<(), AppError> {
    let key = PathKey::from_path(path);
    if let Some(existing) = state.by_path.get(&key).copied() {
        if existing != id {
            return Err(conflict(
                path,
                "the path is already owned by another document",
            ));
        }
    }
    let Some(entry) = state.entries.get(&id) else {
        return Err(not_found(path));
    };
    let old_path = entry.path.clone();
    remove_mapping(state, id);
    if let Some(entry) = state.entries.get_mut(&id) {
        if PathKey::from_path(&old_path) != key {
            push_legacy(&mut entry.legacy_paths, &old_path);
            entry.path = path.to_path_buf();
        }
        match observation {
            FileObservation::Present(identity) => {
                entry.file = Some(identity.clone());
                entry.file_state = FileState::Present;
            }
            FileObservation::Unavailable => {
                entry.file = None;
                entry.file_state = FileState::Unavailable;
            }
            FileObservation::Absent => {
                entry.file_state = FileState::Absent;
            }
        }
    }
    state.by_path.insert(key, id);
    match observation {
        FileObservation::Present(identity) => {
            state
                .by_file
                .entry(identity.file_hex())
                .or_default()
                .insert(id);
        }
        FileObservation::Unavailable | FileObservation::Absent => {}
    }
    state.dirty_file_identity.insert(id);
    Ok(())
}

fn entry_from_observation(path: &Path, observation: &FileObservation, now: i64) -> IdentityEntry {
    IdentityEntry {
        path: path.to_path_buf(),
        legacy_paths: Vec::new(),
        file: observation.identity().cloned(),
        file_state: match observation {
            FileObservation::Present(_) => FileState::Present,
            FileObservation::Unavailable => FileState::Unavailable,
            FileObservation::Absent => FileState::Absent,
        },
        last_seen_ms: now,
        state: EntryState::Active,
    }
}

fn insert_mapping(
    state: &mut IdentityState,
    id: DocumentId,
    path: &Path,
    identity: Option<&FileIdentity>,
) {
    state.by_path.insert(PathKey::from_path(path), id);
    if let Some(identity) = identity {
        state
            .by_file
            .entry(identity.file_hex())
            .or_default()
            .insert(id);
    }
}

fn remove_mapping(state: &mut IdentityState, id: DocumentId) {
    let key = state
        .entries
        .get(&id)
        .map(|entry| PathKey::from_path(&entry.path));
    if let Some(key) = key {
        if state.by_path.get(&key) == Some(&id) {
            state.by_path.remove(&key);
        }
    }
    let old_file = state.entries.get(&id).and_then(|entry| entry.file.clone());
    remove_by_file(state, id, old_file.as_ref());
}

fn remove_by_file(state: &mut IdentityState, id: DocumentId, file: Option<&FileIdentity>) {
    let Some(file) = file else {
        return;
    };
    let key = file.file_hex();
    let remove_key = if let Some(ids) = state.by_file.get_mut(&key) {
        ids.remove(&id);
        ids.is_empty()
    } else {
        false
    };
    if remove_key {
        state.by_file.remove(&key);
    }
}

fn update_file_hint(
    state: &mut IdentityState,
    id: DocumentId,
    identity: Option<&FileIdentity>,
    observation: &FileObservation,
) {
    let old_file = state.entries.get(&id).and_then(|entry| entry.file.clone());
    remove_by_file(state, id, old_file.as_ref());
    if let Some(entry) = state.entries.get_mut(&id) {
        match observation {
            FileObservation::Present(_) => {
                entry.file = identity.cloned();
                entry.file_state = FileState::Present;
            }
            FileObservation::Unavailable => {
                entry.file = None;
                entry.file_state = FileState::Unavailable;
            }
            FileObservation::Absent => {
                entry.file_state = FileState::Absent;
            }
        }
    }
    if let Some(identity) = identity {
        if matches!(observation, FileObservation::Present(_)) {
            state
                .by_file
                .entry(identity.file_hex())
                .or_default()
                .insert(id);
        }
    }
}

fn push_legacy(paths: &mut Vec<PathBuf>, path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    paths.retain(|candidate| PathKey::from_path(candidate) != PathKey::from_path(path));
    paths.insert(0, path.to_path_buf());
    paths.truncate(IDENTITY_LEGACY_PATHS_MAX);
}

fn load_documents(bytes: &[u8]) -> Result<(DocumentsFile, bool), AppError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
    let version = value
        .get("schemaVersion")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    if version > IDENTITY_SCHEMA_VERSION as u64 || version == 0 {
        return Err(AppError::new(
            AppErrorCode::Io,
            "unsupported document identity schema",
        ));
    }
    let file: DocumentsFile = serde_json::from_value(value)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
    Ok((file, version < IDENTITY_SCHEMA_VERSION as u64))
}

fn state_from_file(file: DocumentsFile) -> IdentityState {
    let mut state = IdentityState::default();
    for (raw_id, stored) in file.entries {
        let Some(id) = DocumentId::parse(&raw_id) else {
            continue;
        };
        let path = PathBuf::from(&stored.path);
        if !path.is_absolute() {
            continue;
        }
        let file_state = stored.file_state.unwrap_or(if stored.file.is_some() {
            FileState::Present
        } else {
            FileState::Unavailable
        });
        let entry = IdentityEntry {
            path,
            legacy_paths: stored
                .legacy_paths
                .into_iter()
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .take(IDENTITY_LEGACY_PATHS_MAX)
                .collect(),
            file: stored.file,
            file_state,
            last_seen_ms: stored.last_seen_ms,
            state: stored.state,
        };
        if entry.state == EntryState::Active {
            state.by_path.insert(PathKey::from_path(&entry.path), id);
        }
        if let Some(file) = entry.file.as_ref() {
            state.by_file.entry(file.file_hex()).or_default().insert(id);
        }
        state.entries.insert(id, entry);
    }
    state
}

fn rebuild_from_legacy(
    history_root: Option<&Path>,
    session_root: Option<&Path>,
) -> Option<IdentityState> {
    let mut entries: BTreeMap<DocumentId, IdentityEntry> = BTreeMap::new();

    if let Some(history_root) = history_root {
        if let Ok(read_dir) = fs::read_dir(history_root) {
            for dir in read_dir.flatten() {
                let id = dir
                    .file_name()
                    .to_str()
                    .and_then(DocumentId::parse)
                    .filter(|_| dir.path().is_dir());
                let Some(id) = id else {
                    continue;
                };
                let Ok(bytes) = fs::read(dir.path().join("entries.json")) else {
                    continue;
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                let Some(path) = value
                    .get("path")
                    .and_then(|path| path.as_str())
                    .map(PathBuf::from)
                else {
                    continue;
                };
                if !path.is_absolute() {
                    continue;
                }
                entries.insert(
                    id,
                    IdentityEntry {
                        path,
                        legacy_paths: Vec::new(),
                        file: None,
                        file_state: FileState::Unavailable,
                        last_seen_ms: now_ms(),
                        state: EntryState::Active,
                    },
                );
            }
        }
    }

    if let Some(session_root) = session_root {
        if let Ok(bytes) = fs::read(session_root.join("view-state.json")) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(entries_value) =
                    value.get("entries").and_then(|value| value.as_object())
                {
                    for key in entries_value.keys() {
                        let Some(id) = DocumentId::parse(key) else {
                            continue;
                        };
                        entries.entry(id).or_insert_with(|| IdentityEntry {
                            path: PathBuf::new(),
                            legacy_paths: Vec::new(),
                            file: None,
                            file_state: FileState::Unavailable,
                            last_seen_ms: now_ms(),
                            state: EntryState::Active,
                        });
                    }
                }
            }
        }
    }

    entries.retain(|_, entry| entry.path.is_absolute());
    if entries.is_empty() {
        return None;
    }
    let mut state = IdentityState {
        entries,
        ..IdentityState::default()
    };
    for (id, entry) in &state.entries {
        state.by_path.insert(PathKey::from_path(&entry.path), *id);
    }
    Some(state)
}

fn backup_corrupt(path: &Path) {
    let timestamp = now_ms();
    let backup = path.with_extension(format!("corrupt-{timestamp}"));
    let _ = fs::rename(path, backup);
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn not_found(path: &Path) -> AppError {
    AppError::new(
        AppErrorCode::NotFound,
        format!("file not found: {}", path.display()),
    )
}

fn conflict(path: &Path, message: &str) -> AppError {
    AppError::new(
        AppErrorCode::Conflict,
        format!("{message}: {}", path.display()),
    )
}
