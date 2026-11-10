//! Meeting commands: task lifecycle, configuration, API keys and models.
//!
//! T-007 registered the full surface together with its permission guards and
//! T-008 implements task start/retry/cancel/status/result plus the background
//! transcription runner. Configuration, keys and model management stay stubs
//! for T-010/T-011.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::settings::{ensure_settings_window, open_settings, SETTINGS_WINDOW_LABEL};
use crate::error::{AppError, AppErrorCode};
use crate::ipc::contract::EVENT_MEETING_MODEL_PROGRESS;
use crate::ipc::dto::{
    Accel, AsrBackend, Degraded, DownloadState, KeyStatus, LlmMode, MeetingConfigGetResponse,
    MeetingConfigPatch, MeetingConfigSetResponse, MeetingOutcome, MeetingResult,
    MeetingRetryResponse, MeetingStage, MeetingStartResponse, MeetingStats, ModelDownloadResponse,
    ModelView,
};
use crate::services::meeting::asr::SherpaAsr;
use crate::services::meeting::decode::{decode_windows, ensure_duration, probe_audio};
use crate::services::meeting::download::{self, DiskProbe};
use crate::services::meeting::models::{manifest, ModelCatalog, ModelState};
use crate::services::meeting::pipeline::{exit_for, run_local, StopExit};
use crate::services::meeting::runtime::{self, resolve_models, tier_defaults, HardwareProfile};
use crate::services::meeting::summarize;
use crate::state::meeting::config::MeetingConfigStore;
use crate::state::meeting::downloads::ModelDownloads;
use crate::state::meeting::job::MeetingSource;
use crate::state::meeting::registry::MeetingRegistry;
use crate::state::workspace_registry::WorkspaceToken;
use crate::state::{AssetScope, WindowSessions};

const TRANSCRIBE_DEADLINE_MIN: u64 = 4;
const TRANSCRIBE_DEADLINE_MIN_MS: u64 = TRANSCRIBE_DEADLINE_MIN * 60_000;
const TRANSCRIBE_DEADLINE_MIN_DURATION: u64 = 15 * 60_000;
const TRANSCRIBE_DEADLINE_MAX: u64 = 240 * 60_000;

/// Task and result commands are limited to document windows and the main
/// window; the settings window never starts a meeting.
fn ensure_document_or_main<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    let label = window.label();
    if label == "main" || label.starts_with("doc-") {
        Ok(())
    } else {
        Err(AppError::new(
            AppErrorCode::PermissionDenied,
            "this command is only available to document and main windows",
        ))
    }
}

/// Read-only meeting commands may also run from the settings window.
fn ensure_reading_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    if window.label() == SETTINGS_WINDOW_LABEL {
        return Ok(());
    }
    ensure_document_or_main(window)
}

fn parse_request_id(request_id: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(request_id).map_err(|_| {
        AppError::new(AppErrorCode::InvalidConfig, "requestId must be a UUID")
            .with_details(serde_json::json!({ "field": "request_id" }))
    })
}

async fn pick_audio<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("MEETING_E2E_AUDIO") {
        return Ok(PathBuf::from(path));
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Audio", &["m4a", "mp4", "wav", "mp3", "flac"])
        .pick_file(move |selected| {
            let _ = sender.send(selected);
        });

    let selected = receiver
        .await
        .map_err(|_| AppError::new(AppErrorCode::Cancelled, "audio dialog was closed"))?
        .ok_or_else(|| AppError::new(AppErrorCode::Cancelled, "audio dialog was cancelled"))?;

    selected.into_path().map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("the dialog returned an unreadable path: {error}"),
        )
    })
}

#[tauri::command]
pub async fn meeting_start<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    registry: State<'_, MeetingRegistry>,
    config: State<'_, MeetingConfigStore>,
    assets: State<'_, AssetScope>,
    sessions: State<'_, WindowSessions>,
) -> Result<MeetingStartResponse, AppError> {
    ensure_document_or_main(&window)?;

    let picked = pick_audio(&app).await?;
    let path = tauri::async_runtime::spawn_blocking(move || std::fs::canonicalize(picked))
        .await
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?
        .map_err(|error| AppError::from_io(&error))?;

    let probe_path = path.clone();
    let probe = tauri::async_runtime::spawn_blocking(move || probe_audio(&probe_path))
        .await
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))??;
    ensure_duration(&probe, config.get().config.max_minutes)?;

    let bytes = std::fs::metadata(&path)
        .map_err(|error| AppError::from_io(&error))?
        .len();
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "meeting".to_string());

    let label = format!("doc-{}", Uuid::new_v4());
    let acquired = match assets.acquire(&label, &path) {
        Ok(changed) => changed,
        Err(error) => {
            tracing::warn!(%error, "meeting audio could not enter the asset scope");
            false
        }
    };

    let source = MeetingSource::new(path.clone(), bytes, probe.duration_ms);
    let (id, token) = match registry.begin(source, &label) {
        Ok(started) => started,
        Err(error) => {
            assets.release_by_label(&label);
            return Err(error);
        }
    };
    let _ = registry.set_display_title(id, stem.clone());

    let query = meeting_query(&id, &stem);
    let parent_workspace: Option<WorkspaceToken> = sessions.workspace_for(window.label());
    let created = crate::commands::document::create_untitled_window_with_label(
        app.clone(),
        parent_workspace,
        Some(label.clone()),
        Some(query),
    )
    .await;

    let meeting_window = match created {
        Ok(created) => created,
        Err(error) => {
            registry.cancel_by_label(&label);
            registry.release(id);
            assets.release_by_label(&label);
            return Err(error);
        }
    };

    let app_name = app
        .state::<crate::state::ShellLocale>()
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    if let Err(error) = meeting_window.set_title(
        &crate::commands::document::window_title_for_untitled(&stem, &app_name),
    ) {
        tracing::warn!(%error, "failed to set the meeting window title");
    }

    if acquired {
        match meeting_window.convert_file_src(&path, None) {
            Ok(url) => {
                registry.set_audio_url(id, url);
            }
            Err(error) => {
                tracing::warn!(%error, "failed to convert the meeting audio URL");
                registry.set_audio_url(id, String::new());
            }
        }
    }

    spawn_job(
        app,
        id,
        registry
            .running_source(id)
            .unwrap_or_else(|| MeetingSource::new(path, bytes, probe.duration_ms)),
        token,
    );
    Ok(MeetingStartResponse {
        request_id: id.to_string(),
    })
}

#[tauri::command]
pub fn meeting_retry<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    registry: State<'_, MeetingRegistry>,
    request_id: String,
) -> Result<MeetingRetryResponse, AppError> {
    ensure_document_or_main(&window)?;
    let id = parse_request_id(&request_id)?;
    let (token, attempt) = registry.retry(id, window.label())?;
    let source = registry
        .running_source(id)
        .ok_or_else(|| AppError::new(AppErrorCode::NotFound, "retried job vanished"))?;
    spawn_job(app, id, source, token);
    Ok(MeetingRetryResponse {
        request_id: id.to_string(),
        attempt,
    })
}

#[tauri::command]
pub fn meeting_cancel<R: Runtime>(
    window: WebviewWindow<R>,
    registry: State<'_, MeetingRegistry>,
    request_id: String,
) -> Result<(), AppError> {
    ensure_document_or_main(&window)?;
    registry.cancel(parse_request_id(&request_id)?)
}

#[tauri::command]
pub fn meeting_status<R: Runtime>(
    window: WebviewWindow<R>,
    registry: State<'_, MeetingRegistry>,
    request_id: String,
) -> Result<MeetingOutcome, AppError> {
    ensure_document_or_main(&window)?;
    Ok(registry.status(parse_request_id(&request_id)?))
}

#[tauri::command]
pub fn meeting_take_result<R: Runtime>(
    window: WebviewWindow<R>,
    registry: State<'_, MeetingRegistry>,
    request_id: String,
) -> Result<Option<MeetingResult>, AppError> {
    ensure_document_or_main(&window)?;
    Ok(registry.take_result(parse_request_id(&request_id)?))
}

/// Query suffix appended to the document URL for a meeting window.
pub fn meeting_query(id: &Uuid, stem: &str) -> String {
    format!(
        "&meeting={id}&name={}",
        utf8_percent_encode(stem, NON_ALPHANUMERIC)
    )
}

fn spawn_job<R: Runtime>(
    app: AppHandle<R>,
    id: Uuid,
    source: MeetingSource,
    token: CancellationToken,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<MeetingRegistry>();
        let result = transcribe(&app, &registry, id, &source, &token);
        let label = registry.running_label(id);
        let Some(label) = label else {
            return;
        };
        match result {
            Ok(result) => {
                if let Some(snapshot) = registry.finish(id, result) {
                    registry.emit_progress(&label, &snapshot);
                }
            }
            Err(error) => {
                if error.code != AppErrorCode::Cancelled {
                    // `fail` only accepts Preparing or Releasing. An error
                    // after Transcribing must enter Releasing first.
                    let _ = registry.advance(id, MeetingStage::Releasing);
                }
                if let Some(snapshot) = registry.fail(id, error) {
                    registry.emit_progress(&label, &snapshot);
                }
            }
        }
    });
}

fn transcribe<R: Runtime>(
    app: &AppHandle<R>,
    registry: &MeetingRegistry,
    id: Uuid,
    source: &MeetingSource,
    token: &CancellationToken,
) -> Result<MeetingResult, AppError> {
    if token.is_cancelled() {
        return Err(AppError::new(AppErrorCode::Cancelled, "meeting cancelled"));
    }

    let config = app.state::<MeetingConfigStore>().get().config;
    let profile = HardwareProfile::detect();
    let resolved = resolve_models(config.asr.local_model.as_deref(), None, &profile)?;
    let defaults = tier_defaults(&profile);
    let catalog = app.state::<Arc<dyn ModelCatalog>>();
    let asr_id = resolved.asr;

    match catalog.state(asr_id) {
        ModelState::Ready => {}
        state => {
            return Err(AppError::new(
                AppErrorCode::ModelNotReady,
                format!("{} is {:?}", asr_id, state),
            )
            .with_details(serde_json::json!({ "model_id": asr_id, "state": format!("{state:?}").to_lowercase() })));
        }
    }

    let path = source.path.clone();
    registry.advance_checked(id, MeetingStage::Transcribing)?;
    let _ = registry.set_backend(id, AsrBackend::Local);
    registry.set_local_model(id, asr_id)?;
    let accel = match defaults.accel {
        runtime::Accel::Cpu => Accel::Cpu,
        runtime::Accel::Metal => Accel::Metal,
    };
    registry.set_accel(id, accel)?;
    let llm_mode = match config.llm.mode {
        summarize::LlmMode::Local => LlmMode::Local,
        summarize::LlmMode::Remote => LlmMode::Remote,
    };
    let _ = registry.set_llm_mode(id, llm_mode);

    let asr_dir = catalog
        .path(asr_id)
        .ok_or_else(|| AppError::new(AppErrorCode::ModelNotReady, "unknown ASR model"))?;
    let mut asr = SherpaAsr::open(asr_id, &asr_dir, defaults.threads)?;
    let vad_model = (catalog.state("silero-vad") == ModelState::Ready)
        .then(|| catalog.path("silero-vad"))
        .flatten();

    let deadline = Instant::now()
        + Duration::from_millis(
            (source
                .duration_ms
                .saturating_mul(TRANSCRIBE_DEADLINE_MIN_MS)
                / 60_000)
                .clamp(TRANSCRIBE_DEADLINE_MIN_DURATION, TRANSCRIBE_DEADLINE_MAX),
        );
    let windows = decode_windows(&path, token.clone())?;
    let outcome = run_local(
        windows,
        vad_model.as_deref(),
        &mut asr,
        token,
        Some(deadline),
    )?;

    let available = outcome.available();
    let total = outcome.segments.len();
    let (exit, partial) = exit_for(outcome.stop_reason, total, available);
    let label = registry.running_label(id).unwrap_or_default();
    let _ = registry.set_failed_segments(id, outcome.failed_segments as u32);
    let _ = registry.set_stop_reason(id, outcome.stop_reason);
    let _ = registry.set_exit(id, exit);
    if partial {
        let _ = registry.set_partial(id, true);
    }
    if outcome.partial_decode || outcome.partial_until_ms.is_some() {
        let _ = registry.degrade(
            id,
            Degraded {
                partial_decode: outcome.partial_decode,
                partial_until_ms: outcome.partial_until_ms,
                ..Degraded::default()
            },
        );
    }
    registry.advance_checked(id, MeetingStage::Releasing)?;

    if exit == StopExit::Failed {
        return Err(AppError::new(
            AppErrorCode::AsrFailed,
            "all speech segments failed",
        ));
    }

    registry.advance_checked(id, MeetingStage::Rendering)?;
    let markdown = render_markdown(&label, source, &outcome, partial);
    Ok(MeetingResult {
        markdown,
        audio_url: String::new(),
        title: String::new(),
        duration_ms: source.duration_ms,
        stats: MeetingStats {
            failed_segments: outcome.failed_segments as u32,
            ..MeetingStats::default()
        },
        partial,
    })
}

fn render_markdown(
    _label: &str,
    source: &MeetingSource,
    outcome: &crate::services::meeting::pipeline::PipelineOutcome,
    partial: bool,
) -> String {
    let mut markdown = String::new();
    markdown.push_str("# 会议纪要\n\n");
    markdown.push_str(&format!("> 由青墨自动转写 · {}", source.display_name()));
    markdown.push_str("\n\n");
    if partial {
        if let Some(until) = outcome.partial_until_ms {
            markdown.push_str(&format!("> 只转写了前 {}。\n\n", format_ms(until)));
        } else {
            markdown.push_str("> 转写不完整。\n\n");
        }
    }
    markdown.push_str("## 转录\n\n");
    for segment in &outcome.segments {
        if !matches!(
            segment.status,
            crate::services::meeting::asr::SegmentStatus::Ok
        ) || segment.text.is_empty()
        {
            markdown.push_str(&format!("- [{}] [识别失败]\n", format_ms(segment.start_ms)));
            continue;
        }
        let speaker = segment
            .speaker
            .map(|speaker| format!("说话人 {}：", u16::from(speaker) + 1))
            .unwrap_or_default();
        markdown.push_str(&format!(
            "- [{}] {}{}\n",
            format_ms(segment.start_ms),
            speaker,
            segment.text
        ));
    }
    markdown
}

fn format_ms(ms: u64) -> String {
    let total = ms / 1000;
    let minutes = total / 60;
    let seconds = total % 60;
    if minutes >= 60 {
        format!("{:02}:{:02}:{:02}", minutes / 60, minutes % 60, seconds)
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

// ---------------------------------------------------------------------------
// Configuration, keys and models (T-010/T-011)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn meeting_config_get<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<MeetingConfigGetResponse, AppError> {
    ensure_reading_window(&window)?;
    Err(AppError::not_implemented("meeting_config_get"))
}

#[tauri::command]
pub fn meeting_config_set<R: Runtime>(
    window: WebviewWindow<R>,
    patch: MeetingConfigPatch,
    expected_revision: u64,
) -> Result<MeetingConfigSetResponse, AppError> {
    ensure_settings_window(&window)?;
    let _ = (patch, expected_revision);
    Err(AppError::not_implemented("meeting_config_set"))
}

#[tauri::command]
pub fn meeting_key_status<R: Runtime>(
    window: WebviewWindow<R>,
    slot: String,
) -> Result<KeyStatus, AppError> {
    ensure_settings_window(&window)?;
    let _ = slot;
    Err(AppError::not_implemented("meeting_key_status"))
}

#[tauri::command]
pub fn meeting_key_set<R: Runtime>(
    window: WebviewWindow<R>,
    slot: String,
    value: String,
) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    let _ = (slot, value);
    Err(AppError::not_implemented("meeting_key_set"))
}

#[tauri::command]
pub fn meeting_key_clear<R: Runtime>(
    window: WebviewWindow<R>,
    slot: String,
    all: Option<bool>,
) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    let _ = (slot, all);
    Err(AppError::not_implemented("meeting_key_clear"))
}

#[tauri::command]
pub fn meeting_models_list<R: Runtime>(
    window: WebviewWindow<R>,
    catalog: State<'_, Arc<dyn ModelCatalog>>,
    downloads: State<'_, Arc<ModelDownloads>>,
) -> Result<Vec<ModelView>, AppError> {
    ensure_reading_window(&window)?;
    let mut views = Vec::with_capacity(manifest().len());
    for pack in manifest() {
        let overlay = downloads.overlay(pack.id);
        let error = overlay.as_ref().and_then(|(_, error)| error.clone());
        let state =
            overlay
                .map(|(state, _)| state)
                .unwrap_or_else(|| match catalog.state(pack.id) {
                    ModelState::Ready => crate::ipc::dto::ModelState::Ready,
                    ModelState::NotVerified => crate::ipc::dto::ModelState::NotVerified,
                    ModelState::NotDownloaded => crate::ipc::dto::ModelState::NotDownloaded,
                    ModelState::Partial => crate::ipc::dto::ModelState::Partial,
                    ModelState::Missing => crate::ipc::dto::ModelState::Missing,
                    ModelState::Verifying => crate::ipc::dto::ModelState::Verifying,
                    ModelState::Downloading => crate::ipc::dto::ModelState::Downloading,
                    ModelState::Corrupt => crate::ipc::dto::ModelState::Corrupt,
                    ModelState::Failed => crate::ipc::dto::ModelState::Failed,
                });
        let path = catalog.path(pack.id);
        let local_bytes = path
            .as_deref()
            .and_then(|dir| std::fs::read_dir(dir).ok())
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| entry.metadata().ok())
                    .filter(|meta| meta.is_file())
                    .map(|meta| meta.len())
                    .sum()
            })
            .unwrap_or(0);
        views.push(ModelView {
            id: pack.id.to_owned(),
            display: pack.display.to_owned(),
            kind: match pack.kind {
                crate::services::meeting::models::ModelKind::Asr => crate::ipc::dto::ModelKind::Asr,
                crate::services::meeting::models::ModelKind::Segmentation => {
                    crate::ipc::dto::ModelKind::Segmentation
                }
                crate::services::meeting::models::ModelKind::Embedding => {
                    crate::ipc::dto::ModelKind::Embedding
                }
                crate::services::meeting::models::ModelKind::Vad => crate::ipc::dto::ModelKind::Vad,
                crate::services::meeting::models::ModelKind::Llm => crate::ipc::dto::ModelKind::Llm,
            },
            family: pack.family.map(|family| match family {
                crate::services::meeting::models::AsrFamily::Paraformer => {
                    crate::ipc::dto::AsrFamily::Paraformer
                }
                crate::services::meeting::models::AsrFamily::SenseVoice => {
                    crate::ipc::dto::AsrFamily::SenseVoice
                }
                crate::services::meeting::models::AsrFamily::ZipformerTransducer => {
                    crate::ipc::dto::AsrFamily::ZipformerTransducer
                }
                crate::services::meeting::models::AsrFamily::FireRedCtc => {
                    crate::ipc::dto::AsrFamily::FireRedCtc
                }
            }),
            license: pack.license.as_str().to_owned(),
            license_url: pack.license_url.to_owned(),
            languages: pack
                .languages
                .iter()
                .map(|language| language.as_str().to_owned())
                .collect(),
            download_bytes: pack.download_bytes,
            install_bytes: pack.install_bytes,
            local_bytes,
            peak_memory_mb: pack.peak_memory_mb,
            peak_basis: match pack.peak_basis {
                crate::services::meeting::models::PeakBasis::MeasuredRss => {
                    crate::ipc::dto::PeakBasis::MeasuredRss
                }
                crate::services::meeting::models::PeakBasis::Estimated => {
                    crate::ipc::dto::PeakBasis::Estimated
                }
            },
            group: pack.group.map(str::to_owned),
            state,
            path: path.map(|path| path.to_string_lossy().into_owned()),
            error,
        });
    }
    Ok(views)
}

#[tauri::command]
pub fn meeting_model_download<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    catalog: State<'_, Arc<dyn ModelCatalog>>,
    downloads: State<'_, Arc<ModelDownloads>>,
    disk: State<'_, Arc<dyn DiskProbe>>,
    id: String,
) -> Result<ModelDownloadResponse, AppError> {
    ensure_reading_window(&window)?;
    let pack = crate::services::meeting::models::find(&id)
        .ok_or_else(|| AppError::new(AppErrorCode::ModelNotReady, "unknown model id"))?;
    download::ensure_space(disk.inner().as_ref(), catalog.root(), pack)?;
    let (download_id, token) = downloads.begin(pack.id, pack.download_bytes)?;
    let app_for_worker = app.clone();
    let root = catalog.root().to_path_buf();
    let downloads_for_worker = Arc::clone(downloads.inner());
    tauri::async_runtime::spawn_blocking(move || {
        downloads_for_worker.start(download_id);
        emit_model_progress(&app_for_worker, downloads_for_worker.as_ref(), download_id);
        let mut last_emit = Instant::now();
        let result = {
            let mut report = |done: u64, state: DownloadState| {
                downloads_for_worker.set_progress(download_id, done, pack.download_bytes);
                if state == DownloadState::Verifying {
                    downloads_for_worker.verifying(download_id);
                }
                if state == DownloadState::Verifying
                    || last_emit.elapsed() >= Duration::from_millis(250)
                {
                    last_emit = Instant::now();
                    emit_model_progress(
                        &app_for_worker,
                        downloads_for_worker.as_ref(),
                        download_id,
                    );
                }
            };
            download::run(&root, pack, download_id, &token, &mut report)
        };
        match result {
            Ok(()) => {
                downloads_for_worker.done(download_id);
                emit_model_progress(&app_for_worker, downloads_for_worker.as_ref(), download_id);
            }
            Err(error) => {
                downloads_for_worker.fail(download_id, error);
                emit_model_progress(&app_for_worker, downloads_for_worker.as_ref(), download_id);
            }
        }
    });
    Ok(ModelDownloadResponse {
        download_id: download_id.to_string(),
    })
}

fn emit_model_progress<R: Runtime>(
    app: &AppHandle<R>,
    downloads: &ModelDownloads,
    download_id: Uuid,
) {
    if let Some(progress) = downloads.snapshot(download_id) {
        if let Err(error) = app.emit(EVENT_MEETING_MODEL_PROGRESS, progress) {
            tracing::warn!(%error, "failed to emit model download progress");
        }
    }
}

#[tauri::command]
pub fn meeting_model_download_cancel<R: Runtime>(
    window: WebviewWindow<R>,
    downloads: State<'_, Arc<ModelDownloads>>,
    download_id: String,
) -> Result<(), AppError> {
    ensure_reading_window(&window)?;
    let id = Uuid::parse_str(&download_id).map_err(|_| {
        AppError::new(AppErrorCode::InvalidConfig, "downloadId must be a UUID")
            .with_details(serde_json::json!({ "field": "download_id" }))
    })?;
    downloads.cancel(id)
}

#[tauri::command]
pub fn meeting_model_remove<R: Runtime>(
    window: WebviewWindow<R>,
    catalog: State<'_, Arc<dyn ModelCatalog>>,
    downloads: State<'_, Arc<ModelDownloads>>,
    config: State<'_, MeetingConfigStore>,
    id: String,
) -> Result<(), AppError> {
    ensure_reading_window(&window)?;
    let Some(path) = catalog.path(&id) else {
        return Err(AppError::new(
            AppErrorCode::ModelNotReady,
            "unknown model id",
        ));
    };
    let not_downloaded = || {
        AppError::new(AppErrorCode::ModelNotReady, "model is not downloaded")
            .with_details(serde_json::json!({ "model_id": id }))
    };
    if !path.is_dir() {
        return Err(not_downloaded());
    }
    downloads.cancel_and_wait(&id, Duration::from_secs(5));
    std::fs::remove_dir_all(&path).map_err(|error| AppError::from_io(&error))?;
    download::remove_staging(catalog.root(), &id);
    config.clear_local_model(&id)?;
    Ok(())
}

/// Opens (or focuses) Settings. When the window is already open, `section`
/// navigates it to the matching deep link first.
#[tauri::command]
pub fn app_settings_open<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    section: Option<String>,
) -> Result<(), AppError> {
    ensure_reading_window(&window)?;
    let section = match section.as_deref() {
        None | Some("ai") => section,
        Some(other) => {
            return Err(AppError::new(
                AppErrorCode::InvalidConfig,
                format!("unknown settings section: {other}"),
            ))
        }
    };
    let already_open = app.get_webview_window(SETTINGS_WINDOW_LABEL).is_some();
    open_settings(&app)?;
    if let (true, Some(section)) = (already_open, section) {
        if let Some(settings) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
            if let Err(error) = settings.eval(format!(
                "window.location.assign('settings.html?section={section}')"
            )) {
                tracing::warn!(%error, "failed to navigate the settings window");
            }
            if let Err(error) = settings.set_focus() {
                tracing::warn!(%error, "failed to focus the settings window");
            }
        }
    }
    Ok(())
}
