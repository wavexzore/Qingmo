//! ASR route matrix, evaluated once in `Preparing`.
//!
//! The six cells only differ in mode, key presence and local readiness. A
//! missing remote key never blocks a ready local model and never passes for an
//! unready one.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, AppErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AsrMode {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteDecision {
    pub kind: RouteKind,
    pub remote_key_missing: bool,
}

/// Resolve the routing matrix. Errors carry the recovery reason.
pub fn decide(mode: AsrMode, has_key: bool, local_ready: bool) -> Result<RouteDecision, AppError> {
    match (mode, has_key, local_ready) {
        (AsrMode::Local, _, true) => Ok(RouteDecision {
            kind: RouteKind::Local,
            remote_key_missing: false,
        }),
        (AsrMode::Local, _, false) => Err(AppError::new(
            AppErrorCode::ModelNotReady,
            "local ASR model is not ready",
        )),
        (AsrMode::Remote, true, _) => Ok(RouteDecision {
            kind: RouteKind::Remote,
            remote_key_missing: false,
        }),
        (AsrMode::Remote, false, true) => Ok(RouteDecision {
            kind: RouteKind::Local,
            remote_key_missing: true,
        }),
        (AsrMode::Remote, false, false) => Err(AppError::new(
            AppErrorCode::InvalidConfig,
            "remote ASR key is missing and no local model is ready",
        )
        .with_details(json!({ "reason": "remote_key_missing" }))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_cells_match_the_matrix() {
        assert_eq!(
            decide(AsrMode::Local, false, true).unwrap().kind,
            RouteKind::Local
        );
        assert_eq!(
            decide(AsrMode::Local, true, true).unwrap().kind,
            RouteKind::Local
        );
        assert_eq!(
            decide(AsrMode::Local, true, false).unwrap_err().code,
            AppErrorCode::ModelNotReady
        );
        assert_eq!(
            decide(AsrMode::Remote, true, true).unwrap().kind,
            RouteKind::Remote
        );
        assert_eq!(
            decide(AsrMode::Remote, true, false).unwrap().kind,
            RouteKind::Remote
        );
        let fallback = decide(AsrMode::Remote, false, true).unwrap();
        assert_eq!(fallback.kind, RouteKind::Local);
        assert!(fallback.remote_key_missing);
    }

    #[test]
    fn remote_without_key_and_local_rejects_with_reason() {
        let error = decide(AsrMode::Remote, false, false).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidConfig);
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details["reason"].as_str()),
            Some("remote_key_missing")
        );
    }
}
