use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::FilePayload;
use crate::state::workspace_registry::WorkspaceToken;

#[derive(Debug, Default)]
struct Inner {
    /// Payload staged by `document_open` until the new window asks for it.
    pending: HashMap<String, FilePayload>,
    /// Document token currently owned by each window.
    tokens: HashMap<String, String>,
    /// One previous document token kept alive for rollback after an in-window
    /// switch. It is released by the next switch or when the window closes.
    previous_tokens: HashMap<String, String>,
    /// Windows whose document has no path yet (created by New or the blank main).
    untitled: HashSet<String>,
    /// Workspace capability currently owned by each window.
    workspaces: HashMap<String, WorkspaceToken>,
    /// Destroyed labels. Writes arriving after a window is gone must be refused,
    /// otherwise a late dialog callback could resurrect its state.
    closed: HashSet<String>,
    /// Monotonic write generation per label; detects concurrent workspace
    /// switches and main-window ABA.
    epochs: HashMap<String, u64>,
}

/// Everything one window owned at the moment it was released.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowRelease {
    pub doc_token: Option<String>,
    /// Rollback token retained by the last in-window document switch.
    pub previous_doc_token: Option<String>,
    pub workspace_token: Option<WorkspaceToken>,
}

impl WindowRelease {
    pub fn is_empty(&self) -> bool {
        self.doc_token.is_none()
            && self.previous_doc_token.is_none()
            && self.workspace_token.is_none()
    }
}

/// The token ownership change produced by one in-window document switch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentActivation {
    /// Token that was active before the switch and is now kept for rollback.
    pub previous: Option<String>,
    /// Token that was already retained and can no longer be reached: the
    /// caller must release it from the registry and its watcher.
    pub retired: Option<String>,
}

/// Per-window document and workspace handoff.
///
/// Opening a file creates the window in Rust, so the payload must survive
/// until that window's webview boots and calls `document_take_pending`.
#[derive(Debug, Clone, Default)]
pub struct WindowSessions {
    inner: Arc<Mutex<Inner>>,
}

impl WindowSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stages a payload for a window that is about to be created.
    ///
    /// Returns `false` when the label was already released; the caller still
    /// owns the staged doc token and must release it.
    pub fn stage(&self, label: &str, payload: FilePayload) -> bool {
        let mut inner = self.lock();
        if inner.closed.contains(label) {
            return false;
        }
        inner.pending.insert(label.to_string(), payload);
        true
    }

    /// Drops a staged payload, used when window creation fails.
    pub fn discard_pending(&self, label: &str) {
        self.lock().pending.remove(label);
    }

    /// Marks a window as an untitled document so its title is localized.
    pub fn mark_untitled(&self, label: &str) {
        let mut inner = self.lock();
        if inner.closed.contains(label) {
            return;
        }
        inner.untitled.insert(label.to_string());
    }

    /// Revokes the untitled mark, for example when window creation failed.
    pub fn clear_untitled(&self, label: &str) {
        self.lock().untitled.remove(label);
    }

    /// Whether the window currently owns an untitled document.
    pub fn is_untitled(&self, label: &str) -> bool {
        self.lock().untitled.contains(label)
    }

    /// Hands the staged payload to its window and records token ownership.
    pub fn take_pending(&self, label: &str) -> Option<FilePayload> {
        let mut inner = self.lock();
        if inner.closed.contains(label) {
            return None;
        }
        let payload = inner.pending.remove(label)?;
        inner.untitled.remove(label);
        inner
            .tokens
            .insert(label.to_string(), payload.doc_token.clone());
        Some(payload)
    }

    /// Records a new token after Save As or another in-window token change.
    ///
    /// Returns `false` when the window is already gone; the caller must then
    /// release the new doc token and must not start a document watcher.
    pub fn set_token(&self, label: &str, token: String) -> bool {
        let mut inner = self.lock();
        if inner.closed.contains(label) {
            return false;
        }
        inner.tokens.insert(label.to_string(), token);
        inner.untitled.remove(label);
        true
    }

    /// Switches the document token owned by one live window.
    ///
    /// The token that was active is retained (instead of released) so the
    /// caller can roll back a failed adoption with a second activation. Only
    /// one rollback token is kept per window: activating again returns the
    /// previously retained token in [`DocumentActivation::retired`] for the
    /// caller to release. Passing `None` marks the window untitled.
    pub fn activate_document(
        &self,
        label: &str,
        token: Option<String>,
    ) -> Result<DocumentActivation, AppError> {
        let mut inner = self.lock();
        if inner.closed.contains(label) {
            return Err(AppError::new(
                AppErrorCode::Cancelled,
                "the window was closed before the document could be activated",
            ));
        }

        let current = inner.tokens.get(label).cloned();
        if current == token {
            if token.is_none() {
                inner.untitled.insert(label.to_string());
            }
            return Ok(DocumentActivation::default());
        }

        let retired = inner.previous_tokens.remove(label);
        if let Some(current) = current.as_ref() {
            inner
                .previous_tokens
                .insert(label.to_string(), current.clone());
        }
        // Rolling back to the retained token makes it active again; it must
        // not remain in both maps.
        if let Some(next) = token.as_ref() {
            if inner.previous_tokens.get(label) == Some(next) {
                inner.previous_tokens.remove(label);
            }
            inner.tokens.insert(label.to_string(), next.clone());
            inner.untitled.remove(label);
        } else {
            inner.tokens.remove(label);
            inner.untitled.insert(label.to_string());
        }

        let retired = retired.filter(|value| token.as_deref() != Some(value.as_str()));
        Ok(DocumentActivation {
            previous: current,
            retired,
        })
    }

    /// Path staged for a window that has not consumed its payload yet.
    pub fn pending_path(&self, label: &str) -> Option<std::path::PathBuf> {
        self.lock()
            .pending
            .get(label)
            .map(|payload| std::path::PathBuf::from(&payload.path))
    }

    /// Document token currently owned by a window.
    pub fn token_for(&self, label: &str) -> Option<String> {
        self.lock().tokens.get(label).cloned()
    }

    /// Whether another window already owns or retains this doc token.
    ///
    /// Tree payloads are unowned until adopted, and rollback tokens remain
    /// owned by the same window; both are allowed. A token that belongs to a
    /// different window must never be activated by this one.
    pub fn document_token_owned_elsewhere(&self, label: &str, token: &str) -> bool {
        let inner = self.lock();
        inner
            .tokens
            .iter()
            .any(|(other, value)| other != label && value == token)
            || inner
                .previous_tokens
                .iter()
                .any(|(other, value)| other != label && value == token)
    }

    /// Commits a workspace token when the window is still open and has not
    /// changed its workspace since `expected_epoch` was read.
    ///
    /// Returns the token that must be released by the caller. `Err` means the
    /// caller still owns the candidate token (closed window or lost race).
    pub fn set_workspace(
        &self,
        label: &str,
        token: WorkspaceToken,
        expected_epoch: u64,
    ) -> Result<Option<WorkspaceToken>, AppError> {
        let mut inner = self.lock();
        if inner.closed.contains(label) {
            return Err(AppError::new(
                AppErrorCode::Cancelled,
                "the window was closed before the workspace could be committed",
            ));
        }
        if inner.epoch(label) != expected_epoch {
            return Err(AppError::new(
                AppErrorCode::Cancelled,
                "the workspace changed while the request was in flight",
            ));
        }
        let previous = inner.workspaces.insert(label.to_string(), token);
        inner.bump_epoch(label);
        Ok(previous)
    }

    /// Compare-and-remove: only clears the token this request actually read.
    pub fn take_workspace_if(
        &self,
        label: &str,
        expected: &WorkspaceToken,
    ) -> Option<WorkspaceToken> {
        let mut inner = self.lock();
        if inner.workspaces.get(label) != Some(expected) {
            return None;
        }
        let removed = inner.workspaces.remove(label);
        if removed.is_some() {
            inner.bump_epoch(label);
        }
        removed
    }

    /// Workspace token currently owned by a window.
    pub fn workspace_for(&self, label: &str) -> Option<WorkspaceToken> {
        self.lock().workspaces.get(label).cloned()
    }

    /// Authorization check for every workspace command.
    pub fn owns_workspace(&self, label: &str, token: &WorkspaceToken) -> bool {
        self.lock().workspaces.get(label) == Some(token)
    }

    /// Live `(label, token)` snapshot for the watcher.
    ///
    /// This is routing/observation only; authorization still goes through
    /// [`Self::owns_workspace`].
    pub fn workspace_entries(&self) -> Vec<(String, WorkspaceToken)> {
        self.lock()
            .workspaces
            .iter()
            .map(|(label, token)| (label.clone(), token.clone()))
            .collect()
    }

    pub fn is_closed(&self, label: &str) -> bool {
        self.lock().closed.contains(label)
    }

    /// Current write generation; a new label starts at zero.
    pub fn epoch(&self, label: &str) -> u64 {
        self.lock().epoch(label)
    }

    /// Clears tombstones and leftovers before rebuilding a window (main ABA).
    ///
    /// Returns any residual tokens the caller must release. This is the only
    /// path that revives a closed label.
    pub fn reopen(&self, label: &str) -> WindowRelease {
        let mut inner = self.lock();
        inner.closed.remove(label);
        let released = inner.take_all(label);
        inner.bump_epoch(label);
        released
    }

    /// Atomically removes every bit of per-window state.
    ///
    /// Returns the doc token the registry must release — the adopted one, or
    /// the staged payload's token for a window destroyed before boot — plus the
    /// workspace token. A second call returns two `None`s.
    pub fn release(&self, label: &str) -> WindowRelease {
        let mut inner = self.lock();
        let released = inner.take_all(label);
        inner.closed.insert(label.to_string());
        inner.bump_epoch(label);
        released
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Inner {
    fn epoch(&self, label: &str) -> u64 {
        self.epochs.get(label).copied().unwrap_or(0)
    }

    fn bump_epoch(&mut self, label: &str) {
        let next = self.epoch(label).saturating_add(1);
        self.epochs.insert(label.to_string(), next);
    }

    /// Existing release semantics are preserved: an adopted doc token wins
    /// over a staged payload, and the staged payload is always dropped.
    fn take_all(&mut self, label: &str) -> WindowRelease {
        let doc_token = self
            .tokens
            .remove(label)
            .or_else(|| self.pending.remove(label).map(|payload| payload.doc_token));
        self.pending.remove(label);
        let previous_doc_token = self.previous_tokens.remove(label);
        self.untitled.remove(label);
        let workspace_token = self.workspaces.remove(label);
        WindowRelease {
            doc_token,
            previous_doc_token,
            workspace_token,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::dto::{LineEnding, TextEncoding, TextFormat};

    fn payload(token: &str) -> FilePayload {
        FilePayload {
            doc_token: token.to_string(),
            path: "/docs/note.md".to_string(),
            text: "hello\n".to_string(),
            format: TextFormat {
                encoding: TextEncoding::Utf8,
                has_bom: false,
                eol: LineEnding::Lf,
            },
            mixed_eol: false,
            hash: "a".repeat(64),
            size: 6,
            text_units: 6,
            mtime_ms: 1_700_000_000_000,
            read_only: false,
            read_only_reason: None,
        }
    }

    #[test]
    fn pending_payload_is_taken_once_and_owns_the_token() {
        let sessions = WindowSessions::new();
        assert!(sessions.stage("doc-1", payload("token-1")));

        let taken = sessions.take_pending("doc-1").expect("payload");
        assert_eq!(taken.doc_token, "token-1");
        assert!(sessions.take_pending("doc-1").is_none());
        let released = sessions.release("doc-1");
        assert_eq!(released.doc_token.as_deref(), Some("token-1"));
        assert!(released.workspace_token.is_none());
        assert!(sessions.release("doc-1").is_empty());
    }

    #[test]
    fn closing_before_taking_the_payload_releases_its_token() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));

        assert_eq!(
            sessions.release("doc-1").doc_token.as_deref(),
            Some("token-1")
        );
        assert!(sessions.take_pending("doc-1").is_none());
        assert!(sessions.release("doc-1").is_empty());
    }

    #[test]
    fn discarded_pending_payload_is_not_handed_out() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.discard_pending("doc-1");
        assert!(sessions.take_pending("doc-1").is_none());
    }

    #[test]
    fn save_as_can_replace_the_window_token() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        assert!(sessions.set_token("doc-1", "token-2".to_string()));
        assert_eq!(
            sessions.release("doc-1").doc_token.as_deref(),
            Some("token-2")
        );
    }

    #[test]
    fn untitled_mark_survives_a_missing_payload() {
        let sessions = WindowSessions::new();
        sessions.mark_untitled("doc-1");

        assert!(sessions.take_pending("doc-1").is_none());
        assert!(sessions.is_untitled("doc-1"));

        assert!(sessions.release("doc-1").is_empty());
        assert!(!sessions.is_untitled("doc-1"));
    }

    #[test]
    fn release_prefers_the_adopted_token_over_a_staged_one() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        sessions.stage("doc-1", payload("token-2"));

        assert_eq!(
            sessions.release("doc-1").doc_token.as_deref(),
            Some("token-1")
        );
        // The leftover staged payload is gone even though the adopted token
        // won; nothing may survive the window.
        assert!(sessions.pending_path("doc-1").is_none());
        assert!(sessions.take_pending("doc-1").is_none());
    }

    #[test]
    fn clear_untitled_revokes_the_title_mark() {
        let sessions = WindowSessions::new();
        sessions.mark_untitled("doc-1");
        sessions.clear_untitled("doc-1");

        assert!(!sessions.is_untitled("doc-1"));
        assert!(!sessions.is_untitled("doc-2"));
    }

    #[test]
    fn taking_a_payload_or_setting_a_token_clears_the_untitled_mark() {
        let sessions = WindowSessions::new();
        sessions.mark_untitled("doc-1");
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        assert!(!sessions.is_untitled("doc-1"));

        sessions.mark_untitled("doc-2");
        sessions.set_token("doc-2", "token-2".to_string());
        assert!(!sessions.is_untitled("doc-2"));
        assert_eq!(
            sessions.release("doc-2").doc_token.as_deref(),
            Some("token-2")
        );
    }

    #[test]
    fn release_returns_document_and_workspace_tokens_once() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        let workspace = WorkspaceToken::new();
        sessions
            .set_workspace("doc-1", workspace.clone(), 0)
            .expect("workspace");

        let released = sessions.release("doc-1");
        assert_eq!(released.doc_token.as_deref(), Some("token-1"));
        assert_eq!(released.workspace_token.as_ref(), Some(&workspace));
        assert!(sessions.release("doc-1").is_empty());
        assert!(sessions.is_closed("doc-1"));
    }

    #[test]
    fn closed_labels_refuse_late_writes() {
        let sessions = WindowSessions::new();
        sessions.release("doc-1");
        assert!(sessions.is_closed("doc-1"));

        assert!(!sessions.stage("doc-1", payload("token-1")));
        assert!(!sessions.set_token("doc-1", "token-2".to_string()));
        sessions.mark_untitled("doc-1");
        assert!(!sessions.is_untitled("doc-1"));
        assert!(sessions
            .set_workspace("doc-1", WorkspaceToken::new(), 1)
            .is_err());
    }

    #[test]
    fn set_workspace_rejects_a_stale_epoch_and_keeps_the_new_token_unowned() {
        let sessions = WindowSessions::new();
        let first = WorkspaceToken::new();
        let second = WorkspaceToken::new();

        assert_eq!(
            sessions
                .set_workspace("doc-1", first.clone(), 0)
                .expect("first commit"),
            None
        );
        let epoch = sessions.epoch("doc-1");
        assert_eq!(epoch, 1);

        assert!(sessions.set_workspace("doc-1", second.clone(), 0).is_err());
        assert_eq!(sessions.workspace_for("doc-1"), Some(first));
        assert!(!sessions.owns_workspace("doc-1", &second));
    }

    #[test]
    fn concurrent_commits_with_the_same_epoch_have_exactly_one_winner() {
        let sessions = WindowSessions::new();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut handles = Vec::new();
        let mut tokens = Vec::new();

        for _ in 0..2 {
            let sessions = sessions.clone();
            let barrier = Arc::clone(&barrier);
            let token = WorkspaceToken::new();
            tokens.push(token.clone());
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                sessions.set_workspace("doc-1", token, 0).is_ok()
            }));
        }
        barrier.wait();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread"))
            .collect::<Vec<_>>();

        assert_eq!(outcomes.iter().filter(|ok| **ok).count(), 1);
        let owner = sessions.workspace_for("doc-1").expect("one token");
        assert!(tokens.iter().any(|token| token == &owner));
    }

    #[test]
    fn stale_cleanup_cannot_delete_a_newer_workspace() {
        let sessions = WindowSessions::new();
        let first = WorkspaceToken::new();
        let second = WorkspaceToken::new();

        sessions
            .set_workspace("doc-1", first.clone(), 0)
            .expect("first");
        sessions
            .set_workspace("doc-1", second.clone(), sessions.epoch("doc-1"))
            .expect("second");

        assert!(sessions.take_workspace_if("doc-1", &first).is_none());
        assert_eq!(sessions.workspace_for("doc-1"), Some(second.clone()));
        assert_eq!(
            sessions.take_workspace_if("doc-1", &second),
            Some(second.clone())
        );
        assert!(sessions.workspace_for("doc-1").is_none());
    }

    #[test]
    fn workspace_ownership_is_per_window() {
        let sessions = WindowSessions::new();
        let token = WorkspaceToken::new();
        sessions
            .set_workspace("doc-1", token.clone(), 0)
            .expect("workspace");

        assert!(sessions.owns_workspace("doc-1", &token));
        assert!(!sessions.owns_workspace("doc-2", &token));
        assert_eq!(
            sessions.workspace_entries(),
            vec![("doc-1".to_string(), token)]
        );
    }

    #[test]
    fn reopen_clears_the_tombstone_and_revives_staging() {
        let sessions = WindowSessions::new();
        let workspace = WorkspaceToken::new();
        sessions
            .set_workspace("main", workspace.clone(), 0)
            .expect("workspace");
        sessions.release("main");
        assert!(sessions.is_closed("main"));

        let released = sessions.reopen("main");
        assert_eq!(released.workspace_token, None);
        assert!(!sessions.is_closed("main"));
        assert!(sessions.stage("main", payload("token-1")));
        assert!(sessions
            .set_workspace("main", WorkspaceToken::new(), sessions.epoch("main"))
            .is_ok());
    }

    #[test]
    fn reopen_returns_leftover_tokens_and_bumps_the_epoch() {
        let sessions = WindowSessions::new();
        sessions.stage("main", payload("token-1"));
        let workspace = WorkspaceToken::new();
        sessions
            .set_workspace("main", workspace.clone(), 0)
            .expect("workspace");
        let old_epoch = sessions.epoch("main");

        let released = sessions.reopen("main");
        assert_eq!(released.doc_token.as_deref(), Some("token-1"));
        assert_eq!(released.workspace_token.as_ref(), Some(&workspace));
        assert!(sessions.epoch("main") > old_epoch);
        assert!(sessions
            .set_workspace("main", WorkspaceToken::new(), old_epoch)
            .is_err());
    }

    #[test]
    fn take_workspace_if_does_not_touch_document_state() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        let workspace = WorkspaceToken::new();
        sessions
            .set_workspace("doc-1", workspace.clone(), 0)
            .expect("workspace");

        assert_eq!(
            sessions.take_workspace_if("doc-1", &workspace),
            Some(workspace)
        );
        assert_eq!(sessions.token_for("doc-1").as_deref(), Some("token-1"));
        assert_eq!(
            sessions.release("doc-1").doc_token.as_deref(),
            Some("token-1")
        );
    }

    #[test]
    fn set_token_refuses_a_closed_window() {
        let sessions = WindowSessions::new();
        sessions.release("doc-1");
        assert!(!sessions.set_token("doc-1", "token-2".to_string()));
        assert!(sessions.token_for("doc-1").is_none());
    }

    #[test]
    fn activation_keeps_one_rollback_token_and_retires_the_older_one() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");

        let first = sessions
            .activate_document("doc-1", Some("token-2".to_string()))
            .expect("switch");
        assert_eq!(first.previous.as_deref(), Some("token-1"));
        assert!(first.retired.is_none());
        assert_eq!(sessions.token_for("doc-1").as_deref(), Some("token-2"));

        let second = sessions
            .activate_document("doc-1", Some("token-3".to_string()))
            .expect("second switch");
        assert_eq!(second.previous.as_deref(), Some("token-2"));
        // token-1 is now unreachable and must be released by the caller.
        assert_eq!(second.retired.as_deref(), Some("token-1"));
        assert_eq!(sessions.token_for("doc-1").as_deref(), Some("token-3"));

        let released = sessions.release("doc-1");
        assert_eq!(released.doc_token.as_deref(), Some("token-3"));
        assert_eq!(released.previous_doc_token.as_deref(), Some("token-2"));
    }

    #[test]
    fn activation_can_roll_back_to_the_retained_token() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        sessions
            .activate_document("doc-1", Some("token-2".to_string()))
            .expect("switch");

        let rollback = sessions
            .activate_document("doc-1", Some("token-1".to_string()))
            .expect("rollback");
        assert_eq!(rollback.previous.as_deref(), Some("token-2"));
        assert!(rollback.retired.is_none());
        assert_eq!(sessions.token_for("doc-1").as_deref(), Some("token-1"));

        // The failed candidate is retained and released with the window.
        let released = sessions.release("doc-1");
        assert_eq!(released.doc_token.as_deref(), Some("token-1"));
        assert_eq!(released.previous_doc_token.as_deref(), Some("token-2"));
    }

    #[test]
    fn activating_untitled_keeps_the_rollback_token() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");

        sessions.activate_document("doc-1", None).expect("untitled");
        assert!(sessions.token_for("doc-1").is_none());
        assert!(sessions.is_untitled("doc-1"));

        sessions
            .activate_document("doc-1", Some("token-1".to_string()))
            .expect("restore");
        assert!(!sessions.is_untitled("doc-1"));
        assert_eq!(sessions.token_for("doc-1").as_deref(), Some("token-1"));
    }

    #[test]
    fn activating_a_closed_window_is_refused() {
        let sessions = WindowSessions::new();
        sessions.release("doc-1");
        assert!(sessions
            .activate_document("doc-1", Some("token-2".to_string()))
            .is_err());
        assert!(sessions.token_for("doc-1").is_none());
    }
}
