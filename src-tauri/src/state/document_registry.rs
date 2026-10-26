use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, ReadOnlyReason, TextFormat};
use crate::services::file_service::{FileService, ParsedFile};

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
    fn from_parsed(parsed: &ParsedFile) -> Self {
        Self {
            format: parsed.format.clone(),
            read_only: parsed.read_only_reason,
            base_hash: parsed.hash.clone(),
            disk_size: parsed.size,
            mtime_ms: parsed.mtime_ms,
        }
    }
}

#[derive(Debug)]
pub struct DocumentRecord {
    /// The path returned by the native dialog. It may be a symlink.
    pub raw_selected: PathBuf,
    /// The canonical target actually read and written.
    pub canonical_target: PathBuf,
    /// Serializes saves and keeps base hash/metadata atomic.
    pub state: Mutex<DocState>,
}

impl DocumentRecord {
    pub fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, DocState>, AppError> {
        self.state
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document state lock poisoned"))
    }
}

#[derive(Debug, Default)]
struct RegistryInner {
    docs: RwLock<HashMap<DocToken, Arc<DocumentRecord>>>,
}

/// P1 keeps exactly one active document. A successful `open` invalidates the
/// previous token before the new one is returned.
#[derive(Debug, Clone, Default)]
pub struct DocumentRegistry {
    inner: Arc<RegistryInner>,
}

impl DocumentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens a path that was already chosen by the Rust-side dialog.
    /// This is public for integration tests; it is not an IPC command and the
    /// frontend cannot supply a path.
    pub fn open_path(&self, selected: PathBuf) -> Result<FilePayload, AppError> {
        ensure_supported_extension(&selected)?;

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

        let parsed = FileService::read(&canonical_target)?;
        let token = DocToken::new();
        let record = Arc::new(DocumentRecord {
            raw_selected: selected,
            canonical_target: canonical_target.clone(),
            state: Mutex::new(DocState::from_parsed(&parsed)),
        });

        let mut docs = self
            .inner
            .docs
            .write()
            .map_err(|_| AppError::new(AppErrorCode::Io, "document registry lock poisoned"))?;
        docs.clear();
        docs.insert(token.clone(), record);

        Ok(parsed.into_payload(token.as_str(), path_to_display(&canonical_target)))
    }

    pub fn reload(&self, token: &str) -> Result<FilePayload, AppError> {
        let record = self.get(token)?;

        let current_target = std::fs::canonicalize(&record.raw_selected).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(
                    AppErrorCode::NotFound,
                    format!("file not found: {}", record.raw_selected.display()),
                )
            } else {
                AppError::from_io(&error)
            }
        })?;

        if current_target != record.canonical_target {
            return Err(AppError::new(
                AppErrorCode::OutsideScope,
                "the selected path now points to a different file",
            ));
        }

        ensure_supported_extension(&record.raw_selected)?;
        let parsed = FileService::read(&record.canonical_target)?;

        {
            let mut state = record.lock_state()?;
            state.format = parsed.format.clone();
            state.read_only = parsed.read_only_reason;
            state.base_hash = parsed.hash.clone();
            state.disk_size = parsed.size;
            state.mtime_ms = parsed.mtime_ms;
        }

        Ok(parsed.into_payload(token, path_to_display(&record.canonical_target)))
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
