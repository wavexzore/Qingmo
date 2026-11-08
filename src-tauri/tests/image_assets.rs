//! Image paste persistence contract: only images with matching magic bytes,
//! a 10 MiB cap, and never overwriting an existing asset.

use std::fs;

use base64::Engine;
use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::image_assets::{save_image, MAX_IMAGE_BYTES};
use tempfile::TempDir;

const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

fn document(dir: &TempDir) -> std::path::PathBuf {
    let path = dir.path().join("note.md");
    fs::write(&path, "body\n").expect("fixture");
    path
}

fn png_bytes() -> Vec<u8> {
    [PNG, b"body"].concat()
}

#[test]
fn saves_next_to_the_document_and_never_overwrites() {
    let dir = TempDir::new().expect("temp dir");
    let document = document(&dir);
    let data = base64::engine::general_purpose::STANDARD.encode(png_bytes());

    // Ten pastes of the same display name must produce ten distinct files.
    let mut paths = Vec::new();
    for _ in 0..10 {
        let saved = save_image(&document, "Screenshot 2026.png", "image/png", &data)
            .expect("repeated save");
        paths.push(saved.relative_path);
    }

    assert_eq!(paths[0], "assets/Screenshot-2026.png");
    for (index, path) in paths.iter().enumerate() {
        if index > 0 {
            assert_eq!(path, &format!("assets/Screenshot-2026-{}.png", index + 1));
        }
        assert!(dir.path().join(path).is_file(), "missing {path}");
    }
    let mut unique = paths.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 10);
}

#[test]
fn sanitizes_path_components_in_the_display_name() {
    let dir = TempDir::new().expect("temp dir");
    let document = document(&dir);
    let data = base64::engine::general_purpose::STANDARD.encode(png_bytes());
    let saved = save_image(&document, "../../evil name.png", "image/png", &data).expect("saved");
    assert_eq!(saved.relative_path, "assets/evil-name.png");
    assert!(dir.path().join(&saved.relative_path).is_file());
    assert!(!dir.path().join("evil").exists());
}

#[test]
fn rejects_svg_and_mismatched_magic_without_writing() {
    let dir = TempDir::new().expect("temp dir");
    let document = document(&dir);
    let fake = base64::engine::general_purpose::STANDARD.encode(b"not an image");

    assert_eq!(
        save_image(&document, "x.png", "image/png", &fake)
            .expect_err("bad magic")
            .code,
        AppErrorCode::UnsupportedExtension
    );
    assert_eq!(
        save_image(&document, "x.svg", "image/svg+xml", &fake)
            .expect_err("svg")
            .code,
        AppErrorCode::UnsupportedExtension
    );
    assert!(!dir.path().join("assets").exists());
}

#[test]
fn enforces_the_decoded_ten_mib_cap() {
    let dir = TempDir::new().expect("temp dir");
    let document = document(&dir);
    let mut oversized = png_bytes();
    oversized.resize(MAX_IMAGE_BYTES as usize + 1, 0);
    let data = base64::engine::general_purpose::STANDARD.encode(oversized);

    assert_eq!(
        save_image(&document, "huge.png", "image/png", &data)
            .expect_err("oversized image")
            .code,
        AppErrorCode::FileTooLarge
    );
    assert!(!dir.path().join("assets").exists());
}

#[test]
fn accepts_gif_jpeg_and_webp_magic() {
    let dir = TempDir::new().expect("temp dir");
    let document = document(&dir);
    let engine = base64::engine::general_purpose::STANDARD;

    let gif = engine.encode([b"GIF8".as_slice(), b"body"].concat());
    let jpeg = engine.encode([&[0xFF, 0xD8, 0xFF][..], b"body"].concat());
    let webp = engine.encode(
        [
            b"RIFF".as_slice(),
            &[0, 0, 0, 0][..],
            b"WEBP".as_slice(),
            b"body",
        ]
        .concat(),
    );

    assert_eq!(
        save_image(&document, "a.gif", "image/gif", &gif)
            .expect("gif")
            .relative_path,
        "assets/a.gif"
    );
    assert_eq!(
        save_image(&document, "a.jpg", "image/jpeg", &jpeg)
            .expect("jpeg")
            .relative_path,
        "assets/a.jpg"
    );
    assert_eq!(
        save_image(&document, "a.webp", "image/webp", &webp)
            .expect("webp")
            .relative_path,
        "assets/a.webp"
    );
}
