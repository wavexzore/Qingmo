mod common;

use std::fs;

use common::{invoke, open_file, save, temp_siblings, write_file};
use qingmo_lib::error::AppErrorCode;
use qingmo_lib::state::DocumentRegistry;
use serde_json::json;
use tempfile::TempDir;

#[test]
fn conflict_returns_current_details_and_preserves_disk() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "note.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    fs::write(&target, b"external\n").expect("external change");
    let error = save(&registry, &payload.doc_token, "mine\n", None)
        .expect_err("changed disk must conflict");

    assert_eq!(error.code, AppErrorCode::Conflict);
    let details = error.details.expect("conflict details");
    assert_eq!(
        details["currentHash"],
        blake3::hash(b"external\n").to_hex().to_string()
    );
    assert_eq!(details["currentSize"], 9);
    assert!(details["currentMtimeMs"].as_i64().unwrap() > 0);
    assert_eq!(fs::read(&target).expect("target readable"), b"external\n");
    assert!(temp_siblings(&target).is_empty());
}

#[test]
fn exact_expected_hash_allows_the_confirmed_overwrite() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "note.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    fs::write(&target, b"external\n").expect("external change");
    let conflict = save(&registry, &payload.doc_token, "mine\n", None)
        .expect_err("changed disk must conflict");
    let current_hash = conflict.details.unwrap()["currentHash"]
        .as_str()
        .expect("currentHash")
        .to_string();

    let result = save(&registry, &payload.doc_token, "mine\n", Some(&current_hash))
        .expect("exact version must save");

    assert_eq!(result.hash, blake3::hash(b"mine\n").to_hex().to_string());
    assert_eq!(fs::read(&target).expect("target readable"), b"mine\n");
}

#[test]
fn a_second_external_change_conflicts_again() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "note.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    fs::write(&target, b"first-external\n").expect("first change");
    let first = save(&registry, &payload.doc_token, "mine\n", None)
        .expect_err("first change must conflict");
    let first_hash = first.details.unwrap()["currentHash"]
        .as_str()
        .expect("first hash")
        .to_string();

    fs::write(&target, b"second-external\n").expect("second change");
    let second = save(&registry, &payload.doc_token, "mine\n", Some(&first_hash))
        .expect_err("stale confirmation must conflict again");
    assert_eq!(second.code, AppErrorCode::Conflict);
    let second_hash = second.details.unwrap()["currentHash"]
        .as_str()
        .expect("second hash")
        .to_string();
    assert_ne!(second_hash, first_hash);
    assert_eq!(
        fs::read(&target).expect("target readable"),
        b"second-external\n"
    );

    save(&registry, &payload.doc_token, "mine\n", Some(&second_hash))
        .expect("latest version must save");
    assert_eq!(fs::read(&target).expect("target readable"), b"mine\n");
}

#[test]
fn a_confirmed_noop_refreshes_the_base_hash() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "note.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    fs::write(&target, b"external\n").expect("external change");
    let conflict = save(&registry, &payload.doc_token, "external\n", None)
        .expect_err("changed disk must conflict");
    let current_hash = conflict.details.unwrap()["currentHash"]
        .as_str()
        .expect("currentHash")
        .to_string();

    save(
        &registry,
        &payload.doc_token,
        "external\n",
        Some(&current_hash),
    )
    .expect("byte-identical confirmation must succeed");

    save(&registry, &payload.doc_token, "after\n", None)
        .expect("base hash must now match the confirmed version");
    assert_eq!(fs::read(&target).expect("target readable"), b"after\n");
}

#[test]
fn read_only_documents_reject_writes_even_with_a_hash() {
    let dir = TempDir::new().expect("temp dir");
    let registry = DocumentRegistry::new();

    let mdx = write_file(&dir, "component.mdx", b"base\n");
    let mdx_payload = open_file(&registry, mdx.clone());
    assert_eq!(
        mdx_payload.read_only_reason,
        Some(qingmo_lib::ipc::dto::ReadOnlyReason::Mdx)
    );
    let error = save(
        &registry,
        &mdx_payload.doc_token,
        "mine\n",
        Some(&mdx_payload.hash),
    )
    .expect_err("MDX must stay read-only");
    assert_eq!(error.code, AppErrorCode::ReadOnly);
    assert_eq!(fs::read(&mdx).expect("mdx readable"), b"base\n");

    let mixed = write_file(&dir, "mixed.md", b"a\r\nb\n");
    let mixed_payload = open_file(&registry, mixed.clone());
    assert_eq!(
        mixed_payload.read_only_reason,
        Some(qingmo_lib::ipc::dto::ReadOnlyReason::MixedEol)
    );
    let error = save(
        &registry,
        &mixed_payload.doc_token,
        "mine\n",
        Some(&mixed_payload.hash),
    )
    .expect_err("mixed EOL must stay read-only");
    assert_eq!(error.code, AppErrorCode::ReadOnly);
    assert_eq!(fs::read(&mixed).expect("mixed readable"), b"a\r\nb\n");
}

#[test]
fn a_missing_file_returns_not_found_without_recreating_it() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "gone.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    fs::remove_file(&target).expect("delete target");
    let error =
        save(&registry, &payload.doc_token, "mine\n", None).expect_err("missing file must fail");
    assert_eq!(error.code, AppErrorCode::NotFound);
    assert!(!target.exists());
    assert!(temp_siblings(&target).is_empty());
}

#[test]
fn command_round_trip_conflict_and_invalid_token() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "command.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());

    let app = tauri::test::mock_builder()
        .manage(registry.clone())
        .invoke_handler(qingmo_lib::commands::handler())
        .build(tauri::generate_context!())
        .expect("mock app must build");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview must build");

    let result = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "new\n",
            "expectedCurrentHash": null
        }),
    )
    .expect("command must succeed");
    assert_eq!(result["size"], 4);
    assert_eq!(fs::read(&target).expect("target readable"), b"new\n");

    fs::write(&target, b"external\n").expect("external change");
    let conflict = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "mine\n",
            "expectedCurrentHash": null
        }),
    )
    .expect_err("command must report conflict");
    assert_eq!(conflict["code"], "CONFLICT");
    let current_hash = conflict["details"]["currentHash"]
        .as_str()
        .expect("currentHash");

    let forced = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "mine\n",
            "expectedCurrentHash": current_hash
        }),
    )
    .expect("confirmed command must succeed");
    assert_eq!(forced["hash"], blake3::hash(b"mine\n").to_hex().to_string());

    let invalid = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": "forged",
            "text": "mine\n",
            "expectedCurrentHash": null
        }),
    )
    .expect_err("forged token must fail");
    assert_eq!(invalid["code"], "INVALID_PATH");
}
