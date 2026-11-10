//! ASR raw-result parsing and probability semantics.

use qingmo_lib::services::meeting::asr::{parse_result, Segment, SegmentStatus};
use sherpa_onnx::OfflineRecognizerResult;

fn result(text: &str, times: Vec<f32>, log_probs: Vec<f32>) -> OfflineRecognizerResult {
    OfflineRecognizerResult {
        text: text.into(),
        tokens: vec!["x".into(); times.len()],
        timestamps: Some(times),
        durations: None,
        ys_log_probs: log_probs,
    }
}

#[test]
fn zipformer_log_probs_become_finite_probabilities() {
    let parsed = parse_result(&result("a b", vec![0.0, 0.5], vec![-0.1, -0.2]), 0, 1000);
    assert_eq!(parsed.tokens[0].1, Some((-0.1f32).exp()));
    let segment = Segment::from_raw(parsed, 0, 1000);
    assert!(segment.avg_prob.is_some());
    assert_eq!(segment.status, SegmentStatus::Ok);
}

#[test]
fn without_log_probs_the_average_is_none() {
    let parsed = parse_result(&result("a b", vec![0.0, 0.5], vec![]), 0, 1000);
    assert_eq!(parsed.tokens[0].1, None);
    let segment = Segment::from_raw(parsed, 0, 1000);
    assert_eq!(segment.avg_prob, None);
    assert!(!segment.low_confidence);
}

#[test]
fn infinite_log_prob_is_filtered() {
    let parsed = parse_result(&result("a", vec![0.0], vec![1e30]), 0, 1000);
    assert_eq!(parsed.tokens[0].1, None);
}

#[test]
fn missing_timestamps_still_produce_a_segment() {
    let mut raw = result("hello", vec![], vec![]);
    raw.timestamps = None;
    let parsed = parse_result(&raw, 0, 1000);
    assert_eq!(parsed.start_ms, 0);
    assert_eq!(parsed.end_ms, 1);
}

#[test]
#[ignore = "needs MEETING_MODEL_ZIPFORMER and MEETING_MODEL_PARAFORMER"]
fn real_models_expose_the_expected_probability_branch() {
    use qingmo_lib::services::meeting::asr::{AsrEngine, SherpaAsr};
    use std::path::Path;
    use tokio_util::sync::CancellationToken;

    fn run(dir: &str, pack: &str) -> Segment {
        let mut engine = SherpaAsr::open(pack, Path::new(dir), 2).unwrap();
        let wave = sherpa_onnx::Wave::read(&format!("{dir}/test_wavs/0.wav")).unwrap();
        let end = (wave.samples().len() as u64 * 1000)
            / u64::from(qingmo_lib::services::meeting::TARGET_SAMPLE_RATE);
        let raw = engine
            .recognize(wave.samples(), 0, end, &CancellationToken::new())
            .unwrap();
        assert!(!raw.text.trim().is_empty());
        Segment::from_raw(raw, 0, end)
    }

    let zip = std::env::var("MEETING_MODEL_ZIPFORMER").unwrap();
    let para = std::env::var("MEETING_MODEL_PARAFORMER").unwrap();
    assert!(run(&zip, "zipformer-zh-en-int8").avg_prob.is_some());
    assert!(run(&para, "paraformer-zh-en-int8").avg_prob.is_none());
}
