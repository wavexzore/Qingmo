use std::fs;
use std::path::PathBuf;

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::{LineEnding, TextEncoding};
use qingmo_lib::state::DocumentRegistry;
use tempfile::TempDir;

fn save_code(registry: &DocumentRegistry, path: PathBuf, text: &str) -> AppErrorCode {
    registry
        .save_as(path, text)
        .expect_err("save-as must fail")
        .code
}

#[test]
fn creates_a_new_utf8_file_and_registers_the_document() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("untitled.md");
    let text = "# Hello\n\n😀\n";
    let registry = DocumentRegistry::new();

    let payload = registry
        .save_as(target.clone(), text)
        .expect("save-as must create the file");

    let bytes = fs::read(&target).expect("saved file must exist");
    assert_eq!(bytes, text.as_bytes());
    assert_eq!(payload.text, text);
    assert_eq!(payload.format.encoding, TextEncoding::Utf8);
    assert!(!payload.format.has_bom);
    assert_eq!(payload.format.eol, LineEnding::Lf);
    assert!(!payload.mixed_eol);
    assert!(!payload.read_only);
    assert!(payload.read_only_reason.is_none());
    assert_eq!(payload.hash, blake3::hash(&bytes).to_hex().to_string());
    assert_eq!(payload.size, bytes.len() as u64);
    assert_eq!(payload.text_units, text.encode_utf16().count() as u64);
    assert_eq!(
        payload.path,
        fs::canonicalize(&target).unwrap().to_string_lossy()
    );
    assert!(!payload.doc_token.is_empty());
    assert_eq!(registry.len(), 1);
    assert!(registry.get(&payload.doc_token).is_ok());
}

#[test]
fn appends_md_when_the_dialog_returns_no_extension() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("note");
    let registry = DocumentRegistry::new();

    let payload = registry
        .save_as(target, "body\n")
        .expect("save-as must add the Markdown extension");

    let expected = dir.path().join("note.md");
    assert!(expected.exists(), "note.md must be created");
    assert_eq!(
        payload.path,
        fs::canonicalize(&expected).unwrap().to_string_lossy()
    );
}

#[test]
fn overwrites_existing_files_while_preserving_encoding_and_eol() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("legacy.md");
    fs::write(
        &target,
        [0xFF, 0xFE, b'o', 0, b'l', 0, b'd', 0, b'\r', 0, b'\n', 0],
    )
    .expect("fixture must be written");
    let registry = DocumentRegistry::new();

    let payload = registry
        .save_as(target.clone(), "new\n")
        .expect("save-as must overwrite the existing file");

    assert_eq!(payload.text, "new\n");
    assert_eq!(payload.format.encoding, TextEncoding::Utf16Le);
    assert!(payload.format.has_bom);
    assert_eq!(payload.format.eol, LineEnding::Crlf);
    assert_eq!(
        fs::read(&target).expect("saved file must exist"),
        [0xFF, 0xFE, b'n', 0, b'e', 0, b'w', 0, b'\r', 0, b'\n', 0,]
    );
    assert_eq!(payload.size, 12);
}

#[test]
fn keeps_other_window_tokens_after_save_as() {
    let dir = TempDir::new().expect("temp dir");
    let first_path = dir.path().join("first.md");
    fs::write(&first_path, "first\n").expect("fixture must be written");
    let registry = DocumentRegistry::new();
    let first = registry
        .open_path(first_path.clone())
        .expect("first file must open");

    let second = registry
        .save_as(dir.path().join("second.md"), "second\n")
        .expect("save-as must create the second file");

    assert_ne!(first.doc_token, second.doc_token);
    assert!(
        registry.get(&first.doc_token).is_ok(),
        "another window must keep its token"
    );
    assert!(registry.get(&second.doc_token).is_ok());
    assert_eq!(registry.len(), 2);
    assert_eq!(
        fs::read_to_string(first_path).expect("first file must still exist"),
        "first\n"
    );
}

#[test]
fn rejects_unsupported_extensions_and_mdx_targets() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    assert_eq!(
        save_code(&registry, dir.path().join("note.txt"), "body\n"),
        AppErrorCode::UnsupportedExtension
    );
    assert_eq!(
        save_code(&registry, dir.path().join("note.mdx"), "body\n"),
        AppErrorCode::UnsupportedExtension
    );
    assert!(!dir.path().join("note.txt").exists());
    assert!(!dir.path().join("note.mdx").exists());
}

#[test]
fn rejects_invalid_text_and_missing_parents_without_writing() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();
    let target = dir.path().join("note.md");

    assert_eq!(
        save_code(&registry, target.clone(), "a\r\nb"),
        AppErrorCode::Io
    );
    assert!(!target.exists());

    assert_eq!(
        save_code(&registry, target.clone(), "a\0b"),
        AppErrorCode::Io
    );
    assert!(!target.exists());

    assert_eq!(
        save_code(
            &registry,
            dir.path().join("missing").join("note.md"),
            "body"
        ),
        AppErrorCode::NotFound
    );
    assert!(!dir.path().join("missing").exists());
}
