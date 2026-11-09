//! Image paste/drop persistence next to the document.
//!
//! The verified entry point anchors the parent directory and the `assets`
//! subdirectory. On Unix both are opened with `O_NOFOLLOW|O_DIRECTORY` and all
//! writes use `openat`/`renameat`, so a symlink or a swapped parent cannot
//! redirect an image outside the document directory.

use std::path::Path;

use base64::Engine;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::ImageSaveResult;
use crate::services::file_identity::{same_identity, FileIdentity};

pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const ASSETS_DIR: &str = "assets";

const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Compatibility wrapper. Production commands should use
/// [`save_image_verified`] with the document's parent identity.
pub fn save_image(
    document: &Path,
    file_name: &str,
    mime: &str,
    data_base64: &str,
) -> Result<ImageSaveResult, AppError> {
    save_image_verified(document, file_name, mime, data_base64, None)
}

pub fn save_image_verified(
    document: &Path,
    file_name: &str,
    mime: &str,
    data_base64: &str,
    expected_parent: Option<&FileIdentity>,
) -> Result<ImageSaveResult, AppError> {
    let mime = normalize_mime(mime)?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| AppError::new(AppErrorCode::InvalidPath, "image data is not valid base64"))?;
    if data.len() as u64 > MAX_IMAGE_BYTES {
        return Err(AppError::new(
            AppErrorCode::FileTooLarge,
            "image exceeds 10 MiB",
        ));
    }
    verify_magic(&data, mime)?;

    let parent = document.parent().ok_or_else(|| {
        AppError::new(
            AppErrorCode::InvalidPath,
            "document has no parent directory",
        )
    })?;
    let extension = extension_for(mime);
    let stem = sanitize_stem(file_name, extension);

    #[cfg(unix)]
    {
        unix::save_verified(parent, &stem, extension, mime, &data, expected_parent)
    }
    #[cfg(not(unix))]
    {
        fallback::save_verified(parent, &stem, extension, mime, &data, expected_parent)
    }
}

fn result_for(stem: &str, name: &str, size: usize, mime: &str) -> ImageSaveResult {
    let relative = format!("{ASSETS_DIR}/{name}");
    ImageSaveResult {
        markdown: format!("![{stem}]({relative})"),
        relative_path: relative,
        size_bytes: size as u64,
        mime: mime.to_string(),
    }
}

#[cfg(unix)]
mod unix {
    use std::ffi::CString;
    use std::fs::{self, File};
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use super::*;

    pub(super) fn save_verified(
        parent: &Path,
        stem: &str,
        extension: &str,
        mime: &str,
        data: &[u8],
        expected_parent: Option<&FileIdentity>,
    ) -> Result<ImageSaveResult, AppError> {
        let parent_fd = open_dir(parent)?;
        let parent_identity = identity_of_fd(&parent_fd)?;
        check_parent(expected_parent, &parent_identity)?;

        let assets_path = parent.join(ASSETS_DIR);
        match fs::symlink_metadata(&assets_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::new(
                        AppErrorCode::InvalidPath,
                        "the assets path is not a plain directory",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&assets_path).map_err(|error| AppError::from_io(&error))?;
            }
            Err(error) => return Err(AppError::from_io(&error)),
        }
        let assets_fd = openat_dir(&parent_fd, ASSETS_DIR)?;
        let assets_identity = identity_of_fd(&assets_fd)?;

        let mut last_error = None;
        for index in 0..100 {
            let name = if index == 0 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem}-{}.{extension}", index + 1)
            };
            let name_c = CString::new(name.as_bytes())
                .map_err(|_| AppError::new(AppErrorCode::InvalidPath, "invalid image file name"))?;
            let final_fd = match openat_create_new(&assets_fd, &name_c) {
                Ok(fd) => fd,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(AppError::from_io(&error)),
            };

            let temp_name = format!(".qingmo-{}.tmp", uuid::Uuid::new_v4());
            let temp_c = CString::new(temp_name.as_bytes()).map_err(|_| {
                AppError::new(AppErrorCode::InvalidPath, "invalid temporary image name")
            })?;
            let temp_fd = match openat_create_new(&assets_fd, &temp_c) {
                Ok(fd) => fd,
                Err(error) => {
                    let _ = unlinkat(&assets_fd, &name_c);
                    return Err(AppError::from_io(&error));
                }
            };

            let mut temp_file = File::from(temp_fd);
            if let Err(error) = temp_file.write_all(data) {
                let _ = unlinkat(&assets_fd, &temp_c);
                let _ = unlinkat(&assets_fd, &name_c);
                return Err(AppError::from_io(&error));
            }
            if let Err(error) = temp_file.sync_all() {
                let _ = unlinkat(&assets_fd, &temp_c);
                let _ = unlinkat(&assets_fd, &name_c);
                return Err(AppError::from_io(&error));
            }
            drop(temp_file);

            if let Err(error) = renameat(&assets_fd, &temp_c, &assets_fd, &name_c) {
                let _ = unlinkat(&assets_fd, &temp_c);
                let _ = unlinkat(&assets_fd, &name_c);
                return Err(AppError::from_io(&error));
            }
            drop(final_fd);

            let parent_after = identity_of_fd(&parent_fd)?;
            let assets_after = identity_of_fd(&assets_fd)?;
            let assets_path_after = crate::services::file_identity::file_identity(&assets_path)?;
            let unchanged = check_parent(expected_parent, &parent_after).is_ok()
                && same_identity_opt(&assets_identity, &assets_after)
                && same_identity_opt(&assets_identity, &assets_path_after);
            if !unchanged {
                let _ = unlinkat(&assets_fd, &name_c);
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the document directory changed while saving the image",
                ));
            }

            return Ok(result_for(stem, &name, data.len(), mime));
        }

        Err(AppError::new(
            AppErrorCode::Busy,
            format!(
                "could not reserve an image filename: {}",
                last_error
                    .map(|error| error.to_string())
                    .unwrap_or_default()
            ),
        ))
    }

    fn same_identity_opt(left: &Option<FileIdentity>, right: &Option<FileIdentity>) -> bool {
        match (left, right) {
            (Some(left), Some(right)) => same_identity(left, right),
            (None, None) => true,
            _ => false,
        }
    }

    fn check_parent(
        expected: Option<&FileIdentity>,
        actual: &Option<FileIdentity>,
    ) -> Result<(), AppError> {
        let Some(expected) = expected else {
            return Ok(());
        };
        match actual {
            Some(actual) if same_identity(expected, actual) => Ok(()),
            _ => Err(AppError::new(
                AppErrorCode::Conflict,
                "the document directory changed before saving the image",
            )),
        }
    }

    fn open_dir(path: &Path) -> Result<OwnedFd, AppError> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| AppError::new(AppErrorCode::InvalidPath, "invalid directory path"))?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(AppError::from_io(&std::io::Error::last_os_error()));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn openat_dir(parent: &OwnedFd, name: &str) -> Result<OwnedFd, AppError> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| AppError::new(AppErrorCode::InvalidPath, "invalid directory name"))?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(AppError::from_io(&std::io::Error::last_os_error()));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn openat_create_new(parent: &OwnedFd, name: &CString) -> std::io::Result<OwnedFd> {
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn renameat(
        old_dir: &OwnedFd,
        old_name: &CString,
        new_dir: &OwnedFd,
        new_name: &CString,
    ) -> std::io::Result<()> {
        let result = unsafe {
            libc::renameat(
                old_dir.as_raw_fd(),
                old_name.as_ptr(),
                new_dir.as_raw_fd(),
                new_name.as_ptr(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn unlinkat(dir: &OwnedFd, name: &CString) -> std::io::Result<()> {
        let result = unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn identity_of_fd(fd: &OwnedFd) -> Result<Option<FileIdentity>, AppError> {
        let metadata = fd
            .try_clone()
            .map_err(|error| AppError::from_io(&error))
            .map(File::from)?
            .metadata()
            .map_err(|error| AppError::from_io(&error))?;
        Ok(crate::services::file_identity::identity_from_metadata(
            &metadata,
        ))
    }
}

#[cfg(not(unix))]
mod fallback {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    use super::*;
    use crate::services::file_identity::{file_identity, observe_path, FileObservation};

    pub(super) fn save_verified(
        parent: &Path,
        stem: &str,
        extension: &str,
        mime: &str,
        data: &[u8],
        expected_parent: Option<&FileIdentity>,
    ) -> Result<ImageSaveResult, AppError> {
        check_parent(expected_parent, parent)?;
        let assets = parent.join(ASSETS_DIR);
        match fs::symlink_metadata(&assets) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::new(
                        AppErrorCode::InvalidPath,
                        "the assets path is not a plain directory",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&assets).map_err(|error| AppError::from_io(&error))?;
            }
            Err(error) => return Err(AppError::from_io(&error)),
        }
        let assets_before = observe_path(&assets)?;

        let mut last_error = None;
        for index in 0..100 {
            let name = if index == 0 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem}-{}.{extension}", index + 1)
            };
            let target = assets.join(&name);
            let mut file = match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(AppError::from_io(&error)),
            };
            let temp = assets.join(format!(".qingmo-{}.tmp", uuid::Uuid::new_v4()));
            let mut temp_file = match OpenOptions::new().create_new(true).write(true).open(&temp) {
                Ok(file) => file,
                Err(error) => {
                    let _ = fs::remove_file(&target);
                    return Err(AppError::from_io(&error));
                }
            };
            if let Err(error) = temp_file.write_all(data).and_then(|_| temp_file.sync_all()) {
                let _ = fs::remove_file(&temp);
                let _ = fs::remove_file(&target);
                return Err(AppError::from_io(&error));
            }
            drop(temp_file);
            drop(&mut file);
            if let Err(error) = fs::rename(&temp, &target) {
                let _ = fs::remove_file(&temp);
                let _ = fs::remove_file(&target);
                return Err(AppError::from_io(&error));
            }
            let assets_after = observe_path(&assets)?;
            if !crate::services::file_identity::same_observation(&assets_before, &assets_after)
                || check_parent(expected_parent, parent).is_err()
            {
                let _ = fs::remove_file(&target);
                return Err(AppError::new(
                    AppErrorCode::Conflict,
                    "the document directory changed while saving the image",
                ));
            }
            return Ok(result_for(stem, &name, data.len(), mime));
        }
        Err(AppError::new(
            AppErrorCode::Busy,
            format!(
                "could not reserve an image filename: {}",
                last_error
                    .map(|error| error.to_string())
                    .unwrap_or_default()
            ),
        ))
    }

    fn check_parent(expected: Option<&FileIdentity>, parent: &Path) -> Result<(), AppError> {
        let Some(expected) = expected else {
            return Ok(());
        };
        match file_identity(parent)? {
            Some(actual) if same_identity(expected, &actual) => Ok(()),
            _ => Err(AppError::new(
                AppErrorCode::Conflict,
                "the document directory changed before saving the image",
            )),
        }
    }
}

fn normalize_mime(mime: &str) -> Result<&'static str, AppError> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Ok("image/png"),
        "image/jpeg" => Ok("image/jpeg"),
        "image/gif" => Ok("image/gif"),
        "image/webp" => Ok("image/webp"),
        "image/svg+xml" => Err(AppError::new(
            AppErrorCode::UnsupportedExtension,
            "SVG images are not accepted",
        )),
        _ => Err(AppError::new(
            AppErrorCode::UnsupportedExtension,
            "unsupported image type",
        )),
    }
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn verify_magic(bytes: &[u8], mime: &str) -> Result<(), AppError> {
    let ok = match mime {
        "image/png" => bytes.starts_with(PNG),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF8"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::new(
            AppErrorCode::UnsupportedExtension,
            "image bytes do not match the declared type",
        ))
    }
}

fn sanitize_stem(file_name: &str, extension: &str) -> String {
    let raw = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("image");
    let mut stem = String::with_capacity(raw.len());
    let mut last_dash = false;
    for character in raw.chars() {
        let allowed = character.is_alphanumeric() || character == '-' || character == '_';
        if allowed {
            stem.push(character);
            last_dash = false;
        } else if !last_dash {
            stem.push('-');
            last_dash = true;
        }
    }
    let stem = stem.trim_matches('-').to_string();
    let stem = if stem.is_empty() {
        "image".to_string()
    } else {
        stem.chars().take(80).collect()
    };
    if stem.eq_ignore_ascii_case(extension) {
        "image".to_string()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn png() -> String {
        base64::engine::general_purpose::STANDARD.encode([PNG, b"body"].concat())
    }

    #[test]
    fn writes_into_assets_and_reserves_names() {
        let dir = TempDir::new().expect("temp dir");
        let document = dir.path().join("note.md");
        fs::write(&document, "body").expect("fixture");

        let first =
            save_image(&document, "Screenshot 2026.png", "image/png", &png()).expect("save image");
        assert_eq!(first.relative_path, "assets/Screenshot-2026.png");
        assert!(dir.path().join(&first.relative_path).is_file());

        let second = save_image(&document, "Screenshot 2026.png", "image/png", &png())
            .expect("second save image");
        assert_eq!(second.relative_path, "assets/Screenshot-2026-2.png");
    }

    #[test]
    fn rejects_mismatched_magic_and_svg() {
        let dir = TempDir::new().expect("temp dir");
        let document = dir.path().join("note.md");
        fs::write(&document, "body").expect("fixture");
        assert_eq!(
            save_image(&document, "a.png", "image/png", "ZmFrZQ==")
                .expect_err("bad magic")
                .code,
            AppErrorCode::UnsupportedExtension
        );
        assert_eq!(
            save_image(&document, "a.svg", "image/svg+xml", "ZmFrZQ==")
                .expect_err("svg")
                .code,
            AppErrorCode::UnsupportedExtension
        );
    }
}
