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
            "allow-document-take-pending",
            "allow-document-reload",
            "allow-document-save-as",
            "allow-document-write-atomic",
            "allow-app-close-confirm",
            "allow-app-set-live-preview",
            "allow-app-apply-locale",
            "allow-app-open-external",
            "allow-app-update-status",
            "allow-app-update-check",
            "allow-app-update-download",
            "allow-app-update-install",
            "allow-app-logs-list",
            "allow-app-logs-stats",
            "allow-app-logs-export",
            "allow-app-logs-open-dir",
            "allow-app-logs-clear",
            "allow-session-view-state-get",
            "allow-session-view-state-set",
            "allow-session-draft-write",
            "allow-session-draft-discard",
        ]
    );

    let forbidden_prefixes = [
        "fs:", "shell:", "http:", "store:", "sql:", "dialog:", "path:", "menu:", "tray:", "image:",
        "webview:", "window:", "updater:",
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

    assert_eq!(capability["windows"], serde_json::json!(["main", "doc-*"]));
}

#[test]
fn about_capability_is_least_privilege() {
    let capability = read_json("capabilities/about.json");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be an array")
        .iter()
        .map(|value| value.as_str().expect("permission must be a string"))
        .collect::<Vec<_>>();

    assert_eq!(capability["windows"], serde_json::json!(["about"]));
    assert_eq!(
        permissions,
        vec![
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-start-dragging",
            "core:window:allow-internal-toggle-maximize",
            "allow-app-about-info",
            "allow-app-about-close",
            "allow-app-about-open-link",
            "allow-app-update-status",
            "allow-app-update-check",
        ]
    );

    for permission in &permissions {
        assert!(
            !permission.starts_with("updater:"),
            "updater:* must never be granted to the webview: {permission}"
        );
        for prefix in ["fs:", "shell:", "http:", "dialog:", "opener:", "updater:"] {
            assert!(
                !permission.starts_with(prefix),
                "forbidden About permission {permission}"
            );
        }
    }
}

#[test]
fn settings_capability_is_least_privilege() {
    let capability = read_json("capabilities/settings.json");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be an array")
        .iter()
        .map(|value| value.as_str().expect("permission must be a string"))
        .collect::<Vec<_>>();

    assert_eq!(capability["windows"], serde_json::json!(["settings"]));
    assert_eq!(
        permissions,
        vec![
            "core:window:allow-start-dragging",
            "allow-app-settings-info",
            "allow-app-settings-close",
        ]
    );

    for permission in &permissions {
        assert!(
            !permission.starts_with("updater:"),
            "updater:* must never be granted to the webview: {permission}"
        );
        for prefix in ["fs:", "shell:", "http:", "dialog:", "opener:", "updater:"] {
            assert!(
                !permission.starts_with(prefix),
                "forbidden settings permission {permission}"
            );
        }
    }
}

#[test]
fn recovery_capability_is_least_privilege() {
    let capability = read_json("capabilities/recovery.json");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be an array")
        .iter()
        .map(|value| value.as_str().expect("permission must be a string"))
        .collect::<Vec<_>>();

    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(
        permissions,
        vec!["allow-session-draft-list", "allow-session-draft-read"]
    );

    for permission in &permissions {
        for prefix in ["fs:", "shell:", "http:", "dialog:", "opener:", "updater:"] {
            assert!(
                !permission.starts_with(prefix),
                "forbidden recovery permission {permission}"
            );
        }
    }
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
        "img-src 'self' data: https:",
        "connect-src 'self' ipc: http://ipc.localhost",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
    ] {
        assert!(
            csp.contains(directive),
            "CSP missing directive: {directive}\nactual: {csp}"
        );
    }

    let img_src = csp
        .split(';')
        .map(str::trim)
        .find(|directive| directive.starts_with("img-src "))
        .expect("CSP must contain an img-src directive");
    assert_eq!(img_src, "img-src 'self' data: https:");
    assert!(
        !img_src.contains("http:"),
        "plain HTTP images must stay blocked: {img_src}"
    );

    let dev_csp = security["devCsp"]
        .as_str()
        .expect("dev CSP must be a string");
    assert!(!dev_csp.contains('*'), "dev CSP must not contain wildcards");
    assert!(dev_csp.contains("ws://localhost:1420"));
    assert!(dev_csp.contains("http://localhost:1420"));
}

#[test]
fn updater_config_is_signed_https_and_non_downgrading() {
    let config = read_json("tauri.conf.json");
    assert_eq!(
        config["bundle"]["createUpdaterArtifacts"],
        Value::Bool(true)
    );

    let updater = &config["plugins"]["updater"];
    let pubkey = updater["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey must be a string");
    assert!(
        !pubkey.trim().is_empty(),
        "updater pubkey must not be empty"
    );
    assert_eq!(updater["requireSignedVersion"], Value::Bool(true));
    assert!(
        updater.get("dangerousInsecureTransportProtocol").is_none(),
        "insecure transport must stay disabled"
    );
    assert!(
        updater.get("allowDowngrades").is_none(),
        "downgrades must stay disabled"
    );
    assert!(
        updater.get("windows").is_none(),
        "Windows install settings are outside the macOS MVP"
    );

    let endpoints = updater["endpoints"]
        .as_array()
        .expect("plugins.updater.endpoints must be an array");
    assert_eq!(endpoints.len(), 1);
    let endpoint = endpoints[0]
        .as_str()
        .expect("updater endpoint must be a string");
    assert!(endpoint.starts_with("https://"), "endpoint must use HTTPS");
    assert_eq!(
        endpoint,
        "https://github.com/wavexzore/Qingmo/releases/latest/download/latest.json"
    );
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
        serde_json::json!(["default", "about", "settings", "recovery"])
    );

    let windows = app["windows"].as_array().expect("windows must be an array");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], "main");
}
