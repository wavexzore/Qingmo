use std::fs::File;
use std::io::Write;
use std::path::Path;

use atomic_write_file::AtomicWriteFile;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{ConflictDetails, LineEnding, SaveResult, TextEncoding, TextFormat};
use crate::services::file_identity::{
    identity_from_handle, identity_from_metadata, observe_path, same_identity, FileIdentity,
    FileObservation,
};
use crate::services::file_lock::{FileLockGuard, FileLockStore};
use crate::services::file_service::{mtime_ms, FileService, MAX_DOCUMENT_BYTES, MAX_WRITE_BYTES};
use crate::services::history_store::HistoryStore;
use crate::state::DocumentRecord;

struct CurrentDisk {
    hash: String,
    size: u64,
    mtime_ms: i64,
    bytes: Vec<u8>,
    identity: Option<FileIdentity>,
}

/// Anchor captured by `read_current`; the writer refuses to overwrite a
/// different instance when the target changed in between.
#[derive(Debug, Clone)]
pub enum ExpectedTarget {
    Existing {
        identity: Option<FileIdentity>,
        hash: String,
        size: u64,
        mtime_ms: i64,
    },
    Absent,
}

#[derive(Debug, Clone)]
pub struct WriteOutcome {
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub identity: Option<FileIdentity>,
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

    /// Reads while holding the cross-process path lock.
    ///
    /// Reload must not race a save from another process; the lock is the same
    /// one `write_with_services` takes.
    pub fn with_read_lock<T>(
        locks: Option<&FileLockStore>,
        path: &Path,
        read: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let _lock = locks.map(|store| store.acquire(path)).transpose()?;
        read()
    }

    /// Writes a brand-new Save As target under the one FileLock owner.
    pub fn write_new(
        locks: Option<&FileLockStore>,
        path: &Path,
        format: &TextFormat,
        text_lf: &str,
        expected: &ExpectedTarget,
        expected_parent: Option<&FileIdentity>,
    ) -> Result<WriteOutcome, AppError> {
        let _lock = locks.map(|store| store.acquire(path)).transpose()?;
        write_formatted(path, format, text_lf, expected, expected_parent)
    }

    /// Writes one history snapshot over the current disk version.
    ///
    /// The expected target comes from the same locked `read_current` used by a
    /// normal save; the caller cannot supply a path or an unverified version.
    pub fn restore_with_services(
        record: &DocumentRecord,
        format: &TextFormat,
        text_lf: &str,
        locks: Option<&FileLockStore>,
    ) -> Result<SaveResult, AppError> {
        let paths = record.paths()?;
        let _lock: Option<FileLockGuard> = locks
            .map(|store| store.acquire(&paths.canonical_target))
            .transpose()?;
        let mut state = record.lock_state()?;
        let current = read_current(record, &paths)?;
        let expected = ExpectedTarget::Existing {
            identity: current.identity.clone(),
            hash: current.hash.clone(),
            size: current.size,
            mtime_ms: current.mtime_ms,
        };
        let result = write_formatted(
            &paths.canonical_target,
            format,
            text_lf,
            &expected,
            paths.parent_identity.as_ref(),
        )?;
        state.base_hash = result.hash.clone();
        state.disk_size = result.size;
        state.mtime_ms = result.mtime_ms;
        state.format = format.clone();
        Ok(SaveResult {
            hash: result.hash,
            size: result.size,
            mtime_ms: result.mtime_ms,
            doc_token: String::new(),
            generation: paths.generation,
        })
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
        let paths = record.paths()?;
        let _lock: Option<FileLockGuard> = locks
            .map(|store| store.acquire(&paths.canonical_target))
            .transpose()?;
        let mut state = record.lock_state()?;

        if let Some(reason) = state.read_only {
            return Err(AppError::new(
                AppErrorCode::ReadOnly,
                format!("document is read-only: {reason:?}"),
            ));
        }

        let current = read_current(record, &paths)?;
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
                doc_token: String::new(),
                generation: paths.generation,
            });
        }

        if let Some(history) = history {
            if let Err(error) = history.capture_for(
                record.document_id().as_ref(),
                &paths.canonical_target,
                &current.bytes,
                &current.hash,
                force_history,
            ) {
                // History is a safety net, never a save blocker.
                tracing::warn!(%error, "failed to capture document history");
            }
        }

        let result = {
            let expected = ExpectedTarget::Existing {
                identity: current.identity.clone(),
                hash: current.hash.clone(),
                size: current.size,
                mtime_ms: current.mtime_ms,
            };
            write_formatted(
                &paths.canonical_target,
                &format,
                text_lf,
                &expected,
                paths.parent_identity.as_ref(),
            )?
        };
        let save_result = SaveResult {
            hash: result.hash.clone(),
            size: result.size,
            mtime_ms: result.mtime_ms,
            doc_token: String::new(),
            generation: paths.generation,
        };
        state.base_hash = result.hash;
        state.disk_size = result.size;
        state.mtime_ms = result.mtime_ms;
        state.format = format;
        Ok(save_result)
    }
}

/// Encodes and atomically writes text using an explicit format.
///
/// The save-as path calls this after the native dialog has already confirmed
/// the target. It shares validation/encoding with the normal document save, so
/// a new file cannot bypass the LF/NUL/16MiB rules.
pub(crate) fn write_formatted(
    path: &Path,
    format: &TextFormat,
    text_lf: &str,
    expected: &ExpectedTarget,
    expected_parent: Option<&FileIdentity>,
) -> Result<WriteOutcome, AppError> {
    validate_text(text_lf)?;
    if encoded_len(format, text_lf)? > MAX_WRITE_BYTES {
        return Err(file_too_large());
    }
    let encoded = encode(format, text_lf)?;
    let parent = path.parent().ok_or_else(|| {
        AppError::new(
            AppErrorCode::InvalidPath,
            "document has no parent directory",
        )
    })?;
    let parent_before = observe_path(parent)?;
    if let Some(expected_parent) = expected_parent {
        if !matches!(&parent_before, FileObservation::Present(actual) if same_identity(expected_parent, actual))
        {
            return Err(AppError::new(
                AppErrorCode::Conflict,
                "parent directory changed before saving",
            ));
        }
    }

    let target_before = observe_target(path)?;
    check_expected_target(&target_before, expected, path, expected_parent)?;

    let mut atomic = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| AppError::from_io(&error))?;

    #[cfg(unix)]
    if let Some(expected_parent) = expected_parent {
        let directory_identity = atomic_directory_identity(&atomic)?;
        match directory_identity {
            Some(actual) if same_identity(expected_parent, &actual) => {}
            _ => {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "parent directory changed before saving",
                ))
            }
        }
    }

    let target_after_open = observe_target(path)?;
    if target_changed(&target_before, &target_after_open, expected) {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "file changed while saving",
        ));
    }

    atomic
        .write_all(&encoded)
        .map_err(|error| AppError::from_io(&error))?;
    fault_injection_after_temp();

    let temp_metadata = atomic
        .as_file()
        .metadata()
        .map_err(|error| AppError::from_io(&error))?;
    let temp_identity = identity_from_handle(atomic.as_file())?;
    let temp_mtime_ms = mtime_ms(&temp_metadata);
    atomic
        .as_file()
        .sync_all()
        .map_err(|error| AppError::from_io(&error))?;

    #[cfg(unix)]
    if let Some(expected_parent) = expected_parent {
        let directory_identity = atomic_directory_identity(&atomic)?;
        match directory_identity {
            Some(actual) if same_identity(expected_parent, &actual) => {}
            _ => {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "parent directory changed before commit",
                ))
            }
        }
    }
    let target_before_commit = observe_target(path)?;
    if target_changed(&target_before, &target_before_commit, expected)
        || !crate::services::file_identity::same_observation(
            &target_after_open,
            &target_before_commit,
        )
    {
        return Err(AppError::new(
            AppErrorCode::Conflict,
            "file changed before commit",
        ));
    }

    match atomic.commit() {
        Ok(()) => Ok(WriteOutcome {
            hash: blake3::hash(&encoded).to_hex().to_string(),
            size: encoded.len() as u64,
            mtime_ms: temp_mtime_ms,
            identity: temp_identity,
        }),
        Err(error) => {
            // The commit may have succeeded and only the durability barrier
            // failed. Re-read before reporting failure so a committed file is
            // never reported as a failed save.
            match FileService::read_raw(path, MAX_DOCUMENT_BYTES, expected_parent) {
                Ok(raw) if raw.hash == blake3::hash(&encoded).to_hex().to_string() => {
                    tracing::warn!(%error, "commit reported an error after the file was written");
                    Ok(WriteOutcome {
                        hash: raw.hash,
                        size: raw.size,
                        mtime_ms: raw.mtime_ms,
                        identity: temp_identity,
                    })
                }
                _ => Err(AppError::from_io(&error)),
            }
        }
    }
}

fn observe_target(path: &Path) -> Result<FileObservation, AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::new(
            AppErrorCode::InvalidPath,
            format!("symbolic links are not accepted: {}", path.display()),
        )),
        Ok(metadata) if !metadata.is_file() => Err(AppError::new(
            AppErrorCode::NotAFile,
            format!("not a regular file: {}", path.display()),
        )),
        Ok(_) => observe_path(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileObservation::Absent),
        Err(error) => Err(AppError::from_io(&error)),
    }
}

fn check_expected_target(
    target_before: &FileObservation,
    expected: &ExpectedTarget,
    path: &Path,
    expected_parent: Option<&FileIdentity>,
) -> Result<(), AppError> {
    match expected {
        ExpectedTarget::Existing {
            identity,
            hash,
            size,
            ..
        } => {
            if target_before.is_absent() {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the document was deleted before saving; refusing to recreate it",
                ));
            }
            if let Some(expected_identity) = identity {
                let matches = matches!(
                    target_before,
                    FileObservation::Present(actual)
                        if same_identity(expected_identity, actual)
                );
                if !matches && matches!(target_before, FileObservation::Present(_)) {
                    return Err(AppError::new(
                        AppErrorCode::Conflict,
                        "a different file appeared at the document path",
                    ));
                }
            }
            let raw = FileService::read_raw(path, MAX_DOCUMENT_BYTES, expected_parent)?;
            if raw.hash != *hash || raw.size != *size {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "file changed before saving",
                ));
            }
            Ok(())
        }
        ExpectedTarget::Absent => {
            if !target_before.is_absent() {
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "a file appeared at the save-as target",
                ));
            }
            Ok(())
        }
    }
}

fn target_changed(
    before: &FileObservation,
    after: &FileObservation,
    expected: &ExpectedTarget,
) -> bool {
    match expected {
        ExpectedTarget::Existing {
            identity: Some(identity),
            ..
        } => !matches!(
            after,
            FileObservation::Present(actual) if same_identity(identity, actual)
        ),
        ExpectedTarget::Existing { identity: None, .. } => {
            std::mem::discriminant(before) != std::mem::discriminant(after)
        }
        ExpectedTarget::Absent => !after.is_absent(),
    }
}

#[cfg(unix)]
fn atomic_directory_identity(atomic: &AtomicWriteFile) -> Result<Option<FileIdentity>, AppError> {
    use std::os::fd::AsFd;

    let Some(directory) = atomic.directory() else {
        return Ok(None);
    };
    let owned = directory
        .as_fd()
        .try_clone_to_owned()
        .map_err(|error| AppError::from_io(&error))?;
    let file = File::from(owned);
    let metadata = file.metadata().map_err(|error| AppError::from_io(&error))?;
    Ok(identity_from_metadata(&metadata))
}

fn read_current(
    record: &DocumentRecord,
    paths: &crate::state::document_registry::DocumentPaths,
) -> Result<CurrentDisk, AppError> {
    let raw = FileService::read_raw(
        &paths.canonical_target,
        MAX_DOCUMENT_BYTES,
        paths.parent_identity.as_ref(),
    )?;
    let _ = record;
    Ok(CurrentDisk {
        hash: raw.hash,
        size: raw.size,
        mtime_ms: raw.mtime_ms,
        bytes: raw.bytes,
        identity: raw.identity,
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
    use std::fs;

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

    fn format() -> TextFormat {
        TextFormat {
            encoding: TextEncoding::Utf8,
            has_bom: false,
            eol: LineEnding::Lf,
        }
    }

    #[test]
    fn absent_expected_refuses_an_existing_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.md");
        fs::write(&path, "old").expect("fixture");
        let error = write_formatted(&path, &format(), "new", &ExpectedTarget::Absent, None)
            .expect_err("existing target must conflict");
        assert_eq!(error.code, AppErrorCode::Conflict);
        assert_eq!(fs::read_to_string(&path).expect("read"), "old");
    }

    #[test]
    fn existing_expected_refuses_a_missing_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.md");
        fs::write(&path, "old").expect("fixture");
        let raw = FileService::read_raw(&path, MAX_DOCUMENT_BYTES, None).expect("read");
        fs::remove_file(&path).expect("remove");
        let expected = ExpectedTarget::Existing {
            identity: raw.identity,
            hash: raw.hash,
            size: raw.size,
            mtime_ms: raw.mtime_ms,
        };
        let error = write_formatted(&path, &format(), "new", &expected, None)
            .expect_err("missing target must conflict");
        assert_eq!(error.code, AppErrorCode::Conflict);
        assert!(!path.exists(), "a missing document must not be recreated");
    }

    #[test]
    fn existing_hash_mismatch_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.md");
        fs::write(&path, "old").expect("fixture");
        let raw = FileService::read_raw(&path, MAX_DOCUMENT_BYTES, None).expect("read");
        let expected = ExpectedTarget::Existing {
            identity: raw.identity,
            hash: "not-the-current-hash".to_string(),
            size: raw.size,
            mtime_ms: raw.mtime_ms,
        };
        let error = write_formatted(&path, &format(), "new", &expected, None)
            .expect_err("hash mismatch must conflict");
        assert_eq!(error.code, AppErrorCode::Conflict);
        assert_eq!(fs::read_to_string(&path).expect("read"), "old");
    }

    #[test]
    fn expected_parent_identity_mismatch_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let other = tempfile::tempdir().expect("other");
        let path = dir.path().join("a.md");
        fs::write(&path, "old").expect("fixture");
        let other_identity = crate::services::file_identity::file_identity(other.path())
            .expect("identity")
            .expect("supported");
        let error = write_formatted(
            &path,
            &format(),
            "new",
            &ExpectedTarget::Absent,
            Some(&other_identity),
        )
        .expect_err("parent mismatch must conflict");
        assert_eq!(error.code, AppErrorCode::Conflict);
        assert_eq!(fs::read_to_string(&path).expect("read"), "old");
    }

    #[test]
    fn absent_expected_creates_a_new_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("new.md");
        let outcome = write_formatted(&path, &format(), "new", &ExpectedTarget::Absent, None)
            .expect("create");
        assert_eq!(outcome.size, 3);
        assert_eq!(fs::read_to_string(&path).expect("read"), "new");
    }
}
