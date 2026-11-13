//! Quote and number back-checking.
//!
//! A card is only `verified` when its quote still exists verbatim (after
//! whitespace/punctuation normalization) and every number in its text can be
//! found in that quote or its source segment. `confidence` is copied from the
//! quoted segment and never invented.

use std::collections::{BTreeSet, HashSet};

use super::asr::{Segment, SegmentStatus};
use super::cards::Card;
use super::lang::is_cjk;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ValidationStats {
    pub unverified: u32,
    pub missing_quote: u32,
    pub numeric_mismatch: u32,
}

#[derive(Debug)]
struct View<'a> {
    segment: &'a Segment,
    normalized: String,
}

impl<'a> View<'a> {
    fn new(segment: &'a Segment) -> Self {
        Self {
            segment,
            normalized: normalize(&segment.text),
        }
    }
}

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric() || is_cjk(*ch))
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_cjk_numeral(ch: char) -> bool {
    matches!(
        ch,
        '零' | '〇'
            | '一'
            | '二'
            | '三'
            | '四'
            | '五'
            | '六'
            | '七'
            | '八'
            | '九'
            | '十'
            | '百'
            | '千'
            | '万'
            | '亿'
            | '两'
    )
}

/// Numeric tokens. ASCII digits keep their decimal point and drop thousands
/// separators; CJK numeral runs stay whole. Membership is exact, so "5" never
/// matches "50" and "1.5" never matches "15".
fn numeric_tokens(text: &str) -> HashSet<String> {
    let mut result = HashSet::new();
    let mut ascii = String::new();
    let mut han = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            if !han.is_empty() {
                result.insert(std::mem::take(&mut han));
            }
            ascii.push(ch);
        } else if ch == ',' && !ascii.is_empty() {
            // Thousands separator: 1,000 and 1000 are the same token.
        } else if ch == '.' && !ascii.is_empty() && !ascii.ends_with('.') {
            ascii.push('.');
        } else {
            if !ascii.is_empty() {
                result.insert(std::mem::take(&mut ascii));
            }
            if is_cjk_numeral(ch) {
                han.push(ch);
            } else if !han.is_empty() {
                result.insert(std::mem::take(&mut han));
            }
        }
    }
    if !ascii.is_empty() {
        result.insert(ascii);
    }
    if !han.is_empty() {
        result.insert(han);
    }
    result.retain(|token| !token.is_empty());
    result
}

fn locate<'a>(card: &Card, views: &[View<'a>]) -> Option<Vec<usize>> {
    let quote = normalize(&card.quote);
    if quote.is_empty() {
        return None;
    }
    // A short quote can occur several times. Prefer a segment that overlaps
    // the card's own time range, then the nearest start, instead of always
    // snapping to the first occurrence in the transcript.
    let candidates = views
        .iter()
        .enumerate()
        .filter(|(_, view)| view.normalized.contains(&quote))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if !candidates.is_empty() {
        let best = candidates
            .into_iter()
            .min_by_key(|index| {
                let segment = views[*index].segment;
                if segment.start_ms <= card.t0_ms && card.t0_ms < segment.end_ms {
                    0
                } else {
                    segment.start_ms.abs_diff(card.t0_ms)
                }
            })
            .expect("candidates is non-empty");
        return Some(vec![best]);
    }

    // A quote may straddle two adjacent segments inside the card time range.
    let mut indices = (0..views.len())
        .filter(|index| {
            let segment = views[*index].segment;
            segment.start_ms < card.t1_ms.max(card.t0_ms + 1)
                && card.t0_ms < segment.end_ms.max(segment.start_ms + 1)
        })
        .collect::<Vec<_>>();
    if indices.len() < 2 {
        return None;
    }
    indices.sort_unstable();
    let joined = indices
        .iter()
        .map(|index| views[*index].normalized.as_str())
        .collect::<String>();
    joined.contains(&quote).then_some(indices)
}

fn numbers_backed(card: &Card, indices: &[usize], views: &[View<'_>]) -> bool {
    let wanted = numeric_tokens(&card.text);
    if wanted.is_empty() {
        return true;
    }
    let mut haystack = numeric_tokens(&card.quote);
    for index in indices {
        haystack.extend(numeric_tokens(&views[*index].segment.text));
    }
    wanted.is_subset(&haystack)
}

/// Return the new unverified count; card order is preserved.
pub fn validate_cards(cards: &mut [Card], segments: &[Segment]) -> ValidationStats {
    let views = segments
        .iter()
        .filter(|segment| segment.status == SegmentStatus::Ok)
        .map(View::new)
        .collect::<Vec<_>>();
    let mut stats = ValidationStats::default();

    for card in cards {
        let Some(indices) = locate(card, &views) else {
            card.verified = false;
            card.confidence = None;
            card.speaker = None;
            stats.unverified += 1;
            stats.missing_quote += 1;
            continue;
        };

        let first = views[*indices.first().expect("locate returns at least one index")].segment;
        if card.t0_ms < first.start_ms || card.t0_ms >= first.end_ms {
            card.t0_ms = first.start_ms;
        }
        card.t0_ms = card.t0_ms.max(first.start_ms);
        card.t1_ms = card.t1_ms.min(first.end_ms).max(card.t0_ms + 1);
        if card.speaker.is_none() {
            let speakers = indices
                .iter()
                .map(|index| views[*index].segment.speaker)
                .collect::<BTreeSet<_>>();
            card.speaker = if speakers.len() == 1 {
                speakers.into_iter().next().flatten()
            } else {
                None
            };
        }

        let confidence = indices
            .iter()
            .map(|index| views[*index].segment.avg_prob)
            .try_fold(None::<f32>, |acc, prob| {
                let prob = prob?;
                Some(Some(acc.map_or(prob, |value: f32| value.min(prob))))
            });
        card.confidence = confidence.flatten();

        if numbers_backed(card, &indices, &views) {
            card.verified = true;
        } else {
            card.verified = false;
            stats.unverified += 1;
            stats.numeric_mismatch += 1;
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::asr::{ProbSource, SegmentStatus};
    use crate::services::meeting::cards::CardKind;

    fn segment(text: &str, avg: Option<f32>) -> Segment {
        Segment {
            start_ms: 0,
            end_ms: 5000,
            text: text.into(),
            tokens: Vec::new(),
            avg_prob: avg,
            prob_source: if avg.is_some() {
                ProbSource::Token
            } else {
                ProbSource::None
            },
            low_confidence: false,
            speaker: Some(2),
            status: SegmentStatus::Ok,
        }
    }

    #[test]
    fn missing_quote_is_unverified_and_has_no_confidence() {
        let segments = vec![segment("今天讨论发布计划", Some(0.9))];
        let mut cards = vec![Card::new(CardKind::Decision, "定了", "明天上线", 0, 1000)];
        let stats = validate_cards(&mut cards, &segments);
        assert!(!cards[0].verified);
        assert_eq!(cards[0].confidence, None);
        assert_eq!(stats.missing_quote, 1);
    }

    #[test]
    fn confidence_is_copied_from_the_quoted_segment() {
        let segments = vec![segment("发布会定在三点", Some(0.42))];
        let mut cards = vec![Card::new(
            CardKind::Decision,
            "发布会定在三点",
            "发布会定在三点",
            1000,
            2000,
        )];
        let stats = validate_cards(&mut cards, &segments);
        assert!(cards[0].verified);
        assert_eq!(cards[0].confidence, Some(0.42));
        assert_eq!(cards[0].speaker, Some(2));
        assert_eq!(stats.unverified, 0);
    }

    #[test]
    fn number_outside_the_quote_is_pending() {
        let segments = vec![segment("预算需要确认", Some(0.8))];
        let mut cards = vec![Card::new(
            CardKind::Action,
            "预算 120 万",
            "预算需要确认",
            0,
            1000,
        )];
        let stats = validate_cards(&mut cards, &segments);
        assert!(!cards[0].verified);
        assert_eq!(stats.numeric_mismatch, 1);
    }

    #[test]
    fn number_from_the_source_segment_passes() {
        let segments = vec![segment("预算 120 万，需要确认", Some(0.8))];
        let mut cards = vec![Card::new(
            CardKind::Action,
            "确认 120 万预算",
            "预算 120 万",
            0,
            1000,
        )];
        let stats = validate_cards(&mut cards, &segments);
        assert!(cards[0].verified);
        assert_eq!(stats.numeric_mismatch, 0);
    }

    #[test]
    fn numbers_must_match_exactly_not_as_substrings() {
        let segments = vec![segment("增长 50%，预算 13 万", Some(0.8))];
        let mut substring = vec![Card::new(
            CardKind::Risk,
            "增长 5%，预算 3 万",
            "增长 50%，预算 13 万",
            0,
            1000,
        )];
        let stats = validate_cards(&mut substring, &segments);
        assert!(!substring[0].verified);
        assert_eq!(stats.numeric_mismatch, 1);

        let mut decimal = vec![Card::new(
            CardKind::Risk,
            "增长 1.5%，预算 13 万",
            "增长 50%，预算 13 万",
            0,
            1000,
        )];
        let stats = validate_cards(&mut decimal, &segments);
        assert!(!decimal[0].verified);
        assert_eq!(stats.numeric_mismatch, 1);
    }

    #[test]
    fn duplicate_quotes_prefer_the_card_time_range() {
        let mut first = segment("没问题", Some(0.9));
        first.start_ms = 0;
        first.end_ms = 5000;
        first.speaker = Some(2);
        let mut second = segment("没问题", Some(0.9));
        second.start_ms = 60_000;
        second.end_ms = 65_000;
        second.speaker = Some(3);
        let segments = vec![first, second];
        let mut cards = vec![Card::new(
            CardKind::Decision,
            "没问题",
            "没问题",
            61_000,
            62_000,
        )];
        validate_cards(&mut cards, &segments);
        assert_eq!(
            cards[0].t0_ms, 61_000,
            "a timestamp inside the matched segment is kept"
        );
        assert_eq!(cards[0].speaker, Some(3));
    }

    #[test]
    fn mixed_speakers_across_a_spanning_quote_are_none() {
        let mut first = segment("前半句", Some(0.9));
        first.start_ms = 0;
        first.end_ms = 1000;
        first.speaker = Some(2);
        let mut second = segment("后半句", Some(0.9));
        second.start_ms = 1000;
        second.end_ms = 2000;
        second.speaker = Some(3);
        let segments = vec![first, second];
        let mut cards = vec![Card::new(
            CardKind::Decision,
            "跨段",
            "前半句后半句",
            0,
            2000,
        )];
        validate_cards(&mut cards, &segments);
        assert_eq!(cards[0].speaker, None);
    }

    #[test]
    fn whitespace_and_punctuation_normalization_matches() {
        let segments = vec![segment("OK，就这么定了。", None)];
        let mut cards = vec![Card::new(
            CardKind::Decision,
            "定了",
            "OK 就这么定了",
            0,
            1000,
        )];
        validate_cards(&mut cards, &segments);
        assert!(cards[0].verified);
        assert_eq!(cards[0].confidence, None);
    }
}
