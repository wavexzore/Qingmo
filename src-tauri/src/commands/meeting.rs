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
    Accel, AsrBackend, AsrConfigView, AsrMode, Degraded, DiskStatus, DownloadState, KeyStatus,
    LlmConfigView, LlmMode, MeetingConfigGetResponse, MeetingConfigPatch, MeetingConfigSetResponse,
    MeetingConfigView, MeetingOutcome, MeetingResult, MeetingRetryResponse, MeetingStage,
    MeetingStartResponse, MeetingStats, ModelDownloadResponse, ModelOrigin, ModelView,
    ResolvedModelsView, RuntimeMode, RuntimeNote, RuntimePreview, RuntimeView, TierDefaultsView,
};
use crate::services::meeting::asr::SherpaAsr;
use crate::services::meeting::budget;
use crate::services::meeting::decode::{
    decode_windows, ensure_duration, probe_audio, window_total,
};
use crate::services::meeting::diarize::{self, SherpaDiarizer};
use crate::services::meeting::download::{self, DiskProbe};
use crate::services::meeting::keys::KeyService;
use crate::services::meeting::lang::detect_language;
use crate::services::meeting::models::{find, manifest, ModelCatalog, ModelPack, ModelState};
use crate::services::meeting::pipeline::{
    exit_for, run_local_with_progress, run_remote, run_remote_with_fallback_diarized, StopExit,
};
use crate::services::meeting::remote_asr::{HttpRemoteAsr, RemoteAsrConfig};
use crate::services::meeting::render::{self, RenderInput};
use crate::services::meeting::runtime::{
    self, resolve_models, tier_defaults, HardwareProfile, MemoryProbe, Origin, SystemMemory,
};
use crate::services::meeting::speaker::DiarizationEngine;
use crate::services::meeting::summarize::{self, DefaultLlmFactory, RemoteLlmSpec, SummarizePlan};
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
    if let Some(path) = crate::services::meeting::e2e::var("MEETING_E2E_AUDIO")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
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

/// Remote failure with no local fallback gets the documented recovery code.
pub fn remote_failed(error: AppError, local_missing: bool) -> AppError {
    if !local_missing || error.code == AppErrorCode::Cancelled {
        return error;
    }
    let reason = error
        .details
        .as_ref()
        .and_then(|details| details.get("reason"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!("remote_failed"));
    AppError::new(
        AppErrorCode::AsrFailed,
        "remote ASR failed and no local model is ready",
    )
    .with_details(serde_json::json!({ "reason": reason, "fallback_unavailable": true }))
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
    let llm_local = config.llm.mode == summarize::LlmMode::Local;
    // A pinned summary model is irrelevant while remote summaries are chosen;
    // rejecting it would block a machine that only has the local ASR pack.
    let resolved = resolve_models(
        config.asr.local_model.as_deref(),
        llm_local
            .then_some(config.llm.local_model.as_deref())
            .flatten(),
        &profile,
    )?;
    let defaults = tier_defaults(&profile);
    let catalog = app.state::<Arc<dyn ModelCatalog>>();
    let asr_id = resolved.asr;

    let local_ready = catalog.state(asr_id) == ModelState::Ready;
    let keys = app.state::<Arc<KeyService>>();
    let asr_key = resolve_key(&config.asr.api_key, keys.inner(), &config.asr_key_ref());
    let route = crate::services::meeting::asr_route::decide(
        config.asr.mode,
        asr_key.is_some(),
        local_ready,
    )?;
    if route.remote_key_missing {
        let _ = registry.degrade(
            id,
            Degraded {
                remote_key_missing: true,
                ..Degraded::default()
            },
        );
    }
    if local_ready {
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
    }

    let path = source.path.clone();
    registry.advance_checked(id, MeetingStage::Transcribing)?;
    let backend = match route.kind {
        crate::services::meeting::asr_route::RouteKind::Local => AsrBackend::Local,
        crate::services::meeting::asr_route::RouteKind::Remote => {
            AsrBackend::Remote(provider_view(config.asr.provider))
        }
    };
    let _ = registry.set_backend(id, backend);
    registry.set_local_model(id, asr_id)?;
    let cpu_only = config.runtime.mode == crate::state::meeting::config::RuntimeMode::Cpu;
    let runtime_accel = if cpu_only {
        runtime::Accel::Cpu
    } else {
        defaults.accel
    };
    let accel = match runtime_accel {
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
    let mut local_asr = local_ready
        .then(|| SherpaAsr::open(asr_id, &asr_dir, defaults.threads))
        .transpose()?;
    let vad_model = (catalog.state("silero-vad") == ModelState::Ready)
        .then(|| catalog.model_file("silero-vad"))
        .flatten();

    let deadline = Instant::now()
        + Duration::from_millis(
            (source
                .duration_ms
                .saturating_mul(TRANSCRIBE_DEADLINE_MIN_MS)
                / 60_000)
                .clamp(TRANSCRIBE_DEADLINE_MIN_DURATION, TRANSCRIBE_DEADLINE_MAX),
        );
    let speaker_models = diarize::models_from_catalog(catalog.inner().as_ref());
    let mut diarizer = speaker_models
        .as_ref()
        .and_then(|models| SherpaDiarizer::new(models).ok());
    let mut outcome = match route.kind {
        crate::services::meeting::asr_route::RouteKind::Local => {
            let asr = local_asr.as_mut().ok_or_else(|| {
                AppError::new(AppErrorCode::ModelNotReady, "local ASR is not ready")
            })?;
            let total_windows = window_total(source.duration_ms);
            run_local_with_progress(
                decode_windows(&path, token.clone())?,
                vad_model.as_deref(),
                asr,
                diarizer
                    .as_mut()
                    .map(|diarizer| diarizer as &mut dyn DiarizationEngine),
                token,
                Some(deadline),
                total_windows,
                &mut |window| {
                    registry.set_window(id, Some(window));
                },
            )?
        }
        crate::services::meeting::asr_route::RouteKind::Remote => {
            let key = asr_key.ok_or_else(|| {
                AppError::new(AppErrorCode::InvalidConfig, "remote ASR key is missing")
            })?;
            let mut remote = HttpRemoteAsr::new(RemoteAsrConfig::new(
                config.asr.provider,
                config.asr.model.clone(),
                key,
            ))?;
            let local_missing = local_asr.is_none();
            let outcome = match (local_asr.as_mut(), diarizer.as_mut()) {
                (Some(asr), diarizer) => run_remote_with_fallback_diarized(
                    &path,
                    &mut remote,
                    asr,
                    vad_model.as_deref(),
                    diarizer.map(|diarizer| diarizer as &mut dyn DiarizationEngine),
                    token,
                    Some(deadline),
                )
                .map_err(|error| remote_failed(error, local_missing))?,
                (None, _) => run_remote(
                    decode_windows(&path, token.clone())?,
                    &mut remote,
                    token,
                    Some(deadline),
                )
                .map_err(|error| remote_failed(error, local_missing))?,
            };
            outcome
        }
    };
    outcome.remote_key_missing = route.remote_key_missing;
    let _ = registry.set_backend(
        id,
        match outcome.actual_backend {
            crate::services::meeting::pipeline::ActualBackend::Local => AsrBackend::Local,
            crate::services::meeting::pipeline::ActualBackend::Remote => {
                AsrBackend::Remote(provider_view(config.asr.provider))
            }
        },
    );

    let available = outcome.available();
    let total = outcome.segments.len();
    let (exit, partial) = exit_for(outcome.stop_reason, total, available);
    let _ = registry.set_failed_segments(id, outcome.failed_segments as u32);
    let _ = registry.set_stop_reason(id, outcome.stop_reason);
    let _ = registry.set_exit(id, exit);
    if partial {
        let _ = registry.set_partial(id, true);
    }
    if outcome.partial_decode
        || outcome.partial_until_ms.is_some()
        || outcome.speaker_degraded
        || outcome.speaker_partial
    {
        let _ = registry.degrade(
            id,
            Degraded {
                partial_decode: outcome.partial_decode,
                partial_until_ms: outcome.partial_until_ms,
                speaker_degraded: outcome.speaker_degraded,
                speaker_partial: outcome.speaker_partial,
                ..Degraded::default()
            },
        );
    }
    if let Some(count) = outcome.speaker_count {
        let _ = registry.set_speaker_count(id, count);
    }
    registry.advance_checked(id, MeetingStage::Releasing)?;

    if exit == StopExit::Failed {
        return Err(AppError::new(
            AppErrorCode::AsrFailed,
            "all speech segments failed",
        ));
    }

    let transcript_text = outcome
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<String>();
    let language = detect_language(&transcript_text);
    let stem = source
        .path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "会议纪要".to_owned());

    // ASR and diarization sessions are done; release them before the summary
    // model is loaded and re-sample the live memory instead of the value from
    // before ASR.
    drop(local_asr);
    drop(diarizer);
    let available_memory_mb = SystemMemory.available_mb();

    let llm_mode = config.llm.mode;
    let local_model = (llm_mode == summarize::LlmMode::Local).then_some(resolved.llm);
    let local_ready = local_model.is_some_and(|id| catalog.state(id) == ModelState::Ready);
    let local_path = local_model
        .and_then(|id| catalog.model_file(id))
        .filter(|_| local_ready);
    let keys = app.state::<Arc<KeyService>>();
    let remote = (llm_mode == summarize::LlmMode::Remote).then(|| RemoteLlmSpec {
        base_url: config.llm.base_url.clone(),
        model: config.llm.model.clone(),
        api_key: resolve_key(&config.llm.api_key, keys.inner(), &config.llm_key_ref()),
    });
    let plan = SummarizePlan {
        mode: llm_mode,
        local_model: local_model.map(str::to_owned),
        local_path,
        local_ready,
        remote,
        available_memory_mb,
        threads: defaults.threads,
        accel: runtime_accel,
    };
    registry.advance_checked(id, MeetingStage::Summarizing)?;
    let summary_deadline = Instant::now() + summarize::SUMMARY_DEADLINE;
    let summary_outcome = summarize::summarize(
        &outcome.segments,
        language,
        &plan,
        &DefaultLlmFactory,
        token,
        Some(summary_deadline),
    )?;
    if token.is_cancelled() {
        return Err(AppError::new(AppErrorCode::Cancelled, "meeting cancelled"));
    }
    if summary_outcome.llm_model_missing
        || summary_outcome.llm_unconfigured
        || summary_outcome.llm_budget_exceeded
    {
        let _ = registry.degrade(
            id,
            Degraded {
                llm_model_missing: summary_outcome.llm_model_missing,
                llm_unconfigured: summary_outcome.llm_unconfigured,
                llm_budget_exceeded: summary_outcome.llm_budget_exceeded,
                ..Degraded::default()
            },
        );
    }
    let stats = card_stats(&summary_outcome.cards, summary_outcome.unverified, &outcome);
    registry.advance_checked(id, MeetingStage::Rendering)?;
    let degraded = Degraded {
        partial_decode: outcome.partial_decode,
        partial_until_ms: outcome.partial_until_ms,
        remote_fallback: outcome.remote_fallback,
        remote_last_error: outcome.remote_last_error.map(reason_view),
        remote_key_missing: outcome.remote_key_missing,
        speaker_degraded: outcome.speaker_degraded,
        speaker_partial: outcome.speaker_partial,
        llm_model_missing: summary_outcome.llm_model_missing,
        llm_unconfigured: summary_outcome.llm_unconfigured,
        llm_budget_exceeded: summary_outcome.llm_budget_exceeded,
        llm_failed: summary_outcome.last_error.is_some()
            || summary_outcome.llm_load_failed
            || summary_outcome.deadline_exceeded,
        high_memory_model: high_memory_model(&profile, asr_id),
        ..Degraded::default()
    };
    let markdown = render::render(RenderInput {
        title: &stem,
        language,
        actual_backend: match outcome.actual_backend {
            crate::services::meeting::pipeline::ActualBackend::Local => AsrBackend::Local,
            crate::services::meeting::pipeline::ActualBackend::Remote => {
                AsrBackend::Remote(provider_view(config.asr.provider))
            }
        },
        local_model: Some(asr_id),
        speaker_count: outcome.speaker_count,
        stats,
        segments: &outcome.segments,
        cards: &summary_outcome.cards,
        degraded,
        keep_transcript: config.keep_transcript,
    });
    Ok(MeetingResult {
        markdown,
        audio_url: String::new(),
        title: String::new(),
        duration_ms: source.duration_ms,
        stats,
        partial,
    })
}

// ---------------------------------------------------------------------------
// Configuration, keys and models (T-010/T-011)
// ---------------------------------------------------------------------------

fn card_stats(
    cards: &[crate::services::meeting::cards::Card],
    unverified: u32,
    outcome: &crate::services::meeting::pipeline::PipelineOutcome,
) -> MeetingStats {
    use crate::services::meeting::cards::CardKind;
    MeetingStats {
        decisions: cards
            .iter()
            .filter(|card| card.kind == CardKind::Decision)
            .count() as u32,
        actions: cards
            .iter()
            .filter(|card| card.kind == CardKind::Action)
            .count() as u32,
        risks: cards
            .iter()
            .filter(|card| card.kind == CardKind::Risk)
            .count() as u32,
        unverified,
        failed_segments: outcome.failed_segments as u32,
    }
}

fn provider_view(
    provider: crate::services::meeting::remote_asr::RemoteProvider,
) -> crate::ipc::dto::RemoteProvider {
    match provider {
        crate::services::meeting::remote_asr::RemoteProvider::OpenAi => {
            crate::ipc::dto::RemoteProvider::OpenAi
        }
        crate::services::meeting::remote_asr::RemoteProvider::Groq => {
            crate::ipc::dto::RemoteProvider::Groq
        }
        crate::services::meeting::remote_asr::RemoteProvider::Deepgram => {
            crate::ipc::dto::RemoteProvider::Deepgram
        }
    }
}

fn reason_view(
    reason: crate::services::meeting::runtime::ReasonCode,
) -> crate::ipc::dto::ReasonCode {
    use crate::services::meeting::runtime::ReasonCode;
    match reason {
        ReasonCode::RemoteAuth => crate::ipc::dto::ReasonCode::RemoteAuth,
        ReasonCode::RemoteQuota => crate::ipc::dto::ReasonCode::RemoteQuota,
        ReasonCode::RemoteKeyMissing => crate::ipc::dto::ReasonCode::RemoteKeyMissing,
        ReasonCode::RemoteResponseTooLarge => crate::ipc::dto::ReasonCode::RemoteResponseTooLarge,
        ReasonCode::FallbackUnavailable => crate::ipc::dto::ReasonCode::FallbackUnavailable,
        ReasonCode::DiskFull => crate::ipc::dto::ReasonCode::DiskFull,
        ReasonCode::ArchiveBomb => crate::ipc::dto::ReasonCode::ArchiveBomb,
        ReasonCode::ArchiveEscape => crate::ipc::dto::ReasonCode::ArchiveEscape,
        ReasonCode::MemoryBudget => crate::ipc::dto::ReasonCode::MemoryBudget,
        ReasonCode::ModelUnsupported => crate::ipc::dto::ReasonCode::ModelUnsupported,
        ReasonCode::ConfigRevision => crate::ipc::dto::ReasonCode::ConfigRevision,
        ReasonCode::KeyringUnavailable => crate::ipc::dto::ReasonCode::KeyringUnavailable,
    }
}

fn high_memory_model(profile: &HardwareProfile, id: &str) -> bool {
    profile.total_memory_mb <= 8 * 1024 && find(id).is_some_and(|pack| pack.peak_memory_mb >= 1_400)
}

fn resolve_key(stored: &str, keys: &KeyService, reference: &str) -> Option<String> {
    let stored = stored.trim();
    if stored.is_empty() {
        keys.get(reference)
    } else {
        Some(stored.to_owned())
    }
}

fn resolve_status(stored: &str, keys: &KeyService, reference: &str) -> KeyStatus {
    if stored.trim().is_empty() {
        keys.status(reference)
    } else {
        KeyStatus::Present
    }
}

fn key_slot(config: &crate::state::meeting::MeetingConfig, slot: &str) -> Result<String, AppError> {
    match slot {
        "asr" => Ok(config.asr_key_ref()),
        "llm" => Ok(config.llm_key_ref()),
        _ => Err(AppError::new(
            AppErrorCode::InvalidConfig,
            format!("unknown key slot: {slot}"),
        )
        .with_details(serde_json::json!({ "field": "slot" }))),
    }
}

/// Missing members of the first-use transcription set, in enqueue order.
fn transcription_gaps(
    config: &crate::state::meeting::MeetingConfig,
    catalog: &dyn ModelCatalog,
    profile: &HardwareProfile,
) -> Vec<&'static ModelPack> {
    let defaults = tier_defaults(profile);
    let resolved = resolve_models(
        config.asr.local_model.as_deref(),
        config.llm.local_model.as_deref(),
        profile,
    )
    .ok()
    .map(|resolved| resolved.asr);
    let mut ids: Vec<&'static str> = vec![defaults.asr_model];
    if let Some(selected) = config.asr.local_model.as_deref().and_then(find) {
        ids.push(selected.id);
    }
    if let Some(resolved) = resolved {
        ids.push(resolved);
    }
    ids.extend([
        "silero-vad",
        "pyannote-segmentation-3-int8",
        "campplus-zh-en-advanced",
    ]);
    let mut unique: Vec<&'static str> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    unique
        .into_iter()
        .filter(|id| catalog.state(id) != ModelState::Ready)
        .filter_map(find)
        .collect()
}

fn required_bytes(packs: &[&ModelPack]) -> u64 {
    packs.iter().fold(0u64, |total, pack| {
        total.saturating_add(download::required_bytes(
            pack.download_bytes,
            pack.install_bytes,
        ))
    })
}

#[tauri::command]
pub fn meeting_config_get<R: Runtime>(
    window: WebviewWindow<R>,
    catalog: State<'_, Arc<dyn ModelCatalog>>,
    config: State<'_, MeetingConfigStore>,
    keys: State<'_, Arc<KeyService>>,
    disk: State<'_, Arc<dyn DiskProbe>>,
) -> Result<MeetingConfigGetResponse, AppError> {
    ensure_reading_window(&window)?;
    let snapshot = config.get();
    let profile = HardwareProfile::detect();
    let defaults = tier_defaults(&profile);
    let resolved = resolve_models(
        snapshot.config.asr.local_model.as_deref(),
        snapshot.config.llm.local_model.as_deref(),
        &profile,
    );
    let (resolved_view, unsupported) = match resolved {
        Ok(resolved) => (
            Some(ResolvedModelsView {
                asr: resolved.asr.to_owned(),
                llm: resolved.llm.to_owned(),
                asr_origin: match resolved.asr_origin {
                    Origin::Auto => ModelOrigin::Auto,
                    Origin::Pinned => ModelOrigin::Pinned,
                },
                llm_origin: match resolved.llm_origin {
                    Origin::Auto => ModelOrigin::Auto,
                    Origin::Pinned => ModelOrigin::Pinned,
                },
            }),
            None,
        ),
        Err(_) => (None, Some(crate::ipc::dto::ReasonCode::ModelUnsupported)),
    };
    let asr_gaps = transcription_gaps(&snapshot.config, catalog.inner().as_ref(), &profile);
    let llm_gaps: Vec<&'static ModelPack> = resolved_view
        .as_ref()
        .and_then(|resolved| find(&resolved.llm))
        .filter(|pack| catalog.state(pack.id) != ModelState::Ready)
        .into_iter()
        .collect();
    let free_bytes = disk.free_bytes(catalog.root()).unwrap_or(0);
    Ok(MeetingConfigGetResponse {
        config: MeetingConfigView {
            runtime: RuntimeView {
                mode: match snapshot.config.runtime.mode {
                    crate::state::meeting::RuntimeMode::Auto => RuntimeMode::Auto,
                    crate::state::meeting::RuntimeMode::Cpu => RuntimeMode::Cpu,
                },
            },
            asr: AsrConfigView {
                mode: match snapshot.config.asr.mode {
                    crate::services::meeting::asr_route::AsrMode::Local => AsrMode::Local,
                    crate::services::meeting::asr_route::AsrMode::Remote => AsrMode::Remote,
                },
                local_model: snapshot.config.asr.local_model.clone(),
                provider: match snapshot.config.asr.provider {
                    crate::services::meeting::remote_asr::RemoteProvider::OpenAi => {
                        crate::ipc::dto::RemoteProvider::OpenAi
                    }
                    crate::services::meeting::remote_asr::RemoteProvider::Groq => {
                        crate::ipc::dto::RemoteProvider::Groq
                    }
                    crate::services::meeting::remote_asr::RemoteProvider::Deepgram => {
                        crate::ipc::dto::RemoteProvider::Deepgram
                    }
                },
                model: snapshot.config.asr.model.clone(),
                api_key_ref: snapshot.config.asr.api_key_ref.clone(),
                key_status: resolve_status(
                    &snapshot.config.asr.api_key,
                    keys.inner(),
                    &snapshot.config.asr_key_ref(),
                ),
            },
            llm: LlmConfigView {
                mode: match snapshot.config.llm.mode {
                    crate::services::meeting::summarize::LlmMode::Local => LlmMode::Local,
                    crate::services::meeting::summarize::LlmMode::Remote => LlmMode::Remote,
                },
                local_model: snapshot.config.llm.local_model.clone(),
                base_url: snapshot.config.llm.base_url.clone(),
                model: snapshot.config.llm.model.clone(),
                api_key_ref: snapshot.config.llm.api_key_ref.clone(),
                key_status: resolve_status(
                    &snapshot.config.llm.api_key,
                    keys.inner(),
                    &snapshot.config.llm_key_ref(),
                ),
            },
            keep_transcript: snapshot.config.keep_transcript,
            max_minutes: snapshot.config.max_minutes,
            revision: snapshot.revision,
        },
        preview: RuntimePreview {
            defaults: TierDefaultsView {
                asr_model: defaults.asr_model.to_owned(),
                llm_model: defaults.llm_model.to_owned(),
                threads: defaults.threads,
                accel: match defaults.accel {
                    runtime::Accel::Cpu => Accel::Cpu,
                    runtime::Accel::Metal => Accel::Metal,
                },
                notes: defaults
                    .notes
                    .iter()
                    .map(|note| match note {
                        runtime::RuntimeNote::FireRedHighMemory => RuntimeNote::FireRedHighMemory,
                        runtime::RuntimeNote::LlmEightBRequires32GiB => {
                            RuntimeNote::LlmEightBRequires32GiB
                        }
                        runtime::RuntimeNote::WindowsSlowLlm => RuntimeNote::WindowsSlowLlm,
                    })
                    .collect(),
            },
            resolved: resolved_view,
            unsupported,
            asr_budget_mb: budget::asr_budget_mb(
                profile.available_memory_mb,
                profile.total_memory_mb,
            ),
            llm_budget_mb: budget::llm_budget_mb(profile.available_memory_mb),
        },
        disk: DiskStatus {
            free_bytes,
            asr_required_bytes: required_bytes(&asr_gaps),
            llm_required_bytes: required_bytes(&llm_gaps),
        },
    })
}

#[tauri::command]
pub fn meeting_config_set<R: Runtime>(
    window: WebviewWindow<R>,
    config: State<'_, MeetingConfigStore>,
    patch: MeetingConfigPatch,
    expected_revision: u64,
) -> Result<MeetingConfigSetResponse, AppError> {
    ensure_settings_window(&window)?;
    let patch = crate::state::meeting::config::MeetingConfigPatch {
        runtime_mode: patch.runtime_mode.map(|mode| match mode {
            RuntimeMode::Auto => crate::state::meeting::config::RuntimeMode::Auto,
            RuntimeMode::Cpu => crate::state::meeting::config::RuntimeMode::Cpu,
        }),
        asr_mode: patch.asr_mode.map(|mode| match mode {
            AsrMode::Local => crate::services::meeting::asr_route::AsrMode::Local,
            AsrMode::Remote => crate::services::meeting::asr_route::AsrMode::Remote,
        }),
        asr_local_model: patch.asr_local_model,
        asr_provider: patch.asr_provider.map(|provider| match provider {
            crate::ipc::dto::RemoteProvider::OpenAi => {
                crate::services::meeting::remote_asr::RemoteProvider::OpenAi
            }
            crate::ipc::dto::RemoteProvider::Groq => {
                crate::services::meeting::remote_asr::RemoteProvider::Groq
            }
            crate::ipc::dto::RemoteProvider::Deepgram => {
                crate::services::meeting::remote_asr::RemoteProvider::Deepgram
            }
        }),
        asr_model: patch.asr_model,
        asr_api_key_ref: patch.asr_api_key_ref,
        llm_mode: patch.llm_mode.map(|mode| match mode {
            LlmMode::Local => crate::services::meeting::summarize::LlmMode::Local,
            LlmMode::Remote => crate::services::meeting::summarize::LlmMode::Remote,
        }),
        llm_local_model: patch.llm_local_model,
        llm_base_url: patch.llm_base_url,
        llm_model: patch.llm_model,
        llm_api_key_ref: patch.llm_api_key_ref,
        keep_transcript: patch.keep_transcript,
        max_minutes: patch.max_minutes,
    };
    let revision = config.set(patch, expected_revision)?;
    Ok(MeetingConfigSetResponse { revision })
}

#[tauri::command]
pub fn meeting_key_status<R: Runtime>(
    window: WebviewWindow<R>,
    config: State<'_, MeetingConfigStore>,
    keys: State<'_, Arc<KeyService>>,
    slot: String,
) -> Result<KeyStatus, AppError> {
    ensure_settings_window(&window)?;
    let snapshot = config.get();
    let reference = key_slot(&snapshot.config, &slot)?;
    let stored = match slot.as_str() {
        "asr" => &snapshot.config.asr.api_key,
        _ => &snapshot.config.llm.api_key,
    };
    Ok(resolve_status(stored, keys.inner(), &reference))
}

#[tauri::command]
pub fn meeting_key_set<R: Runtime>(
    window: WebviewWindow<R>,
    config: State<'_, MeetingConfigStore>,
    keys: State<'_, Arc<KeyService>>,
    slot: String,
    value: String,
) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    let reference = key_slot(&config.get().config, &slot)?;
    config.set_key(&slot, &value)?;
    keys.clear(&reference);
    Ok(())
}

#[tauri::command]
pub fn meeting_key_clear<R: Runtime>(
    window: WebviewWindow<R>,
    config: State<'_, MeetingConfigStore>,
    keys: State<'_, Arc<KeyService>>,
    slot: String,
    all: Option<bool>,
) -> Result<(), AppError> {
    ensure_settings_window(&window)?;
    for reference in config.clear_key(&slot, all == Some(true))? {
        keys.clear(&reference);
    }
    Ok(())
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
    open_settings(&app)?;
    if let Some(section) = section {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_failure_without_local_gets_the_fallback_code() {
        let error = AppError::new(AppErrorCode::AsrFailed, "boom")
            .with_details(serde_json::json!({ "reason": "remote_timeout" }));
        let mapped = remote_failed(error, true);
        assert_eq!(mapped.code, AppErrorCode::AsrFailed);
        let details = mapped.details.expect("details");
        assert_eq!(details["reason"], "remote_timeout");
        assert_eq!(details["fallback_unavailable"], true);
    }

    #[test]
    fn remote_failure_with_local_or_cancel_passes_through() {
        let error = AppError::new(AppErrorCode::AsrFailed, "boom")
            .with_details(serde_json::json!({ "reason": "remote_timeout" }));
        let kept = remote_failed(error, false);
        assert!(kept
            .details
            .as_ref()
            .unwrap()
            .get("fallback_unavailable")
            .is_none());

        let cancelled = AppError::new(AppErrorCode::Cancelled, "stop");
        assert_eq!(remote_failed(cancelled, true).code, AppErrorCode::Cancelled);
    }
}
