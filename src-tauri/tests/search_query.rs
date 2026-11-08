//! Search grammar and FTS routing.

use qingmo_lib::ipc::dto::SearchMode;
use qingmo_lib::services::search_query::{
    parse, plain_snippet, short_terms, title_from_body, TermTable, SEARCH_MAX_QUERY_CHARS,
    SEARCH_MAX_TERMS,
};

#[test]
fn parses_phrases_exclusions_and_routes_each_term() {
    let parsed = parse("ab \"exact phrase\" -cd 中文 中文词").expect("parse");
    assert_eq!(parsed.mode, SearchMode::Mixed);
    assert_eq!(parsed.include.len(), 4);
    assert_eq!(parsed.exclude.len(), 1);

    let alpha = &parsed.include[0];
    assert_eq!(alpha.table, TermTable::Short);
    assert!(alpha.expression.ends_with('*'));
    assert_eq!(parsed.include[2].expression, "\"中文\"");
    assert_eq!(parsed.include[1].table, TermTable::Trigram);
    assert_eq!(parsed.include[2].table, TermTable::Short);
    assert_eq!(parsed.include[3].table, TermTable::Trigram);

    assert_eq!(parsed.exclude[0].table, TermTable::Short);
    assert!(parsed.exclude[0].exclude);
}

#[test]
fn short_non_alphanumeric_terms_are_quoted_and_escaped() {
    let parsed = parse("\"中文\" c++ a-b").expect("parse");
    assert_eq!(parsed.include[0].table, TermTable::Short);
    assert!(parsed.include[0].expression.starts_with('"'));
    assert!(parsed.include[2].expression.starts_with('"'));
    assert!(parse("\"\"").expect("empty phrase").is_empty());
}

#[test]
fn rejects_oversized_queries_and_too_many_terms() {
    let too_many = (0..(SEARCH_MAX_TERMS + 1))
        .map(|index| format!("word{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(parse(&too_many).is_err());
    assert!(parse(&"a".repeat(SEARCH_MAX_QUERY_CHARS + 1)).is_err());
    assert!(parse(&"a".repeat(200)).is_ok());
    assert!(parse(&"a".repeat(201)).is_err());
}

#[test]
fn cjk_unigrams_are_preserved_in_the_short_index() {
    assert_eq!(
        short_terms("中文 mixedCASE 123"),
        "中 文 中文 mixedcase 123"
    );
    assert_eq!(short_terms("a_b-c"), "a_b c");
}

#[test]
fn titles_prefer_the_first_atx_heading_and_snippets_center_the_hit() {
    assert_eq!(title_from_body("intro\n# 标题\nbody", "fallback"), "标题");
    assert_eq!(title_from_body("body", "fallback"), "fallback");

    let parsed = parse("needle").expect("parse");
    let body = format!("{}needle{}", "a".repeat(100), "b".repeat(200));
    let snippet = plain_snippet(&body, &parsed.include);
    assert!(snippet.contains("needle"));
    assert!(snippet.starts_with('…'));
    assert!(snippet.ends_with('…'));
}
