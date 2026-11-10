use qingmo_lib::error::AppError;
use qingmo_lib::ipc::dto::{
    AboutInfo, AboutLink, Accel, AppLanguage, AppSettingsOpenRequest, ApplyLocaleRequest,
    AsrBackend, AsrConfigView, AsrFamily, AsrMode, CloseCancelledPayload, CloseRequestedPayload,
    ConflictDetails, Degraded, DocumentChangeKind, DocumentChangedPayload,
    DocumentRelocatedPayload, DownloadState, DraftKind, DraftMeta, DraftRecord, DraftWriteRequest,
    EditorViewState, EditorViewStateInput, FilePayload, HistoryEntry, HistoryRecord,
    ImageSaveResult, KeyStatus, LlmConfigView, LlmMode, LogEntry, LogLevel, LogStats,
    MeetingConfigGetResponse, MeetingConfigPatch, MeetingConfigSetRequest,
    MeetingConfigSetResponse, MeetingConfigView, MeetingKeyClearRequest, MeetingKeySetRequest,
    MeetingOutcome, MeetingProgress, MeetingResult, MeetingRetryResponse, MeetingStage,
    MeetingStartResponse, MeetingStats, MenuActionPayload, ModelDownloadCancelRequest,
    ModelDownloadRequest, ModelDownloadResponse, ModelKind, ModelOrigin, ModelProgress, ModelState,
    ModelView, NativeShellLabels, PeakBasis, ReasonCode, RemoteProvider, ResolvedModelsView,
    RuntimeMode, RuntimeNote, RuntimePreview, RuntimeView, SaveRequest, SaveResult, SearchHit,
    SearchIndexState, SearchMode, SearchResponse, SearchStatus, TierDefaultsView, TrashEntry,
    TrashEntryState, TrashRestoreMode, TrashRestoreResult, UpdateFlushRequest, UpdateInfo,
    UpdatePhase, UpdateProgress, UpdateProgressPayload, UpdateSnapshot, WindowBounds, WindowIntent,
    WindowPhase, WindowProgress, WorkspaceEntry, WorkspaceEntryKind, WorkspaceIndexStatusPayload,
    WorkspaceInfo, WorkspaceListing, WorkspaceTruncationReason,
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
    DocumentRelocatedPayload::export_all(&config)
        .expect("DocumentRelocatedPayload bindings must export");
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

    RuntimeMode::export_all(&config).expect("RuntimeMode bindings must export");
    AsrMode::export_all(&config).expect("AsrMode bindings must export");
    LlmMode::export_all(&config).expect("LlmMode bindings must export");
    RemoteProvider::export_all(&config).expect("RemoteProvider bindings must export");
    Accel::export_all(&config).expect("Accel bindings must export");
    ModelKind::export_all(&config).expect("ModelKind bindings must export");
    AsrFamily::export_all(&config).expect("AsrFamily bindings must export");
    PeakBasis::export_all(&config).expect("PeakBasis bindings must export");
    ModelState::export_all(&config).expect("ModelState bindings must export");
    KeyStatus::export_all(&config).expect("KeyStatus bindings must export");
    MeetingStage::export_all(&config).expect("MeetingStage bindings must export");
    WindowPhase::export_all(&config).expect("WindowPhase bindings must export");
    AsrBackend::export_all(&config).expect("AsrBackend bindings must export");
    RuntimeNote::export_all(&config).expect("RuntimeNote bindings must export");
    ModelOrigin::export_all(&config).expect("ModelOrigin bindings must export");
    ReasonCode::export_all(&config).expect("ReasonCode bindings must export");
    WindowProgress::export_all(&config).expect("WindowProgress bindings must export");
    Degraded::export_all(&config).expect("Degraded bindings must export");
    MeetingStats::export_all(&config).expect("MeetingStats bindings must export");
    MeetingProgress::export_all(&config).expect("MeetingProgress bindings must export");
    MeetingResult::export_all(&config).expect("MeetingResult bindings must export");
    MeetingOutcome::export_all(&config).expect("MeetingOutcome bindings must export");
    MeetingStartResponse::export_all(&config).expect("MeetingStartResponse bindings must export");
    MeetingRetryResponse::export_all(&config).expect("MeetingRetryResponse bindings must export");
    RuntimeView::export_all(&config).expect("RuntimeView bindings must export");
    AsrConfigView::export_all(&config).expect("AsrConfigView bindings must export");
    LlmConfigView::export_all(&config).expect("LlmConfigView bindings must export");
    MeetingConfigView::export_all(&config).expect("MeetingConfigView bindings must export");
    MeetingConfigPatch::export_all(&config).expect("MeetingConfigPatch bindings must export");
    TierDefaultsView::export_all(&config).expect("TierDefaultsView bindings must export");
    ResolvedModelsView::export_all(&config).expect("ResolvedModelsView bindings must export");
    RuntimePreview::export_all(&config).expect("RuntimePreview bindings must export");
    MeetingConfigGetResponse::export_all(&config)
        .expect("MeetingConfigGetResponse bindings must export");
    MeetingConfigSetRequest::export_all(&config)
        .expect("MeetingConfigSetRequest bindings must export");
    MeetingConfigSetResponse::export_all(&config)
        .expect("MeetingConfigSetResponse bindings must export");
    MeetingKeySetRequest::export_all(&config).expect("MeetingKeySetRequest bindings must export");
    MeetingKeyClearRequest::export_all(&config)
        .expect("MeetingKeyClearRequest bindings must export");
    ModelView::export_all(&config).expect("ModelView bindings must export");
    ModelDownloadRequest::export_all(&config).expect("ModelDownloadRequest bindings must export");
    ModelDownloadResponse::export_all(&config).expect("ModelDownloadResponse bindings must export");
    ModelDownloadCancelRequest::export_all(&config)
        .expect("ModelDownloadCancelRequest bindings must export");
    DownloadState::export_all(&config).expect("DownloadState bindings must export");
    ModelProgress::export_all(&config).expect("ModelProgress bindings must export");
    AppSettingsOpenRequest::export_all(&config)
        .expect("AppSettingsOpenRequest bindings must export");
}
