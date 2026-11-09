//! Workspace watcher lifecycle and routing tests.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use notify_debouncer_full::notify::event::{
    CreateKind, DataChange, EventKind, ModifyKind, RenameMode,
};
use notify_debouncer_full::notify::Event;
use notify_debouncer_full::DebouncedEvent;
use qingmo_lib::ipc::dto::DocumentRelocatedPayload;
use qingmo_lib::state::workspace_watcher::{
    BuildScheduler, EventHandler, ImmediateScheduler, WatchHandle, WatcherFactory,
    WorkspaceEventSink, WorkspaceWatcher,
};
use qingmo_lib::state::{DocumentRegistry, WindowSessions, WorkspaceRegistry, WorkspaceToken};

struct NoopHandle;

impl WatchHandle for NoopHandle {}

#[derive(Clone, Default)]
struct RecordingSink {
    emits: Arc<Mutex<Vec<String>>>,
    relocated: Arc<Mutex<Vec<(String, DocumentRelocatedPayload)>>>,
}

impl WorkspaceEventSink for RecordingSink {
    fn emit(&self, label: &str) {
        self.emits
            .lock()
            .expect("sink lock")
            .push(label.to_string());
    }

    fn relocated(&self, label: &str, payload: &DocumentRelocatedPayload) {
        self.relocated
            .lock()
            .expect("relocated lock")
            .push((label.to_string(), payload.clone()));
    }
}

#[derive(Clone, Default)]
struct RecordingFactory {
    built: Arc<Mutex<Vec<PathBuf>>>,
    handlers: Arc<Mutex<Vec<(PathBuf, EventHandler)>>>,
    fail: Arc<Mutex<HashSet<PathBuf>>>,
}

impl RecordingFactory {
    fn fail_root(&self, root: &std::path::Path) {
        self.fail
            .lock()
            .expect("fail lock")
            .insert(root.to_path_buf());
    }

    fn clear_failures(&self) {
        self.fail.lock().expect("fail lock").clear();
    }

    fn handler_for(&self, root: &std::path::Path, index: usize) -> EventHandler {
        self.handlers
            .lock()
            .expect("handlers lock")
            .iter()
            .filter(|(path, _)| path == root)
            .nth(index)
            .map(|(_, handler)| Arc::clone(handler))
            .unwrap_or_else(|| panic!("missing handler {index} for {}", root.display()))
    }
}

impl WatcherFactory for RecordingFactory {
    fn build(
        &self,
        root: &std::path::Path,
        handler: EventHandler,
    ) -> Result<Box<dyn WatchHandle>, &'static str> {
        if self.fail.lock().expect("fail lock").contains(root) {
            return Err("watch");
        }
        self.built
            .lock()
            .expect("built lock")
            .push(root.to_path_buf());
        self.handlers
            .lock()
            .expect("handlers lock")
            .push((root.to_path_buf(), handler));
        Ok(Box::new(NoopHandle))
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    watcher: WorkspaceWatcher,
    sessions: WindowSessions,
    registry: WorkspaceRegistry,
    sink: RecordingSink,
    factory: RecordingFactory,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = std::fs::canonicalize(dir.path()).expect("canonical root");
    let sessions = WindowSessions::new();
    let registry = WorkspaceRegistry::new();
    let sink = RecordingSink::default();
    let factory = RecordingFactory::default();
    let watcher = WorkspaceWatcher::with_hooks(
        Arc::new(sink.clone()),
        sessions.clone(),
        registry.clone(),
        Arc::new(factory.clone()),
        Arc::new(ImmediateScheduler),
    );
    Harness {
        _dir: dir,
        root,
        watcher,
        sessions,
        registry,
        sink,
        factory,
    }
}

impl Harness {
    fn attach(&self, label: &str) -> WorkspaceToken {
        let (token, _) = self.registry.open_canonical(self.root.clone());
        let sessions = &self.sessions;
        sessions
            .set_workspace(label, token.clone(), sessions.epoch(label))
            .expect("attach workspace");
        token
    }

    fn attach_other_root(&self, label: &str) -> (tempfile::TempDir, PathBuf, WorkspaceToken) {
        let dir = tempfile::tempdir().expect("other dir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical other");
        let (token, _) = self.registry.open_canonical(root.clone());
        let sessions = &self.sessions;
        sessions
            .set_workspace(label, token.clone(), sessions.epoch(label))
            .expect("attach other workspace");
        (dir, root, token)
    }

    fn take_emits(&self) -> Vec<String> {
        std::mem::take(&mut *self.sink.emits.lock().expect("sink lock"))
    }

    fn take_relocated(&self) -> Vec<(String, DocumentRelocatedPayload)> {
        std::mem::take(&mut *self.sink.relocated.lock().expect("relocated lock"))
    }

    fn trigger(&self, root: &std::path::Path, handler_index: usize, events: Vec<Event>) {
        let handler = self.factory.handler_for(root, handler_index);
        let debounced = events
            .into_iter()
            .map(|event| DebouncedEvent::new(event, Instant::now()))
            .collect();
        handler(Ok(debounced));
    }
}

fn event(kind: EventKind, path: PathBuf) -> Event {
    Event {
        kind,
        paths: vec![path],
        attrs: Default::default(),
    }
}

#[test]
fn one_root_with_two_tokens_builds_one_watcher_and_emits_once_per_window() {
    let h = harness();
    h.attach("doc-1");
    h.attach("doc-2");
    h.watcher.sync_watchers();

    assert_eq!(h.watcher.watched_root_count(), 1);
    assert_eq!(h.factory.built.lock().expect("built").len(), 1);
    // The successful build emits one catch-up event per owning window.
    let mut initial = h.take_emits();
    initial.sort();
    assert_eq!(initial, vec!["doc-1".to_string(), "doc-2".to_string()]);

    h.trigger(
        &h.root,
        0,
        vec![event(
            EventKind::Create(CreateKind::File),
            h.root.join("note.md"),
        )],
    );
    let mut emitted = h.take_emits();
    emitted.sort();
    assert_eq!(emitted, vec!["doc-1".to_string(), "doc-2".to_string()]);

    // Pure content changes and hidden paths never refresh the tree.
    h.trigger(
        &h.root,
        0,
        vec![event(
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            h.root.join("note.md"),
        )],
    );
    h.trigger(
        &h.root,
        0,
        vec![event(
            EventKind::Create(CreateKind::File),
            h.root.join(".git").join("index"),
        )],
    );
    assert!(h.take_emits().is_empty());

    // A rename with one visible end refreshes once for the whole batch.
    h.trigger(
        &h.root,
        0,
        vec![
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                h.root.join("note.md"),
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                h.root.join("hidden").join("note.md"),
            ),
            event(EventKind::Create(CreateKind::File), h.root.join("other.md")),
        ],
    );
    assert_eq!(h.take_emits().len(), 2);
}

#[test]
fn releasing_one_window_keeps_the_watcher_and_releasing_all_drops_it() {
    let h = harness();
    let first = h.attach("doc-1");
    h.attach("doc-2");
    h.watcher.sync_watchers();
    h.take_emits();

    h.sessions.release("doc-1");
    h.registry.release(&first);
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 1);

    h.trigger(
        &h.root,
        0,
        vec![event(
            EventKind::Create(CreateKind::File),
            h.root.join("note.md"),
        )],
    );
    assert_eq!(h.take_emits(), vec!["doc-2".to_string()]);

    let second = h.sessions.release("doc-2").workspace_token.expect("token");
    h.registry.release(&second);
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 0);
}

#[test]
fn switching_roots_replaces_the_watch_and_stale_tokens_are_ignored() {
    let h = harness();
    let first = h.attach("doc-1");
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 1);

    let other_dir = tempfile::tempdir().expect("other dir");
    let other_root = std::fs::canonicalize(other_dir.path()).expect("canonical other");
    let (other_token, _) = h.registry.open_canonical(other_root.clone());
    let previous = h
        .sessions
        .set_workspace("doc-1", other_token.clone(), h.sessions.epoch("doc-1"))
        .expect("switch");
    assert_eq!(previous.as_ref(), Some(&first));
    h.registry.release(&first);
    h.watcher.sync_watchers();

    assert_eq!(h.watcher.watched_root_count(), 1);
    let built = h.factory.built.lock().expect("built").clone();
    assert_eq!(built.len(), 2);
    assert!(built.contains(&h.root));
    assert!(built.contains(&other_root));

    // An expired registry token is not an active root, even while the session
    // still references it.
    h.registry.release(&other_token);
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 0);
    drop(other_dir);
}

#[test]
fn a_failed_build_is_not_retried_until_an_explicit_rearm() {
    let h = harness();
    h.attach("doc-1");
    h.factory.fail_root(&h.root);
    h.watcher.sync_watchers();

    assert_eq!(h.watcher.watched_root_count(), 0);
    assert_eq!(h.watcher.failed_roots(), vec![h.root.clone()]);

    h.factory.clear_failures();
    h.watcher.sync_watchers();
    assert_eq!(
        h.watcher.watched_root_count(),
        0,
        "failed roots stay failed"
    );
    assert_eq!(h.factory.built.lock().expect("built").len(), 0);

    h.watcher.rearm_root(&h.root);
    assert_eq!(h.watcher.watched_root_count(), 1);
    assert!(h.watcher.failed_roots().is_empty());
    assert_eq!(h.factory.built.lock().expect("built").len(), 1);
}

#[test]
fn a_late_handler_from_a_rearmed_build_is_discarded() {
    let h = harness();
    h.attach("doc-1");
    h.watcher.sync_watchers();
    h.take_emits();

    h.watcher.rearm_root(&h.root);
    assert_eq!(h.watcher.watched_root_count(), 1);
    assert_eq!(h.factory.handlers.lock().expect("handlers").len(), 2);
    // The rebuilt watcher emits one catch-up refresh for its owning window.
    assert_eq!(h.take_emits(), vec!["doc-1".to_string()]);

    // The first build's handler must not emit after rearm.
    h.trigger(
        &h.root,
        0,
        vec![event(
            EventKind::Create(CreateKind::File),
            h.root.join("stale.md"),
        )],
    );
    assert!(h.take_emits().is_empty());

    h.trigger(
        &h.root,
        1,
        vec![event(
            EventKind::Create(CreateKind::File),
            h.root.join("fresh.md"),
        )],
    );
    assert_eq!(h.take_emits(), vec!["doc-1".to_string()]);
}

#[test]
fn a_callback_error_marks_the_root_failed_and_stops_emitting() {
    let h = harness();
    h.attach("doc-1");
    h.watcher.sync_watchers();
    h.take_emits();

    let handler = h.factory.handler_for(&h.root, 0);
    handler(Err(vec![]));
    assert_eq!(h.watcher.watched_root_count(), 0);
    assert_eq!(h.watcher.failed_roots(), vec![h.root.clone()]);

    h.trigger(
        &h.root,
        0,
        vec![event(
            EventKind::Create(CreateKind::File),
            h.root.join("late.md"),
        )],
    );
    assert!(h.take_emits().is_empty());

    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 0);
}

#[test]
fn shutdown_drops_every_watch_and_late_events() {
    let h = harness();
    h.attach("doc-1");
    h.watcher.sync_watchers();
    let handler = h.factory.handler_for(&h.root, 0);
    h.take_emits();

    h.watcher.shutdown();
    assert_eq!(h.watcher.watched_root_count(), 0);

    let debounced = vec![DebouncedEvent::new(
        event(EventKind::Create(CreateKind::File), h.root.join("late.md")),
        Instant::now(),
    )];
    handler(Ok(debounced));
    assert!(h.take_emits().is_empty());
}

#[test]
fn a_custom_timeout_scheduler_marks_a_stalled_build_failed() {
    #[derive(Default)]
    struct CapturingScheduler {
        build: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        timeout: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl BuildScheduler for CapturingScheduler {
        fn schedule(&self, task: Box<dyn FnOnce() + Send + 'static>) {
            *self.build.lock().expect("build") = Some(task);
        }

        fn schedule_timeout(
            &self,
            _delay: std::time::Duration,
            task: Box<dyn FnOnce() + Send + 'static>,
        ) {
            *self.timeout.lock().expect("timeout") = Some(task);
        }
    }

    let dir = tempfile::tempdir().expect("temp");
    let root = std::fs::canonicalize(dir.path()).expect("canonical");
    let sessions = WindowSessions::new();
    let registry = WorkspaceRegistry::new();
    let (token, _) = registry.open_canonical(root.clone());
    sessions
        .set_workspace("doc-1", token, sessions.epoch("doc-1"))
        .expect("attach");
    let scheduler = Arc::new(CapturingScheduler::default());
    let factory = RecordingFactory::default();
    let watcher = WorkspaceWatcher::with_hooks(
        Arc::new(RecordingSink::default()),
        sessions,
        registry,
        Arc::new(factory),
        scheduler.clone(),
    );

    watcher.sync_watchers();
    // The timeout fires before the build task completes.
    let timeout = scheduler
        .timeout
        .lock()
        .expect("timeout")
        .take()
        .expect("timeout task");
    timeout();
    assert_eq!(watcher.failed_roots(), vec![root.clone()]);

    // A late build result is discarded.
    let build = scheduler
        .build
        .lock()
        .expect("build")
        .take()
        .expect("build task");
    build();
    assert_eq!(watcher.watched_root_count(), 0);
}

#[test]
fn interleaved_syncs_never_count_a_removed_root() {
    let h = harness();
    let first = h.attach("doc-1");
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 1);

    std::thread::scope(|scope| {
        for _ in 0..8 {
            let watcher = &h.watcher;
            let sessions = h.sessions.clone();
            scope.spawn(move || {
                for _ in 0..20 {
                    watcher.sync_watchers();
                    assert!(sessions.workspace_entries().len() <= 1);
                }
            });
        }
    });

    h.sessions.release("doc-1");
    h.registry.release(&first);
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 0);
}

#[test]
fn two_roots_are_watched_independently() {
    let h = harness();
    let first = h.attach("doc-1");
    let (other_dir, other_root, other_token) = h.attach_other_root("doc-2");
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 2);

    h.sessions.release("doc-1");
    h.registry.release(&first);
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 1);
    let built = h.factory.built.lock().expect("built").clone();
    assert!(built.contains(&h.root));
    assert!(built.contains(&other_root));

    h.sessions.release("doc-2");
    h.registry.release(&other_token);
    h.watcher.sync_watchers();
    assert_eq!(h.watcher.watched_root_count(), 0);
    drop(other_dir);
}

#[test]
fn a_file_rename_rekeys_the_open_document_and_emits_relocated() {
    let h = harness();
    h.attach("doc-1");
    let documents = DocumentRegistry::new();
    h.watcher.attach_registry(documents.clone());
    let old = h.root.join("old.md");
    std::fs::write(&old, "body").expect("fixture");
    let payload = documents.open_path(old.clone()).expect("open");
    h.sessions.set_token("doc-1", payload.doc_token.clone());
    h.watcher.sync_watchers();
    let _ = h.take_emits();

    let new = h.root.join("new.md");
    std::fs::rename(&old, &new).expect("rename");
    h.trigger(
        &h.root,
        0,
        vec![Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            paths: vec![old.clone(), new.clone()],
            attrs: Default::default(),
        }],
    );

    let relocated = h.take_relocated();
    assert_eq!(relocated.len(), 1);
    assert_eq!(relocated[0].0, "doc-1");
    assert_eq!(relocated[0].1.doc_token, payload.doc_token);
    assert_eq!(
        relocated[0].1.path,
        std::fs::canonicalize(&new)
            .expect("canonical new")
            .to_string_lossy()
    );
    let record = documents.get(&payload.doc_token).expect("record");
    assert_eq!(
        record.paths().expect("paths").canonical_target,
        std::fs::canonicalize(&new).expect("canonical new")
    );
}

#[test]
fn a_directory_rename_uses_prefix_rekey_for_open_children() {
    let h = harness();
    h.attach("doc-1");
    let documents = DocumentRegistry::new();
    h.watcher.attach_registry(documents.clone());
    let docs = h.root.join("docs");
    std::fs::create_dir(&docs).expect("docs");
    let old = docs.join("note.md");
    std::fs::write(&old, "body").expect("fixture");
    let payload = documents.open_path(old.clone()).expect("open");
    h.sessions.set_token("doc-1", payload.doc_token.clone());
    h.watcher.sync_watchers();
    let _ = h.take_emits();

    let renamed = h.root.join("docs2");
    std::fs::rename(&docs, &renamed).expect("rename dir");
    h.trigger(
        &h.root,
        0,
        vec![Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            paths: vec![docs.clone(), renamed.clone()],
            attrs: Default::default(),
        }],
    );

    let record = documents.get(&payload.doc_token).expect("record");
    assert_eq!(
        record.paths().expect("paths").canonical_target,
        std::fs::canonicalize(renamed.join("note.md")).expect("canonical child")
    );
    assert_eq!(h.take_relocated().len(), 1);
}

#[test]
fn renaming_an_open_markdown_file_to_txt_rekeys_but_does_not_enter_the_directory_branch() {
    let h = harness();
    h.attach("doc-1");
    let documents = DocumentRegistry::new();
    h.watcher.attach_registry(documents.clone());
    let old = h.root.join("note.md");
    std::fs::write(&old, "body").expect("fixture");
    let payload = documents.open_path(old.clone()).expect("open");
    h.sessions.set_token("doc-1", payload.doc_token.clone());
    h.watcher.sync_watchers();
    let _ = h.take_emits();

    let new = h.root.join("note.txt");
    std::fs::rename(&old, &new).expect("rename");
    h.trigger(
        &h.root,
        0,
        vec![Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            paths: vec![old, new.clone()],
            attrs: Default::default(),
        }],
    );

    let record = documents.get(&payload.doc_token).expect("record");
    assert_eq!(
        record.paths().expect("paths").canonical_target,
        std::fs::canonicalize(&new).expect("canonical")
    );
    assert_eq!(h.take_relocated().len(), 1);
}

#[test]
fn moving_an_open_document_out_of_the_workspace_does_not_rekey_it() {
    let h = harness();
    h.attach("doc-1");
    let documents = DocumentRegistry::new();
    h.watcher.attach_registry(documents.clone());
    let old = h.root.join("note.md");
    std::fs::write(&old, "body").expect("fixture");
    let canonical_old = std::fs::canonicalize(&old).expect("canonical old");
    let payload = documents.open_path(old.clone()).expect("open");
    h.sessions.set_token("doc-1", payload.doc_token.clone());
    h.watcher.sync_watchers();
    let _ = h.take_emits();

    let outside = tempfile::tempdir().expect("outside");
    let new = outside.path().join("note.md");
    std::fs::rename(&old, &new).expect("move out");
    h.trigger(
        &h.root,
        0,
        vec![Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            paths: vec![old.clone(), new],
            attrs: Default::default(),
        }],
    );

    let record = documents.get(&payload.doc_token).expect("record");
    assert_eq!(
        record.paths().expect("paths").canonical_target,
        canonical_old
    );
    assert!(h.take_relocated().is_empty());
}
