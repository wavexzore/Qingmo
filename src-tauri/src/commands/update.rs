use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Error as UpdaterError, UpdaterExt};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::contract::{EVENT_UPDATE_PROGRESS, EVENT_UPDATE_STATE};
use crate::ipc::dto::{UpdateProgress, UpdateProgressPayload, UpdateSnapshot};
use crate::state::{CloseGuard, UpdateManager};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy)]
enum Operation {
    Check,
    Download,
    Install,
}

impl Operation {
    fn phase(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Download => "download",
            Self::Install => "install",
        }
    }

    fn code(self) -> AppErrorCode {
        match self {
            Self::Check => AppErrorCode::UpdateCheckFailed,
            Self::Download => AppErrorCode::UpdateDownloadFailed,
            Self::Install => AppErrorCode::UpdateInstallFailed,
        }
    }
}

#[tauri::command]
pub fn app_update_status(manager: State<'_, UpdateManager>) -> Result<UpdateSnapshot, AppError> {
    Ok(manager.snapshot())
}

#[tauri::command]
pub async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, UpdateManager>,
) -> Result<UpdateSnapshot, AppError> {
    let generation = manager.begin_check()?;

    let outcome = tokio::time::timeout(CHECK_TIMEOUT, async {
        let updater = app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .configure_client(|client| client.https_only(true))
            .build()
            .map_err(|error| classify_updater_error(&error, Operation::Check, None))?;
        updater
            .check()
            .await
            .map_err(|error| classify_updater_error(&error, Operation::Check, None))
    })
    .await;

    match outcome {
        Ok(Ok(Some(update))) => {
            let snapshot = manager.finish_check_some(generation, update)?;
            emit_state(&app, &snapshot);
            Ok(snapshot)
        }
        Ok(Ok(None)) => {
            let snapshot = manager.finish_check_none(generation)?;
            emit_state(&app, &snapshot);
            Ok(snapshot)
        }
        Ok(Err(error)) => {
            let snapshot = manager.fail_check(generation, error.clone())?;
            emit_state(&app, &snapshot);
            Err(error)
        }
        Err(_) => {
            let error = update_error(Operation::Check, "timeout", true, None);
            let snapshot = manager.fail_check(generation, error.clone())?;
            emit_state(&app, &snapshot);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn app_update_download<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, UpdateManager>,
) -> Result<UpdateSnapshot, AppError> {
    let generation = manager.begin_download()?;

    let Some(mut update) = manager.current_update() else {
        let error = update_error(Operation::Download, "config", false, None);
        return Err(fail_download(&app, manager.inner(), generation, error));
    };

    if update.download_url.scheme() != "https" {
        let error = update_error(Operation::Download, "config", false, None);
        return Err(fail_download(&app, manager.inner(), generation, error));
    }
    update.timeout = Some(DOWNLOAD_TIMEOUT);

    let downloaded = Arc::new(AtomicU64::new(0));
    let over_limit = Arc::new(AtomicBool::new(false));
    let mut last_emit = Instant::now();
    let progress_app = app.clone();
    let progress_downloaded = Arc::clone(&downloaded);
    let progress_over_limit = Arc::clone(&over_limit);
    let on_chunk = move |chunk_len: usize, content_length: Option<u64>| {
        let chunk_len = chunk_len as u64;
        let total = progress_downloaded.fetch_add(chunk_len, Ordering::Relaxed) + chunk_len;
        if content_length.is_some_and(|length| length > MAX_ARTIFACT_BYTES)
            || total > MAX_ARTIFACT_BYTES
        {
            progress_over_limit.store(true, Ordering::Relaxed);
            return;
        }
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let manager = progress_app.state::<UpdateManager>();
            if let Some(progress) = manager.record_progress(generation, total, content_length) {
                emit_progress(&progress_app, generation, progress);
            }
        }
    };

    let mut download = Box::pin(update.download(on_chunk, || {}));
    let watchdog_downloaded = Arc::clone(&downloaded);
    let watchdog_over_limit = Arc::clone(&over_limit);
    let watchdog = async move {
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if watchdog_over_limit.load(Ordering::Relaxed)
                || watchdog_downloaded.load(Ordering::Relaxed) > MAX_ARTIFACT_BYTES
            {
                return;
            }
        }
    };

    let outcome = tokio::time::timeout(DOWNLOAD_TIMEOUT, async {
        tokio::select! {
            result = &mut download => Some(result),
            _ = watchdog => None,
        }
    })
    .await;

    match outcome {
        Err(_) => {
            let error = update_error(Operation::Download, "timeout", true, None);
            Err(fail_download(&app, manager.inner(), generation, error))
        }
        Ok(None) => {
            let error = update_error(Operation::Download, "too_large", false, None);
            Err(fail_download(&app, manager.inner(), generation, error))
        }
        Ok(Some(Err(error))) => {
            let version = manager.snapshot().update.map(|info| info.version);
            let error = classify_updater_error(&error, Operation::Download, version.as_deref());
            Err(fail_download(&app, manager.inner(), generation, error))
        }
        Ok(Some(Ok(bytes))) => {
            if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
                let error = update_error(Operation::Download, "too_large", false, None);
                return Err(fail_download(&app, manager.inner(), generation, error));
            }
            let snapshot = manager.finish_download(generation, bytes)?;
            emit_state(&app, &snapshot);
            Ok(snapshot)
        }
    }
}

#[tauri::command]
pub async fn app_update_install<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, UpdateManager>,
    close_guard: State<'_, CloseGuard>,
) -> Result<(), AppError> {
    close_guard.begin_install()?;
    let generation = match manager.begin_install() {
        Ok(generation) => generation,
        Err(error) => {
            close_guard.end_install();
            return Err(error);
        }
    };
    emit_state(&app, &manager.snapshot());

    let version = manager.snapshot().update.map(|info| info.version);
    let Some(update) = manager.current_update() else {
        let error = update_error(Operation::Install, "config", false, version.as_deref());
        let _ = manager.fail_install(generation, error.clone(), true);
        close_guard.end_install();
        emit_state(&app, &manager.snapshot());
        return Err(error);
    };
    let Some(artifact) = manager.artifact() else {
        let error = update_error(Operation::Install, "config", false, version.as_deref());
        let _ = manager.fail_install(generation, error.clone(), true);
        close_guard.end_install();
        emit_state(&app, &manager.snapshot());
        return Err(error);
    };

    let result = tauri::async_runtime::spawn_blocking(move || update.install(artifact)).await;

    match result {
        Ok(Ok(())) => {
            app.request_restart();
            Ok(())
        }
        Ok(Err(error)) => {
            let (error, clear_artifact) = classify_install_error(&error, version.as_deref());
            let _ = manager.fail_install(generation, error.clone(), clear_artifact);
            close_guard.end_install();
            emit_state(&app, &manager.snapshot());
            Err(error)
        }
        Err(join_error) => {
            tracing::error!(?join_error, "update install task failed");
            let error = update_error(Operation::Install, "io", false, version.as_deref());
            let _ = manager.fail_install(generation, error.clone(), false);
            close_guard.end_install();
            emit_state(&app, &manager.snapshot());
            Err(error)
        }
    }
}

fn fail_download<R: Runtime>(
    app: &AppHandle<R>,
    manager: &UpdateManager,
    generation: u64,
    error: AppError,
) -> AppError {
    match manager.fail_download(generation, error.clone()) {
        Ok(snapshot) => emit_state(app, &snapshot),
        Err(_) => emit_state(app, &manager.snapshot()),
    }
    error
}

fn emit_state<R: Runtime>(app: &AppHandle<R>, snapshot: &UpdateSnapshot) {
    if let Err(error) = app.emit(EVENT_UPDATE_STATE, snapshot.clone()) {
        tracing::error!(?error, "failed to emit update state");
    }
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, generation: u64, progress: UpdateProgress) {
    let payload = UpdateProgressPayload {
        generation,
        downloaded: progress.downloaded,
        total: progress.total,
    };
    if let Err(error) = app.emit(EVENT_UPDATE_PROGRESS, payload) {
        tracing::error!(?error, "failed to emit update progress");
    }
}

fn update_error(
    operation: Operation,
    reason: &'static str,
    retryable: bool,
    version: Option<&str>,
) -> AppError {
    update_error_with_code(
        operation.code(),
        operation,
        reason,
        retryable,
        version,
        None,
    )
}

fn update_error_with_code(
    code: AppErrorCode,
    operation: Operation,
    reason: &'static str,
    retryable: bool,
    version: Option<&str>,
    recovery_path: Option<&std::path::Path>,
) -> AppError {
    let message = match code {
        AppErrorCode::UpdateCheckFailed => "failed to check for updates",
        AppErrorCode::UpdateDownloadFailed => "failed to download the update",
        AppErrorCode::UpdateInstallFailed => "failed to install the update",
        AppErrorCode::UpdateSignatureInvalid => "the update signature is invalid",
        AppErrorCode::UpdateUnsupported => "automatic updates are not supported here",
        _ => "update operation failed",
    };
    let mut details = json!({
        "phase": operation.phase(),
        "reason": reason,
        "retryable": retryable,
    });
    if let Some(version) = version {
        details["version"] = json!(version);
    }
    if let Some(path) = recovery_path {
        details["recoveryPath"] = json!(path.to_string_lossy());
    }
    AppError::new(code, message).with_details(details)
}

fn classify_updater_error(
    error: &UpdaterError,
    operation: Operation,
    version: Option<&str>,
) -> AppError {
    match error {
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => update_error_with_code(
            AppErrorCode::UpdateSignatureInvalid,
            operation,
            "signature",
            false,
            version,
            None,
        ),
        UpdaterError::UnsupportedOs
        | UpdaterError::UnsupportedArch
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_) => update_error_with_code(
            AppErrorCode::UpdateUnsupported,
            operation,
            "platform",
            false,
            version,
            None,
        ),
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) | UpdaterError::ReleaseNotFound => {
            update_error(operation, "network", true, version)
        }
        UpdaterError::EmptyEndpoints
        | UpdaterError::InsecureTransportProtocol
        | UpdaterError::UrlParse(_)
        | UpdaterError::Serialization(_)
        | UpdaterError::Semver(_)
        | UpdaterError::Http(_)
        | UpdaterError::InvalidHeaderValue(_)
        | UpdaterError::InvalidHeaderName(_)
        | UpdaterError::FormatDate => update_error(operation, "config", false, version),
        UpdaterError::Io(_) => update_error(operation, "io", false, version),
        UpdaterError::AuthenticationFailed => {
            update_error(Operation::Install, "authentication", false, version)
        }
        UpdaterError::InvalidUpdaterFormat
        | UpdaterError::BinaryNotFoundInArchive
        | UpdaterError::DebInstallFailed
        | UpdaterError::PackageInstallFailed
        | UpdaterError::TempDirNotFound
        | UpdaterError::TempDirNotOnSameMountPoint
        | UpdaterError::FailedToDetermineExtractPath => {
            update_error(Operation::Install, "format", false, version)
        }
        UpdaterError::PreviousAppNotRestored(path) => update_error_with_code(
            AppErrorCode::UpdateInstallFailed,
            Operation::Install,
            "restore_failed",
            false,
            version,
            Some(path.as_path()),
        ),
        _ => update_error(operation, "unknown", false, version),
    }
}

fn classify_install_error(error: &UpdaterError, version: Option<&str>) -> (AppError, bool) {
    let signature = matches!(
        error,
        UpdaterError::Minisign(_)
            | UpdaterError::Base64(_)
            | UpdaterError::SignatureUtf8(_)
            | UpdaterError::SignedVersionMismatch { .. }
            | UpdaterError::MissingSignedVersion
    );
    let classified = if signature {
        update_error_with_code(
            AppErrorCode::UpdateSignatureInvalid,
            Operation::Install,
            "signature",
            false,
            version,
            None,
        )
    } else {
        classify_updater_error(error, Operation::Install, version)
    };
    (classified, signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(error: &AppError) -> &serde_json::Value {
        error.details.as_ref().expect("update errors carry details")
    }

    #[test]
    fn signature_errors_are_not_retryable_and_clear_the_artifact() {
        let error = classify_updater_error(
            &UpdaterError::SignedVersionMismatch {
                signed: "0.1.0".to_string(),
                announced: "0.2.0".to_string(),
            },
            Operation::Download,
            Some("0.2.0"),
        );
        assert_eq!(error.code, AppErrorCode::UpdateSignatureInvalid);
        assert_eq!(details(&error)["reason"], "signature");
        assert_eq!(details(&error)["retryable"], false);
        assert_eq!(details(&error)["version"], "0.2.0");

        let (error, clear) =
            classify_install_error(&UpdaterError::MissingSignedVersion, Some("0.2.0"));
        assert_eq!(error.code, AppErrorCode::UpdateSignatureInvalid);
        assert!(clear);
    }

    #[test]
    fn network_and_config_errors_keep_the_operation_code() {
        let network = classify_updater_error(
            &UpdaterError::Network("offline".to_string()),
            Operation::Check,
            None,
        );
        assert_eq!(network.code, AppErrorCode::UpdateCheckFailed);
        assert_eq!(details(&network)["reason"], "network");
        assert_eq!(details(&network)["retryable"], true);

        let config = classify_updater_error(&UpdaterError::EmptyEndpoints, Operation::Check, None);
        assert_eq!(config.code, AppErrorCode::UpdateCheckFailed);
        assert_eq!(details(&config)["reason"], "config");
        assert_eq!(details(&config)["retryable"], false);
    }

    #[test]
    fn platform_and_restore_errors_use_stable_codes() {
        let platform =
            classify_updater_error(&UpdaterError::UnsupportedArch, Operation::Check, None);
        assert_eq!(platform.code, AppErrorCode::UpdateUnsupported);
        assert_eq!(details(&platform)["reason"], "platform");

        let restore = classify_updater_error(
            &UpdaterError::PreviousAppNotRestored(std::path::PathBuf::from("/tmp/old.app")),
            Operation::Install,
            Some("0.2.0"),
        );
        assert_eq!(restore.code, AppErrorCode::UpdateInstallFailed);
        assert_eq!(details(&restore)["reason"], "restore_failed");
        assert_eq!(details(&restore)["recoveryPath"], "/tmp/old.app");
    }

    #[test]
    fn generic_error_details_do_not_include_urls_or_paths() {
        let error = update_error(Operation::Download, "timeout", true, Some("0.2.0"));
        let serialized = serde_json::to_string(details(&error)).expect("details must serialize");
        assert!(!serialized.contains("https://"));
        assert!(!serialized.contains("/Users/"));
        assert_eq!(details(&error)["phase"], "download");
        assert_eq!(details(&error)["reason"], "timeout");
        assert_eq!(details(&error)["retryable"], true);
    }
}
