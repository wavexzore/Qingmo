use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{AppError, AppErrorCode};

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

/// Why the document watcher notified the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DocumentChangeKind {
    /// The file exists with a different hash than the editor's base version.
    Modified,
    /// The file disappeared or stopped being a regular file.
    Deleted,
}

/// Payload of `app://document-changed`.
///
/// The watcher has already read the disk version, so a modified file carries
/// the exact hash/size/mtime the window needs to open the conflict banner
/// without a second read. Deleted files carry no version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChangedPayload {
    pub doc_token: String,
    pub kind: DocumentChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_mtime_ms: Option<i64>,
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

/// Severity of a persisted log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// One persisted log line, parsed for the log viewer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub target: String,
    pub message: String,
}

/// Aggregate counters for the log directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LogStats {
    pub total_entries: u64,
    pub error_count: u64,
    pub warn_count: u64,
    pub info_count: u64,
    pub debug_count: u64,
    pub total_size_bytes: u64,
    pub file_count: u64,
    pub oldest_entry: Option<String>,
    pub newest_entry: Option<String>,
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
    /// Per-language notes from the manifest's custom `notesByLocale` field.
    /// Absent on manifests published before the field existed.
    #[ts(optional)]
    pub notes_by_locale: Option<std::collections::BTreeMap<String, String>>,
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

/// UI language selected in the webview.
///
/// The webview owns the user preference and projects it into native shell
/// labels; Rust never keeps a second copy of the menu copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum AppLanguage {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

/// Every label the native shell renders. The frontend builds this DTO; Rust
/// only validates and renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellLabels {
    pub app_name: String,
    pub about: String,
    pub settings: String,
    pub services: String,
    pub hide_app: String,
    pub hide_others: String,
    pub show_all: String,
    pub quit_app: String,
    pub file: String,
    pub open: String,
    pub save: String,
    pub close_window: String,
    pub edit: String,
    pub undo: String,
    pub redo: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
    pub view: String,
    pub live_preview: String,
    pub command_palette: String,
    pub toggle_theme: String,
    pub logs: String,
    pub fullscreen: String,
    pub theme: String,
    pub theme_light: String,
    pub theme_dark: String,
    pub theme_system: String,
    pub language: String,
    #[serde(rename = "languageZhCN")]
    pub language_zh_cn: String,
    pub language_en: String,
    pub window: String,
    pub minimize: String,
    pub zoom: String,
    pub maximize: String,
    pub bring_all_to_front: String,
    pub help: String,
    pub untitled_file_name: String,
}

pub const NATIVE_SHELL_LABEL_LIMIT: usize = 80;
pub const NATIVE_SHELL_APP_NAME_LIMIT: usize = 32;
pub const NATIVE_SHELL_FILE_NAME_LIMIT: usize = 120;

fn invalid_locale(field: &str, reason: &str) -> AppError {
    AppError::new(
        AppErrorCode::InvalidLocale,
        format!("invalid native shell label: {field} ({reason})"),
    )
    .with_details(serde_json::json!({ "field": field, "reason": reason }))
}

fn is_bidi_format_char(character: char) -> bool {
    matches!(
        character,
        '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

fn validate_untitled_file_name(name: &str) -> Result<(), AppError> {
    let field = "untitledFileName";
    if name.trim().is_empty() {
        return Err(invalid_locale(field, "empty"));
    }
    if name.chars().count() > NATIVE_SHELL_FILE_NAME_LIMIT {
        return Err(invalid_locale(field, "too_long"));
    }
    if name
        .chars()
        .any(|character| character.is_control() || is_bidi_format_char(character))
    {
        return Err(invalid_locale(field, "control_character"));
    }
    if !name.ends_with(".md") {
        return Err(invalid_locale(field, "invalid_file_name"));
    }
    if name.starts_with('.')
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.contains(':')
    {
        return Err(invalid_locale(field, "invalid_file_name"));
    }
    let path = std::path::Path::new(name);
    if path.is_absolute() || path.file_name().and_then(|value| value.to_str()) != Some(name) {
        return Err(invalid_locale(field, "invalid_file_name"));
    }
    Ok(())
}

impl NativeShellLabels {
    /// Menu/title labels only; `untitledFileName` is validated separately.
    pub fn fields(&self) -> [(&'static str, &str); 38] {
        [
            ("appName", &self.app_name),
            ("about", &self.about),
            ("settings", &self.settings),
            ("services", &self.services),
            ("hideApp", &self.hide_app),
            ("hideOthers", &self.hide_others),
            ("showAll", &self.show_all),
            ("quitApp", &self.quit_app),
            ("file", &self.file),
            ("open", &self.open),
            ("save", &self.save),
            ("closeWindow", &self.close_window),
            ("edit", &self.edit),
            ("undo", &self.undo),
            ("redo", &self.redo),
            ("cut", &self.cut),
            ("copy", &self.copy),
            ("paste", &self.paste),
            ("selectAll", &self.select_all),
            ("view", &self.view),
            ("livePreview", &self.live_preview),
            ("commandPalette", &self.command_palette),
            ("toggleTheme", &self.toggle_theme),
            ("logs", &self.logs),
            ("fullscreen", &self.fullscreen),
            ("theme", &self.theme),
            ("themeLight", &self.theme_light),
            ("themeDark", &self.theme_dark),
            ("themeSystem", &self.theme_system),
            ("language", &self.language),
            ("languageZhCN", &self.language_zh_cn),
            ("languageEn", &self.language_en),
            ("window", &self.window),
            ("minimize", &self.minimize),
            ("zoom", &self.zoom),
            ("maximize", &self.maximize),
            ("bringAllToFront", &self.bring_all_to_front),
            ("help", &self.help),
        ]
    }

    pub fn validate(&self) -> Result<(), AppError> {
        for (field, value) in self.fields() {
            let limit = if field == "appName" {
                NATIVE_SHELL_APP_NAME_LIMIT
            } else {
                NATIVE_SHELL_LABEL_LIMIT
            };
            if value.trim().is_empty() {
                return Err(invalid_locale(field, "empty"));
            }
            if value.chars().count() > limit {
                return Err(invalid_locale(field, "too_long"));
            }
            if value
                .chars()
                .any(|character| character.is_control() || is_bidi_format_char(character))
            {
                return Err(invalid_locale(field, "control_character"));
            }
        }
        validate_untitled_file_name(&self.untitled_file_name)
    }
}

/// Complete payload of `app_apply_locale`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLocaleRequest {
    pub language: AppLanguage,
    pub labels: NativeShellLabels,
}

#[cfg(test)]
pub fn test_native_labels(app_name: &str) -> NativeShellLabels {
    NativeShellLabels {
        app_name: app_name.to_string(),
        about: format!("About {app_name}"),
        settings: "Settings…".to_string(),
        services: "Services".to_string(),
        hide_app: format!("Hide {app_name}"),
        hide_others: "Hide Others".to_string(),
        show_all: "Show All".to_string(),
        quit_app: format!("Quit {app_name}"),
        file: "File".to_string(),
        open: "Open…".to_string(),
        save: "Save".to_string(),
        close_window: "Close Window".to_string(),
        edit: "Edit".to_string(),
        undo: "Undo".to_string(),
        redo: "Redo".to_string(),
        cut: "Cut".to_string(),
        copy: "Copy".to_string(),
        paste: "Paste".to_string(),
        select_all: "Select All".to_string(),
        view: "View".to_string(),
        live_preview: "Live Preview".to_string(),
        command_palette: "Command Palette".to_string(),
        toggle_theme: "Toggle Theme".to_string(),
        logs: "Logs…".to_string(),
        fullscreen: "Full Screen".to_string(),
        theme: "Theme".to_string(),
        theme_light: "Light".to_string(),
        theme_dark: "Dark".to_string(),
        theme_system: "System".to_string(),
        language: "Language".to_string(),
        language_zh_cn: "简体中文".to_string(),
        language_en: "English".to_string(),
        window: "Window".to_string(),
        minimize: "Minimize".to_string(),
        zoom: "Zoom".to_string(),
        maximize: "Maximize".to_string(),
        bring_all_to_front: "Bring All to Front".to_string(),
        help: "Help".to_string(),
        untitled_file_name: "Untitled.md".to_string(),
    }
}

/// Persisted CodeMirror view state for one named document.
///
/// The store stamps `updatedAtMs`; the webview only supplies the input shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorViewState {
    pub anchor: u32,
    pub head: u32,
    /// Document position of the block at the top of the viewport.
    pub top_pos: u32,
    /// Pixel offset between that block's top and the viewport top.
    pub top_offset: f64,
    pub scroll_left: f64,
    /// User preference, not the effective mode.
    pub live_preview_preferred: bool,
    pub updated_at_ms: i64,
}

/// Lenient write shape for `session_view_state_set`.
///
/// Numbers arrive as `i64`/`f64` so an out-of-range value is clamped by the
/// store instead of failing at the serde boundary and losing the AppError.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorViewStateInput {
    pub anchor: i64,
    pub head: i64,
    pub top_pos: i64,
    pub top_offset: f64,
    pub scroll_left: f64,
    pub live_preview_preferred: bool,
}

/// Why a crash draft exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DraftKind {
    /// Never bound to a path; recovery always creates a new untitled session.
    Untitled,
    /// A named document whose save failed or conflicted.
    Named,
}

/// Request body for `session_draft_write`.
///
/// `kind` stays a string so an unknown value produces `INVALID_PATH` instead
/// of a deserialization error outside the AppError contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftWriteRequest {
    /// Existing draft id; omitted for the first write of a session.
    #[ts(optional)]
    pub id: Option<String>,
    pub kind: String,
    #[ts(optional)]
    pub path: Option<String>,
    pub title: String,
    pub text: String,
    pub anchor: i64,
    pub head: i64,
}

/// Metadata shown by the recovery banner/dialog; never carries the body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    pub id: String,
    pub kind: DraftKind,
    pub path: Option<String>,
    pub title: String,
    /// UTF-16 code units, matching JavaScript `String.length`.
    pub text_units: u64,
    /// UTF-8 byte length of `text`.
    pub size_bytes: u64,
    pub anchor: u32,
    pub head: u32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub app_version: String,
}

/// On-disk draft file, returned by `session_draft_read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub schema_version: u32,
    pub id: String,
    pub kind: DraftKind,
    pub path: Option<String>,
    pub title: String,
    pub text: String,
    pub text_units: u64,
    pub size_bytes: u64,
    pub anchor: u32,
    pub head: u32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub app_version: String,
}

impl DraftRecord {
    pub fn meta(&self) -> DraftMeta {
        DraftMeta {
            id: self.id.clone(),
            kind: self.kind,
            path: self.path.clone(),
            title: self.title.clone(),
            text_units: self.text_units,
            size_bytes: self.size_bytes,
            anchor: self.anchor,
            head: self.head,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            app_version: self.app_version.clone(),
        }
    }
}

pub const DRAFT_SCHEMA_VERSION: u32 = 1;
pub const VIEW_STATE_SCHEMA_VERSION: u32 = 1;
