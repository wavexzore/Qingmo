//! Cross-platform file-instance identity.
//!
//! The identity is deliberately *not* used as the document identity. It is a
//! short-lived observation used to pair rename events and to re-check a path
//! between `canonicalize` and the actual read/write. `DocumentId` lives in
//! [`crate::services::document_identity`].
//!
//! `Ok(None)` means "the platform cannot provide a stable identity here"
//! (network redirector, unsupported filesystem, all-zero id). Only a genuine
//! I/O, permission, or not-found failure is returned as `Err`.

use std::fs::File;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppErrorCode};

/// Stable file-instance identity.
///
/// The `birth_ns` field is a *stronger* tie-breaker when the filesystem
/// provides it. An identity with `birth_ns == 0` can still match by its core
/// id; when both sides carry a birth time, both must agree.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileIdentity {
    #[serde(rename_all = "camelCase")]
    Inode {
        device: u64,
        inode: u64,
        birth_ns: u64,
    },
    #[serde(rename_all = "camelCase")]
    LowRes {
        volume: u32,
        index: u64,
        birth_ns: u64,
    },
    #[serde(rename_all = "camelCase")]
    HighRes {
        volume: u64,
        file_id: u128,
        birth_ns: u64,
    },
}

impl FileIdentity {
    pub fn birth_ns(&self) -> u64 {
        match self {
            Self::Inode { birth_ns, .. }
            | Self::LowRes { birth_ns, .. }
            | Self::HighRes { birth_ns, .. } => *birth_ns,
        }
    }

    pub fn with_birth_ns(mut self, birth_ns: u64) -> Self {
        match &mut self {
            Self::Inode {
                birth_ns: value, ..
            }
            | Self::LowRes {
                birth_ns: value, ..
            }
            | Self::HighRes {
                birth_ns: value, ..
            } => *value = birth_ns,
        }
        self
    }

    /// Returns a stable textual key. The key is opaque; callers must not parse
    /// it. It is used for the `by_file` index and diagnostics only.
    pub fn file_hex(&self) -> FileKey {
        let value = match self {
            Self::Inode { device, inode, .. } => format!("inode:{device:x}:{inode:x}"),
            Self::LowRes { volume, index, .. } => format!("lowres:{volume:x}:{index:x}"),
            Self::HighRes {
                volume, file_id, ..
            } => format!("highres:{volume:x}:{file_id:x}"),
        };
        FileKey(value)
    }
}

/// Opaque key for a [`FileIdentity`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct FileKey(String);

impl FileKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for FileKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Result of observing a path at one point in time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileObservation {
    Present(FileIdentity),
    Unavailable,
    Absent,
}

impl FileObservation {
    pub fn identity(&self) -> Option<&FileIdentity> {
        match self {
            Self::Present(identity) => Some(identity),
            Self::Unavailable | Self::Absent => None,
        }
    }

    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }
}

/// Reads the identity of the file or directory at `path`.
///
/// Symbolic links are followed, matching the `canonical_target` semantics used
/// by the document layer. Use [`observe_path`] when an absent path must be
/// distinguished from an unsupported one.
pub fn file_identity(path: &Path) -> Result<Option<FileIdentity>, AppError> {
    let core = file_id::get_file_id(path).map_err(|error| map_path_error(path, &error))?;
    let metadata = std::fs::metadata(path).map_err(|error| map_path_error(path, &error))?;
    let birth_ns = birth_ns_from_metadata(&metadata);
    let identity = match core {
        file_id::FileId::Inode {
            device_id,
            inode_number,
        } => {
            if device_id == 0 && inode_number == 0 {
                return Ok(None);
            }
            FileIdentity::Inode {
                device: device_id,
                inode: inode_number,
                birth_ns,
            }
        }
        file_id::FileId::LowRes {
            volume_serial_number,
            file_index,
        } => {
            if volume_serial_number == 0 && file_index == 0 {
                return Ok(None);
            }
            FileIdentity::LowRes {
                volume: volume_serial_number,
                index: file_index,
                birth_ns,
            }
        }
        file_id::FileId::HighRes {
            volume_serial_number,
            file_id,
        } => {
            if volume_serial_number == 0 && file_id == 0 {
                return Ok(None);
            }
            FileIdentity::HighRes {
                volume: volume_serial_number,
                file_id,
                birth_ns,
            }
        }
    };
    #[cfg(target_os = "linux")]
    let identity = identity.with_birth_ns(linux_birth_ns(path));
    Ok(Some(identity))
}

/// Reads the identity of an open handle. Prefer this over [`file_identity`]
/// when a check-then-use window must be closed.
pub fn identity_from_handle(file: &File) -> Result<Option<FileIdentity>, AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let metadata = file.metadata().map_err(|error| AppError::from_io(&error))?;
        let birth_ns = birth_ns_from_metadata(&metadata);
        Ok(Some(FileIdentity::Inode {
            device: metadata.dev(),
            inode: metadata.ino(),
            birth_ns,
        }))
    }

    #[cfg(windows)]
    {
        windows_identity_from_handle(file)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Ok(None)
    }
}

/// Builds an identity from metadata. On Windows path metadata cannot carry the
/// volume/file index, so this returns `None`; use [`identity_from_handle`].
pub fn identity_from_metadata(metadata: &std::fs::Metadata) -> Option<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let device = metadata.dev();
        let inode = metadata.ino();
        if device == 0 && inode == 0 {
            return None;
        }
        Some(FileIdentity::Inode {
            device,
            inode,
            birth_ns: birth_ns_from_metadata(metadata),
        })
    }

    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

/// Observes a path as Present / Unavailable / Absent.
pub fn observe_path(path: &Path) -> Result<FileObservation, AppError> {
    match file_identity(path) {
        Ok(Some(identity)) => Ok(FileObservation::Present(identity)),
        Ok(None) => Ok(FileObservation::Unavailable),
        Err(error) if error.code == AppErrorCode::NotFound => Ok(FileObservation::Absent),
        Err(error) => Err(error),
    }
}

/// Strong/weak identity comparison.
///
/// Core ids must match. If both sides carry a non-zero birth time, they must
/// also match; a missing birth time is treated as a weaker observation rather
/// than a mismatch.
pub fn same_identity(left: &FileIdentity, right: &FileIdentity) -> bool {
    let core_matches = match (left, right) {
        (
            FileIdentity::Inode {
                device: left_device,
                inode: left_inode,
                ..
            },
            FileIdentity::Inode {
                device: right_device,
                inode: right_inode,
                ..
            },
        ) => left_device == right_device && left_inode == right_inode,
        (
            FileIdentity::LowRes {
                volume: left_volume,
                index: left_index,
                ..
            },
            FileIdentity::LowRes {
                volume: right_volume,
                index: right_index,
                ..
            },
        ) => left_volume == right_volume && left_index == right_index,
        (
            FileIdentity::HighRes {
                volume: left_volume,
                file_id: left_id,
                ..
            },
            FileIdentity::HighRes {
                volume: right_volume,
                file_id: right_id,
                ..
            },
        ) => left_volume == right_volume && left_id == right_id,
        _ => false,
    };

    if !core_matches {
        return false;
    }

    match (left.birth_ns(), right.birth_ns()) {
        (0, _) | (_, 0) => true,
        (left_birth, right_birth) => left_birth == right_birth,
    }
}

pub fn same_identity_opt(left: Option<&FileIdentity>, right: Option<&FileIdentity>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => same_identity(left, right),
        (None, None) => true,
        _ => false,
    }
}

pub fn same_observation(left: &FileObservation, right: &FileObservation) -> bool {
    match (left, right) {
        (FileObservation::Present(left), FileObservation::Present(right)) => {
            same_identity(left, right)
        }
        (FileObservation::Unavailable, FileObservation::Unavailable) => true,
        (FileObservation::Absent, FileObservation::Absent) => true,
        _ => false,
    }
}

fn map_path_error(path: &Path, error: &io::Error) -> AppError {
    if error.kind() == io::ErrorKind::NotFound {
        AppError::new(
            AppErrorCode::NotFound,
            format!("file not found: {}", path.display()),
        )
    } else {
        AppError::from_io(error)
    }
}

#[cfg(unix)]
fn birth_ns_from_metadata(metadata: &std::fs::Metadata) -> u64 {
    #[cfg(target_os = "linux")]
    {
        // `Metadata::created()` is not implemented on Linux. `statx` is the
        // only portable way to obtain btime; when the filesystem does not
        // expose it the mask bit is clear and we fall back to zero.
        let _ = metadata;
        0
    }

    #[cfg(not(target_os = "linux"))]
    {
        metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }
}

#[cfg(not(unix))]
fn birth_ns_from_metadata(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

/// Linux birth time for a path, using `statx(AT_SYMLINK_NOFOLLOW)`.
#[cfg(target_os = "linux")]
pub fn linux_birth_ns(path: &Path) -> u64 {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return 0;
    };
    let mut statx: libc::statx = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::statx(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_SYNC_AS_STAT,
            libc::STATX_BTIME,
            &mut statx,
        )
    };
    if result != 0 || statx.stx_mask & libc::STATX_BTIME == 0 {
        return 0;
    }
    let seconds = statx.stx_btime.tv_sec.max(0) as u128;
    let nanos = statx.stx_btime.tv_nsec.max(0) as u128;
    (seconds * 1_000_000_000 + nanos).min(u64::MAX as u128) as u64
}

#[cfg(windows)]
fn windows_identity_from_handle(file: &File) -> Result<Option<FileIdentity>, AppError> {
    use std::mem;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
    };

    let handle = file.as_raw_handle() as HANDLE;
    let birth_ns = file
        .metadata()
        .ok()
        .and_then(|metadata| metadata.created().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0);

    let mut high: FILE_ID_INFO = unsafe { mem::zeroed() };
    let high_ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            &mut high as *mut FILE_ID_INFO as _,
            mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if high_ok != 0 {
        return Ok(Some(FileIdentity::HighRes {
            volume: high.VolumeSerialNumber,
            file_id: u128::from_le_bytes(high.FileId.Identifier),
            birth_ns,
        }));
    }

    let high_error = io::Error::last_os_error();
    if !windows_unsupported(&high_error) {
        return Err(AppError::from_io(&high_error));
    }

    let mut low: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    let low_ok = unsafe { GetFileInformationByHandle(handle, &mut low) };
    if low_ok == 0 {
        let error = io::Error::last_os_error();
        if windows_unsupported(&error) {
            return Ok(None);
        }
        return Err(AppError::from_io(&error));
    }

    let index = ((low.nFileIndexHigh as u64) << 32) | low.nFileIndexLow as u64;
    let volume = low.dwVolumeSerialNumber;
    if volume == 0 && index == 0 {
        return Ok(None);
    }
    Ok(Some(FileIdentity::LowRes {
        volume,
        index,
        birth_ns,
    }))
}

#[cfg(windows)]
fn windows_unsupported(error: &io::Error) -> bool {
    // ERROR_INVALID_FUNCTION (1), ERROR_NOT_SUPPORTED (50), and
    // ERROR_INVALID_PARAMETER (87) are the common redirector answers.
    matches!(error.raw_os_error(), Some(1 | 50 | 87))
}
