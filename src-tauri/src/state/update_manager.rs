use std::sync::{Arc, Mutex, MutexGuard};

use tauri_plugin_updater::Update;
use time::format_description::well_known::Rfc3339;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{UpdateInfo, UpdatePhase, UpdateProgress, UpdateSnapshot};

/// The updater manifest is plain text; keep it small enough for a webview but
/// large enough for a normal release note.
const MAX_NOTES_BYTES: usize = 64 * 1024;

/// Process-wide update state machine.
///
/// Every transition happens inside one short mutex critical section. No method
/// awaits while holding the lock; the command layer performs network/install
/// work outside the manager and then reports completion.
pub struct UpdateManager {
    inner: Mutex<Inner>,
}

struct Inner {
    phase: UpdatePhase,
    generation: u64,
    current_version: String,
    update: Option<Update>,
    update_info: Option<UpdateInfo>,
    artifact: Option<Arc<[u8]>>,
    progress: Option<UpdateProgress>,
}

impl UpdateManager {
    pub fn new(current_version: impl Into<String>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                phase: UpdatePhase::Idle,
                generation: 0,
                current_version: current_version.into(),
                update: None,
                update_info: None,
                artifact: None,
                progress: None,
            }),
        }
    }

    pub fn snapshot(&self) -> UpdateSnapshot {
        snapshot_locked(&self.lock())
    }

    /// Idle -> Checking.
    pub fn begin_check(&self) -> Result<u64, AppError> {
        let mut inner = self.lock();
        if inner.phase != UpdatePhase::Idle {
            return Err(wrong_phase(inner.phase));
        }
        inner.phase = UpdatePhase::Checking;
        inner.update = None;
        inner.update_info = None;
        inner.artifact = None;
        inner.progress = None;
        inner.generation += 1;
        Ok(inner.generation)
    }

    /// Checking -> Idle (no update announced).
    pub fn finish_check_none(&self, generation: u64) -> Result<UpdateSnapshot, AppError> {
        let mut inner = self.lock();
        ensure(&inner, UpdatePhase::Checking, generation)?;
        inner.phase = UpdatePhase::Idle;
        inner.update = None;
        inner.update_info = None;
        inner.artifact = None;
        inner.progress = None;
        advance(&mut inner);
        Ok(snapshot_locked(&inner))
    }

    /// Checking -> Available.
    pub fn finish_check_some(
        &self,
        generation: u64,
        update: Update,
    ) -> Result<UpdateSnapshot, AppError> {
        let mut inner = self.lock();
        ensure(&inner, UpdatePhase::Checking, generation)?;
        inner.update_info = Some(info_from_update(&update));
        inner.update = Some(update);
        inner.phase = UpdatePhase::Available;
        inner.artifact = None;
        inner.progress = None;
        advance(&mut inner);
        Ok(snapshot_locked(&inner))
    }

    /// Checking -> Idle on failure. The error is logged and returned by the command layer.
    pub fn fail_check(&self, generation: u64, error: AppError) -> Result<UpdateSnapshot, AppError> {
        let mut inner = self.lock();
        ensure(&inner, UpdatePhase::Checking, generation)?;
        tracing::debug!(code = ?error.code, "update check failed");
        inner.phase = UpdatePhase::Idle;
        inner.update = None;
        inner.update_info = None;
        inner.artifact = None;
        inner.progress = None;
        advance(&mut inner);
        Ok(snapshot_locked(&inner))
    }

    /// Available -> Downloading.
    pub fn begin_download(&self) -> Result<u64, AppError> {
        let mut inner = self.lock();
        if inner.phase != UpdatePhase::Available {
            return Err(wrong_phase(inner.phase));
        }
        inner.phase = UpdatePhase::Downloading;
        inner.artifact = None;
        inner.progress = Some(UpdateProgress {
            downloaded: 0,
            total: None,
        });
        inner.generation += 1;
        Ok(inner.generation)
    }

    pub fn current_update(&self) -> Option<Update> {
        self.lock().update.clone()
    }

    /// Stores cumulative progress only when the callback belongs to the current download.
    pub fn record_progress(
        &self,
        generation: u64,
        downloaded: u64,
        total: Option<u64>,
    ) -> Option<UpdateProgress> {
        let mut inner = self.lock();
        if inner.phase != UpdatePhase::Downloading || inner.generation != generation {
            return None;
        }
        let total = total.or_else(|| inner.progress.as_ref().and_then(|value| value.total));
        let progress = UpdateProgress { downloaded, total };
        inner.progress = Some(progress);
        Some(progress)
    }

    /// Downloading -> Ready. The artifact is kept as a single shared allocation.
    pub fn finish_download(
        &self,
        generation: u64,
        bytes: Vec<u8>,
    ) -> Result<UpdateSnapshot, AppError> {
        let mut inner = self.lock();
        ensure(&inner, UpdatePhase::Downloading, generation)?;
        let length = bytes.len() as u64;
        let total = inner
            .progress
            .as_ref()
            .and_then(|value| value.total)
            .unwrap_or(length);
        inner.artifact = Some(Arc::from(bytes.into_boxed_slice()));
        inner.progress = Some(UpdateProgress {
            downloaded: length,
            total: Some(total),
        });
        inner.phase = UpdatePhase::Ready;
        advance(&mut inner);
        Ok(snapshot_locked(&inner))
    }

    /// Downloading -> Available. Keeps the update so the user can retry.
    pub fn fail_download(
        &self,
        generation: u64,
        error: AppError,
    ) -> Result<UpdateSnapshot, AppError> {
        let mut inner = self.lock();
        ensure(&inner, UpdatePhase::Downloading, generation)?;
        tracing::debug!(code = ?error.code, "update download failed");
        inner.phase = UpdatePhase::Available;
        inner.artifact = None;
        inner.progress = None;
        advance(&mut inner);
        Ok(snapshot_locked(&inner))
    }

    /// Ready -> Installing.
    pub fn begin_install(&self) -> Result<u64, AppError> {
        let mut inner = self.lock();
        if inner.phase != UpdatePhase::Ready {
            return Err(wrong_phase(inner.phase));
        }
        inner.phase = UpdatePhase::Installing;
        inner.generation += 1;
        Ok(inner.generation)
    }

    pub fn artifact(&self) -> Option<Arc<[u8]>> {
        self.lock().artifact.clone()
    }

    /// Installing -> Ready (retryable) or Available (signature failure).
    pub fn fail_install(
        &self,
        generation: u64,
        error: AppError,
        clear_artifact: bool,
    ) -> Result<UpdateSnapshot, AppError> {
        let mut inner = self.lock();
        ensure(&inner, UpdatePhase::Installing, generation)?;
        tracing::debug!(code = ?error.code, "update install failed");
        if clear_artifact {
            inner.phase = UpdatePhase::Available;
            inner.artifact = None;
            inner.progress = None;
        } else {
            inner.phase = UpdatePhase::Ready;
        }
        advance(&mut inner);
        Ok(snapshot_locked(&inner))
    }

    pub fn is_installing(&self) -> bool {
        self.lock().phase == UpdatePhase::Installing
    }

    #[cfg(test)]
    pub fn force_available_for_test(&self, info: UpdateInfo) -> u64 {
        let mut inner = self.lock();
        inner.phase = UpdatePhase::Available;
        inner.update = None;
        inner.update_info = Some(info);
        inner.artifact = None;
        inner.progress = None;
        inner.generation += 1;
        inner.generation
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn ensure(inner: &Inner, expected: UpdatePhase, generation: u64) -> Result<(), AppError> {
    if inner.generation != generation {
        return Err(AppError::new(AppErrorCode::Busy, "stale update generation"));
    }
    if inner.phase != expected {
        return Err(wrong_phase(inner.phase));
    }
    Ok(())
}

fn advance(inner: &mut Inner) {
    inner.generation += 1;
}

fn wrong_phase(phase: UpdatePhase) -> AppError {
    if matches!(
        phase,
        UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing
    ) {
        AppError::new(
            AppErrorCode::Busy,
            "another update operation is in progress",
        )
    } else {
        AppError::new(
            AppErrorCode::UpdateNotReady,
            "the update is not ready for this operation",
        )
    }
}

fn snapshot_locked(inner: &Inner) -> UpdateSnapshot {
    UpdateSnapshot {
        phase: inner.phase,
        generation: inner.generation,
        current_version: inner.current_version.clone(),
        update: inner.update_info.clone(),
        progress: inner.progress,
    }
}

fn info_from_update(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        date: update.date.and_then(format_date),
        body: update.body.as_deref().map(truncate_notes),
        notes_by_locale: notes_by_locale(&update.raw_json),
    }
}

/// Reads the optional structured `notesByLocale` manifest field. Unknown
/// languages are kept; every value is truncated like the legacy body.
fn notes_by_locale(raw: &serde_json::Value) -> Option<std::collections::BTreeMap<String, String>> {
    let locales = raw.get("notesByLocale")?.as_object()?;
    let notes: std::collections::BTreeMap<String, String> = locales
        .iter()
        .filter_map(|(language, value)| {
            value
                .as_str()
                .map(|text| (language.clone(), truncate_notes(text)))
        })
        .collect();
    (!notes.is_empty()).then_some(notes)
}

fn format_date(date: time::OffsetDateTime) -> Option<String> {
    date.format(&Rfc3339).ok()
}

fn truncate_notes(notes: &str) -> String {
    if notes.len() <= MAX_NOTES_BYTES {
        return notes.to_string();
    }
    let mut end = MAX_NOTES_BYTES;
    while end > 0 && !notes.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &notes[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> UpdateInfo {
        UpdateInfo {
            version: "0.2.0".to_string(),
            date: Some("2026-10-27T12:00:00Z".to_string()),
            body: Some("Notes".to_string()),
            notes_by_locale: None,
        }
    }

    fn available_manager() -> (UpdateManager, u64) {
        let manager = UpdateManager::new("0.1.0");
        let generation = manager.force_available_for_test(info());
        (manager, generation)
    }

    fn error(code: AppErrorCode) -> AppError {
        AppError::new(code, "test error")
    }

    #[test]
    fn starts_idle() {
        let manager = UpdateManager::new("0.1.0");
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert_eq!(snapshot.generation, 0);
        assert_eq!(snapshot.current_version, "0.1.0");
        assert!(snapshot.update.is_none());
        assert!(snapshot.progress.is_none());
        assert!(!manager.is_installing());
    }

    #[test]
    fn check_is_single_flight_and_returns_to_idle() {
        let manager = UpdateManager::new("0.1.0");
        let generation = manager.begin_check().expect("check must start");
        assert_eq!(generation, 1);
        assert_eq!(manager.snapshot().phase, UpdatePhase::Checking);

        let busy = manager.begin_check().expect_err("second check must fail");
        assert_eq!(busy.code, AppErrorCode::Busy);

        let snapshot = manager
            .finish_check_none(generation)
            .expect("no-update check must finish");
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert_eq!(snapshot.generation, 2);
        assert!(snapshot.update.is_none());
    }

    #[test]
    fn available_download_ready_and_progress() {
        let (manager, available_generation) = available_manager();
        let available = manager.snapshot();
        assert_eq!(available.phase, UpdatePhase::Available);
        assert_eq!(available.generation, available_generation);
        assert_eq!(available.update, Some(info()));

        let download_generation = manager.begin_download().expect("download must start");
        assert_eq!(manager.snapshot().phase, UpdatePhase::Downloading);
        assert_eq!(
            manager
                .begin_download()
                .expect_err("second download must fail")
                .code,
            AppErrorCode::Busy
        );

        let progress = manager
            .record_progress(download_generation, 10, Some(100))
            .expect("current generation must record progress");
        assert_eq!(progress.downloaded, 10);
        assert_eq!(progress.total, Some(100));
        assert!(manager
            .record_progress(download_generation + 1, 20, None)
            .is_none());

        let ready = manager
            .finish_download(download_generation, vec![7; 10])
            .expect("download must finish");
        assert_eq!(ready.phase, UpdatePhase::Ready);
        assert_eq!(ready.progress.as_ref().unwrap().downloaded, 10);
        assert_eq!(ready.progress.as_ref().unwrap().total, Some(100));
        assert_eq!(manager.artifact().expect("artifact must exist").len(), 10);
        assert!(manager
            .record_progress(download_generation, 99, None)
            .is_none());
    }

    #[test]
    fn failed_download_keeps_update_for_retry() {
        let (manager, _) = available_manager();
        let generation = manager.begin_download().expect("download must start");
        let snapshot = manager
            .fail_download(generation, error(AppErrorCode::UpdateDownloadFailed))
            .expect("failure must roll back");
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.update, Some(info()));
        assert!(snapshot.progress.is_none());
        assert!(manager.artifact().is_none());
        assert!(manager.begin_download().is_ok());
    }

    #[test]
    fn install_requires_ready_and_handles_retry_and_signature_failure() {
        let (manager, _) = available_manager();
        assert_eq!(
            manager
                .begin_install()
                .expect_err("install before download must fail")
                .code,
            AppErrorCode::UpdateNotReady
        );

        let download_generation = manager.begin_download().expect("download must start");
        manager
            .finish_download(download_generation, vec![1, 2, 3])
            .expect("download must finish");

        let install_generation = manager.begin_install().expect("install must start");
        assert!(manager.is_installing());
        assert_eq!(
            manager
                .begin_install()
                .expect_err("double install must fail")
                .code,
            AppErrorCode::Busy
        );

        let retry = manager
            .fail_install(
                install_generation,
                error(AppErrorCode::UpdateInstallFailed),
                false,
            )
            .expect("install failure must roll back");
        assert_eq!(retry.phase, UpdatePhase::Ready);
        assert!(manager.artifact().is_some());
        assert!(!manager.is_installing());

        let install_generation = manager.begin_install().expect("install retry must start");
        let signature = manager
            .fail_install(
                install_generation,
                error(AppErrorCode::UpdateSignatureInvalid),
                true,
            )
            .expect("signature failure must roll back");
        assert_eq!(signature.phase, UpdatePhase::Available);
        assert_eq!(signature.update, Some(info()));
        assert!(manager.artifact().is_none());
        assert!(!manager.is_installing());
    }

    #[test]
    fn wrong_phase_and_stale_generation_fail_closed() {
        let manager = UpdateManager::new("0.1.0");
        assert_eq!(
            manager
                .begin_download()
                .expect_err("download before check must fail")
                .code,
            AppErrorCode::UpdateNotReady
        );

        let generation = manager.begin_check().expect("check must start");
        manager
            .finish_check_none(generation)
            .expect("check must finish");
        let busy = manager
            .finish_check_none(generation)
            .expect_err("stale completion must fail");
        assert_eq!(busy.code, AppErrorCode::Busy);
        assert_eq!(manager.snapshot().phase, UpdatePhase::Idle);
        assert_eq!(manager.snapshot().generation, 2);
    }

    #[test]
    fn structured_notes_are_read_and_truncated_per_language() {
        let raw = serde_json::json!({
            "notesByLocale": {
                "zh-CN": "中文说明",
                "en-US": "x".repeat(MAX_NOTES_BYTES + 10),
            }
        });

        let notes = notes_by_locale(&raw).expect("structured notes");
        assert_eq!(notes.get("zh-CN").map(String::as_str), Some("中文说明"));
        assert!(notes["en-US"].ends_with('…'));
        assert!(notes["en-US"].len() <= MAX_NOTES_BYTES + '…'.len_utf8());
    }

    #[test]
    fn absent_or_invalid_structured_notes_are_ignored() {
        assert!(notes_by_locale(&serde_json::json!({})).is_none());
        assert!(notes_by_locale(&serde_json::json!({"notesByLocale": []})).is_none());
        assert!(notes_by_locale(&serde_json::json!({"notesByLocale": {"zh-CN": 1}})).is_none());
    }

    #[test]
    fn notes_are_truncated_on_a_utf8_boundary() {
        let notes = "é".repeat(MAX_NOTES_BYTES);
        let truncated = truncate_notes(&notes);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() <= MAX_NOTES_BYTES + '…'.len_utf8());
        assert!(truncated.is_char_boundary(truncated.len() - '…'.len_utf8()));

        let short = "release notes";
        assert_eq!(truncate_notes(short), short);
    }

    #[test]
    fn dates_are_rfc3339() {
        let epoch = time::OffsetDateTime::from_unix_timestamp(0).expect("epoch must exist");
        assert_eq!(format_date(epoch).as_deref(), Some("1970-01-01T00:00:00Z"));
    }
}
