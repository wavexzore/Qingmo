use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(relative: &str) -> Value {
    let path = manifest_dir().join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

#[test]
fn capability_contains_only_expected_permissions() {
    let capability = read_json("capabilities/default.json");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be an array")
        .iter()
        .map(|value| value.as_str().expect("permission must be a string"))
        .collect::<Vec<_>>();

    let core_permissions = permissions
        .iter()
        .copied()
        .filter(|permission| permission.starts_with("core:"))
        .collect::<Vec<_>>();
    assert_eq!(
        core_permissions,
        vec!["core:event:allow-listen", "core:event:allow-unlisten"]
    );

    let app_permissions = permissions
        .iter()
        .copied()
        .filter(|permission| !permission.starts_with("core:"))
        .collect::<Vec<_>>();
    assert_eq!(
        app_permissions,
        vec![
            "allow-document-open",
            "allow-document-reload",
            "allow-document-write-atomic",
            "allow-app-close-confirm",
        ]
    );

    let forbidden_prefixes = [
        "fs:", "shell:", "http:", "store:", "sql:", "dialog:", "path:", "menu:", "tray:", "image:",
        "webview:", "window:",
    ];
    for permission in &permissions {
        assert!(
            !permission.starts_with("core:default"),
            "core:default is too broad: {permission}"
        );
        for prefix in forbidden_prefixes {
            assert!(
                !permission.starts_with(prefix),
                "forbidden permission {permission}"
            );
        }
    }

    assert_eq!(capability["windows"], serde_json::json!(["main"]));
}

#[test]
fn production_csp_is_strict_and_has_no_wildcards() {
    let config = read_json("tauri.conf.json");
    let security = &config["app"]["security"];
    let csp = security["csp"]
        .as_str()
        .expect("production CSP must be a string");

    assert!(!csp.contains('*'), "CSP must not contain wildcards: {csp}");
    for directive in [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' ipc: http://ipc.localhost",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ] {
        assert!(
            csp.contains(directive),
            "CSP missing directive: {directive}\nactual: {csp}"
        );
    }

    let dev_csp = security["devCsp"]
        .as_str()
        .expect("dev CSP must be a string");
    assert!(!dev_csp.contains('*'), "dev CSP must not contain wildcards");
    assert!(dev_csp.contains("ws://localhost:1420"));
    assert!(dev_csp.contains("http://localhost:1420"));
}

#[test]
fn window_and_asset_protocol_are_locked_down() {
    let config = read_json("tauri.conf.json");
    let app = &config["app"];

    assert_eq!(app["withGlobalTauri"], Value::Bool(false));
    assert_eq!(
        app["security"]["assetProtocol"]["enable"],
        Value::Bool(false)
    );
    assert_eq!(
        app["security"]["capabilities"],
        serde_json::json!(["default"])
    );

    let windows = app["windows"].as_array().expect("windows must be an array");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], "main");
}
