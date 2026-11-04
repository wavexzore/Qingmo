use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::ipc::dto::FilePayload;

#[derive(Debug, Default)]
struct Inner {
    /// Payload staged by `document_open` until the new window asks for it.
    pending: HashMap<String, FilePayload>,
    /// Document token currently owned by each window.
    tokens: HashMap<String, String>,
    /// Windows whose document has no path yet (created by New or the blank main).
    untitled: HashSet<String>,
}

/// Per-window document handoff.
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
    pub fn stage(&self, label: &str, payload: FilePayload) {
        self.lock().pending.insert(label.to_string(), payload);
    }

    /// Drops a staged payload, used when window creation fails.
    pub fn discard_pending(&self, label: &str) {
        self.lock().pending.remove(label);
    }

    /// Marks a window as an untitled document so its title is localized.
    pub fn mark_untitled(&self, label: &str) {
        self.lock().untitled.insert(label.to_string());
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
        let payload = inner.pending.remove(label)?;
        inner.untitled.remove(label);
        inner
            .tokens
            .insert(label.to_string(), payload.doc_token.clone());
        Some(payload)
    }

    /// Records a new token after Save As or another in-window token change.
    pub fn set_token(&self, label: &str, token: String) {
        let mut inner = self.lock();
        inner.tokens.insert(label.to_string(), token);
        inner.untitled.remove(label);
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

    /// Removes a window's token and any payload it never consumed.
    ///
    /// Returns the token the registry must release: the one the window had
    /// adopted, or — for a window destroyed before its boot payload was
    /// consumed — the one the staged payload was opened against.
    pub fn release(&self, label: &str) -> Option<String> {
        let mut inner = self.lock();
        let token = inner
            .tokens
            .remove(label)
            .or_else(|| inner.pending.remove(label).map(|payload| payload.doc_token));
        inner.untitled.remove(label);
        token
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        sessions.stage("doc-1", payload("token-1"));

        let taken = sessions.take_pending("doc-1").expect("payload");
        assert_eq!(taken.doc_token, "token-1");
        assert!(sessions.take_pending("doc-1").is_none());
        assert_eq!(sessions.release("doc-1").as_deref(), Some("token-1"));
        assert!(sessions.release("doc-1").is_none());
    }

    #[test]
    fn closing_before_taking_the_payload_releases_its_token() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));

        assert_eq!(sessions.release("doc-1").as_deref(), Some("token-1"));
        assert!(sessions.take_pending("doc-1").is_none());
        assert!(sessions.release("doc-1").is_none());
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
        sessions.set_token("doc-1", "token-2".to_string());
        assert_eq!(sessions.release("doc-1").as_deref(), Some("token-2"));
    }

    #[test]
    fn untitled_mark_survives_a_missing_payload() {
        let sessions = WindowSessions::new();
        sessions.mark_untitled("doc-1");

        assert!(sessions.take_pending("doc-1").is_none());
        assert!(sessions.is_untitled("doc-1"));

        assert_eq!(sessions.release("doc-1"), None);
        assert!(!sessions.is_untitled("doc-1"));
    }

    #[test]
    fn release_prefers_the_adopted_token_over_a_staged_one() {
        let sessions = WindowSessions::new();
        sessions.stage("doc-1", payload("token-1"));
        sessions.take_pending("doc-1");
        sessions.stage("doc-1", payload("token-2"));

        assert_eq!(sessions.release("doc-1").as_deref(), Some("token-1"));
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
        assert_eq!(sessions.release("doc-2").as_deref(), Some("token-2"));
    }
}
