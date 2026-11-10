//! Meeting API keys: the OS keyring with a session-memory fallback.
//!
//! Plaintext never enters `config.json`. When the platform keyring is
//! unavailable (locked store, headless session), keys stay in this process and
//! every status reports `KeyringUnavailable` so the settings page can warn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::KeyStatus;
use crate::state::meeting::MeetingConfig;

pub const SERVICE: &str = "qingmo.meeting";

/// Raw credential backend. Tests inject [`MemoryKeyStore`].
pub trait KeyStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, AppError>;
    fn set(&self, account: &str, value: &str) -> Result<(), AppError>;
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

pub struct SystemKeyStore;

fn keyring_error(error: keyring::Error) -> AppError {
    match error {
        keyring::Error::NoEntry => AppError::new(AppErrorCode::NotFound, "keyring entry is absent"),
        other => AppError::new(AppErrorCode::Io, format!("keyring failure: {other}"))
            .with_details(serde_json::json!({ "reason": "keyring_unavailable" })),
    }
}

impl KeyStore for SystemKeyStore {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keyring_error)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keyring_error(error)),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keyring_error)?;
        entry.set_password(value).map_err(keyring_error)
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keyring_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keyring_error(error)),
        }
    }
}

/// Always-available fallback for tests and headless runs.
#[derive(Default)]
pub struct MemoryKeyStore {
    entries: Mutex<HashMap<String, String>>,
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(account)
            .cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), AppError> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(account);
        Ok(())
    }
}

/// A backend that is always unavailable, exercising the memory fallback.
#[derive(Default)]
pub struct BrokenKeyStore;

impl KeyStore for BrokenKeyStore {
    fn get(&self, _account: &str) -> Result<Option<String>, AppError> {
        Err(AppError::new(AppErrorCode::Io, "keyring unavailable"))
    }
    fn set(&self, _account: &str, _value: &str) -> Result<(), AppError> {
        Err(AppError::new(AppErrorCode::Io, "keyring unavailable"))
    }
    fn delete(&self, _account: &str) -> Result<(), AppError> {
        Err(AppError::new(AppErrorCode::Io, "keyring unavailable"))
    }
}

pub struct KeyService {
    store: Arc<dyn KeyStore>,
    memory: Mutex<HashMap<String, String>>,
    unavailable: AtomicBool,
}

impl KeyService {
    pub fn new(store: Arc<dyn KeyStore>) -> Self {
        Self {
            store,
            memory: Mutex::new(HashMap::new()),
            unavailable: AtomicBool::new(false),
        }
    }

    pub fn system() -> Self {
        Self::new(Arc::new(SystemKeyStore))
    }

    fn memory_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.memory
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn mark_unavailable(&self) {
        self.unavailable.store(true, Ordering::Relaxed);
    }

    pub fn status(&self, account: &str) -> KeyStatus {
        if self.unavailable.load(Ordering::Relaxed) {
            return KeyStatus::KeyringUnavailable;
        }
        match self.store.get(account) {
            Ok(Some(_)) => KeyStatus::Present,
            Ok(None) => KeyStatus::Absent,
            Err(error) => {
                self.mark_unavailable();
                tracing::warn!(%error, "keyring is unavailable");
                KeyStatus::KeyringUnavailable
            }
        }
    }

    /// Save a secret. A keyring failure keeps it in memory for this session
    /// and still reports success so the user is not blocked.
    pub fn set(&self, account: &str, value: &str) -> Result<(), AppError> {
        match self.store.set(account, value) {
            Ok(()) => {
                self.memory_lock().remove(account);
                Ok(())
            }
            Err(error) => {
                self.mark_unavailable();
                tracing::warn!(%error, "keyring unavailable; keeping the key in memory");
                self.memory_lock()
                    .insert(account.to_owned(), value.to_owned());
                Ok(())
            }
        }
    }

    /// Session + backend lookup. `None` when absent or unavailable.
    pub fn get(&self, account: &str) -> Option<String> {
        if let Some(value) = self.memory_lock().get(account).cloned() {
            return Some(value);
        }
        self.store.get(account).ok().flatten()
    }

    /// Best-effort delete; a missing entry is success.
    pub fn clear(&self, account: &str) {
        self.memory_lock().remove(account);
        if let Err(error) = self.store.delete(account) {
            self.mark_unavailable();
            tracing::warn!(%error, "failed to delete a keyring entry");
        }
    }
}

/// References removed by `meeting_key_clear`. `slot` is ignored for
/// `all=true`; the current explicit/derived refs and the whole history are
/// deduplicated.
pub fn clear_set(config: &MeetingConfig, slot: &str, all: bool) -> Result<Vec<String>, AppError> {
    let mut references = if all {
        let mut references = config.key_refs.clone();
        references.push(config.asr_key_ref());
        references.push(config.llm_key_ref());
        references
    } else {
        vec![match slot {
            "asr" => config.asr_key_ref(),
            "llm" => config.llm_key_ref(),
            _ => {
                return Err(AppError::new(
                    AppErrorCode::InvalidConfig,
                    format!("unknown key slot: {slot}"),
                )
                .with_details(serde_json::json!({ "field": "slot" })))
            }
        }]
    };
    references.dedup();
    let mut unique = Vec::with_capacity(references.len());
    for reference in references {
        if !unique.contains(&reference) {
            unique.push(reference);
        }
    }
    Ok(unique)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_backend_falls_back_to_memory_and_reports_unavailable() {
        let service = KeyService::new(Arc::new(BrokenKeyStore));
        assert_eq!(service.status("asr.openai"), KeyStatus::KeyringUnavailable);
        service.set("asr.openai", "sk-test").unwrap();
        assert_eq!(service.get("asr.openai").as_deref(), Some("sk-test"));
        assert_eq!(service.status("asr.openai"), KeyStatus::KeyringUnavailable);
        service.clear("asr.openai");
        assert!(service.get("asr.openai").is_none());
    }

    #[test]
    fn memory_backend_round_trips_and_reports_absent() {
        let service = KeyService::new(Arc::new(MemoryKeyStore::default()));
        assert_eq!(service.status("llm.default"), KeyStatus::Absent);
        service.set("llm.default", "sk").unwrap();
        assert_eq!(service.status("llm.default"), KeyStatus::Present);
        service.clear("llm.default");
        assert_eq!(service.status("llm.default"), KeyStatus::Absent);
    }
}

#[test]
fn clear_set_deduplicates_current_and_history() {
    let mut config = MeetingConfig::default();
    config.asr.api_key_ref = "asr.custom".into();
    config.llm.api_key_ref = "llm.custom".into();
    config.key_refs = vec!["asr.custom".into(), "llm.custom".into(), "llm.old".into()];
    assert_eq!(
        clear_set(&config, "", true).unwrap(),
        ["asr.custom", "llm.custom", "llm.old"]
    );
    assert_eq!(clear_set(&config, "asr", false).unwrap(), ["asr.custom"]);
    assert!(clear_set(&config, "other", false).is_err());
}
