//! Reproducible save benchmark for the real `AtomicWriter`.
//!
//! It copies a fixture to a temporary `.md` file, opens it through the same
//! `DocumentRegistry` used by the app, then repeatedly calls
//! `AtomicWriter::write`. Every iteration changes three bytes near the padding
//! comment, so the writer always performs the full read/hash/encode/commit
//! path instead of taking the "bytes already identical" shortcut.
//!
//! Run through `pnpm bench`; standalone usage:
//! `cargo run --release --example atomic_bench -- --fixture bench/fixtures/medium.md --iterations 12 --label medium`

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

use qingmo_lib::services::AtomicWriter;
use qingmo_lib::state::DocumentRegistry;
use serde_json::json;

struct Args {
    fixture: PathBuf,
    iterations: usize,
    label: String,
    output: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut fixture = None;
    let mut iterations = 10usize;
    let mut label = "fixture".to_string();
    let mut output = None;
    let mut args = std::env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--fixture" => fixture = args.next().map(PathBuf::from),
            "--iterations" => {
                iterations = args
                    .next()
                    .ok_or("missing value for --iterations")?
                    .parse()
                    .map_err(|_| "invalid --iterations")?;
            }
            "--label" => label = args.next().ok_or("missing value for --label")?,
            "--json" => output = args.next().map(PathBuf::from),
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        fixture: fixture.ok_or("missing --fixture")?,
        iterations,
        label,
        output,
    })
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((fraction * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

fn round(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

fn summarize(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let count = samples.len();
    let sum: f64 = samples.iter().sum();
    json!({
        "count": count,
        "min": round(samples.first().copied().unwrap_or(0.0), 3),
        "p50": round(percentile(&samples, 0.5), 3),
        "p95": round(percentile(&samples, 0.95), 3),
        "max": round(samples.last().copied().unwrap_or(0.0), 3),
        "mean": round(if count == 0 { 0.0 } else { sum / count as f64 }, 3),
    })
}

/// `ps` reports RSS in KiB on macOS and Linux. Windows is not a bench target.
fn rss_mb() -> Option<f64> {
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let kib: f64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()?;
    Some(round(kib / 1024.0, 1))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    let temporary = tempfile::tempdir()?;
    let target = temporary.path().join("atomic-bench.md");
    fs::copy(&args.fixture, &target)?;

    let registry = DocumentRegistry::new();
    let open_start = Instant::now();
    let payload = registry.open_path(target)?;
    let open_ms = open_start.elapsed().as_secs_f64() * 1000.0;
    let record = registry.get(&payload.doc_token)?;

    let mut text = payload.text.clone();
    let len = text.len();
    if len < 4 || &text[len - 4..] != "-->\n" {
        return Err("fixture must end with a `-->` padding comment".into());
    }

    // Warm up the parser/caches without polluting the measured samples.
    text.replace_range(len - 4..len - 1, "wrm");
    AtomicWriter::write(&record, &text, None)?;

    let mut samples = Vec::with_capacity(args.iterations);
    for index in 0..args.iterations {
        let marker = format!("{index:03}");
        text.replace_range(len - 4..len - 1, &marker);
        let start = Instant::now();
        let result = AtomicWriter::write(&record, &text, None)?;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        if result.size != text.len() as u64 {
            return Err(format!(
                "size mismatch after save: {} != {}",
                result.size,
                text.len()
            )
            .into());
        }
    }

    let report = json!({
        "fixture": args.label,
        "bytes": payload.size,
        "iterations": args.iterations,
        "openMs": round(open_ms, 3),
        "saveMs": summarize(samples),
        "rssMb": rss_mb(),
        "source": "AtomicWriter::write (real temp file, release build)",
    });

    if let Some(output) = args.output {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            output,
            format!("{}\n", serde_json::to_string_pretty(&report)?),
        )?;
    } else {
        println!("{}", serde_json::to_string_pretty(&report)?);
    }

    Ok(())
}
