use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::ipc::contract::EVENT_DOCUMENT_CHANGED;
use crate::ipc::dto::{DocumentChangeKind, DocumentChangedPayload};
use crate::services::file_service::{mtime_ms, MAX_FILE_BYTES};
use crate::state::DocumentRegistry;

/// How often every open document is checked for a different disk version.
///
/// A polling loop is deliberately used instead of a platform file watcher:
/// atomic renames, network volumes and sleep/wake behave the same on macOS,
/// Windows and Linux, and the process only stats one or two open files per
/// tick. The interval is short enough to feel immediate without keeping the
/// disk busy.
pub const DOCUMENT_WATCH_INTERVAL: Duration = Duration::from_millis(750);

/// A single missing observation can be a transient rename performed by
/// another editor's atomic save, so deletion is confirmed on the second poll.
const MISSES_BEFORE_DELETE: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiskVersion {
    hash: String,
    size: u64,
    mtime_ms: i64,
}

#[derive(Debug)]
struct WatchEntry {
    path: PathBuf,
    /// Size/mtime of the last observed version, used to skip hashing.
    last_stat: Option<(u64, i64)>,
    /// Hash already delivered to the window; avoids repeat banners.
    emitted_hash: Option<String>,
    misses: u8,
    deleted_emitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ObservedChange {
    Modified(DiskVersion),
    Deleted,
}

/// Watches the disk version of every document owned by an open window.
///
/// The watcher never writes and never touches the editor text: it only emits
/// `app://document-changed` with the version it found. The window decides
/// whether the buffer is clean enough to reload automatically or whether the
/// user must resolve a conflict first.
pub struct DocumentWatcher {
    inner: Arc<Inner>,
    stop: Arc<AtomicBool>,
}

struct Inner {
    app: AppHandle,
    registry: DocumentRegistry,
    docs: Mutex<HashMap<String, WatchEntry>>,
}

impl DocumentWatcher {
    pub fn start(app: AppHandle, registry: DocumentRegistry) -> Self {
        let inner = Arc::new(Inner {
            app,
            registry,
            docs: Mutex::new(HashMap::new()),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let worker = Arc::clone(&inner);
        let worker_stop = Arc::clone(&stop);

        if let Err(error) = std::thread::Builder::new()
            .name("document-watcher".to_string())
            .spawn(move || {
                while !worker_stop.load(Ordering::Relaxed) {
                    std::thread::sleep(DOCUMENT_WATCH_INTERVAL);
                    if worker_stop.load(Ordering::Relaxed) {
                        break;
                    }
                    worker.poll_once();
                }
            })
        {
            tracing::error!(%error, "failed to start the document watcher thread");
        }

        Self { inner, stop }
    }

    /// Registers the canonical target that belongs to `doc_token`.
    ///
    /// The first poll reads (and hashes) the file, so a change that happened
    /// between opening the document and registering the watch is still found.
    pub fn watch(&self, doc_token: &str, path: &Path) {
        let Ok(mut docs) = self.inner.docs.lock() else {
            return;
        };
        docs.insert(
            doc_token.to_string(),
            WatchEntry {
                path: path.to_path_buf(),
                last_stat: None,
                emitted_hash: None,
                misses: 0,
                deleted_emitted: false,
            },
        );
    }

    /// Stops watching a document after its window has released the token.
    pub fn unwatch(&self, doc_token: &str) {
        let Ok(mut docs) = self.inner.docs.lock() else {
            return;
        };
        docs.remove(doc_token);
    }
}

impl Inner {
    fn forget(&self, doc_token: &str) {
        if let Ok(mut docs) = self.docs.lock() {
            docs.remove(doc_token);
        }
    }

    fn poll_once(&self) {
        let targets: Vec<(String, PathBuf)> = {
            let Ok(docs) = self.docs.lock() else {
                return;
            };
            docs.iter()
                .map(|(token, entry)| (token.clone(), entry.path.clone()))
                .collect()
        };

        for (token, path) in targets {
            let Some(record) = self.registry.get(&token).ok() else {
                // The window closed between the snapshot and this check.
                self.forget(&token);
                continue;
            };

            let stat = match stat_of(&path) {
                Ok(stat) => stat,
                Err(error) => {
                    tracing::debug!(%error, path = %path.display(), "document stat failed");
                    continue;
                }
            };

            // Hashing is only needed when size/mtime moved. A missing file is
            // always observed so the deletion confirmation can advance.
            let unchanged = {
                let Ok(docs) = self.docs.lock() else {
                    continue;
                };
                docs.get(&token)
                    .is_some_and(|entry| stat.is_some() && entry.last_stat == stat)
            };
            if unchanged {
                continue;
            }

            let disk = match stat {
                Some((size, _)) if size > MAX_FILE_BYTES => {
                    // A document larger than the app's own limit can never be
                    // reloaded; avoid hashing an arbitrarily large file on
                    // every tick.
                    tracing::debug!(
                        path = %path.display(),
                        size,
                        "skipping an oversized external document"
                    );
                    if let Ok(mut docs) = self.docs.lock() {
                        if let Some(entry) = docs.get_mut(&token) {
                            entry.last_stat = stat;
                        }
                    }
                    continue;
                }
                Some((size, mtime_ms)) => match read_version(&path) {
                    Ok(hash) => {
                        // A writer that updates the file in place can expose a
                        // partial version while it is still writing. Only
                        // report a version whose metadata stayed stable for
                        // the whole read.
                        if stat_of(&path).ok().flatten() != Some((size, mtime_ms)) {
                            continue;
                        }
                        Some(DiskVersion {
                            hash,
                            size,
                            mtime_ms,
                        })
                    }
                    Err(error) => {
                        tracing::debug!(%error, path = %path.display(), "document hash failed");
                        continue;
                    }
                },
                None => None,
            };

            // Re-read the base hash after hashing: an atomic save updates it
            // while the watcher is reading, and that write must not be
            // reported back to the window as an external change.
            let base_hash = match record.lock_state() {
                Ok(state) => state.base_hash.clone(),
                Err(_) => continue,
            };

            let change = {
                let Ok(mut docs) = self.docs.lock() else {
                    continue;
                };
                let Some(entry) = docs.get_mut(&token) else {
                    continue;
                };
                detect(entry, &base_hash, disk)
            };

            match change {
                Some(ObservedChange::Modified(version)) => {
                    tracing::debug!(
                        doc_token = token,
                        path = %path.display(),
                        hash = version.hash,
                        "external document change detected"
                    );
                    self.emit(DocumentChangedPayload {
                        doc_token: token,
                        kind: DocumentChangeKind::Modified,
                        current_hash: Some(version.hash),
                        current_size: Some(version.size),
                        current_mtime_ms: Some(version.mtime_ms),
                    });
                }
                Some(ObservedChange::Deleted) => {
                    tracing::debug!(
                        doc_token = token,
                        path = %path.display(),
                        "document deletion detected"
                    );
                    self.emit(DocumentChangedPayload {
                        doc_token: token,
                        kind: DocumentChangeKind::Deleted,
                        current_hash: None,
                        current_size: None,
                        current_mtime_ms: None,
                    });
                }
                None => {}
            }
        }
    }

    fn emit(&self, payload: DocumentChangedPayload) {
        if let Err(error) = self.app.emit(EVENT_DOCUMENT_CHANGED, payload) {
            tracing::error!(%error, "failed to emit app://document-changed");
        }
    }
}

impl Drop for DocumentWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Compares one observation with the version the editor already has.
///
/// `base_hash` is the version the window opened/reloaded/saved. A matching
/// hash is our own write or an unchanged file and must never reach the UI.
fn detect(
    entry: &mut WatchEntry,
    base_hash: &str,
    disk: Option<DiskVersion>,
) -> Option<ObservedChange> {
    match disk {
        Some(version) => {
            entry.misses = 0;
            entry.deleted_emitted = false;
            entry.last_stat = Some((version.size, version.mtime_ms));

            if version.hash == base_hash {
                entry.emitted_hash = None;
                return None;
            }
            if entry.emitted_hash.as_deref() == Some(version.hash.as_str()) {
                return None;
            }

            entry.emitted_hash = Some(version.hash.clone());
            Some(ObservedChange::Modified(version))
        }
        None => {
            entry.last_stat = None;
            entry.misses = entry.misses.saturating_add(1);
            if entry.misses >= MISSES_BEFORE_DELETE && !entry.deleted_emitted {
                entry.deleted_emitted = true;
                entry.emitted_hash = None;
                Some(ObservedChange::Deleted)
            } else {
                None
            }
        }
    }
}

fn stat_of(path: &Path) -> std::io::Result<Option<(u64, i64)>> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some((metadata.len(), mtime_ms(&metadata)))),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_version(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> WatchEntry {
        WatchEntry {
            path: PathBuf::from("/docs/note.md"),
            last_stat: None,
            emitted_hash: None,
            misses: 0,
            deleted_emitted: false,
        }
    }

    fn version(hash: &str) -> DiskVersion {
        DiskVersion {
            hash: hash.to_string(),
            size: 6,
            mtime_ms: 1,
        }
    }

    #[test]
    fn hashes_the_file_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"hello\n").expect("write");

        assert_eq!(
            read_version(&path).expect("hash"),
            blake3::hash(b"hello\n").to_hex().to_string()
        );
        let (size, mtime) = stat_of(&path).expect("stat").expect("file");
        assert_eq!(size, 6);
        assert!(mtime > 0);
    }

    #[test]
    fn missing_files_produce_no_version() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(stat_of(&dir.path().join("missing.md")).expect("stat"), None);
    }

    #[test]
    fn the_base_version_is_never_reported() {
        let mut entry = entry();
        assert_eq!(detect(&mut entry, "base", Some(version("base"))), None);
        assert_eq!(entry.emitted_hash, None);
    }

    #[test]
    fn a_new_disk_hash_is_reported_once() {
        let mut entry = entry();
        let first = detect(&mut entry, "base", Some(version("external")));
        assert_eq!(first, Some(ObservedChange::Modified(version("external"))));
        assert_eq!(entry.last_stat, Some((6, 1)));

        assert_eq!(detect(&mut entry, "base", Some(version("external"))), None);
    }

    #[test]
    fn a_later_external_version_is_reported_again() {
        let mut entry = entry();
        assert!(detect(&mut entry, "base", Some(version("external-1"))).is_some());
        assert!(detect(&mut entry, "base", Some(version("external-2"))).is_some());
    }

    #[test]
    fn deletion_is_confirmed_on_the_second_poll_and_only_emitted_once() {
        let mut entry = entry();
        assert_eq!(detect(&mut entry, "base", None), None);
        assert_eq!(
            detect(&mut entry, "base", None),
            Some(ObservedChange::Deleted)
        );
        assert_eq!(detect(&mut entry, "base", None), None);
    }

    #[test]
    fn a_transient_missing_sample_does_not_report_deletion() {
        let mut entry = entry();
        assert_eq!(detect(&mut entry, "base", None), None);
        assert_eq!(detect(&mut entry, "base", Some(version("base"))), None);
        assert_eq!(entry.misses, 0);
        assert!(!entry.deleted_emitted);
    }

    #[test]
    fn a_reappearing_file_with_new_content_is_reported() {
        let mut entry = entry();
        assert_eq!(detect(&mut entry, "base", None), None);
        assert_eq!(
            detect(&mut entry, "base", None),
            Some(ObservedChange::Deleted)
        );
        assert_eq!(
            detect(&mut entry, "base", Some(version("external"))),
            Some(ObservedChange::Modified(version("external")))
        );
    }
}
