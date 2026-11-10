//! Meeting window contract: save-as names, query encoding and destruction
//! cleanup. The EditorBoot behaviour lives in the frontend tests.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use qingmo_lib::commands::document::meeting_save_as_name;
use qingmo_lib::commands::meeting::meeting_query;
use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::state::meeting::asset_scope::{AssetAllow, AssetScope};
use qingmo_lib::state::meeting::job::{MeetingOutcome, MeetingProgress, MeetingSource};
use qingmo_lib::state::meeting::progress::ProgressEmitter;
use qingmo_lib::state::meeting::registry::MeetingRegistry;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<MeetingProgress>>,
}

impl ProgressEmitter for Recorder {
    fn emit(&self, _window_label: &str, progress: &MeetingProgress) {
        self.events.lock().unwrap().push(progress.clone());
    }
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

fn registry() -> MeetingRegistry {
    MeetingRegistry::with_emitter(Arc::new(Recorder::default()))
}

fn scope() -> (AssetScope, Arc<AllowRecorder>) {
    struct Shared(Arc<AllowRecorder>);
    impl AssetAllow for Shared {
        fn allow(&self, path: &Path) -> Result<(), AppError> {
            self.0.allow(path)
        }
    }
    let recorder = Arc::new(AllowRecorder::default());
    (
        AssetScope::with_allow(Box::new(Shared(recorder.clone()))),
        recorder,
    )
}

fn source(name: &str) -> MeetingSource {
    MeetingSource::new(PathBuf::from("/meetings").join(name), 4096, 65_000)
}

#[test]
fn save_as_default_derives_from_the_meeting_title_only() {
    assert_eq!(
        meeting_save_as_name("x.md — 青墨", "青墨", "未命名.md"),
        "x.md"
    );
    assert_eq!(
        meeting_save_as_name("记录.markdown — 青墨", "青墨", "未命名.md"),
        "记录.md"
    );
    assert_eq!(
        meeting_save_as_name("访谈 — 青墨", "青墨", "未命名.md"),
        "访谈.md"
    );
    assert_eq!(
        meeting_save_as_name(" — 青墨", "青墨", "未命名.md"),
        "未命名.md"
    );
    assert_eq!(
        meeting_save_as_name("普通文档 — 青墨", "青墨", "Untitled.md"),
        "普通文档.md"
    );
}

#[test]
fn meeting_query_percent_encodes_the_stem() {
    let id = uuid::Uuid::new_v4();
    let query = meeting_query(&id, "周会 2026-11-10");
    assert!(query.starts_with(&format!("&meeting={id}&name=")));
    assert!(query.contains("%20"));
    assert!(!query.contains(' '));
}

#[test]
fn destroyed_window_cancels_and_drops_the_terminal_and_asset() {
    let registry = registry();
    let (scope, _) = scope();
    scope
        .acquire("doc-a", Path::new("/meetings/a.m4a"))
        .unwrap();
    let (id, token) = registry.begin(source("a.m4a"), "doc-a").unwrap();

    // The exact Destroyed sequence.
    registry.cancel_by_label("doc-a");
    assert!(registry.release_by_label("doc-a"));
    scope.release_by_label("doc-a");

    assert!(token.is_cancelled());
    assert!(matches!(registry.status(id), MeetingOutcome::Gone));
    assert_eq!(scope.refs("doc-a"), None);
    // The slot is immediately reusable, even before the worker stops.
    registry.begin(source("b.m4a"), "doc-b").unwrap();
}

#[test]
fn destroying_after_ready_drops_the_result() {
    let registry = registry();
    let (id, _) = registry.begin(source("a.m4a"), "doc-a").unwrap();
    registry.advance(
        id,
        qingmo_lib::state::meeting::job::MeetingStage::Transcribing,
    );
    registry.advance(id, qingmo_lib::state::meeting::job::MeetingStage::Releasing);
    registry.advance(id, qingmo_lib::state::meeting::job::MeetingStage::Rendering);
    registry
        .finish(
            id,
            qingmo_lib::state::meeting::job::MeetingResult {
                markdown: "# 纪要".into(),
                audio_url: String::new(),
                title: String::new(),
                duration_ms: 65_000,
                stats: Default::default(),
                partial: false,
            },
        )
        .unwrap();
    assert!(registry.take_result(id).is_some());

    registry.release_by_label("doc-a");
    assert!(registry.take_result(id).is_none());
}

#[test]
fn retry_reuses_the_source_and_bumps_the_attempt() {
    let registry = registry();
    let (id, _) = registry.begin(source("访谈.m4a"), "doc-a").unwrap();
    registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "all failed"))
        .unwrap();
    let (token, attempt) = registry.retry(id, "doc-a").unwrap();
    assert_eq!(attempt, 2);
    assert!(!token.is_cancelled());
    let source = registry.running_source(id).expect("source is preserved");
    assert_eq!(source.display_name(), "访谈.m4a");
    assert_eq!(source.duration_ms, 65_000);
}

#[test]
fn display_title_survives_locale_rebuilds() {
    let registry = registry();
    let (id, _) = registry.begin(source("访谈.m4a"), "doc-a").unwrap();
    registry.set_display_title(id, "访谈".into());
    assert_eq!(
        registry.display_title_for_label("doc-a").as_deref(),
        Some("访谈")
    );
    registry
        .fail(id, AppError::new(AppErrorCode::AsrFailed, "all failed"))
        .unwrap();
    assert_eq!(
        registry.display_title_for_label("doc-a").as_deref(),
        Some("访谈")
    );
}
