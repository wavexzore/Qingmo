use qingmo_lib::error::AppError;
use qingmo_lib::ipc::dto::{
    AboutInfo, AboutLink, CloseRequestedPayload, ConflictDetails, DocumentChangeKind,
    DocumentChangedPayload, FilePayload, LogEntry, LogLevel, LogStats, MenuActionPayload,
    SaveRequest, SaveResult, UpdateInfo, UpdatePhase, UpdateProgress, UpdateProgressPayload,
    UpdateSnapshot,
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
    AboutInfo::export_all(&config).expect("AboutInfo bindings must export");
    AboutLink::export_all(&config).expect("AboutLink bindings must export");
    CloseRequestedPayload::export_all(&config).expect("CloseRequestedPayload bindings must export");
    MenuActionPayload::export_all(&config).expect("MenuActionPayload bindings must export");
    UpdatePhase::export_all(&config).expect("UpdatePhase bindings must export");
    UpdateInfo::export_all(&config).expect("UpdateInfo bindings must export");
    UpdateProgress::export_all(&config).expect("UpdateProgress bindings must export");
    UpdateSnapshot::export_all(&config).expect("UpdateSnapshot bindings must export");
    UpdateProgressPayload::export_all(&config).expect("UpdateProgressPayload bindings must export");
    LogLevel::export_all(&config).expect("LogLevel bindings must export");
    LogEntry::export_all(&config).expect("LogEntry bindings must export");
    LogStats::export_all(&config).expect("LogStats bindings must export");
    DocumentChangeKind::export_all(&config).expect("DocumentChangeKind bindings must export");
    DocumentChangedPayload::export_all(&config)
        .expect("DocumentChangedPayload bindings must export");
}
