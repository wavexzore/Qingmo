//! Cross-chunk speaker stitching for remote ASR.
//!
//! Remote providers number speakers per response. Two seconds of audio overlap
//! let a new chunk inherit the previous chunk's global ids before duplicate
//! words are dropped; genuinely new voices get the next id, and everything past
//! eight collapses into `9` (`9+`).

use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::asr::Segment;

pub const MAX_SPEAKERS: u8 = 8;
pub const OVERFLOW_SPEAKER: u8 = 9;
pub const OVERLAP_MS: u64 = 2_000;

/// Absolute diarization turn; one global speaker id per turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeakerTurn {
    pub t0_ms: u64,
    pub t1_ms: u64,
    pub speaker: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiarizeError {
    Cancelled,
    Failed {
        message: String,
        /// Turns already produced before the failing subwindow.
        turns: Vec<SpeakerTurn>,
    },
}

/// Two ONNX files resolved from the speaker-pack manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerModels {
    pub segmentation: PathBuf,
    pub embedding: PathBuf,
}

/// Injected seam so pipeline tests never need the 30 MB real models.
pub trait DiarizationEngine: Send {
    fn push_window(
        &mut self,
        samples: &[f32],
        subwindow_start_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError>;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SpeakerJoinStats {
    pub tagged: usize,
    pub unmatched: usize,
    pub speakers: u8,
}

/// One label per segment: longest absolute overlap, ties keep the later turn.
pub fn join(segments: &mut [Segment], turns: &[SpeakerTurn]) -> SpeakerJoinStats {
    let mut stats = SpeakerJoinStats::default();
    for segment in segments.iter_mut() {
        let best = turns
            .iter()
            .filter_map(|turn| {
                let overlap = turn
                    .t1_ms
                    .min(segment.end_ms)
                    .saturating_sub(turn.t0_ms.max(segment.start_ms));
                (overlap > 0).then_some((overlap, turn.speaker))
            })
            .max_by_key(|(overlap, _)| *overlap);
        match best {
            Some((_, speaker)) => {
                segment.speaker = Some(speaker);
                stats.tagged += 1;
                stats.speakers = stats.speakers.max(speaker);
            }
            None => {
                segment.speaker = None;
                stats.unmatched += 1;
            }
        }
    }
    stats
}

#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub prob: Option<f32>,
    pub speaker: Option<u8>,
}

#[derive(Debug, Default)]
pub struct SpeakerStitcher {
    next: u8,
    map: std::collections::HashMap<u8, u8>,
}

impl SpeakerStitcher {
    pub fn new() -> Self {
        Self::default()
    }

    fn assign(&mut self, local: u8) -> u8 {
        if let Some(global) = self.map.get(&local) {
            return *global;
        }
        let global = self.next.saturating_add(1).min(OVERFLOW_SPEAKER);
        self.map.insert(local, global);
        if global < OVERFLOW_SPEAKER {
            self.next = global;
        }
        global
    }

    /// Inherit ids from the previous tail, then map the new chunk.
    pub fn stitch(&mut self, previous_tail: &[Word], words: &mut [Word], chunk_start_ms: u64) {
        let overlap_end = chunk_start_ms.saturating_add(OVERLAP_MS);
        for word in words.iter() {
            if word.start_ms >= overlap_end {
                continue;
            }
            let Some(local) = word.speaker else {
                continue;
            };
            let Some(previous) = previous_tail
                .iter()
                .filter(|previous| previous.speaker.is_some())
                .max_by_key(|previous| overlap(word, previous))
            else {
                continue;
            };
            if overlap(word, previous) > 0 {
                if let Some(global) = previous.speaker {
                    self.map.entry(local).or_insert(global);
                }
            }
        }
        for word in words.iter_mut() {
            if let Some(local) = word.speaker {
                word.speaker = Some(self.assign(local));
            }
        }
    }
}

fn overlap(left: &Word, right: &Word) -> u64 {
    left.end_ms
        .min(right.end_ms)
        .saturating_sub(left.start_ms.max(right.start_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(start: u64, speaker: Option<u8>) -> Word {
        Word {
            start_ms: start,
            end_ms: start + 500,
            text: "w".into(),
            prob: Some(0.9),
            speaker,
        }
    }

    #[test]
    fn global_ids_start_at_one_and_are_stable() {
        let mut stitcher = SpeakerStitcher::new();
        let mut words = vec![word(0, Some(0)), word(600, Some(0)), word(1200, Some(1))];
        stitcher.stitch(&[], &mut words, 0);
        assert_eq!(words[0].speaker, Some(1));
        assert_eq!(words[1].speaker, Some(1));
        assert_eq!(words[2].speaker, Some(2));
    }

    #[test]
    fn overlap_inherits_the_previous_global_id() {
        let mut stitcher = SpeakerStitcher::new();
        let mut first = vec![word(299_800, Some(4))];
        stitcher.stitch(&[], &mut first, 0);
        assert_eq!(first[0].speaker, Some(1));

        let mut second = vec![word(300_000, Some(7)), word(302_500, Some(2))];
        stitcher.stitch(&first, &mut second, 300_000);
        assert_eq!(second[0].speaker, Some(1));
        assert_eq!(second[1].speaker, Some(2));
    }

    #[test]
    fn ninth_voice_collapses_to_nine_plus() {
        let mut stitcher = SpeakerStitcher::new();
        let mut words = (0..10)
            .map(|index: u8| word(u64::from(index) * 1000, Some(index)))
            .collect::<Vec<_>>();
        stitcher.stitch(&[], &mut words, 0);
        assert_eq!(words[8].speaker, Some(9));
        assert_eq!(words[9].speaker, Some(9));
    }

    fn segment(start: u64, end: u64) -> Segment {
        let mut segment = Segment::failed(start, end);
        segment.status = super::super::asr::SegmentStatus::Ok;
        segment.text = "x".into();
        segment
    }

    fn turn(t0: u64, t1: u64, speaker: u8) -> SpeakerTurn {
        SpeakerTurn {
            t0_ms: t0,
            t1_ms: t1,
            speaker,
        }
    }

    #[test]
    fn join_picks_the_longest_overlap_and_never_splits_a_segment() {
        let mut segments = vec![segment(1_000, 3_000)];
        let stats = join(&mut segments, &[turn(900, 1_400, 1), turn(1_400, 2_900, 2)]);
        assert_eq!(segments[0].speaker, Some(2));
        assert_eq!(stats.tagged, 1);
        assert_eq!(stats.speakers, 2);
    }

    #[test]
    fn join_leaves_non_overlapping_segments_unlabelled() {
        let mut segments = vec![segment(5_000, 6_000), segment(1_000, 2_000)];
        let stats = join(&mut segments, &[turn(0, 4_999, 1)]);
        assert_eq!(segments[0].speaker, None);
        assert_eq!(segments[1].speaker, Some(1));
        assert_eq!(stats.unmatched, 1);
    }
}
