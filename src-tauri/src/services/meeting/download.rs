//! Model downloading: staging, resume, hash checks, safe unpack and commit.
//!
//! Every byte lands in `meeting-models/.staging/<id>/` on the same volume as
//! the final directory, so the commit is a pair of renames. The staging path
//! is keyed by model id so a retried attempt resumes the same `.part`. The
//! archive is hashed before unpacking; every extracted file is hashed again
//! before the `.ready` marker is written.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::Disks;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::models::{sha256_file, write_ready, ArchiveSpec, ModelPack};
use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::DownloadState;

pub const STAGING_DIR: &str = ".staging";
pub const COMMIT_FILE: &str = "commit.json";
const CHUNK_BYTES: usize = 256 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 2000;
const MAX_ARCHIVE_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const ARCHIVE_SLACK_BYTES: u64 = 64 * 1024 * 1024;

/// Free-space seam so tests never touch a real disk.
pub trait DiskProbe: Send + Sync {
    fn free_bytes(&self, path: &Path) -> Result<u64, AppError>;
}

pub struct SystemDiskProbe;

impl DiskProbe for SystemDiskProbe {
    fn free_bytes(&self, path: &Path) -> Result<u64, AppError> {
        #[cfg(debug_assertions)]
        if let Some(free) =
            super::e2e::var("MEETING_E2E_FREE_SPACE").and_then(|value| value.parse::<u64>().ok())
        {
            return Ok(free.saturating_mul(1024 * 1024));
        }
        let probe = path.to_path_buf();
        let disks = Disks::new_with_refreshed_list();
        let mut best: Option<(usize, u64)> = None;
        for disk in disks.list() {
            let mount = disk.mount_point();
            if probe.starts_with(mount) {
                let depth = mount.components().count();
                if best.is_none_or(|(best_depth, _)| depth > best_depth) {
                    best = Some((depth, disk.available_space()));
                }
            }
        }
        best.map(|(_, free)| free).ok_or_else(|| {
            AppError::new(
                AppErrorCode::ModelDownloadFailed,
                format!("no filesystem contains {}", probe.display()),
            )
            .with_details(serde_json::json!({ "reason": "disk_probe" }))
        })
    }
}

/// Required headroom: enough for the download plus a full install copy.
pub fn required_bytes(download: u64, install: u64) -> u64 {
    download
        .saturating_mul(2)
        .max(download.saturating_add(install.saturating_mul(105) / 100 + ARCHIVE_SLACK_BYTES))
}

pub fn ensure_space(probe: &dyn DiskProbe, root: &Path, pack: &ModelPack) -> Result<(), AppError> {
    let required = required_bytes(pack.download_bytes, pack.install_bytes);
    let free = probe.free_bytes(root)?;
    if free < required {
        return Err(AppError::new(
            AppErrorCode::ModelDownloadFailed,
            "not enough disk space for the model",
        )
        .with_details(serde_json::json!({
            "reason": "disk_full",
            "freeBytes": free,
            "requiredBytes": required
        })));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitLog {
    id: String,
    staging: String,
    backup: String,
}

fn failure(reason: &str, message: impl Into<String>) -> AppError {
    AppError::new(AppErrorCode::ModelDownloadFailed, message)
        .with_details(serde_json::json!({ "reason": reason }))
}

fn cancelled() -> AppError {
    AppError::new(AppErrorCode::Cancelled, "model download cancelled")
}

fn checked_cancel(cancel: &CancellationToken) -> Result<(), AppError> {
    if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}

/// `MEETING_E2E_*` rewrites official URLs into a local mirror.
#[cfg(debug_assertions)]
fn rewrite_source(pack_id: &str, url: &str, name: &str) -> String {
    let Some(base) = super::e2e::var("MEETING_E2E_DOWNLOAD_BASE") else {
        return url.to_owned();
    };
    format!("{}/{pack_id}/{name}", base.trim_end_matches('/'))
}

#[cfg(not(debug_assertions))]
fn rewrite_source(_pack_id: &str, url: &str, _name: &str) -> String {
    url.to_owned()
}

/// A local mirror is rebuilt from unpacked files, so its archive hash cannot
/// match the official `.tar.bz2`; per-file hashes are still checked after
/// unpacking.
#[cfg(debug_assertions)]
fn mirroring() -> bool {
    super::e2e::var("MEETING_E2E_DOWNLOAD_BASE").is_some()
}

#[cfg(not(debug_assertions))]
fn mirroring() -> bool {
    false
}

/// Official sources for non-archive packs are usually directories; one file
/// is one `.../<name>` entry. A few packs (the VAD) already point at the file,
/// so an existing `/<name>` suffix is kept.
fn file_source(pack_id: &str, source: &str, name: &str) -> String {
    let base = source.trim_end_matches('/');
    let url = if base.ends_with(&format!("/{name}")) {
        base.to_owned()
    } else {
        format!("{base}/{name}")
    };
    rewrite_source(pack_id, &url, name)
}

fn local_source(url: &str) -> Option<PathBuf> {
    let path = url.strip_prefix("file://").unwrap_or(url);
    (url.starts_with("file://") || Path::new(path).is_absolute()).then(|| PathBuf::from(path))
}

/// Copy a mirror file with the same Range/progress contract as HTTP.
fn copy_local(
    source: &Path,
    part: &Path,
    offset: u64,
    expected: u64,
    cancel: &CancellationToken,
    done: &mut u64,
    progress: &mut dyn FnMut(u64, DownloadState),
) -> Result<u64, AppError> {
    let mut input = File::open(source).map_err(|error| failure("network", error.to_string()))?;
    if offset > 0 {
        std::io::Seek::seek(&mut input, std::io::SeekFrom::Start(offset))
            .map_err(|error| AppError::from_io(&error))?;
    }
    let mut output = if offset > 0 {
        OpenOptions::new()
            .append(true)
            .open(part)
            .map_err(|error| AppError::from_io(&error))?
    } else {
        File::create(part).map_err(|error| AppError::from_io(&error))?
    };
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut written = 0u64;
    loop {
        checked_cancel(cancel)?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| AppError::from_io(&error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| AppError::from_io(&error))?;
        written = written.saturating_add(read as u64);
        *done = done.saturating_add(read as u64);
        progress(*done, DownloadState::Downloading);
    }
    if expected > 0 && offset + written < expected {
        return Err(failure("network", "mirror file is shorter than declared"));
    }
    Ok(offset + written.max(expected))
}

/// Resume one file. Returns the final byte count written for it.
fn download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    part: &Path,
    expected: u64,
    cancel: &CancellationToken,
    done: &mut u64,
    progress: &mut dyn FnMut(u64, DownloadState),
) -> Result<u64, AppError> {
    let existing = fs::metadata(part).map(|meta| meta.len()).unwrap_or(0);
    let offset = if expected > 0 && existing > expected {
        // A leftover from a different byte count cannot be resumed.
        let _ = fs::remove_file(part);
        0
    } else {
        existing
    };
    // Count resumed bytes once, up front, so the progress bar is monotonic.
    *done = done.saturating_add(offset);
    if offset == expected && expected > 0 {
        progress(*done, DownloadState::Downloading);
        return Ok(offset);
    }

    if let Some(local) = local_source(url) {
        return copy_local(&local, part, offset, expected, cancel, done, progress);
    }

    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .map_err(|error| failure("network", format!("model request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(failure(
            "http_status",
            format!("model request returned {}", response.status()),
        ));
    }
    if offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        // The server ignored the range; restart this file cleanly.
        *done = done.saturating_sub(offset);
        let _ = fs::remove_file(part);
    }
    let mut output = if offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        OpenOptions::new()
            .append(true)
            .open(part)
            .map_err(|error| AppError::from_io(&error))?
    } else {
        File::create(part).map_err(|error| AppError::from_io(&error))?
    };

    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        checked_cancel(cancel)?;
        let read = response
            .read(&mut buffer)
            .map_err(|error| failure("network", format!("model stream interrupted: {error}")))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| AppError::from_io(&error))?;
        *done = done.saturating_add(read as u64);
        progress(*done, DownloadState::Downloading);
    }
    output.flush().map_err(|error| AppError::from_io(&error))?;
    let written = fs::metadata(part).map(|meta| meta.len()).unwrap_or(0);
    if written != expected {
        return Err(failure(
            "length",
            format!("model file length {written} != expected {expected}"),
        ));
    }
    Ok(written)
}

fn verify_file(path: &Path, expected_sha: &str, expected_bytes: u64) -> Result<(), AppError> {
    let meta = fs::metadata(path).map_err(|error| AppError::from_io(&error))?;
    if meta.len() != expected_bytes {
        let _ = fs::remove_file(path);
        return Err(failure("length", "model file length mismatch"));
    }
    let actual = sha256_file(path)?;
    if !expected_sha.is_empty() && actual != expected_sha {
        let _ = fs::remove_file(path);
        return Err(failure("hash_mismatch", "model file hash mismatch"));
    }
    Ok(())
}

fn archive_path(staging: &Path, spec: &ArchiveSpec) -> PathBuf {
    staging.join(match spec.format {
        super::models::ArchiveFormat::TarBz2 => "archive.tar.bz2",
    })
}

fn safe_entry_path(path: &Path) -> Result<Vec<Component<'_>>, AppError> {
    if path.is_absolute() {
        return Err(failure("archive_escape", "absolute archive entry"));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => parts.push(Component::Normal(value)),
            Component::ParentDir => {
                return Err(failure("archive_escape", "archive entry escapes with .."));
            }
            _ => return Err(failure("archive_escape", "unsupported archive path")),
        }
    }
    if parts.is_empty() {
        return Err(failure("archive_escape", "empty archive entry"));
    }
    Ok(parts)
}

fn unpack_archive(
    archive: &Path,
    staging: &Path,
    spec: &ArchiveSpec,
    cancel: &CancellationToken,
) -> Result<(), AppError> {
    let file = File::open(archive).map_err(|error| AppError::from_io(&error))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);

    let limit = spec
        .bytes
        .saturating_mul(105)
        .saturating_div(100)
        .saturating_add(ARCHIVE_SLACK_BYTES);
    let unpack_root = staging.join(".unpack");
    let _ = fs::remove_dir_all(&unpack_root);
    fs::create_dir_all(&unpack_root).map_err(|error| AppError::from_io(&error))?;

    let mut total = 0u64;
    let mut entries = 0usize;
    for entry in tar
        .entries()
        .map_err(|error| failure("archive", error.to_string()))?
    {
        let mut entry = entry.map_err(|error| failure("archive", error.to_string()))?;
        entries += 1;
        if entries > MAX_ARCHIVE_ENTRIES {
            return Err(failure("archive_bomb", "too many archive entries"));
        }
        let header = entry.header();
        if !matches!(
            header.entry_type(),
            tar::EntryType::Regular | tar::EntryType::Directory
        ) {
            return Err(failure("archive_link", "archive contains a link"));
        }
        let path = entry
            .path()
            .map_err(|error| failure("archive_escape", error.to_string()))?
            .into_owned();
        let parts = safe_entry_path(&path)?;
        let Some(Component::Normal(top)) = parts.first() else {
            return Err(failure("archive_escape", "archive entry has no root"));
        };
        if top.to_string_lossy() != spec.root {
            continue;
        }
        let size = entry.size();
        if size > MAX_ARCHIVE_FILE_BYTES {
            return Err(failure("archive_bomb", "archive file is too large"));
        }
        total = total.saturating_add(size);
        if total > limit {
            return Err(failure("archive_bomb", "unpacked archive is too large"));
        }

        let mut relative = PathBuf::new();
        for part in parts.iter().skip(1) {
            if let Component::Normal(value) = part {
                relative.push(value);
            }
        }
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = unpack_root.join(relative);
        if header.entry_type() == tar::EntryType::Directory {
            fs::create_dir_all(&target).map_err(|error| AppError::from_io(&error))?;
            continue;
        }
        checked_cancel(cancel)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| AppError::from_io(&error))?;
        }
        let mut output = File::create(&target).map_err(|error| AppError::from_io(&error))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| AppError::from_io(&error))?;
    }

    // Move only the declared files to the staging root; extras are ignored.
    for declared in spec.root_files {
        let source = unpack_root.join(declared);
        let target = staging.join(declared);
        if !source.is_file() {
            return Err(failure(
                "archive_missing",
                format!("archive is missing {declared}"),
            ));
        }
        fs::rename(&source, &target).map_err(|error| AppError::from_io(&error))?;
    }
    let _ = fs::remove_dir_all(&unpack_root);
    Ok(())
}

/// Download, verify and atomically install one pack.
pub fn run(
    root: &Path,
    pack: &ModelPack,
    _download_id: Uuid,
    cancel: &CancellationToken,
    progress: &mut dyn FnMut(u64, DownloadState),
) -> Result<(), AppError> {
    let staging_root = root.join(STAGING_DIR);
    fs::create_dir_all(&staging_root).map_err(|error| AppError::from_io(&error))?;
    // Staging is keyed by model id, not by the in-memory download id, so a
    // retry after an interruption resumes the same `.part` files.
    let staging = staging_root.join(pack.id);
    fs::create_dir_all(&staging).map_err(|error| AppError::from_io(&error))?;

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(2 * 60 * 60))
        .build()
        .map_err(|error| failure("network", error.to_string()))?;

    let mut done = 0u64;
    if let Some(spec) = pack.archive {
        let archive = archive_path(&staging, &spec);
        let part = archive.with_extension("part");
        let source = pack
            .source
            .first()
            .ok_or_else(|| failure("manifest", "archive has no source"))?;
        let source_url = rewrite_source(pack.id, source.url, "archive.tar.bz2");
        // A mirror archive is rebuilt locally, so neither its length nor its
        // hash match the official release; unpacked files are verified below.
        let expected = if mirroring() { 0 } else { spec.bytes };
        if (expected == 0 && archive.is_file()) || has_length(&archive, expected) {
            done = done.saturating_add(expected);
            progress(done, DownloadState::Downloading);
            let _ = fs::remove_file(&part);
        } else {
            download_file(
                &client,
                &source_url,
                &part,
                expected,
                cancel,
                &mut done,
                progress,
            )?;
            persist_downloaded(&part, &archive)?;
        }
        progress(done, DownloadState::Verifying);
        let actual = sha256_file(&archive)?;
        if !mirroring() && !spec.sha256.is_empty() && actual != spec.sha256 {
            let _ = fs::remove_file(&archive);
            return Err(failure("hash_mismatch", "archive hash mismatch"));
        }
        progress(done, DownloadState::Downloading);
        unpack_archive(&archive, &staging, &spec, cancel)?;
        let _ = fs::remove_file(&part);
    } else {
        for file in pack.files {
            let part = staging.join(format!("{}.part", file.name));
            let target = staging.join(file.name);
            if has_length(&target, file.bytes) {
                done = done.saturating_add(file.bytes);
                progress(done, DownloadState::Downloading);
                continue;
            }
            let _ = fs::remove_file(&target);
            download_file(
                &client,
                &file_source(pack.id, file.source.url, file.name),
                &part,
                file.bytes,
                cancel,
                &mut done,
                progress,
            )?;
            persist_downloaded(&part, &target)?;
            progress(done, DownloadState::Downloading);
        }
    }

    progress(done, DownloadState::Verifying);
    for file in pack.files {
        checked_cancel(cancel)?;
        verify_file(&staging.join(file.name), file.sha256, file.bytes)?;
    }
    if pack.archive.is_some() {
        // The archive stays until every unpacked file is verified; a failed
        // extraction can then retry without downloading it again.
        let _ = fs::remove_file(archive_path(&staging, pack.archive.as_ref().unwrap()));
    }
    // Archive spec bytes may differ slightly from the file sum; report exact.
    progress(pack.download_bytes.max(done), DownloadState::Verifying);
    commit(root, &staging, pack.id, &staging_root)?;
    let target = root.join(pack.id);
    write_ready(&target, pack, super::models::unix_now_public())?;
    Ok(())
}

fn has_length(path: &Path, expected: u64) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == expected)
}

fn persist_downloaded(part: &Path, target: &Path) -> Result<(), AppError> {
    // Windows `rename` refuses an existing destination.
    if target.exists() {
        fs::remove_file(target).map_err(|error| AppError::from_io(&error))?;
    }
    fs::rename(part, target).map_err(|error| AppError::from_io(&error))
}

fn write_commit(log: &CommitLog, path: &Path) -> Result<(), AppError> {
    fs::write(
        path,
        serde_json::to_vec_pretty(log).map_err(|error| failure("io", error.to_string()))?,
    )
    .map_err(|error| AppError::from_io(&error))
}

fn commit(root: &Path, staging: &Path, id: &str, staging_root: &Path) -> Result<(), AppError> {
    let target = root.join(id);
    let backup = staging_root.join(format!("{id}.old-{}", Uuid::new_v4()));
    let log = CommitLog {
        id: id.to_string(),
        staging: staging.to_string_lossy().into_owned(),
        backup: backup.to_string_lossy().into_owned(),
    };
    let log_path = staging_root.join(format!(
        "{}.commit.json",
        staging.file_name().unwrap_or_default().to_string_lossy()
    ));
    write_commit(&log, &log_path)?;
    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| AppError::from_io(&error))?;
    }
    if let Err(error) = fs::rename(staging, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(AppError::from_io(&error));
    }
    let _ = fs::remove_dir_all(&backup);
    let _ = fs::remove_file(target.join(COMMIT_FILE));
    let _ = fs::remove_file(&log_path);
    Ok(())
}

/// Repair a crash between the two commit renames.
/// Drop every staging leftover of one model (used just before removal).
pub fn remove_staging(root: &Path, id: &str) {
    let staging_root = root.join(STAGING_DIR);
    let _ = fs::remove_dir_all(staging_root.join(id));
    let Ok(entries) = fs::read_dir(&staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == format!("{id}.commit.json") || name.starts_with(&format!("{id}.old-")) {
            if entry.path().is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            } else {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

pub fn recover_orphans(root: &Path) {
    let staging_root = root.join(STAGING_DIR);
    let Ok(entries) = fs::read_dir(&staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        let log_path = entry.path();
        if !log_path.to_string_lossy().ends_with(".commit.json") {
            continue;
        }
        let Ok(bytes) = fs::read(&log_path) else {
            continue;
        };
        let Ok(log) = serde_json::from_slice::<CommitLog>(&bytes) else {
            let _ = fs::remove_file(&log_path);
            continue;
        };
        let target = root.join(&log.id);
        let backup = PathBuf::from(&log.backup);
        if !target.exists() && backup.exists() {
            if let Err(error) = fs::rename(&backup, &target) {
                tracing::warn!(%error, id = log.id, "failed to restore a model backup");
                continue;
            }
        } else if target.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
        let _ = fs::remove_dir_all(&log.staging);
        let _ = fs::remove_file(&log_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_source_appends_the_file_name() {
        std::env::remove_var("QINGMO_E2E_ENV");
        std::env::remove_var("MEETING_E2E_DOWNLOAD_BASE");
        assert_eq!(
            file_source("pack", "https://host/resolve/main/", "model.onnx"),
            "https://host/resolve/main/model.onnx"
        );
        // The VAD source already points at the file.
        assert_eq!(
            file_source(
                "silero-vad",
                "https://host/asr-models/silero_vad.onnx",
                "silero_vad.onnx"
            ),
            "https://host/asr-models/silero_vad.onnx"
        );
        std::env::set_var("MEETING_E2E_DOWNLOAD_BASE", "/mirror");
        assert_eq!(
            file_source("pack", "https://host/resolve/main", "model.onnx"),
            "/mirror/pack/model.onnx"
        );
        std::env::remove_var("MEETING_E2E_DOWNLOAD_BASE");
    }

    #[test]
    fn copy_local_honours_the_offset_and_rejects_a_short_source() {
        let dir = std::env::temp_dir().join(format!("qingmo-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source");
        let part = dir.join("part");
        fs::write(&source, b"0123456789").unwrap();
        fs::write(&part, b"0123").unwrap();
        let mut done = 4;
        let mut calls = 0;
        let mut progress = |_done: u64, _state: DownloadState| calls += 1;
        let total = copy_local(
            &source,
            &part,
            4,
            6,
            &CancellationToken::new(),
            &mut done,
            &mut progress,
        )
        .unwrap();
        assert_eq!(total, 10);
        assert_eq!(done, 10);
        assert_eq!(fs::read(&part).unwrap(), b"0123456789");
        assert!(calls > 0);

        fs::write(&part, b"0123").unwrap();
        let mut done = 4;
        let mut progress = |_done: u64, _state: DownloadState| {};
        assert!(copy_local(
            &source,
            &part,
            4,
            12,
            &CancellationToken::new(),
            &mut done,
            &mut progress,
        )
        .is_err());

        // A mirror download has no declared length; copy everything after the
        // offset and report the real byte count.
        fs::write(&part, b"0123").unwrap();
        let mut done = 4;
        let total = copy_local(
            &source,
            &part,
            4,
            0,
            &CancellationToken::new(),
            &mut done,
            &mut progress,
        )
        .unwrap();
        assert_eq!(total, 10);
        assert_eq!(done, 10);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn required_space_uses_the_larger_side() {
        assert_eq!(required_bytes(100, 100), 100 + 105 + ARCHIVE_SLACK_BYTES);
        assert_eq!(required_bytes(10_000, 0), 10_000 + ARCHIVE_SLACK_BYTES);
        assert_eq!(required_bytes(100_000_000, 100), 200_000_000);
    }

    #[test]
    fn rejects_absolute_and_parent_entries() {
        assert!(safe_entry_path(Path::new("/abs/file")).is_err());
        assert!(safe_entry_path(Path::new("root/../file")).is_err());
        assert_eq!(
            safe_entry_path(Path::new("root/sub/file")).unwrap().len(),
            3
        );
    }
}
