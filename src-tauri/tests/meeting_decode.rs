//! Decoder contract: supported containers decode to 16 kHz mono windows, and
//! every rejection path maps to a stable audio error code.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::meeting::decode::{decode_windows, ensure_duration, probe_audio};
use qingmo_lib::services::meeting::{MAX_AUDIO_BYTES, TARGET_SAMPLE_RATE};
use qingmo_lib::state::document_registry::ensure_supported_audio;
use tokio_util::sync::CancellationToken;

const WINDOW_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 600;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/meeting")
        .join(name)
}

fn scope(name: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::copy(fixture(name), dir.path().join(name)).expect("fixture copy");
    dir
}

#[test]
fn accepts_every_supported_extension() {
    for name in ["a.m4a", "a.mp4", "a.wav", "a.mp3", "a.flac"] {
        ensure_supported_audio(Path::new(name)).expect(name);
    }
    for name in ["a.ogg", "a.aiff", "a", "a.md"] {
        assert_eq!(
            ensure_supported_audio(Path::new(name)).unwrap_err().code,
            AppErrorCode::AudioUnsupported
        );
    }
}

#[test]
fn probes_every_container() {
    for name in [
        "sample.m4a",
        "sample.mp4",
        "sample.wav",
        "sample.mp3",
        "sample.flac",
    ] {
        let probe = probe_audio(&fixture(name)).expect(name);
        assert!(
            (6_000..=6_500).contains(&probe.duration_ms),
            "{name}: {}",
            probe.duration_ms
        );
        let expected_rate = match name {
            "sample.wav" => 16_000,
            "sample.mp3" => 22_050,
            _ => 44_100,
        };
        assert_eq!(probe.sample_rate, expected_rate, "{name}");
        assert!(probe.channels >= 1, "{name}");
    }
}

#[test]
fn decodes_to_target_rate_and_mono() {
    let dir = scope("stereo-48k.wav");
    let path = dir.path().join("stereo-48k.wav");
    let probe = probe_audio(&path).expect("probe");
    assert_eq!(probe.sample_rate, 48_000);
    assert_eq!(probe.channels, 2);

    let samples: Vec<f32> = decode_windows(&path, CancellationToken::new())
        .expect("open")
        .flat_map(|window| window.expect("window"))
        .collect();

    let expected = (probe.duration_ms as usize * TARGET_SAMPLE_RATE as usize) / 1000;
    assert!(
        samples.len().abs_diff(expected) < 1_000,
        "got {}, expected {}",
        samples.len(),
        expected
    );
    assert!(samples.iter().all(|sample| sample.is_finite()));
    assert!(samples.iter().any(|sample| sample.abs() > 0.001));
}

#[test]
fn splits_exact_ten_minute_windows() {
    let dir = scope("window-10m.flac");
    let path = dir.path().join("window-10m.flac");
    let windows: Vec<Vec<f32>> = decode_windows(&path, CancellationToken::new())
        .expect("open")
        .map(|window| window.expect("window"))
        .collect();

    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].len(), WINDOW_SAMPLES);
    assert_eq!(windows[1].len(), 30 * TARGET_SAMPLE_RATE as usize);
}

#[test]
fn pre_cancelled_token_stops_before_decoding() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut decoder = decode_windows(&fixture("sample.wav"), cancel).expect("open");
    let error = decoder.next().expect("item").unwrap_err();
    assert_eq!(error.code, AppErrorCode::Cancelled);
}

#[test]
fn rejects_magic_mismatch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fake.wav");
    fs::write(&path, b"not really a wave file").expect("write");
    let error = probe_audio(&path).unwrap_err();
    assert_eq!(error.code, AppErrorCode::AudioUnsupported);
}

#[test]
fn rejects_oversize_file_before_decoding() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("huge.wav");
    let mut file = fs::File::create(&path).expect("create");
    file.write_all(b"RIFF\0\0\0\0WAVE").expect("header");
    file.set_len(MAX_AUDIO_BYTES + 1).expect("sparse");
    let error = probe_audio(&path).unwrap_err();
    assert_eq!(error.code, AppErrorCode::AudioTooLarge);
}

#[test]
fn rejects_empty_and_corrupt_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let empty = dir.path().join("empty.wav");
    fs::write(&empty, b"RIFF\0\0\0\0WAVE").expect("write");
    assert_eq!(
        probe_audio(&empty).unwrap_err().code,
        AppErrorCode::AudioDecodeFailed
    );

    let corrupt = dir.path().join("corrupt.m4a");
    let bytes = fs::read(fixture("sample.m4a")).expect("read");
    fs::write(&corrupt, &bytes[..bytes.len().min(120)]).expect("write");
    let error = decode_windows(&corrupt, CancellationToken::new());
    let error = match error {
        Ok(mut decoder) => decoder.next().expect("item").unwrap_err(),
        Err(error) => error,
    };
    assert_eq!(error.code, AppErrorCode::AudioDecodeFailed);
}

#[test]
fn enforces_the_duration_cap() {
    let probe = probe_audio(&fixture("sample.wav")).expect("probe");
    ensure_duration(&probe, 5).expect("six seconds fit in five minutes");
    ensure_duration(&probe, 1).expect("six seconds fit in one minute");

    let long = probe_audio(&fixture("window-10m.flac")).expect("probe");
    assert_eq!(
        ensure_duration(&long, 5).unwrap_err().code,
        AppErrorCode::AudioTooLong
    );
}

#[test]
fn missing_file_is_not_found() {
    let error = probe_audio(Path::new("/definitely/missing.wav")).unwrap_err();
    assert_eq!(error.code, AppErrorCode::NotFound);
}
