use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::ipc::dto::{FilePayload, SaveRequest, TextEncoding, TextFormat};
use qingmo_lib::ipc::{command_permissions, COMMANDS, EVENTS};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_text(relative: &str) -> String {
    let path = manifest_dir().join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}

fn read_json(relative: &str) -> Value {
    serde_json::from_str(&read_text(relative))
        .unwrap_or_else(|error| panic!("failed to parse {relative}: {error}"))
}

#[test]
fn frontend_command_mirror_contains_every_contract_name() {
    let source = read_text("../apps/desktop/src/lib/ipc/commands.ts");

    for command in COMMANDS {
        assert!(
            source.contains(&format!("\"{command}\"")),
            "commands.ts is missing {command}"
        );
    }
    for event in EVENTS {
        assert!(
            source.contains(&format!("\"{event}\"")),
            "commands.ts is missing event {event}"
        );
    }

    assert_eq!(COMMANDS.len(), 4);
    assert_eq!(EVENTS, &["app://close-requested"]);
}

#[test]
fn capability_covers_exactly_the_application_commands() {
    let capability = read_json("capabilities/default.json");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be an array")
        .iter()
        .map(|value| value.as_str().expect("permission must be a string"))
        .collect::<Vec<_>>();

    let app_permissions = permissions
        .iter()
        .copied()
        .filter(|permission| permission.starts_with("allow-"))
        .collect::<Vec<_>>();
    assert_eq!(app_permissions, command_permissions());

    assert_eq!(capability["windows"], json!(["main"]));
}

#[test]
fn build_manifest_declares_the_same_command_list() {
    let build_script = read_text("build.rs");
    assert!(
        build_script.contains("AppManifest::new().commands(contract::COMMANDS)"),
        "build.rs must derive the app manifest from contract::COMMANDS"
    );
}

#[test]
fn dto_wire_names_are_camel_case_and_stable() {
    let request = SaveRequest {
        doc_token: "token".to_string(),
        text: "hello\n".to_string(),
        expected_current_hash: None,
    };
    let value = serde_json::to_value(&request).expect("SaveRequest must serialize");
    assert_eq!(
        value,
        json!({
            "docToken": "token",
            "text": "hello\n",
            "expectedCurrentHash": null
        })
    );

    let payload = FilePayload {
        doc_token: "token".to_string(),
        path: "/tmp/note.md".to_string(),
        text: "hello\n".to_string(),
        format: TextFormat {
            encoding: TextEncoding::Utf8,
            has_bom: false,
            eol: qingmo_lib::ipc::dto::LineEnding::Lf,
        },
        mixed_eol: false,
        hash: "a".repeat(64),
        size: 6,
        text_units: 6,
        mtime_ms: 1_700_000_000_000,
        read_only: false,
        read_only_reason: None,
    };
    let value = serde_json::to_value(&payload).expect("FilePayload must serialize");
    assert_eq!(value["docToken"], "token");
    assert_eq!(value["format"]["hasBom"], false);
    assert_eq!(value["mixedEol"], false);
    assert_eq!(value["textUnits"], 6);
    assert_eq!(value["mtimeMs"], 1_700_000_000_000i64);
    assert_eq!(value["readOnly"], false);
    assert!(value["readOnlyReason"].is_null());
}

#[test]
fn error_wire_shape_is_stable() {
    let error = AppError::new(AppErrorCode::Conflict, "file changed")
        .with_details(json!({"currentHash": "abc"}));
    let value = serde_json::to_value(&error).expect("AppError must serialize");
    assert_eq!(value["code"], "CONFLICT");
    assert_eq!(value["message"], "file changed");
    assert_eq!(value["details"]["currentHash"], "abc");
}

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("valid URL"),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<Value>().expect("valid JSON"))
}

#[test]
fn invoke_handler_registers_every_contract_command() {
    let app = tauri::test::mock_builder()
        .manage(qingmo_lib::state::DocumentRegistry::new())
        .invoke_handler(qingmo_lib::commands::handler())
        .build(tauri::generate_context!())
        .expect("mock app must build");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview must build");

    // `document_open` is registered but cannot be invoked here: it opens a
    // native dialog. Registration is asserted from the single handler source.
    let handler_source = read_text("src/commands/mod.rs");
    assert!(handler_source.contains("document::document_open"));
    assert!(handler_source.contains("document::document_reload"));
    assert!(handler_source.contains("stub::document_write_atomic"));
    assert!(handler_source.contains("stub::app_close_confirm"));

    let error = invoke(&webview, "document_reload", json!({"docToken": "fake"}))
        .expect_err("reload with a fake token must fail");
    assert_eq!(error["code"], "INVALID_PATH", "unexpected error: {error}");

    for (command, body) in [
        (
            "document_write_atomic",
            json!({"docToken": "fake", "text": "", "expectedCurrentHash": null}),
        ),
        ("app_close_confirm", json!({"allow": false})),
    ] {
        let error = invoke(&webview, command, body).expect_err("stub must return an error");
        assert_eq!(
            error["code"], "IO",
            "{command} was not registered or returned an unexpected error: {error}"
        );
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|message| message.contains("not implemented")),
            "unexpected stub message for {command}: {error}"
        );
    }
}
