//! Pure registry data: job, terminal, progress snapshots and result types.
//!
//! Time is absolute audio milliseconds from the source start. The registry never
//! reads the audio file; `source_name` and elapsed time are display-only.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::meeting::asr_route::AsrMode;
use crate::services::meeting::pipeline::{StopExit, StopReason};
use crate::services::meeting::remote_asr::RemoteProvider;
use crate::services::meeting::runtime::Accel;
use crate::services::meeting::summarize::LlmMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingSource {
    pub path: PathBuf,
    pub bytes: u64,
    pub duration_ms: u64,
}

impl MeetingSource {
    pub fn new(path: impl Into<PathBuf>, bytes: u64, duration_ms: u64) -> Self {
        Self {
            path: path.into(),
            bytes,
            duration_ms,
        }
    }

    pub fn display_name(&self) -> String {
        source_name(&self.path)
    }
}

fn source_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStage {
    Preparing,
    Transcribing,
    Releasing,
    Summarizing,
    Rendering,
    Partial,
    PartialDone,
    Done,
    Cancelled,
    Failed,
}

impl MeetingStage {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::PartialDone | Self::Done | Self::Cancelled | Self::Failed
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowPhase {
    Decoding,
    Diarizing,
    Transcribing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WindowProgress {
    pub index: u32,
    pub total: u32,
    pub phase: WindowPhase,
    pub done_segments: u32,
    pub total_segments: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "provider", rename_all = "lowercase")]
pub enum AsrBackend {
    #[default]
    Local,
    Remote(RemoteProvider),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Degraded {
    #[serde(default)]
    pub llm_model_missing: bool,
    #[serde(default)]
    pub llm_unconfigured: bool,
    #[serde(default)]
    pub llm_budget_exceeded: bool,
    #[serde(default)]
    pub partial_decode: bool,
    #[serde(default)]
    pub remote_fallback: bool,
    #[serde(default)]
    pub remote_key_missing: bool,
    #[serde(default)]
    pub remote_last_error: Option<crate::services::meeting::runtime::ReasonCode>,
    #[serde(default)]
    pub partial_until_ms: Option<u64>,
    #[serde(default)]
    pub speaker_degraded: bool,
    #[serde(default)]
    pub speaker_partial: bool,
    #[serde(default)]
    pub high_memory_model: bool,
    #[serde(default)]
    pub slow_machine: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStats {
    pub decisions: u32,
    pub actions: u32,
    pub risks: u32,
    pub unverified: u32,
    pub failed_segments: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResult {
    pub markdown: String,
    pub audio_url: String,
    pub title: String,
    pub duration_ms: u64,
    pub stats: MeetingStats,
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingProgress {
    pub request_id: Uuid,
    pub attempt: u32,
    pub stage: MeetingStage,
    pub window: Option<WindowProgress>,
    pub elapsed_ms: u64,
    pub source_name: String,
    pub duration_ms: u64,
    pub bytes: u64,
    pub actual_backend: AsrBackend,
    pub local_model: String,
    pub llm_mode: LlmMode,
    pub llm_model: String,
    pub accel: Accel,
    pub rtf: Option<f32>,
    pub speaker_count: Option<u8>,
    pub failed_segments: u32,
    pub degraded: Degraded,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MeetingOutcome {
    Running(MeetingProgress),
    Ready(MeetingResult),
    Failed { error: AppError, attempt: u32 },
    Gone,
}

pub enum Terminal {
    Ready(MeetingResult),
    Failed {
        error: AppError,
        source: MeetingSource,
        audio_url: Option<String>,
        display_title: String,
        attempt: u32,
    },
}

pub struct MeetingJob {
    pub id: Uuid,
    pub attempt: u32,
    pub stage: MeetingStage,
    pub source: MeetingSource,
    pub window_label: String,
    pub display_title: String,
    pub audio_url: Option<String>,
    pub cancel_token: CancellationToken,
    pub partial: bool,
    pub stop_reason: Option<StopReason>,
    pub exit: Option<StopExit>,
    pub actual_backend: AsrBackend,
    pub local_model: String,
    pub llm_mode: LlmMode,
    pub llm_model: String,
    pub accel: Accel,
    pub rtf: Option<f32>,
    pub speaker_count: Option<u8>,
    pub failed_segments: u32,
    pub degraded: Degraded,
    pub window: Option<WindowProgress>,
    pub error: Option<AppError>,
    started: Instant,
}

impl MeetingJob {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: Uuid,
        attempt: u32,
        source: MeetingSource,
        window_label: String,
        display_title: String,
        audio_url: Option<String>,
    ) -> Self {
        Self {
            id,
            attempt,
            stage: MeetingStage::Preparing,
            source,
            window_label,
            display_title,
            audio_url,
            cancel_token: CancellationToken::new(),
            partial: false,
            stop_reason: None,
            exit: None,
            actual_backend: AsrBackend::Local,
            local_model: String::new(),
            llm_mode: LlmMode::Local,
            llm_model: String::new(),
            accel: Accel::Cpu,
            rtf: None,
            speaker_count: None,
            failed_segments: 0,
            degraded: Degraded::default(),
            window: None,
            error: None,
            started: Instant::now(),
        }
    }

    pub fn progress(&self) -> MeetingProgress {
        MeetingProgress {
            request_id: self.id,
            attempt: self.attempt,
            stage: self.stage,
            window: self.window,
            elapsed_ms: self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            source_name: self.source.display_name(),
            duration_ms: self.source.duration_ms,
            bytes: self.source.bytes,
            actual_backend: self.actual_backend,
            local_model: self.local_model.clone(),
            llm_mode: self.llm_mode,
            llm_model: self.llm_model.clone(),
            accel: self.accel,
            rtf: self.rtf,
            speaker_count: self.speaker_count,
            failed_segments: self.failed_segments,
            degraded: self.degraded.clone(),
            error: self.error.clone(),
        }
    }
}

/// `MeetingSource` is only needed by retries and never crosses IPC.
pub fn retryable_error(error: &AppError) -> bool {
    error.code != crate::error::AppErrorCode::Cancelled
}

pub fn asr_mode_local() -> AsrMode {
    AsrMode::Local
}
