//! Document token lifecycle: Save As retirement and close ordering.

use std::fs;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::state::{DocumentRegistry, WindowSessions};

fn write(path: &std::path::Path, text: &str) {
    fs::write(path, text).expect("fixture");
}

#[test]
fn save_as_swap_retires_current_and_previous_tokens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let registry = DocumentRegistry::new();
    let sessions = WindowSessions::new();

    let first_payload = registry.open_path(first).expect("open first");
    sessions.set_token("doc-1", first_payload.doc_token.clone());
    let second_payload = registry.open_path(second).expect("open second");
    // An in-window switch retains the first token for rollback.
    let activation = sessions
        .activate_document("doc-1", Some(second_payload.doc_token.clone()))
        .expect("switch");
    assert_eq!(
        activation.previous.as_deref(),
        Some(first_payload.doc_token.as_str())
    );

    let saved = registry
        .save_as(dir.path().join("c.md"), "c\n")
        .expect("save as");
    let swap = sessions.replace_token("doc-1", saved.doc_token.clone());
    assert!(swap.accepted);
    assert_eq!(
        swap.current.as_deref(),
        Some(second_payload.doc_token.as_str())
    );
    assert_eq!(
        swap.previous.as_deref(),
        Some(first_payload.doc_token.as_str())
    );

    for old in [swap.current, swap.previous].into_iter().flatten() {
        let _ = registry.deactivate(&old);
        assert!(registry.release(&old));
    }

    assert!(registry.get(&first_payload.doc_token).is_err());
    assert!(registry.get(&second_payload.doc_token).is_err());
    assert!(registry.get(&saved.doc_token).is_ok());
    assert_eq!(registry.len(), 1);
    assert!(!sessions.owns_current_document("doc-1", &first_payload.doc_token));
    assert!(!sessions.owns_current_document("doc-1", &second_payload.doc_token));
    assert!(sessions.owns_current_document("doc-1", &saved.doc_token));
    assert_eq!(
        sessions.label_for_current(&saved.doc_token).as_deref(),
        Some("doc-1")
    );
}

#[test]
fn a_previous_token_is_not_current_for_another_window() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = dir.path().join("a.md");
    let second = dir.path().join("b.md");
    write(&first, "a");
    write(&second, "b");
    let registry = DocumentRegistry::new();
    let sessions = WindowSessions::new();

    let first_payload = registry.open_path(first).expect("open first");
    let second_payload = registry.open_path(second).expect("open second");
    sessions.set_token("doc-1", first_payload.doc_token.clone());
    let activation = sessions
        .activate_document("doc-1", Some(second_payload.doc_token.clone()))
        .expect("switch");
    let previous = activation.previous.expect("previous");

    assert!(!sessions.owns_current_document("doc-1", &previous));
    assert!(!sessions.owns_current_document("doc-2", &previous));
    assert!(!sessions.owns_current_document("doc-2", &second_payload.doc_token));
    assert!(sessions.label_for_current(&previous).is_none());
}

#[test]
fn deactivate_waits_for_an_in_flight_save_and_rejects_later_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("a.md");
    write(&path, "original");
    let registry = DocumentRegistry::new();
    let payload = registry.open_path(path.clone()).expect("open");
    let record = registry.get(&payload.doc_token).expect("record");

    let (held_sender, held_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let _io = record.lock_io().expect("io lock");
        held_sender.send(()).expect("signal");
        thread::sleep(Duration::from_millis(180));
    });
    held_receiver.recv().expect("in-flight save holds the lock");

    let started = Instant::now();
    registry
        .deactivate(&payload.doc_token)
        .expect("deactivate waits for the lock");
    assert!(
        started.elapsed() >= Duration::from_millis(120),
        "deactivate must wait for the in-flight save"
    );
    worker.join().expect("worker");

    // The record still exists but is no longer writable. A queued save that
    // starts after close must fail instead of writing into a closed window.
    let error = registry
        .write_atomic(&payload.doc_token, "late\n", None)
        .expect_err("inactive document must reject the write");
    assert_eq!(error.code, AppErrorCode::InvalidPath);

    assert!(registry.release(&payload.doc_token));
    assert!(registry.get(&payload.doc_token).is_err());
    assert_eq!(
        fs::read_to_string(&path).expect("file"),
        "original",
        "the rejected write must not touch the file"
    );
}

#[test]
fn save_result_reports_the_issuing_token_and_generation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("a.md");
    write(&path, "before\n");
    let registry = DocumentRegistry::new();
    let payload = registry.open_path(path).expect("open");
    let result = registry
        .write_atomic(&payload.doc_token, "after\n", None)
        .expect("save");
    assert_eq!(result.doc_token, payload.doc_token);
    assert!(result.generation > 0);
    assert_eq!(result.size, 6);
}

#[test]
fn open_returns_a_fresh_active_record() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("a.md");
    write(&path, "body");
    let registry = DocumentRegistry::new();
    let payload = registry.open_path(path).expect("open");
    let record = registry.get(&payload.doc_token).expect("record");
    assert!(record.is_active());
    assert!(
        record.document_id().is_none(),
        "identity is optional without a store"
    );
}
