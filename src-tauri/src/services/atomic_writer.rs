use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use atomic_write_file::AtomicWriteFile;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{ConflictDetails, LineEnding, SaveResult, TextEncoding, TextFormat};
use crate::services::file_service::{mtime_ms, MAX_FILE_BYTES};
use crate::state::DocumentRecord;

struct CurrentDisk {
    hash: String,
    size: u64,
    mtime_ms: i64,
}

/// The only implementation that writes document bytes to disk.
///
/// It always re-hashes the current file while holding the document state lock;
/// there is no mtime/size fast path. The caller cannot supply a format, path,
/// or a boolean force flag.
pub struct AtomicWriter;

impl AtomicWriter {
    pub fn write(
        record: &DocumentRecord,
        text_lf: &str,
        expected_current_hash: Option<&str>,
    ) -> Result<SaveResult, AppError> {
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
        let encoded = encode(&state.format, text_lf)?;
        let new_hash = blake3::hash(&encoded).to_hex().to_string();

        if current.hash == new_hash && current.size == encoded.len() as u64 {
            // The user confirmed a version whose bytes are already identical;
            // refresh the base metadata without touching the file.
            state.base_hash = current.hash.clone();
            state.disk_size = current.size;
            state.mtime_ms = current.mtime_ms;
            return Ok(SaveResult {
                hash: current.hash,
                size: current.size,
                mtime_ms: current.mtime_ms,
            });
        }

        let result = write_formatted(&record.canonical_target, &state.format, text_lf)?;
        state.base_hash = result.hash.clone();
        state.disk_size = result.size;
        state.mtime_ms = result.mtime_ms;
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
    if !metadata.is_file() {
        return Err(AppError::new(
            AppErrorCode::NotAFile,
            format!("not a regular file: {}", record.canonical_target.display()),
        ));
    }

    let mut hasher = blake3::Hasher::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| AppError::from_io(&error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }

    Ok(CurrentDisk {
        hash: hasher.finalize().to_hex().to_string(),
        size,
        mtime_ms: mtime_ms(&metadata),
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
    if text_lf.len() as u64 > MAX_FILE_BYTES {
        return Err(file_too_large());
    }
    Ok(())
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

    if bytes.len() as u64 > MAX_FILE_BYTES {
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
        format!("file exceeds {MAX_FILE_BYTES} bytes"),
    )
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
        let oversized = "a".repeat(MAX_FILE_BYTES as usize + 1);
        assert_eq!(
            validate_text(&oversized)
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
