//! Summary orchestration: budget gate, backend selection, per-window timeout,
//! global deadline and extractive degradation.
//!
//! LLM failures never escape except cancellation; every window that cannot be
//! summarized falls back to keyword extraction and the caller gets the flags it
//! needs for the visible degradation banner.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::asr::Segment;
use super::budget::{llm_fits, llm_need_mb};
use super::cards::{
    extract_window, window_timeout, windows, CardGenerator, CardWindow, GenerateError,
};
use super::lang::Lang;
use super::llm::{LlmClient, LlmError, RemoteLlm, RemoteLlmConfig};
use super::llm_local::{LocalLlm, LocalLlmSpec};
use super::models::find;
use super::reduce::reduce_cards;
use super::runtime::Accel;
use super::validate::validate_cards;
use crate::error::{AppError, AppErrorCode};

pub const SUMMARY_DEADLINE: Duration = Duration::from_secs(20 * 60);
pub const REMOTE_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_CONSECUTIVE_PARSE_FAILURES: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmMode {
    Local,
    Remote,
}

#[derive(Debug, Clone)]
pub struct RemoteLlmSpec {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SummarizePlan {
    pub mode: LlmMode,
    pub local_model: Option<String>,
    pub local_path: Option<PathBuf>,
    pub local_ready: bool,
    pub remote: Option<RemoteLlmSpec>,
    pub available_memory_mb: u64,
    pub threads: u16,
    pub accel: Accel,
}

pub trait LlmFactory {
    fn remote(&self, spec: &RemoteLlmSpec) -> Result<Box<dyn LlmClient>, LlmError>;
    fn local(
        &self,
        spec: &LocalLlmSpec,
        threads: u16,
        accel: Accel,
    ) -> Result<Box<dyn LlmClient>, LlmError>;
}

pub struct DefaultLlmFactory;

impl LlmFactory for DefaultLlmFactory {
    fn remote(&self, spec: &RemoteLlmSpec) -> Result<Box<dyn LlmClient>, LlmError> {
        Ok(Box::new(RemoteLlm::new(&RemoteLlmConfig::new(
            &spec.base_url,
            &spec.model,
            spec.api_key.clone(),
        ))?))
    }

    fn local(
        &self,
        spec: &LocalLlmSpec,
        threads: u16,
        accel: Accel,
    ) -> Result<Box<dyn LlmClient>, LlmError> {
        Ok(Box::new(LocalLlm::open(spec, threads, accel)?))
    }
}

#[derive(Debug)]
pub struct SummarizeOutcome {
    pub cards: Vec<super::cards::Card>,
    pub windows: usize,
    pub llm_windows: usize,
    pub extractive_windows: usize,
    pub unverified: u32,
    pub llm_model_missing: bool,
    pub llm_unconfigured: bool,
    pub llm_budget_exceeded: bool,
    pub llm_load_failed: bool,
    pub deadline_exceeded: bool,
    pub last_error: Option<LlmError>,
}

impl SummarizeOutcome {
    fn extractive(windows: usize) -> Self {
        Self {
            cards: Vec::new(),
            windows,
            llm_windows: 0,
            extractive_windows: windows,
            unverified: 0,
            llm_model_missing: false,
            llm_unconfigured: false,
            llm_budget_exceeded: false,
            llm_load_failed: false,
            deadline_exceeded: false,
            last_error: None,
        }
    }
}

enum Availability {
    Ready {
        client: Box<dyn LlmClient>,
        timeout: Duration,
    },
    Disabled,
}

/// Summarize a finished transcript. Cancellation is the only hard error.
pub fn summarize(
    segments: &[Segment],
    lang: Lang,
    plan: &SummarizePlan,
    factory: &dyn LlmFactory,
    cancel: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<SummarizeOutcome, AppError> {
    let windows = windows(segments);
    let mut outcome = SummarizeOutcome::extractive(windows.len());
    outcome.extractive_windows = 0;
    if windows.is_empty() {
        return Ok(outcome);
    }
    let deadline = deadline.unwrap_or_else(|| Instant::now() + SUMMARY_DEADLINE);

    if cancel.is_cancelled() {
        return Err(AppError::new(AppErrorCode::Cancelled, "summary cancelled"));
    }

    let mut availability = match open_client(plan, factory, &mut outcome) {
        Some(availability) => availability,
        None => {
            extract_all(&windows, segments, lang, &mut outcome);
            outcome.extractive_windows = windows.len();
            finish(&mut outcome, lang, segments);
            return Ok(outcome);
        }
    };

    if Instant::now() >= deadline {
        outcome.deadline_exceeded = true;
        extract_all(&windows, segments, lang, &mut outcome);
        outcome.extractive_windows = windows.len();
        finish(&mut outcome, lang, segments);
        return Ok(outcome);
    }

    let mut consecutive_parse_failures = 0u32;
    for window in &windows {
        if cancel.is_cancelled() {
            return Err(AppError::new(AppErrorCode::Cancelled, "summary cancelled"));
        }
        if Instant::now() >= deadline {
            outcome.deadline_exceeded = true;
            push_extractive(window, segments, lang, &mut outcome);
            continue;
        }

        let Availability::Ready { client, timeout } = &mut availability else {
            push_extractive(window, segments, lang, &mut outcome);
            continue;
        };
        let window_deadline = deadline.min(Instant::now() + *timeout);
        let generator = CardGenerator::new(client.as_ref());
        match generator.generate_window(window, segments, lang, cancel, Some(window_deadline)) {
            Ok(cards) => {
                outcome.cards.extend(cards);
                outcome.llm_windows += 1;
                consecutive_parse_failures = 0;
            }
            Err(GenerateError::Cancelled) => {
                return Err(AppError::new(AppErrorCode::Cancelled, "summary cancelled"));
            }
            Err(GenerateError::Timeout) => {
                tracing::warn!(start_ms = window.start_ms, "summary window timed out");
                push_extractive(window, segments, lang, &mut outcome);
                consecutive_parse_failures = 0;
            }
            Err(GenerateError::Parse(error)) => {
                tracing::warn!(%error, start_ms = window.start_ms, "card parse failed");
                outcome.last_error = Some(LlmError::new(
                    super::llm::LlmErrorCode::Protocol,
                    error.clone(),
                ));
                push_extractive(window, segments, lang, &mut outcome);
                consecutive_parse_failures += 1;
                if consecutive_parse_failures >= MAX_CONSECUTIVE_PARSE_FAILURES {
                    tracing::warn!("two consecutive parse failures, extracting the rest");
                    availability = Availability::Disabled;
                }
            }
            Err(GenerateError::Llm(error)) => {
                tracing::warn!(%error, start_ms = window.start_ms, "llm failed");
                outcome.last_error = Some(error);
                push_extractive(window, segments, lang, &mut outcome);
                availability = Availability::Disabled;
            }
        }
    }

    finish(&mut outcome, lang, segments);
    Ok(outcome)
}

fn open_client(
    plan: &SummarizePlan,
    factory: &dyn LlmFactory,
    outcome: &mut SummarizeOutcome,
) -> Option<Availability> {
    match plan.mode {
        LlmMode::Local => {
            let Some(id) = plan.local_model.as_deref().filter(|id| !id.is_empty()) else {
                outcome.llm_model_missing = true;
                return None;
            };
            let Some(pack) = find(id) else {
                outcome.llm_model_missing = true;
                return None;
            };
            let Some(path) = plan.local_path.clone() else {
                outcome.llm_model_missing = true;
                return None;
            };
            if !plan.local_ready {
                outcome.llm_model_missing = true;
                return None;
            }
            if !llm_fits(llm_need_mb(pack), plan.available_memory_mb) {
                outcome.llm_budget_exceeded = true;
                return None;
            }
            let spec = LocalLlmSpec::new(id, path);
            match factory.local(&spec, plan.threads, plan.accel) {
                Ok(client) => Some(Availability::Ready {
                    client,
                    timeout: window_timeout(id),
                }),
                Err(error) => {
                    tracing::warn!(%error, "local llm load failed");
                    outcome.llm_load_failed = true;
                    outcome.last_error = Some(error);
                    None
                }
            }
        }
        LlmMode::Remote => {
            let Some(remote) = plan.remote.as_ref() else {
                outcome.llm_unconfigured = true;
                return None;
            };
            if remote.base_url.trim().is_empty() || remote.model.trim().is_empty() {
                outcome.llm_unconfigured = true;
                return None;
            }
            match factory.remote(remote) {
                Ok(client) => Some(Availability::Ready {
                    client,
                    timeout: REMOTE_TIMEOUT,
                }),
                Err(error) => {
                    tracing::warn!(%error, "remote llm setup failed");
                    outcome.llm_load_failed = true;
                    outcome.last_error = Some(error);
                    None
                }
            }
        }
    }
}

fn push_extractive(
    window: &CardWindow,
    segments: &[Segment],
    lang: Lang,
    outcome: &mut SummarizeOutcome,
) {
    outcome.cards.extend(extract_window(window, segments, lang));
    outcome.extractive_windows += 1;
}

fn extract_all(
    windows: &[CardWindow],
    segments: &[Segment],
    lang: Lang,
    outcome: &mut SummarizeOutcome,
) {
    for window in windows {
        outcome.cards.extend(extract_window(window, segments, lang));
    }
}

fn finish(outcome: &mut SummarizeOutcome, lang: Lang, segments: &[Segment]) {
    outcome.cards = reduce_cards(std::mem::take(&mut outcome.cards), lang);
    let stats = validate_cards(&mut outcome.cards, segments);
    outcome.unverified = stats.unverified;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::asr::SegmentStatus;

    fn segment(start: u64, end: u64, text: &str) -> Segment {
        Segment {
            start_ms: start,
            end_ms: end,
            text: text.into(),
            tokens: Vec::new(),
            avg_prob: None,
            prob_source: crate::services::meeting::asr::ProbSource::None,
            low_confidence: false,
            speaker: None,
            status: SegmentStatus::Ok,
        }
    }

    fn plan(mode: LlmMode) -> SummarizePlan {
        SummarizePlan {
            mode,
            local_model: Some("qwen3-1.7b-instruct-q4km".into()),
            local_path: Some("/tmp/model.gguf".into()),
            local_ready: true,
            remote: None,
            available_memory_mb: 8192,
            threads: 4,
            accel: Accel::Cpu,
        }
    }

    #[test]
    fn remote_without_configuration_is_unconfigured() {
        let mut outcome = SummarizeOutcome::extractive(0);
        assert!(open_client(&plan(LlmMode::Remote), &DefaultLlmFactory, &mut outcome).is_none());
        assert!(outcome.llm_unconfigured);
    }

    #[test]
    fn missing_local_model_is_missing() {
        let mut outcome = SummarizeOutcome::extractive(0);
        let mut local = plan(LlmMode::Local);
        local.local_path = None;
        assert!(open_client(&local, &DefaultLlmFactory, &mut outcome).is_none());
        assert!(outcome.llm_model_missing);
    }

    #[test]
    fn budget_is_checked_before_loading() {
        let mut outcome = SummarizeOutcome::extractive(0);
        let mut local = plan(LlmMode::Local);
        local.available_memory_mb = 1024;
        assert!(open_client(&local, &DefaultLlmFactory, &mut outcome).is_none());
        assert!(outcome.llm_budget_exceeded);
    }

    #[test]
    fn extractive_fallback_always_produces_cards() {
        let segments = vec![
            segment(0, 1000, "我们决定明天发布"),
            segment(1000, 2000, "风险可能延期"),
        ];
        let mut outcome = SummarizeOutcome::extractive(1);
        let windows = windows(&segments);
        extract_all(&windows, &segments, Lang::Zh, &mut outcome);
        finish(&mut outcome, Lang::Zh, &segments);
        assert!(!outcome.cards.is_empty());
        assert!(outcome.cards.iter().all(|card| card.verified));
    }
}
