//! Deterministic card reduction.
//!
//! Summary cards concatenate in time order. Every other kind merges when its
//! two-gram Jaccard similarity is above 0.6 and the two time ranges overlap;
//! the earliest timestamp survives.

use super::cards::{grams, jaccard_sets, Card, CardKind};
use super::lang::Lang;

pub const SIMILARITY_THRESHOLD: f32 = 0.6;

fn similarity(left: &Card, right: &Card, lang: Lang) -> f32 {
    jaccard_similarity(left, right, lang)
}

/// Public for tests and diagnostics: two-gram Jaccard similarity of card text.
pub fn jaccard_similarity(left: &Card, right: &Card, lang: Lang) -> f32 {
    jaccard_sets(&grams(&left.text, lang), &grams(&right.text, lang))
}

fn overlaps(left: &Card, right: &Card) -> bool {
    left.t0_ms <= right.t1_ms && right.t0_ms <= left.t1_ms
}

/// Merge summaries into one chronological card and deduplicate/merge the rest.
pub fn reduce_cards(mut cards: Vec<Card>, lang: Lang) -> Vec<Card> {
    let mut summaries = Vec::new();
    let mut others = Vec::new();
    for card in cards.drain(..) {
        if card.kind == CardKind::Summary {
            summaries.push(card);
        } else {
            others.push(card);
        }
    }
    summaries.sort_by_key(|card| card.t0_ms);

    let mut reduced = Vec::new();
    if !summaries.is_empty() {
        let mut merged = summaries[0].clone();
        merged.speaker = None;
        for summary in &summaries[1..] {
            merged.text.push('\n');
            merged.text.push_str(&summary.text);
            merged.t1_ms = merged.t1_ms.max(summary.t1_ms);
            merged.verified &= summary.verified;
            merged.confidence = match (merged.confidence, summary.confidence) {
                (Some(left), Some(right)) => Some(left.min(right)),
                _ => None,
            };
            if merged.quote.is_empty() {
                merged.quote.clone_from(&summary.quote);
            }
        }
        reduced.push(merged);
    }

    others.sort_by(|left, right| {
        left.kind
            .priority()
            .cmp(&right.kind.priority())
            .then(left.t0_ms.cmp(&right.t0_ms))
    });

    let mut kept: Vec<Card> = Vec::new();
    'next: for card in others {
        for existing in &mut kept {
            if existing.kind != card.kind {
                continue;
            }
            if similarity(existing, &card, lang) > SIMILARITY_THRESHOLD && overlaps(existing, &card)
            {
                existing.merge_from(&card);
                continue 'next;
            }
        }
        kept.push(card);
    }

    reduced.extend(kept);
    reduced
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(kind: CardKind, text: &str, quote: &str, t0: u64) -> Card {
        Card::new(kind, text, quote, t0, t0 + 1000)
    }

    #[test]
    fn similar_overlapping_cards_merge_to_the_earliest_time() {
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
        let reduced = reduce_cards(vec![first, second], Lang::Zh);
        assert_eq!(reduced.len(), 2);
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
        assert_eq!(reduced[0].t1_ms, 6000);
    }

    #[test]
    fn identical_quotes_without_overlap_stay_separate() {
        let cards = vec![
            card(CardKind::Decision, "定了", "就这么定了", 0),
            card(CardKind::Decision, "定了", "就这么定了", 9000),
        ];
        assert_eq!(reduce_cards(cards, Lang::Zh).len(), 2);
    }
}
