use std::fs;
use std::path::{Path, PathBuf};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::{LineEnding, ReadOnlyReason, TextEncoding};
use qingmo_lib::services::file_service::MAX_FILE_BYTES;
use qingmo_lib::state::DocumentRegistry;
use tempfile::TempDir;

fn write_file(dir: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.path().join(name);
    fs::write(&path, bytes).expect("fixture must be written");
    path
}

fn write_text(dir: &TempDir, name: &str, text: &str) -> PathBuf {
    write_file(dir, name, text.as_bytes())
}

fn open_code(registry: &DocumentRegistry, path: impl AsRef<Path>) -> AppErrorCode {
    registry
        .open_path(path.as_ref().to_path_buf())
        .expect_err("open must fail")
        .code
}

fn reload_code(registry: &DocumentRegistry, token: &str) -> AppErrorCode {
    registry.reload(token).expect_err("reload must fail").code
}

#[test]
fn opens_plain_utf8_and_reports_disk_metadata() {
    let dir = TempDir::new().expect("temp dir");
    let bytes = b"# Title\n\nbody\n";
    let path = write_file(&dir, "note.md", bytes);

    let registry = DocumentRegistry::new();
    let payload = registry.open_path(path.clone()).expect("file must open");

    assert_eq!(payload.text, "# Title\n\nbody\n");
    assert_eq!(payload.format.encoding, TextEncoding::Utf8);
    assert!(!payload.format.has_bom);
    assert_eq!(payload.format.eol, LineEnding::Lf);
    assert!(!payload.mixed_eol);
    assert!(!payload.read_only);
    assert!(payload.read_only_reason.is_none());
    assert_eq!(payload.size, bytes.len() as u64);
    assert_eq!(payload.hash, blake3::hash(bytes).to_hex().to_string());
    assert_eq!(
        payload.text_units,
        payload.text.encode_utf16().count() as u64
    );
    assert!(payload.mtime_ms > 0);
    assert_eq!(
        payload.path,
        fs::canonicalize(&path).unwrap().to_string_lossy()
    );
    assert!(!payload.doc_token.is_empty());
    assert_eq!(registry.len(), 1);
}

#[test]
fn strips_boms_and_decodes_both_utf16_endians() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let utf8 = write_file(&dir, "utf8.md", b"\xEF\xBB\xBFhello");
    let payload = registry.open_path(utf8).expect("UTF-8 BOM must open");
    assert_eq!(payload.text, "hello");
    assert_eq!(payload.format.encoding, TextEncoding::Utf8);
    assert!(payload.format.has_bom);

    // UTF-16LE: FF FE + "hi\r\n"
    let utf16le = write_file(
        &dir,
        "utf16le.md",
        &[0xFF, 0xFE, b'h', 0, b'i', 0, b'\r', 0, b'\n', 0],
    );
    let payload = registry.open_path(utf16le).expect("UTF-16LE must open");
    assert_eq!(payload.text, "hi\n");
    assert_eq!(payload.format.encoding, TextEncoding::Utf16Le);
    assert_eq!(payload.format.eol, LineEnding::Crlf);
    assert!(payload.format.has_bom);

    // UTF-16BE: FE FF + "hi"
    let utf16be = write_file(&dir, "utf16be.md", &[0xFE, 0xFF, 0, b'h', 0, b'i']);
    let payload = registry.open_path(utf16be).expect("UTF-16BE must open");
    assert_eq!(payload.text, "hi");
    assert_eq!(payload.format.encoding, TextEncoding::Utf16Be);
    assert!(payload.format.has_bom);

    // UTF-16LE without a BOM must not be guessed from NUL bytes.
    let no_bom = write_file(&dir, "no-bom.md", &[b'h', 0, b'i', 0]);
    assert_eq!(
        open_code(&registry, no_bom),
        AppErrorCode::UnsupportedEncoding
    );
}

#[test]
fn rejects_utf32_invalid_utf8_nul_and_broken_surrogates() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    for (name, bytes) in [
        ("utf32le.md", vec![0xFF, 0xFE, 0x00, 0x00, b'a', 0]),
        ("utf32be.md", vec![0x00, 0x00, 0xFE, 0xFF, 0, 0, 0, b'a']),
        ("invalid.md", vec![b'a', 0xFF, b'b']),
        ("odd-utf16.md", vec![0xFF, 0xFE, b'h']),
        ("nul.md", b"a\0b".to_vec()),
    ] {
        let path = write_file(&dir, name, &bytes);
        assert_eq!(
            open_code(&registry, path),
            AppErrorCode::UnsupportedEncoding,
            "{name} must be rejected"
        );
    }
}

#[test]
fn normalizes_line_endings_and_marks_mixed_eol_read_only() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let crlf = write_text(&dir, "crlf.md", "a\r\nb\r\n");
    let payload = registry.open_path(crlf).expect("CRLF must open");
    assert_eq!(payload.text, "a\nb\n");
    assert_eq!(payload.format.eol, LineEnding::Crlf);
    assert!(!payload.mixed_eol);
    assert!(!payload.read_only);

    let cr = write_text(&dir, "cr.md", "a\rb\r");
    let payload = registry.open_path(cr).expect("CR must open");
    assert_eq!(payload.text, "a\nb\n");
    assert_eq!(payload.format.eol, LineEnding::Cr);
    assert!(!payload.mixed_eol);
    assert!(!payload.read_only);

    let lf = write_text(&dir, "lf.md", "a\nb\n");
    let payload = registry.open_path(lf).expect("LF must open");
    assert_eq!(payload.format.eol, LineEnding::Lf);
    assert!(!payload.read_only);

    let mixed = write_text(&dir, "mixed.md", "a\r\nb\nc\r");
    let payload = registry
        .open_path(mixed)
        .expect("mixed EOL must still open");
    assert_eq!(payload.text, "a\nb\nc\n");
    assert_eq!(payload.format.eol, LineEnding::Lf);
    assert!(payload.mixed_eol);
    assert!(payload.read_only);
    assert_eq!(payload.read_only_reason, Some(ReadOnlyReason::MixedEol));
}

#[test]
fn marks_mdx_read_only_even_when_mixed_eol() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let mdx = write_text(&dir, "component.mdx", "export const A = 1\r\n\n# Hi\r\n");
    let payload = registry.open_path(mdx).expect("MDX must open");
    assert!(payload.read_only);
    assert_eq!(payload.read_only_reason, Some(ReadOnlyReason::Mdx));
}

#[test]
fn enforces_the_ten_mib_boundary() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let exactly = write_file(&dir, "exactly.md", &vec![b'a'; MAX_FILE_BYTES as usize]);
    let payload = registry.open_path(exactly).expect("10 MiB must open");
    assert_eq!(payload.size, MAX_FILE_BYTES);

    let over = write_file(&dir, "over.md", &vec![b'a'; MAX_FILE_BYTES as usize + 1]);
    assert_eq!(open_code(&registry, over), AppErrorCode::FileTooLarge);
}

#[test]
fn rejects_missing_directories_and_unsupported_extensions() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    assert_eq!(
        open_code(&registry, dir.path().join("missing.md")),
        AppErrorCode::NotFound
    );

    assert_eq!(
        open_code(&registry, dir.path().join("missing.txt")),
        AppErrorCode::UnsupportedExtension
    );

    let text = write_text(&dir, "note.txt", "plain");
    assert_eq!(
        open_code(&registry, text),
        AppErrorCode::UnsupportedExtension
    );

    let directory = dir.path().join("folder.md");
    fs::create_dir(&directory).expect("directory fixture");
    assert_eq!(open_code(&registry, directory), AppErrorCode::NotAFile);

    // Extensions are matched case-insensitively.
    let upper = write_text(&dir, "UPPER.MD", "ok");
    let payload = registry
        .open_path(upper)
        .expect("uppercase extension must open");
    assert_eq!(payload.text, "ok");
}

#[test]
fn handles_unicode_paths_and_counts_utf16_units() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let path = write_text(&dir, "笔记-😀.markdown", "a😀b\n");
    let payload = registry.open_path(path).expect("unicode path must open");
    assert_eq!(payload.text, "a😀b\n");
    assert_eq!(payload.text_units, 5);
    assert!(payload.path.contains("笔记-😀.markdown"));
}

#[test]
fn rejects_forged_tokens_and_keeps_each_window_document_alive() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    assert_eq!(reload_code(&registry, "forged"), AppErrorCode::InvalidPath);
    assert!(registry.is_empty());

    let first = write_text(&dir, "first.md", "first");
    let second = write_text(&dir, "second.md", "second");

    let first_payload = registry.open_path(first).expect("first must open");
    let second_payload = registry.open_path(second).expect("second must open");

    assert_eq!(registry.len(), 2);
    let first_reload = registry
        .reload(&first_payload.doc_token)
        .expect("first window token must stay valid");
    assert_eq!(first_reload.text, "first");

    let reloaded = registry
        .reload(&second_payload.doc_token)
        .expect("second token must stay valid");
    assert_eq!(reloaded.text, "second");
    assert_eq!(reloaded.doc_token, second_payload.doc_token);

    assert!(registry.release(&first_payload.doc_token));
    assert_eq!(registry.len(), 1);
    assert_eq!(
        reload_code(&registry, &first_payload.doc_token),
        AppErrorCode::InvalidPath
    );
    assert!(!registry.release(&first_payload.doc_token));
}

#[test]
fn detects_a_symlink_swap_on_reload() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new().expect("temp dir");
    let target_a = write_text(&dir, "target-a.md", "alpha");
    let target_b = write_text(&dir, "target-b.md", "bravo");
    let link = dir.path().join("link.md");
    symlink(&target_a, &link).expect("symlink fixture");

    let registry = DocumentRegistry::new();
    let payload = registry.open_path(link.clone()).expect("symlink must open");
    assert_eq!(payload.text, "alpha");
    assert_eq!(
        payload.path,
        fs::canonicalize(&target_a).unwrap().to_string_lossy()
    );

    fs::remove_file(&link).expect("old link removed");
    symlink(&target_b, &link).expect("replacement symlink");

    assert_eq!(
        reload_code(&registry, &payload.doc_token),
        AppErrorCode::OutsideScope
    );
}

#[cfg(unix)]
#[test]
fn reports_permission_denied_for_an_unreadable_file() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().expect("temp dir");
    let path = write_text(&dir, "locked.md", "secret");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("chmod");

    let registry = DocumentRegistry::new();
    let code = open_code(&registry, &path);

    // Restore before asserting so the temp directory can be cleaned up.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod restore");
    assert_eq!(code, AppErrorCode::PermissionDenied);
}
