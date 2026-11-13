//! Window aggregation, map prompts, JSON parsing and the extractive fallback.
//!
//! One map window covers at most six minutes or 1200 characters. The LLM sees
//! only the window transcript; every returned card must carry a verbatim
//! `quote` and an absolute `t0`, otherwise the whole answer is retried once and
//! finally replaced by keyword extraction.

use std::collections::HashSet;
use std::fmt;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::asr::{Segment, SegmentStatus};
use super::lang::Lang;
use super::llm::{LlmClient, LlmError, LlmErrorCode};

pub const MAP_WINDOW_MS: u64 = 6 * 60 * 1000;
pub const MAP_WINDOW_CHARS: usize = 1200;
pub const MAX_CARDS_PER_WINDOW: usize = 40;
pub const MAX_CARD_TEXT: usize = 200;
pub const MAX_CARD_QUOTE: usize = 300;
pub const MAX_QUOTE_SPEAKER: u8 = 9;
pub const MAX_SUMMARY_CARDS: usize = 3;
pub const MAX_KEYWORD_CARDS: usize = 5;
const RETRIES: usize = 1;

const ZH_DECISION: &[&str] = &["决定", "确认", "定了", "就这么"];
const ZH_ACTION: &[&str] = &["负责", "跟进", "之前", "截止", "明天"];
const ZH_RISK: &[&str] = &["风险", "担心", "可能", "崩", "超"];

const EN_DECISION: &[&str] = &["decide", "agreed", "signed off", "final"];
const EN_ACTION: &[&str] = &["owner", "follow up", "by", "before", "deadline", "tomorrow"];
const EN_RISK: &[&str] = &["risk", "concern", "might", "blocker", "slip"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    Summary,
    Decision,
    Action,
    Risk,
}

impl CardKind {
    /// Higher wins when the local prompt has to drop cards.
    pub fn priority(self) -> u8 {
        match self {
            Self::Summary => 0,
            Self::Risk => 1,
            Self::Action => 2,
            Self::Decision => 3,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Decision => "decision",
            Self::Action => "action",
            Self::Risk => "risk",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "summary" | "摘要" => Some(Self::Summary),
            "decision" | "决定" => Some(Self::Decision),
            "action" | "行动" | "待办" => Some(Self::Action),
            "risk" | "风险" => Some(Self::Risk),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub kind: CardKind,
    pub text: String,
    pub quote: String,
    pub t0_ms: u64,
    pub t1_ms: u64,
    #[serde(default)]
    pub speaker: Option<u8>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub confidence: Option<f32>,
}

impl Card {
    pub fn new(
        kind: CardKind,
        text: impl Into<String>,
        quote: impl Into<String>,
        t0_ms: u64,
        t1_ms: u64,
    ) -> Self {
        Self {
            kind,
            text: text.into(),
            quote: quote.into(),
            t0_ms,
            t1_ms,
            speaker: None,
            verified: false,
            confidence: None,
        }
    }

    pub(crate) fn merge_from(&mut self, other: &Card) {
        self.t0_ms = self.t0_ms.min(other.t0_ms);
        self.t1_ms = self.t1_ms.max(other.t1_ms);
        if other.text.chars().count() > self.text.chars().count() {
            self.text.clone_from(&other.text);
        }
        self.verified &= other.verified;
        self.confidence = match (self.confidence, other.confidence) {
            (Some(a), Some(b)) => Some(a.min(b)),
            _ => None,
        };
        if self.speaker != other.speaker {
            self.speaker = None;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardWindow {
    pub start_ms: u64,
    pub end_ms: u64,
    /// Indices into the transcript slice, with the prompt-visible prefix.
    pub lines: Vec<WindowLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowLine {
    pub segment: usize,
    pub text: String,
}

/// Group usable segments into six-minute / 1200-character map windows.
pub fn windows(segments: &[Segment]) -> Vec<CardWindow> {
    let mut result = Vec::new();
    let mut current: Option<CardWindow> = None;

    for (index, segment) in segments.iter().enumerate() {
        if segment.status != SegmentStatus::Ok || segment.text.trim().is_empty() {
            continue;
        }
        let start = segment.start_ms;
        let length = segment.text.trim().chars().count();
        let needs_new = current.as_ref().is_some_and(|window| {
            start >= window.end_ms
                || chars_in_window(window) >= MAP_WINDOW_CHARS
                || chars_in_window(window).saturating_add(length) > MAP_WINDOW_CHARS
        });
        if needs_new {
            if let Some(window) = current.take() {
                result.push(window);
            }
        }
        let window = current.get_or_insert_with(|| CardWindow {
            start_ms: start,
            end_ms: start.saturating_add(MAP_WINDOW_MS),
            lines: Vec::new(),
        });
        let room = MAP_WINDOW_CHARS.saturating_sub(chars_in_window(window));
        if room == 0 {
            continue;
        }
        window.lines.push(WindowLine {
            segment: index,
            text: take_chars(segment.text.trim(), room),
        });
    }

    if let Some(window) = current {
        result.push(window);
    }
    result
}

fn chars_in_window(window: &CardWindow) -> usize {
    window
        .lines
        .iter()
        .map(|line| line.text.chars().count())
        .sum()
}

fn take_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn timestamp(ms: u64) -> String {
    let seconds = ms / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

fn system_prompt(lang: Lang) -> String {
    match lang {
        Lang::Zh => "你是会议纪要抽取器。只输出一个 JSON 数组，不要 Markdown 代码块，不要解释。\n\
每项必须包含：kind（summary|decision|action|risk）、text（不超过 200 字）、\
quote（转录中的逐字原文）、t0（绝对毫秒整数）、t1（可选）、speaker（可选，1-9）。\n\
规则：只从给出的转录抽取；summary 1-3 条，decision/action/risk 各 0-5 条；\
没有就输出 []；t0/t1 必须落在窗口内；quote 必须逐字照抄，不得改写。\n\
/no_think"
            .to_owned(),
        Lang::En => {
            "You extract meeting minutes. Output only a JSON array, no Markdown fence, no prose.\n\
Every item needs: kind (summary|decision|action|risk), text (<=200 chars), \
quote (verbatim transcript), t0 (absolute milliseconds), t1 (optional), speaker (optional 1-9).\n\
Rules: use only the transcript; 1-3 summary items, 0-5 each for decision/action/risk; \
output [] when empty; t0/t1 must stay inside the window; copy quote verbatim.\n\
/no_think"
                .to_owned()
        }
    }
}

fn user_prompt(window: &CardWindow, segments: &[Segment], lang: Lang) -> String {
    let mut prompt = String::new();
    match lang {
        Lang::Zh => prompt.push_str(&format!(
            "窗口 {}–{}，单位毫秒。\n",
            timestamp(window.start_ms),
            timestamp(window.end_ms)
        )),
        Lang::En => prompt.push_str(&format!(
            "Window {}–{} in absolute milliseconds.\n",
            timestamp(window.start_ms),
            timestamp(window.end_ms)
        )),
    }
    for line in &window.lines {
        let segment = &segments[line.segment];
        let speaker = segment
            .speaker
            .map(|speaker| format!("说话人{speaker} "))
            .unwrap_or_default();
        prompt.push_str(&format!(
            "[{}] t0={} {} {}\n",
            timestamp(segment.start_ms),
            segment.start_ms,
            speaker,
            line.text
        ));
    }
    prompt
}

/// Remove complete reasoning blocks. Only the two known tag pairs are
/// stripped, and an unterminated opening tag is left untouched so ordinary
/// prose containing the word "thinking" can never truncate the JSON.
pub fn strip_think(raw: &str) -> String {
    let without_tags = strip_pair(raw, "<thinking>", "</thinking>");
    strip_qwen_prefix(&without_tags)
}

fn strip_pair(raw: &str, open: &str, close: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find(open) {
        let Some(relative_end) = rest[start + open.len()..].find(close) else {
            break;
        };
        output.push_str(&rest[..start]);
        rest = &rest[start + open.len() + relative_end + close.len()..];
    }
    output.push_str(rest);
    output
}

/// Qwen3 may emit `think` ... `response` without angle brackets. Only a block
/// at the very start counts, so "I'm thinking ..." is never treated as a tag.
fn strip_qwen_prefix(raw: &str) -> String {
    let trimmed = raw.trim_start();
    let Some(rest) = trimmed.strip_prefix("think") else {
        return raw.to_owned();
    };
    if !rest.starts_with(|ch: char| ch.is_whitespace() || ch == '>') {
        return raw.to_owned();
    }
    let Some(end) = rest.find("response") else {
        return raw.to_owned();
    };
    rest[end + "response".len()..]
        .trim_start_matches(|ch: char| ch == '>' || ch.is_whitespace())
        .to_owned()
}

/// Locate the outermost JSON value. Arrays are preferred; json_object mode
/// on OpenAI-compatible endpoints returns a bare object instead.
fn json_slice(raw: &str) -> Option<&str> {
    let array = raw.find('[').zip(raw.rfind(']'));
    let object = raw.find('{').zip(raw.rfind('}'));
    let (start, end) = match (array, object) {
        (Some((start, _end)), Some((object_start, _))) if object_start < start => {
            (object_start, raw.rfind('}')?)
        }
        (Some((start, end)), _) => (start, end),
        (None, Some(pair)) => pair,
        (None, None) => return None,
    };
    (end >= start).then(|| &raw[start..=end])
}

/// Accept an array, one card object, or `{ cards | items: [...] }`.
fn parse_entries(json: &str) -> Result<Vec<RawCard>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("invalid card JSON: {error}"))?;
    let entries = match value {
        serde_json::Value::Array(entries) => entries,
        serde_json::Value::Object(mut map) => {
            let inner = map.remove("cards").or_else(|| map.remove("items"));
            match inner {
                Some(serde_json::Value::Array(entries)) => entries,
                Some(other) => vec![other],
                None => vec![serde_json::Value::Object(map)],
            }
        }
        other => vec![other],
    };
    entries
        .into_iter()
        .map(|entry| {
            serde_json::from_value(entry).map_err(|error| format!("invalid card JSON: {error}"))
        })
        .collect()
}

fn speaker<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| match value {
        serde_json::Value::Number(number) => number.as_u64().map(|number| number as u8),
        serde_json::Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }))
}

#[derive(Debug, Deserialize)]
struct RawCard {
    kind: String,
    text: String,
    quote: String,
    #[serde(alias = "t0Ms", alias = "t0_ms")]
    t0: u64,
    #[serde(default, alias = "t1Ms", alias = "t1_ms")]
    t1: Option<u64>,
    #[serde(default, deserialize_with = "speaker")]
    speaker: Option<u8>,
}

/// Parse one LLM answer and clamp every time to its window.
pub fn parse_cards(raw: &str, window_start: u64, window_end: u64) -> Result<Vec<Card>, String> {
    let raw = strip_think(raw);
    let json = json_slice(&raw).ok_or_else(|| "response has no JSON value".to_owned())?;
    let parsed = parse_entries(json)?;
    let upper = window_end.max(window_start + 1);
    let mut cards = Vec::with_capacity(parsed.len().min(MAX_CARDS_PER_WINDOW));
    for entry in parsed.into_iter().take(MAX_CARDS_PER_WINDOW) {
        let kind = CardKind::parse(&entry.kind)
            .ok_or_else(|| format!("unknown card kind: {}", entry.kind))?;
        let text = entry.text.trim();
        let quote = entry.quote.trim();
        if text.is_empty() || quote.is_empty() {
            return Err("card has an empty text or quote".to_owned());
        }
        let t0 = entry.t0.clamp(window_start, upper.saturating_sub(1));
        let t1 = entry
            .t1
            .unwrap_or(t0.saturating_add(1))
            .max(t0.saturating_add(1))
            .min(upper);
        cards.push(Card {
            kind,
            text: take_chars(text, MAX_CARD_TEXT),
            quote: take_chars(quote, MAX_CARD_QUOTE),
            t0_ms: t0,
            t1_ms: t1,
            speaker: entry
                .speaker
                .filter(|speaker| (1..=MAX_QUOTE_SPEAKER).contains(speaker)),
            verified: false,
            confidence: None,
        });
    }
    Ok(cards)
}

#[derive(Debug)]
pub enum GenerateError {
    Llm(LlmError),
    Timeout,
    Cancelled,
    Parse(String),
}

impl fmt::Display for GenerateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Llm(error) => write!(formatter, "llm: {error}"),
            Self::Timeout => formatter.write_str("window timeout"),
            Self::Cancelled => formatter.write_str("cancelled"),
            Self::Parse(message) => write!(formatter, "parse: {message}"),
        }
    }
}

impl From<LlmError> for GenerateError {
    fn from(error: LlmError) -> Self {
        Self::Llm(error)
    }
}

pub struct CardGenerator<'a> {
    client: &'a dyn LlmClient,
}

impl<'a> CardGenerator<'a> {
    pub fn new(client: &'a dyn LlmClient) -> Self {
        Self { client }
    }

    /// One map window: request, parse, retry once, then hand back the error so
    /// the caller can switch this window to keyword extraction.
    pub fn generate_window(
        &self,
        window: &CardWindow,
        segments: &[Segment],
        lang: Lang,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Vec<Card>, GenerateError> {
        let system = system_prompt(lang);
        let user = user_prompt(window, segments, lang);
        let mut last = None;
        for attempt in 0..=RETRIES {
            if cancel.is_cancelled() {
                return Err(GenerateError::Cancelled);
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(GenerateError::Timeout);
            }
            let raw = match self.client.generate(&system, &user, cancel, deadline) {
                Ok(raw) => raw,
                Err(error) if error.code == LlmErrorCode::Cancelled => {
                    return Err(GenerateError::Cancelled);
                }
                Err(error) if error.code == LlmErrorCode::Timeout => {
                    return Err(GenerateError::Timeout);
                }
                Err(error) => return Err(GenerateError::Llm(error)),
            };
            match parse_cards(&raw, window.start_ms, window.end_ms) {
                Ok(cards) => return Ok(cards),
                Err(error) => {
                    if attempt < RETRIES {
                        tracing::warn!(error = %error, "card JSON invalid, retrying");
                    }
                    last = Some(error);
                }
            }
        }
        Err(GenerateError::Parse(
            last.unwrap_or_else(|| "unknown parse failure".to_owned()),
        ))
    }
}

/// Keyword extraction for one window; always returns usable cards.
pub fn extract_window(window: &CardWindow, segments: &[Segment], lang: Lang) -> Vec<Card> {
    let usable = window
        .lines
        .iter()
        .filter_map(|line| {
            let segment = segments.get(line.segment)?;
            (segment.status == SegmentStatus::Ok && !segment.text.trim().is_empty())
                .then_some(segment)
        })
        .collect::<Vec<_>>();

    let mut cards = Vec::new();
    for segment in summary_ranking(&usable, lang)
        .into_iter()
        .take(MAX_SUMMARY_CARDS)
    {
        cards.push(from_segment(CardKind::Summary, segment));
    }
    for (kind, table) in [
        (CardKind::Decision, keywords(lang).0),
        (CardKind::Action, keywords(lang).1),
        (CardKind::Risk, keywords(lang).2),
    ] {
        let mut added = 0usize;
        for segment in &usable {
            if added >= MAX_KEYWORD_CARDS {
                break;
            }
            if matches_any(segment.text.as_str(), table) {
                cards.push(from_segment(kind, segment));
                added += 1;
            }
        }
    }
    cards.sort_by_key(|card| card.t0_ms);
    cards
}

fn keywords(
    lang: Lang,
) -> (
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
) {
    match lang {
        Lang::Zh => (ZH_DECISION, ZH_ACTION, ZH_RISK),
        Lang::En => (EN_DECISION, EN_ACTION, EN_RISK),
    }
}

fn matches_any(text: &str, table: &[&str]) -> bool {
    let lowered = text.to_lowercase();
    table.iter().any(|keyword| lowered.contains(keyword))
}

fn from_segment(kind: CardKind, segment: &Segment) -> Card {
    let text = take_chars(segment.text.trim(), MAX_CARD_TEXT);
    let mut card = Card::new(kind, text.clone(), text, segment.start_ms, segment.end_ms);
    card.speaker = segment.speaker;
    card
}

fn summary_ranking<'a>(segments: &[&'a Segment], lang: Lang) -> Vec<&'a Segment> {
    if segments.len() <= MAX_SUMMARY_CARDS {
        return segments.to_vec();
    }
    let grams = segments
        .iter()
        .map(|segment| grams(&segment.text, lang))
        .collect::<Vec<_>>();
    let size = segments.len();
    let mut similarity = vec![vec![0.0f32; size]; size];
    for left in 0..size {
        for right in (left + 1)..size {
            let score = jaccard_sets(&grams[left], &grams[right]);
            similarity[left][right] = score;
            similarity[right][left] = score;
        }
    }
    let mut scores = vec![1.0f32; size];
    for _ in 0..20 {
        let mut next = vec![0.15f32; size];
        for left in 0..size {
            let total = (0..size).map(|right| similarity[left][right]).sum::<f32>();
            if total <= f32::EPSILON {
                continue;
            }
            for right in 0..size {
                next[right] += 0.85 * similarity[right][left] / total * scores[left];
            }
        }
        scores = next;
    }
    let mut order = (0..size).collect::<Vec<_>>();
    order.sort_by(|left, right| scores[*right].total_cmp(&scores[*left]));
    let mut picked = order
        .into_iter()
        .take(MAX_SUMMARY_CARDS)
        .collect::<Vec<_>>();
    picked.sort_unstable();
    picked.into_iter().map(|index| segments[index]).collect()
}

/// Character bigrams for Chinese, word bigrams for English.
pub fn grams(text: &str, lang: Lang) -> HashSet<String> {
    match lang {
        Lang::Zh => {
            let chars = text
                .chars()
                .filter(|ch| !ch.is_whitespace() && is_word_char(*ch))
                .collect::<Vec<_>>();
            chars.windows(2).map(|pair| pair.iter().collect()).collect()
        }
        Lang::En => {
            let words = text
                .split_whitespace()
                .map(|word| {
                    word.trim_matches(|ch: char| !ch.is_alphanumeric())
                        .to_lowercase()
                })
                .filter(|word| !word.is_empty())
                .collect::<Vec<_>>();
            words.windows(2).map(|pair| pair.join(" ")).collect()
        }
    }
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric()
}

pub fn jaccard_sets(left: &HashSet<String>, right: &HashSet<String>) -> f32 {
    if left.is_empty() && right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(right).count() as f32;
    let union = left.union(right).count() as f32;
    if union <= f32::EPSILON {
        0.0
    } else {
        intersection / union
    }
}

/// Timeout chosen per local model size.
pub fn window_timeout(model_id: &str) -> Duration {
    if model_id.starts_with("qwen3-8b") {
        Duration::from_secs(360)
    } else if model_id.starts_with("qwen3-4b") {
        Duration::from_secs(240)
    } else {
        Duration::from_secs(120)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::asr::ProbSource;

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

    #[test]
    fn windows_split_on_six_minutes() {
        let segments = vec![segment(0, 1000, "a"), segment(360_000, 361_000, "b")];
        let windows = windows(&segments);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].start_ms, 0);
        assert_eq!(windows[1].start_ms, 360_000);
    }

    #[test]
    fn windows_split_on_character_budget() {
        let segments = vec![
            segment(0, 1000, &"字".repeat(700)),
            segment(2000, 3000, &"字".repeat(700)),
        ];
        let windows = windows(&segments);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].lines[0].text.chars().count(), 700);
    }

    #[test]
    fn parse_clamps_and_accepts_fences_and_think() {
        let raw = "```json\n[{\"kind\":\"decision\",\"text\":\"定了\",\"quote\":\"就这么定了\",\"t0\":9000,\"t1\":9000}]\n```";
        let cards = parse_cards(raw, 1000, 2000).unwrap();
        assert_eq!(cards[0].t0_ms, 1999);
        assert_eq!(cards[0].t1_ms, 2000);
        assert_eq!(cards[0].speaker, None);
    }

    #[test]
    fn parse_accepts_a_single_object_and_string_speaker() {
        let raw =
            "{\"kind\":\"summary\",\"text\":\"x\",\"quote\":\"q\",\"t0\":500,\"speaker\":\"2\"}";
        let cards = parse_cards(raw, 0, 1000).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].speaker, Some(2));
    }

    #[test]
    fn parse_accepts_wrapped_cards() {
        let raw = "{\"cards\":[{\"kind\":\"action\",\"text\":\"x\",\"quote\":\"q\",\"t0\":1}]}";
        let cards = parse_cards(raw, 0, 1000).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].speaker, None);
    }

    #[test]
    fn parse_rejects_json_without_cards() {
        assert!(parse_cards("{\"note\":\"x\"}", 0, 1000).is_err());
        assert!(parse_cards("no json here", 0, 1000).is_err());
    }

    #[test]
    fn missing_field_is_invalid() {
        let raw = "[{\"kind\":\"risk\",\"text\":\"x\",\"quote\":\"q\"}]";
        assert!(parse_cards(raw, 0, 1000).is_err());
    }

    #[test]
    fn complete_tagged_blocks_are_removed() {
        assert_eq!(
            strip_think("a <thinking>hidden</thinking>c"),
            "a c",
            "complete thinking blocks are stripped"
        );
        assert_eq!(
            strip_think("<thinking>x</thinking> <thinking>y</thinking> tail"),
            "  tail"
        );
    }

    #[test]
    fn qwen_prefix_is_removed_only_at_the_start() {
        assert_eq!(strip_think("think 先想想\nresponse[1]"), "[1]");
        assert_eq!(strip_think("  think\nplan\nresponse  ok"), "ok");
        assert_eq!(
            strip_think("I'm thinking about it"),
            "I'm thinking about it",
            "prose containing the word thinking is preserved"
        );
        assert_eq!(
            strip_think("[{\"text\":\"thinking out loud\"}]"),
            "[{\"text\":\"thinking out loud\"}]"
        );
    }

    #[test]
    fn unterminated_tag_is_preserved() {
        assert_eq!(
            strip_think("<thinking>never closed"),
            "<thinking>never closed"
        );
    }

    #[test]
    fn extractive_fallback_uses_both_tables() {
        let segments = vec![
            segment(0, 1000, "我们决定明天发布"),
            segment(1000, 2000, "小王负责跟进"),
            segment(2000, 3000, "担心可能崩"),
            segment(3000, 4000, "普通的一句话"),
        ];
        let window = CardWindow {
            start_ms: 0,
            end_ms: 600_000,
            lines: (0..segments.len())
                .map(|segment| WindowLine {
                    segment,
                    text: segments[segment].text.clone(),
                })
                .collect(),
        };
        let cards = extract_window(&window, &segments, Lang::Zh);
        assert!(cards.iter().any(|card| card.kind == CardKind::Decision));
        assert!(cards.iter().any(|card| card.kind == CardKind::Action));
        assert!(cards.iter().any(|card| card.kind == CardKind::Risk));
    }

    #[test]
    fn extractive_text_is_capped() {
        let segments = vec![segment(0, 1000, &"长".repeat(500))];
        let window = CardWindow {
            start_ms: 0,
            end_ms: 600_000,
            lines: vec![WindowLine {
                segment: 0,
                text: "长".repeat(500),
            }],
        };
        let cards = extract_window(&window, &segments, Lang::Zh);
        assert!(!cards.is_empty());
        assert!(cards.iter().all(|card| card.text.chars().count() <= 200));
    }

    #[test]
    fn timeout_tiers_match_model_size() {
        assert_eq!(window_timeout("qwen3-1.7b-instruct-q4km").as_secs(), 120);
        assert_eq!(window_timeout("qwen3-4b-instruct-q4km").as_secs(), 240);
        assert_eq!(window_timeout("qwen3-8b-instruct-q4km").as_secs(), 360);
    }
}
