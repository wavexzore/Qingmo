use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use atomic_write_file::AtomicWriteFile;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{ConflictDetails, LineEnding, SaveResult, TextEncoding, TextFormat};
use crate::services::file_lock::{FileLockGuard, FileLockStore};
use crate::services::file_service::{mtime_ms, MAX_WRITE_BYTES};
use crate::services::history_store::HistoryStore;
use crate::state::DocumentRecord;

struct CurrentDisk {
    hash: String,
    size: u64,
    mtime_ms: i64,
    bytes: Vec<u8>,
}

/// The only implementation that writes document bytes to disk.
///
/// It always re-hashes the current file while holding the document state lock;
/// there is no mtime/size fast path. The caller cannot supply a format, path,
/// or a boolean force flag.
pub struct AtomicWriter;

impl AtomicWriter {
    /// Compatibility entry point used by unit tests that do not configure app
    /// services. Production commands use [`Self::write_with_services`].
    pub fn write(
        record: &DocumentRecord,
        text_lf: &str,
        expected_current_hash: Option<&str>,
    ) -> Result<SaveResult, AppError> {
        Self::write_with_services(record, text_lf, expected_current_hash, None, None, false)
    }

    /// The single write path with optional sidecar lock, history capture and a
    /// format override used by history restore.
    pub fn write_with_services(
        record: &DocumentRecord,
        text_lf: &str,
        expected_current_hash: Option<&str>,
        history: Option<&HistoryStore>,
        locks: Option<&FileLockStore>,
        force_history: bool,
    ) -> Result<SaveResult, AppError> {
        Self::write_with_format(
            record,
            text_lf,
            expected_current_hash,
            None,
            history,
            locks,
            force_history,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn write_with_format(
        record: &DocumentRecord,
        text_lf: &str,
        expected_current_hash: Option<&str>,
        format_override: Option<&TextFormat>,
        history: Option<&HistoryStore>,
        locks: Option<&FileLockStore>,
        force_history: bool,
    ) -> Result<SaveResult, AppError> {
        // Global lock order: path FileLock -> registry map (already resolved by
        // the caller) -> DocState -> HistoryStore internal mutex.
        let _lock: Option<FileLockGuard> = locks
            .map(|store| store.acquire(&record.canonical_target))
            .transpose()?;
        let mut state = record.lock_state()?;

        if let Some(reason) = state.read_only {
            return Err(AppError::new(
                AppErrorCode::ReadOnly,
                format!("document is read-only: {reason:?}"),
            ));
        }

        let current = read_current(record)?;
        if current.hash != state.base_hash {
            let confirmed = expected_current_hash.is_some_and(|expected| expected == current.hash);
            if !confirmed {
                return Err(conflict_error(&current));
            }
        }

        validate_text(text_lf)?;
        let format = format_override.unwrap_or(&state.format).clone();
        let encoded = encode(&format, text_lf)?;
        let new_hash = blake3::hash(&encoded).to_hex().to_string();

        if current.hash == new_hash && current.size == encoded.len() as u64 {
            // The user confirmed a version whose bytes are already identical;
            // refresh the base metadata without touching the file.
            state.base_hash = current.hash.clone();
            state.disk_size = current.size;
            state.mtime_ms = current.mtime_ms;
            state.format = format;
            return Ok(SaveResult {
                hash: current.hash,
                size: current.size,
                mtime_ms: current.mtime_ms,
            });
        }

        if let Some(history) = history {
            if let Err(error) = history.capture(
                &record.canonical_target,
                &current.bytes,
                &current.hash,
                force_history,
            ) {
                // History is a safety net, never a save blocker.
                tracing::warn!(%error, "failed to capture document history");
            }
        }

        let result = write_formatted(&record.canonical_target, &format, text_lf)?;
        state.base_hash = result.hash.clone();
        state.disk_size = result.size;
        state.mtime_ms = result.mtime_ms;
        state.format = format;
        Ok(result)
    }
}

/// Encodes and atomically writes text using an explicit format.
///
/// The save-as path calls this after the native dialog has already confirmed
/// the target. It shares validation/encoding with the normal document save, so
/// a new file cannot bypass the LF/NUL/10MiB rules.
pub(crate) fn write_formatted(
    path: &Path,
    format: &TextFormat,
    text_lf: &str,
) -> Result<SaveResult, AppError> {
    validate_text(text_lf)?;
    if encoded_len(format, text_lf)? > MAX_WRITE_BYTES {
        return Err(file_too_large());
    }
    let encoded = encode(format, text_lf)?;

    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| AppError::from_io(&error))?;
    file.write_all(&encoded)
        .map_err(|error| AppError::from_io(&error))?;
    fault_injection_after_temp();
    file.commit().map_err(|error| AppError::from_io(&error))?;

    let size = encoded.len() as u64;
    let mtime_ms = std::fs::metadata(path)
        .map(|metadata| mtime_ms(&metadata))
        .unwrap_or(0);

    Ok(SaveResult {
        hash: blake3::hash(&encoded).to_hex().to_string(),
        size,
        mtime_ms,
    })
}

fn read_current(record: &DocumentRecord) -> Result<CurrentDisk, AppError> {
    // See FileService::read: classify directories before opening them so the
    // same NOT_A_FILE contract holds on Windows.
    let path_metadata = std::fs::metadata(&record.canonical_target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                AppErrorCode::NotFound,
                format!("file not found: {}", record.canonical_target.display()),
            )
        } else {
            AppError::from_io(&error)
        }
    })?;
    if !path_metadata.is_file() {
        return Err(AppError::new(
            AppErrorCode::NotAFile,
            format!("not a regular file: {}", record.canonical_target.display()),
        ));
    }

    let mut file = File::open(&record.canonical_target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                AppErrorCode::NotFound,
                format!("file not found: {}", record.canonical_target.display()),
            )
        } else {
            AppError::from_io(&error)
        }
    })?;

    let metadata = file.metadata().map_err(|error| AppError::from_io(&error))?;
    // A file that grew past the write ceiling cannot be the base of a save.
    // Check the size before reading so a multi-gigabyte external append does
    // not occupy the path lock while it is hashed.
    if metadata.len() > MAX_WRITE_BYTES {
        return Err(file_too_large());
    }

    let mut hasher = blake3::Hasher::new();
    let mut size = 0u64;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_WRITE_BYTES) as usize);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| AppError::from_io(&error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes.extend_from_slice(&buffer[..read]);
        size += read as u64;
        if size > MAX_WRITE_BYTES {
            return Err(file_too_large());
        }
    }

    Ok(CurrentDisk {
        hash: hasher.finalize().to_hex().to_string(),
        size,
        mtime_ms: mtime_ms(&metadata),
        bytes,
    })
}

fn validate_text(text_lf: &str) -> Result<(), AppError> {
    if text_lf.contains('\r') {
        return Err(AppError::new(
            AppErrorCode::Io,
            "save text must use LF-only line endings",
        ));
    }
    if text_lf.contains('\0') {
        return Err(AppError::new(
            AppErrorCode::Io,
            "save text must not contain NUL characters",
        ));
    }
    Ok(())
}

/// Exact encoded size without allocating the output buffer.
fn encoded_len(format: &TextFormat, text_lf: &str) -> Result<u64, AppError> {
    let newline_count = text_lf.bytes().filter(|byte| *byte == b'\n').count() as u64;
    let crlf_extra = if format.eol == LineEnding::Crlf {
        newline_count
    } else {
        0
    };
    match format.encoding {
        TextEncoding::Utf8 => {
            let bom = if format.has_bom { 3 } else { 0 };
            Ok(bom + text_lf.len() as u64 + crlf_extra)
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if !format.has_bom {
                return Err(AppError::new(
                    AppErrorCode::UnsupportedEncoding,
                    "UTF-16 document has no BOM; refusing to write an ambiguous file",
                ));
            }
            let units = text_lf.encode_utf16().count() as u64;
            Ok(2 + units * 2 + crlf_extra * 2)
        }
    }
}

fn encode(format: &TextFormat, text_lf: &str) -> Result<Vec<u8>, AppError> {
    let restored = restore_line_endings(text_lf, format.eol);
    let mut bytes = Vec::new();

    match format.encoding {
        TextEncoding::Utf8 => {
            if format.has_bom {
                bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            bytes.extend_from_slice(restored.as_bytes());
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if !format.has_bom {
                return Err(AppError::new(
                    AppErrorCode::UnsupportedEncoding,
                    "UTF-16 document has no BOM; refusing to write an ambiguous file",
                ));
            }
            let little_endian = format.encoding == TextEncoding::Utf16Le;
            if little_endian {
                bytes.extend_from_slice(&[0xFF, 0xFE]);
            } else {
                bytes.extend_from_slice(&[0xFE, 0xFF]);
            }
            for unit in restored.encode_utf16() {
                if little_endian {
                    bytes.extend_from_slice(&unit.to_le_bytes());
                } else {
                    bytes.extend_from_slice(&unit.to_be_bytes());
                }
            }
        }
    }

    if bytes.len() as u64 > MAX_WRITE_BYTES {
        return Err(file_too_large());
    }
    Ok(bytes)
}

fn restore_line_endings(text_lf: &str, eol: LineEnding) -> String {
    match eol {
        LineEnding::Lf => text_lf.to_owned(),
        LineEnding::Crlf => text_lf.replace('\n', "\r\n"),
        LineEnding::Cr => text_lf.replace('\n', "\r"),
    }
}

fn conflict_error(current: &CurrentDisk) -> AppError {
    let details = ConflictDetails {
        current_hash: current.hash.clone(),
        current_mtime_ms: current.mtime_ms,
        current_size: current.size,
    };
    AppError::new(
        AppErrorCode::Conflict,
        "file changed on disk since it was opened",
    )
    .with_details(serde_json::to_value(details).unwrap_or(serde_json::Value::Null))
}

fn file_too_large() -> AppError {
    AppError::new(
        AppErrorCode::FileTooLarge,
        format!("file exceeds the {MAX_WRITE_BYTES} byte save limit"),
    )
    .with_details(serde_json::json!({
        "operation": "save",
        "limitBytes": MAX_WRITE_BYTES,
    }))
}

/// Debug-build-only fault injection used by
/// `scripts/fault-injection/kill-after-temp.sh`. Production builds compile
/// this to an empty function.
#[cfg(debug_assertions)]
fn fault_injection_after_temp() {
    if let Some(millis) = std::env::var("QINGMO_FAULT_AFTER_TEMP_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        eprintln!("QINGMO_FAULT_AFTER_TEMP");
        std::thread::sleep(std::time::Duration::from_millis(millis));
    }
}

#[cfg(not(debug_assertions))]
fn fault_injection_after_temp() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_each_line_ending_at_the_string_level() {
        assert_eq!(restore_line_endings("a\nb\n", LineEnding::Lf), "a\nb\n");
        assert_eq!(
            restore_line_endings("a\nb\n", LineEnding::Crlf),
            "a\r\nb\r\n"
        );
        assert_eq!(restore_line_endings("a\nb\n", LineEnding::Cr), "a\rb\r");
    }

    #[test]
    fn rejects_cr_nul_and_oversize_text() {
        assert_eq!(
            validate_text("a\r\nb").expect_err("CR must fail").code,
            AppErrorCode::Io
        );
        assert_eq!(
            validate_text("a\0b").expect_err("NUL must fail").code,
            AppErrorCode::Io
        );
        let oversized = "a".repeat(MAX_WRITE_BYTES as usize + 1);
        let format = TextFormat {
            encoding: TextEncoding::Utf8,
            has_bom: false,
            eol: LineEnding::Lf,
        };
        assert_eq!(
            encode(&format, &oversized)
                .expect_err("oversize must fail")
                .code,
            AppErrorCode::FileTooLarge
        );
    }

    #[test]
    fn encodes_utf8_and_utf16_exactly() {
        let utf8 = TextFormat {
            encoding: TextEncoding::Utf8,
            has_bom: false,
            eol: LineEnding::Crlf,
        };
        assert_eq!(encode(&utf8, "a\nb").expect("UTF-8 must encode"), b"a\r\nb");

        let utf16le = TextFormat {
            encoding: TextEncoding::Utf16Le,
            has_bom: true,
            eol: LineEnding::Lf,
        };
        assert_eq!(
            encode(&utf16le, "hi").expect("UTF-16LE must encode"),
            vec![0xFF, 0xFE, b'h', 0, b'i', 0]
        );

        let utf16be = TextFormat {
            encoding: TextEncoding::Utf16Be,
            has_bom: true,
            eol: LineEnding::Lf,
        };
        assert_eq!(
            encode(&utf16be, "hi").expect("UTF-16BE must encode"),
            vec![0xFE, 0xFF, 0, b'h', 0, b'i']
        );
    }

    #[test]
    fn refuses_utf16_without_a_bom() {
        let format = TextFormat {
            encoding: TextEncoding::Utf16Le,
            has_bom: false,
            eol: LineEnding::Lf,
        };
        assert_eq!(
            encode(&format, "hi")
                .expect_err("missing BOM must fail")
                .code,
            AppErrorCode::UnsupportedEncoding
        );
    }
}
