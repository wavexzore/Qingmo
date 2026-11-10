//! Pipeline loop, exit table and failure placeholders.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use qingmo_lib::services::meeting::asr::{AsrEngine, RawAsr};
use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::pipeline::{run_local, StopExit, StopReason};
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
