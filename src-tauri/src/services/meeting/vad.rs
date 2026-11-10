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
    pub start: usize,
    pub end: usize,
}

impl SpeechSegment {
    pub fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
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

fn fixed_grid(total: usize) -> Vec<SpeechSegment> {
    let mut segments = Vec::new();
    let mut start = 0;
    while start < total {
        let end = (start + MAX_SEGMENT_SAMPLES).min(total);
        segments.push(SpeechSegment { start, end });
        start = end;
    }
    segments
}

fn normalize(samples_len: usize, mut segments: Vec<SpeechSegment>) -> Vec<SpeechSegment> {
    let mut out = Vec::with_capacity(segments.len());
    for segment in segments.drain(..) {
        let start = segment.start.saturating_sub(PADDING_SAMPLES);
        let end = (segment.end + PADDING_SAMPLES).min(samples_len);
        if end <= start {
            continue;
        }
        let mut cursor = start;
        while cursor < end {
            let chunk_end = (cursor + MAX_SEGMENT_SAMPLES).min(end);
            if chunk_end.saturating_sub(cursor) >= MIN_SPEECH_SAMPLES {
                out.push(SpeechSegment {
                    start: cursor,
                    end: chunk_end,
                });
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
            .map(|previous: &SpeechSegment| previous.end)
            .unwrap_or(0)
            .max(segment.start);
        if segment.end.saturating_sub(start) >= MIN_SPEECH_SAMPLES {
            deduped.push(SpeechSegment {
                start,
                end: segment.end,
            });
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
    cancel: &CancellationToken,
) -> Segmentation {
    if samples.is_empty() {
        return Segmentation::default();
    }

    let Some(detector) = model.and_then(build_detector) else {
        if model.is_some() {
            warn!("VAD model could not be loaded; using fixed 30 s segmentation");
        }
        return Segmentation {
            segments: fixed_grid(samples.len()),
            degraded: true,
        };
    };

    let mut raw = Vec::new();
    for chunk in samples.chunks(FEED_CHUNK) {
        if cancel.is_cancelled() {
            break;
        }
        detector.accept_waveform(chunk);
        while let Some(segment) = detector.front() {
            let start = segment.start().max(0) as usize;
            raw.push(SpeechSegment {
                start,
                end: start + segment.n().max(0) as usize,
            });
            detector.pop();
        }
    }

    detector.flush();
    while let Some(segment) = detector.front() {
        let start = segment.start().max(0) as usize;
        raw.push(SpeechSegment {
            start,
            end: start + segment.n().max(0) as usize,
        });
        detector.pop();
    }

    Segmentation {
        segments: normalize(samples.len(), raw),
        degraded: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_grid_covers_every_sample_without_empty_segments() {
        let segments = fixed_grid(TARGET_SAMPLE_RATE as usize * 65);
        assert_eq!(segments.len(), 3);
        assert!(segments.iter().all(|segment| !segment.is_empty()));
        assert!(segments
            .iter()
            .all(|segment| segment.len() <= MAX_SEGMENT_SAMPLES));
        assert_eq!(segments.first().unwrap().start, 0);
        assert_eq!(
            segments.last().unwrap().end,
            TARGET_SAMPLE_RATE as usize * 65
        );
    }

    #[test]
    fn normalize_pads_and_splits() {
        let segments = normalize(
            MAX_SEGMENT_SAMPLES * 2,
            vec![SpeechSegment {
                start: 0,
                end: MAX_SEGMENT_SAMPLES * 2,
            }],
        );
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start, 0);
        assert_eq!(segments[1].end, MAX_SEGMENT_SAMPLES * 2);
    }

    #[test]
    fn normalize_merges_overlapping_padding() {
        let segments = normalize(
            10_000,
            vec![
                SpeechSegment {
                    start: 1_000,
                    end: 4_000,
                },
                SpeechSegment {
                    start: 4_100,
                    end: 8_000,
                },
            ],
        );
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start, 0);
        assert_eq!(segments[0].end, 7_200);
    }

    #[test]
    fn normalize_clips_and_drops_short_tails() {
        let segments = normalize(
            10_000,
            vec![
                SpeechSegment { start: 0, end: 1 },
                SpeechSegment {
                    start: 9_900,
                    end: 10_000,
                },
            ],
        );
        assert!(segments.is_empty());
    }
}
