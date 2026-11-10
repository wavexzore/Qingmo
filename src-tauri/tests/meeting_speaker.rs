//! Speaker join: one label per segment, absolute overlap and 9+ overflow.

use qingmo_lib::services::meeting::asr::{Segment, SegmentStatus};
use qingmo_lib::services::meeting::speaker::{join, SpeakerTurn};

fn segment(start: u64, end: u64) -> Segment {
    let mut segment = Segment::failed(start, end);
    segment.status = SegmentStatus::Ok;
    segment.text = "hello".into();
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
fn a_segment_gets_exactly_one_longest_overlap_label() {
    let mut segments = vec![segment(10_000, 20_000)];
    let stats = join(
        &mut segments,
        &[
            turn(9_000, 12_000, 1),
            turn(12_000, 19_000, 2),
            turn(19_500, 21_000, 3),
        ],
    );
    assert_eq!(segments[0].speaker, Some(2));
    assert_eq!(stats.tagged, 1);
    assert_eq!(stats.unmatched, 0);
    assert_eq!(stats.speakers, 2);
}

#[test]
fn same_speaker_stays_stable_across_segments() {
    let mut segments = vec![segment(0, 10_000), segment(10_000, 20_000)];
    join(&mut segments, &[turn(0, 20_000, 4), turn(0, 2_000, 9)]);
    assert_eq!(segments[0].speaker, Some(4));
    assert_eq!(segments[1].speaker, Some(4));
}

#[test]
fn no_overlap_and_nine_plus_are_preserved() {
    let mut segments = vec![segment(30_000, 31_000), segment(0, 1_000)];
    let stats = join(&mut segments, &[turn(0, 1_000, 9)]);
    assert_eq!(segments[0].speaker, None);
    assert_eq!(segments[1].speaker, Some(9));
    assert_eq!(stats.speakers, 9);
    assert_eq!(stats.unmatched, 1);
}
