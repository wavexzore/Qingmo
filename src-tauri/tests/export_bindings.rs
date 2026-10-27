use qingmo_lib::error::AppError;
use qingmo_lib::ipc::dto::{
    CloseRequestedPayload, ConflictDetails, FilePayload, SaveRequest, SaveResult, UpdateInfo,
    UpdatePhase, UpdateProgress, UpdateProgressPayload, UpdateSnapshot,
};
use std::path::PathBuf;
use ts_rs::{Config, TS};

fn export_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/shared/src/generated")
}

#[test]
fn export_bindings() {
    let dir = export_dir();
    std::fs::create_dir_all(&dir).expect("generated directory must be creatable");
    let config = Config::new().with_out_dir(dir).with_large_int("number");

    FilePayload::export_all(&config).expect("FilePayload bindings must export");
    SaveRequest::export_all(&config).expect("SaveRequest bindings must export");
    SaveResult::export_all(&config).expect("SaveResult bindings must export");
    ConflictDetails::export_all(&config).expect("ConflictDetails bindings must export");
    AppError::export_all(&config).expect("AppError bindings must export");
    CloseRequestedPayload::export_all(&config).expect("CloseRequestedPayload bindings must export");
    UpdatePhase::export_all(&config).expect("UpdatePhase bindings must export");
    UpdateInfo::export_all(&config).expect("UpdateInfo bindings must export");
    UpdateProgress::export_all(&config).expect("UpdateProgress bindings must export");
    UpdateSnapshot::export_all(&config).expect("UpdateSnapshot bindings must export");
    UpdateProgressPayload::export_all(&config).expect("UpdateProgressPayload bindings must export");
}
