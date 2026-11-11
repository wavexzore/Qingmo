//! Reachable degradation reaches the rendered body and never blocks output.

use qingmo_lib::ipc::dto::{AsrBackend, Degraded, MeetingStats};
use qingmo_lib::services::meeting::asr::{Segment, SegmentStatus};
use qingmo_lib::services::meeting::cards::Card;
use qingmo_lib::services::meeting::lang::Lang;
use qingmo_lib::services::meeting::render::{render, RenderInput};

fn segment(start: u64, text: &str) -> Segment {
    let mut segment = Segment::failed(start, start + 1_000);
    segment.status = SegmentStatus::Ok;
    segment.text = text.into();
    segment
}

fn render_with(segments: &[Segment], cards: &[Card], degraded: Degraded) -> String {
    render(RenderInput {
        title: "降级",
        language: Lang::Zh,
        actual_backend: AsrBackend::Local,
        local_model: Some("paraformer-zh-en-int8"),
        speaker_count: None,
        stats: MeetingStats::default(),
        segments,
        cards,
        degraded,
        keep_transcript: true,
    })
}

#[test]
fn every_llm_degradation_keeps_the_transcript() {
    let segments = vec![segment(0, "仍然有转录")];
    let output = render_with(
        &segments,
        &[],
        Degraded {
            llm_model_missing: true,
            llm_unconfigured: true,
            llm_budget_exceeded: true,
            llm_failed: true,
            ..Degraded::default()
        },
    );
    assert!(output.contains("仍然有转录"));
    assert!(output.contains("本地摘要模型未就绪"));
    assert!(output.contains("未配置远程摘要"));
    assert!(output.contains("内存不足"));
    assert!(output.contains("摘要模型失败或超时"));
    assert!(output.contains("未生成摘要"));
}

#[test]
fn remote_fallback_and_reason_are_both_visible() {
    let segments = vec![segment(0, "本地完成")];
    let output = render_with(
        &segments,
        &[],
        Degraded {
            remote_fallback: true,
            remote_last_error: Some(qingmo_lib::ipc::dto::ReasonCode::RemoteQuota),
            ..Degraded::default()
        },
    );
    assert!(output.contains("远程转写失败，已回退本地"));
    assert!(output.contains("配额不足"));
}

#[test]
fn speaker_degradation_never_removes_segments() {
    let segments = vec![segment(0, "无标签也保留")];
    let output = render_with(
        &segments,
        &[],
        Degraded {
            speaker_degraded: true,
            ..Degraded::default()
        },
    );
    assert!(output.contains("未分离说话人"));
    assert!(output.contains("无标签也保留"));
}

#[test]
fn high_memory_and_slow_machine_are_visible() {
    let segments = vec![segment(0, "x")];
    let output = render_with(
        &segments,
        &[],
        Degraded {
            high_memory_model: true,
            slow_machine: true,
            ..Degraded::default()
        },
    );
    assert!(output.contains("高内存模型 · 峰值约 1.2 GB"));
    assert!(output.contains("本机较慢"));
}
