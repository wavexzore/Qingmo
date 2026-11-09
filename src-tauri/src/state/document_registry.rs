use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{
    FilePayload, LineEnding, ReadOnlyReason, SaveResult, TextEncoding, TextFormat,
};
use crate::services::atomic_writer::{AtomicWriter, ExpectedTarget};
use crate::services::document_identity::{
    DocumentId, DocumentIdentityStore, IdentityStatus, LiveDocuments, PathKey, ResolveOutcome,
};
use crate::services::file_identity::{observe_path, same_identity, FileIdentity, FileObservation};
use crate::services::file_lock::FileLockStore;
use crate::services::file_service::{FileService, MAX_DOCUMENT_BYTES};
use crate::services::history_store::HistoryStore;
use crate::services::workspace_service::resolve_document_verified;

/// Opaque IPC handle. It is intentionally not a document identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DocToken(String);

impl DocToken {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for DocToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct DocState {
    pub format: TextFormat,
    pub read_only: Option<ReadOnlyReason>,
    pub base_hash: String,
    pub disk_size: u64,
    pub mtime_ms: i64,
}

impl DocState {
    fn from_parsed(parsed: &crate::services::file_service::ParsedFile) -> Self {
        Self {
            format: parsed.format.clone(),
            read_only: parsed.read_only_reason,
            base_hash: parsed.hash.clone(),
            disk_size: parsed.size,
            mtime_ms: parsed.mtime_ms,
        }
    }
}

/// A consistent snapshot of the paths and identities of one document.
///
/// Callers must not hold this snapshot across a rekey; take a fresh one after
/// any operation that can move the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPaths {
    pub raw_path: PathBuf,
    pub canonical_target: PathBuf,
    pub parent_identity: Option<FileIdentity>,
    pub file_identity: Option<FileIdentity>,
    pub generation: u64,
}

#[derive(Debug)]
pub struct DocumentRecord {
    document_id: Option<DocumentId>,
    paths: Mutex<DocumentPaths>,
    state: Mutex<DocState>,
    io_lock: Mutex<()>,
    active: AtomicBool,
}

impl DocumentRecord {
    fn new(document_id: Option<DocumentId>, paths: DocumentPaths, state: DocState) -> Self {
        Self {
            document_id,
            paths: Mutex::new(paths),
            state: Mutex::new(state),
            io_lock: Mutex::new(()),
            active: AtomicBool::new(true),
        }
    }

    pub fn document_id(&self) -> Option<DocumentId> {
        self.document_id
    }

    pub fn paths(&self) -> Result<DocumentPaths, AppError> {
        self.paths
            .lock()
            .map(|paths| paths.clone())
            .map_err(|_| AppError::new(AppErrorCode::Io, "document path lock poisoned"))
    }

    pub fn set_paths(&self, mut paths: DocumentPaths) -> Result<DocumentPaths, AppError> {
        let mut guard = self
            .paths
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document path lock poisoned"))?;
        paths.generation = guard.generation.saturating_add(1);
        *guard = paths.clone();
        Ok(paths)
    }

    pub fn raw_selected(&self) -> Result<PathBuf, AppError> {
        Ok(self.paths()?.raw_path)
    }

    pub fn canonical_target(&self) -> Result<PathBuf, AppError> {
        Ok(self.paths()?.canonical_target)
    }

    pub fn lock_state(&self) -> Result<MutexGuard<'_, DocState>, AppError> {
        self.state
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document state lock poisoned"))
    }

    pub fn lock_io(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.io_lock
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document io lock poisoned"))
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Default)]
struct DocumentServices {
    history: Option<HistoryStore>,
    locks: Option<FileLockStore>,
    identity: Option<DocumentIdentityStore>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    docs: RwLock<HashMap<DocToken, Arc<DocumentRecord>>>,
    by_path: RwLock<HashMap<PathKey, HashSet<DocToken>>>,
    services: RwLock<DocumentServices>,
    rekey_lock: Mutex<()>,
}

#[derive(Debug, Clone, Default)]
pub struct RelocatedDocument {
    pub token: String,
    pub document_id: Option<DocumentId>,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct RekeyOutcome {
    pub relocated: Vec<RelocatedDocument>,
    pub requires_rescan: bool,
}

/// Registry of documents owned by open windows.
#[derive(Debug, Clone, Default)]
pub struct DocumentRegistry {
    inner: Arc<RegistryInner>,
}

impl DocumentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn configure_services(
        &self,
        history: Option<HistoryStore>,
        locks: Option<FileLockStore>,
        identity: Option<DocumentIdentityStore>,
    ) {
        if let Ok(mut services) = self.inner.services.write() {
            *services = DocumentServices {
                history,
                locks,
                identity,
            };
        }
    }

    fn services(&self) -> DocumentServices {
        self.inner
            .services
            .read()
            .map(|services| services.clone())
            .unwrap_or_default()
    }

    pub fn snapshot_live(&self) -> LiveDocuments {
        let docs = match self.inner.docs.read() {
            Ok(docs) => docs,
            Err(_) => return LiveDocuments::default(),
        };
        let mut live = LiveDocuments::default();
        for record in docs.values() {
            let Ok(paths) = record.paths() else {
                continue;
            };
            if let Some(id) = record.document_id() {
                live.insert(&paths.raw_path, id);
                live.insert(&paths.canonical_target, id);
            }
        }
        live
    }

    pub fn is_path_open(&self, path: &Path) -> bool {
        let Ok(by_path) = self.inner.by_path.read() else {
            return true;
        };
        by_path.contains_key(&PathKey::from_path(path))
    }

    /// Whether any live record currently owns this exact file instance.
    ///
    /// Save As must not replace a file another window has open even when the
    /// target path is reached through a different hardlink.
    pub fn is_file_identity_open(&self, identity: &FileIdentity) -> bool {
        let Ok(docs) = self.inner.docs.read() else {
            return true;
        };
        docs.values().any(|record| {
            record
                .paths()
                .ok()
                .and_then(|paths| paths.file_identity)
                .is_some_and(|owned| same_identity(&owned, identity))
        })
    }

    pub fn is_path_owned_by_other(&self, path: &Path, token: &str) -> bool {
        self.inner
            .by_path
            .read()
            .ok()
            .and_then(|by_path| by_path.get(&PathKey::from_path(path)).cloned())
            .is_some_and(|tokens| tokens.iter().any(|candidate| candidate.as_str() != token))
    }

    pub fn has_child_prefix(&self, directory: &Path) -> bool {
        let parent = PathKey::from_path(directory);
        self.inner
            .by_path
            .read()
            .map(|by_path| by_path.keys().any(|key| parent.is_prefix_of(key)))
            .unwrap_or(false)
    }

    pub fn canonical_paths(&self) -> Vec<PathBuf> {
        self.inner
            .docs
            .read()
            .map(|docs| {
                docs.values()
                    .filter_map(|record| record.paths().ok())
                    .map(|paths| paths.canonical_target)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn tokens_where_any(&self, keys: &[PathKey]) -> Vec<(DocToken, Arc<DocumentRecord>)> {
        let docs = match self.inner.docs.read() {
            Ok(docs) => docs,
            Err(_) => return Vec::new(),
        };
        let by_path = match self.inner.by_path.read() {
            Ok(by_path) => by_path,
            Err(_) => return Vec::new(),
        };
        let mut tokens = HashSet::new();
        for key in keys {
            if let Some(values) = by_path.get(key) {
                tokens.extend(values.iter().cloned());
            }
        }
        let mut records: Vec<(DocToken, Arc<DocumentRecord>)> = tokens
            .into_iter()
            .filter_map(|token| docs.get(&token).map(|record| (token, Arc::clone(record))))
            .collect();
        records.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
        records
    }

    pub fn open_path(&self, selected: PathBuf) -> Result<FilePayload, AppError> {
        self.open_path_inner(selected, None)
    }

    pub fn open_path_with_root(
        &self,
        selected: PathBuf,
        root: &Path,
    ) -> Result<FilePayload, AppError> {
        self.open_path_inner(selected, Some(root))
    }

    fn open_path_inner(
        &self,
        selected: PathBuf,
        root: Option<&Path>,
    ) -> Result<FilePayload, AppError> {
        let _rekey = self
            .inner
            .rekey_lock
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document rekey lock poisoned"))?;
        ensure_supported_extension(&selected)?;

        let (raw_path, canonical_target, parent_identity) = match root {
            Some(root) => {
                let relative = selected.strip_prefix(root).map_err(|_| {
                    AppError::new(
                        AppErrorCode::OutsideScope,
                        "the document is outside the workspace",
                    )
                })?;
                let segments: Vec<String> = relative
                    .components()
                    .filter_map(|component| match component {
                        std::path::Component::Normal(value) => value.to_str().map(str::to_string),
                        _ => None,
                    })
                    .collect();
                let resolved = resolve_document_verified(root, &segments)?;
                (
                    resolved.raw_path,
                    resolved.canonical_target,
                    resolved.parent_identity,
                )
            }
            None => {
                let canonical_target = std::fs::canonicalize(&selected).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        AppError::new(
                            AppErrorCode::NotFound,
                            format!("file not found: {}", selected.display()),
                        )
                    } else {
                        AppError::from_io(&error)
                    }
                })?;
                ensure_supported_extension(&canonical_target)?;
                let parent_identity = observe_parent(&canonical_target)?;
                (selected.clone(), canonical_target, parent_identity)
            }
        };

        if let Some(root) = root {
            if !canonical_target.starts_with(root) {
                return Err(AppError::new(
                    AppErrorCode::OutsideScope,
                    "the document is outside the workspace",
                ));
            }
        }
        ensure_supported_extension(&canonical_target)?;
        let raw = FileService::read_raw(
            &canonical_target,
            MAX_DOCUMENT_BYTES,
            parent_identity.as_ref(),
        )?;
        let observation = observation_of(raw.identity.as_ref());
        let parsed = FileService::parse(raw, &canonical_target)?;

        let document_id = match self.services().identity.as_ref() {
            Some(identity) => {
                let live = self.snapshot_live();
                match identity.resolve_open(&canonical_target, observation, &live)? {
                    ResolveOutcome::Existing { id, .. } | ResolveOutcome::Created { id } => {
                        Some(id)
                    }
                    ResolveOutcome::Unmanaged => None,
                }
            }
            None => None,
        };

        let token = DocToken::new();
        let paths = DocumentPaths {
            raw_path,
            canonical_target: canonical_target.clone(),
            parent_identity,
            file_identity: parsed.identity.clone(),
            generation: 0,
        };
        let record = Arc::new(DocumentRecord::new(
            document_id,
            paths,
            DocState::from_parsed(&parsed),
        ));
        self.insert_record(token.clone(), Arc::clone(&record))?;

        Ok(parsed.into_payload(token.as_str(), path_to_display(&canonical_target)))
    }

    fn insert_record(&self, token: DocToken, record: Arc<DocumentRecord>) -> Result<(), AppError> {
        let paths = record.paths()?;
        let mut by_path = self
            .inner
            .by_path
            .write()
            .map_err(|_| AppError::new(AppErrorCode::Io, "path registry lock poisoned"))?;
        add_path_keys(&mut by_path, &token, &paths);
        let mut docs = self
            .inner
            .docs
            .write()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document registry lock poisoned"))?;
        docs.insert(token, record);
        Ok(())
    }

    /// Saves an untitled document to a path chosen by the native dialog.
    pub fn save_as(&self, selected: PathBuf, text_lf: &str) -> Result<FilePayload, AppError> {
        let _rekey = self
            .inner
            .rekey_lock
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document rekey lock poisoned"))?;
        let selected = with_markdown_extension(selected);
        ensure_save_extension(&selected)?;

        let canonical_target = resolve_save_target(&selected)?;
        ensure_save_extension(&canonical_target)?;
        if self.is_path_open(&selected) || self.is_path_open(&canonical_target) {
            return Err(AppError::new(
                AppErrorCode::Busy,
                "the save-as target is already open in another window",
            ));
        }
        if let FileObservation::Present(identity) = observe_path(&canonical_target)? {
            if self.is_file_identity_open(&identity) {
                return Err(AppError::new(
                    AppErrorCode::Busy,
                    "the save-as target is already open in another window",
                ));
            }
        }

        let (format, existing) =
            match FileService::read_raw(&canonical_target, MAX_DOCUMENT_BYTES, None) {
                Ok(raw) => (raw.format.clone(), Some(raw)),
                Err(error) if error.code == AppErrorCode::NotFound => (
                    TextFormat {
                        encoding: TextEncoding::Utf8,
                        has_bom: false,
                        eol: LineEnding::Lf,
                    },
                    None,
                ),
                Err(error) => return Err(error),
            };

        let services = self.services();
        if let (Some(history), Some(raw)) = (services.history.as_ref(), existing.as_ref()) {
            if let Err(error) = history.capture(&canonical_target, &raw.bytes, &raw.hash, false) {
                tracing::warn!(%error, "failed to capture save-as history");
            }
        }

        let expected = match existing.as_ref() {
            Some(raw) => ExpectedTarget::Existing {
                identity: raw.identity.clone(),
                hash: raw.hash.clone(),
                size: raw.size,
                mtime_ms: raw.mtime_ms,
            },
            None => ExpectedTarget::Absent,
        };
        let parent_identity = observe_parent(&canonical_target)?;
        let result = AtomicWriter::write_new(
            services.locks.as_ref(),
            &canonical_target,
            &format,
            text_lf,
            &expected,
            parent_identity.as_ref(),
        )?;

        let observation = observation_of(result.identity.as_ref());
        let document_id = match services.identity.as_ref() {
            Some(identity) => {
                let live = self.snapshot_live();
                Some(identity.resolve_open_new(&canonical_target, observation, &live)?)
            }
            None => None,
        };
        let text_units = text_lf.encode_utf16().count() as u64;
        let token = DocToken::new();
        let record = Arc::new(DocumentRecord::new(
            document_id,
            DocumentPaths {
                raw_path: selected,
                canonical_target: canonical_target.clone(),
                parent_identity,
                file_identity: result.identity,
                generation: 0,
            },
            DocState {
                format: format.clone(),
                read_only: None,
                base_hash: result.hash.clone(),
                disk_size: result.size,
                mtime_ms: result.mtime_ms,
            },
        ));
        self.insert_record(token.clone(), record)?;

        Ok(FilePayload {
            doc_token: token.as_str().to_string(),
            path: path_to_display(&canonical_target),
            text: text_lf.to_string(),
            format,
            mixed_eol: false,
            hash: result.hash,
            size: result.size,
            text_units,
            mtime_ms: result.mtime_ms,
            read_only: false,
            read_only_reason: None,
        })
    }

    pub fn write_atomic(
        &self,
        token: &str,
        text_lf: &str,
        expected_current_hash: Option<&str>,
    ) -> Result<SaveResult, AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        if !record.is_active() {
            return Err(inactive_token());
        }
        let services = self.services();
        let mut result = AtomicWriter::write_with_services(
            &record,
            text_lf,
            expected_current_hash,
            services.history.as_ref(),
            services.locks.as_ref(),
            false,
        )?;
        let paths = record.paths()?;
        let observation = observe_path(&paths.canonical_target)?;
        if let (Some(id), Some(identity)) = (record.document_id(), services.identity.as_ref()) {
            if let Err(error) =
                identity.bind_save(&id, &paths.canonical_target, observation.clone())
            {
                tracing::warn!(%error, "failed to bind saved document identity");
            }
        }
        let mut updated = paths;
        updated.file_identity = observation.identity().cloned();
        updated.parent_identity = observe_parent(&updated.canonical_target)?;
        if let Err(error) = record.set_paths(updated) {
            tracing::warn!(%error, "failed to refresh document paths after save");
        }
        let generation = record.paths().map(|paths| paths.generation).unwrap_or(0);
        result.doc_token = token.to_string();
        result.generation = generation;
        Ok(result)
    }

    pub fn restore_history(&self, token: &str, entry_id: &str) -> Result<FilePayload, AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        if !record.is_active() {
            return Err(inactive_token());
        }
        let paths = record.paths()?;
        let services = self.services();
        let history = services
            .history
            .as_ref()
            .ok_or_else(|| AppError::new(AppErrorCode::Io, "history storage is unavailable"))?;
        let snapshot = history.read_raw_for(
            record.document_id().as_ref(),
            &paths.canonical_target,
            entry_id,
        )?;
        let decoded = crate::services::encoding::decode(&snapshot.0)?;
        let result = AtomicWriter::restore_with_services(
            &record,
            &snapshot.1,
            &decoded.text,
            services.locks.as_ref(),
        )?;
        let observation = observe_path(&paths.canonical_target)?;
        if let (Some(id), Some(identity)) = (record.document_id(), services.identity.as_ref()) {
            if let Err(error) =
                identity.bind_save(&id, &paths.canonical_target, observation.clone())
            {
                tracing::warn!(%error, "failed to bind restored document identity");
            }
        }
        let mut updated = paths.clone();
        updated.file_identity = observation.identity().cloned();
        updated.parent_identity = observe_parent(&updated.canonical_target)?;
        if let Err(error) = record.set_paths(updated) {
            tracing::warn!(%error, "failed to refresh document paths after a history restore");
        }
        Ok(FilePayload {
            doc_token: token.to_string(),
            path: path_to_display(&paths.canonical_target),
            text: decoded.text.clone(),
            format: snapshot.1,
            mixed_eol: false,
            hash: result.hash,
            size: result.size,
            text_units: decoded.text.encode_utf16().count() as u64,
            mtime_ms: result.mtime_ms,
            read_only: false,
            read_only_reason: None,
        })
    }

    pub fn reload(&self, token: &str) -> Result<FilePayload, AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        if !record.is_active() {
            return Err(inactive_token());
        }
        let paths = record.paths()?;

        let current_target = std::fs::canonicalize(&paths.raw_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(
                    AppErrorCode::NotFound,
                    format!("file not found: {}", paths.raw_path.display()),
                )
            } else {
                AppError::from_io(&error)
            }
        })?;
        if current_target != paths.canonical_target {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "the selected path now points to a different file",
            ));
        }

        let raw = AtomicWriter::with_read_lock(
            self.services().locks.as_ref(),
            &paths.canonical_target,
            || {
                FileService::read_raw(
                    &paths.canonical_target,
                    MAX_DOCUMENT_BYTES,
                    paths.parent_identity.as_ref(),
                )
            },
        )?;
        let parsed = FileService::parse(raw, &paths.canonical_target)?;
        let mut state = record.lock_state()?;
        state.format = parsed.format.clone();
        state.read_only = parsed.read_only_reason;
        state.base_hash = parsed.hash.clone();
        state.disk_size = parsed.size;
        state.mtime_ms = parsed.mtime_ms;
        drop(state);

        let services = self.services();
        if let (Some(id), Some(identity)) = (record.document_id(), services.identity.as_ref()) {
            let observation = observation_of(parsed.identity.as_ref());
            if let Err(error) = identity.bind_save(&id, &paths.canonical_target, observation) {
                tracing::warn!(%error, "failed to bind reloaded document identity");
            }
        }
        let mut updated = paths;
        updated.file_identity = parsed.identity.clone();
        updated.parent_identity = parsed.parent_identity.clone();
        record.set_paths(updated)?;

        Ok(parsed.into_payload(token, path_to_display(&record.canonical_target()?)))
    }

    pub fn get(&self, token: &str) -> Result<Arc<DocumentRecord>, AppError> {
        let docs = self
            .inner
            .docs
            .read()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document registry lock poisoned"))?;
        docs.iter()
            .find(|(candidate, _)| candidate.as_str() == token)
            .map(|(_, record)| Arc::clone(record))
            .ok_or_else(|| AppError::new(AppErrorCode::InvalidPath, "invalid or expired docToken"))
    }

    pub fn deactivate(&self, token: &str) -> Result<(), AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        record.set_active(false);
        drop(_io);
        Ok(())
    }

    pub fn activate(&self, token: &str) -> Result<Arc<DocumentRecord>, AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        record.set_active(true);
        drop(_io);
        Ok(record)
    }

    pub fn release(&self, token: &str) -> bool {
        let _rekey = match self.inner.rekey_lock.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let key = DocToken(token.to_string());
        let record = match self.inner.docs.write() {
            Ok(mut docs) => docs.remove(&key),
            Err(_) => return false,
        };
        let Some(record) = record else {
            return false;
        };
        if let Ok(paths) = record.paths() {
            if let Ok(mut by_path) = self.inner.by_path.write() {
                remove_path_keys(&mut by_path, &key, &paths);
            }
        }
        true
    }

    pub fn len(&self) -> usize {
        self.inner
            .docs
            .read()
            .map(|docs| docs.len())
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn rekey_path(
        &self,
        old_path: &Path,
        new_path: &Path,
        _root: &Path,
    ) -> Result<RekeyOutcome, AppError> {
        let _rekey = self
            .inner
            .rekey_lock
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document rekey lock poisoned"))?;
        let keys = vec![PathKey::from_path(old_path)];
        let candidates = self.tokens_where_any(&keys);
        self.rekey_candidates(candidates, |paths| {
            let mut next = paths.clone();
            let new_canonical =
                std::fs::canonicalize(new_path).unwrap_or_else(|_| new_path.to_path_buf());
            let raw_matches = PathKey::from_path(&paths.raw_path) == PathKey::from_path(old_path);
            let canonical_matches =
                PathKey::from_path(&paths.canonical_target) == PathKey::from_path(old_path);
            if raw_matches {
                next.raw_path = new_path.to_path_buf();
            }
            if canonical_matches || raw_matches {
                next.canonical_target = new_canonical;
            }
            if !raw_matches && !canonical_matches {
                return None;
            }
            Some(next)
        })
    }

    pub fn rekey_prefix(
        &self,
        old_dir: &Path,
        new_dir: &Path,
        _root: &Path,
    ) -> Result<RekeyOutcome, AppError> {
        let _rekey = self
            .inner
            .rekey_lock
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document rekey lock poisoned"))?;
        let parent = PathKey::from_path(old_dir);
        let new_dir_canonical =
            std::fs::canonicalize(new_dir).unwrap_or_else(|_| new_dir.to_path_buf());
        let old_canonical = match old_dir.file_name() {
            Some(name) => new_dir_canonical.with_file_name(name),
            None => old_dir.to_path_buf(),
        };
        let canonical_parent = PathKey::from_path(&old_canonical);
        let mut keys = Vec::new();
        if let Ok(by_path) = self.inner.by_path.read() {
            for key in by_path.keys() {
                if parent.is_prefix_of(key) || canonical_parent.is_prefix_of(key) {
                    keys.push(key.clone());
                }
            }
        }
        let candidates = self.tokens_where_any(&keys);
        self.rekey_candidates(candidates, |paths| {
            let raw_suffix = paths.raw_path.strip_prefix(old_dir).ok();
            let canonical_suffix = paths
                .canonical_target
                .strip_prefix(&old_canonical)
                .ok()
                .or(raw_suffix);
            let suffix = canonical_suffix?;
            let raw = raw_suffix
                .map(|suffix| new_dir.join(suffix))
                .unwrap_or_else(|| new_dir_canonical.join(suffix));
            let canonical = new_dir_canonical.join(suffix);
            if raw == paths.raw_path && canonical == paths.canonical_target {
                return None;
            }
            Some(DocumentPaths {
                raw_path: raw,
                canonical_target: canonical,
                ..paths.clone()
            })
        })
    }

    pub fn rekey_token(
        &self,
        token: &str,
        new_path: &Path,
        observation: FileObservation,
    ) -> Result<(), AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        let mut paths = record.paths()?;
        let old_paths = paths.clone();
        paths.raw_path = new_path.to_path_buf();
        paths.canonical_target = new_path.to_path_buf();
        paths.file_identity = observation.identity().cloned();
        paths.parent_identity = observe_parent(new_path)?;
        let paths = record.set_paths(paths)?;
        self.move_path_keys(&DocToken(token.to_string()), &old_paths, &paths);
        Ok(())
    }

    pub fn rekey_document(
        &self,
        id: DocumentId,
        new_path: &Path,
        observation: FileObservation,
    ) -> Result<RekeyOutcome, AppError> {
        let record = self
            .inner
            .docs
            .read()
            .ok()
            .and_then(|docs| {
                docs.iter()
                    .find(|(_, record)| record.document_id() == Some(id))
                    .map(|(token, _)| token.as_str().to_string())
            })
            .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "document identity not found"))?;
        let old = self.get(&record)?.canonical_target()?;
        let _ = observation;
        self.rekey_path(&old, new_path, new_path)
    }

    fn rekey_candidates<F>(
        &self,
        candidates: Vec<(DocToken, Arc<DocumentRecord>)>,
        rewrite: F,
    ) -> Result<RekeyOutcome, AppError>
    where
        F: Fn(&DocumentPaths) -> Option<DocumentPaths>,
    {
        let mut outcome = RekeyOutcome::default();
        if candidates.is_empty() {
            return Ok(outcome);
        }
        let mut guards = Vec::with_capacity(candidates.len());
        for (_, record) in &candidates {
            guards.push(record.lock_io()?);
        }

        let mut changes: Vec<(DocumentId, PathBuf, FileObservation)> = Vec::new();
        for (token, record) in &candidates {
            let paths = record.paths()?;
            let Some(mut next) = rewrite(&paths) else {
                continue;
            };
            let new_canonical = next.canonical_target.clone();
            if new_canonical != paths.canonical_target {
                if self.is_path_owned_by_other(&new_canonical, token.as_str()) {
                    return Err(AppError::new(
                        AppErrorCode::Conflict,
                        "the rename target is already open in another window",
                    ));
                }
                let observed = observe_path(&new_canonical)?;
                if let (Some(expected), FileObservation::Present(actual)) =
                    (paths.file_identity.as_ref(), &observed)
                {
                    if !same_identity(expected, actual) {
                        return Err(AppError::new(
                            AppErrorCode::Conflict,
                            "the rename target is a different file",
                        ));
                    }
                }
                if let Some(id) = record.document_id() {
                    changes.push((id, new_canonical.clone(), observed));
                }
            }

            if PathKey::from_path(&next.raw_path) != PathKey::from_path(&next.canonical_target) {
                let raw_observation = observe_path(&next.raw_path)?;
                let raw_matches = match (&paths.file_identity, &raw_observation) {
                    (Some(expected), FileObservation::Present(actual)) => {
                        same_identity(expected, actual)
                    }
                    (None, _) | (_, FileObservation::Unavailable) => true,
                    (_, FileObservation::Absent) => false,
                };
                if !raw_matches {
                    next.raw_path = next.canonical_target.clone();
                    outcome.requires_rescan = true;
                }
            }
            next.parent_identity = observe_parent(&next.canonical_target)?;
            if new_canonical != paths.canonical_target {
                next.file_identity = match observe_path(&new_canonical)? {
                    FileObservation::Present(identity) => Some(identity),
                    FileObservation::Unavailable | FileObservation::Absent => None,
                };
            }
            let updated = record.set_paths(next)?;
            self.move_path_keys(token, &paths, &updated);
            outcome.relocated.push(RelocatedDocument {
                token: token.as_str().to_string(),
                document_id: record.document_id(),
                path: updated.raw_path,
            });
        }
        drop(guards);
        let identity = self.services().identity;
        if let Some(identity) = identity.as_ref() {
            if identity.status() == IdentityStatus::Enabled && !changes.is_empty() {
                if let Err(error) = identity.adopt_many(&changes) {
                    tracing::warn!(%error, "failed to adopt document identities after rename");
                }
            }
        }
        Ok(outcome)
    }

    fn move_path_keys(&self, token: &DocToken, old: &DocumentPaths, new: &DocumentPaths) {
        if let Ok(mut by_path) = self.inner.by_path.write() {
            remove_path_keys(&mut by_path, token, old);
            add_path_keys(&mut by_path, token, new);
        }
    }

    pub fn mark_missing(&self, token: &str) -> Result<(), AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        if let (Some(id), Some(identity)) = (record.document_id(), self.services().identity) {
            if let Err(error) = identity.mark_missing(&id) {
                tracing::warn!(%error, "failed to mark the document identity missing");
            }
        }
        record.set_active(false);
        Ok(())
    }

    pub fn mark_recovered(&self, token: &str, path: &Path) -> Result<(), AppError> {
        let record = self.get(token)?;
        let _io = record.lock_io()?;
        if let (Some(id), Some(identity)) = (record.document_id(), self.services().identity) {
            if let Err(error) = identity.mark_recovered(&id, path) {
                tracing::warn!(%error, "failed to recover the document identity");
            }
        }
        let mut paths = record.paths()?;
        let old = paths.clone();
        paths.canonical_target = path.to_path_buf();
        paths.raw_path = path.to_path_buf();
        paths.file_identity = observe_path(path)?.identity().cloned();
        paths.parent_identity = observe_parent(path)?;
        let updated = record.set_paths(paths)?;
        self.move_path_keys(&DocToken(token.to_string()), &old, &updated);
        record.set_active(true);
        Ok(())
    }
}

fn inactive_token() -> AppError {
    AppError::new(AppErrorCode::InvalidPath, "invalid or expired docToken")
}

fn observation_of(identity: Option<&FileIdentity>) -> FileObservation {
    match identity {
        Some(identity) => FileObservation::Present(identity.clone()),
        None => FileObservation::Unavailable,
    }
}

fn observe_parent(path: &Path) -> Result<Option<FileIdentity>, AppError> {
    let Some(parent) = path.parent() else {
        return Ok(None);
    };
    Ok(match observe_path(parent)? {
        FileObservation::Present(identity) => Some(identity),
        FileObservation::Unavailable | FileObservation::Absent => None,
    })
}

fn add_path_keys(
    by_path: &mut HashMap<PathKey, HashSet<DocToken>>,
    token: &DocToken,
    paths: &DocumentPaths,
) {
    let raw = PathKey::from_path(&paths.raw_path);
    let canonical = PathKey::from_path(&paths.canonical_target);
    by_path
        .entry(raw.clone())
        .or_default()
        .insert(token.clone());
    if canonical != raw {
        by_path.entry(canonical).or_default().insert(token.clone());
    }
}

fn remove_path_keys(
    by_path: &mut HashMap<PathKey, HashSet<DocToken>>,
    token: &DocToken,
    paths: &DocumentPaths,
) {
    for key in [
        PathKey::from_path(&paths.raw_path),
        PathKey::from_path(&paths.canonical_target),
    ] {
        let empty = if let Some(tokens) = by_path.get_mut(&key) {
            tokens.remove(token);
            tokens.is_empty()
        } else {
            false
        };
        if empty {
            by_path.remove(&key);
        }
    }
}

fn with_markdown_extension(mut path: PathBuf) -> PathBuf {
    let has_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| !value.is_empty());
    if !has_extension {
        path.set_extension("md");
    }
    path
}

fn ensure_save_extension(path: &Path) -> Result<(), AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("md" | "markdown") => Ok(()),
        _ => Err(AppError::new(
            AppErrorCode::UnsupportedExtension,
            format!(
                "save-as only supports .md and .markdown: {}",
                path.display()
            ),
        )),
    }
}

fn resolve_save_target(path: &Path) -> Result<PathBuf, AppError> {
    match std::fs::canonicalize(path) {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| {
                AppError::new(AppErrorCode::InvalidPath, "the save path has no parent")
            })?;
            let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    AppError::new(
                        AppErrorCode::NotFound,
                        format!("parent directory not found: {}", parent.display()),
                    )
                } else {
                    AppError::from_io(&error)
                }
            })?;
            let file_name = path.file_name().ok_or_else(|| {
                AppError::new(AppErrorCode::InvalidPath, "the save path has no file name")
            })?;
            Ok(canonical_parent.join(file_name))
        }
        Err(error) => Err(AppError::from_io(&error)),
    }
}

pub fn ensure_supported_extension(path: &Path) -> Result<(), AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("md" | "markdown" | "mdx") => Ok(()),
        _ => Err(AppError::new(
            AppErrorCode::UnsupportedExtension,
            format!("unsupported file extension: {}", path.display()),
        )),
    }
}

fn path_to_display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
