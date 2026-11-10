//! Progress snapshots and targeted emission.
//!
//! Every registry mutation builds exactly one snapshot; the caller only emits
//! when the registry returns `Some`, so a released job cannot emit afterwards.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::job::MeetingProgress;

pub const EVENT_MEETING_PROGRESS: &str = "app://meeting-progress";

pub trait ProgressEmitter: Send + Sync {
    fn emit(&self, window_label: &str, progress: &MeetingProgress);
}

pub struct TauriProgressEmitter {
    app: AppHandle,
}

impl TauriProgressEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ProgressEmitter for TauriProgressEmitter {
    fn emit(&self, window_label: &str, progress: &MeetingProgress) {
        if let Err(error) =
            self.app
                .emit_to(window_label.to_owned(), EVENT_MEETING_PROGRESS, progress)
        {
            tracing::warn!(%error, window_label, "failed to emit meeting progress");
        }
    }
}

/// Serialize helper used by tests to prove the DTO wire shape.
pub fn wire_json(progress: &MeetingProgress) -> String {
    serde_json::to_string(progress).expect("progress is serializable")
}

pub fn _assert_progress_serializable<T: Serialize>(_value: &T) {}
