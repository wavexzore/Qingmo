//! Headless search benchmark used by `bench/search.mjs`.
//!
//! It indexes one generated corpus and measures cold/warm queries through the
//! exact production `SearchIndexService` path (SQLite/FTS5, no Tauri window).

use std::path::PathBuf;
use std::time::Instant;

use qingmo_lib::services::SearchIndexService;

fn argument(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
        if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
            return Some(value.to_string());
        }
    }
    None
}

fn percentile(sorted: &[u64], percent: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) * percent) / 100;
    sorted[index]
}

fn main() {
    let root = PathBuf::from(argument("--root").expect("--root is required"));
    let db = PathBuf::from(argument("--db").expect("--db is required"));
    let iterations: usize = argument("--iterations")
        .and_then(|value| value.parse().ok())
        .unwrap_or(5);

    let index = SearchIndexService::open(db.clone()).expect("index must open");
    let start = Instant::now();
    // A scan stops after its budget or the body cap. Repeating the scan lets
    // a large workspace finish across passes while still measuring the real
    // production path (fresh files are skipped by hash/mtime).
    let mut passes = 0usize;
    let mut last_indexed = 0u64;
    loop {
        index.scan_root(&root).expect("scan must succeed");
        passes += 1;
        let status = index.status(&root);
        eprintln!(
            "pass {}: indexed={} total={} truncated={}",
            passes, status.indexed, status.total, status.truncated
        );
        if !status.truncated
            || status.indexed >= status.total
            || status.indexed == last_indexed
            || passes >= 10
        {
            break;
        }
        last_indexed = status.indexed;
    }
    let scan_ms = start.elapsed().as_millis() as u64;
    let status = index.status(&root);

    let queries = [
        ("cjk-short", "中"),
        ("cjk-3", "中文标"),
        ("latin-2", "ab"),
        ("latin", "hello"),
        ("mixed", "中文 hello"),
        ("exclude", "hello -world"),
        ("phrase", "\"hello world\""),
    ];
    let mut report = Vec::new();
    for (name, query) in queries {
        let mut timings = Vec::new();
        let mut hits = 0usize;
        for _ in 0..iterations {
            let started = Instant::now();
            let response = index.search(&root, query, 30, 0).expect("search must run");
            timings.push(started.elapsed().as_millis() as u64);
            hits = response.results.len();
        }
        timings.sort_unstable();
        report.push(serde_json::json!({
            "query": name,
            "text": query,
            "p50Ms": percentile(&timings, 50),
            "p95Ms": percentile(&timings, 95),
            "p99Ms": percentile(&timings, 99),
            "hits": hits,
        }));
    }

    let page_started = Instant::now();
    let page = index.search(&root, "hello", 30, 30).expect("paged search");
    let page_ms = page_started.elapsed().as_millis() as u64;
    println!(
        "{}",
        serde_json::json!({
            "root": root.to_string_lossy(),
            "scanMs": scan_ms,
            "scanPasses": passes,
            "indexed": status.indexed,
            "total": status.total,
            "truncated": status.truncated,
            "pageMs": page_ms,
            "pageHasMore": page.has_more,
            "queries": report,
        })
    );
}
