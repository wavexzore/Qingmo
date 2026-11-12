//! Temporary probe: run the local pipeline against a real recording.
//!
//! Usage: cargo run --example probe_pipeline -- <audio> <asr-dir> <vad-model>

use std::path::Path;

use qingmo_lib::services::meeting::asr::SherpaAsr;
use qingmo_lib::services::meeting::decode::{decode_windows, probe_audio, window_total};
use qingmo_lib::services::meeting::diarize::SherpaDiarizer;
use qingmo_lib::services::meeting::pipeline::run_local_with_progress;
use qingmo_lib::services::meeting::speaker::SpeakerModels;
use tokio_util::sync::CancellationToken;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = Path::new(&args[1]);
    let asr_dir = Path::new(&args[2]);
    let vad = Path::new(&args[3]);
    let probe = probe_audio(path).expect("probe");
    let cancel = CancellationToken::new();
    let windows = decode_windows(path, cancel.clone()).expect("decode");
    let mut asr = SherpaAsr::open("paraformer-zh-en-int8", asr_dir, 4).expect("asr");
    let models = SpeakerModels {
        segmentation: Path::new(&args[4]).to_path_buf(),
        embedding: Path::new(&args[5]).to_path_buf(),
    };
    let mut diarizer = SherpaDiarizer::new(&models).expect("diarizer");
    let mut counts = std::collections::BTreeMap::<u64, (usize, usize)>::new();
    let mut on_window = |progress: qingmo_lib::ipc::dto::WindowProgress| {
        counts.entry(u64::from(progress.index)).or_default().0 += progress.done_segments as usize;
    };
    let outcome = run_local_with_progress(
        windows,
        Some(vad),
        &mut asr,
        Some(&mut diarizer),
        &cancel,
        None,
        window_total(probe.duration_ms),
        &mut on_window,
    )
    .expect("pipeline");
    println!(
        "segments={} ok={} failed={} stop={:?}",
        outcome.segments.len(),
        outcome
            .segments
            .iter()
            .filter(|s| s.status == qingmo_lib::services::meeting::asr::SegmentStatus::Ok)
            .count(),
        outcome
            .segments
            .iter()
            .filter(|s| s.status == qingmo_lib::services::meeting::asr::SegmentStatus::Failed)
            .count(),
        outcome.stop_reason
    );
    for (index, (done, _)) in counts {
        println!("window {index} processed {done}");
    }
    let mut per_window = std::collections::BTreeMap::<u64, (usize, usize, usize)>::new();
    for segment in &outcome.segments {
        let entry = per_window.entry(segment.start_ms / 600_000).or_default();
        entry.0 += 1;
        if segment.text.is_empty() {
            entry.1 += 1;
        } else {
            entry.2 += 1;
        }
    }
    for (window, (total, empty, text)) in per_window {
        println!("window {window} pushed={total} empty={empty} text={text}");
    }
    let mut per_win_spk =
        std::collections::BTreeMap::<u64, std::collections::BTreeMap<u8, usize>>::new();
    for segment in &outcome.segments {
        if let Some(speaker) = segment.speaker {
            *per_win_spk
                .entry(segment.start_ms / 600_000)
                .or_default()
                .entry(speaker)
                .or_default() += 1;
        }
    }
    for (w, dist) in &per_win_spk {
        println!("window {w} speakers={dist:?}");
    }
    let mut speakers = std::collections::BTreeMap::<u8, usize>::new();
    for segment in &outcome.segments {
        if let Some(speaker) = segment.speaker {
            *speakers.entry(speaker).or_default() += 1;
        }
    }
    println!("speakers={speakers:?}");
    for segment in outcome.segments.iter().take(12) {
        println!(
            "{}ms spk={:?} {:?}",
            segment.start_ms, segment.speaker, segment.text
        );
    }
    if let Some(first) = outcome.segments.iter().find(|s| s.start_ms >= 600_000) {
        println!("w1 first start={} text={:?}", first.start_ms, first.text);
    }
}
