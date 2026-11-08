//! Cross-thread sidecar lock behaviour (the same OS primitive used across
//! processes). A second owner must wait at most `LOCK_TIMEOUT_MS`, then fail
//! with `BUSY`; dropping the guard releases the path immediately.

use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::FileLockStore;
use tempfile::TempDir;

fn fixture() -> (TempDir, FileLockStore, std::path::PathBuf) {
    let dir = TempDir::new().expect("temp dir");
    let store = FileLockStore::open(dir.path().join("locks")).expect("lock store");
    let document = dir.path().join("note.md");
    fs::write(&document, "body\n").expect("fixture");
    let canonical = fs::canonicalize(&document).expect("canonical");
    (dir, store, canonical)
}

#[test]
fn a_held_lock_times_out_with_busy_and_releases_on_drop() {
    let (_dir, store, path) = fixture();
    let guard = store.acquire(&path).expect("first lock");
    let started = Instant::now();
    let error = store
        .acquire(&path)
        .expect_err("second lock must fail while held");
    assert_eq!(error.code, AppErrorCode::Busy);
    assert!(started.elapsed() >= Duration::from_millis(1_900));
    assert!(started.elapsed() < Duration::from_millis(5_000));

    drop(guard);
    store.acquire(&path).expect("lock must be reusable");
}

#[test]
fn a_waiting_thread_acquires_after_the_owner_releases() {
    let (_dir, store, path) = fixture();
    let guard = store.acquire(&path).expect("first lock");
    let (sender, receiver) = mpsc::channel();
    let waiting = store.clone();
    let waiting_path = path.clone();
    let handle = std::thread::spawn(move || {
        let result = waiting.acquire(&waiting_path);
        sender
            .send(result.map(|_guard| ()).map_err(|error| error.code))
            .expect("send result");
    });

    std::thread::sleep(Duration::from_millis(200));
    drop(guard);
    let result = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("second acquirer must report");
    handle.join().expect("thread join");
    assert!(result.is_ok(), "result: {result:?}");
}

#[test]
fn a_nonexistent_save_target_can_be_locked() {
    let dir = TempDir::new().expect("temp dir");
    let store = FileLockStore::open(dir.path().join("locks")).expect("lock store");
    let target = dir.path().join("new.md");
    let guard = store.acquire_target(&target).expect("target lock");
    assert!(store.acquire_target(&target).is_err());
    drop(guard);
}

#[test]
fn disabled_store_is_a_safe_noop() {
    let store = FileLockStore::disabled();
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("note.md");
    let _guard = store.acquire(&path).expect("disabled acquire");
    let _second = store.acquire(&path).expect("disabled acquire is reentrant");
}
