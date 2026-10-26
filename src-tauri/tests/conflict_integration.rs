//! Command-level conflict integration.
//!
//! The lower-level `conflict.rs` verifies the writer/registry contract. This
//! file goes through `document_write_atomic` and `document_reload` with a mock
//! webview so error serialization, base-hash refresh and encoding preservation
//! are exercised across the real IPC boundary.

mod common;

use std::fs;

use common::{encode_utf16, invoke, open_file, write_file};
use qingmo_lib::state::DocumentRegistry;
use serde_json::json;
use tempfile::TempDir;

type MockApp = tauri::App<tauri::test::MockRuntime>;
type MockWebview = tauri::WebviewWindow<tauri::test::MockRuntime>;

fn mock_webview(registry: DocumentRegistry) -> (MockApp, MockWebview) {
    let app = tauri::test::mock_builder()
        .manage(registry)
        .invoke_handler(qingmo_lib::commands::handler())
        .build(tauri::generate_context!())
        .expect("mock app must build");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview must build");
    (app, webview)
}

#[test]
fn reload_command_refreshes_the_base_hash_after_an_external_change() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "reload.md", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    let (app, webview) = mock_webview(registry);
    let _ = &app;

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
    .expect_err("changed disk must conflict");
    assert_eq!(conflict["code"], "CONFLICT");
    assert_eq!(
        conflict["details"]["currentHash"],
        blake3::hash(b"external\n").to_hex().to_string()
    );
    assert_eq!(fs::read(&target).expect("target readable"), b"external\n");

    let reloaded = invoke(
        &webview,
        "document_reload",
        json!({ "docToken": payload.doc_token }),
    )
    .expect("reload command must succeed");
    assert_eq!(reloaded["text"], "external\n");
    assert_eq!(
        reloaded["hash"],
        blake3::hash(b"external\n").to_hex().to_string()
    );

    // Reload replaces the base hash, so the next normal save is not a conflict.
    let saved = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "mine\n",
            "expectedCurrentHash": null
        }),
    )
    .expect("save after reload must succeed");
    assert_eq!(saved["hash"], blake3::hash(b"mine\n").to_hex().to_string());
    assert_eq!(fs::read(&target).expect("target readable"), b"mine\n");
}

#[test]
fn utf16_conflict_overwrite_preserves_bom_and_crlf() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(
        &dir,
        "utf16-conflict.md",
        &encode_utf16("old\r\n", true, true),
    );
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    let (app, webview) = mock_webview(registry);
    let _ = &app;

    let external = encode_utf16("external\r\n", true, true);
    fs::write(&target, &external).expect("external change");

    let conflict = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "新\n",
            "expectedCurrentHash": null
        }),
    )
    .expect_err("UTF-16 disk change must conflict");
    assert_eq!(conflict["code"], "CONFLICT");
    let current_hash = conflict["details"]["currentHash"]
        .as_str()
        .expect("currentHash")
        .to_string();
    assert_eq!(current_hash, blake3::hash(&external).to_hex().to_string());

    let forced = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "新\n",
            "expectedCurrentHash": current_hash
        }),
    )
    .expect("exact UTF-16 overwrite must succeed");

    let expected = encode_utf16("新\r\n", true, true);
    assert_eq!(fs::read(&target).expect("target readable"), expected);
    assert_eq!(forced["size"], expected.len() as u64);

    let reloaded = invoke(
        &webview,
        "document_reload",
        json!({ "docToken": payload.doc_token }),
    )
    .expect("reload command must succeed");
    assert_eq!(reloaded["text"], "新\n");
    assert_eq!(reloaded["format"]["encoding"], "utf16Le");
    assert_eq!(reloaded["format"]["hasBom"], true);
    assert_eq!(reloaded["format"]["eol"], "crlf");
    assert_eq!(reloaded["hash"], forced["hash"]);
}

#[test]
fn read_only_mdx_command_rejects_writes_and_preserves_bytes() {
    let dir = TempDir::new().expect("temp dir");
    let target = write_file(&dir, "component.mdx", b"base\n");
    let registry = DocumentRegistry::new();
    let payload = open_file(&registry, target.clone());
    assert!(payload.read_only);
    let (app, webview) = mock_webview(registry);
    let _ = &app;

    let error = invoke(
        &webview,
        "document_write_atomic",
        json!({
            "docToken": payload.doc_token,
            "text": "mine\n",
            "expectedCurrentHash": payload.hash
        }),
    )
    .expect_err("MDX write must be rejected");
    assert_eq!(error["code"], "READ_ONLY");
    assert_eq!(fs::read(&target).expect("target readable"), b"base\n");
}
