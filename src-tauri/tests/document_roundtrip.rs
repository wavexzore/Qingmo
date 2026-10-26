//! Cross-registry round-trip coverage.
//!
//! `document_open.rs` focuses on decoding and `atomic_writer.rs` on bytes at
//! rest. This file closes the loop: open -> edit -> save -> reopen through a
//! fresh registry (the app-restart case) for every supported on-disk format.

mod common;

use std::fs;

use common::{encode_utf16, open_file, save, temp_siblings, write_file};
use qingmo_lib::ipc::dto::{LineEnding, TextEncoding};
use qingmo_lib::services::file_service::MAX_FILE_BYTES;
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
    let initial = "a".repeat(MAX_FILE_BYTES as usize - 1);
    let target = write_file(&dir, "ten-mib.md", initial.as_bytes());
    let registry = DocumentRegistry::new();

    let payload = open_file(&registry, target.clone());
    assert_eq!(payload.size, MAX_FILE_BYTES - 1);
    assert_eq!(payload.text.len(), initial.len());

    // Grow to exactly the limit; adding one more byte must stay rejected by
    // the existing boundary tests, not silently accepted here.
    let edited = format!("{initial}\n");
    let saved = save(&registry, &payload.doc_token, &edited, None).expect("exact limit must save");
    assert_eq!(saved.size, MAX_FILE_BYTES);

    let bytes = fs::read(&target).expect("target readable");
    assert_eq!(bytes.len() as u64, MAX_FILE_BYTES);
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert!(temp_siblings(&target).is_empty());

    let reopened = DocumentRegistry::new()
        .open_path(target)
        .expect("10 MiB must reopen");
    assert_eq!(reopened.text_units as u64, MAX_FILE_BYTES);
    assert_eq!(reopened.text, edited);
    assert_eq!(reopened.hash, saved.hash);
}
