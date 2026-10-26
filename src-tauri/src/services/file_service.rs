use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, ReadOnlyReason, TextFormat};
use crate::services::encoding;

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

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

pub struct FileService;

impl FileService {
    /// Reads the canonical target through one open handle and returns a fully
    /// validated, LF-normalized document. It never returns partial content.
    pub fn read(path: &Path) -> Result<ParsedFile, AppError> {
        let file = File::open(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(
                    AppErrorCode::NotFound,
                    format!("file not found: {}", path.display()),
                )
            } else {
                AppError::from_io(&error)
            }
        })?;

        let metadata = file.metadata().map_err(|error| AppError::from_io(&error))?;
        if !metadata.is_file() {
            return Err(AppError::new(
                AppErrorCode::NotAFile,
                format!("not a regular file: {}", path.display()),
            ));
        }

        if metadata.len() > MAX_FILE_BYTES {
            return Err(file_too_large());
        }

        let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| AppError::from_io(&error))?;

        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(file_too_large());
        }

        let hash = blake3::hash(&bytes).to_hex().to_string();
        let decoded = encoding::decode(&bytes)?;
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
            format: decoded.format,
            mixed_eol: decoded.mixed_eol,
            hash,
            size: bytes.len() as u64,
            text_units,
            mtime_ms: mtime_ms(&metadata),
            read_only: read_only_reason.is_some(),
            read_only_reason,
        })
    }
}

fn file_too_large() -> AppError {
    AppError::new(
        AppErrorCode::FileTooLarge,
        format!("file exceeds {MAX_FILE_BYTES} bytes"),
    )
}

pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
