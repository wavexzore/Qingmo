//! Local ASR/diarization calibration over a manifest of short samples.
//!
//! Usage: `calibrate_meeting <models-root> <manifest.json> <out.json>`
//!
//! The manifest lists `samples` (`id`, `wav`, `ref`) and optional
//! `diarization` entries (`id`, `wav`). Every sample is transcribed with the
//! real Paraformer pack; `diarization` entries also run the real speaker
//! pipeline so the cluster threshold can be judged by label stability.
//!
//! Sample audio is self-built and never committed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use qingmo_lib::services::meeting::asr::SherpaAsr;
use qingmo_lib::services::meeting::decode::decode_windows;
use qingmo_lib::services::meeting::diarize::SherpaDiarizer;
use qingmo_lib::services::meeting::pipeline::run_local_with_diarizer;
use qingmo_lib::services::meeting::speaker::SpeakerModels;

const ASR_ID: &str = "paraformer-zh-en-int8";
const SEGMENTATION_ID: &str = "pyannote-segmentation-3-int8";
const EMBEDDING_ID: &str = "campplus-zh-en-advanced";

#[derive(Debug, Deserialize)]
struct Manifest {
    samples: Vec<Sample>,
    #[serde(default)]
    diarization: Vec<DiarSample>,
}

#[derive(Debug, Deserialize)]
struct Sample {
    id: String,
    wav: PathBuf,
    #[serde(rename = "ref")]
    reference: String,
}

#[derive(Debug, Deserialize)]
struct DiarSample {
    id: String,
    wav: PathBuf,
}

#[derive(Debug, Serialize)]
struct Report {
    asr: AsrReport,
    diarization: Vec<DiarReport>,
}

#[derive(Debug, Serialize)]
struct AsrReport {
    samples: Vec<SampleReport>,
    mean_cer: f32,
    p95_cer: f32,
    max_cer: f32,
}

#[derive(Debug, Serialize)]
struct SampleReport {
    id: String,
    cer: f32,
    ref_chars: usize,
    hyp_chars: usize,
}

#[derive(Debug, Serialize)]
struct DiarReport {
    id: String,
    labels: usize,
    segments: usize,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!(
            "usage: {} <models-root> <manifest.json> <out.json>",
            args[0]
        );
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[1]);
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(&args[2]).expect("manifest")).expect("manifest json");

    let mut asr = SherpaAsr::open(ASR_ID, &root.join(ASR_ID), 4).expect("asr model");
    let mut reports = Vec::new();
    for sample in &manifest.samples {
        let hyp = transcribe(&mut asr, &sample.wav);
        let reference = normalize(&sample.reference);
        let hypothesis = normalize(&hyp);
        let ref_chars = reference.chars().count();
        let hyp_chars = hypothesis.chars().count();
        let cer = if ref_chars == 0 {
            1.0
        } else {
            distance(&reference, &hypothesis) as f32 / ref_chars as f32
        };
        eprintln!(
            "{} cer={:.3} ref={} hyp={}",
            sample.id,
            cer,
            reference.len(),
            hypothesis.len()
        );
        reports.push(SampleReport {
            id: sample.id.clone(),
            cer,
            ref_chars,
            hyp_chars,
        });
    }

    let mean_cer = if reports.is_empty() {
        0.0
    } else {
        reports.iter().map(|sample| sample.cer).sum::<f32>() / reports.len() as f32
    };
    let max_cer = reports
        .iter()
        .map(|sample| sample.cer)
        .fold(0.0_f32, f32::max);
    let mut sorted = reports.iter().map(|sample| sample.cer).collect::<Vec<_>>();
    sorted.sort_by(f32::total_cmp);
    let p95_cer = sorted
        .get((sorted.len() * 95 / 100).saturating_sub(1))
        .copied()
        .unwrap_or(0.0);

    let models = SpeakerModels {
        segmentation: root.join(SEGMENTATION_ID).join("model.int8.onnx"),
        embedding: root
            .join(EMBEDDING_ID)
            .join("3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"),
    };
    let mut diarization = Vec::new();
    for sample in &manifest.diarization {
        let mut diarizer = SherpaDiarizer::new(&models).expect("diarizer");
        let outcome = transcribe_diarized(&mut asr, &sample.wav, &mut diarizer).expect("pipeline");
        let labels: BTreeSet<u8> = outcome
            .segments
            .iter()
            .filter_map(|segment| segment.speaker)
            .collect();
        eprintln!(
            "{} labels={} segments={}",
            sample.id,
            labels.len(),
            outcome.segments.len()
        );
        diarization.push(DiarReport {
            id: sample.id.clone(),
            labels: labels.len(),
            segments: outcome.segments.len(),
        });
    }

    std::fs::write(
        &args[3],
        serde_json::to_vec_pretty(&Report {
            asr: AsrReport {
                samples: reports,
                mean_cer,
                p95_cer,
                max_cer,
            },
            diarization,
        })
        .expect("json"),
    )
    .expect("write");
    println!("mean_cer={mean_cer:.3} p95_cer={p95_cer:.3} max_cer={max_cer:.3}");
}

fn transcribe(asr: &mut SherpaAsr, wav: &Path) -> String {
    let outcome = run_local_with_diarizer(
        decode_windows(wav, CancellationToken::new()).expect("decode"),
        None,
        asr,
        None,
        &CancellationToken::new(),
        None,
    )
    .expect("pipeline");
    outcome
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn transcribe_diarized(
    asr: &mut SherpaAsr,
    wav: &Path,
    diarizer: &mut SherpaDiarizer,
) -> Option<qingmo_lib::services::meeting::pipeline::PipelineOutcome> {
    let vad = std::env::var_os("MEETING_PROBE_VAD").map(PathBuf::from);
    run_local_with_diarizer(
        decode_windows(wav, CancellationToken::new()).ok()?,
        vad.as_deref(),
        asr,
        Some(diarizer),
        &CancellationToken::new(),
        None,
    )
    .ok()
}

/// Keeps CJK, ASCII letters and digits; everything else separates nothing.
fn normalize(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for (row, ch) in left.chars().enumerate() {
        current[0] = row + 1;
        for (column, other) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(ch != *other);
            current[column + 1] = (previous[column + 1] + 1)
                .min(current[column] + 1)
                .min(substitution);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}
