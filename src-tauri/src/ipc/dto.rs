use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Encoding of the file on disk. UTF-16 without a BOM is intentionally absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

/// Dominant line ending detected while reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReadOnlyReason {
    Mdx,
    MixedEol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    pub encoding: TextEncoding,
    pub has_bom: bool,
    pub eol: LineEnding,
}

/// The read result for `document_open` / `document_reload`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    pub doc_token: String,
    pub path: String,
    /// Always LF-only in memory; the original EOL is described by `format.eol`.
    pub text: String,
    pub format: TextFormat,
    pub mixed_eol: bool,
    /// BLAKE3 of the raw bytes on disk, including BOM/EOL.
    pub hash: String,
    pub size: u64,
    /// UTF-16 code units, matching JavaScript `String.length`.
    pub text_units: u64,
    pub mtime_ms: i64,
    pub read_only: bool,
    pub read_only_reason: Option<ReadOnlyReason>,
}

/// Logical payload of `document_write_atomic`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub doc_token: String,
    /// LF-only text; any `\r` is rejected by the Rust command.
    pub text: String,
    /// Set only after the user confirms an exact-version overwrite.
    #[ts(optional)]
    pub expected_current_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetails {
    pub current_hash: String,
    pub current_mtime_ms: i64,
    pub current_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    Window,
    Exit,
}

/// Payload of the single P1 application event `app://close-requested`.
///
/// `target` lets a window ignore events that were delivered by a global
/// listener but belong to another window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequestedPayload {
    pub reason: CloseReason,
    pub target: String,
}

/// Payload of `app://menu-action`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MenuActionPayload {
    pub action: String,
    pub target: String,
}

/// Build metadata displayed by the About window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    pub version: String,
    /// Version plus the architecture of this build, e.g. `0.1.0 · arm64`.
    pub build: String,
    pub platform: String,
    pub license: String,
    pub copyright: String,
}

/// External destinations linked from the About window.
///
/// The webview sends an enum, never a URL: Rust owns the allowlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AboutLink {
    Docs,
    Github,
    Changelog,
    License,
}

/// Lifecycle phase owned by the Rust `UpdateManager`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
}

/// User-visible metadata for an available update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// RFC3339 timestamp from the updater manifest; display only.
    pub date: Option<String>,
    /// Plain text, truncated by the Rust side before it reaches the webview.
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Complete update state returned by every update command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub phase: UpdatePhase,
    /// Monotonic operation generation; stale progress/events are discarded by the UI.
    pub generation: u64,
    pub current_version: String,
    pub update: Option<UpdateInfo>,
    pub progress: Option<UpdateProgress>,
}

/// Payload of `app://update-progress`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressPayload {
    pub generation: u64,
    pub downloaded: u64,
    pub total: Option<u64>,
}
