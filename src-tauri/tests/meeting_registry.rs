//! Registry concurrency, cancellation, release, retry and asset scope.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::ipc::dto::{Accel, LlmMode};
use qingmo_lib::services::meeting::pipeline::{StopExit, StopReason};
use qingmo_lib::state::meeting::asset_scope::{AssetAllow, AssetScope};
use qingmo_lib::state::meeting::job::{
    AsrBackend, Degraded, MeetingProgress, MeetingResult, MeetingSource, MeetingStage,
    MeetingStats, WindowPhase, WindowProgress,
};
use qingmo_lib::state::meeting::progress::ProgressEmitter;
use qingmo_lib::state::meeting::registry::MeetingRegistry;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<(String, MeetingProgress)>>,
}

impl ProgressEmitter for Recorder {
    fn emit(&self, window_label: &str, progress: &MeetingProgress) {
        self.events
            .lock()
            .unwrap()
            .push((window_label.to_owned(), progress.clone()));
    }
}

fn registry() -> (MeetingRegistry, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    (MeetingRegistry::with_emitter(recorder.clone()), recorder)
}

fn source(name: &str) -> MeetingSource {
    MeetingSource::new(PathBuf::from("/meetings").join(name), 1024, 90_000)
}

fn begin(
    registry: &MeetingRegistry,
    label: &str,
) -> (uuid::Uuid, tokio_util::sync::CancellationToken) {
    registry.begin(source("voice.m4a"), label).unwrap()
}

fn to_transcribing(registry: &MeetingRegistry, id: uuid::Uuid) {
    assert!(registry.advance(id, MeetingStage::Transcribing));
}

fn to_releasing(registry: &MeetingRegistry, id: uuid::Uuid, exit: StopExit) {
    to_transcribing(registry, id);
    assert!(registry.set_stop_reason(id, StopReason::Completed));
    assert!(registry.set_exit(id, exit));
    assert!(registry.advance(id, MeetingStage::Releasing));
}

fn to_rendering(registry: &MeetingRegistry, id: uuid::Uuid) {
    to_releasing(registry, id, StopExit::Releasing);
    assert!(registry.advance(id, MeetingStage::Summarizing));
    assert!(registry.advance(id, MeetingStage::Rendering));
}

fn result() -> MeetingResult {
    MeetingResult {
        markdown: "# 纪要".into(),
        audio_url: String::new(),
        title: String::new(),
        duration_ms: 90_000,
        stats: MeetingStats::default(),
        partial: false,
    }
}

#[test]
fn second_begin_is_busy_until_the_cancelled_job_stops() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    let error = registry.begin(source("b.m4a"), "doc-b").unwrap_err();
    assert_eq!(error.code, AppErrorCode::MeetingBusy);
    registry.cancel(id).unwrap();
    assert_eq!(
        registry.begin(source("b.m4a"), "doc-b").unwrap_err().code,
        AppErrorCode::MeetingBusy
    );
    assert!(registry
        .fail(id, AppError::new(AppErrorCode::Cancelled, "stop"))
        .is_some());
    registry.begin(source("b.m4a"), "doc-b").unwrap();
}

#[test]
fn cancel_only_sets_the_token_and_fail_writes_the_only_cancelled_snapshot() {
    let (registry, recorder) = registry();
    let (id, token) = begin(&registry, "doc-a");
    to_transcribing(&registry, id);
    registry.cancel(id).unwrap();
    assert!(token.is_cancelled());
    assert!(matches!(
        registry.status(id),
        qingmo_lib::state::meeting::job::MeetingOutcome::Running(_)
    ));

    let snapshot = registry
        .fail(id, AppError::new(AppErrorCode::Cancelled, "stop"))
        .unwrap();
    assert_eq!(snapshot.stage, MeetingStage::Cancelled);
    assert_eq!(
        snapshot.error.as_ref().map(|error| error.code),
        Some(AppErrorCode::Cancelled)
    );
    // The caller emits the returned snapshot; the registry itself stays silent.
    let terminal_events = recorder
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, progress)| progress.stage == MeetingStage::Cancelled)
        .count();
    assert_eq!(terminal_events, 0);
    match registry.status(id) {
        qingmo_lib::state::meeting::job::MeetingOutcome::Failed { error, .. } => {
            assert_eq!(error.code, AppErrorCode::Cancelled)
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    registry.begin(source("b.m4a"), "doc-b").unwrap();
}

#[test]
fn failed_exit_can_only_reach_failed() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_releasing(&registry, id, StopExit::Failed);
    assert_eq!(
        registry
            .advance_checked(id, MeetingStage::Rendering)
            .unwrap_err()
            .code,
        AppErrorCode::InvalidConfig
    );
    assert!(registry.advance(id, MeetingStage::Failed));
    assert!(registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "all failed"))
        .is_some());
    match registry.status(id) {
        qingmo_lib::state::meeting::job::MeetingOutcome::Failed { error, attempt } => {
            assert_eq!(error.code, AppErrorCode::AsrFailed);
            assert_eq!(attempt, 1);
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[test]
fn repeated_exit_sets_return_false() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_transcribing(&registry, id);
    assert!(registry.set_stop_reason(id, StopReason::Completed));
    assert!(!registry.set_stop_reason(id, StopReason::Silent));
    assert!(registry.set_exit(id, StopExit::Releasing));
    assert!(!registry.set_exit(id, StopExit::Failed));
}

#[test]
fn release_wins_over_late_finish_and_does_not_emit() {
    let (registry, recorder) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_rendering(&registry, id);
    let before = recorder.events.lock().unwrap().len();
    assert!(registry.release(id));
    assert!(registry.finish(id, result()).is_none());
    assert_eq!(recorder.events.lock().unwrap().len(), before);
    assert!(matches!(
        registry.status(id),
        qingmo_lib::state::meeting::job::MeetingOutcome::Gone
    ));
}

#[test]
fn result_is_retrievable_repeatedly_and_release_removes_it() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_rendering(&registry, id);
    let snapshot = registry.finish(id, result()).unwrap();
    assert_eq!(snapshot.stage, MeetingStage::Done);
    assert_eq!(registry.take_result(id).unwrap().markdown, "# 纪要");
    assert_eq!(registry.take_result(id).unwrap().markdown, "# 纪要");

    assert!(registry.release_by_label("doc-a"));
    assert!(registry.take_result(id).is_none());
    assert!(matches!(
        registry.status(id),
        qingmo_lib::state::meeting::job::MeetingOutcome::Gone
    ));
}

#[test]
fn released_window_can_start_again_immediately() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    assert!(registry.release(id));
    registry.begin(source("b.m4a"), "doc-b").unwrap();
    assert!(matches!(
        registry.status(id),
        qingmo_lib::state::meeting::job::MeetingOutcome::Gone
    ));
}

#[test]
fn a_finished_result_survives_b_starting() {
    let (registry, _) = registry();
    let (a, _) = begin(&registry, "doc-a");
    to_rendering(&registry, a);
    registry.finish(a, result()).unwrap();
    let (b, _) = begin(&registry, "doc-b");
    assert_eq!(registry.take_result(a).unwrap().markdown, "# 纪要");
    match registry.status(b) {
        qingmo_lib::state::meeting::job::MeetingOutcome::Running(progress) => {
            assert_eq!(progress.stage, MeetingStage::Preparing)
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    to_rendering(&registry, b);
    registry.finish(b, result()).unwrap();
}

#[test]
fn failed_retry_keeps_source_and_audio_url_and_bumps_attempt() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    assert!(registry.set_audio_url(id, "asset://voice.wav".into()));
    registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "all failed"))
        .unwrap();

    let (token, attempt) = registry.retry(id, "doc-a").unwrap();
    assert_eq!(attempt, 2);
    assert!(!token.is_cancelled());
    match registry.status(id) {
        qingmo_lib::state::meeting::job::MeetingOutcome::Running(progress) => {
            assert_eq!(progress.attempt, 2);
            assert_eq!(progress.duration_ms, 90_000);
            assert_eq!(progress.source_name, "voice.m4a");
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    let snapshot = registry
        .fail(id, AppError::new(AppErrorCode::Cancelled, "stop"))
        .unwrap();
    assert_eq!(snapshot.stage, MeetingStage::Cancelled);
}

#[test]
fn cancelled_terminal_is_not_retryable() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    registry
        .fail(id, AppError::new(AppErrorCode::Cancelled, "stop"))
        .unwrap();
    let error = registry.retry(id, "doc-a").unwrap_err();
    assert_eq!(error.code, AppErrorCode::InvalidConfig);
}

#[test]
fn retry_requires_the_matching_label_and_an_empty_slot() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "all failed"))
        .unwrap();
    assert_eq!(
        registry.retry(id, "doc-b").unwrap_err().code,
        AppErrorCode::NotFound
    );
    let (other, _) = begin(&registry, "doc-b");
    assert_eq!(
        registry.retry(id, "doc-a").unwrap_err().code,
        AppErrorCode::MeetingBusy
    );
    registry
        .fail(other, AppError::new(AppErrorCode::Cancelled, "stop"))
        .unwrap();
}

#[test]
fn stale_finish_and_fail_do_not_evict_the_running_job() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_rendering(&registry, id);
    let stale = uuid::Uuid::new_v4();

    assert!(registry.finish(stale, result()).is_none());
    assert!(matches!(
        registry.status(id),
        qingmo_lib::ipc::dto::MeetingOutcome::Running(_)
    ));
    assert!(registry
        .fail(stale, AppError::new(AppErrorCode::AsrFailed, "stale"))
        .is_none());
    assert!(matches!(
        registry.status(id),
        qingmo_lib::ipc::dto::MeetingOutcome::Running(_)
    ));

    let snapshot = registry.finish(id, result()).expect("current job finishes");
    assert_eq!(snapshot.stage, MeetingStage::Done);
}

#[test]
fn duplicate_finish_does_not_replace_the_terminal() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_rendering(&registry, id);
    registry.finish(id, result()).unwrap();
    assert!(registry.finish(id, result()).is_none());
    assert!(registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "late"))
        .is_none());
    assert_eq!(registry.take_result(id).unwrap().markdown, "# 纪要");
}

#[test]
fn partial_done_stays_ready_with_partial_true() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_transcribing(&registry, id);
    assert!(registry.set_partial(id, true));
    assert!(registry.set_stop_reason(id, StopReason::Deadline));
    assert!(registry.set_exit(id, StopExit::Partial));
    assert!(registry.advance(id, MeetingStage::Releasing));
    assert!(registry.advance(id, MeetingStage::Summarizing));
    assert!(registry.advance(id, MeetingStage::Rendering));
    let snapshot = registry.finish(id, result()).unwrap();
    assert_eq!(snapshot.stage, MeetingStage::PartialDone);
    match registry.status(id) {
        qingmo_lib::state::meeting::job::MeetingOutcome::Ready(result) => {
            assert!(result.partial)
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[test]
fn result_partial_forces_partial_done() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_rendering(&registry, id);
    let mut result = result();
    result.partial = true;
    let snapshot = registry.finish(id, result).unwrap();
    assert_eq!(snapshot.stage, MeetingStage::PartialDone);
    assert!(registry.take_result(id).unwrap().partial);
}

#[test]
fn retry_resets_partial() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    to_transcribing(&registry, id);
    assert!(registry.set_partial(id, true));
    registry.set_stop_reason(id, StopReason::Deadline);
    registry.set_exit(id, StopExit::Partial);
    registry.advance(id, MeetingStage::Releasing);
    registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "failed"))
        .unwrap();
    registry.retry(id, "doc-a").unwrap();
    to_rendering(&registry, id);
    let snapshot = registry.finish(id, result()).unwrap();
    assert_eq!(snapshot.stage, MeetingStage::Done);
}

#[test]
fn illegal_transitions_are_invalid_config() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    for target in [
        MeetingStage::Rendering,
        MeetingStage::Summarizing,
        MeetingStage::Done,
        MeetingStage::PartialDone,
    ] {
        assert_eq!(
            registry.advance_checked(id, target).unwrap_err().code,
            AppErrorCode::InvalidConfig,
            "{target:?}"
        );
    }
    assert!(registry
        .advance_checked(id, MeetingStage::Transcribing)
        .is_ok());
    assert_eq!(
        registry
            .advance_checked(id, MeetingStage::Done)
            .unwrap_err()
            .code,
        AppErrorCode::InvalidConfig
    );
    assert!(registry.advance_checked(id, MeetingStage::Partial).is_ok());
    assert_eq!(
        registry
            .advance_checked(id, MeetingStage::Done)
            .unwrap_err()
            .code,
        AppErrorCode::InvalidConfig
    );
}

#[test]
fn finish_before_rendering_returns_none_and_keeps_the_job() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    assert!(registry.finish(id, result()).is_none());
    assert!(matches!(
        registry.status(id),
        qingmo_lib::state::meeting::job::MeetingOutcome::Running(_)
    ));
}

#[test]
fn progress_fields_and_backend_are_settable() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    assert!(registry.set_backend(id, AsrBackend::Local));
    assert!(registry.set_speaker_count(id, 4));
    assert!(registry.set_failed_segments(id, 2));
    assert!(registry.set_window(
        id,
        Some(WindowProgress {
            index: 1,
            total: 3,
            phase: WindowPhase::Transcribing,
            done_segments: 2,
            total_segments: 5,
        })
    ));
    assert!(registry.degrade(
        id,
        Degraded {
            remote_fallback: true,
            ..Degraded::default()
        }
    ));
    let snapshot = registry
        .fail(id, AppError::new(AppErrorCode::Cancelled, "stop"))
        .unwrap();
    assert_eq!(snapshot.speaker_count, Some(4));
    assert_eq!(snapshot.failed_segments, 2);
    assert!(snapshot.degraded.remote_fallback);
    assert_eq!(snapshot.window.unwrap().index, 1);
}

#[derive(Default)]
struct AllowRecorder {
    allowed: Mutex<Vec<PathBuf>>,
}

impl AssetAllow for AllowRecorder {
    fn allow(&self, path: &Path) -> Result<(), AppError> {
        self.allowed.lock().unwrap().push(path.to_owned());
        Ok(())
    }
}

#[test]
fn asset_scope_allows_only_on_zero_to_one() {
    let recorder = Arc::new(AllowRecorder::default());
    let scope = AssetScope::with_allow(Box::new(SharedAllow(recorder.clone())));
    let path = Path::new("/meetings/a.wav");
    assert!(scope.acquire("doc-a", path).unwrap());
    assert!(!scope.acquire("doc-a", path).unwrap());
    assert_eq!(recorder.allowed.lock().unwrap().len(), 1);
    assert_eq!(scope.refs("doc-a"), Some(2));
    assert!(scope.release_by_label("doc-a"));
    assert_eq!(scope.refs("doc-a"), Some(1));
    assert!(scope.release_by_label("doc-a"));
    assert_eq!(scope.refs("doc-a"), None);
    assert_eq!(recorder.allowed.lock().unwrap().len(), 1);

    assert!(scope.acquire("doc-a", path).unwrap());
    assert_eq!(scope.path("doc-a").unwrap(), path);
    assert_eq!(recorder.allowed.lock().unwrap().len(), 2);
}

#[test]
fn asset_scope_keeps_other_labels() {
    let recorder = Arc::new(AllowRecorder::default());
    let scope = AssetScope::with_allow(Box::new(SharedAllow(recorder.clone())));
    scope.acquire("doc-a", Path::new("/a.wav")).unwrap();
    scope.acquire("doc-b", Path::new("/b.wav")).unwrap();
    scope.release_by_label("doc-a");
    assert_eq!(scope.path("doc-b").unwrap(), PathBuf::from("/b.wav"));
    assert_eq!(recorder.allowed.lock().unwrap().len(), 2);
}

struct SharedAllow(Arc<AllowRecorder>);

impl AssetAllow for SharedAllow {
    fn allow(&self, path: &Path) -> Result<(), AppError> {
        self.0.allow(path)
    }
}

#[test]
fn unknown_cancel_and_release_are_reported() {
    let (registry, _) = registry();
    let missing = uuid::Uuid::new_v4();
    assert_eq!(
        registry.cancel(missing).unwrap_err().code,
        AppErrorCode::NotFound
    );
    assert!(!registry.cancel_by_label("doc-x"));
    assert!(!registry.release(missing));
    assert!(!registry.release_by_label("doc-x"));
}

#[test]
fn progress_wire_shape_is_camel_case() {
    let (registry, recorder) = registry();
    begin(&registry, "doc-a");
    let events = recorder.events.lock().unwrap();
    let json = serde_json::to_string(&events[0].1).unwrap();
    assert!(json.contains("\"requestId\""));
    assert!(json.contains("\"sourceName\""));
    assert!(json.contains("\"actualBackend\""));
    assert!(!json.contains("request_id"));
}

#[test]
fn asr_and_llm_modes_are_available_to_job_progress() {
    let (registry, _) = registry();
    let (id, _) = begin(&registry, "doc-a");
    let snapshot = registry
        .fail(id, AppError::new(AppErrorCode::Cancelled, "stop"))
        .unwrap();
    assert_eq!(snapshot.actual_backend, AsrBackend::Local);
    assert_eq!(snapshot.accel, Accel::Cpu);
    assert_eq!(snapshot.llm_mode, LlmMode::Local);
}

#[test]
fn label_map_is_not_shared_between_windows() {
    let recorder = Arc::new(AllowRecorder::default());
    let scope = AssetScope::with_allow(Box::new(SharedAllow(recorder)));
    scope.acquire("doc-a", Path::new("/a.wav")).unwrap();
    scope.acquire("doc-b", Path::new("/b.wav")).unwrap();
    let mut seen = HashMap::new();
    seen.insert("doc-a", scope.path("doc-a").unwrap());
    seen.insert("doc-b", scope.path("doc-b").unwrap());
    assert_ne!(seen["doc-a"], seen["doc-b"]);
}
