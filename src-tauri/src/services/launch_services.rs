//! Prunes duplicate LaunchServices registrations left behind by old app copies.
//!
//! macOS keeps one LaunchServices record per application bundle path. A copy
//! mounted from a DMG, downloaded twice or built locally registers the same
//! `CFBundleIdentifier`, so Finder's "Open With" menu accumulates every copy
//! that still exists on disk. Replacing the installed bundle in place does not
//! remove those records.
//!
//! At launch, older duplicate registrations are removed with `lsregister -u`
//! and the current bundle is refreshed with `lsregister -f`. Only the per-user
//! LaunchServices database is edited; the other bundles stay on disk and can
//! still be opened, which re-registers them.
//!
//! The cleanup deliberately keeps a copy that is newer than the running bundle
//! and every installed copy while the running bundle lives outside an install
//! location. That prevents a development or downloaded build from silently
//! taking the file association away from the installed app. It also requires a
//! non-sandboxed app because LaunchServices lives outside the app sandbox.

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The private command line front end of the LaunchServices database.
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// `kLSApplicationNotFoundErr`; `lsregister -u` reports it when the record was
/// already gone, which is the desired end state rather than a failure.
const LS_APPLICATION_NOT_FOUND: &str = "-10814";

/// A locked or wedged LaunchServices database must not pin a blocking thread
/// for the lifetime of the process. The command normally finishes in well
/// under a second.
const LSREGISTER_TIMEOUT: Duration = Duration::from_secs(5);
const LSREGISTER_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// What one cleanup pass changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    /// Copies whose LaunchServices registration was removed.
    pub unregistered: Vec<PathBuf>,
    /// Copies that could not be unregistered, with the reason.
    pub failed: Vec<(PathBuf, String)>,
    /// The reason the running bundle could not be refreshed, if it failed.
    pub refresh_failed: Option<String>,
}

/// The `.app` bundle that contains the currently running executable.
///
/// Returns `None` for a bare binary (`cargo run`, `cargo test`), which has no
/// bundle registration to maintain.
pub fn current_bundle_path() -> Option<PathBuf> {
    bundle_path_from_executable(&std::env::current_exe().ok()?)
}

/// Removes LaunchServices registrations for old copies of the running bundle.
///
/// The bundle identifier and the version are read from the running bundle
/// itself, not from build configuration, so a renamed or re-signed copy keeps
/// working.
pub fn cleanup_duplicate_registrations(current: &Path) -> CleanupReport {
    let mut report = CleanupReport::default();
    if !current.is_dir() {
        tracing::debug!(
            path = %current.display(),
            "skipping LaunchServices cleanup for a missing bundle"
        );
        return report;
    }
    if is_ephemeral_bundle(current) {
        tracing::debug!(
            path = %current.display(),
            "skipping LaunchServices cleanup for a bundle outside an install location"
        );
        return report;
    }
    if !Path::new(LSREGISTER).is_file() {
        tracing::warn!("lsregister is unavailable; skipping LaunchServices cleanup");
        return report;
    }

    let Some(bundle_id) = platform::bundle_identifier(current) else {
        tracing::warn!(
            path = %current.display(),
            "could not read CFBundleIdentifier; skipping LaunchServices cleanup"
        );
        return report;
    };
    let current_version = platform::bundle_version(current);
    let registered = platform::registered_app_paths(&bundle_id);

    report = cleanup_registered(
        &registered,
        current,
        current_version.as_deref(),
        platform::bundle_version,
        run_lsregister,
    );
    report
}

/// Testable half of the cleanup: decides, unregisters and refreshes.
fn cleanup_registered<V, F>(
    registered: &[PathBuf],
    current: &Path,
    current_version: Option<&[u64]>,
    version_of: V,
    mut run: F,
) -> CleanupReport
where
    V: Fn(&Path) -> Option<Vec<u64>>,
    F: FnMut(&str, &Path) -> Result<(), String>,
{
    let mut report = CleanupReport::default();
    if is_ephemeral_bundle(current) {
        return report;
    }

    for duplicate in duplicates(registered, current) {
        let exists = duplicate.is_dir();
        let duplicate_version = version_of(&duplicate);
        if !should_unregister(
            &duplicate,
            current,
            exists,
            duplicate_version.as_deref(),
            current_version,
        ) {
            continue;
        }

        match run("-u", &duplicate) {
            Ok(()) => {
                tracing::debug!(
                    path = %duplicate.display(),
                    "removed a stale LaunchServices registration"
                );
                report.unregistered.push(duplicate);
            }
            Err(error) => {
                tracing::warn!(
                    path = %duplicate.display(),
                    %error,
                    "failed to remove a stale LaunchServices registration"
                );
                report.failed.push((duplicate, error));
            }
        }
    }

    if let Err(error) = run("-f", current) {
        tracing::warn!(
            path = %current.display(),
            %error,
            "failed to refresh the LaunchServices registration"
        );
        report.refresh_failed = Some(error);
    }

    report
}

/// Whether a duplicate may be removed without hiding a better copy.
///
/// The order is deliberate: a newer copy always wins, an installed copy beats
/// a build or download, and a system-wide install beats a per-user one. Only
/// then can an older, equal or unreadable-version copy be removed.
fn should_unregister(
    duplicate: &Path,
    current: &Path,
    duplicate_exists: bool,
    duplicate_version: Option<&[u64]>,
    current_version: Option<&[u64]>,
) -> bool {
    if !duplicate_exists {
        return true;
    }

    let order = match (current_version, duplicate_version) {
        (Some(current), Some(duplicate)) => Some(duplicate.cmp(current)),
        _ => None,
    };
    if order == Some(Ordering::Greater) {
        return false;
    }

    // A development build or a downloaded copy must not hide the app the user
    // actually installed, even when the installed copy is older.
    if is_install_location(duplicate) && !is_install_location(current) {
        return false;
    }
    // `/Applications` outranks `~/Applications`; keep the system-wide copy
    // when the running one is only the per-user copy.
    if duplicate.starts_with("/Applications") && !current.starts_with("/Applications") {
        return false;
    }

    if is_ephemeral_bundle(duplicate) {
        return true;
    }

    // An unreadable version is not a reason to hide the copy.
    order.is_some()
}

/// Extracts the enclosing `.app` bundle from an executable inside it.
fn bundle_path_from_executable(executable: &Path) -> Option<PathBuf> {
    // <bundle>.app/Contents/MacOS/<executable>
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    if macos.file_name()? != OsStr::new("MacOS")
        || contents.file_name()? != OsStr::new("Contents")
        || !bundle
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    {
        return None;
    }
    bundle
        .join("Contents/Info.plist")
        .is_file()
        .then(|| bundle.to_path_buf())
}

/// Whether the bundle lives somewhere macOS does not treat as an installation.
///
/// Bundles on mounted images, Gatekeeper translocation paths, downloads,
/// temporary directories and the Trash disappear or are replaced without
/// updating LaunchServices. Registering one would only create another stale
/// "Open With" entry, so the cleanup leaves the database alone until the app
/// runs from a stable location.
fn is_ephemeral_bundle(bundle: &Path) -> bool {
    const PREFIXES: &[&str] = &[
        "/Volumes",
        "/private/var/folders",
        "/var/folders",
        "/private/tmp",
        "/tmp",
        "/private/var/tmp",
        "/var/tmp",
    ];
    if PREFIXES.iter().any(|root| bundle.starts_with(root)) {
        return true;
    }

    std::env::var_os("HOME")
        .map(PathBuf::from)
        .is_some_and(|home| {
            ["Downloads", "Desktop", ".Trash"]
                .iter()
                .any(|dir| bundle.starts_with(home.join(dir)))
        })
}

/// `/Applications` or `~/Applications`; other locations are user-managed.
fn is_install_location(bundle: &Path) -> bool {
    bundle.starts_with("/Applications")
        || std::env::var_os("HOME")
            .map(PathBuf::from)
            .is_some_and(|home| bundle.starts_with(home.join("Applications")))
}

/// Registered copies that are not the running bundle, de-duplicated.
fn duplicates(registered: &[PathBuf], current: &Path) -> Vec<PathBuf> {
    let mut duplicates: Vec<PathBuf> = Vec::new();
    for path in registered {
        if is_same_path(path, current) || duplicates.iter().any(|seen| is_same_path(seen, path)) {
            continue;
        }
        duplicates.push(path.clone());
    }
    duplicates
}

fn is_same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    if let (Ok(left_meta), Ok(right_meta)) = (std::fs::metadata(left), std::fs::metadata(right)) {
        use std::os::unix::fs::MetadataExt;
        if left_meta.dev() == right_meta.dev() && left_meta.ino() == right_meta.ino() {
            return true;
        }
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn parse_version(value: &str) -> Option<Vec<u64>> {
    let parts: Option<Vec<u64>> = value
        .trim()
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect();
    parts.filter(|parts| !parts.is_empty())
}

fn run_lsregister(flag: &str, bundle: &Path) -> Result<(), String> {
    let mut child = Command::new(LSREGISTER)
        .arg(flag)
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run lsregister: {error}"))?;

    // Drain stderr on its own thread so a verbose failure cannot fill the pipe
    // buffer and block the child before it exits.
    let reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stderr.read_to_end(&mut buffer);
            buffer
        })
    });

    let status = match wait_for_child(&mut child, LSREGISTER_TIMEOUT) {
        Ok(status) => status,
        Err(error) => {
            if let Some(reader) = reader {
                let _ = reader.join();
            }
            return Err(format!("lsregister {flag} {error}"));
        }
    };

    let stderr = reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    if status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&stderr);
    let detail = stderr.trim();
    if flag == "-u" && detail.contains(LS_APPLICATION_NOT_FOUND) {
        return Ok(());
    }
    if detail.is_empty() {
        Err(format!("lsregister {flag} exited with {status}"))
    } else {
        Err(format!("lsregister {flag} exited with {status}: {detail}"))
    }
}

/// Waits for a child process, killing it if it outlives the timeout.
fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {timeout:?}"));
            }
            Ok(None) => std::thread::sleep(LSREGISTER_POLL_INTERVAL),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait: {error}"));
            }
        }
    }
}

/// macOS backend. The whole file is only compiled on macOS; see
/// `services/mod.rs`.
mod platform {
    use std::path::{Path, PathBuf};

    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::bundle::CFBundle;
    use core_foundation::error::CFErrorRef;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::CFURL;

    // The C API is deprecated in favour of
    // `-[NSWorkspace URLsForApplicationsWithBundleIdentifier:]`, but it is
    // available on every supported macOS version and avoids pulling AppKit
    // into this small service.
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        /// Every existing application bundle that claims `bundle_identifier`.
        ///
        /// The error out-parameter is optional; passing null keeps the
        /// ownership rules trivial and an empty list is treated as "nothing to
        /// clean" by the caller.
        fn LSCopyApplicationURLsForBundleIdentifier(
            bundle_identifier: CFStringRef,
            error: *mut CFErrorRef,
        ) -> CFArrayRef;
    }

    pub(super) fn registered_app_paths(bundle_id: &str) -> Vec<PathBuf> {
        let identifier = CFString::new(bundle_id);
        let array_ref = unsafe {
            LSCopyApplicationURLsForBundleIdentifier(
                identifier.as_concrete_TypeRef(),
                std::ptr::null_mut(),
            )
        };
        if array_ref.is_null() {
            return Vec::new();
        }

        let urls: CFArray<CFURL> = unsafe { TCFType::wrap_under_create_rule(array_ref) };
        urls.iter()
            .filter_map(|url| match url.to_path() {
                Some(path) => Some(path),
                None => {
                    tracing::warn!("could not convert a LaunchServices URL to a path");
                    None
                }
            })
            .collect::<Vec<_>>()
    }

    pub(super) fn bundle_identifier(bundle: &Path) -> Option<String> {
        info_string(bundle, "CFBundleIdentifier")
    }

    pub(super) fn bundle_version(bundle: &Path) -> Option<Vec<u64>> {
        super::parse_version(&info_string(bundle, "CFBundleShortVersionString")?)
    }

    fn info_string(bundle: &Path, key: &str) -> Option<String> {
        let url = CFURL::from_path(bundle, true)?;
        let bundle = CFBundle::new(url)?;
        let info = bundle.info_dictionary();
        let value = info.find(CFString::new(key))?;
        value.downcast::<CFString>().map(|value| value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_bundle(root: &Path, name: &str, identifier: &str, version: &str) -> PathBuf {
        let bundle = root.join(name);
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/MacOS/qingmo"), b"").unwrap();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>{identifier}</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
</dict>
</plist>"#
            ),
        )
        .unwrap();
        bundle
    }

    #[test]
    fn locates_the_enclosing_app_bundle() {
        let root = tempfile::tempdir().unwrap();
        let bundle = app_bundle(root.path(), "青墨.APP", "com.wavexzore.qingmo", "0.1.4");
        let executable = bundle.join("Contents/MacOS/qingmo");

        assert_eq!(
            bundle_path_from_executable(&executable),
            Some(bundle.clone())
        );
        assert_eq!(
            bundle_path_from_executable(&root.path().join("target/debug/qingmo")),
            None
        );
        assert_eq!(
            bundle_path_from_executable(Path::new("/usr/local/bin/qingmo")),
            None
        );
        assert_eq!(bundle_path_from_executable(Path::new("/qingmo")), None);
    }

    #[test]
    fn reads_bundle_metadata_from_the_bundle() {
        let root = tempfile::tempdir().unwrap();
        let bundle = app_bundle(root.path(), "青墨.app", "com.example.qingmo", "0.1.4");

        assert_eq!(
            platform::bundle_identifier(&bundle).as_deref(),
            Some("com.example.qingmo")
        );
        assert_eq!(platform::bundle_version(&bundle), Some(vec![0, 1, 4]));
    }

    #[test]
    fn duplicates_skip_the_running_bundle_and_repeats() {
        let registered = vec![
            PathBuf::from("/Applications/青墨.app"),
            PathBuf::from("/Users/me/Downloads/青墨.app"),
            PathBuf::from("/Applications/青墨.app"),
            PathBuf::from("/Volumes/Qingmo/青墨.app"),
        ];

        assert_eq!(
            duplicates(&registered, Path::new("/Applications/青墨.app")),
            [
                PathBuf::from("/Users/me/Downloads/青墨.app"),
                PathBuf::from("/Volumes/Qingmo/青墨.app"),
            ]
        );
    }

    #[test]
    fn duplicates_are_empty_without_other_copies() {
        let registered = vec![PathBuf::from("/Applications/青墨.app")];
        assert!(duplicates(&registered, Path::new("/Applications/青墨.app")).is_empty());
        assert!(duplicates(&[], Path::new("/Applications/青墨.app")).is_empty());
    }

    #[test]
    fn ephemeral_bundles_are_not_cleaned_up() {
        assert!(is_ephemeral_bundle(Path::new("/Volumes/Qingmo/青墨.app")));
        assert!(is_ephemeral_bundle(Path::new(
            "/private/var/folders/xy/T/AppTranslocation/ABC/青墨.app"
        )));
        assert!(is_ephemeral_bundle(Path::new(
            "/var/folders/xy/T/tmp.123/青墨.app"
        )));
        assert!(is_ephemeral_bundle(Path::new(
            "/private/tmp/qingmo/青墨.app"
        )));
        assert!(is_ephemeral_bundle(Path::new("/tmp/qingmo/青墨.app")));
        assert!(is_ephemeral_bundle(Path::new("/var/tmp/qingmo/青墨.app")));

        assert!(!is_ephemeral_bundle(Path::new("/Applications/青墨.app")));
        assert!(!is_ephemeral_bundle(Path::new(
            "/Users/me/Applications/青墨.app"
        )));
        assert!(!is_ephemeral_bundle(Path::new(
            "/Users/me/Code/Qingmo/src-tauri/target/debug/bundle/macos/青墨.app"
        )));

        let home = std::env::var_os("HOME").expect("HOME must be set");
        assert!(is_ephemeral_bundle(
            &PathBuf::from(&home).join("Downloads/青墨.app")
        ));
        assert!(is_ephemeral_bundle(
            &PathBuf::from(&home).join(".Trash/青墨.app")
        ));
    }

    #[test]
    fn recognizes_install_locations() {
        assert!(is_install_location(Path::new("/Applications/青墨.app")));
        let home = std::env::var_os("HOME").expect("HOME must be set");
        assert!(is_install_location(
            &PathBuf::from(home).join("Applications/青墨.app")
        ));
        assert!(!is_install_location(Path::new(
            "/Users/me/Code/Qingmo/target/debug/bundle/macos/青墨.app"
        )));
    }

    #[test]
    fn treats_symlinked_paths_as_the_same_bundle() {
        let root = tempfile::tempdir().unwrap();
        let bundle = app_bundle(root.path(), "青墨.app", "com.wavexzore.qingmo", "0.1.4");
        let link = root.path().join("青墨-link.app");
        std::os::unix::fs::symlink(&bundle, &link).unwrap();

        assert!(is_same_path(&bundle, &link));
    }

    #[test]
    fn keeps_newer_and_installed_copies() {
        let current = Path::new("/Users/me/Code/Qingmo/target/debug/bundle/macos/青墨.app");

        assert!(!should_unregister(
            Path::new("/Applications/青墨.app"),
            current,
            true,
            Some(&[0, 1, 3]),
            Some(&[0, 1, 4])
        ));
        assert!(!should_unregister(
            Path::new("/Applications/青墨.app"),
            current,
            true,
            Some(&[0, 1, 5]),
            Some(&[0, 1, 4])
        ));
        assert!(!should_unregister(
            Path::new("/Applications/青墨.app"),
            current,
            true,
            Some(&[0, 1, 4]),
            Some(&[0, 1, 4])
        ));
        assert!(should_unregister(
            Path::new("/Users/me/Downloads/青墨.app"),
            Path::new("/Applications/青墨.app"),
            true,
            Some(&[0, 1, 4]),
            Some(&[0, 1, 4])
        ));
        assert!(should_unregister(
            Path::new("/tmp/gone.app"),
            current,
            false,
            None,
            Some(&[0, 1, 4])
        ));
        assert!(!should_unregister(
            Path::new("/Volumes/Qingmo/青墨.app"),
            current,
            true,
            Some(&[9, 9, 9]),
            Some(&[0, 1, 4])
        ));
        assert!(should_unregister(
            Path::new("/Volumes/Qingmo/青墨.app"),
            current,
            true,
            Some(&[0, 1, 3]),
            Some(&[0, 1, 4])
        ));
        assert!(!should_unregister(
            Path::new("/Users/me/old/青墨.app"),
            current,
            true,
            None,
            Some(&[0, 1, 4])
        ));
    }

    #[test]
    fn a_system_install_outranks_a_per_user_install() {
        let user_install = Path::new("/Users/me/Applications/青墨.app");
        assert!(!should_unregister(
            Path::new("/Applications/青墨.app"),
            user_install,
            true,
            Some(&[0, 1, 4]),
            Some(&[0, 1, 4])
        ));
        assert!(!should_unregister(
            Path::new("/Applications/青墨.app"),
            user_install,
            true,
            Some(&[0, 1, 3]),
            Some(&[0, 1, 4])
        ));
        assert!(should_unregister(
            Path::new("/Users/me/Applications/青墨.app"),
            Path::new("/Applications/青墨.app"),
            true,
            Some(&[0, 1, 3]),
            Some(&[0, 1, 4])
        ));
    }

    #[test]
    fn unregisters_duplicates_then_refreshes_current() {
        let current = PathBuf::from("/Users/me/Qingmo.app");
        let older = PathBuf::from("/Users/me/old/青墨.app");
        let registered = vec![current.clone(), older.clone(), current.clone()];
        let mut calls: Vec<(String, PathBuf)> = Vec::new();

        let report = cleanup_registered(
            &registered,
            &current,
            Some(&[0, 1, 4]),
            |_| None,
            |flag, path| {
                calls.push((flag.to_string(), path.to_path_buf()));
                Ok(())
            },
        );

        assert_eq!(
            calls,
            [
                ("-u".to_string(), older.clone()),
                ("-f".to_string(), current.clone()),
            ]
        );
        assert_eq!(report.unregistered, [older]);
        assert!(report.failed.is_empty());
        assert_eq!(report.refresh_failed, None);
    }

    #[test]
    fn records_unregister_failures_and_refresh_failures() {
        let current = PathBuf::from("/Users/me/Qingmo.app");
        let duplicate = PathBuf::from("/Users/me/old/青墨.app");
        let mut calls = 0;

        let report = cleanup_registered(
            &[current.clone(), duplicate.clone()],
            &current,
            Some(&[0, 1, 4]),
            |_| None,
            |flag, _| {
                calls += 1;
                if flag == "-u" {
                    Err("unregister failed".to_string())
                } else {
                    Err("refresh failed".to_string())
                }
            },
        );

        assert_eq!(calls, 2);
        assert_eq!(
            report.failed,
            [(duplicate, "unregister failed".to_string())]
        );
        assert_eq!(report.refresh_failed.as_deref(), Some("refresh failed"));
    }

    #[test]
    fn ephemeral_current_bundle_skips_every_call() {
        let mut calls = 0;
        let report = cleanup_registered(
            &[
                PathBuf::from("/Volumes/Qingmo/青墨.app"),
                PathBuf::from("/Applications/青墨.app"),
            ],
            Path::new("/Volumes/Qingmo/青墨.app"),
            Some(&[0, 1, 4]),
            |_| None,
            |_, _| {
                calls += 1;
                Ok(())
            },
        );

        assert_eq!(calls, 0);
        assert_eq!(report, CleanupReport::default());
    }

    #[test]
    fn parses_numeric_versions() {
        assert_eq!(parse_version("0.1.4"), Some(vec![0, 1, 4]));
        assert_eq!(parse_version(" 1 "), Some(vec![1]));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("0.1.4-beta"), None);
    }

    #[test]
    fn a_stuck_child_is_killed_after_the_timeout() {
        let mut child = Command::new("/bin/sleep")
            .arg("10")
            .spawn()
            .expect("sleep must start");
        let started = Instant::now();
        let error = wait_for_child(&mut child, Duration::from_millis(50))
            .expect_err("a sleeping child must time out");
        assert!(error.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn an_exited_child_reports_its_status() {
        let mut child = Command::new("/usr/bin/true")
            .spawn()
            .expect("true must start");
        let status = wait_for_child(&mut child, Duration::from_secs(5))
            .expect("true must exit before the timeout");
        assert!(status.success());
    }
}
