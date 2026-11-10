//! Local llama.cpp guards: GGUF header, GPU layers, prompt truncation.

use std::time::{Duration, Instant};

use qingmo_lib::services::meeting::llm::{LlmClient, LlmErrorCode};
use qingmo_lib::services::meeting::llm_local::{
    check_gguf, gpu_layers, truncate_to_budget, with_no_think, LocalLlm, LocalLlmSpec,
    INPUT_TOKEN_BUDGET, N_BATCH, N_CTX,
};
use qingmo_lib::services::meeting::runtime::Accel;
use tokio_util::sync::CancellationToken;

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-llm-local-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

#[test]
fn context_constants_follow_the_design() {
    assert_eq!(N_CTX, 4096);
    assert_eq!(N_BATCH, 128);
    assert_eq!(INPUT_TOKEN_BUDGET, 4096 - 1024 - 256);
}

#[test]
fn gguf_header_is_checked_before_loading() {
    let path = temp("bad.gguf");
    std::fs::write(&path, b"NOPE").unwrap();
    assert_eq!(
        check_gguf(&path).unwrap_err().code,
        LlmErrorCode::ModelInvalid
    );

    let mut short = vec![0u8; 512];
    short[..4].copy_from_slice(b"GGUF");
    std::fs::write(&path, &short).unwrap();
    assert_eq!(
        check_gguf(&path).unwrap_err().code,
        LlmErrorCode::ModelInvalid
    );

    let mut bad_version = vec![0u8; 2048];
    bad_version[..4].copy_from_slice(b"GGUF");
    bad_version[4..8].copy_from_slice(&9u32.to_le_bytes());
    std::fs::write(&path, &bad_version).unwrap();
    assert_eq!(
        check_gguf(&path).unwrap_err().code,
        LlmErrorCode::ModelInvalid
    );

    let mut good = vec![0u8; 2048];
    good[..4].copy_from_slice(b"GGUF");
    good[4..8].copy_from_slice(&3u32.to_le_bytes());
    std::fs::write(&path, &good).unwrap();
    check_gguf(&path).unwrap();

    let missing = temp("missing.gguf");
    let _ = std::fs::remove_file(&missing);
    assert_eq!(
        check_gguf(&missing).unwrap_err().code,
        LlmErrorCode::ModelMissing
    );
}

#[test]
fn gpu_layers_are_off_on_windows_and_cpu() {
    assert_eq!(gpu_layers(Accel::Cpu, false), 0);
    assert_eq!(gpu_layers(Accel::Metal, false), 999);
    assert_eq!(gpu_layers(Accel::Metal, true), 0);
}

#[test]
fn no_think_is_appended_once() {
    assert!(with_no_think("system").ends_with("/no_think"));
    assert_eq!(with_no_think("system\n/no_think"), "system\n/no_think");
}

#[test]
fn truncation_keeps_head_and_tail_within_budget() {
    let text = format!("HEAD-{}-TAIL", "中".repeat(1000));
    let output = truncate_to_budget(&text, 80, |value| value.chars().count());
    assert!(output.chars().count() <= 80);
    assert!(output.starts_with("HEAD-"));
    assert!(output.ends_with("TAIL"));
}

#[test]
fn truncation_is_a_noop_when_the_text_fits() {
    assert_eq!(
        truncate_to_budget("short", 100, |value| value.len()),
        "short"
    );
    assert_eq!(truncate_to_budget("short", 0, |value| value.len()), "");
}

#[test]
fn metadata_check_does_not_read_the_whole_file_for_missing_paths() {
    assert_eq!(
        check_gguf(std::path::Path::new("/nonexistent/x.gguf"))
            .unwrap_err()
            .code,
        LlmErrorCode::ModelMissing
    );
}

#[test]
#[ignore = "needs MEETING_TEST_LLM pointing at a Qwen3 GGUF"]
fn real_gguf_generates_json_with_the_chat_template() {
    let path = std::env::var("MEETING_TEST_LLM").expect("MEETING_TEST_LLM");
    let model = LocalLlm::open(
        &LocalLlmSpec::new("qwen3-1.7b-instruct-q4km", path),
        2,
        Accel::Cpu,
    )
    .unwrap();
    let raw = model
        .generate(
            "你是会议纪要抽取器，只输出 JSON 数组。",
            "转录：[00:00:00] 我们决定明天发布。",
            &CancellationToken::new(),
            Some(Instant::now() + Duration::from_secs(600)),
        )
        .unwrap();
    assert!(raw.contains('['), "{raw}");
    assert!(raw.contains(']'), "{raw}");

    // Force the token-budget truncation path with a transcript far beyond n_ctx.
    let long = format!(
        "[00:00:00] {} 决定明天发布。",
        "这是一段很长的会议转录。".repeat(800)
    );
    let raw = model
        .generate(
            "你是会议纪要抽取器，只输出 JSON 数组。",
            &long,
            &CancellationToken::new(),
            Some(Instant::now() + Duration::from_secs(600)),
        )
        .unwrap();
    assert!(raw.contains('['), "{raw}");
}
