use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::oneshot;

/// Windows that did not save before an update install, or `Ok(())` when all did.
pub type FlushOutcome = Result<(), Vec<String>>;

/// Coordinates the "save every other window before installing" barrier.
///
/// The install command owns the exchange: it registers the target windows,
/// emits one `app://update-flush-request` and awaits the receiver. Each window
/// answers through `app_update_flush_ack`. The first refusal ends the wait
/// immediately, because installing and restarting would discard an unsaved or
/// conflicted document.
#[derive(Debug, Default)]
pub struct UpdateFlushGate {
    state: Mutex<Option<PendingFlush>>,
    next_request_id: AtomicU64,
}

#[derive(Debug)]
struct PendingFlush {
    request_id: u64,
    remaining: HashSet<String>,
    failed: Vec<String>,
    sender: Option<oneshot::Sender<FlushOutcome>>,
}

impl UpdateFlushGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one flush request.
    ///
    /// A receiver that resolves immediately is returned when there is nothing
    /// to wait for. Registering a new request abandons the previous one: its
    /// sender drops, the waiting command fails closed, and a late acknowledgement
    /// finds no matching request.
    pub fn begin(
        &self,
        targets: impl IntoIterator<Item = String>,
    ) -> (u64, oneshot::Receiver<FlushOutcome>) {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        let remaining: HashSet<String> = targets.into_iter().collect();
        if remaining.is_empty() {
            let _ = sender.send(Ok(()));
            return (request_id, receiver);
        }

        *self.lock() = Some(PendingFlush {
            request_id,
            remaining,
            failed: Vec::new(),
            sender: Some(sender),
        });
        (request_id, receiver)
    }

    /// Records one window's answer.
    ///
    /// Returns `false` when the request is unknown or the window was not
    /// targeted; a stale answer is harmless and must not fail an install.
    pub fn ack(&self, request_id: u64, label: &str, ok: bool) -> bool {
        let mut state = self.lock();
        {
            let Some(pending) = state.as_mut() else {
                return false;
            };
            if pending.request_id != request_id || !pending.remaining.remove(label) {
                return false;
            }
            if !ok {
                pending.failed.push(label.to_string());
            }
            if pending.failed.is_empty() && !pending.remaining.is_empty() {
                return true;
            }

            let outcome = if pending.failed.is_empty() {
                Ok(())
            } else {
                Err(std::mem::take(&mut pending.failed))
            };
            if let Some(sender) = pending.sender.take() {
                let _ = sender.send(outcome);
            }
        }
        // The request is complete; a late answer must not look accepted.
        *state = None;
        true
    }

    /// Drops a request that timed out so a late acknowledgement cannot revive it.
    pub fn cancel(&self, request_id: u64) {
        let mut state = self.lock();
        if state
            .as_ref()
            .is_some_and(|pending| pending.request_id == request_id)
        {
            *state = None;
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<PendingFlush>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot::error::TryRecvError;

    #[test]
    fn waits_for_every_window() {
        let gate = UpdateFlushGate::new();
        let (request_id, mut receiver) = gate.begin(["main".to_string(), "doc-1".to_string()]);

        assert!(gate.ack(request_id, "main", true));
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        assert!(gate.ack(request_id, "doc-1", true));
        assert!(matches!(receiver.try_recv(), Ok(Ok(()))));
    }

    #[test]
    fn a_failure_ends_the_wait_immediately() {
        let gate = UpdateFlushGate::new();
        let (request_id, mut receiver) = gate.begin(["main".to_string(), "doc-1".to_string()]);

        assert!(gate.ack(request_id, "doc-1", false));
        assert!(matches!(
            receiver.try_recv(),
            Ok(Err(failed)) if failed == vec!["doc-1".to_string()]
        ));
        assert!(!gate.ack(request_id, "main", true));
    }

    #[test]
    fn stale_or_unknown_answers_are_ignored() {
        let gate = UpdateFlushGate::new();
        let (request_id, _receiver) = gate.begin(["main".to_string()]);

        assert!(!gate.ack(request_id + 1, "main", true));
        assert!(!gate.ack(request_id, "doc-1", true));
        gate.cancel(request_id);
        assert!(!gate.ack(request_id, "main", true));
    }

    #[test]
    fn no_targets_resolves_without_waiting() {
        let gate = UpdateFlushGate::new();
        let (_request_id, mut receiver) = gate.begin(std::iter::empty());
        assert!(matches!(receiver.try_recv(), Ok(Ok(()))));
    }

    #[test]
    fn a_new_request_abandons_the_previous_one() {
        let gate = UpdateFlushGate::new();
        let (first, mut first_receiver) = gate.begin(["main".to_string()]);
        let (_second, mut second_receiver) = gate.begin(["doc-1".to_string()]);

        assert!(matches!(
            first_receiver.try_recv(),
            Err(TryRecvError::Closed)
        ));
        assert!(!gate.ack(first, "main", true));
        assert!(matches!(
            second_receiver.try_recv(),
            Err(TryRecvError::Empty)
        ));
    }
}
