//! Cancellation: registry token, pipeline stop and no temp-file residue.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use qingmo_lib::ipc::dto::MeetingProgress;
use qingmo_lib::services::meeting::asr::{AsrEngine, RawAsr};
use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::pipeline::run_local;
use qingmo_lib::services::meeting::TARGET_SAMPLE_RATE;
use qingmo_lib::state::meeting::progress::ProgressEmitter;
use qingmo_lib::state::meeting::{MeetingRegistry, MeetingSource};
use tokio_util::sync::CancellationToken;

struct CancelAsr;

impl AsrEngine for CancelAsr {
    fn recognize(
        &mut self,
        _samples: &[f32],
        _start_ms: u64,
        end_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<RawAsr, qingmo_lib::error::AppError> {
        cancel.cancel();
        Ok(RawAsr {
            start_ms: 0,
            end_ms: end_ms.max(1),
            text: "partial".into(),
            tokens: Vec::new(),
        })
    }
}

fn wav(seconds: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-cancel-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{seconds}.wav"));
    let samples = TARGET_SAMPLE_RATE * seconds;
    let data = samples * 2;
    let mut bytes = Vec::with_capacity(44 + data as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data.to_le_bytes());
    bytes.extend_from_slice(&vec![0u8; data as usize]);
    fs::write(&path, bytes).unwrap();
    path
}

struct Noop;

impl ProgressEmitter for Noop {
    fn emit(&self, _label: &str, _progress: &MeetingProgress) {}
}

#[test]
fn registry_cancel_flips_the_token_and_release_is_idempotent() {
    let registry = MeetingRegistry::with_emitter(Arc::new(Noop));
    let source = MeetingSource::new("/tmp/in.wav", 10, 1_000);
    let (id, token) = registry.begin(source, "doc-1").expect("begin");
    assert!(registry.cancel(id).is_ok());
    assert!(token.is_cancelled());
    assert!(registry.cancel(id).is_ok());
    assert!(registry.release(id));
    assert!(!registry.release(id));
}

#[test]
fn pipeline_stops_at_the_next_segment_boundary() {
    let path = wav(3);
    let token = CancellationToken::new();
    let error = run_local(
        decode_windows(&path, token.clone()).unwrap(),
        None,
        &mut CancelAsr,
        &token,
        None,
    )
    .expect_err("cancel");
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::Cancelled);
    // Neither decoding nor staging leaves a temp artifact next to the source.
    let leftovers = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.contains("tmp") || name.ends_with(".part")
        })
        .count();
    assert_eq!(leftovers, 0);
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
