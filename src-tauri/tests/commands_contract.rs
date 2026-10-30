use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::ipc::dto::{
    AboutLink, AppLanguage, ApplyLocaleRequest, CloseReason, DocumentChangeKind,
    DocumentChangedPayload, FilePayload, NativeShellLabels, SaveRequest, TextEncoding, TextFormat,
    UpdateInfo, UpdatePhase, UpdateSnapshot,
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

    assert_eq!(COMMANDS.len(), 29);
    assert_eq!(
        EVENTS,
        &[
            "app://close-requested",
            "app://update-state",
            "app://update-progress",
            "app://menu-action",
            "app://document-changed"
        ]
    );

    for action in qingmo_lib::ipc::contract::MENU_ACTIONS {
        assert!(
            source.contains(&format!("\"{action}\"")),
            "commands.ts is missing menu action {action}"
        );
    }

    assert_eq!(qingmo_lib::ipc::contract::MENU_ACTIONS.len(), 12);
    assert!(qingmo_lib::ipc::contract::MENU_ACTIONS.contains(&"language.zh-CN"));
    assert!(qingmo_lib::ipc::contract::MENU_ACTIONS.contains(&"language.en"));
}

#[test]
fn capabilities_cover_exactly_the_application_commands() {
    let mut app_permissions = Vec::new();
    for capability in [
        "capabilities/default.json",
        "capabilities/about.json",
        "capabilities/settings.json",
        "capabilities/recovery.json",
    ] {
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

    for auxiliary in ["capabilities/about.json", "capabilities/settings.json"] {
        let permissions = capability_permissions(auxiliary);
        for permission in &permissions {
            assert!(
                !permission.starts_with("updater:"),
                "updater:* must never be granted to the webview: {permission}"
            );
        }
    }

    assert_eq!(
        read_json("capabilities/default.json")["windows"],
        json!(["main", "doc-*"])
    );
    assert_eq!(
        read_json("capabilities/about.json")["windows"],
        json!(["about"])
    );
    assert_eq!(
        read_json("capabilities/settings.json")["windows"],
        json!(["settings"])
    );
    assert_eq!(
        read_json("capabilities/recovery.json")["windows"],
        json!(["main"])
    );
    assert_eq!(
        capability_permissions("capabilities/recovery.json"),
        vec![
            "allow-session-draft-list".to_string(),
            "allow-session-draft-read".to_string(),
        ]
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

    let change = DocumentChangedPayload {
        doc_token: "token".to_string(),
        kind: DocumentChangeKind::Modified,
        current_hash: Some("abc".to_string()),
        current_size: Some(6),
        current_mtime_ms: Some(1_700_000_000_000),
    };
    let value = serde_json::to_value(&change).expect("DocumentChangedPayload must serialize");
    assert_eq!(
        value,
        json!({
            "docToken": "token",
            "kind": "modified",
            "currentHash": "abc",
            "currentSize": 6,
            "currentMtimeMs": 1_700_000_000_000i64
        })
    );

    let deleted = DocumentChangedPayload {
        doc_token: "token".to_string(),
        kind: DocumentChangeKind::Deleted,
        current_hash: None,
        current_size: None,
        current_mtime_ms: None,
    };
    let value = serde_json::to_value(&deleted).expect("deleted payload must serialize");
    assert_eq!(value, json!({"docToken": "token", "kind": "deleted"}));

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
        (AppErrorCode::InvalidLocale, "INVALID_LOCALE"),
    ] {
        let value = serde_json::to_value(AppError::new(code, "update error"))
            .expect("AppError must serialize");
        assert_eq!(value["code"], wire);
    }
}

/// The ACL treats the platform's real frontend origin as `local`; the mock
/// runtime defaults to the macOS/Linux scheme on every platform.
fn local_invoke_url() -> tauri::Url {
    #[cfg(windows)]
    let url = "http://tauri.localhost";
    #[cfg(not(windows))]
    let url = "tauri://localhost";
    url.parse().expect("valid URL")
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
            url: local_invoke_url(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<Value>().expect("valid JSON"))
}

#[test]
fn invoke_handler_registers_every_contract_command() {
    let session_dir = tempfile::tempdir().expect("session temp dir must be creatable");
    let store = qingmo_lib::services::SessionStore::open(session_dir.path().join("session"))
        .expect("session store must open");
    let app = tauri::test::mock_builder()
        .manage(store)
        .manage(qingmo_lib::state::DocumentRegistry::new())
        .manage(qingmo_lib::state::WindowSessions::new())
        .manage(CloseGuard::new())
        .manage(qingmo_lib::state::FocusTracker::new())
        .manage(qingmo_lib::state::PreviewModes::new())
        .manage(qingmo_lib::state::ShellLocale::default())
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
    for command in COMMANDS {
        assert!(
            handler_source.contains(&format!("::{command}")),
            "commands/mod.rs is missing a handler for {command}"
        );
    }

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

    // External link opening validates the href before it ever reaches the OS
    // opener, so unsafe schemes fail in the mock runtime as they would in the
    // app. A successful open is covered by the validator unit tests.
    for href in [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "./OTHER.md",
        "",
    ] {
        let error = invoke(&webview, "app_open_external", json!({ "href": href }))
            .expect_err("unsafe links must be rejected");
        assert_eq!(
            error["code"], "INVALID_PATH",
            "app_open_external must reject {href:?}: {error}"
        );
    }

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

    for command in ["app_settings_info", "app_settings_close"] {
        let error = invoke(&webview, command, json!({}))
            .expect_err("settings commands must reject other windows");
        let denied = error.get("code").and_then(Value::as_str) == Some("PERMISSION_DENIED")
            || error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"));
        assert!(
            denied,
            "{command} must be scoped to the settings window: {error}"
        );
    }

    let settings = tauri::WebviewWindowBuilder::new(&app, "settings", Default::default())
        .build()
        .expect("mock settings webview must build");
    let version = invoke(&settings, "app_settings_info", json!({}))
        .expect("the settings window must read the app version");
    assert_eq!(version, env!("CARGO_PKG_VERSION"));

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

    let mut invalid_labels = valid_labels();
    invalid_labels.open = "  ".to_string();
    let error = invoke(
        &webview,
        "app_apply_locale",
        json!({
            "request": {
                "language": "zh-CN",
                "labels": invalid_labels,
            }
        }),
    )
    .expect_err("invalid labels must be rejected");
    assert_eq!(error["code"], "INVALID_LOCALE", "unexpected error: {error}");
    assert_eq!(error["details"]["field"], "open");

    let absent = invoke(
        &webview,
        "session_view_state_get",
        json!({"path": "/docs/absent.md"}),
    )
    .expect("an unknown view key must resolve to null");
    assert_eq!(absent, Value::Null);

    invoke(
        &webview,
        "session_view_state_set",
        json!({
            "path": "/docs/note.md",
            "state": {
                "anchor": -4,
                "head": 12,
                "topPos": 8,
                "topOffset": 12.5,
                "scrollLeft": 0,
                "livePreviewPreferred": false
            }
        }),
    )
    .expect("view state writes must succeed with a writable store");
    let restored = invoke(
        &webview,
        "session_view_state_get",
        json!({"path": "/docs/note.md"}),
    )
    .expect("view state reads must succeed");
    assert_eq!(
        restored["anchor"], 0,
        "negative anchors must clamp: {restored}"
    );
    assert_eq!(restored["head"], 12);
    assert_eq!(restored["livePreviewPreferred"], false);
    assert!(restored["updatedAtMs"].as_i64().unwrap_or_default() > 0);

    let draft = invoke(
        &webview,
        "session_draft_write",
        json!({
            "request": {
                "kind": "untitled",
                "path": null,
                "title": "Untitled",
                "text": "draft body",
                "anchor": 0,
                "head": 10
            }
        }),
    )
    .expect("draft writes must succeed with a writable store");
    let draft_id = draft["id"].as_str().expect("draft id must be a string");
    assert_eq!(draft["textUnits"], 10);
    assert_eq!(draft["sizeBytes"], 10);

    let listed =
        invoke(&webview, "session_draft_list", json!({})).expect("draft listing must succeed");
    assert_eq!(listed.as_array().map(Vec::len), Some(1));

    let record = invoke(&webview, "session_draft_read", json!({"id": draft_id}))
        .expect("draft reads must succeed");
    assert_eq!(record["text"], "draft body");
    assert_eq!(record["kind"], "untitled");

    let discarded = invoke(&webview, "session_draft_discard", json!({"id": draft_id}))
        .expect("draft discard must succeed");
    assert_eq!(discarded, json!(true));
    let error = invoke(&webview, "session_draft_read", json!({"id": draft_id}))
        .expect_err("a discarded draft must be gone");
    assert_eq!(error["code"], "NOT_FOUND");

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

fn valid_labels() -> NativeShellLabels {
    NativeShellLabels {
        app_name: "Qingmo".to_string(),
        about: "About Qingmo".to_string(),
        settings: "Settings…".to_string(),
        services: "Services".to_string(),
        hide_app: "Hide Qingmo".to_string(),
        hide_others: "Hide Others".to_string(),
        show_all: "Show All".to_string(),
        quit_app: "Quit Qingmo".to_string(),
        file: "File".to_string(),
        open: "Open…".to_string(),
        save: "Save".to_string(),
        close_window: "Close Window".to_string(),
        edit: "Edit".to_string(),
        undo: "Undo".to_string(),
        redo: "Redo".to_string(),
        cut: "Cut".to_string(),
        copy: "Copy".to_string(),
        paste: "Paste".to_string(),
        select_all: "Select All".to_string(),
        view: "View".to_string(),
        live_preview: "Live Preview".to_string(),
        outline: "Outline".to_string(),
        command_palette: "Command Palette".to_string(),
        toggle_theme: "Toggle Theme".to_string(),
        logs: "Logs…".to_string(),
        fullscreen: "Full Screen".to_string(),
        theme: "Theme".to_string(),
        theme_light: "Light".to_string(),
        theme_dark: "Dark".to_string(),
        theme_system: "System".to_string(),
        language: "Language".to_string(),
        language_zh_cn: "简体中文".to_string(),
        language_en: "English".to_string(),
        window: "Window".to_string(),
        minimize: "Minimize".to_string(),
        zoom: "Zoom".to_string(),
        maximize: "Maximize".to_string(),
        bring_all_to_front: "Bring All to Front".to_string(),
        help: "Help".to_string(),
        untitled_file_name: "Untitled.md".to_string(),
    }
}

#[test]
fn native_shell_labels_wire_shape_and_validation() {
    let labels = valid_labels();
    labels.validate().expect("default labels must be valid");

    let request = ApplyLocaleRequest {
        language: AppLanguage::ZhCn,
        labels: labels.clone(),
    };
    let value = serde_json::to_value(&request).expect("ApplyLocaleRequest must serialize");
    assert_eq!(value["language"], "zh-CN");
    assert_eq!(value["labels"]["appName"], "Qingmo");
    assert_eq!(value["labels"]["languageZhCN"], "简体中文");
    assert_eq!(serde_json::to_value(AppLanguage::En).unwrap(), "en");

    let mut empty = labels.clone();
    empty.open = "  ".to_string();
    let error = empty.validate().expect_err("empty labels must fail");
    assert_eq!(error.code, AppErrorCode::InvalidLocale);
    assert_eq!(error.details.as_ref().unwrap()["field"], "open");
    assert_eq!(error.details.as_ref().unwrap()["reason"], "empty");

    let mut too_long = labels.clone();
    too_long.file = "x".repeat(81);
    assert_eq!(
        too_long
            .validate()
            .expect_err("oversized labels must fail")
            .code,
        AppErrorCode::InvalidLocale
    );

    let mut control = labels.clone();
    control.help = "a\nb".to_string();
    assert_eq!(
        control
            .validate()
            .expect_err("control characters must fail")
            .code,
        AppErrorCode::InvalidLocale
    );

    let mut bidi = labels.clone();
    bidi.save = "a\u{202E}b".to_string();
    assert_eq!(
        bidi.validate().expect_err("bidi overrides must fail").code,
        AppErrorCode::InvalidLocale
    );

    let too_long_name = format!("{}.md", "x".repeat(118));
    for invalid_name in [
        "",
        "Untitled",
        "../escape.md",
        ".hidden.md",
        "dir/name.md",
        "dir\\name.md",
        "C:name.md",
        too_long_name.as_str(),
    ] {
        let mut invalid = labels.clone();
        invalid.untitled_file_name = invalid_name.to_string();
        assert_eq!(
            invalid
                .validate()
                .expect_err("invalid untitled file names must fail")
                .code,
            AppErrorCode::InvalidLocale,
            "file name {invalid_name:?}"
        );
    }
}
