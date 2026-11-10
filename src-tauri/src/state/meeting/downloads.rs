//! Single-slot model download state.
//!
//! Only the worker mutates progress; the commands only enqueue, cancel or
//! inspect. Terminal states keep the last error so the settings list can show
//! it until the next enqueue.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{DownloadState, ModelProgress, ModelState};

struct Slot {
    state: DownloadState,
    download_id: Option<Uuid>,
    model_id: Option<String>,
    done_bytes: u64,
    total_bytes: u64,
    cancel: Option<CancellationToken>,
    error: Option<AppError>,
}

impl Default for Slot {
    fn default() -> Self {
        Self {
            state: DownloadState::Cancelled,
            download_id: None,
            model_id: None,
            done_bytes: 0,
            total_bytes: 0,
            cancel: None,
            error: None,
        }
    }
}

#[derive(Default)]
pub struct ModelDownloads {
    slot: Mutex<Slot>,
    settled: Condvar,
}

fn busy() -> AppError {
    AppError::new(AppErrorCode::ModelBusy, "another model download is active")
}

fn unknown() -> AppError {
    AppError::new(AppErrorCode::InvalidConfig, "unknown download id")
        .with_details(serde_json::json!({ "field": "download_id" }))
}

impl ModelDownloads {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn begin(
        &self,
        model_id: &str,
        total_bytes: u64,
    ) -> Result<(Uuid, CancellationToken), AppError> {
        let mut slot = self.lock();
        if matches!(
            slot.state,
            DownloadState::Queued | DownloadState::Downloading | DownloadState::Verifying
        ) {
            return Err(busy());
        }
        let id = Uuid::new_v4();
        let token = CancellationToken::new();
        slot.state = DownloadState::Queued;
        slot.download_id = Some(id);
        slot.model_id = Some(model_id.to_owned());
        slot.done_bytes = 0;
        slot.total_bytes = total_bytes;
        slot.cancel = Some(token.clone());
        slot.error = None;
        Ok((id, token))
    }

    pub fn start(&self, id: Uuid) {
        let mut slot = self.lock();
        if slot.download_id == Some(id) {
            slot.state = DownloadState::Downloading;
        }
    }

    pub fn set_progress(&self, id: Uuid, done_bytes: u64, total_bytes: u64) {
        let mut slot = self.lock();
        if slot.download_id == Some(id) {
            slot.done_bytes = done_bytes.min(total_bytes);
            slot.total_bytes = total_bytes;
        }
    }

    pub fn verifying(&self, id: Uuid) {
        let mut slot = self.lock();
        if slot.download_id == Some(id) {
            slot.state = DownloadState::Verifying;
        }
    }

    pub fn done(&self, id: Uuid) {
        let mut slot = self.lock();
        if slot.download_id == Some(id) {
            slot.state = DownloadState::Done;
            slot.done_bytes = slot.total_bytes;
            slot.cancel = None;
            self.settled.notify_all();
        }
    }

    pub fn fail(&self, id: Uuid, error: AppError) {
        let mut slot = self.lock();
        if slot.download_id == Some(id) {
            slot.state = if error.code == AppErrorCode::Cancelled {
                DownloadState::Cancelled
            } else {
                DownloadState::Failed
            };
            slot.error = Some(error);
            slot.cancel = None;
            self.settled.notify_all();
        }
    }

    pub fn cancel(&self, id: Uuid) -> Result<(), AppError> {
        let slot = self.lock();
        if slot.download_id != Some(id) {
            return Err(unknown());
        }
        if let Some(token) = slot.cancel.as_ref() {
            token.cancel();
        }
        Ok(())
    }

    /// Cancel the running download of `model_id` and wait until the worker
    /// settles. Returns whether a worker was actually running.
    pub fn cancel_and_wait(&self, model_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut slot = self.lock();
        let Some(id) = slot
            .download_id
            .filter(|_| slot.model_id.as_deref() == Some(model_id))
        else {
            return false;
        };
        if matches!(
            slot.state,
            DownloadState::Done | DownloadState::Failed | DownloadState::Cancelled
        ) {
            return false;
        }
        if let Some(token) = slot.cancel.as_ref() {
            token.cancel();
        }
        while !matches!(
            slot.state,
            DownloadState::Done | DownloadState::Failed | DownloadState::Cancelled
        ) {
            let now = Instant::now();
            if now >= deadline {
                let _ = id;
                break;
            }
            let (next, timeout_result) = self
                .settled
                .wait_timeout(slot, deadline.saturating_duration_since(now))
                .unwrap_or_else(|poison| poison.into_inner());
            slot = next;
            if timeout_result.timed_out() {
                break;
            }
        }
        true
    }

    /// Download state overlaid on the filesystem state for `meeting_models_list`.
    pub fn overlay(&self, model_id: &str) -> Option<(ModelState, Option<AppError>)> {
        let slot = self.lock();
        if slot.model_id.as_deref() != Some(model_id) {
            return None;
        }
        let state = match slot.state {
            DownloadState::Queued | DownloadState::Downloading => ModelState::Downloading,
            DownloadState::Verifying => ModelState::Verifying,
            DownloadState::Failed => ModelState::Failed,
            DownloadState::Done | DownloadState::Cancelled => return None,
        };
        Some((state, slot.error.clone()))
    }

    pub fn snapshot(&self, id: Uuid) -> Option<ModelProgress> {
        let slot = self.lock();
        if slot.download_id != Some(id) {
            return None;
        }
        Some(ModelProgress {
            download_id: id.to_string(),
            model_id: slot.model_id.clone().unwrap_or_default(),
            done_bytes: slot.done_bytes,
            total_bytes: slot.total_bytes,
            state: slot.state,
            error: slot.error.clone(),
        })
    }

    pub fn is_active(&self, model_id: &str) -> bool {
        let slot = self.lock();
        slot.model_id.as_deref() == Some(model_id)
            && matches!(
                slot.state,
                DownloadState::Queued | DownloadState::Downloading | DownloadState::Verifying
            )
    }
}
