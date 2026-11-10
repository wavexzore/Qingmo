//! Per-window allowlist for meeting audio playback.
//!
//! The asset protocol pattern is added only on a path's 0→1 transition and is
//! never removed in-process, so closing and reopening the same file still plays.
//! Release only drops the label reference; the pattern stays.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppErrorCode};

pub trait AssetAllow: Send + Sync {
    fn allow(&self, path: &Path) -> Result<(), AppError>;
}

pub struct TauriAssetAllow {
    app: AppHandle,
}

impl TauriAssetAllow {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AssetAllow for TauriAssetAllow {
    fn allow(&self, path: &Path) -> Result<(), AppError> {
        self.app
            .asset_protocol_scope()
            .allow_file(path)
            .map_err(|error| AppError::new(AppErrorCode::PermissionDenied, error.to_string()))
    }
}

#[derive(Debug, Clone)]
struct Entry {
    path: PathBuf,
    refs: u32,
}

#[derive(Default)]
struct ScopeState {
    labels: HashMap<String, Entry>,
}

pub struct AssetScope {
    state: Mutex<ScopeState>,
    allow: Box<dyn AssetAllow>,
}

impl AssetScope {
    pub fn new(app: AppHandle) -> Self {
        Self::with_allow(Box::new(TauriAssetAllow::new(app)))
    }

    pub fn with_allow(allow: Box<dyn AssetAllow>) -> Self {
        Self {
            state: Mutex::new(ScopeState::default()),
            allow,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ScopeState> {
        self.state.lock().expect("asset scope poisoned")
    }

    /// Register `label` for `path`. Returns true when the allow pattern was
    /// added on this call; a failed allow leaves no reference behind.
    pub fn acquire(&self, label: &str, path: &Path) -> Result<bool, AppError> {
        let mut state = self.lock();
        if let Some(entry) = state.labels.get_mut(label) {
            if entry.path == path {
                entry.refs = entry.refs.saturating_add(1);
                return Ok(false);
            }
            entry.path = path.to_owned();
            drop(state);
            self.allow.allow(path)?;
            return Ok(true);
        }
        self.allow.allow(path)?;
        state.labels.insert(
            label.to_owned(),
            Entry {
                path: path.to_owned(),
                refs: 1,
            },
        );
        Ok(true)
    }

    pub fn release_by_label(&self, label: &str) -> bool {
        let mut state = self.lock();
        let Some(entry) = state.labels.get_mut(label) else {
            return false;
        };
        if entry.refs > 1 {
            entry.refs -= 1;
            return true;
        }
        state.labels.remove(label);
        true
    }

    pub fn refs(&self, label: &str) -> Option<u32> {
        self.lock().labels.get(label).map(|entry| entry.refs)
    }

    pub fn path(&self, label: &str) -> Option<PathBuf> {
        self.lock()
            .labels
            .get(label)
            .map(|entry| entry.path.clone())
    }
}
