use qingmo_lib::ipc::dto::UpdatePhase;
use qingmo_lib::state::UpdateManager;
use serde_json::json;
use tauri_plugin_updater::UpdaterExt;

#[test]
fn finish_check_some_builds_available_snapshot() {
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("mock app with updater plugin must build");
    let updater = app
        .updater_builder()
        .target("test-target")
        .build()
        .expect("offline updater must build");
    let update = updater
        .restore_update(json!({
            "version": "1.0.0",
            "pub_date": "2026-10-27T12:00:00Z",
            "notes": "Notes",
            "platforms": {
                "test-target": {
                    "signature": "test-signature",
                    "url": "https://example.invalid/qingmo.app.tar.gz"
                }
            }
        }))
        .expect("offline metadata must parse")
        .expect("newer version must be an update");

    let manager = UpdateManager::new("0.1.0");
    let generation = manager.begin_check().expect("check must start");
    let snapshot = manager
        .finish_check_some(generation, update)
        .expect("available transition must succeed");
    assert_eq!(snapshot.phase, UpdatePhase::Available);
    assert_eq!(snapshot.generation, 2);
    assert_eq!(snapshot.update.as_ref().unwrap().version, "1.0.0");
    assert_eq!(
        snapshot.update.as_ref().unwrap().date.as_deref(),
        Some("2026-10-27T12:00:00Z")
    );
    assert_eq!(
        snapshot.update.as_ref().unwrap().body.as_deref(),
        Some("Notes")
    );
    assert!(manager.current_update().is_some());
}
