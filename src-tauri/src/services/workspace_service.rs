use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{
    WorkspaceEntry, WorkspaceEntryKind, WorkspaceListing, WorkspaceTruncationReason,
};
use crate::state::document_registry::ensure_supported_extension;

/// Deepest directory chain accepted from the webview.
pub const MAX_SEGMENTS: usize = 64;
/// Maximum number of entries returned by one listing.
pub const MAX_LISTED: usize = 10_000;
/// Maximum number of directory entries inspected before reporting truncated.
pub const MAX_SCANNED: usize = 50_000;
/// Longest single path segment accepted (bytes on Unix, UTF-16 units on Windows).
pub const MAX_SEGMENT_UNITS: usize = 255;

fn invalid_segment() -> AppError {
    AppError::new(
        AppErrorCode::InvalidPath,
        "invalid workspace directory segment",
    )
}

fn outside_scope() -> AppError {
    AppError::new(AppErrorCode::OutsideScope, "path is outside the workspace")
}

fn is_bidi_format_char(character: char) -> bool {
    matches!(
        character,
        '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

fn is_unsafe_display_char(character: char) -> bool {
    character.is_control() || is_bidi_format_char(character)
}

/// Whether a name may be shown and used as one navigation segment.
fn is_unsafe_name(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    if name.chars().any(is_unsafe_display_char) {
        return true;
    }
    if name.contains('/') || name.contains('\\') {
        return true;
    }
    #[cfg(windows)]
    {
        if name.encode_utf16().count() > MAX_SEGMENT_UNITS {
            return true;
        }
    }
    #[cfg(not(windows))]
    {
        if name.len() > MAX_SEGMENT_UNITS {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let upper = stem.to_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || is_windows_reserved_numbered(&upper, "COM")
        || is_windows_reserved_numbered(&upper, "LPT")
}

#[cfg(windows)]
fn is_windows_reserved_numbered(value: &str, prefix: &str) -> bool {
    let Some(rest) = value.strip_prefix(prefix) else {
        return false;
    };
    matches!(
        rest,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "\u{00B9}" | "\u{00B2}" | "\u{00B3}"
    )
}

#[cfg(windows)]
fn validate_windows_segment(segment: &str) -> Result<(), AppError> {
    if segment
        .chars()
        .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(invalid_segment());
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err(invalid_segment());
    }
    if is_windows_reserved_name(segment) {
        return Err(invalid_segment());
    }
    Ok(())
}

/// Rejects anything that could navigate outside the workspace or make the
/// segment ambiguous on either platform.
pub fn validate_segment(segment: &str) -> Result<(), AppError> {
    if segment.is_empty() || segment == "." || segment == ".." {
        return Err(invalid_segment());
    }
    if segment
        .chars()
        .any(|character| character == '/' || character == '\\' || character == '\0')
    {
        return Err(invalid_segment());
    }
    if segment.chars().any(is_unsafe_display_char) {
        return Err(invalid_segment());
    }
    if segment.len() > MAX_SEGMENT_UNITS {
        return Err(invalid_segment());
    }
    #[cfg(windows)]
    {
        if segment.encode_utf16().count() > MAX_SEGMENT_UNITS {
            return Err(invalid_segment());
        }
        validate_windows_segment(segment)?;
    }

    let mut components = Path::new(segment).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if name == std::ffi::OsStr::new(segment) => Ok(()),
        _ => Err(invalid_segment()),
    }
}

pub fn validate_segments(segments: &[String]) -> Result<(), AppError> {
    if segments.len() > MAX_SEGMENTS {
        return Err(invalid_segment());
    }
    for segment in segments {
        validate_segment(segment)?;
    }
    Ok(())
}

/// Whether a path relative to a workspace root can never produce a visible
/// tree row: any hidden component or a `node_modules` component.
///
/// An empty relative path is the root itself and stays visible. The watcher and
/// the directory listing share this rule so they cannot drift apart.
pub fn is_ignored_relative_path(relative: &Path) -> bool {
    relative.components().any(|component| match component {
        Component::Normal(name) => {
            let Some(name) = name.to_str() else {
                return true;
            };
            name.starts_with('.') || name == "node_modules"
        }
        Component::CurDir => false,
        _ => true,
    })
}

/// Directories first, then case-insensitive name, then original name.
pub fn sort_entries(entries: &mut [WorkspaceEntry]) {
    fn directory_rank(kind: WorkspaceEntryKind) -> u8 {
        match kind {
            WorkspaceEntryKind::Directory | WorkspaceEntryKind::SymlinkDirectory => 0,
            WorkspaceEntryKind::File | WorkspaceEntryKind::SymlinkFile => 1,
        }
    }

    entries.sort_by_cached_key(|entry| {
        (
            directory_rank(entry.kind),
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
}

/// Applies the per-listing cap and reports why the view is incomplete.
///
/// `scan_cap_hit` wins over the listed cap because the order is only
/// best-effort once the scan itself stopped early.
pub fn truncate_entries(
    entries: Vec<WorkspaceEntry>,
    limit: usize,
    scan_cap_hit: bool,
) -> (Vec<WorkspaceEntry>, bool, Option<WorkspaceTruncationReason>) {
    let listed = entries.len() > limit;
    let reason = if scan_cap_hit {
        Some(WorkspaceTruncationReason::Scanned)
    } else if listed {
        Some(WorkspaceTruncationReason::Listed)
    } else {
        None
    };
    let truncated = scan_cap_hit || listed;
    let mut entries = entries;
    if listed {
        entries.truncate(limit);
    }
    (entries, truncated, reason)
}

fn canonicalize_error(error: &std::io::Error) -> AppError {
    match error.kind() {
        std::io::ErrorKind::NotFound => AppError::new(AppErrorCode::NotFound, "path not found"),
        std::io::ErrorKind::PermissionDenied => {
            AppError::new(AppErrorCode::PermissionDenied, "permission denied")
        }
        _ => AppError::new(AppErrorCode::Io, "failed to resolve the path"),
    }
}

fn canonical_child(root: &Path, segments: &[String]) -> Result<PathBuf, AppError> {
    validate_segments(segments)?;
    let mut candidate = root.to_path_buf();
    for segment in segments {
        candidate.push(segment);
    }
    let canonical =
        std::fs::canonicalize(&candidate).map_err(|error| canonicalize_error(&error))?;
    if !canonical.starts_with(root) {
        return Err(outside_scope());
    }
    Ok(canonical)
}

/// Resolves a directory chain below one canonical root.
pub fn resolve_directory(root: &Path, segments: &[String]) -> Result<PathBuf, AppError> {
    let canonical = canonical_child(root, segments)?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| canonicalize_error(&error))?;
    if !metadata.is_dir() {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "path is not a directory",
        ));
    }
    Ok(canonical)
}

/// Resolves a document chain below one canonical root.
pub fn resolve_document(root: &Path, segments: &[String]) -> Result<PathBuf, AppError> {
    let canonical = canonical_child(root, segments)?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| canonicalize_error(&error))?;
    if !metadata.is_file() {
        return Err(AppError::new(AppErrorCode::NotAFile, "path is not a file"));
    }
    ensure_supported_extension(&canonical)?;
    Ok(canonical)
}

fn classify_symlink(path: &Path) -> WorkspaceEntryKind {
    match std::fs::canonicalize(path) {
        Ok(target) => match std::fs::metadata(&target) {
            Ok(metadata) if metadata.is_dir() => WorkspaceEntryKind::SymlinkDirectory,
            _ => WorkspaceEntryKind::SymlinkFile,
        },
        Err(_) => WorkspaceEntryKind::SymlinkFile,
    }
}

fn symlink_openable(root: &Path, path: &Path) -> bool {
    let Ok(target) = std::fs::canonicalize(path) else {
        return false;
    };
    if !target.starts_with(root) {
        return false;
    }
    std::fs::metadata(&target).is_ok_and(|metadata| metadata.is_file())
        && ensure_supported_extension(&target).is_ok()
}

/// Lists one directory level below a canonical workspace root.
///
/// Only regular directories and supported Markdown files are returned. Hidden
/// entries, `node_modules` directories, non-UTF-8 names, control/bidi names and
/// names containing separators are skipped. Symlinks are never expandable and
/// are only openable when their canonical target stays inside the root and is a
/// supported file.
pub fn list_directory_with_limit(
    root: &Path,
    segments: &[String],
    limit: usize,
) -> Result<WorkspaceListing, AppError> {
    let directory = resolve_directory(root, segments)?;
    let read_dir = std::fs::read_dir(&directory).map_err(|error| canonicalize_error(&error))?;

    let mut entries = Vec::new();
    let mut scanned = 0usize;
    let mut scan_cap_hit = false;

    for item in read_dir {
        if scanned >= MAX_SCANNED {
            scan_cap_hit = true;
            break;
        }
        let entry = match item {
            Ok(entry) => entry,
            Err(error) => {
                tracing::debug!(%error, "failed to read one workspace directory entry");
                continue;
            }
        };
        scanned += 1;

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::debug!(%error, "failed to inspect one workspace directory entry");
                continue;
            }
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            tracing::debug!("skipping a workspace entry with a non-UTF-8 name");
            continue;
        };
        if is_unsafe_name(&name) || name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        if file_type.is_symlink() {
            let kind = classify_symlink(&path);
            if kind == WorkspaceEntryKind::SymlinkDirectory && name == "node_modules" {
                continue;
            }
            let openable = kind == WorkspaceEntryKind::SymlinkFile && symlink_openable(root, &path);
            entries.push(WorkspaceEntry {
                name,
                kind,
                expandable: false,
                openable,
            });
        } else if file_type.is_dir() {
            if name == "node_modules" {
                continue;
            }
            entries.push(WorkspaceEntry {
                name,
                kind: WorkspaceEntryKind::Directory,
                expandable: true,
                openable: false,
            });
        } else if file_type.is_file() {
            if ensure_supported_extension(Path::new(&name)).is_err() {
                continue;
            }
            entries.push(WorkspaceEntry {
                name,
                kind: WorkspaceEntryKind::File,
                expandable: false,
                openable: true,
            });
        }
    }

    sort_entries(&mut entries);
    let (entries, truncated, truncation_reason) = truncate_entries(entries, limit, scan_cap_hit);

    Ok(WorkspaceListing {
        segments: segments.to_vec(),
        entries,
        truncated,
        truncation_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical root");
        (dir, root)
    }

    fn entry(name: &str, kind: WorkspaceEntryKind) -> WorkspaceEntry {
        WorkspaceEntry {
            name: name.to_string(),
            kind,
            expandable: matches!(kind, WorkspaceEntryKind::Directory),
            openable: matches!(
                kind,
                WorkspaceEntryKind::File | WorkspaceEntryKind::SymlinkFile
            ),
        }
    }

    #[test]
    fn segments_reject_navigation_and_separators() {
        for invalid in ["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb"] {
            assert!(
                validate_segment(invalid).is_err(),
                "{invalid:?} must be rejected"
            );
        }
        for valid in ["notes", "a b", "文档", "..hidden"] {
            assert!(
                validate_segment(valid).is_ok(),
                "{valid:?} must be accepted"
            );
        }
        assert!(validate_segments(&vec!["a".to_string(); MAX_SEGMENTS + 1]).is_err());
    }

    #[test]
    fn segment_length_is_bounded() {
        assert!(validate_segment(&"a".repeat(MAX_SEGMENT_UNITS)).is_ok());
        assert!(validate_segment(&"a".repeat(MAX_SEGMENT_UNITS + 1)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_segments_reject_invalid_characters_and_reserved_names() {
        for invalid in [
            "a:b",
            "a?b",
            "trailing.",
            "trailing ",
            "CON",
            "nul.md",
            "COM1",
            "LPT9",
        ] {
            assert!(validate_segment(invalid).is_err(), "{invalid:?}");
        }
        assert!(validate_segment("CONSOLE").is_ok());
        assert!(validate_segment("note.md").is_ok());
    }

    #[test]
    fn ignored_relative_paths_cover_hidden_and_node_modules() {
        assert!(!is_ignored_relative_path(Path::new("")));
        assert!(!is_ignored_relative_path(Path::new("docs/notes")));
        assert!(is_ignored_relative_path(Path::new(".git")));
        assert!(is_ignored_relative_path(Path::new("docs/.cache")));
        assert!(is_ignored_relative_path(Path::new("node_modules")));
        assert!(is_ignored_relative_path(Path::new(
            "packages/node_modules/x.js"
        )));
    }

    #[test]
    fn sorting_is_directory_first_then_case_insensitive_and_stable() {
        let mut entries = vec![
            entry("beta.md", WorkspaceEntryKind::File),
            entry("Alpha", WorkspaceEntryKind::Directory),
            entry("alpha.md", WorkspaceEntryKind::File),
            entry("Alpha.md", WorkspaceEntryKind::File),
            entry("zeta", WorkspaceEntryKind::Directory),
            entry("Link", WorkspaceEntryKind::SymlinkDirectory),
        ];
        sort_entries(&mut entries);
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["Alpha", "Link", "zeta", "Alpha.md", "alpha.md", "beta.md"]
        );
    }

    #[test]
    fn truncation_reports_listed_and_scanned_reasons() {
        let entries = vec![
            entry("a.md", WorkspaceEntryKind::File),
            entry("b.md", WorkspaceEntryKind::File),
        ];
        let (kept, truncated, reason) = truncate_entries(entries.clone(), 1, false);
        assert_eq!(kept.len(), 1);
        assert!(truncated);
        assert_eq!(reason, Some(WorkspaceTruncationReason::Listed));

        let (kept, truncated, reason) = truncate_entries(entries.clone(), 10, false);
        assert_eq!(kept.len(), 2);
        assert!(!truncated);
        assert_eq!(reason, None);

        let (_, truncated, reason) = truncate_entries(entries, 10, true);
        assert!(truncated);
        assert_eq!(reason, Some(WorkspaceTruncationReason::Scanned));
    }

    #[test]
    fn listing_skips_hidden_node_modules_and_unsupported_files() {
        let (_dir, root) = canonical_tempdir();
        std::fs::create_dir(root.join("docs")).expect("docs");
        std::fs::create_dir(root.join("node_modules")).expect("node_modules");
        std::fs::create_dir(root.join(".git")).expect("git");
        std::fs::write(root.join("note.md"), "body").expect("note");
        std::fs::write(root.join("component.MDX"), "body").expect("mdx");
        std::fs::write(root.join("notes.txt"), "body").expect("text");
        std::fs::write(root.join(".hidden.md"), "body").expect("hidden");

        let listing =
            list_directory_with_limit(&root, &[], MAX_LISTED).expect("listing must succeed");
        let names = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["docs", "component.MDX", "note.md"]);
        assert!(listing.entries[0].expandable);
        assert!(listing.entries[1].openable);
        assert!(!listing.truncated);
        assert!(listing.segments.is_empty());
    }

    #[test]
    fn listing_one_level_does_not_recurse() {
        let (_dir, root) = canonical_tempdir();
        std::fs::create_dir(root.join("docs")).expect("docs");
        std::fs::write(root.join("docs").join("nested.md"), "body").expect("nested");

        let listing = list_directory_with_limit(&root, &[], MAX_LISTED).expect("root");
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "docs");

        let listing =
            list_directory_with_limit(&root, &["docs".to_string()], MAX_LISTED).expect("docs");
        assert_eq!(listing.entries[0].name, "nested.md");
    }

    #[test]
    fn listing_rejects_escaping_segments_and_files_as_directories() {
        let (_dir, root) = canonical_tempdir();
        std::fs::write(root.join("note.md"), "body").expect("note");

        assert_eq!(
            list_directory_with_limit(&root, &["..".to_string()], MAX_LISTED)
                .expect_err("escape")
                .code,
            AppErrorCode::InvalidPath
        );
        assert_eq!(
            list_directory_with_limit(&root, &["note.md".to_string()], MAX_LISTED)
                .expect_err("file as directory")
                .code,
            AppErrorCode::InvalidPath
        );
        assert_eq!(
            list_directory_with_limit(&root, &["missing".to_string()], MAX_LISTED)
                .expect_err("missing")
                .code,
            AppErrorCode::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_classified_and_only_inside_files_are_openable() {
        let (_dir, root) = canonical_tempdir();
        let outside_dir = tempfile::tempdir().expect("outside");
        let outside_root = std::fs::canonicalize(outside_dir.path()).expect("outside canonical");
        std::fs::create_dir(root.join("docs")).expect("docs");
        std::fs::write(root.join("inside.md"), "body").expect("inside");
        std::fs::write(outside_root.join("outside.md"), "body").expect("outside");

        std::os::unix::fs::symlink(root.join("docs"), root.join("link-dir")).expect("link dir");
        std::os::unix::fs::symlink(root.join("inside.md"), root.join("link-file.md"))
            .expect("link file");
        std::os::unix::fs::symlink(
            outside_root.join("outside.md"),
            root.join("outside-link.md"),
        )
        .expect("outside link");
        std::os::unix::fs::symlink(root.join("missing.md"), root.join("broken.md"))
            .expect("broken link");
        std::os::unix::fs::symlink(root.join("docs"), root.join("node_modules"))
            .expect("node_modules link");

        let listing = list_directory_with_limit(&root, &[], MAX_LISTED).expect("listing");
        let by_name = |name: &str| {
            listing
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };

        assert_eq!(
            by_name("link-dir").kind,
            WorkspaceEntryKind::SymlinkDirectory
        );
        assert!(!by_name("link-dir").expandable);
        assert!(!by_name("link-dir").openable);
        assert_eq!(
            by_name("link-file.md").kind,
            WorkspaceEntryKind::SymlinkFile
        );
        assert!(by_name("link-file.md").openable);
        assert!(!by_name("outside-link.md").openable);
        assert_eq!(by_name("broken.md").kind, WorkspaceEntryKind::SymlinkFile);
        assert!(!by_name("broken.md").openable);
        assert!(listing
            .entries
            .iter()
            .all(|entry| entry.name != "node_modules"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn listing_skips_non_utf8_names() {
        use std::os::unix::ffi::OsStringExt;

        let (_dir, root) = canonical_tempdir();
        std::fs::write(root.join("valid.md"), "body").expect("valid");
        let invalid = std::ffi::OsString::from_vec(vec![b'b', b'a', b'd', 0xff, b'.', b'm', b'd']);
        std::fs::write(root.join(invalid), "body").expect("invalid name");

        let listing = list_directory_with_limit(&root, &[], MAX_LISTED).expect("listing");
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "valid.md");
    }

    #[test]
    fn document_resolution_checks_jail_kind_and_extension() {
        let (_dir, root) = canonical_tempdir();
        std::fs::create_dir(root.join("docs")).expect("docs");
        std::fs::write(root.join("note.md"), "body").expect("note");
        std::fs::write(root.join("notes.txt"), "body").expect("text");

        assert_eq!(
            resolve_document(&root, &["note.md".to_string()]).expect("note"),
            root.join("note.md")
        );
        assert_eq!(
            resolve_document(&root, &["docs".to_string()])
                .expect_err("directory")
                .code,
            AppErrorCode::NotAFile
        );
        assert_eq!(
            resolve_document(&root, &["notes.txt".to_string()])
                .expect_err("extension")
                .code,
            AppErrorCode::UnsupportedExtension
        );
        assert_eq!(
            resolve_document(&root, &["missing.md".to_string()])
                .expect_err("missing")
                .code,
            AppErrorCode::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn document_resolution_rejects_symlinks_that_escape_the_root() {
        let (_dir, root) = canonical_tempdir();
        let outside = tempfile::tempdir().expect("outside");
        let outside_root = std::fs::canonicalize(outside.path()).expect("outside canonical");
        std::fs::write(outside_root.join("outside.md"), "body").expect("outside");
        std::os::unix::fs::symlink(outside_root.join("outside.md"), root.join("escape.md"))
            .expect("link");

        assert_eq!(
            resolve_document(&root, &["escape.md".to_string()])
                .expect_err("escape")
                .code,
            AppErrorCode::OutsideScope
        );
    }

    #[test]
    fn truncated_listing_keeps_the_first_entries_in_order() {
        let (_dir, root) = canonical_tempdir();
        for index in 0..5 {
            std::fs::write(root.join(format!("note-{index}.md")), "body").expect("note");
        }

        let listing = list_directory_with_limit(&root, &[], 2).expect("listing");
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.truncated);
        assert_eq!(
            listing.truncation_reason,
            Some(WorkspaceTruncationReason::Listed)
        );
    }
}
