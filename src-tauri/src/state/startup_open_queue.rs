use std::path::PathBuf;
use std::sync::Mutex;

/// Holds OS open requests that arrive before `setup` finished.
///
/// macOS can deliver `RunEvent::Opened` before the event loop reports `Ready`,
/// which is also when Tauri runs `setup` and creates the logging, session,
/// watcher and update services. Opening a document immediately would race
/// those services (most visibly leaving the document watcher unregistered), so
/// early paths wait here until `setup` marks the application ready.
#[derive(Debug, Default)]
pub struct StartupOpenQueue {
    state: Mutex<QueueState>,
}

#[derive(Debug, Default)]
struct QueueState {
    ready: bool,
    pending: Vec<PathBuf>,
}

impl StartupOpenQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues `path` until startup is ready.
    ///
    /// Returns `true` when the caller should open it immediately because
    /// startup already finished; `false` when it was queued for `mark_ready`.
    pub fn push(&self, path: PathBuf) -> bool {
        let mut state = self.lock();
        if state.ready {
            return true;
        }
        state.pending.push(path);
        false
    }

    /// Marks startup ready and returns every path that arrived too early.
    pub fn mark_ready(&self) -> Vec<PathBuf> {
        let mut state = self.lock();
        state.ready = true;
        std::mem::take(&mut state.pending)
    }

    /// Whether `setup` has finished and window services are available.
    pub fn is_ready(&self) -> bool {
        self.lock().ready
    }

    /// Whether an OS open is waiting for the drain; restore must not claim in
    /// that case or it would create a window the OS request should own.
    pub fn has_pending(&self) -> bool {
        !self.lock().pending.is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_before_ready_wait_for_the_drain() {
        let queue = StartupOpenQueue::new();
        assert!(!queue.is_ready());
        assert!(!queue.push(PathBuf::from("/tmp/one.md")));
        assert!(!queue.push(PathBuf::from("/tmp/two.md")));

        assert_eq!(
            queue.mark_ready(),
            [PathBuf::from("/tmp/one.md"), PathBuf::from("/tmp/two.md")]
        );
        assert!(queue.is_ready());
        assert!(queue.mark_ready().is_empty());
    }

    #[test]
    fn paths_after_ready_open_immediately() {
        let queue = StartupOpenQueue::new();
        assert!(queue.mark_ready().is_empty());
        assert!(queue.push(PathBuf::from("/tmp/one.md")));
        assert!(queue.mark_ready().is_empty());
    }

    #[test]
    fn a_drain_keeps_paths_that_arrived_after_ready() {
        let queue = StartupOpenQueue::new();
        assert!(!queue.push(PathBuf::from("/tmp/before.md")));

        let drained = queue.mark_ready();
        assert_eq!(drained, [PathBuf::from("/tmp/before.md")]);
        assert!(queue.push(PathBuf::from("/tmp/after.md")));
        assert!(queue.mark_ready().is_empty());
    }
}
