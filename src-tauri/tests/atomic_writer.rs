mod common;

use std::fs;

use common::{encode_utf16, open_file, save, temp_siblings, write_file};
use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::LineEnding;
use qingmo_lib::services::file_service::MAX_FILE_BYTES;
use qingmo_lib::state::DocumentRegistry;
use tempfile::TempDir;

#[test]
fn writes_utf8_lf_and_updates_metadata() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "note.md", b"old\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let result = save(&registry, &payload.doc_token, "new\n", None).expect("save must succeed");

    assert_eq!(fs::read(&target).expect("target readable"), b"new\n");
    assert_eq!(result.hash, blake3::hash(b"new\n").to_hex().to_string());
    assert_eq!(result.size, 4);
    assert!(result.mtime_ms > 0);
    assert!(temp_siblings(&target).is_empty());

    let reloaded = registry
        .reload(&payload.doc_token)
        .expect("reload must succeed");
    assert_eq!(reloaded.text, "new\n");
    assert_eq!(reloaded.format.eol, LineEnding::Lf);
    assert_eq!(reloaded.text_units, 4);
}

#[test]
fn preserves_utf8_bom_and_each_line_ending() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let mut utf8_bom_crlf = vec![0xEF, 0xBB, 0xBF];
    utf8_bom_crlf.extend_from_slice(b"old\r\n");
    let target = write_file(&dir, "bom.md", &utf8_bom_crlf);
    let payload = open_file(&registry, target.clone());
    assert!(payload.format.has_bom);
    assert_eq!(payload.format.eol, LineEnding::Crlf);
    save(&registry, &payload.doc_token, "new\n", None).expect("save must succeed");
    let mut expected = vec![0xEF, 0xBB, 0xBF];
    expected.extend_from_slice(b"new\r\n");
    assert_eq!(fs::read(&target).expect("target readable"), expected);

    let target = write_file(&dir, "cr.md", b"old\r");
    let payload = open_file(&registry, target.clone());
    assert_eq!(payload.format.eol, LineEnding::Cr);
    save(&registry, &payload.doc_token, "new\n", None).expect("save must succeed");
    assert_eq!(fs::read(&target).expect("target readable"), b"new\r");
}

#[test]
fn preserves_utf16le_bom_and_crlf_byte_for_byte() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "utf16le.md", &encode_utf16("old\r\n", true, true));
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    assert_eq!(
        payload.format.encoding,
        qingmo_lib::ipc::dto::TextEncoding::Utf16Le
    );
    assert_eq!(payload.format.eol, LineEnding::Crlf);

    save(&registry, &payload.doc_token, "new\n", None).expect("save must succeed");

    assert_eq!(
        fs::read(&target).expect("target readable"),
        encode_utf16("new\r\n", true, true)
    );
    let reloaded = registry.reload(&payload.doc_token).expect("reload");
    assert_eq!(reloaded.text, "new\n");
}

#[test]
fn preserves_utf16be_bom_and_lf_byte_for_byte() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "utf16be.md", &encode_utf16("old\n", false, true));
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    assert_eq!(
        payload.format.encoding,
        qingmo_lib::ipc::dto::TextEncoding::Utf16Be
    );

    save(&registry, &payload.doc_token, "新\n", None).expect("save must succeed");

    assert_eq!(
        fs::read(&target).expect("target readable"),
        encode_utf16("新\n", false, true)
    );
    let reloaded = registry.reload(&payload.doc_token).expect("reload");
    assert_eq!(reloaded.text, "新\n");
}

#[test]
fn writes_an_empty_document() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "empty.md", b"old\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let result = save(&registry, &payload.doc_token, "", None).expect("save must succeed");

    assert_eq!(result.size, 0);
    assert_eq!(fs::read(&target).expect("target readable"), b"");
    let reloaded = registry.reload(&payload.doc_token).expect("reload");
    assert_eq!(reloaded.text, "");
    assert_eq!(reloaded.size, 0);
    assert_eq!(reloaded.format.eol, LineEnding::Lf);
}

#[cfg(unix)]
#[test]
fn identical_bytes_do_not_rewrite_the_file() {
    use std::os::unix::fs::MetadataExt;

    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "same.md", b"same\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    let before = fs::metadata(&target).expect("metadata");

    let result = save(&registry, &payload.doc_token, "same\n", None).expect("save must succeed");

    let after = fs::metadata(&target).expect("metadata");
    assert_eq!(result.hash, before_hash(&target));
    assert_eq!(result.size, 5);
    assert_eq!(after.ino(), before.ino());
    assert_eq!(after.modified().unwrap(), before.modified().unwrap());
    assert!(temp_siblings(&target).is_empty());
}

#[test]
fn rejects_cr_nul_and_oversized_text_without_touching_the_file() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "guarded.md", b"old\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let cr = save(&registry, &payload.doc_token, "a\r\nb", None).expect_err("CR must fail");
    assert_eq!(cr.code, AppErrorCode::Io);

    let nul = save(&registry, &payload.doc_token, "a\0b", None).expect_err("NUL must fail");
    assert_eq!(nul.code, AppErrorCode::Io);

    let oversized = "a".repeat(MAX_FILE_BYTES as usize + 1);
    let too_large =
        save(&registry, &payload.doc_token, &oversized, None).expect_err("oversize must fail");
    assert_eq!(too_large.code, AppErrorCode::FileTooLarge);

    assert_eq!(fs::read(&target).expect("target readable"), b"old\n");
    assert!(temp_siblings(&target).is_empty());
}

#[test]
fn enforces_the_encoded_size_limit() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let crlf_target = write_file(&dir, "crlf-limit.md", b"old\r\n");
    let crlf_payload = open_file(&registry, crlf_target);
    let crlf_text = format!("{}\n", "a".repeat(MAX_FILE_BYTES as usize - 1));
    let error = save(&registry, &crlf_payload.doc_token, &crlf_text, None)
        .expect_err("CRLF expansion must exceed the limit");
    assert_eq!(error.code, AppErrorCode::FileTooLarge);

    let utf16_target = write_file(&dir, "utf16-limit.md", &encode_utf16("old\n", true, true));
    let utf16_payload = open_file(&registry, utf16_target);
    let utf16_text = "a".repeat((MAX_FILE_BYTES / 2) as usize + 1);
    let error = save(&registry, &utf16_payload.doc_token, &utf16_text, None)
        .expect_err("UTF-16 expansion must exceed the limit");
    assert_eq!(error.code, AppErrorCode::FileTooLarge);
}

#[cfg(unix)]
#[test]
fn preserves_unix_mode_and_owner() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "mode.md", b"old\n");
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).expect("chmod");
    let before = fs::metadata(&target).expect("metadata");

    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    save(&registry, &payload.doc_token, "new\n", None).expect("save must succeed");

    let after = fs::metadata(&target).expect("metadata");
    assert_eq!(after.mode() & 0o777, 0o640);
    assert_eq!(after.uid(), before.uid());
    assert_eq!(after.gid(), before.gid());
}

#[cfg(unix)]
#[test]
fn eacces_keeps_the_old_file_and_creates_no_temp() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let dir = TempDir::new().expect("temp dir");
    let probe = write_file(&dir, "probe", b"x");
    let effective_uid = fs::metadata(&probe).expect("probe metadata").uid();
    fs::remove_file(&probe).expect("probe removed");
    if effective_uid == 0 {
        return;
    }

    let locked = dir.path().join("locked");
    fs::create_dir(&locked).expect("locked dir");
    let target = locked.join("note.md");
    fs::write(&target, b"old\n").expect("target");

    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).expect("lock dir");
    let error = save(&registry, &payload.doc_token, "new\n", None)
        .expect_err("read-only directory must fail");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("unlock dir");

    assert_eq!(error.code, AppErrorCode::PermissionDenied);
    assert_eq!(fs::read(&target).expect("target readable"), b"old\n");
    assert!(temp_siblings(&target).is_empty());
}

#[cfg(unix)]
fn before_hash(path: &std::path::Path) -> String {
    blake3::hash(&fs::read(path).expect("hash source"))
        .to_hex()
        .to_string()
}
