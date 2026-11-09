//! Cross-registry round-trip coverage.
//!
//! `document_open.rs` focuses on decoding and `atomic_writer.rs` on bytes at
//! rest. This file closes the loop: open -> edit -> save -> reopen through a
//! fresh registry (the app-restart case) for every supported on-disk format.

mod common;

use std::fs;

use common::{encode_utf16, open_file, save, temp_siblings, write_file};
use qingmo_lib::ipc::dto::{LineEnding, TextEncoding};
use qingmo_lib::services::file_service::{MAX_DOCUMENT_BYTES, MAX_WRITE_BYTES};

const TEN_MIB: u64 = 10 * 1024 * 1024;
use qingmo_lib::state::DocumentRegistry;
use tempfile::TempDir;

struct Case {
    name: &'static str,
    bytes: Vec<u8>,
    encoding: TextEncoding,
    eol: LineEnding,
    has_bom: bool,
}

fn expected_bytes(text: &str, encoding: TextEncoding, eol: LineEnding, has_bom: bool) -> Vec<u8> {
    let body = text.replace(
        '\n',
        match eol {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
            LineEnding::Cr => "\r",
        },
    );
    match encoding {
        TextEncoding::Utf8 => {
            let mut bytes = if has_bom {
                vec![0xEF, 0xBB, 0xBF]
            } else {
                Vec::new()
            };
            bytes.extend_from_slice(body.as_bytes());
            bytes
        }
        TextEncoding::Utf16Le => encode_utf16(&body, true, has_bom),
        TextEncoding::Utf16Be => encode_utf16(&body, false, has_bom),
    }
}

fn cases() -> Vec<Case> {
    let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
    utf8_bom.extend_from_slice(b"old\r\n");

    vec![
        Case {
            name: "plain-utf8.md",
            bytes: b"old\n".to_vec(),
            encoding: TextEncoding::Utf8,
            eol: LineEnding::Lf,
            has_bom: false,
        },
        Case {
            name: "utf8-bom-crlf.md",
            bytes: utf8_bom,
            encoding: TextEncoding::Utf8,
            eol: LineEnding::Crlf,
            has_bom: true,
        },
        Case {
            name: "utf16le-bom-crlf.md",
            bytes: encode_utf16("old\r\n", true, true),
            encoding: TextEncoding::Utf16Le,
            eol: LineEnding::Crlf,
            has_bom: true,
        },
        Case {
            name: "utf16be-bom-lf.md",
            bytes: encode_utf16("old\n", false, true),
            encoding: TextEncoding::Utf16Be,
            eol: LineEnding::Lf,
            has_bom: true,
        },
    ]
}

#[test]
fn open_edit_save_and_reopen_preserves_each_supported_format() {
    let dir = TempDir::new().expect("temp dir");
    let edited = "新标题\n\n正文 line\n";

    for case in cases() {
        let target = write_file(&dir, case.name, &case.bytes);
        let registry = DocumentRegistry::new();
        let payload = open_file(&registry, target.clone());

        assert_eq!(payload.format.encoding, case.encoding, "{}", case.name);
        assert_eq!(payload.format.eol, case.eol, "{}", case.name);
        assert_eq!(payload.format.has_bom, case.has_bom, "{}", case.name);

        let saved = save(&registry, &payload.doc_token, edited, None)
            .unwrap_or_else(|error| panic!("{} must save: {error:?}", case.name));
        let bytes = fs::read(&target).expect("target readable");

        assert_eq!(
            bytes,
            expected_bytes(edited, case.encoding, case.eol, case.has_bom),
            "{} bytes",
            case.name
        );
        assert_eq!(
            saved.hash,
            blake3::hash(&bytes).to_hex().to_string(),
            "{} hash",
            case.name
        );
        assert!(
            temp_siblings(&target).is_empty(),
            "{} temp files",
            case.name
        );

        // A fresh registry models the next app launch: identity is the path,
        // not the in-memory token, and the decoded text must match exactly.
        let reopened = DocumentRegistry::new()
            .open_path(target)
            .unwrap_or_else(|error| panic!("{} must reopen: {error:?}", case.name));
        assert_eq!(reopened.text, edited, "{} reopened text", case.name);
        assert_eq!(reopened.format.encoding, case.encoding, "{}", case.name);
        assert_eq!(reopened.format.eol, case.eol, "{}", case.name);
        assert_eq!(reopened.format.has_bom, case.has_bom, "{}", case.name);
        assert_eq!(reopened.hash, saved.hash, "{} reopened hash", case.name);
    }
}

#[test]
fn ten_mib_open_edit_save_and_reopen_has_no_truncation() {
    let dir = TempDir::new().expect("temp dir");
    let initial = "a".repeat(TEN_MIB as usize - 1);
    let target = write_file(&dir, "ten-mib.md", initial.as_bytes());
    let registry = DocumentRegistry::new();

    let payload = open_file(&registry, target.clone());
    assert_eq!(payload.size, TEN_MIB - 1);
    assert_eq!(payload.text.len(), initial.len());

    // Grow to exactly the limit; adding one more byte must stay rejected by
    // the existing boundary tests, not silently accepted here.
    let edited = format!("{initial}\n");
    let saved = save(&registry, &payload.doc_token, &edited, None).expect("exact limit must save");
    assert_eq!(saved.size, TEN_MIB);

    let bytes = fs::read(&target).expect("target readable");
    assert_eq!(bytes.len() as u64, TEN_MIB);
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert!(temp_siblings(&target).is_empty());

    let reopened = DocumentRegistry::new()
        .open_path(target)
        .expect("10 MiB must reopen");
    assert_eq!(reopened.text_units as u64, TEN_MIB);
    assert_eq!(reopened.text, edited);
    assert_eq!(reopened.hash, saved.hash);
}

#[test]
fn a_ten_mib_lf_file_can_grow_by_one_character() {
    let dir = TempDir::new().expect("temp dir");
    let text = "a".repeat(TEN_MIB as usize);
    let target = write_file(&dir, "ten-mib.md", text.as_bytes());
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let edited = format!("{text}!");
    let saved = save(&registry, &payload.doc_token, &edited, None).expect("save must succeed");
    assert_eq!(saved.size, TEN_MIB + 1);
    assert_eq!(fs::read_to_string(&target).expect("read"), edited);

    let reopened = DocumentRegistry::new()
        .open_path(target)
        .expect("10 MiB + 1 must reopen after save");
    assert_eq!(reopened.text, edited);
    assert_eq!(reopened.hash, saved.hash);
}

#[test]
fn a_ten_mib_crlf_file_keeps_its_eol_when_it_grows() {
    let dir = TempDir::new().expect("temp dir");
    let line = format!("{}\r\n", "a".repeat(1022));
    let lines = TEN_MIB as usize / line.len();
    let bytes = line.repeat(lines);
    assert_eq!(bytes.len() as u64, TEN_MIB);
    let target = write_file(&dir, "ten-mib-crlf.md", bytes.as_bytes());
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    assert_eq!(payload.format.eol, LineEnding::Crlf);

    let mut edited = String::with_capacity(payload.text.len() + 1);
    edited.push_str(&payload.text);
    edited.push('x');
    let saved = save(&registry, &payload.doc_token, &edited, None).expect("save must succeed");
    assert_eq!(saved.size, TEN_MIB + 1);
    let written = fs::read(&target).expect("read");
    assert_eq!(written.len() as u64, TEN_MIB + 1);
    assert_eq!(
        written
            .windows(2)
            .filter(|window| *window == b"\r\n")
            .count(),
        lines
    );
}

#[test]
fn a_ten_mib_utf16_file_can_grow_by_one_character() {
    let dir = TempDir::new().expect("temp dir");
    let units = (TEN_MIB as usize - 2) / 2;
    let bytes = encode_utf16(&"a".repeat(units), true, true);
    assert_eq!(bytes.len() as u64, TEN_MIB);
    let target = write_file(&dir, "ten-mib-utf16.md", &bytes);
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    assert_eq!(payload.format.encoding, TextEncoding::Utf16Le);

    let edited = format!("{}b", payload.text);
    let saved = save(&registry, &payload.doc_token, &edited, None).expect("save must succeed");
    assert_eq!(saved.size, TEN_MIB + 2);
    assert_eq!(
        fs::read(&target).expect("read"),
        encode_utf16(&edited, true, true)
    );
}

#[test]
fn sixteen_mib_is_the_hard_save_boundary() {
    let dir = TempDir::new().expect("temp dir");
    let text = "a".repeat(MAX_DOCUMENT_BYTES as usize);
    let target = write_file(&dir, "sixteen-mib.md", text.as_bytes());
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let mut edited = text.clone();
    edited.pop();
    edited.push('b');
    let saved = save(&registry, &payload.doc_token, &edited, None).expect("16 MiB must save");
    assert_eq!(saved.size, MAX_DOCUMENT_BYTES);

    let too_large = format!("{edited}!");
    let error = save(&registry, &payload.doc_token, &too_large, None)
        .expect_err("16 MiB + 1 must be rejected");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::FileTooLarge);
}

#[test]
fn an_external_file_above_the_write_limit_fails_without_rewriting() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "grown.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let grown = vec![b'x'; MAX_WRITE_BYTES as usize + 1];
    fs::write(&target, &grown).expect("external growth");
    let error = save(&registry, &payload.doc_token, "mine\n", None)
        .expect_err("oversized external file must fail");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::FileTooLarge);
    assert_eq!(fs::read(&target).expect("read"), grown);
}

#[test]
fn reload_follows_an_open_document_renamed_to_txt() {
    let dir = TempDir::new().expect("temp dir");
    let old = write_file(&dir, "note.md", b"old body\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, old.clone());

    let renamed = dir.path().join("note.txt");
    fs::rename(&old, &renamed).expect("rename");
    registry
        .rekey_path(&old, &renamed, dir.path())
        .expect("rekey after an external rename");
    fs::write(&renamed, "new body\n").expect("external edit");

    let reloaded = registry
        .reload(&payload.doc_token)
        .expect("a renamed buffer must still reload");
    assert_eq!(reloaded.text, "new body\n");
    assert_eq!(reloaded.size, 9);
}

#[test]
fn save_as_over_an_existing_target_captures_its_old_history() {
    let dir = TempDir::new().expect("temp dir");
    let history =
        qingmo_lib::services::HistoryStore::open(dir.path().join("history")).expect("history");
    let registry = DocumentRegistry::new();
    registry.configure_services(Some(history.clone()), None, None);
    let target = dir.path().join("target.md");
    fs::write(&target, "old body\n").expect("fixture");
    let canonical = fs::canonicalize(&target).expect("canonical");

    let payload = registry
        .save_as(target.clone(), "new body\n")
        .expect("save as");
    assert_eq!(
        fs::read_to_string(&canonical).expect("target"),
        "new body\n"
    );

    let entries = history.list(&canonical, 10, 0);
    assert_eq!(entries.len(), 1, "the overwritten version must be captured");
    let raw = history
        .read_raw(&canonical, &entries[0].id)
        .expect("captured raw");
    assert_eq!(raw.0, b"old body\n");
    assert_eq!(payload.text, "new body\n");
}

#[test]
fn save_as_rejects_an_oversized_target_before_reading_it_into_the_editor() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("huge.md");
    fs::write(&target, vec![b'a'; MAX_DOCUMENT_BYTES as usize + 1]).expect("fixture");
    let registry = DocumentRegistry::new();

    let error = registry
        .save_as(target.clone(), "tiny\n")
        .expect_err("an oversized target must be rejected");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::FileTooLarge);
    assert_eq!(
        fs::metadata(&target).expect("target").len(),
        MAX_DOCUMENT_BYTES + 1,
        "the rejected save must not truncate the target"
    );
}

#[cfg(unix)]
#[test]
fn save_as_through_a_symlink_writes_the_target_and_keeps_the_link() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "target.md", b"old body\n");
    let link = dir.path().join("link.md");
    symlink(&target, &link).expect("symlink");
    let canonical = fs::canonicalize(&target).expect("canonical");
    let registry = DocumentRegistry::new();

    let payload = registry
        .save_as(link.clone(), "new body\n")
        .expect("save through symlink");
    assert_eq!(
        fs::read_link(&link).expect("link"),
        target,
        "Save As must not replace the user's link"
    );
    assert_eq!(
        fs::read_to_string(&canonical).expect("target"),
        "new body\n"
    );

    let record = registry.get(&payload.doc_token).expect("record");
    assert_eq!(record.raw_selected().expect("raw"), link);
    assert_eq!(record.canonical_target().expect("canonical"), canonical);
}
