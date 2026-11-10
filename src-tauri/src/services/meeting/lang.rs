//! Language heuristic for the report template.
//!
//! Detection runs on the finished transcript, never on the audio, and only
//! chooses Chinese vs English templates. Mixed speech follows the majority.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zh => "zh",
            Self::En => "en",
        }
    }
}

/// Pick the template language by CJK share of the non-whitespace characters.
pub fn detect_language(text: &str) -> Lang {
    let mut cjk = 0usize;
    let mut latin = 0usize;
    for ch in text.chars().filter(|ch| !ch.is_whitespace()) {
        if is_cjk(ch) {
            cjk += 1;
        } else if ch.is_ascii_alphabetic() {
            latin += 1;
        }
    }
    let total = cjk + latin;
    if total == 0 || cjk * 10 >= total * 3 {
        Lang::Zh
    } else {
        Lang::En
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_and_mixed_text_choose_chinese() {
        assert_eq!(detect_language("我们今天讨论发布计划"), Lang::Zh);
        assert_eq!(detect_language("OK 我们开始 review 一下"), Lang::Zh);
    }

    #[test]
    fn english_text_chooses_english() {
        assert_eq!(
            detect_language("we review the release plan today"),
            Lang::En
        );
    }

    #[test]
    fn empty_text_defaults_to_chinese() {
        assert_eq!(detect_language("  "), Lang::Zh);
    }
}
