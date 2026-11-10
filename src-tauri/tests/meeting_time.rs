//! Absolute-time contract across ten-minute windows.

use qingmo_lib::services::meeting::asr::{RawAsr, Segment};

fn raw(start: u64, end: u64, tokens: Vec<(u64, Option<f32>)>) -> RawAsr {
    RawAsr {
        start_ms: start,
        end_ms: end,
        text: "x".into(),
        tokens,
    }
}

#[test]
fn twenty_five_minutes_across_three_windows_never_resets() {
    let windows = [
        (0u64, 600_000u64),
        (600_000, 1_200_000),
        (1_200_000, 1_500_000),
    ];
    let mut last = 0u64;
    for (index, (window_start, window_end)) in windows.into_iter().enumerate() {
        let relative = 120_000u64;
        let segment = Segment::from_raw(
            raw(relative, relative + 2_000, vec![(relative, Some(0.9))]),
            window_start,
            window_end,
        );
        assert_eq!(segment.start_ms, window_start + relative);
        assert_eq!(segment.tokens[0].t_ms, window_start + relative);
        assert!(segment.start_ms > last || index == 0);
        last = segment.start_ms;
    }
    assert!(last > 1_200_000);
}

#[test]
fn tokens_never_cross_the_segment_end() {
    let segment = Segment::from_raw(
        raw(
            29_000,
            30_000,
            vec![(29_500, Some(0.4)), (30_500, Some(0.4))],
        ),
        600_000,
        630_000,
    );
    assert_eq!(segment.end_ms, 630_000);
    assert!(segment
        .tokens
        .iter()
        .all(|token| token.t_ms <= segment.end_ms));
    assert_eq!(segment.tokens[1].t_ms, 630_000);
}

#[test]
fn segment_start_is_clamped_below_end() {
    let segment = Segment::from_raw(raw(99_000, 99_000, vec![]), 1000, 2000);
    assert_eq!(segment.start_ms, 1999);
    assert_eq!(segment.end_ms, 2000);
}
