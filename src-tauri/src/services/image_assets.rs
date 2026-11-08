//! Image paste/drop persistence next to the document.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use base64::Engine;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::ImageSaveResult;

pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const ASSETS_DIR: &str = "assets";

const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

pub fn save_image(
    document: &Path,
    file_name: &str,
    mime: &str,
    data_base64: &str,
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
    let assets = parent.join(ASSETS_DIR);
    fs::create_dir_all(&assets).map_err(|error| AppError::from_io(&error))?;

    let extension = extension_for(mime);
    let stem = sanitize_stem(file_name, extension);
    let mut last_error = None;
    for index in 0..100 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{}.{extension}", index + 1)
        };
        let target = assets.join(&name);
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(&data)
                    .map_err(|error| AppError::from_io(&error))?;
                file.sync_all().map_err(|error| AppError::from_io(&error))?;
                let relative = format!("{ASSETS_DIR}/{name}");
                return Ok(ImageSaveResult {
                    markdown: format!("![{stem}]({relative})"),
                    relative_path: relative,
                    size_bytes: data.len() as u64,
                    mime: mime.to_string(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => return Err(AppError::from_io(&error)),
        }
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
