//! Template-language heuristic.

use qingmo_lib::services::meeting::lang::{detect_language, Lang};

#[test]
fn chinese_and_mixed_speech_stay_chinese() {
    assert_eq!(detect_language("今天讨论发布计划"), Lang::Zh);
    assert_eq!(detect_language("OK 我们开始 review 一下"), Lang::Zh);
}

#[test]
fn english_speech_switches() {
    assert_eq!(detect_language("review the release plan"), Lang::En);
}
