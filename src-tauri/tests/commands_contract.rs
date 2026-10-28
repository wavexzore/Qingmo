use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::ipc::dto::{
    AboutLink, CloseReason, FilePayload, SaveRequest, TextEncoding, TextFormat, UpdateInfo,
    UpdatePhase, UpdateSnapshot,
};
use qingmo_lib::ipc::{command_permissions, COMMANDS, EVENTS};
use qingmo_lib::state::CloseGuard;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

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

fn capability_permissions(relative: &str) -> Vec<String> {
    read_json(relative)["permissions"]
        .as_array()
        .expect("permissions must be an array")
        .iter()
        .map(|value| value.as_str().expect("permission must be a string"))
        .map(str::to_string)
        .collect()
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

    assert_eq!(COMMANDS.len(), 19);
    assert_eq!(
        EVENTS,
        &[
            "app://close-requested",
            "app://update-state",
            "app://update-progress",
            "app://menu-action"
        ]
    );

    for action in qingmo_lib::ipc::contract::MENU_ACTIONS {
        assert!(
            source.contains(&format!("\"{action}\"")),
            "commands.ts is missing menu action {action}"
        );
    }
}

#[test]
fn capabilities_cover_exactly_the_application_commands() {
    let mut app_permissions = Vec::new();
    for capability in ["capabilities/default.json", "capabilities/about.json"] {
        app_permissions.extend(
            capability_permissions(capability)
                .into_iter()
                .filter(|permission| permission.starts_with("allow-")),
        );
    }
    app_permissions.sort();
    app_permissions.dedup();

    let mut expected = command_permissions();
    expected.sort();
    assert_eq!(app_permissions, expected);

    let about_permissions = capability_permissions("capabilities/about.json");
    for permission in &about_permissions {
        assert!(
            !permission.starts_with("updater:"),
            "updater:* must never be granted to the webview: {permission}"
        );
    }

    assert_eq!(
        read_json("capabilities/default.json")["windows"],
        json!(["main", "doc-*"])
    );
    assert_eq!(
        read_json("capabilities/about.json")["windows"],
        json!(["about"])
    );
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

    let snapshot = UpdateSnapshot {
        phase: UpdatePhase::Available,
        generation: 2,
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        update: Some(UpdateInfo {
            version: "0.2.0".to_string(),
            date: Some("2026-10-27T12:00:00Z".to_string()),
            body: Some("Notes".to_string()),
            notes_by_locale: None,
        }),
        progress: None,
    };
    let value = serde_json::to_value(&snapshot).expect("UpdateSnapshot must serialize");
    assert_eq!(
        value,
        json!({
            "phase": "available",
            "generation": 2,
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "update": {
                "version": "0.2.0",
                "date": "2026-10-27T12:00:00Z",
                "body": "Notes",
                "notesByLocale": null
            },
            "progress": null
        })
    );

    let about = qingmo_lib::ipc::dto::AboutInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build: format!("{} · arm64", env!("CARGO_PKG_VERSION")),
        platform: "macOS".to_string(),
        license: "Apache-2.0".to_string(),
        copyright: "© 2026 Qingmo Contributors".to_string(),
    };
    let value = serde_json::to_value(&about).expect("AboutInfo must serialize");
    assert_eq!(
        value["build"],
        format!("{} · arm64", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(value["copyright"], "© 2026 Qingmo Contributors");
    assert_eq!(serde_json::to_value(AboutLink::Github).unwrap(), "github");
}

#[test]
fn error_wire_shape_is_stable() {
    let error = AppError::new(AppErrorCode::Conflict, "file changed")
        .with_details(json!({"currentHash": "abc"}));
    let value = serde_json::to_value(&error).expect("AppError must serialize");
    assert_eq!(value["code"], "CONFLICT");
    assert_eq!(value["message"], "file changed");
    assert_eq!(value["details"]["currentHash"], "abc");

    for (code, wire) in [
        (AppErrorCode::UpdateCheckFailed, "UPDATE_CHECK_FAILED"),
        (AppErrorCode::UpdateDownloadFailed, "UPDATE_DOWNLOAD_FAILED"),
        (
            AppErrorCode::UpdateSignatureInvalid,
            "UPDATE_SIGNATURE_INVALID",
        ),
        (AppErrorCode::UpdateInstallFailed, "UPDATE_INSTALL_FAILED"),
        (AppErrorCode::UpdateUnsupported, "UPDATE_UNSUPPORTED"),
        (AppErrorCode::UpdateNotReady, "UPDATE_NOT_READY"),
    ] {
        let value = serde_json::to_value(AppError::new(code, "update error"))
            .expect("AppError must serialize");
        assert_eq!(value["code"], wire);
    }
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
        .manage(qingmo_lib::state::WindowSessions::new())
        .manage(CloseGuard::new())
        .manage(qingmo_lib::state::UpdateManager::new(env!(
            "CARGO_PKG_VERSION"
        )))
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
    assert!(handler_source.contains("document::document_take_pending"));
    assert!(handler_source.contains("document::document_reload"));
    assert!(handler_source.contains("document::document_save_as"));
    assert!(handler_source.contains("document::document_write_atomic"));
    assert!(handler_source.contains("close::app_close_confirm"));
    assert!(handler_source.contains("about::app_about_info"));
    assert!(handler_source.contains("about::app_about_close"));
    assert!(handler_source.contains("about::app_about_open_link"));
    assert!(handler_source.contains("update::app_update_status"));
    assert!(handler_source.contains("update::app_update_check"));
    assert!(handler_source.contains("update::app_update_download"));
    assert!(handler_source.contains("update::app_update_install"));
    assert!(handler_source.contains("logs::app_logs_list"));
    assert!(handler_source.contains("logs::app_logs_stats"));
    assert!(handler_source.contains("logs::app_logs_export"));
    assert!(handler_source.contains("logs::app_logs_open_dir"));
    assert!(handler_source.contains("logs::app_logs_clear"));

    let error = invoke(&webview, "document_reload", json!({"docToken": "fake"}))
        .expect_err("reload with a fake token must fail");
    assert_eq!(error["code"], "INVALID_PATH", "unexpected error: {error}");

    let error = invoke(
        &webview,
        "document_write_atomic",
        json!({"docToken": "fake", "text": "", "expectedCurrentHash": null}),
    )
    .expect_err("write with a fake token must fail");
    assert_eq!(error["code"], "INVALID_PATH", "unexpected error: {error}");

    for command in ["app_about_info", "app_about_close"] {
        let error = invoke(&webview, command, json!({}))
            .expect_err("About commands must reject other windows");
        let denied = error.get("code").and_then(Value::as_str) == Some("PERMISSION_DENIED")
            || error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"));
        assert!(
            denied,
            "{command} must be scoped to the About window: {error}"
        );
    }
    let error = invoke(&webview, "app_about_open_link", json!({"link": "github"}))
        .expect_err("About link opening must be scoped to the About window");
    let denied = error.get("code").and_then(Value::as_str) == Some("PERMISSION_DENIED")
        || error
            .as_str()
            .is_some_and(|message| message.contains("not allowed"));
    assert!(
        denied,
        "app_about_open_link must be scoped to the About window: {error}"
    );

    let about = tauri::WebviewWindowBuilder::new(&app, "about", Default::default())
        .build()
        .expect("mock About webview must build");
    let info = invoke(&about, "app_about_info", json!({}))
        .expect("the About window must read build metadata");
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["license"], "Apache-2.0");
    assert!(
        info["build"]
            .as_str()
            .expect("build must be a string")
            .starts_with(&format!("{} · ", env!("CARGO_PKG_VERSION"))),
        "unexpected build metadata: {info}"
    );

    let stats = invoke(&webview, "app_logs_stats", json!({}))
        .expect("log stats must work without the plugin");
    assert!(stats["totalEntries"].is_number());
    assert!(stats["fileCount"].is_number());
    let entries = invoke(
        &webview,
        "app_logs_list",
        json!({"level": null, "limit": 10}),
    )
    .expect("log listing must work without the plugin");
    assert!(entries.is_array());

    let error = invoke(&webview, "app_close_confirm", json!({"allow": false}))
        .expect_err("a confirmation without a pending close request must fail");
    assert_eq!(
        error["code"], "BUSY",
        "app_close_confirm must reject an unarmed guard: {error}"
    );

    let guard = app.state::<CloseGuard>();
    assert!(guard.begin(CloseReason::Window, ["main".to_string()]));
    let response = invoke(&webview, "app_close_confirm", json!({"allow": false}))
        .expect("cancelling a pending close request must succeed");
    assert_eq!(response, Value::Null);
    assert_eq!(guard.pending(), None);
    assert!(guard.begin(CloseReason::Exit, ["main".to_string()]));
    guard.cancel();

    let status = invoke(&webview, "app_update_status", json!({}))
        .expect("status must be available without the plugin");
    assert_eq!(status["phase"], "idle");
    assert_eq!(status["currentVersion"], env!("CARGO_PKG_VERSION"));

    for command in ["app_update_download", "app_update_install"] {
        let error = invoke(&webview, command, json!({}))
            .expect_err("commands outside their phase must fail closed");
        assert_eq!(
            error["code"], "UPDATE_NOT_READY",
            "{command} must return UPDATE_NOT_READY: {error}"
        );
    }
}
