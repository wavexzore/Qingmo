use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable error codes shared by Rust and TypeScript.
///
/// The wire representation is SCREAMING_SNAKE_CASE so that a frontend can
/// switch on the code without depending on human-readable messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppErrorCode {
    InvalidPath,
    OutsideScope,
    NotFound,
    NotAFile,
    UnsupportedExtension,
    FileTooLarge,
    UnsupportedEncoding,
    Conflict,
    PermissionDenied,
    ReadOnly,
    Busy,
    Io,
    Cancelled,
}

/// The only error shape returned by the four P1 commands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,
    #[ts(optional)]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: AppErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn not_implemented(command: &str) -> Self {
        Self::new(
            AppErrorCode::Io,
            format!("{command} is not implemented yet"),
        )
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}
