//! Pre-implementation demo for the vendored `ys_log_probs` patch.
//!
//! Usage:
//!   cargo run --release --example meeting_asr_demo -- zipformer <dir> <wav>
//!   cargo run --release --example meeting_asr_demo -- paraformer <dir> <wav>
//!
//! Prints whether the recognizer surfaced per-token log probabilities.

use std::path::Path;

use sherpa_onnx::{
    OfflineParaformerModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineTransducerModelConfig, Wave,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: meeting_asr_demo <zipformer|paraformer> <model-dir> <wav>");
        std::process::exit(2);
    }
    let family = &args[1];
    let dir = Path::new(&args[2]);
    let wav = &args[3];

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.tokens = Some(path_string(dir, "tokens.txt"));
    config.model_config.num_threads = 1;
    config.model_config.provider = Some("cpu".into());
    config.model_config.debug = false;
    config.decoding_method = Some("greedy_search".into());

    match family.as_str() {
        "zipformer" => {
            config.model_config.model_type = Some("transducer".into());
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(path_string(dir, "encoder-epoch-34-avg-19.int8.onnx")),
                decoder: Some(path_string(dir, "decoder-epoch-34-avg-19.onnx")),
                joiner: Some(path_string(dir, "joiner-epoch-34-avg-19.int8.onnx")),
            };
        }
        "paraformer" => {
            config.model_config.model_type = Some("paraformer".into());
            config.model_config.paraformer = OfflineParaformerModelConfig {
                model: Some(path_string(dir, "model.int8.onnx")),
            };
        }
        other => {
            eprintln!("unknown family: {other}");
            std::process::exit(2);
        }
    }

    let recognizer = OfflineRecognizer::create(&config).expect("recognizer");
    let wave = Wave::read(wav).expect("wave");
    let stream = recognizer.create_stream();
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    recognizer.decode(&stream);
    let result = stream.get_result().expect("result");

    let finite = result
        .ys_log_probs
        .iter()
        .filter(|value| value.is_finite())
        .count();
    println!("family={family}");
    println!("text={}", result.text);
    println!("tokens={}", result.tokens.len());
    println!("ys_log_probs={}", result.ys_log_probs.len());
    println!("finite={finite}");
    println!("first={:?}", result.ys_log_probs.first());
    if family == "zipformer" {
        assert!(
            !result.ys_log_probs.is_empty(),
            "zipformer must expose log probs"
        );
        assert!(finite > 0, "zipformer log probs must be finite");
    } else {
        assert!(
            result.ys_log_probs.is_empty(),
            "paraformer must not expose log probs"
        );
    }
}

fn path_string(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}
