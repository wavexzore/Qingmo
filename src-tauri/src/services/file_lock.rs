//! Per-path advisory locks backed by a sidecar file in app data.
//!
//! The lock only coordinates Qingmo instances. It deliberately lives under the
//! application data directory instead of next to the user's file: a workspace
//! may be read-only, and a sidecar in the document directory would itself show
//! up in the tree. The inode is removed with the OS file handle, so a crash
//! releases the lock without a stale-file cleanup pass.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppErrorCode};

pub const LOCK_TIMEOUT_MS: u64 = 2_000;
const LOCK_POLL_MS: u64 = 10;

#[derive(Debug, Clone)]
pub struct FileLockStore {
    root: Option<Arc<PathBuf>>,
}

impl FileLockStore {
    pub fn open(root: PathBuf) -> Result<Self, AppError> {
        std::fs::create_dir_all(&root).map_err(|error| AppError::from_io(&error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| AppError::from_io(&error))?;
        }
        Ok(Self {
            root: Some(Arc::new(root)),
        })
    }

    /// A no-op store used when the app data directory is unavailable. Search,
    /// history and trash are independently disabled in that case too.
    pub fn disabled() -> Self {
        Self { root: None }
    }

    /// Acquires the sidecar lock for a canonical document path.
    ///
    /// `try_lock` is non-blocking, so waiting is explicit and bounded by
    /// `LOCK_TIMEOUT_MS`. `WouldBlock` is retried; a real IO error is returned
    /// immediately instead of being disguised as BUSY.
    pub fn acquire(&self, path: &Path) -> Result<FileLockGuard, AppError> {
        let Some(root) = self.root.as_ref() else {
            return Ok(FileLockGuard { _file: None });
        };
        let key = blake3::hash(path.to_string_lossy().as_bytes())
            .to_hex()
            .to_string();
        let lock_path = root.join(format!("{}.lock", &key[..32]));
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| AppError::from_io(&error))?;

        let deadline = Instant::now() + Duration::from_millis(LOCK_TIMEOUT_MS);
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(FileLockGuard { _file: Some(file) }),
                Err(std::fs::TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(AppError::new(
                            AppErrorCode::Busy,
                            "another Qingmo instance is saving this file",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(LOCK_POLL_MS));
                }
                Err(std::fs::TryLockError::Error(error)) => {
                    return Err(AppError::from_io(&error));
                }
            }
        }
    }

    /// Acquires a lock for a path that may not exist yet (Save As).
    pub fn acquire_target(&self, path: &Path) -> Result<FileLockGuard, AppError> {
        let canonical_parent = path
            .parent()
            .ok_or_else(|| AppError::new(AppErrorCode::InvalidPath, "path has no parent"))?
            .canonicalize()
            .map_err(|error| AppError::from_io(&error))?;
        let name = path
            .file_name()
            .ok_or_else(|| AppError::new(AppErrorCode::InvalidPath, "path has no file name"))?;
        self.acquire(&canonical_parent.join(name))
    }

    #[cfg(test)]
    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref().map(|path| path.as_path())
    }
}

/// Holds the OS lock until dropped.
#[derive(Debug)]
pub struct FileLockGuard {
    _file: Option<File>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_times_out_with_busy() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = FileLockStore::open(dir.path().join("locks")).expect("lock store");
        let path = dir.path().join("note.md");
        std::fs::write(&path, "body").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical");

        let _guard = store.acquire(&canonical).expect("first lock");
        let error = store
            .acquire(&canonical)
            .expect_err("second lock must fail");
        assert_eq!(error.code, AppErrorCode::Busy);
    }

    #[test]
    fn dropping_the_guard_releases_the_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = FileLockStore::open(dir.path().join("locks")).expect("lock store");
        let path = dir.path().join("note.md");
        std::fs::write(&path, "body").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical");
        {
            let _guard = store.acquire(&canonical).expect("first lock");
        }
        let _guard = store.acquire(&canonical).expect("lock must be reusable");
    }
}
