//! Persistent application log store.
//!
//! Logs are written next to the platform's application log directory
//! (`~/Library/Logs/com.wavexzore.qingmo` on macOS). One file per day, at most
//! seven files are kept; `panic.log` captures crashes that happen without a
//! terminal attached.
//!
//! The module also owns reading, filtering, exporting and clearing. The
//! frontend only ever sees parsed entries through `commands::logs`.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::ipc::dto::{LogEntry, LogLevel, LogStats};

const FILE_PREFIX: &str = "qingmo";
const FILE_SUFFIX: &str = "log";
const PANIC_FILE: &str = "panic.log";
pub const RETENTION_DAYS: u64 = 7;
const MAX_ENTRIES: usize = 5_000;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

fn is_log_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(&format!("{FILE_PREFIX}."))
                && name.ends_with(&format!(".{FILE_SUFFIX}"))
        })
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

/// Remembers the directory for the process lifetime and removes files older
/// than `keep_days` days.
pub fn init(dir: PathBuf) -> std::io::Result<()> {
    fs::create_dir_all(&dir)?;
    let _ = LOG_DIR.set(dir.clone());
    clear_older_than(&dir, keep_days_from(Some(RETENTION_DAYS as u32)));
    Ok(())
}

/// The active log directory. Falls back to the temp directory when logging was
/// never initialized (unit tests, early startup failures).
pub fn dir() -> PathBuf {
    LOG_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("qingmo"))
}

/// Writes panics to `panic.log`, including a backtrace.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = dir();
        let _ = fs::create_dir_all(&dir);
        let message = format!(
            "==== panic at {} ====\n{info}\nbacktrace:\n{}\n",
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| "unknown".to_string()),
            std::backtrace::Backtrace::force_capture()
        );
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(PANIC_FILE))
        {
            let _ = file.write_all(message.as_bytes());
            let _ = file.flush();
        }
        default_hook(info);
    }));
}

fn keep_days_from(keep_days: Option<u32>) -> u64 {
    keep_days.map_or(RETENTION_DAYS, u64::from)
}

/// Deletes rolling log files older than `keep_days`; `panic.log` is kept.
pub fn clear_older_than(dir: &Path, keep_days: u64) -> usize {
    let cutoff =
        SystemTime::now().checked_sub(Duration::from_secs(keep_days.saturating_mul(24 * 60 * 60)));
    let Some(cutoff) = cutoff else {
        return 0;
    };

    list_files_in(dir)
        .into_iter()
        .filter(|path| modified(path).is_some_and(|time| time < cutoff))
        .filter(|path| fs::remove_file(path).is_ok())
        .count()
}

/// Log files, newest first.
pub fn list_files() -> Vec<PathBuf> {
    list_files_in(&dir())
}

fn list_files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_log_file(path))
        .collect();
    files.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    files
}

impl FromStr for LogLevel {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_uppercase().as_str() {
            "TRACE" => Ok(Self::Trace),
            "DEBUG" => Ok(Self::Debug),
            "INFO" => Ok(Self::Info),
            "WARN" | "WARNING" => Ok(Self::Warn),
            "ERROR" => Ok(Self::Error),
            _ => Err(()),
        }
    }
}

fn parse_line(line: &str) -> Option<LogEntry> {
    let line = line.trim_end();
    if line.is_empty() {
        return None;
    }

    // tracing fmt right-aligns the level: `<timestamp>  INFO target: message`.
    let mut parts = line.split_whitespace();
    let timestamp = parts.next()?;
    let level = parts.next()?.parse::<LogLevel>().ok()?;
    let rest = parts.collect::<Vec<_>>().join(" ");
    let (target, message) = match rest.split_once(": ") {
        Some((target, message)) => (target.trim(), message.trim()),
        None => ("unknown", rest.trim()),
    };

    Some(LogEntry {
        timestamp: timestamp.to_string(),
        level,
        target: target.to_string(),
        message: message.to_string(),
    })
}

/// Reads entries newest first, optionally filtered to `minimum` severity.
pub fn read(minimum: Option<LogLevel>, limit: usize, offset: usize) -> Vec<LogEntry> {
    let limit = limit.clamp(1, MAX_ENTRIES);
    let mut entries = Vec::new();

    for path in list_files() {
        let Ok(file) = File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Some(entry) = parse_line(&line) else {
                continue;
            };
            if minimum.is_some_and(|minimum| entry.level < minimum) {
                continue;
            }
            entries.push(entry);
        }
    }

    entries.reverse();
    entries.into_iter().skip(offset).take(limit).collect()
}

pub fn stats() -> LogStats {
    let files = list_files();
    let mut stats = LogStats {
        total_entries: 0,
        error_count: 0,
        warn_count: 0,
        info_count: 0,
        debug_count: 0,
        total_size_bytes: 0,
        file_count: files.len() as u64,
        oldest_entry: None,
        newest_entry: None,
    };

    for path in &files {
        if let Ok(metadata) = fs::metadata(path) {
            stats.total_size_bytes += metadata.len();
        }
        let Ok(file) = File::open(path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Some(entry) = parse_line(&line) else {
                continue;
            };
            stats.total_entries += 1;
            match entry.level {
                LogLevel::Error => stats.error_count += 1,
                LogLevel::Warn => stats.warn_count += 1,
                LogLevel::Info => stats.info_count += 1,
                LogLevel::Debug | LogLevel::Trace => stats.debug_count += 1,
            }
            if stats.oldest_entry.is_none() {
                stats.oldest_entry = Some(entry.timestamp.clone());
            }
            stats.newest_entry = Some(entry.timestamp.clone());
        }
    }

    stats
}

/// Copies matching log files from `source` to `destination`, newest files last
/// so the export stays chronological. Returns the written path.
pub fn export(
    source: &Path,
    directory: &Path,
    minimum: Option<LogLevel>,
) -> std::io::Result<PathBuf> {
    fs::create_dir_all(directory)?;
    let stamp = OffsetDateTime::now_utc()
        .format(
            &time::format_description::parse_borrowed::<2>(
                "[year][month][day]-[hour][minute][second]",
            )
            .expect("static format is valid"),
        )
        .unwrap_or_else(|_| "export".to_string());
    let destination = directory.join(format!("qingmo-logs-{stamp}.txt"));

    let mut output = File::create(&destination)?;
    writeln!(output, "Qingmo application logs")?;
    writeln!(
        output,
        "Exported: {}",
        OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "unknown".to_string())
    )?;
    if let Some(level) = minimum {
        writeln!(output, "Minimum level: {level:?}")?;
    }
    writeln!(output, "========================================")?;
    writeln!(output)?;

    for path in list_files_in(source).into_iter().rev() {
        let Ok(file) = File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Some(entry) = parse_line(&line) else {
                continue;
            };
            if minimum.is_some_and(|minimum| entry.level < minimum) {
                continue;
            }
            writeln!(output, "{line}")?;
        }
    }

    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(level: LogLevel, message: &str) -> LogEntry {
        LogEntry {
            timestamp: "2026-10-28T02:00:00Z".to_string(),
            level,
            target: "qingmo_lib::test".to_string(),
            message: message.to_string(),
        }
    }

    #[test]
    fn parses_tracing_lines_and_ignores_noise() {
        let parsed = parse_line(
            "2026-10-28T02:00:00.123456Z  INFO qingmo_lib::commands::close: closing window: note.md",
        )
        .expect("line must parse");

        assert_eq!(parsed.level, LogLevel::Info);
        assert_eq!(parsed.target, "qingmo_lib::commands::close");
        assert_eq!(parsed.message, "closing window: note.md");
        assert!(parse_line("").is_none());
        assert!(parse_line("not a tracing line").is_none());
    }

    #[test]
    fn level_filter_keeps_minimum_and_above() {
        let mut entries = [
            entry(LogLevel::Info, "info"),
            entry(LogLevel::Error, "error"),
        ];
        entries.sort_by_key(|entry| entry.level);

        let filtered: Vec<_> = entries
            .into_iter()
            .filter(|entry| entry.level >= LogLevel::Warn)
            .collect();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].message, "error");
    }

    #[test]
    fn clear_older_than_removes_only_stale_rolling_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let stale = dir.path().join("qingmo.2000-01-01.log");
        let fresh = dir.path().join("qingmo.2999-01-01.log");
        let panic = dir.path().join(PANIC_FILE);
        for path in [&stale, &fresh, &panic] {
            fs::write(path, "line").expect("write fixture");
        }
        let old = SystemTime::now() - Duration::from_secs(30 * 24 * 60 * 60);
        // Windows needs FILE_WRITE_ATTRIBUTES, which a read-only handle lacks.
        File::options()
            .write(true)
            .open(&stale)
            .expect("open stale fixture")
            .set_modified(old)
            .expect("age the stale fixture");

        assert_eq!(clear_older_than(dir.path(), RETENTION_DAYS), 1);
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(panic.exists());
    }

    #[test]
    fn export_writes_chronological_entries_and_honours_the_filter() {
        let dir = tempfile::tempdir().expect("temp dir");
        let logs = dir.path().join("logs");
        fs::create_dir_all(&logs).expect("log dir");
        fs::write(
            logs.join("qingmo.2026-10-27.log"),
            "2026-10-27T01:00:00Z  INFO qingmo_lib::test: older\n",
        )
        .expect("write log");
        fs::write(
            logs.join("qingmo.2026-10-28.log"),
            "2026-10-28T01:00:00Z  ERROR qingmo_lib::test: newer\n",
        )
        .expect("write log");

        let exported =
            export(&logs, &dir.path().join("out"), Some(LogLevel::Info)).expect("export");
        let text = fs::read_to_string(exported).expect("read export");

        let older = text.find("older").expect("older entry");
        let newer = text.find("newer").expect("newer entry");
        assert!(older < newer, "export must be chronological");
    }
}
