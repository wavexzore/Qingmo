//! Remote ASR adapters for the three BYOK providers.
//!
//! One decoded window is split into 300 s chunks with 2 s overlap, encoded as
//! 16 kHz mono PCM16 WAV, uploaded sequentially and stitched back into absolute
//! segments. Any final chunk failure aborts the whole remote attempt so the
//! caller can fall back to local exactly once.

use std::io::Read;
use std::time::{Duration, Instant};

use reqwest::blocking::multipart::{Form, Part};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::asr::{ProbSource, Segment, SegmentStatus};
use super::runtime::ReasonCode;
use super::speaker::{SpeakerStitcher, Word, OVERLAP_MS};
use super::TARGET_SAMPLE_RATE;
use crate::error::{AppError, AppErrorCode};

pub const CHUNK_MS: u64 = 300_000;
pub const STEP_MS: u64 = CHUNK_MS - OVERLAP_MS;
pub const DOWNGRADE_MS: u64 = 120_000;
pub const DOWNGRADE_STEP_MS: u64 = DOWNGRADE_MS - OVERLAP_MS;
pub const MAX_CHUNK_BYTES: usize = 23 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const CHUNK_TIMEOUT: Duration = Duration::from_secs(120);
pub const ATTEMPTS: u8 = 3;

pub const DEFAULT_OPENAI_MODEL: &str = "whisper-1";
pub const DEFAULT_GROQ_MODEL: &str = "whisper-large-v3-turbo";
pub const DEFAULT_DEEPGRAM_MODEL: &str = "nova-3";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteProvider {
    OpenAi,
    Groq,
    Deepgram,
}

impl RemoteProvider {
    pub fn default_model(self) -> &'static str {
        match self {
            Self::OpenAi => DEFAULT_OPENAI_MODEL,
            Self::Groq => DEFAULT_GROQ_MODEL,
            Self::Deepgram => DEFAULT_DEEPGRAM_MODEL,
        }
    }
}

/// Production endpoints; tests override the base.
pub fn endpoint(provider: RemoteProvider) -> Url {
    let raw = match provider {
        RemoteProvider::OpenAi => "https://api.openai.com/v1/audio/transcriptions",
        RemoteProvider::Groq => "https://api.groq.com/openai/v1/audio/transcriptions",
        RemoteProvider::Deepgram => "https://api.deepgram.com/v1/listen",
    };
    Url::parse(raw).expect("static provider endpoint")
}

#[derive(Debug, Clone)]
pub struct RemoteAsrConfig {
    pub provider: RemoteProvider,
    pub model: String,
    pub key: String,
    pub base: Url,
    pub connect_timeout: Duration,
    pub chunk_timeout: Duration,
    pub retry_delay: Duration,
}

impl RemoteAsrConfig {
    pub fn new(provider: RemoteProvider, model: impl Into<String>, key: impl Into<String>) -> Self {
        let model = model.into();
        Self {
            provider,
            model: if model.trim().is_empty() {
                provider.default_model().to_owned()
            } else {
                model
            },
            key: key.into(),
            base: endpoint(provider),
            connect_timeout: CONNECT_TIMEOUT,
            chunk_timeout: CHUNK_TIMEOUT,
            retry_delay: Duration::from_millis(250),
        }
    }

    pub fn with_base(mut self, base: Url) -> Self {
        self.base = base;
        self
    }
}

pub trait RemoteAsr: Send {
    fn transcribe_window(
        &mut self,
        window_start_ms: u64,
        samples: &[f32],
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Vec<Segment>, AppError>;
}

/// Verify an endpoint still follows the https/private-http policy.
fn check_endpoint(url: &Url) -> Result<(), AppError> {
    super::llm::normalize_base_url(url.as_str())
        .map(|_| ())
        .map_err(|error| AppError::new(AppErrorCode::InvalidConfig, error.message))
}

struct ChunkError {
    error: AppError,
    too_large: bool,
}

fn fail(code: AppErrorCode, reason: Option<ReasonCode>, message: impl Into<String>) -> AppError {
    let error = AppError::new(code, message);
    match reason {
        Some(reason) => error.with_details(json!({ "reason": reason })),
        None => error,
    }
}

fn chunk_fail(
    code: AppErrorCode,
    reason: Option<ReasonCode>,
    too_large: bool,
    message: impl Into<String>,
) -> ChunkError {
    ChunkError {
        error: fail(code, reason, message),
        too_large,
    }
}

fn is_retryable(error: &AppError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details["reason"].as_str())
        .is_some_and(|reason| reason == "remote_quota")
        || error
            .message
            .strip_prefix("remote http ")
            .and_then(|code| code.parse::<u16>().ok())
            .is_some_and(|code| (500..=599).contains(&code))
}

pub struct HttpRemoteAsr {
    config: RemoteAsrConfig,
    client: Client,
    stitcher: SpeakerStitcher,
    previous_tail: Vec<Word>,
    started: bool,
    window_words: Vec<Word>,
}

impl HttpRemoteAsr {
    pub fn new(config: RemoteAsrConfig) -> Result<Self, AppError> {
        check_endpoint(&config.base)?;
        let client = Client::builder()
            .connect_timeout(config.connect_timeout)
            .timeout(config.chunk_timeout)
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() > 2 {
                    attempt.stop()
                } else if super::llm::normalize_base_url(attempt.url().as_str()).is_ok() {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|error| AppError::new(AppErrorCode::AsrFailed, error.to_string()))?;
        Ok(Self {
            config,
            client,
            stitcher: SpeakerStitcher::new(),
            previous_tail: Vec::new(),
            started: false,
            window_words: Vec::new(),
        })
    }

    pub fn provider(&self) -> RemoteProvider {
        self.config.provider
    }

    #[allow(clippy::too_many_arguments)]
    fn upload_range(
        &mut self,
        start: usize,
        end: usize,
        samples: &[f32],
        window_start_ms: u64,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
        allow_split: bool,
    ) -> Result<(), AppError> {
        if cancel.is_cancelled() {
            return Err(fail(AppErrorCode::Cancelled, None, "cancelled"));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(fail(
                AppErrorCode::AsrFailed,
                None,
                "remote deadline reached",
            ));
        }
        let wav = encode_wav(&samples[start..end]);
        let duration_ms = (end - start) as u64 * 1000 / u64::from(TARGET_SAMPLE_RATE);
        if wav.len() > MAX_CHUNK_BYTES && allow_split && duration_ms > DOWNGRADE_MS {
            return self.upload_split(start, end, samples, window_start_ms, cancel, deadline);
        }
        let chunk_start_ms =
            window_start_ms + (start as u64 * 1000 / u64::from(TARGET_SAMPLE_RATE));
        match self.fetch_with_retry(&wav, chunk_start_ms, cancel) {
            Ok(words) => {
                self.emit_words(words, chunk_start_ms, end, window_start_ms);
                Ok(())
            }
            Err(error) if error.too_large && allow_split && duration_ms > DOWNGRADE_MS => {
                self.upload_split(start, end, samples, window_start_ms, cancel, deadline)
            }
            Err(error) => Err(error.error),
        }
    }

    fn upload_split(
        &mut self,
        start: usize,
        end: usize,
        samples: &[f32],
        window_start_ms: u64,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<(), AppError> {
        let step = ms_to_samples(DOWNGRADE_STEP_MS).max(1);
        let size = ms_to_samples(DOWNGRADE_MS).max(1);
        let mut cursor = start;
        while cursor < end {
            let stop = (cursor + size).min(end);
            self.upload_range(
                cursor,
                stop,
                samples,
                window_start_ms,
                cancel,
                deadline,
                false,
            )?;
            if stop == end {
                break;
            }
            cursor += step;
        }
        Ok(())
    }

    fn emit_words(
        &mut self,
        mut words: Vec<Word>,
        chunk_start_ms: u64,
        end: usize,
        window_start_ms: u64,
    ) {
        let first = !self.started;
        self.stitcher
            .stitch(&self.previous_tail, &mut words, chunk_start_ms);
        if !first {
            words.retain(|word| word.start_ms >= chunk_start_ms + OVERLAP_MS);
        }
        self.started = true;
        let chunk_end_ms = window_start_ms + (end as u64 * 1000 / u64::from(TARGET_SAMPLE_RATE));
        let tail_start = chunk_end_ms.saturating_sub(OVERLAP_MS);
        self.previous_tail = words
            .iter()
            .filter(|word| word.start_ms >= tail_start)
            .cloned()
            .collect();
        self.window_words.extend(words);
    }

    fn fetch_with_retry(
        &self,
        wav: &[u8],
        offset_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<Word>, ChunkError> {
        let mut last = None;
        for attempt in 0..ATTEMPTS {
            if cancel.is_cancelled() {
                return Err(chunk_fail(
                    AppErrorCode::Cancelled,
                    None,
                    false,
                    "cancelled",
                ));
            }
            match self.fetch_once(wav, offset_ms) {
                Ok(words) => return Ok(words),
                Err(error) => {
                    let retryable = !error.too_large && is_retryable(&error.error);
                    last = Some(error);
                    if !retryable || attempt + 1 == ATTEMPTS {
                        break;
                    }
                    if !self.config.retry_delay.is_zero() {
                        std::thread::sleep(self.config.retry_delay * u32::from(attempt + 1));
                    }
                }
            }
        }
        Err(last.unwrap_or_else(|| {
            chunk_fail(AppErrorCode::AsrFailed, None, false, "remote ASR failed")
        }))
    }

    fn fetch_once(&self, wav: &[u8], offset_ms: u64) -> Result<Vec<Word>, ChunkError> {
        let response = match self.config.provider {
            RemoteProvider::OpenAi | RemoteProvider::Groq => {
                let opening = self.config.model.starts_with("whisper");
                let mut form = Form::new().text("model", self.config.model.clone()).part(
                    "file",
                    Part::bytes(wav.to_vec())
                        .file_name("audio.wav")
                        .mime_str("audio/wav")
                        .map_err(|error| ChunkError {
                            error: fail(AppErrorCode::AsrFailed, None, error.to_string()),
                            too_large: false,
                        })?,
                );
                if opening {
                    form = form
                        .text("response_format", "verbose_json")
                        .text("timestamp_granularities[]", "word");
                } else {
                    form = form.text("response_format", "json");
                }
                let mut builder = self
                    .client
                    .post(self.config.base.clone())
                    .bearer_auth(&self.config.key)
                    .multipart(form);
                builder = self.apply_token(builder);
                builder.send()
            }
            RemoteProvider::Deepgram => {
                let mut url = self.config.base.clone();
                url.query_pairs_mut()
                    .append_pair("model", &self.config.model)
                    .append_pair("smart_format", "true")
                    .append_pair("punctuate", "true")
                    .append_pair("diarize", "true");
                self.client
                    .post(url)
                    .header("Authorization", format!("Token {}", self.config.key))
                    .header("Content-Type", "audio/wav")
                    .body(wav.to_vec())
                    .send()
            }
        }
        .map_err(|error| {
            if error.is_timeout() {
                chunk_fail(AppErrorCode::AsrFailed, None, false, "remote timeout")
            } else {
                chunk_fail(AppErrorCode::AsrFailed, None, false, error.to_string())
            }
        })?;

        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => chunk_fail(
                    AppErrorCode::AsrFailed,
                    Some(ReasonCode::RemoteAuth),
                    false,
                    "remote authentication failed",
                ),
                413 => chunk_fail(
                    AppErrorCode::AsrFailed,
                    Some(ReasonCode::RemoteQuota),
                    true,
                    "remote chunk too large",
                ),
                429 => chunk_fail(
                    AppErrorCode::AsrFailed,
                    Some(ReasonCode::RemoteQuota),
                    false,
                    "remote rate limited",
                ),
                code => chunk_fail(
                    AppErrorCode::AsrFailed,
                    None,
                    false,
                    format!("remote http {code}"),
                ),
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(chunk_fail(
                AppErrorCode::AsrFailed,
                Some(ReasonCode::RemoteResponseTooLarge),
                false,
                "response exceeds 8 MiB",
            ));
        }
        let mut body = Vec::new();
        response
            .take(MAX_RESPONSE_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|error| chunk_fail(AppErrorCode::AsrFailed, None, false, error.to_string()))?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(chunk_fail(
                AppErrorCode::AsrFailed,
                Some(ReasonCode::RemoteResponseTooLarge),
                false,
                "response exceeds 8 MiB",
            ));
        }
        match self.config.provider {
            RemoteProvider::OpenAi | RemoteProvider::Groq => parse_openai(&body, offset_ms),
            RemoteProvider::Deepgram => parse_deepgram(&body, offset_ms),
        }
        .map_err(|message| chunk_fail(AppErrorCode::AsrFailed, None, false, message))
    }

    fn apply_token(
        &self,
        builder: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        builder
    }
}
impl RemoteAsr for HttpRemoteAsr {
    fn transcribe_window(
        &mut self,
        window_start_ms: u64,
        samples: &[f32],
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Vec<Segment>, AppError> {
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        self.window_words = Vec::new();
        let chunk_samples = ms_to_samples(CHUNK_MS);
        let step_samples = ms_to_samples(STEP_MS);
        let mut start = 0usize;
        while start < samples.len() {
            if cancel.is_cancelled() {
                return Err(fail(AppErrorCode::Cancelled, None, "cancelled"));
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(fail(
                    AppErrorCode::AsrFailed,
                    None,
                    "remote deadline reached",
                ));
            }
            let end = (start + chunk_samples).min(samples.len());
            self.upload_range(start, end, samples, window_start_ms, cancel, deadline, true)?;
            if end == samples.len() {
                break;
            }
            start += step_samples;
        }
        let words = std::mem::take(&mut self.window_words);
        Ok(words_to_segments(words, window_start_ms))
    }
}

fn ms_to_samples(ms: u64) -> usize {
    (ms.saturating_mul(u64::from(TARGET_SAMPLE_RATE)) / 1000) as usize
}

/// 44-byte PCM16 mono WAV; 300 s at 16 kHz is about 9.6 MB.
fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_bytes = samples.len() * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32_767.0) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[derive(Deserialize, Default)]
struct OpenAiResponse {
    #[serde(default)]
    text: String,
    #[serde(default)]
    words: Vec<OpenAiWord>,
    #[serde(default)]
    segments: Vec<OpenAiSegment>,
}

#[derive(Deserialize)]
struct OpenAiWord {
    #[serde(default)]
    word: String,
    start: f64,
    end: f64,
    #[serde(default)]
    confidence: Option<f32>,
}

#[derive(Deserialize)]
struct OpenAiSegment {
    #[serde(default)]
    text: String,
    start: f64,
    end: f64,
    #[serde(default)]
    avg_logprob: Option<f32>,
    #[serde(default)]
    no_speech_prob: Option<f32>,
}

#[derive(Deserialize)]
struct DeepgramResponse {
    results: DeepgramResults,
}

#[derive(Deserialize)]
struct DeepgramResults {
    channels: Vec<DeepgramChannel>,
}

#[derive(Deserialize)]
struct DeepgramChannel {
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Deserialize)]
struct DeepgramAlternative {
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Deserialize)]
struct DeepgramWord {
    #[serde(default)]
    word: String,
    start: f64,
    end: f64,
    #[serde(default)]
    confidence: Option<f32>,
    #[serde(default)]
    speaker: Option<u8>,
}

fn seconds(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        (value * 1000.0) as u64
    } else {
        0
    }
}

fn clamp_word(mut word: Word, offset_ms: u64) -> Word {
    word.start_ms = offset_ms.saturating_add(word.start_ms);
    word.end_ms = offset_ms
        .saturating_add(word.end_ms)
        .max(word.start_ms.saturating_add(1));
    word
}

fn parse_openai(body: &[u8], offset_ms: u64) -> Result<Vec<Word>, String> {
    let parsed: OpenAiResponse =
        serde_json::from_slice(body).map_err(|error| format!("invalid JSON: {error}"))?;
    let mut words = Vec::new();
    for word in parsed.words {
        let text = word.word.trim();
        if text.is_empty() {
            continue;
        }
        words.push(clamp_word(
            Word {
                start_ms: seconds(word.start),
                end_ms: seconds(word.end).max(seconds(word.start) + 1),
                text: text.to_owned(),
                prob: word
                    .confidence
                    .filter(|prob| prob.is_finite())
                    .map(|prob| prob.clamp(0.0, 1.0)),
                speaker: None,
            },
            offset_ms,
        ));
    }
    if words.is_empty() {
        for segment in parsed.segments {
            if segment.text.trim().is_empty()
                || segment.no_speech_prob.is_some_and(|prob| prob > 0.6)
            {
                continue;
            }
            let start = seconds(segment.start);
            words.push(clamp_word(
                Word {
                    start_ms: start,
                    end_ms: seconds(segment.end).max(start + 1),
                    text: segment.text.trim().to_owned(),
                    prob: segment
                        .avg_logprob
                        .filter(|prob| prob.is_finite())
                        .map(|prob| prob.exp().clamp(0.0, 1.0)),
                    speaker: None,
                },
                offset_ms,
            ));
        }
    }
    if words.is_empty() && !parsed.text.trim().is_empty() {
        let end = (body.len() as u64).max(1);
        words.push(clamp_word(
            Word {
                start_ms: 0,
                end_ms: end,
                text: parsed.text.trim().to_owned(),
                prob: Some(1.0),
                speaker: None,
            },
            offset_ms,
        ));
    }
    Ok(words)
}

fn parse_deepgram(body: &[u8], offset_ms: u64) -> Result<Vec<Word>, String> {
    let parsed: DeepgramResponse =
        serde_json::from_slice(body).map_err(|error| format!("invalid JSON: {error}"))?;
    let mut words = Vec::new();
    for alternative in parsed
        .results
        .channels
        .into_iter()
        .flat_map(|channel| channel.alternatives)
    {
        for word in alternative.words {
            let text = word.word.trim();
            if text.is_empty() {
                continue;
            }
            words.push(clamp_word(
                Word {
                    start_ms: seconds(word.start),
                    end_ms: seconds(word.end).max(seconds(word.start) + 1),
                    text: text.to_owned(),
                    prob: word
                        .confidence
                        .filter(|prob| prob.is_finite())
                        .map(|prob| prob.clamp(0.0, 1.0)),
                    speaker: word.speaker.map(|speaker| speaker.saturating_add(1)),
                },
                offset_ms,
            ));
        }
    }
    Ok(words)
}

fn ends_sentence(text: &str) -> bool {
    text.chars()
        .last()
        .is_some_and(|ch| matches!(ch, '.' | '?' | '!' | '。' | '？' | '！' | ';' | '；'))
}

fn words_to_segments(mut words: Vec<Word>, _window_start_ms: u64) -> Vec<Segment> {
    words.sort_by_key(|word| word.start_ms);
    let mut segments = Vec::new();
    let mut group: Vec<Word> = Vec::new();
    for word in words {
        let break_group = group.last().is_some_and(|previous| {
            word.start_ms.saturating_sub(previous.end_ms) > 800
                || ends_sentence(&previous.text)
                || word.start_ms.saturating_sub(group[0].start_ms) > 30_000
        });
        if break_group {
            if let Some(segment) = group_to_segment(std::mem::take(&mut group)) {
                segments.push(segment);
            }
        }
        group.push(word);
    }
    if let Some(segment) = group_to_segment(group) {
        segments.push(segment);
    }
    segments
}

fn group_to_segment(words: Vec<Word>) -> Option<Segment> {
    if words.is_empty() {
        return None;
    }
    let start_ms = words[0].start_ms;
    let end_ms = words
        .iter()
        .map(|word| word.end_ms)
        .max()
        .unwrap_or(start_ms + 1);
    let mut text = String::new();
    for word in &words {
        let needs_space = text
            .chars()
            .last()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && word
                .text
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric());
        if needs_space {
            text.push(' ');
        }
        text.push_str(&word.text);
    }
    let probabilities = words
        .iter()
        .map(|word| word.prob)
        .collect::<Vec<Option<f32>>>();
    let avg_prob = if !probabilities.is_empty() && probabilities.iter().all(Option::is_some) {
        let mean =
            probabilities.iter().flatten().copied().sum::<f32>() / probabilities.len() as f32;
        mean.is_finite().then_some(mean.clamp(0.0, 1.0))
    } else {
        None
    };
    let prob_source = if avg_prob.is_some() {
        ProbSource::Provider
    } else {
        ProbSource::None
    };
    let speaker = words
        .first()
        .and_then(|word| word.speaker)
        .filter(|speaker| words.iter().all(|word| word.speaker == Some(*speaker)));
    Some(Segment {
        start_ms,
        end_ms,
        text,
        tokens: words
            .iter()
            .map(|word| super::asr::Token {
                t_ms: word.start_ms,
                prob: word.prob,
            })
            .collect(),
        avg_prob,
        prob_source,
        low_confidence: avg_prob.is_some_and(|prob| prob < super::asr::LOW_CONF_PROB),
        speaker,
        status: SegmentStatus::Ok,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_mono_16k_pcm16() {
        let wav = encode_wav(&[0.0, 0.5, -0.5]);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            TARGET_SAMPLE_RATE
        );
        assert_eq!(wav.len(), 44 + 6);
    }

    #[test]
    fn deepgram_speakers_are_one_based() {
        let body = br#"{"results":{"channels":[{"alternatives":[{"words":[
            {"word":"hello","start":0.0,"end":0.5,"confidence":0.9,"speaker":0}
        ]}]}]}}"#;
        let words = parse_deepgram(body, 10_000).unwrap();
        assert_eq!(words[0].speaker, Some(1));
        assert_eq!(words[0].start_ms, 10_000);
    }

    #[test]
    fn no_timestamp_response_becomes_one_chunk_segment() {
        let words = parse_openai(br#"{"text":"hello world"}"#, 5000).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].prob, Some(1.0));
        let segments = words_to_segments(words, 0);
        assert_eq!(segments[0].prob_source, ProbSource::Provider);
    }

    #[test]
    fn words_group_by_gap_and_sentence_end() {
        let words = vec![
            Word {
                start_ms: 0,
                end_ms: 500,
                text: "hello".into(),
                prob: Some(0.9),
                speaker: Some(1),
            },
            Word {
                start_ms: 500,
                end_ms: 900,
                text: "world.".into(),
                prob: Some(0.9),
                speaker: Some(1),
            },
            Word {
                start_ms: 3000,
                end_ms: 3400,
                text: "next".into(),
                prob: None,
                speaker: None,
            },
        ];
        let segments = words_to_segments(words, 0);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "hello world.");
        assert_eq!(segments[0].speaker, Some(1));
        assert_eq!(segments[1].avg_prob, None);
    }
}
