use qingmo_lib::error::AppError;
use qingmo_lib::ipc::dto::{
    AboutInfo, AboutLink, AppLanguage, ApplyLocaleRequest, CloseCancelledPayload,
    CloseRequestedPayload, ConflictDetails, DocumentChangeKind, DocumentChangedPayload, DraftKind,
    DraftMeta, DraftRecord, DraftWriteRequest, EditorViewState, EditorViewStateInput, FilePayload,
    HistoryEntry, HistoryRecord, ImageSaveResult, LogEntry, LogLevel, LogStats, MenuActionPayload,
    NativeShellLabels, SaveRequest, SaveResult, SearchHit, SearchIndexState, SearchMode,
    SearchResponse, SearchStatus, TrashEntry, TrashEntryState, TrashRestoreMode,
    TrashRestoreResult, UpdateFlushRequest, UpdateInfo, UpdatePhase, UpdateProgress,
    UpdateProgressPayload, UpdateSnapshot, WindowBounds, WindowIntent, WorkspaceEntry,
    WorkspaceEntryKind, WorkspaceIndexStatusPayload, WorkspaceInfo, WorkspaceListing,
    WorkspaceTruncationReason,
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
    UpdateFlushRequest::export_all(&config).expect("UpdateFlushRequest bindings must export");
    LogLevel::export_all(&config).expect("LogLevel bindings must export");
    LogEntry::export_all(&config).expect("LogEntry bindings must export");
    LogStats::export_all(&config).expect("LogStats bindings must export");
    AppLanguage::export_all(&config).expect("AppLanguage bindings must export");
    NativeShellLabels::export_all(&config).expect("NativeShellLabels bindings must export");
    ApplyLocaleRequest::export_all(&config).expect("ApplyLocaleRequest bindings must export");
    DocumentChangeKind::export_all(&config).expect("DocumentChangeKind bindings must export");
    DocumentChangedPayload::export_all(&config)
        .expect("DocumentChangedPayload bindings must export");
    EditorViewState::export_all(&config).expect("EditorViewState bindings must export");
    EditorViewStateInput::export_all(&config).expect("EditorViewStateInput bindings must export");
    DraftKind::export_all(&config).expect("DraftKind bindings must export");
    DraftMeta::export_all(&config).expect("DraftMeta bindings must export");
    DraftRecord::export_all(&config).expect("DraftRecord bindings must export");
    DraftWriteRequest::export_all(&config).expect("DraftWriteRequest bindings must export");
    WorkspaceInfo::export_all(&config).expect("WorkspaceInfo bindings must export");
    WorkspaceEntryKind::export_all(&config).expect("WorkspaceEntryKind bindings must export");
    WorkspaceEntry::export_all(&config).expect("WorkspaceEntry bindings must export");
    WorkspaceTruncationReason::export_all(&config)
        .expect("WorkspaceTruncationReason bindings must export");
    WorkspaceListing::export_all(&config).expect("WorkspaceListing bindings must export");
    ImageSaveResult::export_all(&config).expect("ImageSaveResult bindings must export");
    HistoryEntry::export_all(&config).expect("HistoryEntry bindings must export");
    HistoryRecord::export_all(&config).expect("HistoryRecord bindings must export");
    TrashEntryState::export_all(&config).expect("TrashEntryState bindings must export");
    TrashEntry::export_all(&config).expect("TrashEntry bindings must export");
    TrashRestoreMode::export_all(&config).expect("TrashRestoreMode bindings must export");
    TrashRestoreResult::export_all(&config).expect("TrashRestoreResult bindings must export");
    SearchMode::export_all(&config).expect("SearchMode bindings must export");
    SearchHit::export_all(&config).expect("SearchHit bindings must export");
    SearchResponse::export_all(&config).expect("SearchResponse bindings must export");
    SearchIndexState::export_all(&config).expect("SearchIndexState bindings must export");
    SearchStatus::export_all(&config).expect("SearchStatus bindings must export");
    WorkspaceIndexStatusPayload::export_all(&config)
        .expect("WorkspaceIndexStatusPayload bindings must export");
    WindowBounds::export_all(&config).expect("WindowBounds bindings must export");
    WindowIntent::export_all(&config).expect("WindowIntent bindings must export");
    CloseCancelledPayload::export_all(&config).expect("CloseCancelledPayload bindings must export");
}
