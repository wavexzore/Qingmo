//! Diarization integration: subwindow bounds, degradation and cancellation.

use std::fs;
use std::path::{Path, PathBuf};

use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::services::meeting::asr::{AsrEngine, RawAsr};
use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::pipeline::{run_local, run_local_with_diarizer, StopExit};
use qingmo_lib::services::meeting::speaker::{
    DiarizationEngine, DiarizeError, SpeakerModels, SpeakerTurn,
};
use qingmo_lib::services::meeting::TARGET_SAMPLE_RATE;
use tokio_util::sync::CancellationToken;

struct FakeAsr;

impl AsrEngine for FakeAsr {
    fn recognize(
        &mut self,
        _samples: &[f32],
        _start_ms: u64,
        end_ms: u64,
        _cancel: &CancellationToken,
    ) -> Result<RawAsr, AppError> {
        Ok(RawAsr {
            start_ms: 0,
            end_ms: end_ms.max(1),
            text: "hello".into(),
            tokens: vec![(0, Some(0.9))],
        })
    }
}

#[derive(Default)]
struct FakeDiarizer {
    calls: Vec<(usize, u64)>,
    fail_at: Option<usize>,
    cancel_at: Option<usize>,
    token: Option<CancellationToken>,
}

impl DiarizationEngine for FakeDiarizer {
    fn push_window(
        &mut self,
        samples: &[f32],
        subwindow_start_ms: u64,
        _cancel: &CancellationToken,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        let mut turns = Vec::new();
        for (k, chunk) in samples.chunks(60 * TARGET_SAMPLE_RATE as usize).enumerate() {
            self.calls
                .push((chunk.len(), subwindow_start_ms + k as u64 * 60_000));
            let index = self.calls.len() - 1;
            if self.cancel_at == Some(index) {
                self.token.as_ref().unwrap().cancel();
                return Err(DiarizeError::Cancelled);
            }
            if self.fail_at == Some(index) {
                return Err(DiarizeError::Failed {
                    message: "boom".into(),
                    turns,
                });
            }
            let offset = subwindow_start_ms + k as u64 * 60_000;
            let middle = offset + chunk.len() as u64 * 1000 / TARGET_SAMPLE_RATE as u64 / 2;
            turns.push(SpeakerTurn {
                t0_ms: offset,
                t1_ms: middle,
                speaker: 1,
            });
            turns.push(SpeakerTurn {
                t0_ms: middle,
                t1_ms: offset + chunk.len() as u64 * 1000 / TARGET_SAMPLE_RATE as u64,
                speaker: 2,
            });
        }
        Ok(turns)
    }
}

fn wav(name: &str, seconds: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-diarize-{}", std::process::id()));
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

fn two_windows(path: &Path) -> qingmo_lib::services::meeting::decode::DecodeWindow {
    decode_windows(path, CancellationToken::new()).unwrap()
}

#[test]
fn subwindows_are_bounded_and_offsets_are_absolute() {
    let path = wav("three-windows.wav", 605);
    let mut asr = FakeAsr;
    let mut diarizer = FakeDiarizer::default();
    let outcome = run_local_with_diarizer(
        two_windows(&path),
        None,
        &mut asr,
        Some(&mut diarizer),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.speaker_count.is_some());
    assert!(!outcome.speaker_degraded);
    assert!(!outcome.speaker_partial);
    assert_eq!(diarizer.calls.len(), 11);
    for (index, (len, start)) in diarizer.calls.iter().enumerate() {
        assert!(*len <= 60 * TARGET_SAMPLE_RATE as usize);
        if index < 10 {
            assert_eq!(*len, 60 * TARGET_SAMPLE_RATE as usize);
            assert_eq!(*start, index as u64 * 60_000);
        } else {
            assert_eq!(*len, 5 * TARGET_SAMPLE_RATE as usize);
            assert_eq!(*start, 600_000);
        }
    }
    assert!(outcome
        .segments
        .iter()
        .all(|segment| segment.speaker.is_some()));
    assert_eq!(outcome.speaker_count, Some(2));
}

#[test]
fn first_failure_degrades_without_blocking_asr() {
    let path = wav("first-fail.wav", 30);
    let mut asr = FakeAsr;
    let mut diarizer = FakeDiarizer {
        fail_at: Some(0),
        ..FakeDiarizer::default()
    };
    let outcome = run_local_with_diarizer(
        two_windows(&path),
        None,
        &mut asr,
        Some(&mut diarizer),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.speaker_degraded);
    assert!(!outcome.speaker_partial);
    assert!(outcome
        .segments
        .iter()
        .all(|segment| segment.speaker.is_none()));
    assert_eq!(outcome.exit, StopExit::Releasing);
    assert!(outcome.available() >= 1);
}

#[test]
fn later_failure_is_partial_and_keeps_earlier_labels() {
    let path = wav("second-fail.wav", 90);
    let mut asr = FakeAsr;
    let mut diarizer = FakeDiarizer {
        fail_at: Some(1),
        ..FakeDiarizer::default()
    };
    let outcome = run_local_with_diarizer(
        two_windows(&path),
        None,
        &mut asr,
        Some(&mut diarizer),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(!outcome.speaker_degraded);
    assert!(outcome.speaker_partial);
    assert!(outcome
        .segments
        .iter()
        .any(|segment| segment.speaker.is_some()));
    assert!(outcome.available() >= 1);
}

#[test]
fn cancellation_inside_a_subwindow_stops_the_pipeline() {
    let path = wav("cancel.wav", 60);
    let token = CancellationToken::new();
    let mut asr = FakeAsr;
    let mut diarizer = FakeDiarizer {
        cancel_at: Some(0),
        token: Some(token.clone()),
        ..FakeDiarizer::default()
    };
    let error = run_local_with_diarizer(
        two_windows(&path),
        None,
        &mut asr,
        Some(&mut diarizer),
        &token,
        None,
    )
    .expect_err("cancel");
    assert_eq!(error.code, AppErrorCode::Cancelled);
}

#[test]
fn missing_diarizer_only_marks_degraded() {
    let path = wav("missing.wav", 10);
    let mut asr = FakeAsr;
    let outcome = run_local(
        decode_windows(&path, CancellationToken::new()).unwrap(),
        None,
        &mut asr,
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.speaker_degraded);
    assert!(outcome.available() >= 1);
}

#[test]
#[ignore = "needs MEETING_PROBE_MODELS and the two-speaker fixture"]
fn real_models_keep_two_speakers_stable_across_subwindows() {
    let root = PathBuf::from(std::env::var("MEETING_PROBE_MODELS").expect("models root"));
    let models = SpeakerModels {
        segmentation: root.join("seg.onnx"),
        embedding: root.join("emb.onnx"),
    };
    let mut diarizer =
        qingmo_lib::services::meeting::diarize::SherpaDiarizer::new(&models).expect("diarizer");
    let token = CancellationToken::new();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/meeting/two-speakers-56s.wav");
    let bytes = fs::read(fixture).unwrap();
    let mut samples = bytes[44..]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect::<Vec<_>>();
    samples.extend_from_slice(&samples.clone());
    let first = diarizer.push_window(&samples, 0, &token).expect("diarize");
    let speakers = first
        .iter()
        .map(|turn| turn.speaker)
        .collect::<std::collections::BTreeSet<_>>();
    assert!(speakers.len() >= 2, "{speakers:?}");
    let first_half = first
        .iter()
        .filter(|turn| turn.t0_ms < 60_000)
        .map(|turn| turn.speaker)
        .collect::<std::collections::BTreeSet<_>>();
    let second_half = first
        .iter()
        .filter(|turn| turn.t0_ms >= 60_000)
        .map(|turn| turn.speaker)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(first_half, second_half);
}

#[test]
#[ignore = "needs MEETING_PROBE_MODELS and the four-speaker fixture"]
fn real_models_find_four_speakers() {
    let root = PathBuf::from(std::env::var("MEETING_PROBE_MODELS").expect("models root"));
    let models = SpeakerModels {
        segmentation: root.join("seg.onnx"),
        embedding: root.join("emb.onnx"),
    };
    let mut diarizer =
        qingmo_lib::services::meeting::diarize::SherpaDiarizer::new(&models).expect("diarizer");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/meeting/four-speakers-56s.wav");
    let bytes = fs::read(fixture).unwrap();
    let samples = bytes[44..]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect::<Vec<_>>();
    let turns = diarizer
        .push_window(&samples, 0, &CancellationToken::new())
        .expect("diarize");
    let speakers = turns
        .iter()
        .map(|turn| turn.speaker)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(speakers.len(), 4, "{speakers:?}");
}

#[test]
#[ignore = "needs MEETING_PROBE_MODELS and MEETING_PROBE_TEN_MIN"]
fn real_ten_minutes_stays_inside_the_time_budget() {
    let root = PathBuf::from(std::env::var("MEETING_PROBE_MODELS").expect("models root"));
    let models = SpeakerModels {
        segmentation: root.join("seg.onnx"),
        embedding: root.join("emb.onnx"),
    };
    let mut diarizer =
        qingmo_lib::services::meeting::diarize::SherpaDiarizer::new(&models).expect("diarizer");
    let wav = PathBuf::from(std::env::var("MEETING_PROBE_TEN_MIN").expect("ten minute wav"));
    let bytes = fs::read(wav).unwrap();
    let samples = bytes[44..]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect::<Vec<_>>();
    let started = std::time::Instant::now();
    let turns = diarizer
        .push_window(&samples, 0, &CancellationToken::new())
        .expect("diarize");
    eprintln!(
        "ten_minutes_ms={} turns={}",
        started.elapsed().as_millis(),
        turns.len()
    );
    assert!(started.elapsed() <= std::time::Duration::from_secs(303));
}
