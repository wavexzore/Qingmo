//! Meeting configuration: the only persisted source of truth.
//!
//! Writes are patches guarded by `expectedRevision`; invalid fields never hit
//! disk. Schema 0 is migrated to schema 1, invalid/empty references fall back to
//! deterministic derivations and key history is capped at sixteen.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppErrorCode};
use crate::services::meeting::asr_route::AsrMode;
use crate::services::meeting::llm::normalize_base_url;
use crate::services::meeting::models::{ModelCatalog, ModelKind};
use crate::services::meeting::remote_asr::RemoteProvider;
use crate::services::meeting::summarize::LlmMode;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_KEY_REFS: usize = 16;
pub const MAX_MODEL_NAME: usize = 128;
pub const DEFAULT_MAX_MINUTES: u16 = 180;
pub const MIN_MAX_MINUTES: u16 = 5;
pub const MAX_MAX_MINUTES: u16 = 600;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMode {
    #[default]
    Auto,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub mode: RuntimeMode,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            mode: RuntimeMode::Auto,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrConfig {
    pub mode: AsrMode,
    pub local_model: Option<String>,
    pub provider: RemoteProvider,
    pub model: String,
    pub api_key_ref: String,
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            mode: AsrMode::Local,
            local_model: None,
            provider: RemoteProvider::OpenAi,
            model: String::new(),
            api_key_ref: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub mode: LlmMode,
    pub local_model: Option<String>,
    pub base_url: String,
    pub model: String,
    pub api_key_ref: String,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            mode: LlmMode::Local,
            local_model: None,
            base_url: String::new(),
            model: String::new(),
            api_key_ref: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingConfig {
    pub runtime: RuntimeConfig,
    pub asr: AsrConfig,
    pub llm: LlmConfig,
    pub keep_transcript: bool,
    pub max_minutes: u16,
    #[serde(default)]
    pub key_refs: Vec<String>,
}

impl Default for MeetingConfig {
    fn default() -> Self {
        Self {
            runtime: RuntimeConfig::default(),
            asr: AsrConfig::default(),
            llm: LlmConfig::default(),
            keep_transcript: true,
            max_minutes: DEFAULT_MAX_MINUTES,
            key_refs: Vec::new(),
        }
    }
}

impl MeetingConfig {
    pub fn asr_key_ref(&self) -> String {
        if !self.asr.api_key_ref.is_empty() {
            return self.asr.api_key_ref.clone();
        }
        format!("asr.{}", provider_slug(self.asr.provider))
    }

    pub fn llm_key_ref(&self) -> String {
        if !self.llm.api_key_ref.is_empty() {
            return self.llm.api_key_ref.clone();
        }
        if self.llm.base_url.is_empty() {
            "llm.default".to_owned()
        } else {
            format!("llm.{}", sha8(&self.llm.base_url))
        }
    }
}

fn provider_slug(provider: RemoteProvider) -> &'static str {
    match provider {
        RemoteProvider::OpenAi => "openai",
        RemoteProvider::Groq => "groq",
        RemoteProvider::Deepgram => "deepgram",
    }
}

fn sha8(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `^[a-z0-9][a-z0-9._-]{0,63}$`
pub fn valid_slug(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    if value.len() > 64 {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

#[derive(Debug, Clone, Default)]
pub struct MeetingConfigPatch {
    pub runtime_mode: Option<RuntimeMode>,
    pub asr_mode: Option<AsrMode>,
    pub asr_local_model: Option<String>,
    pub asr_provider: Option<RemoteProvider>,
    pub asr_model: Option<String>,
    pub asr_api_key_ref: Option<String>,
    pub llm_mode: Option<LlmMode>,
    pub llm_local_model: Option<String>,
    pub llm_base_url: Option<String>,
    pub llm_model: Option<String>,
    pub llm_api_key_ref: Option<String>,
    pub keep_transcript: Option<bool>,
    pub max_minutes: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct MeetingConfigSnapshot {
    pub config: MeetingConfig,
    pub revision: u64,
    pub schema_version: u32,
}

struct State {
    config: MeetingConfig,
    revision: u64,
}

pub struct MeetingConfigStore {
    path: Option<PathBuf>,
    state: Mutex<State>,
    catalog: Arc<dyn ModelCatalog>,
}

impl MeetingConfigStore {
    /// Load or migrate `config.json`; a corrupt file falls back to defaults and
    /// is replaced on the next successful write.
    pub fn open(
        path: impl Into<PathBuf>,
        catalog: Arc<dyn ModelCatalog>,
    ) -> Result<Self, AppError> {
        let path = path.into();
        let mut changed = false;
        let mut revision = 0u64;
        let config = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<RawFile>(&bytes) {
                Ok(raw) => {
                    revision = raw.revision.unwrap_or(0);
                    changed = raw.schema_version.unwrap_or(0) < SCHEMA_VERSION;
                    let (config, normalized) = normalize_raw(raw, catalog.as_ref());
                    changed |= normalized;
                    config
                }
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "meeting config is corrupt; using defaults");
                    changed = true;
                    MeetingConfig::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => MeetingConfig::default(),
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "meeting config is unreadable; using defaults");
                changed = true;
                MeetingConfig::default()
            }
        };
        let store = Self {
            path: Some(path),
            state: Mutex::new(State { config, revision }),
            catalog,
        };
        if changed {
            if let Err(error) = store.persist_current() {
                tracing::warn!(%error, "meeting config migration could not be written");
            }
        }
        Ok(store)
    }

    /// Non-persistent store for tests and disabled storage.
    pub fn in_memory(catalog: Arc<dyn ModelCatalog>) -> Self {
        Self {
            path: None,
            state: Mutex::new(State {
                config: MeetingConfig::default(),
                revision: 0,
            }),
            catalog,
        }
    }

    pub fn disabled(catalog: Arc<dyn ModelCatalog>) -> Self {
        Self::in_memory(catalog)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("meeting config poisoned")
    }

    pub fn get(&self) -> MeetingConfigSnapshot {
        let state = self.lock();
        MeetingConfigSnapshot {
            config: state.config.clone(),
            revision: state.revision,
            schema_version: SCHEMA_VERSION,
        }
    }

    pub fn revision(&self) -> u64 {
        self.lock().revision
    }

    /// Apply a patch atomically. The provider is applied first so a provider
    /// change clears the old remote model before the same patch can set a new
    /// one.
    pub fn set(&self, patch: MeetingConfigPatch, expected_revision: u64) -> Result<u64, AppError> {
        let mut state = self.lock();
        if expected_revision != state.revision {
            return Err(
                AppError::new(AppErrorCode::Conflict, "meeting config revision changed")
                    .with_details(serde_json::json!({
                        "reason": "config_revision",
                        "current": state.revision,
                    })),
            );
        }

        let mut candidate = state.config.clone();
        if let Some(provider) = patch.asr_provider {
            if provider != candidate.asr.provider {
                candidate.asr.model.clear();
            }
            candidate.asr.provider = provider;
        }
        if let Some(mode) = patch.runtime_mode {
            candidate.runtime.mode = mode;
        }
        if let Some(mode) = patch.asr_mode {
            candidate.asr.mode = mode;
        }
        if let Some(model) = patch.asr_local_model {
            candidate.asr.local_model = normalize_local_model(model);
        }
        if let Some(model) = patch.asr_model {
            candidate.asr.model = normalize_model_name(model);
        }
        if let Some(reference) = patch.asr_api_key_ref {
            candidate.asr.api_key_ref = reference.trim().to_owned();
        }
        if let Some(mode) = patch.llm_mode {
            candidate.llm.mode = mode;
        }
        if let Some(model) = patch.llm_local_model {
            candidate.llm.local_model = normalize_local_model(model);
        }
        if let Some(base_url) = patch.llm_base_url {
            candidate.llm.base_url = normalize_base_url_field(base_url.trim())?;
        }
        if let Some(model) = patch.llm_model {
            candidate.llm.model = normalize_model_name(model);
        }
        if let Some(reference) = patch.llm_api_key_ref {
            candidate.llm.api_key_ref = reference.trim().to_owned();
        }
        if let Some(keep) = patch.keep_transcript {
            candidate.keep_transcript = keep;
        }
        if let Some(max_minutes) = patch.max_minutes {
            candidate.max_minutes = max_minutes;
        }

        validate(&candidate, self.catalog.as_ref())?;
        derive_key_refs(&mut candidate);
        let revision = state.revision.saturating_add(1);
        let stored = StoredFile::from_config(&candidate, revision);
        self.persist(&stored)?;
        state.config = candidate;
        state.revision = revision;
        Ok(revision)
    }

    /// Clears an explicit local model that was just removed.
    ///
    /// Returns the (possibly bumped) revision. A `null` update only happens
    /// when the removed id is the current explicit value.
    pub fn clear_local_model(&self, id: &str) -> Result<u64, AppError> {
        let mut state = self.lock();
        let mut candidate = state.config.clone();
        let mut changed = false;
        if candidate.asr.local_model.as_deref() == Some(id) {
            candidate.asr.local_model = None;
            changed = true;
        }
        if candidate.llm.local_model.as_deref() == Some(id) {
            candidate.llm.local_model = None;
            changed = true;
        }
        if !changed {
            return Ok(state.revision);
        }
        let revision = state.revision.saturating_add(1);
        let stored = StoredFile::from_config(&candidate, revision);
        self.persist(&stored)?;
        state.config = candidate;
        state.revision = revision;
        Ok(revision)
    }

    /// Remember a key reference for `clear(all=true)`; oldest entries fall out.
    pub fn note_key_ref(&self, reference: &str) -> Result<u64, AppError> {
        if !valid_slug(reference) {
            return Err(AppError::new(
                AppErrorCode::InvalidConfig,
                "invalid apiKeyRef",
            ));
        }
        let mut state = self.lock();
        let mut candidate = state.config.clone();
        if !candidate.key_refs.iter().any(|item| item == reference) {
            candidate.key_refs.push(reference.to_owned());
            while candidate.key_refs.len() > MAX_KEY_REFS {
                candidate.key_refs.remove(0);
            }
        }
        derive_key_refs(&mut candidate);
        let revision = state.revision.saturating_add(1);
        let stored = StoredFile::from_config(&candidate, revision);
        self.persist(&stored)?;
        state.config = candidate;
        state.revision = revision;
        Ok(revision)
    }

    fn persist_current(&self) -> Result<(), AppError> {
        let mut state = self.lock();
        let revision = state.revision.saturating_add(1);
        let stored = StoredFile::from_config(&state.config, revision);
        self.persist(&stored)?;
        state.revision = revision;
        Ok(())
    }

    fn persist(&self, stored: &StoredFile) -> Result<(), AppError> {
        let Some(path) = self.path.as_ref() else {
            return Err(AppError::new(
                AppErrorCode::Io,
                "meeting config storage is unavailable",
            ));
        };
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|error| AppError::from_io(&error))?;
        let bytes = serde_json::to_vec_pretty(stored)
            .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
        let tmp = parent.join("config.json.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|error| AppError::from_io(&error))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| AppError::from_io(&error))?;
        drop(file);
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path).map_err(|error| AppError::from_io(&error))?;
        }
        fs::rename(&tmp, path).map_err(|error| AppError::from_io(&error))
    }
}

fn normalize_local_model(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn normalize_model_name(value: String) -> String {
    value.trim().chars().take(MAX_MODEL_NAME).collect()
}

fn normalize_base_url_field(value: &str) -> Result<String, AppError> {
    if value.is_empty() {
        return Ok(String::new());
    }
    normalize_base_url(value)
        .map(|url| url.to_string())
        .map_err(|error| AppError::new(AppErrorCode::InvalidConfig, error.message))
}

fn validate(config: &MeetingConfig, catalog: &dyn ModelCatalog) -> Result<(), AppError> {
    if let Some(id) = config.asr.local_model.as_deref() {
        match catalog.pack(id) {
            Some(pack) if pack.kind == ModelKind::Asr => {}
            _ => {
                return Err(invalid(
                    "asr.localModel must be an ASR model",
                    "local_model",
                ))
            }
        }
    }
    if let Some(id) = config.llm.local_model.as_deref() {
        match catalog.pack(id) {
            Some(pack) if pack.kind == ModelKind::Llm => {}
            _ => {
                return Err(invalid(
                    "llm.localModel must be an LLM model",
                    "local_model",
                ))
            }
        }
    }
    if !config.asr.api_key_ref.is_empty() && !valid_slug(&config.asr.api_key_ref) {
        return Err(invalid("invalid asr.apiKeyRef", "api_key_ref"));
    }
    if !config.llm.api_key_ref.is_empty() && !valid_slug(&config.llm.api_key_ref) {
        return Err(invalid("invalid llm.apiKeyRef", "api_key_ref"));
    }
    if !config.llm.base_url.is_empty() {
        normalize_base_url(&config.llm.base_url)
            .map_err(|error| invalid(&error.message, "base_url"))?;
    }
    if config.asr.model.chars().count() > MAX_MODEL_NAME
        || config.llm.model.chars().count() > MAX_MODEL_NAME
    {
        return Err(invalid("remote model name is too long", "model"));
    }
    if !(MIN_MAX_MINUTES..=MAX_MAX_MINUTES).contains(&config.max_minutes) {
        return Err(invalid("maxMinutes must be 5..=600", "max_minutes"));
    }
    Ok(())
}

fn invalid(message: &str, field: &str) -> AppError {
    AppError::new(AppErrorCode::InvalidConfig, message)
        .with_details(serde_json::json!({ "field": field }))
}

fn derive_key_refs(config: &mut MeetingConfig) {
    for reference in [config.asr_key_ref(), config.llm_key_ref()] {
        if !config.key_refs.iter().any(|item| item == &reference) {
            config.key_refs.push(reference);
        }
    }
    while config.key_refs.len() > MAX_KEY_REFS {
        config.key_refs.remove(0);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    schema_version: u32,
    revision: u64,
    meeting: MeetingBody,
    key_refs: Vec<String>,
}

impl StoredFile {
    fn from_config(config: &MeetingConfig, revision: u64) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            revision,
            meeting: MeetingBody {
                runtime: config.runtime.clone(),
                asr: config.asr.clone(),
                llm: config.llm.clone(),
                keep_transcript: config.keep_transcript,
                max_minutes: config.max_minutes,
            },
            key_refs: config.key_refs.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingBody {
    runtime: RuntimeConfig,
    asr: AsrConfig,
    llm: LlmConfig,
    keep_transcript: bool,
    max_minutes: u16,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawFile {
    schema_version: Option<u32>,
    revision: Option<u64>,
    meeting: Option<RawMeeting>,
    key_refs: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawMeeting {
    runtime: Option<RawRuntime>,
    asr: Option<RawAsr>,
    llm: Option<RawLlm>,
    keep_transcript: Option<bool>,
    max_minutes: Option<u16>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawRuntime {
    mode: Option<RuntimeMode>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawAsr {
    mode: Option<AsrMode>,
    local_model: Option<Option<String>>,
    provider: Option<RemoteProvider>,
    model: Option<String>,
    api_key_ref: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawLlm {
    mode: Option<LlmMode>,
    local_model: Option<Option<String>>,
    base_url: Option<String>,
    model: Option<String>,
    api_key_ref: Option<String>,
}

fn normalize_raw(raw: RawFile, catalog: &dyn ModelCatalog) -> (MeetingConfig, bool) {
    let mut changed = false;
    let mut config = MeetingConfig::default();
    if let Some(meeting) = raw.meeting {
        if let Some(runtime) = meeting.runtime {
            if let Some(mode) = runtime.mode {
                config.runtime.mode = mode;
            }
        }
        if let Some(asr) = meeting.asr {
            if let Some(mode) = asr.mode {
                config.asr.mode = mode;
            }
            if let Some(provider) = asr.provider {
                config.asr.provider = provider;
            }
            config.asr.local_model =
                sanitize_local(asr.local_model, ModelKind::Asr, catalog, &mut changed);
            config.asr.model = normalize_model_name(asr.model.unwrap_or_default());
            if let Some(reference) = asr.api_key_ref {
                let reference = reference.trim().to_owned();
                if reference.is_empty() || valid_slug(&reference) {
                    config.asr.api_key_ref = reference;
                } else {
                    changed = true;
                }
            }
        }
        if let Some(llm) = meeting.llm {
            if let Some(mode) = llm.mode {
                config.llm.mode = mode;
            }
            config.llm.local_model =
                sanitize_local(llm.local_model, ModelKind::Llm, catalog, &mut changed);
            let base_url = llm.base_url.unwrap_or_default();
            match normalize_base_url_field(&base_url) {
                Ok(normalized) => {
                    if normalized != base_url {
                        changed = true;
                    }
                    config.llm.base_url = normalized;
                }
                Err(_) => changed = true,
            }
            config.llm.model = normalize_model_name(llm.model.unwrap_or_default());
            if let Some(reference) = llm.api_key_ref {
                let reference = reference.trim().to_owned();
                if reference.is_empty() || valid_slug(&reference) {
                    config.llm.api_key_ref = reference;
                } else {
                    changed = true;
                }
            }
        }
        if let Some(keep) = meeting.keep_transcript {
            config.keep_transcript = keep;
        }
        if let Some(max_minutes) = meeting.max_minutes {
            if (MIN_MAX_MINUTES..=MAX_MAX_MINUTES).contains(&max_minutes) {
                config.max_minutes = max_minutes;
            } else {
                changed = true;
            }
        }
    }
    let mut refs = Vec::new();
    for reference in raw.key_refs {
        if valid_slug(&reference) && !refs.iter().any(|item| item == &reference) {
            refs.push(reference);
        } else {
            changed = true;
        }
    }
    config.key_refs = refs;
    derive_key_refs(&mut config);
    (config, changed)
}

fn sanitize_local(
    value: Option<Option<String>>,
    kind: ModelKind,
    catalog: &dyn ModelCatalog,
    changed: &mut bool,
) -> Option<String> {
    match value {
        Some(Some(id)) => {
            let id = id.trim();
            if id.is_empty() {
                *changed = true;
                None
            } else if catalog.pack(id).is_some_and(|pack| pack.kind == kind) {
                Some(id.to_owned())
            } else {
                *changed = true;
                None
            }
        }
        Some(None) => None,
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rules() {
        assert!(valid_slug("asr.openai"));
        assert!(valid_slug("llm.3fa91c2e"));
        assert!(!valid_slug("Asr.openai"));
        assert!(!valid_slug(".hidden"));
        assert!(!valid_slug(&"a".repeat(65)));
    }

    #[test]
    fn derived_refs_are_deterministic() {
        let mut config = MeetingConfig::default();
        assert_eq!(config.asr_key_ref(), "asr.openai");
        assert_eq!(config.llm_key_ref(), "llm.default");
        config.llm.base_url = "https://example.test/v1/chat/completions".into();
        assert_eq!(
            config.llm_key_ref(),
            format!("llm.{}", sha8(&config.llm.base_url))
        );
    }

    #[test]
    fn key_refs_cap_at_sixteen() {
        let mut config = MeetingConfig::default();
        for index in 0..20 {
            config.key_refs.push(format!("llm.k{index}"));
        }
        derive_key_refs(&mut config);
        assert_eq!(config.key_refs.len(), MAX_KEY_REFS);
        assert!(config.key_refs.contains(&"asr.openai".to_owned()));
    }
}
