//! Single-slot meeting registry.
//!
//! One lock guards the running job, terminals and tombstones. `release*` takes
//! the job out immediately so a destroyed window stops blocking new tasks; a
//! late `finish`/`fail` then returns `None` and emits nothing.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::job::{
    retryable_error, AsrBackend, Degraded, MeetingJob, MeetingOutcome, MeetingResult,
    MeetingSource, MeetingStage, Terminal, WindowProgress,
};
use super::job::{Accel, LlmMode};
use super::progress::{ProgressEmitter, TauriProgressEmitter};
use crate::error::{AppError, AppErrorCode};
use crate::services::meeting::pipeline::{StopExit, StopReason};
use crate::state::meeting::job::MeetingProgress;

#[derive(Default)]
struct RegistryState {
    running: Option<MeetingJob>,
    terminals: HashMap<String, (Uuid, Terminal)>,
    released: HashSet<String>,
}

pub struct MeetingRegistry {
    state: Mutex<RegistryState>,
    emitter: Arc<dyn ProgressEmitter>,
}

impl MeetingRegistry {
    pub fn new(app: AppHandle) -> Self {
        Self::with_emitter(Arc::new(TauriProgressEmitter::new(app)))
    }

    pub fn with_emitter(emitter: Arc<dyn ProgressEmitter>) -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            emitter,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state.lock().expect("meeting registry poisoned")
    }

    /// Emit one snapshot. Mutation helpers already emit; terminal snapshots
    /// returned by `finish`/`fail` are emitted once by their caller.
    pub fn emit_progress(&self, label: &str, progress: &MeetingProgress) {
        self.emitter.emit(label, progress);
    }

    pub fn begin(
        &self,
        source: MeetingSource,
        window_label: &str,
    ) -> Result<(Uuid, CancellationToken), AppError> {
        let mut state = self.lock();
        if state.running.is_some() {
            return Err(AppError::new(
                AppErrorCode::MeetingBusy,
                "another meeting task is running",
            ));
        }
        let id = Uuid::new_v4();
        let token = CancellationToken::new();
        state.released.remove(window_label);
        let display_title = title_from_source(&source);
        let mut job = MeetingJob::new(id, 1, source, window_label.to_owned(), display_title, None);
        job.cancel_token = token.clone();
        let progress = job.progress();
        state.running = Some(job);
        drop(state);
        self.emit_progress(window_label, &progress);
        Ok((id, token))
    }

    /// Rebuild the same request id from a retryable Failed terminal.
    pub fn retry(
        &self,
        id: Uuid,
        window_label: &str,
    ) -> Result<(CancellationToken, u32), AppError> {
        let mut state = self.lock();
        if state.running.is_some() {
            return Err(AppError::new(
                AppErrorCode::MeetingBusy,
                "another meeting task is running",
            ));
        }
        let Some((terminal_id, terminal)) = state.terminals.get(window_label) else {
            return Err(AppError::new(
                AppErrorCode::NotFound,
                "no failed task for this window",
            ));
        };
        if *terminal_id != id {
            return Err(AppError::new(
                AppErrorCode::NotFound,
                "failed task belongs to another window",
            ));
        }
        let Terminal::Failed {
            error,
            source,
            audio_url,
            display_title,
            attempt,
        } = terminal
        else {
            return Err(AppError::new(
                AppErrorCode::InvalidConfig,
                "task is not retryable",
            ));
        };
        if !retryable_error(error) {
            return Err(AppError::new(
                AppErrorCode::InvalidConfig,
                "cancelled task is not retryable",
            )
            .with_details(serde_json::json!({ "reason": "cancelled" })));
        }
        let source = source.clone();
        let audio_url = audio_url.clone();
        let display_title = display_title.clone();
        let next_attempt = attempt.saturating_add(1);
        state.terminals.remove(window_label);
        state.released.remove(window_label);
        let token = CancellationToken::new();
        let mut job = MeetingJob::new(
            id,
            next_attempt,
            source,
            window_label.to_owned(),
            display_title,
            audio_url,
        );
        job.cancel_token = token.clone();
        let progress = job.progress();
        state.running = Some(job);
        drop(state);
        self.emit_progress(window_label, &progress);
        Ok((token, next_attempt))
    }

    pub fn cancel(&self, id: Uuid) -> Result<(), AppError> {
        let state = self.lock();
        let Some(job) = state.running.as_ref().filter(|job| job.id == id) else {
            return Err(AppError::new(
                AppErrorCode::NotFound,
                "meeting task is not running",
            ));
        };
        job.cancel_token.cancel();
        Ok(())
    }

    pub fn cancel_by_label(&self, label: &str) -> bool {
        let state = self.lock();
        let Some(job) = state
            .running
            .as_ref()
            .filter(|job| job.window_label == label)
        else {
            return false;
        };
        job.cancel_token.cancel();
        true
    }

    /// Cancel, discard the running job, delete any terminal and tombstone label.
    pub fn release(&self, id: Uuid) -> bool {
        let mut state = self.lock();
        let mut label = state
            .running
            .as_ref()
            .filter(|job| job.id == id)
            .map(|job| job.window_label.clone());
        if label.is_none() {
            label = state
                .terminals
                .iter()
                .find_map(|(label, (terminal_id, _))| (*terminal_id == id).then(|| label.clone()));
        }
        let Some(label) = label else {
            return false;
        };
        if let Some(job) = state.running.as_ref() {
            if job.id == id {
                job.cancel_token.cancel();
                state.running = None;
            }
        }
        state.terminals.remove(&label);
        state.released.insert(label);
        true
    }

    pub fn release_by_label(&self, label: &str) -> bool {
        let mut state = self.lock();
        let mut found = false;
        if let Some(job) = state.running.as_ref() {
            if job.window_label == label {
                job.cancel_token.cancel();
                state.running = None;
                found = true;
            }
        }
        if state.terminals.remove(label).is_some() {
            found = true;
        }
        if found {
            state.released.insert(label.to_owned());
        }
        found
    }

    pub fn status(&self, id: Uuid) -> MeetingOutcome {
        let state = self.lock();
        if let Some(job) = state.running.as_ref() {
            if job.id == id {
                return MeetingOutcome::Running(job.progress());
            }
        }
        for (terminal_id, terminal) in state.terminals.values() {
            if *terminal_id != id {
                continue;
            }
            return match terminal {
                Terminal::Ready(result) => MeetingOutcome::Ready(result.clone()),
                Terminal::Failed { error, attempt, .. } => MeetingOutcome::Failed {
                    error: error.clone(),
                    attempt: *attempt,
                },
            };
        }
        MeetingOutcome::Gone
    }

    pub fn advance(&self, id: Uuid, stage: MeetingStage) -> bool {
        self.advance_checked(id, stage).is_ok()
    }

    pub fn advance_checked(&self, id: Uuid, stage: MeetingStage) -> Result<(), AppError> {
        let mut state = self.lock();
        let Some(job) = state.running.as_mut().filter(|job| job.id == id) else {
            return Err(AppError::new(
                AppErrorCode::NotFound,
                "meeting task is not running",
            ));
        };
        validate_stage(job, stage)?;
        job.stage = stage;
        let progress = job.progress();
        let label = job.window_label.clone();
        drop(state);
        self.emit_progress(&label, &progress);
        Ok(())
    }

    pub fn set_window(&self, id: Uuid, window: Option<WindowProgress>) -> bool {
        self.mutate(id, |job| job.window = window)
    }

    pub fn set_failed_segments(&self, id: Uuid, failed: u32) -> bool {
        self.mutate(id, |job| job.failed_segments = failed)
    }

    pub fn degrade(&self, id: Uuid, degraded: Degraded) -> bool {
        self.mutate(id, |job| {
            let target = &mut job.degraded;
            target.llm_model_missing |= degraded.llm_model_missing;
            target.llm_unconfigured |= degraded.llm_unconfigured;
            target.llm_budget_exceeded |= degraded.llm_budget_exceeded;
            target.llm_failed |= degraded.llm_failed;
            target.partial_decode |= degraded.partial_decode;
            target.remote_fallback |= degraded.remote_fallback;
            target.remote_key_missing |= degraded.remote_key_missing;
            target.speaker_degraded |= degraded.speaker_degraded;
            target.speaker_partial |= degraded.speaker_partial;
            target.high_memory_model |= degraded.high_memory_model;
            target.slow_machine |= degraded.slow_machine;
            if degraded.remote_last_error.is_some() {
                target.remote_last_error = degraded.remote_last_error;
            }
            if degraded.partial_until_ms.is_some() {
                target.partial_until_ms = degraded.partial_until_ms;
            }
        })
    }

    pub fn set_backend(&self, id: Uuid, backend: AsrBackend) -> bool {
        self.mutate(id, |job| job.actual_backend = backend)
    }

    pub fn set_local_model(&self, id: Uuid, model: &str) -> Result<(), AppError> {
        self.mutate_checked(id, |job| {
            job.local_model = model.to_owned();
            true
        })
        .then_some(())
        .ok_or_else(not_running)
    }

    pub fn set_accel(&self, id: Uuid, accel: Accel) -> Result<(), AppError> {
        self.mutate_checked(id, |job| {
            job.accel = accel;
            true
        })
        .then_some(())
        .ok_or_else(not_running)
    }

    pub fn set_llm_mode(&self, id: Uuid, mode: LlmMode) -> bool {
        self.mutate(id, |job| job.llm_mode = mode)
    }

    pub fn set_speaker_count(&self, id: Uuid, count: u8) -> bool {
        self.mutate(id, |job| job.speaker_count = Some(count))
    }

    pub fn set_audio_url(&self, id: Uuid, url: String) -> bool {
        self.mutate(id, |job| job.audio_url = Some(url))
    }

    pub fn set_display_title(&self, id: Uuid, title: String) -> bool {
        self.mutate(id, |job| job.display_title = title)
    }

    pub fn set_partial(&self, id: Uuid, partial: bool) -> bool {
        self.mutate(id, |job| job.partial = partial)
    }

    pub fn set_stop_reason(&self, id: Uuid, reason: StopReason) -> bool {
        self.mutate_checked(id, |job| {
            if job.stop_reason.is_some() {
                return false;
            }
            job.stop_reason = Some(reason);
            true
        })
    }

    pub fn set_exit(&self, id: Uuid, exit: StopExit) -> bool {
        self.mutate_checked(id, |job| {
            if job.exit.is_some() {
                return false;
            }
            job.exit = Some(exit);
            true
        })
    }

    fn mutate(&self, id: Uuid, apply: impl FnOnce(&mut MeetingJob)) -> bool {
        self.mutate_checked(id, |job| {
            apply(job);
            true
        })
    }

    fn mutate_checked(&self, id: Uuid, apply: impl FnOnce(&mut MeetingJob) -> bool) -> bool {
        let mut state = self.lock();
        let Some(job) = state.running.as_mut().filter(|job| job.id == id) else {
            return false;
        };
        if !apply(job) {
            return false;
        }
        let progress = job.progress();
        let label = job.window_label.clone();
        drop(state);
        self.emit_progress(&label, &progress);
        true
    }

    /// Success terminal; returns the only snapshot that may be emitted.
    pub fn finish(&self, id: Uuid, mut result: MeetingResult) -> Option<MeetingProgress> {
        let mut state = self.lock();
        let job = state.running.take()?;
        if job.id != id || state.released.contains(&job.window_label) {
            return None;
        }
        if job.stage != MeetingStage::Rendering {
            state.running = Some(job);
            return None;
        }
        let stage = if job.partial || result.partial {
            MeetingStage::PartialDone
        } else {
            MeetingStage::Done
        };
        let mut job = job;
        job.stage = stage;
        job.partial = result.partial || job.partial;
        result.partial = job.partial;
        if job.audio_url.is_some() {
            result.audio_url = job.audio_url.clone().unwrap_or_default();
        }
        if result.title.is_empty() {
            result.title.clone_from(&job.display_title);
        }
        result.stats.failed_segments = job.failed_segments;
        if result.duration_ms == 0 {
            result.duration_ms = job.source.duration_ms;
        }
        let progress = job.progress();
        state
            .terminals
            .insert(job.window_label.clone(), (id, Terminal::Ready(result)));
        Some(progress)
    }

    /// Cancelled or failed terminal. CANCELLED sets `stage=Cancelled`; any other
    /// error must arrive after `Releasing` (or directly from `Preparing`).
    pub fn fail(&self, id: Uuid, error: AppError) -> Option<MeetingProgress> {
        let mut state = self.lock();
        let job = state.running.take()?;
        if job.id != id || state.released.contains(&job.window_label) {
            return None;
        }
        let cancelled = error.code == AppErrorCode::Cancelled;
        let stage = if cancelled {
            MeetingStage::Cancelled
        } else {
            MeetingStage::Failed
        };
        let allowed = if cancelled {
            !job.stage.is_terminal()
        } else {
            matches!(
                job.stage,
                MeetingStage::Preparing | MeetingStage::Releasing | MeetingStage::Failed
            )
        };
        if !allowed {
            state.running = Some(job);
            return None;
        }
        let mut job = job;
        job.stage = stage;
        job.error = Some(error.clone());
        let progress = job.progress();
        state.terminals.insert(
            job.window_label.clone(),
            (
                id,
                Terminal::Failed {
                    error,
                    source: job.source.clone(),
                    audio_url: job.audio_url.clone(),
                    display_title: job.display_title.clone(),
                    attempt: job.attempt,
                },
            ),
        );
        Some(progress)
    }

    /// Label of the running job, used to emit its terminal snapshot.
    pub fn running_label(&self, id: Uuid) -> Option<String> {
        self.lock()
            .running
            .as_ref()
            .filter(|job| job.id == id)
            .map(|job| job.window_label.clone())
    }

    /// Clone the running source, used by `meeting_retry` to spawn again.
    pub fn running_source(&self, id: Uuid) -> Option<MeetingSource> {
        self.lock()
            .running
            .as_ref()
            .filter(|job| job.id == id)
            .map(|job| job.source.clone())
    }

    /// Display title for a meeting window, used when locale changes rebuild
    /// native titles. Ready terminals keep the title that was rendered.
    pub fn display_title_for_label(&self, label: &str) -> Option<String> {
        let state = self.lock();
        if let Some(job) = state
            .running
            .as_ref()
            .filter(|job| job.window_label == label)
        {
            return Some(job.display_title.clone());
        }
        state
            .terminals
            .get(label)
            .map(|(_, terminal)| match terminal {
                Terminal::Ready(result) => result.title.clone(),
                Terminal::Failed { display_title, .. } => display_title.clone(),
            })
    }

    pub fn take_result(&self, id: Uuid) -> Option<MeetingResult> {
        let state = self.lock();
        state
            .terminals
            .values()
            .find_map(|(terminal_id, terminal)| {
                if *terminal_id != id {
                    return None;
                }
                match terminal {
                    Terminal::Ready(result) => Some(result.clone()),
                    Terminal::Failed { .. } => None,
                }
            })
    }
}

fn not_running() -> AppError {
    AppError::new(AppErrorCode::NotFound, "meeting task is not running")
}

fn title_from_source(source: &MeetingSource) -> String {
    source
        .path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| source.display_name())
}

fn validate_stage(job: &MeetingJob, target: MeetingStage) -> Result<(), AppError> {
    let allowed = match (job.stage, target) {
        (
            MeetingStage::Preparing,
            MeetingStage::Transcribing | MeetingStage::Failed | MeetingStage::Cancelled,
        ) => true,
        (
            MeetingStage::Transcribing,
            MeetingStage::Transcribing | MeetingStage::Releasing | MeetingStage::Partial,
        ) => true,
        (MeetingStage::Partial, MeetingStage::Releasing) => true,
        (MeetingStage::Releasing, _) => match job.exit {
            Some(StopExit::Failed) => target == MeetingStage::Failed,
            Some(StopExit::Releasing | StopExit::Partial) | None => {
                matches!(
                    target,
                    MeetingStage::Summarizing
                        | MeetingStage::Rendering
                        | MeetingStage::Failed
                        | MeetingStage::Cancelled
                )
            }
        },
        (MeetingStage::Summarizing, MeetingStage::Rendering | MeetingStage::Releasing) => true,
        (MeetingStage::Rendering, MeetingStage::Done) => !job.partial,
        (MeetingStage::Rendering, MeetingStage::PartialDone) => job.partial,
        (MeetingStage::Rendering, MeetingStage::Cancelled) => true,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(AppError::new(
            AppErrorCode::InvalidConfig,
            format!("illegal meeting transition {:?} -> {target:?}", job.stage),
        )
        .with_details(serde_json::json!({
            "reason": "stage_transition",
            "from": job.stage,
            "to": target,
        })))
    }
}
