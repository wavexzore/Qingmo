//! Local ASR engine over the vendored `sherpa-onnx` crate.
//!
//! The recognizer only sees the samples of one speech segment. Every time in
//! [`RawAsr`] is relative to that slice; [`Segment::from_raw`] adds the segment
//! origin exactly once and clamps tokens to the segment.

use std::path::Path;

use sherpa_onnx::{
    OfflineFireRedAsrCtcModelConfig, OfflineParaformerModelConfig, OfflineRecognizer,
    OfflineRecognizerConfig, OfflineRecognizerResult, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig,
};
use tokio_util::sync::CancellationToken;

use super::lang::is_cjk;
use super::models::{find, AsrFamily, FileRole, ModelPack};
use crate::error::{AppError, AppErrorCode};

pub const LOW_CONF_PROB: f32 = 0.35;
pub const REPEAT_LIMIT: f32 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentStatus {
    Ok,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbSource {
    Token,
    Provider,
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub t_ms: u64,
    pub prob: Option<f32>,
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub tokens: Vec<Token>,
    pub avg_prob: Option<f32>,
    pub prob_source: ProbSource,
    pub low_confidence: bool,
    pub speaker: Option<u8>,
    pub status: SegmentStatus,
}

impl Segment {
    pub fn failed(start_ms: u64, end_ms: u64) -> Self {
        Self {
            start_ms,
            end_ms,
            text: String::new(),
            tokens: Vec::new(),
            avg_prob: None,
            prob_source: ProbSource::None,
            low_confidence: false,
            speaker: None,
            status: SegmentStatus::Failed,
        }
    }

    /// Map a slice-relative [`RawAsr`] onto absolute, clamped times.
    pub fn from_raw(raw: RawAsr, seg_start: u64, seg_end: u64) -> Self {
        let start = (seg_start + raw.start_ms).min(seg_end.saturating_sub(1));
        let end = seg_end
            .max(start + 1)
            .min((seg_start + raw.end_ms).max(start + 1));

        let mut probs = Vec::with_capacity(raw.tokens.len());
        let tokens = raw
            .tokens
            .into_iter()
            .map(|(t_ms, prob)| {
                probs.push(prob);
                Token {
                    t_ms: (seg_start + t_ms).clamp(start, end),
                    prob,
                }
            })
            .collect::<Vec<_>>();

        let has_token_probs =
            tokens.len() == probs.len() && !probs.is_empty() && probs.iter().all(Option::is_some);
        let avg_prob = if has_token_probs {
            let mean = probs.iter().flatten().copied().sum::<f32>() / probs.len() as f32;
            mean.is_finite().then_some(mean)
        } else {
            None
        };
        let prob_source = if avg_prob.is_some() {
            ProbSource::Token
        } else {
            ProbSource::None
        };

        Self {
            start_ms: start,
            end_ms: end,
            text: raw.text.trim().to_owned(),
            tokens,
            avg_prob,
            prob_source,
            low_confidence: avg_prob.is_some_and(|prob| prob < LOW_CONF_PROB),
            speaker: None,
            status: SegmentStatus::Ok,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawAsr {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub tokens: Vec<(u64, Option<f32>)>,
}

pub trait AsrEngine: Send {
    fn recognize(
        &mut self,
        samples: &[f32],
        start_ms: u64,
        end_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<RawAsr, AppError>;

    /// One retry with a higher blank penalty after a repeated segment.
    /// Engines that cannot change their decoding return `None`.
    fn recognize_biased(
        &mut self,
        _samples: &[f32],
        _start_ms: u64,
        _end_ms: u64,
        _cancel: &CancellationToken,
    ) -> Result<Option<RawAsr>, AppError> {
        Ok(None)
    }
}

pub struct SherpaAsr {
    recognizer: Option<OfflineRecognizer>,
    pack: &'static ModelPack,
    dir: std::path::PathBuf,
    threads: i32,
    blank_penalty: f32,
}

impl SherpaAsr {
    pub fn open(pack_id: &str, dir: &Path, threads: u16) -> Result<Self, AppError> {
        let pack = find(pack_id)
            .ok_or_else(|| AppError::new(AppErrorCode::ModelNotReady, "unknown model id"))?;
        let family = pack.family.ok_or_else(|| {
            AppError::new(AppErrorCode::AsrUnavailable, "model is not an ASR pack")
        })?;
        let threads = i32::from(threads.max(1));
        let config = build_config(pack, dir, family, threads, 0.0)?;
        let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
            AppError::new(
                AppErrorCode::AsrUnavailable,
                "OfflineRecognizer::create returned null",
            )
        })?;
        Ok(Self {
            recognizer: Some(recognizer),
            pack,
            dir: dir.to_path_buf(),
            threads,
            blank_penalty: 0.0,
        })
    }

    /// Rebuild with a higher blank penalty for one repeat-detected segment.
    pub fn with_blank_penalty(&self, blank_penalty: f32) -> Result<Self, AppError> {
        let family = self.pack.family.ok_or_else(|| {
            AppError::new(AppErrorCode::AsrUnavailable, "model is not an ASR pack")
        })?;
        let config = build_config(self.pack, &self.dir, family, self.threads, blank_penalty)?;
        let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
            AppError::new(
                AppErrorCode::AsrUnavailable,
                "OfflineRecognizer::create returned null",
            )
        })?;
        Ok(Self {
            recognizer: Some(recognizer),
            pack: self.pack,
            dir: self.dir.clone(),
            threads: self.threads,
            blank_penalty,
        })
    }

    fn install(&mut self, blank_penalty: f32) -> bool {
        match self.with_blank_penalty(blank_penalty) {
            Ok(mut engine) => {
                self.recognizer = engine.recognizer.take();
                true
            }
            Err(_) => false,
        }
    }
}

impl AsrEngine for SherpaAsr {
    fn recognize(
        &mut self,
        samples: &[f32],
        start_ms: u64,
        end_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<RawAsr, AppError> {
        if cancel.is_cancelled() {
            return Err(AppError::new(AppErrorCode::Cancelled, "asr cancelled"));
        }
        if samples.is_empty() {
            return Ok(RawAsr {
                start_ms: 0,
                end_ms: 1,
                text: String::new(),
                tokens: Vec::new(),
            });
        }
        let Some(recognizer) = self.recognizer.as_ref() else {
            return Err(AppError::new(
                AppErrorCode::AsrUnavailable,
                "ASR recognizer is not loaded",
            ));
        };
        let stream = recognizer.create_stream();
        stream.accept_waveform(super::TARGET_SAMPLE_RATE as i32, samples);
        recognizer.decode(&stream);
        let result = stream
            .get_result()
            .ok_or_else(|| AppError::new(AppErrorCode::AsrFailed, "ASR returned no result"))?;
        if cancel.is_cancelled() {
            return Err(AppError::new(AppErrorCode::Cancelled, "asr cancelled"));
        }
        Ok(parse_result(&result, start_ms, end_ms))
    }

    fn recognize_biased(
        &mut self,
        samples: &[f32],
        start_ms: u64,
        end_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<RawAsr>, AppError> {
        let normal = self.blank_penalty;
        // Drop the normal recognizer before allocating the biased one so a
        // retry never doubles the model's resident memory.
        self.recognizer = None;
        if !self.install(normal + 0.5) {
            let _ = self.install(normal);
            return Ok(None);
        }
        let retried = self.recognize(samples, start_ms, end_ms, cancel);
        self.recognizer = None;
        if !self.install(normal) {
            tracing::warn!("failed to restore the normal ASR blank penalty");
        }
        match retried {
            Ok(raw) => Ok(Some(raw)),
            Err(error) if error.code == AppErrorCode::Cancelled => Err(error),
            Err(_) => Ok(None),
        }
    }
}

fn build_config(
    pack: &ModelPack,
    dir: &Path,
    family: AsrFamily,
    threads: i32,
    blank_penalty: f32,
) -> Result<OfflineRecognizerConfig, AppError> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.tokens = Some(file(pack, dir, FileRole::Tokens)?);
    config.model_config.num_threads = threads;
    config.model_config.debug = false;
    config.model_config.provider = Some("cpu".into());
    config.decoding_method = Some("greedy_search".into());
    config.max_active_paths = 4;
    config.blank_penalty = blank_penalty;

    match family {
        AsrFamily::Paraformer => {
            config.model_config.model_type = Some("paraformer".into());
            config.model_config.paraformer = OfflineParaformerModelConfig {
                model: Some(file(pack, dir, FileRole::Model)?),
            };
        }
        AsrFamily::ZipformerTransducer => {
            config.model_config.model_type = Some("transducer".into());
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(file(pack, dir, FileRole::Encoder)?),
                decoder: Some(file(pack, dir, FileRole::Decoder)?),
                joiner: Some(file(pack, dir, FileRole::Joiner)?),
            };
        }
        AsrFamily::SenseVoice => {
            config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                model: Some(file(pack, dir, FileRole::Model)?),
                language: Some("auto".into()),
                use_itn: true,
            };
        }
        AsrFamily::FireRedCtc => {
            config.model_config.fire_red_asr_ctc = OfflineFireRedAsrCtcModelConfig {
                model: Some(file(pack, dir, FileRole::Model)?),
            };
        }
    }
    Ok(config)
}

fn file(pack: &ModelPack, dir: &Path, role: FileRole) -> Result<String, AppError> {
    let entry = pack
        .files
        .iter()
        .find(|file| file.role == role)
        .ok_or_else(|| {
            AppError::new(
                AppErrorCode::ModelNotReady,
                format!("{} has no {:?} file", pack.id, role),
            )
        })?;
    let path = dir.join(entry.name);
    if !path.is_file() {
        return Err(AppError::new(
            AppErrorCode::ModelNotReady,
            format!("missing {}", path.display()),
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn parse_result(result: &OfflineRecognizerResult, _start_ms: u64, _end_ms: u64) -> RawAsr {
    let first = result
        .timestamps
        .as_ref()
        .and_then(|times| times.first())
        .copied()
        .unwrap_or(0.0)
        .max(0.0);
    let last = result
        .timestamps
        .as_ref()
        .and_then(|times| times.last())
        .copied()
        .unwrap_or(first)
        .max(first);
    let start_ms = (first * 1000.0) as u64;
    let end_ms = ((last * 1000.0) as u64).max(start_ms + 1);

    let tokens = result
        .timestamps
        .as_ref()
        .map(|times| {
            times
                .iter()
                .enumerate()
                .map(|(index, time)| {
                    let t_ms = (*time * 1000.0).max(0.0) as u64;
                    let prob = result
                        .ys_log_probs
                        .get(index)
                        .map(|logprob| logprob.exp())
                        .filter(|prob| prob.is_finite())
                        .map(|prob| prob.clamp(0.0, 1.0));
                    (t_ms, prob)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    RawAsr {
        start_ms,
        end_ms,
        text: result.text.clone(),
        tokens,
    }
}

/// 5-gram repeat share over words and CJK characters; `0.0` for short text.
pub fn repeat_ratio(text: &str) -> f32 {
    let units = repeat_units(text);
    if units.len() < 6 {
        return 0.0;
    }
    let mut seen = std::collections::HashSet::with_capacity(units.len());
    let total = units.len() - 4;
    let repeated = units.windows(5).filter(|gram| !seen.insert(*gram)).count();
    repeated as f32 / total as f32
}

/// Split into Latin word runs and single CJK characters so that languages
/// without spaces still produce enough n-grams to detect a decoding loop.
fn repeat_units(text: &str) -> Vec<&str> {
    let mut units = Vec::new();
    let mut word_start = None;
    for (index, ch) in text.char_indices() {
        if ch.is_ascii_alphanumeric() {
            word_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = word_start.take() {
            units.push(&text[start..index]);
        }
        if is_cjk(ch) {
            units.push(&text[index..index + ch.len_utf8()]);
        }
    }
    if let Some(start) = word_start {
        units.push(&text[start..]);
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str, start: u64, end: u64, tokens: Vec<(u64, Option<f32>)>) -> RawAsr {
        RawAsr {
            start_ms: start,
            end_ms: end,
            text: text.into(),
            tokens,
        }
    }

    #[test]
    fn absolute_times_add_the_origin_once() {
        let segment = Segment::from_raw(
            raw(
                "hello",
                120_000,
                121_500,
                vec![(120_000, Some(0.9)), (121_200, Some(0.8))],
            ),
            600_000,
            750_000,
        );
        assert_eq!(segment.start_ms, 720_000);
        assert_eq!(segment.end_ms, 721_500);
        assert_eq!(segment.tokens[0].t_ms, 720_000);
        assert_eq!(segment.tokens[1].t_ms, 721_200);
        assert_eq!(segment.avg_prob, Some(0.85));
        assert_eq!(segment.prob_source, ProbSource::Token);
        assert!(!segment.low_confidence);
    }

    #[test]
    fn raw_end_past_segment_is_clamped() {
        let segment = Segment::from_raw(raw("x", 0, 99_000, vec![(98_000, Some(0.5))]), 1000, 2000);
        assert_eq!(segment.start_ms, 1000);
        assert_eq!(segment.end_ms, 2000);
        assert_eq!(segment.tokens[0].t_ms, 2000);
    }

    #[test]
    fn missing_end_time_becomes_one_ms() {
        let segment = Segment::from_raw(raw("x", 500, 500, vec![]), 0, 1000);
        assert_eq!(segment.start_ms, 500);
        assert_eq!(segment.end_ms, 501);
    }

    #[test]
    fn missing_or_nan_probability_surfaces_none() {
        let segment = Segment::from_raw(raw("x", 0, 10, vec![(0, Some(0.5)), (5, None)]), 0, 1000);
        assert_eq!(segment.avg_prob, None);
        assert_eq!(segment.prob_source, ProbSource::None);
        assert!(!segment.low_confidence);
    }

    #[test]
    fn low_probability_marks_the_segment() {
        let segment = Segment::from_raw(raw("x", 0, 10, vec![(0, Some(0.2))]), 0, 1000);
        assert!(segment.low_confidence);
    }

    #[test]
    fn repeat_ratio_detects_loops() {
        assert_eq!(repeat_ratio("a b c"), 0.0);
        assert_eq!(repeat_ratio("你好世界"), 0.0);
        let looped = "w1 w2 w3 w4 w5 w1 w2 w3 w4 w5 w1 w2 w3 w4 w5 w1 w2 w3 w4 w5";
        assert!(repeat_ratio(looped) > REPEAT_LIMIT);
        let prose = "a b c d e f g h i j k l m n o p";
        assert!(repeat_ratio(prose) < REPEAT_LIMIT);
    }

    #[test]
    fn repeat_ratio_handles_chinese_without_spaces() {
        let looped = "我们今天开会我们今天开会我们今天开会我们今天开会";
        assert!(
            repeat_ratio(looped) > REPEAT_LIMIT,
            "looped Chinese text must be detected: {}",
            repeat_ratio(looped)
        );
        let prose = "今天的会议主要讨论发布计划和风险";
        assert!(
            repeat_ratio(prose) < REPEAT_LIMIT,
            "ordinary Chinese prose must not trigger a retry: {}",
            repeat_ratio(prose)
        );
        let mixed = "我们用 Redis 缓存 session 然后下周 review";
        assert!(repeat_ratio(mixed) < REPEAT_LIMIT);
    }
}
