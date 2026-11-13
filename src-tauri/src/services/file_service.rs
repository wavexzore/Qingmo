use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, ReadOnlyReason, TextFormat};
use crate::services::encoding;
use crate::services::file_identity::{
    identity_from_handle, identity_from_metadata, observe_path, same_identity, FileIdentity,
    FileObservation,
};

/// The single document-size boundary shared by open/save/index/watcher.
pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
/// Backwards-compatible aliases; all three point at the same limit.
pub const MAX_OPEN_BYTES: u64 = MAX_DOCUMENT_BYTES;
pub const MAX_WRITE_BYTES: u64 = MAX_DOCUMENT_BYTES;
pub const MAX_FILE_BYTES: u64 = MAX_DOCUMENT_BYTES;

/// Markdown containers accepted by `document_open`.
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

/// Audio containers accepted by the meeting pipeline.
///
/// This is deliberately separate from [`ensure_supported_extension`]: audio
/// files must still be rejected by `document_open`, while `meeting_start`
/// accepts them without touching the document registry.
pub fn ensure_supported_audio(path: &Path) -> Result<(), AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("m4a" | "mp4" | "wav" | "mp3" | "flac") => Ok(()),
        _ => Err(AppError::new(
            AppErrorCode::AudioUnsupported,
            format!("unsupported audio extension: {}", path.display()),
        )),
    }
}

#[derive(Debug)]
pub struct ParsedFile {
    pub text: String,
    pub format: TextFormat,
    pub mixed_eol: bool,
    pub hash: String,
    pub size: u64,
    pub text_units: u64,
    pub mtime_ms: i64,
    pub read_only: bool,
    pub read_only_reason: Option<ReadOnlyReason>,
    pub identity: Option<FileIdentity>,
    pub parent_identity: Option<FileIdentity>,
}

impl ParsedFile {
    pub fn into_payload(self, doc_token: &str, path: String) -> FilePayload {
        FilePayload {
            doc_token: doc_token.to_string(),
            path,
            text: self.text,
            format: self.format,
            mixed_eol: self.mixed_eol,
            hash: self.hash,
            size: self.size,
            text_units: self.text_units,
            mtime_ms: self.mtime_ms,
            read_only: self.read_only,
            read_only_reason: self.read_only_reason,
        }
    }
}

/// Raw verified read result shared by open, save, reload and Save As.
#[derive(Debug)]
pub struct RawFile {
    pub bytes: Vec<u8>,
    pub format: TextFormat,
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub identity: Option<FileIdentity>,
    pub parent_identity: Option<FileIdentity>,
}

pub struct FileService;

impl FileService {
    /// Reads the canonical target through one open handle and returns a fully
    /// validated, LF-normalized document. It never returns partial content.
    pub fn read(path: &Path) -> Result<ParsedFile, AppError> {
        let raw = Self::read_raw(path, MAX_DOCUMENT_BYTES, None)?;
        Self::parse(raw, path)
    }

    pub fn parse(raw: RawFile, path: &Path) -> Result<ParsedFile, AppError> {
        let decoded = encoding::decode(&raw.bytes)?;
        let text_units = decoded.text.encode_utf16().count() as u64;
        let is_mdx = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mdx"));
        let read_only_reason = if is_mdx {
            Some(ReadOnlyReason::Mdx)
        } else if decoded.mixed_eol {
            Some(ReadOnlyReason::MixedEol)
        } else {
            None
        };

        Ok(ParsedFile {
            text: decoded.text,
            format: raw.format,
            mixed_eol: decoded.mixed_eol,
            hash: raw.hash,
            size: raw.size,
            text_units,
            mtime_ms: raw.mtime_ms,
            read_only: read_only_reason.is_some(),
            read_only_reason,
            identity: raw.identity,
            parent_identity: raw.parent_identity,
        })
    }

    /// Verified read: rejects a symlink final component, anchors the parent
    /// identity, and re-checks size/mtime/ctime after the bytes are read.
    pub fn read_raw(
        path: &Path,
        limit: u64,
        expected_parent: Option<&FileIdentity>,
    ) -> Result<RawFile, AppError> {
        let parent = path.parent().ok_or_else(|| {
            AppError::new(
                AppErrorCode::InvalidPath,
                "document has no parent directory",
            )
        })?;
        let parent_observation = observe_path(parent)?;
        if let Some(expected) = expected_parent {
            if !same_parent(expected, &parent_observation) {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "parent directory changed while opening the document",
                ));
            }
        }

        let link = std::fs::symlink_metadata(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(
                    AppErrorCode::NotFound,
                    format!("file not found: {}", path.display()),
                )
            } else {
                AppError::from_io(&error)
            }
        })?;
        if link.file_type().is_symlink() {
            return Err(AppError::new(
                AppErrorCode::InvalidPath,
                format!("symbolic links are not accepted: {}", path.display()),
            ));
        }
        if !link.is_file() {
            return Err(AppError::new(
                AppErrorCode::NotAFile,
                format!("not a regular file: {}", path.display()),
            ));
        }

        let mut last_conflict = None;
        for _attempt in 0..2 {
            match Self::read_raw_once(path, limit, &link) {
                Ok(raw) => return Ok(raw),
                Err(error) if error.code == AppErrorCode::Conflict => {
                    last_conflict = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_conflict.unwrap_or_else(|| {
            AppError::new(
                AppErrorCode::Conflict,
                "file changed while reading the document",
            )
        }))
    }

    fn read_raw_once(
        path: &Path,
        limit: u64,
        link_metadata: &std::fs::Metadata,
    ) -> Result<RawFile, AppError> {
        let mut file = open_read_no_follow(path)?;
        let metadata = file.metadata().map_err(|error| AppError::from_io(&error))?;
        if !metadata.is_file() {
            return Err(AppError::new(
                AppErrorCode::NotAFile,
                format!("not a regular file: {}", path.display()),
            ));
        }

        let handle_identity = identity_from_handle(&file)?;
        let before_identity = identity_from_metadata(link_metadata);
        if let (Some(handle), Some(before)) = (&handle_identity, &before_identity) {
            if !same_identity(handle, before) {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "file changed while opening the document",
                ));
            }
        }

        #[cfg(windows)]
        {
            if let Some(handle) = handle_identity.as_ref() {
                let path_after = crate::services::file_identity::file_identity(path)?;
                if let Some(path_after) = path_after.as_ref() {
                    if !same_identity(handle, path_after) {
                        return Err(AppError::new(
                            AppErrorCode::Conflict,
                            "path changed while opening the document",
                        ));
                    }
                }
            }
        }

        if metadata.len() > limit {
            return Err(file_too_large());
        }

        let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
        file.by_ref()
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| AppError::from_io(&error))?;
        if bytes.len() as u64 != metadata.len() {
            return Err(AppError::new(
                AppErrorCode::Conflict,
                "file length changed while reading the document",
            ));
        }
        if bytes.len() as u64 > limit {
            return Err(file_too_large());
        }

        let after = file.metadata().map_err(|error| AppError::from_io(&error))?;
        if after.len() != metadata.len()
            || after.modified().ok() != metadata.modified().ok()
            || !same_platform_times(&after, &metadata)
        {
            return Err(AppError::new(
                AppErrorCode::Conflict,
                "file changed while reading the document",
            ));
        }

        let hash = blake3::hash(&bytes).to_hex().to_string();
        let decoded = encoding::decode(&bytes)?;
        let parent_identity = match observe_path(path.parent().unwrap_or_else(|| Path::new(".")))? {
            FileObservation::Present(identity) => Some(identity),
            FileObservation::Unavailable | FileObservation::Absent => None,
        };

        Ok(RawFile {
            bytes,
            format: decoded.format,
            hash,
            size: metadata.len(),
            mtime_ms: mtime_ms(&metadata),
            identity: handle_identity,
            parent_identity,
        })
    }
}

fn same_parent(expected: &FileIdentity, observed: &FileObservation) -> bool {
    match observed {
        FileObservation::Present(actual) => same_identity(expected, actual),
        FileObservation::Unavailable | FileObservation::Absent => false,
    }
}

#[cfg(unix)]
fn open_read_no_follow(path: &Path) -> Result<File, AppError> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| AppError::from_io(&error))
}

#[cfg(not(unix))]
fn open_read_no_follow(path: &Path) -> Result<File, AppError> {
    File::open(path).map_err(|error| AppError::from_io(&error))
}

#[cfg(unix)]
fn same_platform_times(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(not(unix))]
fn same_platform_times(_left: &std::fs::Metadata, _right: &std::fs::Metadata) -> bool {
    true
}

fn file_too_large() -> AppError {
    AppError::new(
        AppErrorCode::FileTooLarge,
        format!("file exceeds the {MAX_DOCUMENT_BYTES} byte document limit"),
    )
    .with_details(serde_json::json!({
        "operation": "open",
        "limitBytes": MAX_DOCUMENT_BYTES,
    }))
}

pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
