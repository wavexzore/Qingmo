//! Identity/history/view rollback mapper.
//!
//! Usage:
//!   cargo run --manifest-path src-tauri/Cargo.toml --example identity_rollback -- \
//!     --dry-run --data src-tauri/tests/fixtures/identity_rollback
//!   cargo run --manifest-path src-tauri/Cargo.toml --example identity_rollback -- \
//!     --apply --data /path/to/app-data
//!
//! Dry-run only prints the report. `--apply` copies/merges the mapped data and
//! writes `<data>/rollback-report.json`; it never deletes identity/history/view.

use std::path::PathBuf;
use std::process::ExitCode;

use qingmo_lib::services::identity_rollback::{run, ROLLBACK_REPORT_FILE};

struct Options {
    data: PathBuf,
    apply: bool,
}

fn usage() -> &'static str {
    "usage: identity_rollback --data <app-data-dir> [--dry-run|--apply]\n\
     default is --dry-run; --apply writes copies and rollback-report.json"
}

fn parse_args() -> Result<Options, String> {
    let mut data = None;
    let mut apply = false;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--data" => {
                let value = args.next().ok_or("--data needs a directory")?;
                data = Some(PathBuf::from(value));
            }
            value if value.starts_with("--data=") => {
                data = Some(PathBuf::from(&value["--data=".len()..]));
            }
            "--apply" => apply = true,
            "--dry-run" => apply = false,
            "--help" | "-h" => return Err(usage().to_string()),
            other => return Err(format!("unknown argument: {other}\n{}", usage())),
        }
    }
    let data = data.ok_or_else(|| format!("--data is required\n{}", usage()))?;
    Ok(Options { data, apply })
}

fn main() -> ExitCode {
    let options = match parse_args() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    match run(&options.data, options.apply) {
        Ok(report) => {
            if options.apply {
                let path = options.data.join(ROLLBACK_REPORT_FILE);
                let bytes = match serde_json::to_vec_pretty(&report) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        eprintln!("failed to encode the rollback report: {error}");
                        return ExitCode::FAILURE;
                    }
                };
                if let Err(error) = std::fs::write(&path, bytes) {
                    eprintln!("failed to write {}: {error}", path.display());
                    return ExitCode::FAILURE;
                }
                println!("{}", path.display());
            } else {
                match serde_json::to_string_pretty(&report) {
                    Ok(json) => println!("{json}"),
                    Err(error) => {
                        eprintln!("failed to encode the rollback report: {error}");
                        return ExitCode::FAILURE;
                    }
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("rollback failed: {error:?}");
            ExitCode::FAILURE
        }
    }
}
