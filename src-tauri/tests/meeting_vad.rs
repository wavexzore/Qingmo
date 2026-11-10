//! VAD segmentation contract: speech is split to <= 30 s with padding, silence
//! yields nothing, and a missing model degrades to a fixed grid.

use std::path::{Path, PathBuf};

use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::vad::{segment_window, MAX_SEGMENT_MS, PADDING_MS};
use qingmo_lib::services::meeting::TARGET_SAMPLE_RATE;
use tokio_util::sync::CancellationToken;

const MAX_SEGMENT_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * MAX_SEGMENT_MS as usize / 1000;
const PADDING_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * PADDING_MS as usize / 1000;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/meeting")
        .join(name)
}

fn model() -> Option<PathBuf> {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("target/meeting-fixtures/silero_vad.onnx");
    path.is_file().then_some(path)
}

fn samples(name: &str) -> Vec<f32> {
    decode_windows(&fixture(name), CancellationToken::new())
        .expect("open fixture")
        .flat_map(|window| window.expect("decode"))
        .collect()
}

fn require_model() -> PathBuf {
    model()
        .unwrap_or_else(|| panic!("run scripts/dev/fetch-meeting-fixtures.sh before the VAD tests"))
}

#[test]
fn missing_model_degrades_to_fixed_grid() {
    let samples = samples("speech-gap-speech.wav");
    let result = segment_window(&samples, None, &CancellationToken::new());
    assert!(result.degraded);
    assert!(!result.segments.is_empty());
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.len() <= MAX_SEGMENT_SAMPLES));
    assert!(result.segments.iter().all(|segment| !segment.is_empty()));
    assert_eq!(result.segments.first().unwrap().start, 0);
    assert_eq!(result.segments.last().unwrap().end, samples.len());
}

#[test]
fn unreadable_model_also_degrades() {
    let samples = samples("silence-10s.wav");
    let result = segment_window(
        &samples,
        Some(Path::new("/definitely/missing.onnx")),
        &CancellationToken::new(),
    );
    assert!(result.degraded);
    assert!(!result.segments.is_empty());
}

#[test]
fn silence_yields_no_segments() {
    let model = require_model();
    let samples = samples("silence-10s.wav");
    let result = segment_window(&samples, Some(&model), &CancellationToken::new());
    assert!(!result.degraded);
    assert!(result.segments.is_empty(), "{:?}", result.segments);
}

#[test]
fn long_speech_is_capped_and_padded() {
    let model = require_model();
    let samples = samples("speech-65s.flac");
    let result = segment_window(&samples, Some(&model), &CancellationToken::new());
    assert!(!result.degraded);
    assert!(!result.segments.is_empty());
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.len() <= MAX_SEGMENT_SAMPLES));
    assert!(result.segments.iter().all(|segment| !segment.is_empty()));
    assert!(result
        .segments
        .windows(2)
        .all(|pair| pair[0].end <= pair[1].start));
}

#[test]
fn silence_gap_becomes_a_boundary() {
    let model = require_model();
    let samples = samples("speech-gap-speech.wav");
    let result = segment_window(&samples, Some(&model), &CancellationToken::new());
    assert!(!result.degraded);
    assert!(result.segments.len() >= 2, "{:?}", result.segments);
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.len() <= MAX_SEGMENT_SAMPLES));

    let gap_start = 5 * TARGET_SAMPLE_RATE as usize;
    let gap_end = 9 * TARGET_SAMPLE_RATE as usize;
    assert!(
        result.segments.iter().any(|segment| segment.end <= gap_end
            && segment.end >= gap_start.saturating_sub(PADDING_SAMPLES)),
        "{:?}",
        result.segments
    );
}

#[test]
fn cancellation_stops_feeding() {
    let model = require_model();
    let samples = samples("speech-65s.flac");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = segment_window(&samples, Some(&model), &cancel);
    assert!(!result.degraded);
    assert!(result.segments.is_empty());
}

#[test]
fn empty_window_is_empty() {
    let result = segment_window(&[], None, &CancellationToken::new());
    assert!(result.segments.is_empty());
    assert!(!result.degraded);
}
