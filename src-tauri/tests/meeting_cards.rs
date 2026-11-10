//! Card aggregation, parsing, retry, extraction and reduction.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use qingmo_lib::services::meeting::asr::{ProbSource, Segment, SegmentStatus};
use qingmo_lib::services::meeting::cards::{
    extract_window, parse_cards, windows, Card, CardGenerator, CardKind, CardWindow, GenerateError,
    WindowLine,
};
use qingmo_lib::services::meeting::lang::Lang;
use qingmo_lib::services::meeting::llm::{LlmClient, LlmError, LlmErrorCode};
use qingmo_lib::services::meeting::reduce::{jaccard_similarity, reduce_cards};
use qingmo_lib::services::meeting::validate::validate_cards;
use tokio_util::sync::CancellationToken;

struct FakeClient {
    responses: Mutex<VecDeque<Result<String, LlmError>>>,
    calls: AtomicUsize,
    prompts: Mutex<Vec<String>>,
}

impl FakeClient {
    fn new(responses: Vec<Result<String, LlmError>>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            calls: AtomicUsize::new(0),
            prompts: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl LlmClient for FakeClient {
    fn generate(
        &self,
        system: &str,
        user: &str,
        _cancel: &CancellationToken,
        _deadline: Option<Instant>,
    ) -> Result<String, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.prompts
            .lock()
            .unwrap()
            .push(format!("{system}\n{user}"));
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(LlmError::new(LlmErrorCode::Protocol, "no script")))
    }
}

fn segment(start: u64, end: u64, text: &str) -> Segment {
    Segment {
        start_ms: start,
        end_ms: end,
        text: text.into(),
        tokens: Vec::new(),
        avg_prob: None,
        prob_source: ProbSource::None,
        low_confidence: false,
        speaker: None,
        status: SegmentStatus::Ok,
    }
}

fn one_window(segments: &[Segment]) -> CardWindow {
    CardWindow {
        start_ms: 0,
        end_ms: 600_000,
        lines: segments
            .iter()
            .enumerate()
            .map(|(index, segment)| WindowLine {
                segment: index,
                text: segment.text.clone(),
            })
            .collect(),
    }
}

fn card(kind: CardKind, text: &str, quote: &str, t0: u64) -> Card {
    Card::new(kind, text, quote, t0, t0 + 1000)
}

#[test]
fn windows_split_at_six_minutes_and_character_budget() {
    let segments = vec![
        segment(0, 1000, "a"),
        segment(359_000, 360_000, "b"),
        segment(360_000, 361_000, "c"),
    ];
    let split = windows(&segments);
    assert_eq!(split.len(), 2);
    assert_eq!(split[1].start_ms, 360_000);

    let long = vec![
        segment(0, 1000, &"字".repeat(800)),
        segment(1000, 2000, &"字".repeat(800)),
    ];
    assert_eq!(windows(&long).len(), 2);
}

#[test]
fn valid_json_is_clamped_to_the_window() {
    let raw = "[{\"kind\":\"decision\",\"text\":\"定了\",\"quote\":\"就这么定了\",\"t0\":9000,\"t1\":9000}]";
    let cards = parse_cards(raw, 1000, 2000).unwrap();
    assert_eq!(cards[0].t0_ms, 1999);
    assert_eq!(cards[0].t1_ms, 2000);
}

#[test]
fn missing_quote_or_t0_is_invalid() {
    assert!(parse_cards("[{\"kind\":\"risk\",\"text\":\"x\",\"t0\":1}]", 0, 10).is_err());
    assert!(parse_cards(
        "[{\"kind\":\"risk\",\"text\":\"x\",\"quote\":\"q\"}]",
        0,
        10
    )
    .is_err());
    assert!(parse_cards(
        "[{\"kind\":\"other\",\"text\":\"x\",\"quote\":\"q\",\"t0\":1}]",
        0,
        10
    )
    .is_err());
}

#[test]
fn empty_array_is_valid() {
    assert!(parse_cards("[]", 0, 10).unwrap().is_empty());
}

#[test]
fn invalid_json_retries_once_then_succeeds() {
    let segments = vec![segment(0, 1000, "我们决定明天发布")];
    let client = FakeClient::new(vec![
        Ok("not json".into()),
        Ok(
            "[{\"kind\":\"decision\",\"text\":\"明天发布\",\"quote\":\"决定明天发布\",\"t0\":500}]"
                .into(),
        ),
    ]);
    let generator = CardGenerator::new(&client);
    let cards = generator
        .generate_window(
            &one_window(&segments),
            &segments,
            Lang::Zh,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(client.calls(), 2);
}

#[test]
fn invalid_json_twice_reports_parse_failure() {
    let segments = vec![segment(0, 1000, "x")];
    let client = FakeClient::new(vec![Ok("nope".into()), Ok("still nope".into())]);
    let generator = CardGenerator::new(&client);
    let error = generator
        .generate_window(
            &one_window(&segments),
            &segments,
            Lang::Zh,
            &CancellationToken::new(),
            None,
        )
        .unwrap_err();
    assert!(matches!(error, GenerateError::Parse(_)));
    assert_eq!(client.calls(), 2);
}

#[test]
fn system_prompt_carries_no_think_and_prompt_has_timestamps() {
    let segments = vec![segment(12_000, 13_000, "你好")];
    let client = FakeClient::new(vec![Ok("[]".into())]);
    CardGenerator::new(&client)
        .generate_window(
            &one_window(&segments),
            &segments,
            Lang::Zh,
            &CancellationToken::new(),
            None,
        )
        .unwrap();
    let prompt = &client.prompts.lock().unwrap()[0];
    assert!(prompt.ends_with("/no_think") || prompt.contains("/no_think"));
    assert!(prompt.contains("t0=12000"));
}

#[test]
fn think_blocks_are_stripped_before_parsing() {
    let raw =
        " thinking先想想</think>[{\"kind\":\"risk\",\"text\":\"x\",\"quote\":\"q\",\"t0\":1}]";
    assert_eq!(parse_cards(raw, 0, 10).unwrap().len(), 1);
    assert!(parse_cards("thinking 未闭合", 0, 10).is_err());
}

#[test]
fn extractive_fallback_uses_language_tables() {
    let zh = vec![
        segment(0, 1000, "我们决定明天发布"),
        segment(1000, 2000, "小王负责跟进"),
        segment(2000, 3000, "担心可能崩"),
    ];
    let cards = extract_window(&one_window(&zh), &zh, Lang::Zh);
    assert!(cards.iter().any(|card| card.kind == CardKind::Decision));
    assert!(cards.iter().any(|card| card.kind == CardKind::Action));
    assert!(cards.iter().any(|card| card.kind == CardKind::Risk));

    let en = vec![
        segment(0, 1000, "we agreed the final plan"),
        segment(1000, 2000, "sam will follow up before tomorrow"),
        segment(2000, 3000, "the blocker might slip"),
    ];
    let cards = extract_window(&one_window(&en), &en, Lang::En);
    assert!(cards.iter().any(|card| card.kind == CardKind::Decision));
    assert!(cards.iter().any(|card| card.kind == CardKind::Action));
    assert!(cards.iter().any(|card| card.kind == CardKind::Risk));
}

#[test]
fn extractive_text_never_exceeds_two_hundred_chars() {
    let segments = vec![segment(0, 1000, &"长".repeat(500))];
    let cards = extract_window(&one_window(&segments), &segments, Lang::Zh);
    assert!(cards.iter().all(|card| card.text.chars().count() <= 200));
}

#[test]
fn missing_quote_is_marked_unverified() {
    let segments = vec![segment(0, 5000, "今天讨论发布计划")];
    let mut cards = vec![card(CardKind::Decision, "定了", "明天上线", 0)];
    let stats = validate_cards(&mut cards, &segments);
    assert!(!cards[0].verified);
    assert_eq!(stats.unverified, 1);
    assert_eq!(cards[0].confidence, None);
}

#[test]
fn numbers_must_exist_in_quote_or_source() {
    let mut segment = segment(0, 5000, "预算 120 万，需要确认");
    segment.avg_prob = Some(0.8);
    let segments = vec![segment];
    let mut good = vec![card(CardKind::Action, "确认 120 万预算", "预算 120 万", 0)];
    let stats = validate_cards(&mut good, &segments);
    assert!(good[0].verified);
    assert_eq!(stats.numeric_mismatch, 0);

    let mut bad = vec![card(CardKind::Action, "确认 130 万预算", "预算 120 万", 0)];
    let stats = validate_cards(&mut bad, &segments);
    assert!(!bad[0].verified);
    assert_eq!(stats.numeric_mismatch, 1);
}

#[test]
fn confidence_and_speaker_come_only_from_the_quoted_segment() {
    let mut first = segment(0, 5000, "发布会定在三点");
    first.avg_prob = Some(0.42);
    first.speaker = Some(3);
    let segments = vec![first];
    let mut cards = vec![card(
        CardKind::Decision,
        "发布会定在三点",
        "发布会定在三点",
        1000,
    )];
    validate_cards(&mut cards, &segments);
    assert_eq!(cards[0].confidence, Some(0.42));
    assert_eq!(cards[0].speaker, Some(3));

    let mut no_prob = segments;
    no_prob[0].avg_prob = None;
    let mut cards = vec![card(
        CardKind::Decision,
        "发布会定在三点",
        "发布会定在三点",
        1000,
    )];
    validate_cards(&mut cards, &no_prob);
    assert_eq!(cards[0].confidence, None);
}

#[test]
fn summaries_concatenate_in_time_order() {
    let cards = vec![
        card(CardKind::Summary, "后段", "后段", 5000),
        card(CardKind::Summary, "前段", "前段", 1000),
    ];
    let reduced = reduce_cards(cards, Lang::Zh);
    assert_eq!(reduced.len(), 1);
    assert_eq!(reduced[0].text, "前段\n后段");
    assert_eq!(reduced[0].t0_ms, 1000);
}

#[test]
fn similar_overlapping_cards_merge_and_keep_the_earliest_time() {
    let cards = vec![
        card(CardKind::Action, "小王负责发布", "小王负责发布", 2000),
        card(
            CardKind::Action,
            "小王负责发布计划",
            "小王负责发布计划",
            1000,
        ),
    ];
    let reduced = reduce_cards(cards, Lang::Zh);
    assert_eq!(reduced.len(), 1);
    assert_eq!(reduced[0].t0_ms, 1000);
    assert_eq!(reduced[0].text, "小王负责发布计划");
}

#[test]
fn similar_but_disjoint_cards_stay_separate() {
    let mut first = card(CardKind::Risk, "可能延期", "可能延期", 0);
    first.t1_ms = 1000;
    let mut second = card(CardKind::Risk, "可能延期", "可能延期", 9000);
    second.t1_ms = 10_000;
    assert_eq!(
        reduce_cards(vec![first.clone(), second.clone()], Lang::Zh).len(),
        2
    );
    assert!(jaccard_similarity(&first, &second, Lang::Zh) > 0.6);
}
