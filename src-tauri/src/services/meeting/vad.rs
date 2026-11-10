//! Voice-activity segmentation.
//!
//! The detector only sees one ten-minute decode window at a time. When the
//! Silero model is missing or cannot be created, segmentation degrades to a
//! fixed 30 s grid instead of failing the task.

use std::path::Path;

use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::services::meeting::TARGET_SAMPLE_RATE;

/// Longest segment handed to ASR.
pub const MAX_SEGMENT_MS: u64 = 30_000;
/// Context padding on both sides, clipped to the window.
pub const PADDING_MS: u64 = 200;
/// Shorter detections are treated as noise.
pub const MIN_SPEECH_MS: u64 = 250;

const MAX_SEGMENT_SAMPLES: usize = (TARGET_SAMPLE_RATE as u64 * MAX_SEGMENT_MS / 1000) as usize;
const PADDING_SAMPLES: usize = (TARGET_SAMPLE_RATE as u64 * PADDING_MS / 1000) as usize;
const MIN_SPEECH_SAMPLES: usize = (TARGET_SAMPLE_RATE as u64 * MIN_SPEECH_MS / 1000) as usize;
const FEED_CHUNK: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechSegment {
    /// Absolute milliseconds from the start of the source.
    pub start_ms: u64,
    /// Absolute milliseconds, clamped to the decode window.
    pub end_ms: u64,
}

impl SpeechSegment {
    pub fn len_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }

    pub fn is_empty(&self) -> bool {
        self.len_ms() == 0
    }
}

#[derive(Debug, Default)]
pub struct Segmentation {
    pub segments: Vec<SpeechSegment>,
    /// True when the fixed grid was used (model missing or creation failed).
    pub degraded: bool,
}

fn build_detector(model: &Path) -> Option<VoiceActivityDetector> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(model.to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.3,
            min_speech_duration: 0.25,
            window_size: 512,
            max_speech_duration: 30.0,
        },
        sample_rate: TARGET_SAMPLE_RATE as i32,
        num_threads: 1,
        ..VadModelConfig::default()
    };
    VoiceActivityDetector::create(&config, 60.0)
}

fn fixed_grid(total: usize) -> Vec<(usize, usize)> {
    let mut segments = Vec::new();
    let mut start = 0;
    while start < total {
        let end = (start + MAX_SEGMENT_SAMPLES).min(total);
        segments.push((start, end));
        start = end;
    }
    segments
}

fn normalize(samples_len: usize, mut segments: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(segments.len());
    for segment in segments.drain(..) {
        let start = segment.0.saturating_sub(PADDING_SAMPLES);
        let end = (segment.1 + PADDING_SAMPLES).min(samples_len);
        if end <= start {
            continue;
        }
        let mut cursor = start;
        while cursor < end {
            let chunk_end = (cursor + MAX_SEGMENT_SAMPLES).min(end);
            if chunk_end.saturating_sub(cursor) >= MIN_SPEECH_SAMPLES {
                out.push((cursor, chunk_end));
            }
            cursor = chunk_end;
        }
    }

    // Splitting can expose a later detection that started inside the previous
    // chunk; trim it so ASR never receives the same samples twice.
    let mut deduped = Vec::with_capacity(out.len());
    for segment in out {
        let start = deduped
            .last()
            .map(|previous: &(usize, usize)| previous.1)
            .unwrap_or(0)
            .max(segment.0);
        if segment.1.saturating_sub(start) >= MIN_SPEECH_SAMPLES {
            deduped.push((start, segment.1));
        }
    }
    deduped
}

/// Segment one decode window.
///
/// Cancellation is checked between feed chunks. A cancelled call returns the
/// segments collected so far, so callers can discard or keep them.
pub fn segment_window(
    samples: &[f32],
    model: Option<&Path>,
    window_start_ms: u64,
    cancel: &CancellationToken,
) -> Segmentation {
    if samples.is_empty() {
        return Segmentation::default();
    }

    let Some(detector) = model.and_then(build_detector) else {
        if model.is_some() {
            warn!("VAD model could not be loaded; using fixed 30 s segmentation");
        }
        return to_absolute(
            fixed_grid(samples.len()),
            samples.len(),
            window_start_ms,
            true,
        );
    };

    let mut raw = Vec::new();
    for chunk in samples.chunks(FEED_CHUNK) {
        if cancel.is_cancelled() {
            break;
        }
        detector.accept_waveform(chunk);
        while let Some(segment) = detector.front() {
            let start = segment.start().max(0) as usize;
            raw.push((start, start + segment.n().max(0) as usize));
            detector.pop();
        }
    }

    detector.flush();
    while let Some(segment) = detector.front() {
        let start = segment.start().max(0) as usize;
        raw.push((start, start + segment.n().max(0) as usize));
        detector.pop();
    }

    to_absolute(
        normalize(samples.len(), raw),
        samples.len(),
        window_start_ms,
        false,
    )
}

fn to_absolute(
    segments: Vec<(usize, usize)>,
    samples_len: usize,
    window_start_ms: u64,
    degraded: bool,
) -> Segmentation {
    let window_end_ms =
        window_start_ms + (samples_len as u64).saturating_mul(1000) / u64::from(TARGET_SAMPLE_RATE);
    let segments = segments
        .into_iter()
        .map(|(start, end)| SpeechSegment {
            start_ms: window_start_ms
                + (start as u64).saturating_mul(1000) / u64::from(TARGET_SAMPLE_RATE),
            end_ms: (window_start_ms
                + (end as u64).saturating_mul(1000) / u64::from(TARGET_SAMPLE_RATE))
            .min(window_end_ms),
        })
        .collect();
    Segmentation { segments, degraded }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_grid_covers_every_sample_without_empty_segments() {
        let segments = fixed_grid(TARGET_SAMPLE_RATE as usize * 65);
        assert_eq!(segments.len(), 3);
        assert!(segments.iter().all(|segment| segment.0 < segment.1));
        assert!(segments
            .iter()
            .all(|segment| (segment.1 - segment.0) <= MAX_SEGMENT_SAMPLES));
        assert_eq!(segments.first().unwrap().0, 0);
        assert_eq!(segments.last().unwrap().1, TARGET_SAMPLE_RATE as usize * 65);
    }

    #[test]
    fn normalize_pads_and_splits() {
        let segments = normalize(MAX_SEGMENT_SAMPLES * 2, vec![(0, MAX_SEGMENT_SAMPLES * 2)]);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].0, 0);
        assert_eq!(segments[1].1, MAX_SEGMENT_SAMPLES * 2);
    }

    #[test]
    fn normalize_merges_overlapping_padding() {
        let segments = normalize(10_000, vec![(1_000, 4_000), (4_100, 8_000)]);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].0, 0);
        assert_eq!(segments[0].1, 7_200);
    }

    #[test]
    fn fixed_grid_gets_the_window_origin() {
        let samples = vec![0.0; TARGET_SAMPLE_RATE as usize];
        let result = segment_window(&samples, None, 600_000, &CancellationToken::new());
        assert!(result.degraded);
        assert_eq!(result.segments[0].start_ms, 600_000);
        assert_eq!(result.segments[0].end_ms, 601_000);
        assert!(result
            .segments
            .iter()
            .all(|segment| segment.start_ms < segment.end_ms));
    }

    #[test]
    fn normalize_clips_and_drops_short_tails() {
        let segments = normalize(10_000, vec![(0, 1), (9_900, 10_000)]);
        assert!(segments.is_empty());
    }
}
