//! Duration hard limit and the 4 h / 600 min boundary.

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::meeting::decode::{ensure_duration, AudioProbe};

fn probe(duration_ms: u64) -> AudioProbe {
    AudioProbe {
        duration_ms,
        sample_rate: 16_000,
        channels: 1,
    }
}

#[test]
fn exactly_six_hundred_minutes_is_allowed() {
    ensure_duration(&probe(600 * 60_000), 600).expect("600 min is the inclusive limit");
}

#[test]
fn one_millisecond_past_the_limit_is_rejected() {
    let error = ensure_duration(&probe(600 * 60_000 + 1), 600).expect_err("must reject");
    assert_eq!(error.code, AppErrorCode::AudioTooLong);
    assert!(error.message.contains("36000000"));
}

#[test]
fn a_lower_configured_limit_is_honored() {
    let error = ensure_duration(&probe(181 * 60_000), 180).expect_err("must reject");
    assert_eq!(error.code, AppErrorCode::AudioTooLong);
}

#[test]
fn four_hour_low_bitrate_style_duration_is_rejected_at_the_six_hour_cap() {
    ensure_duration(&probe(4 * 60 * 60_000), 600).expect("4 h fits the 10 h cap");
}
