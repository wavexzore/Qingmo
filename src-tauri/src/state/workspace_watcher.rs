use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use notify_debouncer_full::notify::event::{EventKind, ModifyKind};
use notify_debouncer_full::notify::{Event, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use tauri::{AppHandle, Emitter};

use crate::ipc::contract::EVENT_WORKSPACE_CHANGED;
use crate::services::search_index::SearchIndexService;
use crate::services::workspace_service::is_ignored_relative_path;
use crate::state::workspace_registry::WorkspaceRegistry;
use crate::state::WindowSessions;

/// Debounce window for filesystem batches.
pub const WORKSPACE_DEBOUNCE: Duration = Duration::from_millis(200);
/// A build that takes longer is marked failed; a late build is discarded.
pub const WATCH_BUILD_TIMEOUT: Duration = Duration::from_secs(10);

pub type EventHandler = Arc<dyn Fn(DebounceEventResult) + Send + Sync + 'static>;

/// Receives one empty `workspace-changed` event per affected window.
pub trait WorkspaceEventSink: Send + Sync + 'static {
    fn emit(&self, label: &str);
}

/// Owns the platform watcher; dropping it stops watching.
pub trait WatchHandle: Send + 'static {}

impl WatchHandle for Debouncer<RecommendedWatcher, RecommendedCache> {}

/// Builds the platform watcher for one canonical root.
///
/// Failures are static kind labels so logs never contain a path or an
/// OS-specific message that might embed one.
pub trait WatcherFactory: Send + Sync + 'static {
    fn build(
        &self,
        root: &Path,
        handler: EventHandler,
    ) -> Result<Box<dyn WatchHandle>, &'static str>;
}

/// Runs watcher construction off the command thread.
pub trait BuildScheduler: Send + Sync + 'static {
    fn schedule(&self, task: Box<dyn FnOnce() + Send + 'static>);
    fn schedule_timeout(&self, delay: Duration, task: Box<dyn FnOnce() + Send + 'static>);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NotifyWatcherFactory;

impl WatcherFactory for NotifyWatcherFactory {
    fn build(
        &self,
        root: &Path,
        handler: EventHandler,
    ) -> Result<Box<dyn WatchHandle>, &'static str> {
        let mut debouncer = new_debouncer(WORKSPACE_DEBOUNCE, None, move |result| handler(result))
            .map_err(|_| "create")?;
        debouncer
            .watch(root, RecursiveMode::Recursive)
            .map_err(|_| "watch")?;
        Ok(Box::new(debouncer))
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct BlockingScheduler;

impl BuildScheduler for BlockingScheduler {
    fn schedule(&self, task: Box<dyn FnOnce() + Send + 'static>) {
        tauri::async_runtime::spawn_blocking(task);
    }

    fn schedule_timeout(&self, delay: Duration, task: Box<dyn FnOnce() + Send + 'static>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            task();
        });
    }
}

/// Deterministic scheduler for tests: builds inline, ignores timeouts.
#[derive(Debug, Default, Clone, Copy)]
pub struct ImmediateScheduler;

impl BuildScheduler for ImmediateScheduler {
    fn schedule(&self, task: Box<dyn FnOnce() + Send + 'static>) {
        task();
    }

    fn schedule_timeout(&self, _delay: Duration, _task: Box<dyn FnOnce() + Send + 'static>) {}
}

/// Production sink: one targeted Tauri event per owning window.
struct TauriEventSink<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> WorkspaceEventSink for TauriEventSink<R> {
    fn emit(&self, label: &str) {
        // The payload is deliberately empty: the tree re-lists known
        // directories and must not parse a path or token from the event.
        if let Err(error) = self.app.emit_to(label, EVENT_WORKSPACE_CHANGED, ()) {
            tracing::debug!(%error, "failed to emit a workspace change");
        }
    }
}

struct RootWatch {
    generation: u64,
    _handle: Box<dyn WatchHandle>,
}

#[derive(Default)]
struct Inner {
    roots: HashMap<PathBuf, RootWatch>,
    failed: HashSet<PathBuf>,
    building: HashMap<PathBuf, u64>,
    next_generation: u64,
}

#[derive(Clone)]
struct BuildContext {
    sink: Arc<dyn WorkspaceEventSink>,
    sessions: WindowSessions,
    registry: WorkspaceRegistry,
    index: Arc<RwLock<Option<SearchIndexService>>>,
    inner: Arc<Mutex<Inner>>,
}

/// Per-canonical-root filesystem watcher for workspace trees.
///
/// Routing is always resolved from the live `WindowSessions`/`WorkspaceRegistry`
/// snapshot, so this module never keeps a second copy of window ownership.
pub struct WorkspaceWatcher {
    ctx: BuildContext,
    factory: Arc<dyn WatcherFactory>,
    scheduler: Arc<dyn BuildScheduler>,
    sync_lock: Mutex<()>,
}

impl WorkspaceWatcher {
    pub fn new<R: tauri::Runtime>(
        app: AppHandle<R>,
        sessions: WindowSessions,
        registry: WorkspaceRegistry,
    ) -> Self {
        Self::with_hooks(
            Arc::new(TauriEventSink { app }),
            sessions,
            registry,
            Arc::new(NotifyWatcherFactory),
            Arc::new(BlockingScheduler),
        )
    }

    pub fn with_hooks(
        sink: Arc<dyn WorkspaceEventSink>,
        sessions: WindowSessions,
        registry: WorkspaceRegistry,
        factory: Arc<dyn WatcherFactory>,
        scheduler: Arc<dyn BuildScheduler>,
    ) -> Self {
        Self {
            ctx: BuildContext {
                sink,
                sessions,
                registry,
                index: Arc::new(RwLock::new(None)),
                inner: Arc::new(Mutex::new(Inner::default())),
            },
            factory,
            scheduler,
            sync_lock: Mutex::new(()),
        }
    }

    /// Attaches the search index as a second consumer of the same batches.
    pub fn attach_index(&self, index: SearchIndexService) {
        if let Ok(mut slot) = self.ctx.index.write() {
            *slot = Some(index);
        }
    }

    /// Reconciles the OS watcher set with the live window-token ownership.
    ///
    /// Idempotent and serialized by `sync_lock`, so an older snapshot can never
    /// remove a root that a newer sync just added.
    pub fn sync_watchers(&self) {
        let _guard = self.lock_sync();
        let active = self.active_roots();

        let mut to_drop = Vec::new();
        let mut to_build = Vec::new();
        {
            let mut inner = self.lock_inner();

            let watched = inner.roots.keys().cloned().collect::<Vec<_>>();
            for root in watched {
                if !active.contains(&root) {
                    if let Some(watch) = inner.roots.remove(&root) {
                        to_drop.push(watch);
                    }
                }
            }
            let building = inner.building.keys().cloned().collect::<Vec<_>>();
            for root in building {
                if !active.contains(&root) {
                    inner.building.remove(&root);
                }
            }
            // Roots that vanished must forget their failure too, so a later
            // reopen can try again. Failed roots that are still active stay in
            // `failed` until an explicit rearm.
            inner.failed.retain(|root| active.contains(root));
            for root in active {
                if inner.roots.contains_key(&root)
                    || inner.failed.contains(&root)
                    || inner.building.contains_key(&root)
                {
                    continue;
                }
                inner.next_generation = inner.next_generation.saturating_add(1);
                let generation = inner.next_generation;
                inner.building.insert(root.clone(), generation);
                to_build.push((root, generation));
            }
        }
        // Dropping a debouncer may join its callback thread; never do it while
        // holding the state lock.
        drop(to_drop);

        for (root, generation) in to_build {
            self.schedule_build(root, generation);
        }
    }

    /// Forces a rebuild of one root even after a previous failure.
    ///
    /// Used when the user explicitly reopens the same folder.
    pub fn rearm_root(&self, root: &Path) {
        let mut to_drop = Vec::new();
        {
            let _guard = self.lock_sync();
            let mut inner = self.lock_inner();
            inner.failed.remove(root);
            inner.building.remove(root);
            if let Some(watch) = inner.roots.remove(root) {
                to_drop.push(watch);
            }
        }
        drop(to_drop);
        self.sync_watchers();
    }

    /// Stops every watcher and rejects late build results.
    pub fn shutdown(&self) {
        let _guard = self.lock_sync();
        let to_drop = {
            let mut inner = self.lock_inner();
            inner.failed.clear();
            inner.building.clear();
            inner
                .roots
                .drain()
                .map(|(_, watch)| watch)
                .collect::<Vec<_>>()
        };
        drop(to_drop);
    }

    pub fn watched_root_count(&self) -> usize {
        self.lock_inner().roots.len()
    }

    pub fn failed_roots(&self) -> Vec<PathBuf> {
        self.lock_inner().failed.iter().cloned().collect()
    }

    fn active_roots(&self) -> HashSet<PathBuf> {
        let mut roots = HashSet::new();
        for (_label, token) in self.ctx.sessions.workspace_entries() {
            if let Ok(record) = self.ctx.registry.get(&token) {
                roots.insert(record.root.clone());
            }
        }
        roots
    }

    fn schedule_build(&self, root: PathBuf, generation: u64) {
        let context = self.ctx.clone();
        let factory = Arc::clone(&self.factory);
        let task_root = root.clone();
        self.scheduler.schedule(Box::new(move || {
            build_root(context, factory, task_root, generation);
        }));

        let timeout_context = self.ctx.clone();
        let timeout_root = root;
        self.scheduler.schedule_timeout(
            WATCH_BUILD_TIMEOUT,
            Box::new(move || {
                let mut inner = timeout_context
                    .inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if inner.building.get(&timeout_root) == Some(&generation) {
                    inner.building.remove(&timeout_root);
                    inner.failed.insert(timeout_root.clone());
                    drop(inner);
                    tracing::warn!(
                        root_count = 1,
                        error_kind = "timeout",
                        "failed to build a workspace watcher"
                    );
                }
            }),
        );
    }

    fn lock_sync(&self) -> std::sync::MutexGuard<'_, ()> {
        self.sync_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.ctx
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn build_root(
    context: BuildContext,
    factory: Arc<dyn WatcherFactory>,
    root: PathBuf,
    generation: u64,
) {
    // The handler must not keep the state alive: Inner owns the debouncer,
    // whose handler would otherwise own Inner.
    let weak = Arc::downgrade(&context.inner);
    let handler_root = root.clone();
    let handler_sessions = context.sessions.clone();
    let handler_registry = context.registry.clone();
    let handler_sink = Arc::clone(&context.sink);
    let handler_index = Arc::clone(&context.index);
    let handler = Arc::new(move |result: DebounceEventResult| {
        handle_events(
            weak.clone(),
            &handler_sessions,
            &handler_registry,
            handler_sink.as_ref(),
            handler_index.as_ref(),
            &handler_root,
            generation,
            result,
        );
    });

    match factory.build(&root, handler) {
        Ok(handle) => {
            let accepted = {
                let mut inner = context
                    .inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let current = inner.building.get(&root).copied();
                if current == Some(generation) && !inner.failed.contains(&root) {
                    inner.building.remove(&root);
                    inner.roots.insert(
                        root.clone(),
                        RootWatch {
                            generation,
                            _handle: handle,
                        },
                    );
                    true
                } else {
                    false
                }
            };
            if accepted {
                // A change may have happened while the watcher was building;
                // one catch-up refresh covers that window.
                emit_to_root(
                    &context.sessions,
                    &context.registry,
                    context.sink.as_ref(),
                    &root,
                );
            }
            // Rejected handles (closed window, rearm, timeout) drop here, off
            // the state lock.
        }
        Err(error_kind) => {
            let mut inner = context
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.building.get(&root) == Some(&generation) {
                inner.building.remove(&root);
                inner.failed.insert(root.clone());
            }
            drop(inner);
            tracing::warn!(
                root_count = 1,
                error_kind,
                "failed to build a workspace watcher"
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_events(
    inner: Weak<Mutex<Inner>>,
    sessions: &WindowSessions,
    registry: &WorkspaceRegistry,
    sink: &dyn WorkspaceEventSink,
    index: &RwLock<Option<SearchIndexService>>,
    root: &Path,
    generation: u64,
    result: DebounceEventResult,
) {
    let Some(inner) = inner.upgrade() else {
        return;
    };
    match result {
        Ok(events) => {
            let current = {
                let inner = inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                inner
                    .roots
                    .get(root)
                    .is_some_and(|watch| watch.generation == generation)
            };
            if !current {
                return;
            }
            if let Some(index) = index.read().ok().and_then(|index| index.clone()) {
                let mut handled = false;
                for event in &events {
                    match event.event.kind {
                        EventKind::Modify(ModifyKind::Name(_)) if event.paths.len() < 2 => {
                            index.notify_rescan(root.to_path_buf());
                            handled = true;
                        }
                        EventKind::Remove(_) => {
                            for path in &event.paths {
                                if is_indexable(root, path) {
                                    index.remove_path(root, path);
                                    handled = true;
                                }
                            }
                        }
                        _ => {
                            for path in &event.paths {
                                if is_indexable(root, path) {
                                    index.notify_upsert(root.to_path_buf(), path.clone());
                                    handled = true;
                                }
                            }
                        }
                    }
                }
                if !handled && !events.is_empty() {
                    index.notify_rescan(root.to_path_buf());
                }
            }
            if events.iter().any(|event| should_refresh(event, root)) {
                emit_to_root(sessions, registry, sink, root);
            }
        }
        Err(errors) => {
            let removed = {
                let mut inner = inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if inner.roots.get(root).map(|watch| watch.generation) != Some(generation) {
                    return;
                }
                let removed = inner.roots.remove(root);
                inner.failed.insert(root.to_path_buf());
                removed
            };
            if let Some(watch) = removed {
                // The callback thread must not join itself; drop the watcher
                // on a separate thread.
                std::thread::spawn(move || drop(watch));
            }
            tracing::warn!(
                root_count = 1,
                error_count = errors.len(),
                error_kind = "callback",
                "workspace watcher reported an error"
            );
        }
    }
}

/// One targeted emit per owning window; deduplication is inherent because the
/// session snapshot contains each label once and this runs once per batch.
fn emit_to_root(
    sessions: &WindowSessions,
    registry: &WorkspaceRegistry,
    sink: &dyn WorkspaceEventSink,
    root: &Path,
) {
    for (label, token) in sessions.workspace_entries() {
        if registry.get(&token).is_ok_and(|record| record.root == root) {
            sink.emit(&label);
        }
    }
}

/// Whether one debounced event can change a visible tree row.
fn is_indexable(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if is_ignored_relative_path(relative) {
        return false;
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md")
                || extension.eq_ignore_ascii_case("markdown")
                || extension.eq_ignore_ascii_case("mdx")
        })
}

pub fn should_refresh(event: &DebouncedEvent, root: &Path) -> bool {
    should_refresh_event(&event.event, root)
}

fn should_refresh_event(event: &Event, root: &Path) -> bool {
    if event.need_rescan() {
        return true;
    }
    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) => {
            event.paths.iter().any(|path| is_visible_path(root, path))
        }
        EventKind::Modify(ModifyKind::Name(_)) => {
            // Rename carries from/to; either visible end must refresh.
            event.paths.iter().any(|path| is_visible_path(root, path))
        }
        _ => false,
    }
}

fn is_visible_path(root: &Path, path: &Path) -> bool {
    let Some(relative) = relative_to_root(root, path) else {
        return false;
    };
    !is_ignored_relative_path(&relative)
}

fn normalize_notify_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn relative_to_root(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = normalize_notify_path(root);
    let path = normalize_notify_path(path);
    if let Ok(relative) = path.strip_prefix(&root) {
        return Some(relative.to_path_buf());
    }
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive; compare the display forms and
        // then map the suffix back to components.
        let root_text = root.to_string_lossy().to_lowercase();
        let path_text = path.to_string_lossy().to_lowercase();
        let rest = path_text.strip_prefix(&root_text)?;
        if rest.is_empty() {
            return Some(PathBuf::new());
        }
        if !rest.starts_with('\\') && !rest.starts_with('/') {
            return None;
        }
        return Some(PathBuf::from(rest.trim_start_matches(['\\', '/'])));
    }
    #[cfg(not(windows))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_full::notify::event::{
        CreateKind, DataChange, Flag, MetadataKind, RenameMode,
    };
    use notify_debouncer_full::notify::event::{ModifyKind, RemoveKind};
    use std::time::Instant;

    fn event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        Event {
            kind,
            paths,
            attrs: Default::default(),
        }
    }

    fn debounced(event: Event) -> DebouncedEvent {
        DebouncedEvent::new(event, Instant::now())
    }

    fn root() -> PathBuf {
        std::fs::canonicalize(tempfile::tempdir().expect("temp").path()).expect("canonical")
    }

    #[test]
    fn create_remove_and_visible_rename_refresh() {
        let root = root();
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Remove(RemoveKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        ] {
            assert!(should_refresh(
                &debounced(event(kind, vec![root.join("note.md")])),
                &root
            ));
        }
    }

    #[test]
    fn pure_content_and_access_events_do_not_refresh() {
        let root = root();
        for kind in [
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime)),
            EventKind::Access(notify_debouncer_full::notify::event::AccessKind::Read),
            EventKind::Other,
        ] {
            assert!(!should_refresh(
                &debounced(event(kind, vec![root.join("note.md")])),
                &root
            ));
        }
    }

    #[test]
    fn hidden_node_modules_and_outside_paths_are_filtered() {
        let root = root();
        for path in [
            root.join(".git").join("index"),
            root.join("node_modules").join("pkg"),
            root.join("docs").join(".cache"),
            PathBuf::from("/elsewhere/note.md"),
        ] {
            assert!(!should_refresh(
                &debounced(event(
                    EventKind::Create(CreateKind::File),
                    vec![path.clone()]
                )),
                &root
            ));
        }
        assert!(should_refresh(
            &debounced(event(
                EventKind::Create(CreateKind::File),
                vec![root.join("docs").join("note.md")]
            )),
            &root
        ));
    }

    #[test]
    fn a_rename_refreshes_when_either_end_is_visible() {
        let root = root();
        let visible = debounced(event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec![
                root.join(".hidden").join("a.md"),
                root.join("docs").join("a.md"),
            ],
        ));
        assert!(should_refresh(&visible, &root));

        let hidden = debounced(event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec![
                root.join(".hidden").join("a.md"),
                root.join(".hidden").join("b.md"),
            ],
        ));
        assert!(!should_refresh(&hidden, &root));
    }

    #[test]
    fn a_rescan_flag_always_refreshes() {
        let root = root();
        let mut rescan = event(EventKind::Other, vec![]);
        rescan.attrs.set_flag(Flag::Rescan);
        assert!(should_refresh(&debounced(rescan), &root));
    }
}
