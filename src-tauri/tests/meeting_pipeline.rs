//! Pipeline loop, exit table and failure placeholders.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use qingmo_lib::ipc::dto::WindowPhase;
use qingmo_lib::services::meeting::asr::{AsrEngine, RawAsr};
use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::diarize::SherpaDiarizer;
use qingmo_lib::services::meeting::pipeline::{
    run_local, run_local_with_diarizer, run_local_with_progress, StopExit, StopReason,
};
use qingmo_lib::services::meeting::speaker::SpeakerModels;
use qingmo_lib::services::meeting::TARGET_SAMPLE_RATE;
use tokio_util::sync::CancellationToken;

struct Fake {
    fail: bool,
}

impl AsrEngine for Fake {
    fn recognize(
        &mut self,
        _samples: &[f32],
        _start_ms: u64,
        end_ms: u64,
        _cancel: &CancellationToken,
    ) -> Result<RawAsr, qingmo_lib::error::AppError> {
        if self.fail {
            return Err(qingmo_lib::error::AppError::new(
                qingmo_lib::error::AppErrorCode::AsrFailed,
                "boom",
            ));
        }
        Ok(RawAsr {
            start_ms: 0,
            end_ms: end_ms.max(1),
            text: "hello".into(),
            tokens: vec![(0, Some(0.9))],
        })
    }
}

fn wav(name: &str, seconds: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-pipeline-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    let samples = TARGET_SAMPLE_RATE * seconds;
    let data_bytes = samples * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for index in 0..samples {
        let value = ((index as f32 * 0.05).sin() * 8_000.0) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    fs::write(&path, bytes).unwrap();
    path
}

fn run(
    path: &Path,
    asr: &mut Fake,
    deadline: Option<Instant>,
) -> qingmo_lib::services::meeting::PipelineOutcome {
    let windows = decode_windows(path, CancellationToken::new()).unwrap();
    run_local(windows, None, asr, &CancellationToken::new(), deadline).unwrap()
}

#[test]
fn success_reaches_releasing_without_partial() {
    let path = wav("ok.wav", 3);
    let outcome = run(&path, &mut Fake { fail: false }, None);
    assert_eq!(outcome.stop_reason, StopReason::Completed);
    assert_eq!(outcome.exit, StopExit::Releasing);
    assert!(!outcome.partial);
    assert!(outcome.available() >= 1);
}

#[test]
fn progress_reports_each_window_and_segment() {
    let path = wav("progress.wav", 3);
    let windows = decode_windows(&path, CancellationToken::new()).unwrap();
    let mut asr = Fake { fail: false };
    let mut seen = Vec::new();
    let outcome = run_local_with_progress(
        windows,
        None,
        &mut asr,
        None,
        &CancellationToken::new(),
        None,
        1,
        &mut |window| seen.push(window),
    )
    .unwrap();
    assert!(outcome.available() >= 1);
    let first = seen.first().expect("a window event");
    assert_eq!(
        (first.index, first.total, first.phase),
        (0, 1, WindowPhase::Diarizing)
    );
    let transcribing: Vec<_> = seen
        .iter()
        .filter(|window| window.phase == WindowPhase::Transcribing)
        .collect();
    assert!(!transcribing.is_empty());
    assert!(transcribing[0].total_segments >= 1);
    assert_eq!(
        transcribing.last().unwrap().done_segments,
        transcribing[0].total_segments
    );
    assert!(transcribing
        .windows(2)
        .all(|pair| pair[1].done_segments >= pair[0].done_segments));
}

#[test]
fn every_segment_failing_is_all_failed() {
    let path = wav("fail.wav", 3);
    let outcome = run(&path, &mut Fake { fail: true }, None);
    assert_eq!(outcome.stop_reason, StopReason::AllFailed);
    assert_eq!(outcome.exit, StopExit::Failed);
    assert!(outcome.failed_segments >= 1);
}

#[test]
fn deadline_without_segments_fails() {
    let path = wav("deadline.wav", 3);
    let outcome = run(
        &path,
        &mut Fake { fail: false },
        Some(Instant::now() - Duration::from_secs(1)),
    );
    assert_eq!(outcome.stop_reason, StopReason::Deadline);
    assert_eq!(outcome.exit, StopExit::Failed);
}

#[test]
fn deadline_after_segments_is_partial() {
    struct Late {
        calls: u8,
    }
    impl AsrEngine for Late {
        fn recognize(
            &mut self,
            _samples: &[f32],
            _start_ms: u64,
            end_ms: u64,
            _cancel: &CancellationToken,
        ) -> Result<RawAsr, qingmo_lib::error::AppError> {
            self.calls += 1;
            std::thread::sleep(Duration::from_millis(150));
            Ok(RawAsr {
                start_ms: 0,
                end_ms: end_ms.max(1),
                text: "hello".into(),
                tokens: vec![],
            })
        }
    }
    let path = wav("late.wav", 660);
    let windows = decode_windows(&path, CancellationToken::new()).unwrap();
    let mut asr = Late { calls: 0 };
    // 3 s lands inside the first window's ASR: the per-window deadline check
    // only fires at the next window, after at least one segment exists.
    let outcome = run_local(
        windows,
        None,
        &mut asr,
        &CancellationToken::new(),
        Some(Instant::now() + Duration::from_millis(3_000)),
    )
    .unwrap();
    assert_eq!(outcome.stop_reason, StopReason::Deadline);
    assert_eq!(outcome.exit, StopExit::Partial);
    assert!(outcome.partial);
    assert!(outcome.partial_until_ms.is_some());
}

#[test]
#[ignore = "needs MEETING_PROBE_MODELS"]
fn real_models_transcribe_two_speakers_with_monotonic_time() {
    let root = PathBuf::from(std::env::var("MEETING_PROBE_MODELS").expect("models root"));
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/meeting/two-speakers-56s.wav");
    let mut asr = qingmo_lib::services::meeting::asr::SherpaAsr::open(
        "paraformer-zh-en-int8",
        &root.join("models/paraformer-zh-en-int8"),
        2,
    )
    .expect("asr");
    let models = SpeakerModels {
        segmentation: root.join("seg.onnx"),
        embedding: root.join("emb.onnx"),
    };
    let mut diarizer = SherpaDiarizer::new(&models).expect("diarizer");
    let outcome = run_local_with_diarizer(
        decode_windows(&fixture, CancellationToken::new()).unwrap(),
        None,
        &mut asr,
        Some(&mut diarizer),
        &CancellationToken::new(),
        None,
    )
    .expect("pipeline");
    assert!(outcome.available() >= 1);
    assert!(outcome.speaker_count.unwrap_or(0) >= 1);
    let mut last = 0;
    for segment in &outcome.segments {
        assert!(segment.start_ms >= last);
        last = segment.start_ms;
        assert!(segment.speaker.is_some());
    }
}
