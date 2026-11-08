//! Query parser and FTS5 routing for workspace search.

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::SearchMode;

pub const SEARCH_MAX_TERMS: usize = 16;
pub const SEARCH_MAX_TERM_CHARS: usize = 200;
pub const SEARCH_MAX_QUERY_CHARS: usize = 1024;
pub const SEARCH_MAX_LIMIT: usize = 100;
pub const SEARCH_MAX_OFFSET: usize = 1000;
pub const SEARCH_DEFAULT_LIMIT: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermTable {
    Trigram,
    Short,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryTerm {
    pub raw: String,
    pub table: TermTable,
    pub expression: String,
    pub exclude: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQuery {
    pub include: Vec<QueryTerm>,
    pub exclude: Vec<QueryTerm>,
    pub mode: SearchMode,
}

impl ParsedQuery {
    pub fn is_empty(&self) -> bool {
        self.include.is_empty()
    }

    /// The first trigram include term, used by FTS5 `snippet()`.
    pub fn snippet_term(&self) -> Option<&QueryTerm> {
        self.include
            .iter()
            .find(|term| term.table == TermTable::Trigram)
    }
}

pub fn parse(query: &str) -> Result<ParsedQuery, AppError> {
    if query.chars().count() > SEARCH_MAX_QUERY_CHARS {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "search query is too long",
        ));
    }
    let mut include = Vec::new();
    let mut exclude = Vec::new();
    let mut index = 0usize;
    let chars: Vec<char> = query.chars().collect();
    while index < chars.len() {
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let negative = chars[index] == '-';
        if negative {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let quoted = chars[index] == '"';
        if quoted {
            index += 1;
        }
        let mut raw = String::new();
        while index < chars.len() {
            let character = chars[index];
            if quoted {
                if character == '"' {
                    index += 1;
                    break;
                }
            } else if character.is_whitespace() {
                break;
            }
            raw.push(character);
            index += 1;
        }
        if raw.is_empty() {
            continue;
        }
        if raw.chars().count() > SEARCH_MAX_TERM_CHARS {
            return Err(AppError::new(
                AppErrorCode::InvalidPath,
                "search term is too long",
            ));
        }
        let term = build_term(raw, quoted, negative)?;
        if negative {
            exclude.push(term);
        } else {
            include.push(term);
        }
    }
    if include.len() + exclude.len() > SEARCH_MAX_TERMS {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "too many search terms",
        ));
    }
    let mode = mode_for(&include, &exclude);
    Ok(ParsedQuery {
        include,
        exclude,
        mode,
    })
}

fn build_term(raw: String, quoted: bool, exclude: bool) -> Result<QueryTerm, AppError> {
    let cjk = contains_cjk(&raw);
    let chars = raw.chars().count();
    let (table, expression) = if quoted {
        if cjk && chars < 3 {
            (TermTable::Short, quote_cjk_short(&raw, chars))
        } else {
            (TermTable::Trigram, quote_trigram(&raw))
        }
    } else if cjk {
        if chars >= 3 {
            (TermTable::Trigram, quote_trigram(&raw))
        } else {
            (TermTable::Short, quote_cjk_short(&raw, chars))
        }
    } else if chars >= 3 {
        (TermTable::Trigram, quote_trigram(&raw))
    } else if raw
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        (
            TermTable::Short,
            format!("{}*", escape_short_word(&raw.to_ascii_lowercase())),
        )
    } else {
        (TermTable::Short, quote_short(&raw))
    };
    Ok(QueryTerm {
        raw,
        table,
        expression,
        exclude,
    })
}

fn mode_for(include: &[QueryTerm], exclude: &[QueryTerm]) -> SearchMode {
    let mut trigram = false;
    let mut short = false;
    for term in include.iter().chain(exclude.iter()) {
        match term.table {
            TermTable::Trigram => trigram = true,
            TermTable::Short => short = true,
        }
    }
    match (trigram, short) {
        (true, true) => SearchMode::Mixed,
        (true, false) => SearchMode::Trigram,
        _ => SearchMode::Short,
    }
}

pub fn contains_cjk(text: &str) -> bool {
    text.chars().any(is_cjk)
}

fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x2E80..=0x2FFF
            | 0x3040..=0x30FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0xAC00..=0xD7AF
    )
}

fn quote_trigram(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// A two-character CJK term is indexed as one exact bigram token. Matching
/// the bigram is both exact (adjacent characters) and much cheaper than the
/// equivalent two-token phrase query.
fn quote_cjk_short(text: &str, chars: usize) -> String {
    if chars == 2 && text.chars().all(is_cjk) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        quote_short(text)
    }
}

fn quote_short(text: &str) -> String {
    let terms = text
        .chars()
        .map(|character| character.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    format!("\"{}\"", terms.replace('"', "\"\""))
}

fn escape_short_word(text: &str) -> String {
    text.replace(['"', '*', '(', ')', ':'], " ")
        .trim()
        .to_string()
}

/// Dense unicode61 terms: every CJK character becomes a unigram; Latin/digit
/// runs become lower-case words. Only the short FTS table consumes this.
pub fn short_terms(text: &str) -> String {
    let mut terms = Vec::new();
    let mut word = String::new();
    let mut previous_cjk: Option<char> = None;
    for character in text.chars() {
        if is_cjk(character) {
            if !word.is_empty() {
                terms.push(word.to_ascii_lowercase());
                word.clear();
            }
            terms.push(character.to_string());
            if let Some(previous) = previous_cjk {
                terms.push(format!("{previous}{character}"));
            }
            previous_cjk = Some(character);
        } else {
            previous_cjk = None;
            if character.is_alphanumeric() || character == '_' {
                word.push(character);
            } else if !word.is_empty() {
                terms.push(word.to_ascii_lowercase());
                word.clear();
            }
        }
    }
    if !word.is_empty() {
        terms.push(word.to_ascii_lowercase());
    }
    terms.join(" ")
}

pub fn title_from_body(body: &str, fallback: &str) -> String {
    for line in body.lines().take(1000) {
        let trimmed = line.trim_start();
        if let Some(title) = trimmed.strip_prefix("# ") {
            let title = title.trim();
            if !title.is_empty() {
                return title.chars().take(200).collect();
            }
        }
    }
    fallback.chars().take(200).collect()
}

pub fn plain_snippet(body: &str, terms: &[QueryTerm]) -> String {
    let lower = body.to_lowercase();
    let needle = terms
        .iter()
        .map(|term| term.raw.to_lowercase())
        .find(|term| !term.is_empty());
    let Some(needle) = needle else {
        return body.chars().take(240).collect();
    };
    let Some(index) = lower.find(&needle) else {
        return body.chars().take(240).collect();
    };
    let char_index = lower[..index].chars().count();
    let chars: Vec<char> = body.chars().collect();
    let start = char_index.saturating_sub(80);
    let end = (char_index + needle.chars().count() + 160).min(chars.len());
    let mut snippet = chars[start..end].iter().collect::<String>();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_cjk_and_latin_terms() {
        let parsed = parse("中文 \"exact phrase\" -排除").expect("parse");
        assert_eq!(parsed.include.len(), 2);
        assert_eq!(parsed.exclude.len(), 1);
        assert_eq!(parsed.include[0].table, TermTable::Short);
        assert_eq!(parsed.include[1].table, TermTable::Trigram);
        assert_eq!(parsed.mode, SearchMode::Mixed);
    }

    #[test]
    fn short_terms_are_cjk_unigrams_bigrams_and_latin_words() {
        assert_eq!(short_terms("中文 testAB 123"), "中 文 中文 testab 123");
    }

    #[test]
    fn rejects_too_many_terms_and_oversized_input() {
        let query = (0..17)
            .map(|index| format!("w{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(parse(&query).is_err());
        assert!(parse(&"a".repeat(SEARCH_MAX_QUERY_CHARS + 1)).is_err());
    }

    #[test]
    fn title_prefers_first_atx_heading() {
        assert_eq!(title_from_body("intro\n# 标题\nbody", "note"), "标题");
        assert_eq!(title_from_body("body", "note"), "note");
    }
}
