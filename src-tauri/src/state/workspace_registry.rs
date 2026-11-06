use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::WorkspaceInfo;

/// Opaque per-window workspace handle. It is never a document identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkspaceToken(String);

impl WorkspaceToken {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    /// Parses a token received over IPC.
    ///
    /// Only the canonical hyphenated lowercase form this process generates is
    /// accepted, so a differently spelled UUID cannot address another token.
    pub fn parse(value: &str) -> Result<Self, AppError> {
        let parsed = uuid::Uuid::parse_str(value).map_err(|_| invalid_token())?;
        if parsed.to_string() != value {
            return Err(invalid_token());
        }
        Ok(Self(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for WorkspaceToken {
    fn default() -> Self {
        Self::new()
    }
}

fn invalid_token() -> AppError {
    AppError::new(
        AppErrorCode::InvalidPath,
        "invalid or expired workspaceToken",
    )
}

fn is_bidi_format_char(character: char) -> bool {
    matches!(
        character,
        '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// Display-only text: no control characters and no bidi overrides.
fn sanitize_display(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() || is_bidi_format_char(character) {
                '\u{FFFD}'
            } else {
                character
            }
        })
        .collect()
}

/// Display-only path text; Windows verbatim prefixes are hidden.
pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    sanitize_display(&raw)
}

/// A canonical workspace root and its safe display name.
#[derive(Debug)]
pub struct WorkspaceRecord {
    /// Canonical root; never reconstructed from the display string.
    pub root: PathBuf,
    /// Display-safe directory name.
    pub name: String,
    root_display: String,
}

impl WorkspaceRecord {
    fn new(root: PathBuf) -> Self {
        let root_display = display_path(&root);
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(sanitize_display)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| root_display.clone());
        Self {
            root,
            name,
            root_display,
        }
    }

    pub fn info(&self, token: &WorkspaceToken) -> WorkspaceInfo {
        WorkspaceInfo {
            token: token.as_str().to_string(),
            root: self.root_display.clone(),
            name: self.name.clone(),
        }
    }
}

/// Process-wide map of workspace tokens.
///
/// Tokens are capabilities, not identities: every window (including a child
/// created from another workspace window) gets its own token, and releasing
/// one never affects the others.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceRegistry {
    inner: Arc<RwLock<HashMap<WorkspaceToken, Arc<WorkspaceRecord>>>>,
}

impl WorkspaceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Probes and registers a directory selected by the native dialog.
    pub fn open(
        &self,
        selected: PathBuf,
    ) -> Result<(WorkspaceToken, Arc<WorkspaceRecord>), AppError> {
        let root = std::fs::canonicalize(&selected).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(AppErrorCode::NotFound, "workspace root not found")
            } else {
                AppError::from_io(&error)
            }
        })?;
        let metadata = std::fs::metadata(&root).map_err(|error| AppError::from_io(&error))?;
        if !metadata.is_dir() {
            return Err(AppError::new(
                AppErrorCode::InvalidPath,
                "workspace root is not a directory",
            ));
        }
        Ok(self.open_canonical(root))
    }

    /// Registers an already probed canonical directory without touching disk.
    pub fn open_canonical(&self, canonical: PathBuf) -> (WorkspaceToken, Arc<WorkspaceRecord>) {
        let token = WorkspaceToken::new();
        let record = Arc::new(WorkspaceRecord::new(canonical));
        let mut map = self.write();
        map.insert(token.clone(), Arc::clone(&record));
        (token, record)
    }

    /// Creates an independent token for the same root.
    pub fn fork(
        &self,
        token: &WorkspaceToken,
    ) -> Result<(WorkspaceToken, Arc<WorkspaceRecord>), AppError> {
        let record = self.get(token)?;
        let child = WorkspaceToken::new();
        let mut map = self.write();
        map.insert(child.clone(), Arc::clone(&record));
        Ok((child, record))
    }

    pub fn get(&self, token: &WorkspaceToken) -> Result<Arc<WorkspaceRecord>, AppError> {
        let map = self.read();
        map.get(token).cloned().ok_or_else(invalid_token)
    }

    pub fn release(&self, token: &WorkspaceToken) -> bool {
        self.write().remove(token).is_some()
    }

    pub fn len(&self) -> usize {
        self.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn read(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<WorkspaceToken, Arc<WorkspaceRecord>>> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<WorkspaceToken, Arc<WorkspaceRecord>>> {
        self.inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical root");
        (dir, root)
    }

    #[test]
    fn open_registers_the_canonical_root() {
        let (_dir, root) = canonical_tempdir();
        let registry = WorkspaceRegistry::new();

        let (token, record) = registry.open(root.clone()).expect("open");
        assert_eq!(record.root, root);
        assert_eq!(registry.len(), 1);
        assert!(registry.get(&token).is_ok());
        assert_eq!(
            record.info(&token).root,
            root.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn open_rejects_files_and_missing_paths() {
        let (_dir, root) = canonical_tempdir();
        let file = root.join("note.md");
        std::fs::write(&file, "body").expect("file");
        let registry = WorkspaceRegistry::new();

        assert_eq!(
            registry.open(file).expect_err("file").code,
            AppErrorCode::InvalidPath
        );
        assert_eq!(
            registry
                .open(root.join("missing"))
                .expect_err("missing")
                .code,
            AppErrorCode::NotFound
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn fork_creates_independent_tokens_for_the_same_root() {
        let (_dir, root) = canonical_tempdir();
        let registry = WorkspaceRegistry::new();
        let (parent, _) = registry.open(root).expect("open");

        let (child, child_record) = registry.fork(&parent).expect("fork");
        assert_ne!(parent, child);
        assert_eq!(
            child_record.root,
            registry.get(&parent).expect("parent").root
        );
        assert_eq!(registry.len(), 2);

        assert!(registry.release(&child));
        assert!(registry.get(&parent).is_ok());
        assert!(registry.release(&parent));
        assert!(registry.is_empty());
    }

    #[test]
    fn releasing_an_unknown_token_is_false_and_get_fails() {
        let registry = WorkspaceRegistry::new();
        let token = WorkspaceToken::new();
        assert!(!registry.release(&token));
        assert_eq!(
            registry.get(&token).expect_err("unknown").code,
            AppErrorCode::InvalidPath
        );
        assert!(registry.fork(&token).is_err());
    }

    #[test]
    fn tokens_only_accept_the_canonical_hyphenated_uuid() {
        let token = WorkspaceToken::new();
        assert_eq!(
            WorkspaceToken::parse(token.as_str())
                .expect("canonical")
                .as_str(),
            token.as_str()
        );
        for invalid in ["", "not-a-token", "123e4567e89b12d3a456426614174000"] {
            assert_eq!(
                WorkspaceToken::parse(invalid).expect_err("invalid").code,
                AppErrorCode::InvalidPath
            );
        }
    }

    #[test]
    fn display_text_strips_control_and_bidi_characters() {
        assert_eq!(sanitize_display("a\u{0007}b"), "a\u{FFFD}b");
        assert_eq!(sanitize_display("a\u{202E}b"), "a\u{FFFD}b");
        assert_eq!(sanitize_display("普通"), "普通");
    }

    #[test]
    fn root_name_falls_back_to_the_display_path() {
        let record = WorkspaceRecord::new(PathBuf::from("/"));
        assert_eq!(record.name, "/");
        assert_eq!(record.info(&WorkspaceToken::new()).name, "/");
    }
}
