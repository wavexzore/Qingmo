//! Throwaway release probe for the T-004c diarization baseline.

use std::time::Instant;

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let seg = &args[1];
    let emb = &args[2];
    let wav = &args[3];
    let load_only = args.get(4).is_some();

    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(seg.clone()),
                window_shift_ratio: 0.3,
            },
            num_threads: 1,
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(emb.clone()),
            num_threads: 1,
            ..Default::default()
        },
        clustering: FastClusteringConfig {
            num_clusters: -1,
            threshold: 0.5,
            compute_confidence: false,
        },
        min_duration_on: 0.3,
        min_duration_off: 0.5,
    };
    let start = Instant::now();
    let diarizer = OfflineSpeakerDiarization::create(&config).expect("create diarizer");
    let extractor = SpeakerEmbeddingExtractor::create(&config.embedding).expect("extractor");
    eprintln!("load_ms={}", start.elapsed().as_millis());
    if load_only {
        return;
    }
    let bytes = std::fs::read(wav).expect("read wav");
    let samples = bytes[44..]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect::<Vec<_>>();
    let start = Instant::now();
    let mut total = 0usize;
    for (index, chunk) in samples.chunks(960_000).enumerate() {
        let result = diarizer.process(chunk).expect("process");
        let turns = result.sort_by_start_time();
        drop(result);
        total += turns.len();
        let mut ranges = std::collections::HashMap::<i32, Vec<(usize, usize)>>::new();
        for turn in &turns {
            let start = (turn.start.max(0.0) * 16000.0) as usize;
            let end = ((turn.end.max(0.0) * 16000.0) as usize).min(chunk.len());
            if end > start {
                ranges.entry(turn.speaker).or_default().push((start, end));
            }
        }
        for ranges in ranges.values() {
            let mut picked = Vec::with_capacity(80_000);
            for (start, end) in ranges {
                let take = (end - start).min(80_000 - picked.len());
                picked.extend_from_slice(&chunk[*start..*start + take]);
                if picked.len() >= 80_000 {
                    break;
                }
            }
            let stream = extractor.create_stream().expect("stream");
            stream.accept_waveform(16000, &picked);
            stream.input_finished();
            if extractor.is_ready(&stream) {
                let _ = extractor.compute(&stream);
            }
        }
        eprintln!("window={index} len={}", chunk.len());
    }
    eprintln!(
        "process_ms={} segments={total}",
        start.elapsed().as_millis()
    );
}
