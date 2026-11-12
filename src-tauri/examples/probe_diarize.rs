//! Temporary probe: count diarizer speaker turns only.
//!
//! Usage: cargo run --example probe_diarize -- <audio> <segmentation> <embedding>

use std::path::Path;

use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::diarize::SherpaDiarizer;
use qingmo_lib::services::meeting::speaker::SpeakerModels;
use qingmo_lib::services::meeting::DiarizationEngine;
use tokio_util::sync::CancellationToken;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = Path::new(&args[1]);
    let models = SpeakerModels {
        segmentation: Path::new(&args[2]).to_path_buf(),
        embedding: Path::new(&args[3]).to_path_buf(),
    };
    let mut diarizer = SherpaDiarizer::new(&models).expect("diarizer");
    let cancel = CancellationToken::new();
    let mut counts = std::collections::BTreeMap::<u8, usize>::new();
    let mut windows = 0usize;
    for (index, window) in decode_windows(path, cancel.clone())
        .expect("decode")
        .enumerate()
    {
        let window = window.expect("window");
        let turns = diarizer
            .push_window(&window.samples, window.start_ms, &cancel)
            .expect("diarize");
        println!("window {index} turns={}", turns.len());
        for turn in turns {
            *counts.entry(turn.speaker).or_default() += 1;
        }
        windows += 1;
        if index >= 2 {
            break;
        }
    }
    println!("windows={windows} speakers={counts:?}");
}
