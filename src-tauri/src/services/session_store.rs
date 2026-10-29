//! Bounded, atomic store for editor view state and crash drafts.
//!
//! Layout under `app_local_data_dir()/session`:
//!
//! ```text
//! session/
//! ├─ view-state.json          # schemaVersion + entries keyed by canonical path
//! └─ drafts/<uuid>.json       # one DraftRecord per file
//! ```
//!
//! All view and draft operations share one `Mutex<StoreState>`; this is what
//! makes a read-modify-write of `view-state.json` safe across windows and what
//! prevents a discard that races a write from resurrecting a draft.
//!
//! The store never accepts a caller-supplied file path: view keys are opaque
//! keys, draft ids are parsed as UUIDs and joined under `drafts/`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{
    DraftKind, DraftMeta, DraftRecord, DraftWriteRequest, EditorViewState, EditorViewStateInput,
    DRAFT_SCHEMA_VERSION, VIEW_STATE_SCHEMA_VERSION,
};

pub const VIEW_STATE_FILE: &str = "view-state.json";
pub const DRAFTS_DIR: &str = "drafts";
pub const MAX_PATH_CHARS: usize = 4096;
pub const MAX_TITLE_CHARS: usize = 200;
pub const VIEW_FILE_MAX_BYTES: u64 = 1024 * 1024;
pub const MAX_VIEW_ENTRIES: usize = 200;
pub const VIEW_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const MAX_DRAFT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_DRAFT_COUNT: usize = 20;
pub const MAX_DRAFT_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
pub const DRAFT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_CORRUPT_BACKUPS: usize = 10;
pub const CORRUPT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

const TOP_OFFSET_LIMIT: f64 = 1_000_000.0;
const SCROLL_LEFT_LIMIT: f64 = 1_000_000.0;
const CORRUPT_SUFFIX: &str = ".corrupt-";

/// Persisted `view-state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewStateFile {
    schema_version: u32,
    entries: BTreeMap<String, EditorViewState>,
}

impl Default for ViewStateFile {
    fn default() -> Self {
        Self {
            schema_version: VIEW_STATE_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Default)]
struct StoreState {
    view: ViewStateFile,
}

/// Counters returned by an explicit GC pass.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GcReport {
    pub drafts_removed: usize,
    pub view_entries_removed: usize,
    pub corrupt_files_removed: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct DraftPrune {
    removed: usize,
    corrupt: usize,
}

struct SessionStoreInner {
    root: PathBuf,
    ready: bool,
    state: Mutex<StoreState>,
}

/// Shared handle to the session store. Cloning is cheap and required before
/// moving the handle into `spawn_blocking`.
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<SessionStoreInner>,
}

impl SessionStore {
    /// Creates the session directories and loads `view-state.json`.
    ///
    /// A corrupt or oversized view file is backed up and replaced with an empty
    /// store instead of blocking startup; only directory failures return Err.
    pub fn open(root: PathBuf) -> Result<Self, AppError> {
        let drafts = root.join(DRAFTS_DIR);
        fs::create_dir_all(&drafts).map_err(|error| AppError::from_io(&error))?;
        set_dir_private(&root)?;
        set_dir_private(&drafts)?;

        let view = load_view(&root);
        Ok(Self {
            inner: Arc::new(SessionStoreInner {
                root,
                ready: true,
                state: Mutex::new(StoreState { view }),
            }),
        })
    }

    /// A store that reports no data and rejects every write. Used when the
    /// application data directory is unavailable so the app still starts.
    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(SessionStoreInner {
                root: PathBuf::new(),
                ready: false,
                state: Mutex::new(StoreState::default()),
            }),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.inner.ready
    }

    /// Startup GC. The caller runs this in `spawn_blocking`.
    pub fn gc(&self) -> GcReport {
        if !self.inner.ready {
            return GcReport::default();
        }
        let Ok(mut state) = self.lock() else {
            return GcReport::default();
        };
        let now = now_ms();
        self.gc_locked(&mut state, now)
    }

    pub fn view_get(&self, path: &str) -> Option<EditorViewState> {
        if !self.inner.ready || validate_view_key(path).is_err() {
            return None;
        }
        let state = self.lock().ok()?;
        state.view.entries.get(path).cloned()
    }

    /// Read-modify-write of the view file. The in-memory copy is replaced only
    /// after the atomic write succeeds, so a failed write cannot fork memory
    /// from disk.
    pub fn view_set(&self, path: &str, input: EditorViewStateInput) -> Result<(), AppError> {
        validate_view_key(path)?;
        if !self.inner.ready {
            return Err(unavailable());
        }

        let mut state = self.lock()?;
        let now = now_ms();
        let entry = clamp_view(input, now);
        let mut next = state.view.clone();
        next.entries.insert(path.to_string(), entry);
        prune_view(&mut next, now);
        let bytes = fit_view_file(&mut next)?;

        write_private_atomic(&self.inner.root.join(VIEW_STATE_FILE), &bytes)?;
        state.view = next;
        Ok(())
    }

    pub fn draft_write(&self, request: DraftWriteRequest) -> Result<DraftMeta, AppError> {
        if !self.inner.ready {
            return Err(unavailable());
        }
        validate_draft_text(&request.text)?;
        let kind = parse_draft_kind(&request.kind)?;
        let path = normalize_draft_path(kind, request.path.as_deref())?;
        let title = truncate_title(&request.title);
        let anchor = clamp_u32(request.anchor);
        let head = clamp_u32(request.head);

        let mut state = self.lock()?;
        let now = now_ms();
        // GC first: an expired id must not be resurrected by rebuilding it on
        // top of a file that is already past its TTL.
        self.gc_locked(&mut state, now);

        let existing_id = match request.id.as_deref() {
            Some(raw) => Some(draft_path(&self.inner.root, raw)?),
            None => None,
        };
        let existing = existing_id
            .as_deref()
            .and_then(|file| fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str::<DraftRecord>(&text).ok())
            .filter(|record| record.schema_version == DRAFT_SCHEMA_VERSION)
            .filter(|record| {
                existing_id
                    .as_deref()
                    .and_then(Path::file_stem)
                    .and_then(|stem| stem.to_str())
                    == Some(record.id.as_str())
            });

        let (id, kind, path, created_at_ms) = match existing {
            Some(record) => (record.id, record.kind, record.path, record.created_at_ms),
            None => (
                request
                    .id
                    .as_deref()
                    .and_then(|raw| Uuid::parse_str(raw).ok())
                    .map_or_else(|| Uuid::new_v4().to_string(), |uuid| uuid.to_string()),
                kind,
                path,
                now,
            ),
        };

        let record = DraftRecord {
            schema_version: DRAFT_SCHEMA_VERSION,
            id: id.clone(),
            kind,
            path,
            title,
            text_units: request.text.encode_utf16().count() as u64,
            size_bytes: request.text.len() as u64,
            text: request.text,
            anchor,
            head,
            created_at_ms,
            updated_at_ms: now,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        let bytes = serde_json::to_vec(&record)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        write_private_atomic(&draft_path(&self.inner.root, &id)?, &bytes)?;
        // Still holding the single lock: prune with the locked helper so this
        // write can never deadlock against its own GC.
        self.prune_drafts_locked(now);
        self.prune_corrupt_backups(now);
        Ok(record.meta())
    }

    pub fn draft_list(&self) -> Result<Vec<DraftMeta>, AppError> {
        if !self.inner.ready {
            return Ok(Vec::new());
        }
        let _state = self.lock()?;
        self.prune_drafts_locked(now_ms());
        let mut metas: Vec<DraftMeta> = read_drafts(&self.inner.root)?
            .into_iter()
            .map(|record| record.meta())
            .collect();
        metas.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
        Ok(metas)
    }

    pub fn draft_read(&self, id: &str) -> Result<DraftRecord, AppError> {
        if !self.inner.ready {
            return Err(unavailable());
        }
        let file = draft_path(&self.inner.root, id)?;
        // Reads share the single lock so a concurrent discard cannot swap the
        // file between validation and read.
        let _state = self.lock()?;
        let text = fs::read_to_string(&file).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(AppErrorCode::NotFound, format!("draft not found: {id}"))
            } else {
                AppError::from_io(&error)
            }
        })?;
        let record: DraftRecord = serde_json::from_str(&text)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        if record.schema_version != DRAFT_SCHEMA_VERSION {
            return Err(AppError::new(
                AppErrorCode::Io,
                format!("unsupported draft schema: {}", record.schema_version),
            ));
        }
        Ok(record)
    }

    pub fn draft_discard(&self, id: &str) -> Result<bool, AppError> {
        if !self.inner.ready {
            return Err(unavailable());
        }
        let file = draft_path(&self.inner.root, id)?;
        let _state = self.lock()?;
        match fs::remove_file(&file) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(AppError::from_io(&error)),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, StoreState>, AppError> {
        self.inner
            .state
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "session store lock is poisoned"))
    }

    /// Runs GC with the lock already held. Never calls `lock()` itself.
    fn gc_locked(&self, state: &mut StoreState, now: i64) -> GcReport {
        let before = state.view.entries.len();
        prune_view(&mut state.view, now);
        let view_entries_removed = before - state.view.entries.len();
        if view_entries_removed > 0 {
            // Best effort: a failed view rewrite must not block draft writes.
            if let Ok(bytes) = fit_view_file(&mut state.view.clone()) {
                let _ = write_private_atomic(&self.inner.root.join(VIEW_STATE_FILE), &bytes);
            }
        }

        let prune = self.prune_drafts_locked(now);
        let corrupt_files_removed = self.prune_corrupt_backups(now);
        GcReport {
            drafts_removed: prune.removed,
            view_entries_removed,
            corrupt_files_removed: corrupt_files_removed + prune.corrupt,
        }
    }

    /// Removes expired, over-count and over-budget drafts. Corrupt files are
    /// deleted rather than quarantined: the body is already unreadable, and
    /// keeping bounded state is more valuable than retaining broken JSON.
    fn prune_drafts_locked(&self, now: i64) -> DraftPrune {
        let mut prune = DraftPrune::default();
        let Ok(entries) = fs::read_dir(self.inner.root.join(DRAFTS_DIR)) else {
            return prune;
        };

        let mut kept: Vec<(String, i64, u64)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let record = fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<DraftRecord>(&text).ok())
                .filter(|record| record.schema_version == DRAFT_SCHEMA_VERSION)
                .filter(|record| {
                    // The file name and the body id must agree; a mismatch is
                    // corrupt state that could never be read back by id.
                    path.file_stem().and_then(|value| value.to_str()) == Some(record.id.as_str())
                });
            match record {
                Some(record) => {
                    let id = path
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string();
                    kept.push((id, record.updated_at_ms, record.size_bytes));
                }
                None => {
                    if fs::remove_file(&path).is_ok() {
                        prune.corrupt += 1;
                    }
                }
            }
        }

        // Expired first, then oldest until the count/budget limits hold.
        let mut expired = Vec::new();
        kept.retain(|(id, updated_at, _)| {
            if now.saturating_sub(*updated_at) <= DRAFT_TTL_MS {
                true
            } else {
                expired.push(id.clone());
                false
            }
        });
        for id in expired {
            if remove_draft_file(&self.inner.root, &id).is_ok() {
                prune.removed += 1;
            }
        }
        kept.sort_by_key(|(_, updated_at, _)| *updated_at);

        let mut total: u64 = kept.iter().map(|(_, _, size)| *size).sum();
        while kept.len() > MAX_DRAFT_COUNT || total > MAX_DRAFT_TOTAL_BYTES {
            let Some((id, _, size)) = kept.first().cloned() else {
                break;
            };
            kept.remove(0);
            total = total.saturating_sub(size);
            if remove_draft_file(&self.inner.root, &id).is_ok() {
                prune.removed += 1;
            }
        }
        prune
    }

    fn prune_corrupt_backups(&self, now: i64) -> usize {
        let Ok(entries) = fs::read_dir(&self.inner.root) else {
            return 0;
        };
        let mut backups: Vec<(SystemTime, PathBuf)> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with(VIEW_STATE_FILE) && name.contains(CORRUPT_SUFFIX)
                    })
            })
            .filter_map(|path| {
                let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok()?;
                Some((modified, path))
            })
            .collect();
        backups.sort_by(|left, right| right.0.cmp(&left.0));

        let cutoff = now.saturating_sub(CORRUPT_TTL_MS);
        let mut removed = 0;
        for (index, (modified, path)) in backups.iter().enumerate() {
            let modified_ms = system_time_ms(*modified);
            if (index >= MAX_CORRUPT_BACKUPS || modified_ms < cutoff)
                && fs::remove_file(path).is_ok()
            {
                removed += 1;
            }
        }
        removed
    }
}

fn unavailable() -> AppError {
    AppError::new(
        AppErrorCode::Io,
        "session storage is unavailable; drafts and view state are disabled",
    )
}

fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

fn system_time_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn clamp_u32(value: i64) -> u32 {
    value.clamp(0, i64::from(u32::MAX)) as u32
}

fn clamp_offset(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-TOP_OFFSET_LIMIT, TOP_OFFSET_LIMIT)
    } else {
        0.0
    }
}

fn clamp_scroll_left(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, SCROLL_LEFT_LIMIT)
    } else {
        0.0
    }
}

fn clamp_view(input: EditorViewStateInput, now: i64) -> EditorViewState {
    EditorViewState {
        anchor: clamp_u32(input.anchor),
        head: clamp_u32(input.head),
        top_pos: clamp_u32(input.top_pos),
        top_offset: clamp_offset(input.top_offset),
        scroll_left: clamp_scroll_left(input.scroll_left),
        live_preview_preferred: input.live_preview_preferred,
        updated_at_ms: now,
    }
}

fn validate_view_key(path: &str) -> Result<(), AppError> {
    if path.is_empty() {
        return Err(invalid_path("view state path must not be empty"));
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(invalid_path("view state path is too long"));
    }
    if path.chars().any(char::is_control) {
        return Err(invalid_path("view state path contains control characters"));
    }
    Ok(())
}

fn parse_draft_kind(value: &str) -> Result<DraftKind, AppError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "untitled" => Ok(DraftKind::Untitled),
        "named" => Ok(DraftKind::Named),
        _ => Err(invalid_path(format!("unknown draft kind: {value}"))),
    }
}

fn normalize_draft_path(kind: DraftKind, path: Option<&str>) -> Result<Option<String>, AppError> {
    match kind {
        DraftKind::Untitled => Ok(None),
        DraftKind::Named => {
            let path = path.ok_or_else(|| invalid_path("named drafts require a path"))?;
            validate_view_key(path)?;
            Ok(Some(path.to_string()))
        }
    }
}

fn truncate_title(title: &str) -> String {
    title
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_TITLE_CHARS)
        .collect()
}

fn validate_draft_text(text: &str) -> Result<(), AppError> {
    if text.len() > MAX_DRAFT_BYTES {
        return Err(AppError::new(
            AppErrorCode::FileTooLarge,
            format!("draft text exceeds {MAX_DRAFT_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn invalid_path(message: impl Into<String>) -> AppError {
    AppError::new(AppErrorCode::InvalidPath, message)
}

/// Parses a draft id and returns `drafts/<canonical-uuid>.json`.
///
/// No caller string is ever joined into the path before UUID validation.
fn draft_path(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    let uuid = Uuid::parse_str(id.trim()).map_err(|_| invalid_path("draft id must be a UUID"))?;
    Ok(root.join(DRAFTS_DIR).join(format!("{uuid}.json")))
}

fn remove_draft_file(root: &Path, id: &str) -> Result<(), AppError> {
    fs::remove_file(draft_path(root, id)?).map_err(|error| AppError::from_io(&error))
}

fn read_drafts(root: &Path) -> Result<Vec<DraftRecord>, AppError> {
    let entries = match fs::read_dir(root.join(DRAFTS_DIR)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::from_io(&error)),
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<DraftRecord>(&text) else {
            continue;
        };
        let stem = path.file_stem().and_then(|value| value.to_str());
        if record.schema_version == DRAFT_SCHEMA_VERSION && stem == Some(record.id.as_str()) {
            records.push(record);
        }
    }
    Ok(records)
}

/// Drops expired entries and the oldest entries above `MAX_VIEW_ENTRIES`.
fn prune_view(view: &mut ViewStateFile, now: i64) {
    view.schema_version = VIEW_STATE_SCHEMA_VERSION;
    view.entries
        .retain(|_, entry| now.saturating_sub(entry.updated_at_ms) <= VIEW_TTL_MS);
    if view.entries.len() <= MAX_VIEW_ENTRIES {
        return;
    }
    let mut keys: Vec<(i64, String)> = view
        .entries
        .iter()
        .map(|(key, entry)| (entry.updated_at_ms, key.clone()))
        .collect();
    keys.sort();
    let excess = view.entries.len() - MAX_VIEW_ENTRIES;
    for (_, key) in keys.into_iter().take(excess) {
        view.entries.remove(&key);
    }
}

/// Serializes the view file and drops the oldest entries until it fits.
fn fit_view_file(view: &mut ViewStateFile) -> Result<Vec<u8>, AppError> {
    loop {
        let bytes = serde_json::to_vec(view)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        if bytes.len() as u64 <= VIEW_FILE_MAX_BYTES {
            return Ok(bytes);
        }
        let oldest = view
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.updated_at_ms)
            .map(|(key, _)| key.clone());
        match oldest {
            Some(key) => {
                view.entries.remove(&key);
            }
            None => {
                return Err(AppError::new(
                    AppErrorCode::FileTooLarge,
                    "view state file exceeds its size limit",
                ));
            }
        }
    }
}

fn load_view(root: &Path) -> ViewStateFile {
    let path = root.join(VIEW_STATE_FILE);
    let Ok(metadata) = fs::metadata(&path) else {
        return ViewStateFile::default();
    };
    if !metadata.is_file() {
        return ViewStateFile::default();
    }
    if metadata.len() > VIEW_FILE_MAX_BYTES {
        backup_corrupt(root, &path);
        return ViewStateFile::default();
    }
    match fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<ViewStateFile>(&text).ok())
    {
        Some(view) if view.schema_version == VIEW_STATE_SCHEMA_VERSION => view,
        _ => {
            backup_corrupt(root, &path);
            ViewStateFile::default()
        }
    }
}

fn backup_corrupt(root: &Path, path: &Path) {
    let target = root.join(format!("{VIEW_STATE_FILE}{CORRUPT_SUFFIX}{}", now_ms()));
    if fs::rename(path, &target).is_ok() {
        let _ = set_file_private(&target);
    }
}

#[cfg(unix)]
fn set_dir_private(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| AppError::from_io(&error))
}

#[cfg(not(unix))]
fn set_dir_private(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(unix)]
fn set_file_private(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_file_private(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Atomic write that restricts the temp file before any bytes are written.
fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| AppError::from_io(&error))?;
    // Set permissions before `write_all`: the plaintext draft must never exist
    // on disk with the process umask permissions, even for a few milliseconds.
    if let Err(error) = restrict_file(&file) {
        let _ = file.discard();
        return Err(AppError::from_io(&error));
    }
    file.write_all(bytes)
        .map_err(|error| AppError::from_io(&error))?;
    file.commit().map_err(|error| AppError::from_io(&error))
}

#[cfg(unix)]
fn restrict_file(file: &AtomicWriteFile) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_file: &AtomicWriteFile) -> std::io::Result<()> {
    Ok(())
}
