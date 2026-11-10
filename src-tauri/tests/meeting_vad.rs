//! VAD segmentation contract: speech is split to <= 30 s with padding, silence
//! yields nothing, and a missing model degrades to a fixed grid.

use std::path::{Path, PathBuf};

use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::vad::{segment_window, MAX_SEGMENT_MS, PADDING_MS};
use qingmo_lib::services::meeting::TARGET_SAMPLE_RATE;
use tokio_util::sync::CancellationToken;

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
        .flat_map(|window| window.expect("decode").samples)
        .collect()
}

fn require_model() -> PathBuf {
    model()
        .unwrap_or_else(|| panic!("run scripts/dev/fetch-meeting-fixtures.sh before the VAD tests"))
}

#[test]
fn missing_model_degrades_to_fixed_grid() {
    let samples = samples("speech-gap-speech.wav");
    let result = segment_window(&samples, None, 0, &CancellationToken::new());
    assert!(result.degraded);
    assert!(!result.segments.is_empty());
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.len_ms() <= MAX_SEGMENT_MS));
    assert!(result.segments.iter().all(|segment| segment.len_ms() > 0));
    assert_eq!(result.segments.first().unwrap().start_ms, 0);
    assert_eq!(
        result.segments.last().unwrap().end_ms,
        (samples.len() as u64 * 1000) / u64::from(TARGET_SAMPLE_RATE)
    );
}

#[test]
fn unreadable_model_also_degrades() {
    let samples = samples("silence-10s.wav");
    let result = segment_window(
        &samples,
        Some(Path::new("/definitely/missing.onnx")),
        0,
        &CancellationToken::new(),
    );
    assert!(result.degraded);
    assert!(!result.segments.is_empty());
}

#[test]
fn silence_yields_no_segments() {
    let model = require_model();
    let samples = samples("silence-10s.wav");
    let result = segment_window(&samples, Some(&model), 0, &CancellationToken::new());
    assert!(!result.degraded);
    assert!(result.segments.is_empty(), "{:?}", result.segments);
}

#[test]
fn long_speech_is_capped_and_padded() {
    let model = require_model();
    let samples = samples("speech-65s.flac");
    let result = segment_window(&samples, Some(&model), 0, &CancellationToken::new());
    assert!(!result.degraded);
    assert!(!result.segments.is_empty());
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.len_ms() <= MAX_SEGMENT_MS));
    assert!(result.segments.iter().all(|segment| segment.len_ms() > 0));
    assert!(result
        .segments
        .windows(2)
        .all(|pair| pair[0].end_ms <= pair[1].start_ms));
}

#[test]
fn silence_gap_becomes_a_boundary() {
    let model = require_model();
    let samples = samples("speech-gap-speech.wav");
    let result = segment_window(&samples, Some(&model), 0, &CancellationToken::new());
    assert!(!result.degraded);
    assert!(result.segments.len() >= 2, "{:?}", result.segments);
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.len_ms() <= MAX_SEGMENT_MS));

    let gap_start = 5_000u64;
    let gap_end = 9_000u64;
    assert!(
        result
            .segments
            .iter()
            .any(|segment| segment.end_ms <= gap_end
                && segment.end_ms >= gap_start.saturating_sub(PADDING_MS)),
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
    let result = segment_window(&samples, Some(&model), 0, &cancel);
    assert!(!result.degraded);
    assert!(result.segments.is_empty());
}

#[test]
fn offsets_are_absolute() {
    let samples = samples("speech-65s.flac");
    let result = segment_window(&samples, None, 600_000, &CancellationToken::new());
    assert!(result.degraded);
    assert!(result
        .segments
        .iter()
        .all(|segment| segment.start_ms >= 600_000));
    assert_eq!(result.segments.first().unwrap().start_ms, 600_000);
}

#[test]
fn empty_window_is_empty() {
    let result = segment_window(&[], None, 0, &CancellationToken::new());
    assert!(result.segments.is_empty());
    assert!(!result.degraded);
}
