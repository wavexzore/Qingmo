//! Fixed renderer: five sections, escaping, badges and every degradation line.

use qingmo_lib::ipc::dto::{AsrBackend, Degraded, MeetingStats, ReasonCode, RemoteProvider};
use qingmo_lib::services::meeting::asr::{Segment, SegmentStatus};
use qingmo_lib::services::meeting::cards::{Card, CardKind};
use qingmo_lib::services::meeting::lang::Lang;
use qingmo_lib::services::meeting::render::{render, RenderInput};

struct Fixture {
    title: String,
    language: Lang,
    backend: AsrBackend,
    local_model: Option<String>,
    speaker_count: Option<u8>,
    stats: MeetingStats,
    segments: Vec<Segment>,
    cards: Vec<Card>,
    degraded: Degraded,
    keep_transcript: bool,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            title: "周会".into(),
            language: Lang::Zh,
            backend: AsrBackend::Local,
            local_model: Some("paraformer-zh-en-int8".into()),
            speaker_count: None,
            stats: MeetingStats::default(),
            segments: vec![segment(1_000, "我们开始", Some(1))],
            cards: Vec::new(),
            degraded: Degraded::default(),
            keep_transcript: true,
        }
    }
}

impl Fixture {
    fn input(&self) -> RenderInput<'_> {
        RenderInput {
            title: &self.title,
            language: self.language,
            actual_backend: self.backend,
            local_model: self.local_model.as_deref(),
            speaker_count: self.speaker_count,
            stats: self.stats,
            segments: &self.segments,
            cards: &self.cards,
            degraded: self.degraded.clone(),
            keep_transcript: self.keep_transcript,
        }
    }

    fn render(&self) -> String {
        render(self.input())
    }
}

fn segment(start: u64, text: &str, speaker: Option<u8>) -> Segment {
    let mut segment = Segment::failed(start, start + 1_000);
    segment.status = SegmentStatus::Ok;
    segment.text = text.into();
    segment.speaker = speaker;
    segment
}

fn low_segment(start: u64, text: &str) -> Segment {
    let mut segment = segment(start, text, Some(1));
    segment.avg_prob = Some(0.2);
    segment.low_confidence = true;
    segment
}

fn card(kind: CardKind, text: &str, quote: &str) -> Card {
    let mut card = Card::new(kind, text, quote, 2_000, 3_000);
    card.speaker = Some(1);
    card
}

fn assert_order(text: &str, needles: &[&str]) {
    let mut cursor = 0;
    for needle in needles {
        let index = text[cursor..]
            .find(needle)
            .unwrap_or_else(|| panic!("missing {needle}"))
            + cursor;
        assert!(index >= cursor);
        cursor = index + needle.len();
    }
}

#[test]
fn chinese_template_has_all_five_sections_in_order() {
    let output = Fixture::default().render();
    assert_order(
        &output,
        &[
            "# 周会",
            "> 本地转写",
            "## 摘要",
            "## 决议",
            "## 待办",
            "## 风险",
            "## 转录",
        ],
    );
}

#[test]
fn english_template_is_complete() {
    let fixture = Fixture {
        title: "Weekly".into(),
        language: Lang::En,
        segments: vec![segment(1_000, "hello", Some(1))],
        backend: AsrBackend::Remote(RemoteProvider::Deepgram),
        speaker_count: Some(2),
        ..Fixture::default()
    };
    let output = fixture.render();
    assert_order(
        &output,
        &[
            "# Weekly",
            "> Remote transcription · Deepgram",
            "## Summary",
            "## Decisions",
            "## Actions",
            "## Risks",
            "## Transcript",
        ],
    );
    assert!(!output.contains("segments failed"));
}

#[test]
fn meta_follows_backend_model_speakers_and_failures() {
    let mut fixture = Fixture {
        speaker_count: Some(2),
        ..Fixture::default()
    };
    fixture.stats.failed_segments = 3;
    let output = fixture.render();
    assert!(output.contains("本地转写 · Paraformer 中英 · int8"));
    assert!(output.contains("已分离（2 人）"));
    assert!(output.contains("3 段识别失败"));

    fixture.backend = AsrBackend::Remote(RemoteProvider::Groq);
    fixture.speaker_count = None;
    let output = fixture.render();
    assert!(output.contains("远程转写 · Groq"));
    assert!(output.contains("远程 · 无说话人标签"));
}

#[test]
fn transcript_can_be_disabled_without_losing_the_section() {
    let fixture = Fixture {
        keep_transcript: false,
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(output.contains("## 转录\n\n已关闭转录正文"));
    assert!(!output.contains("我们开始"));
}

#[test]
fn every_markdown_control_character_is_escaped() {
    let fixture = Fixture {
        title: "a_b*c[d]".into(),
        segments: vec![segment(1_000, "<x> & `y` [z] \\", Some(1))],
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(output.starts_with("# a\\_b\\*c\\[d\\]"));
    assert!(output.contains("\\<x> \\& \\`y\\` \\[z\\] \\\\"));
}

#[test]
fn cards_render_quotes_badges_and_low_confidence() {
    let mut unverified = card(CardKind::Decision, "上线", "我们开始");
    unverified.confidence = Some(0.2);
    let mut verified = card(CardKind::Action, "补文档", "没有引用");
    verified.verified = true;
    let fixture = Fixture {
        cards: vec![unverified, verified],
        segments: vec![
            segment(1_000, "我们开始", Some(1)),
            low_segment(5_000, "没有引用"),
        ],
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(output.contains("`待核` ⚠ 低置信"));
    assert!(output.contains("`已核` ⚠ 低置信"));
    assert!(output.contains("  > 我们开始"));
}

#[test]
fn no_probability_model_has_no_low_confidence_badge() {
    let mut card = card(CardKind::Summary, "摘要", "我们开始");
    card.verified = true;
    let fixture = Fixture {
        cards: vec![card],
        segments: vec![segment(1_000, "我们开始", Some(1))],
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(!output.contains("低置信"));
}

#[test]
fn failed_segments_are_placeholders() {
    let fixture = Fixture {
        segments: vec![
            Segment::failed(65_000, 66_000),
            segment(66_000, "继续", Some(1)),
        ],
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(output.contains("[00:01:05] [识别失败]"));
    assert!(output.contains("[00:01:06] 🟢 说话人 1：继续"));
}

#[test]
fn silence_renders_five_dashes_and_never_claims_summary_failure() {
    let fixture = Fixture {
        segments: Vec::new(),
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(output.starts_with("# 周会\n\n未检测到语音，转录为空"));
    assert!(!output.contains("未生成摘要"));
    assert_eq!(output.matches("## ").count(), 5);
    assert_eq!(output.matches("\n—\n").count(), 5);
}

#[test]
fn partial_decode_reports_minutes_and_sub_minute() {
    let fixture = Fixture {
        degraded: Degraded {
            partial_decode: true,
            partial_until_ms: Some(90_000),
            ..Degraded::default()
        },
        ..Fixture::default()
    };
    assert!(fixture.render().contains("只转写了前 1 分钟"));
    let fixture = Fixture {
        degraded: Degraded {
            partial_decode: true,
            partial_until_ms: Some(30_000),
            ..Degraded::default()
        },
        ..Fixture::default()
    };
    assert!(fixture.render().contains("只转写了前 <1 分钟"));
}

#[test]
fn failure_share_without_decode_truncation_has_no_truncation_line() {
    let mut fixture = Fixture::default();
    fixture.stats.failed_segments = 2;
    assert!(!fixture.render().contains("只转写了前"));
}

#[test]
fn all_degradation_lines_are_visible() {
    let fixture = Fixture {
        degraded: Degraded {
            llm_model_missing: true,
            llm_unconfigured: true,
            llm_budget_exceeded: true,
            partial_decode: true,
            partial_until_ms: Some(120_000),
            remote_fallback: true,
            remote_key_missing: true,
            remote_last_error: Some(ReasonCode::RemoteAuth),
            speaker_degraded: true,
            high_memory_model: true,
            slow_machine: true,
            ..Degraded::default()
        },
        ..Fixture::default()
    };
    let output = fixture.render();
    for line in [
        "远程转写失败，已回退本地",
        "密钥无效",
        "未配置远程密钥，已用本地",
        "本地摘要模型未就绪",
        "未配置远程摘要",
        "内存不足，未生成抽象摘要",
        "未分离说话人",
        "只转写了前 2 分钟",
        "高内存模型 · 峰值约 1.2 GB",
        "本机较慢，可改用远程",
    ] {
        assert!(output.contains(line), "{line}");
    }
    assert!(!output.contains("部分片段未分离说话人"));
}

#[test]
fn speaker_colors_cover_eight_then_nine_plus() {
    let fixture = Fixture {
        segments: vec![
            segment(0, "一", Some(1)),
            segment(1_000, "八", Some(8)),
            segment(2_000, "九", Some(9)),
            segment(3_000, "无", None),
        ],
        ..Fixture::default()
    };
    let output = fixture.render();
    assert!(output.contains("🟢 说话人 1：一"));
    assert!(output.contains("⚪ 说话人 8：八"));
    assert!(output.contains("⚫ 说话人 9+：九"));
    assert!(output.contains("说话人 —：无"));
}

#[test]
fn cards_are_grouped_by_kind_in_fixed_order() {
    let fixture = Fixture {
        cards: vec![
            card(CardKind::Risk, "风险项", "我们开始"),
            card(CardKind::Decision, "决议项", "我们开始"),
            card(CardKind::Action, "待办项", "我们开始"),
            card(CardKind::Summary, "摘要项", "我们开始"),
        ],
        ..Fixture::default()
    };
    let output = fixture.render();
    assert_order(&output, &["摘要项", "决议项", "待办项", "风险项"]);
}

#[test]
fn empty_cards_use_em_dashes_but_summary_says_not_generated() {
    let output = Fixture::default().render();
    let summary = output
        .split("## 摘要")
        .nth(1)
        .unwrap()
        .split("## 决议")
        .next()
        .unwrap();
    assert!(summary.contains("未生成摘要"));
    let decisions = output
        .split("## 决议")
        .nth(1)
        .unwrap()
        .split("## 待办")
        .next()
        .unwrap();
    assert_eq!(decisions.trim(), "—");
}
