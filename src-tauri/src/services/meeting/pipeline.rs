//! Local single-window pipeline skeleton.
//!
//! Decoding, VAD, ASR and the quality gate run in order per window. Failures
//! never abort the loop: failed segments are kept as placeholders and the exit
//! table decides the final state after the last window.

use std::path::Path;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::asr::{repeat_ratio, AsrEngine, Segment, SegmentStatus, REPEAT_LIMIT};
use super::decode::{decode_windows, DecodeWindow};
use super::remote_asr::RemoteAsr;
use super::runtime::ReasonCode;
use super::speaker::{join, DiarizationEngine, DiarizeError, SpeakerTurn};
use super::vad::{segment_window, SpeechSegment};
use crate::error::{AppError, AppErrorCode};

pub const MAX_FAILED_SHARE: f32 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    AllFailed,
    Silent,
    DecodeFailed,
    Deadline,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopExit {
    Releasing,
    Partial,
    Failed,
}

/// One-shot exit sentinels; the registry owns a `MeetingJob` carrying these.
#[derive(Debug, Default)]
pub struct JobFlags {
    pub stop_reason: Option<StopReason>,
    pub exit: Option<StopExit>,
}

impl JobFlags {
    pub fn set_stop_reason(&mut self, reason: StopReason) -> bool {
        if self.stop_reason.is_some() {
            return false;
        }
        self.stop_reason = Some(reason);
        true
    }

    pub fn set_exit(&mut self, exit: StopExit) -> bool {
        if self.exit.is_some() {
            return false;
        }
        self.exit = Some(exit);
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActualBackend {
    Local,
    Remote,
}

#[derive(Debug)]
pub struct PipelineOutcome {
    pub segments: Vec<Segment>,
    pub stop_reason: StopReason,
    pub exit: StopExit,
    pub partial: bool,
    pub partial_decode: bool,
    pub partial_until_ms: Option<u64>,
    pub failed_segments: usize,
    pub actual_backend: ActualBackend,
    pub remote_fallback: bool,
    pub remote_last_error: Option<ReasonCode>,
    pub speaker_degraded: bool,
    pub speaker_partial: bool,
    pub speaker_count: Option<u8>,
}

impl PipelineOutcome {
    pub fn available(&self) -> usize {
        self.segments
            .iter()
            .filter(|segment| segment.status == SegmentStatus::Ok && !segment.text.is_empty())
            .count()
    }
}

/// Exit table, priority 1..4. Returns the exit plus whether `partial` is set.
pub fn exit_for(reason: StopReason, total: usize, available: usize) -> (StopExit, bool) {
    match reason {
        StopReason::AllFailed => (StopExit::Failed, false),
        StopReason::Silent => (StopExit::Releasing, false),
        StopReason::DecodeFailed | StopReason::Deadline => {
            if available > 0 {
                (StopExit::Partial, true)
            } else {
                (StopExit::Failed, false)
            }
        }
        StopReason::Completed => {
            if total > 0 && available == 0 {
                (StopExit::Failed, false)
            } else if available < total {
                (StopExit::Partial, true)
            } else {
                (StopExit::Releasing, false)
            }
        }
    }
}

pub fn run_local(
    windows: DecodeWindow,
    vad_model: Option<&std::path::Path>,
    asr: &mut dyn AsrEngine,
    cancel: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<PipelineOutcome, AppError> {
    run_local_with_diarizer(windows, vad_model, asr, None, cancel, deadline)
}

/// Local loop with an optional diarizer. VAD and diarization run on the same
/// immutable window in one scoped thread pair; ASR waits for both.
pub fn run_local_with_diarizer(
    windows: DecodeWindow,
    vad_model: Option<&std::path::Path>,
    asr: &mut dyn AsrEngine,
    mut diarizer: Option<&mut dyn DiarizationEngine>,
    cancel: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<PipelineOutcome, AppError> {
    let mut segments = Vec::new();
    let mut total = 0usize;
    let mut failed = 0usize;
    let mut reason = StopReason::Completed;
    let mut speaker_degraded = diarizer.is_none();
    let mut speaker_partial = false;
    let mut speaker_count = 0u8;
    let mut successful_window = false;

    for (window_index, window) in windows.enumerate() {
        if cancel.is_cancelled() {
            return Err(AppError::new(AppErrorCode::Cancelled, "pipeline cancelled"));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            reason = StopReason::Deadline;
            break;
        }

        let window = match window {
            Ok(window) => window,
            Err(error) if error.code == AppErrorCode::Cancelled => return Err(error),
            Err(_) => {
                reason = StopReason::DecodeFailed;
                break;
            }
        };

        let (segmentation, turns) = match diarizer.as_deref_mut() {
            Some(engine) => {
                let result = std::thread::scope(|scope| {
                    let diarizer_handle = scope
                        .spawn(|| engine.push_window(&window.samples, window.start_ms, cancel));
                    let segmentation =
                        segment_window(&window.samples, vad_model, window.start_ms, cancel);
                    let turns = diarizer_handle.join().unwrap_or_else(|_| {
                        Err(DiarizeError::Failed {
                            message: "diarizer panicked".into(),
                            turns: Vec::new(),
                        })
                    });
                    (segmentation, Some(turns))
                });
                result
            }
            None => (
                segment_window(&window.samples, vad_model, window.start_ms, cancel),
                None,
            ),
        };

        let turns: Vec<SpeakerTurn> = match turns {
            Some(Ok(turns)) => {
                successful_window = true;
                turns
            }
            Some(Err(DiarizeError::Cancelled)) => {
                return Err(AppError::new(AppErrorCode::Cancelled, "pipeline cancelled"));
            }
            Some(Err(DiarizeError::Failed { turns, .. })) => {
                if turns.is_empty() && (window_index == 0 || !successful_window) {
                    speaker_degraded = true;
                } else {
                    speaker_partial = true;
                }
                diarizer = None;
                turns
            }
            None => {
                if window_index == 0 || !successful_window {
                    speaker_degraded = true;
                } else {
                    speaker_partial = true;
                }
                diarizer = None;
                Vec::new()
            }
        };

        let mut window_segments = Vec::new();
        for speech in segmentation.segments {
            if cancel.is_cancelled() {
                return Err(AppError::new(AppErrorCode::Cancelled, "pipeline cancelled"));
            }
            total += 1;
            match transcribe(asr, &window.samples, speech, cancel) {
                Ok(segment) => {
                    if segment.text.is_empty()
                        && segment.end_ms.saturating_sub(segment.start_ms) > 2_000
                    {
                        continue;
                    }
                    window_segments.push(segment);
                }
                Err(error) if error.code == AppErrorCode::Cancelled => return Err(error),
                Err(_) => {
                    failed += 1;
                    window_segments.push(Segment::failed(speech.start_ms, speech.end_ms));
                }
            }
        }
        if !turns.is_empty() {
            let stats = join(&mut window_segments, &turns);
            speaker_count = speaker_count.max(stats.speakers);
        }
        segments.append(&mut window_segments);
    }

    let available = segments
        .iter()
        .filter(|segment| segment.status == SegmentStatus::Ok && !segment.text.is_empty())
        .count();
    if reason == StopReason::Completed {
        if total > 0 && available == 0 {
            reason = StopReason::AllFailed;
        } else if total == 0 {
            reason = StopReason::Silent;
        }
    }

    let (exit, mut partial) = exit_for(reason, total, available);
    let mut partial_decode = false;
    let mut partial_until_ms = None;
    if matches!(reason, StopReason::DecodeFailed | StopReason::Deadline) && available > 0 {
        partial_decode = true;
        partial_until_ms = segments
            .iter()
            .filter(|segment| segment.status == SegmentStatus::Ok)
            .map(|segment| segment.end_ms)
            .max();
    }
    if total > 0 && failed as f32 / total as f32 > MAX_FAILED_SHARE {
        partial = true;
    }

    Ok(PipelineOutcome {
        segments,
        stop_reason: reason,
        exit,
        partial,
        partial_decode,
        partial_until_ms,
        failed_segments: failed,
        actual_backend: ActualBackend::Local,
        remote_fallback: false,
        remote_last_error: None,
        speaker_degraded,
        speaker_partial,
        speaker_count: (speaker_count > 0).then_some(speaker_count),
    })
}

pub fn run_remote(
    windows: DecodeWindow,
    remote: &mut dyn RemoteAsr,
    cancel: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<PipelineOutcome, AppError> {
    let mut segments = Vec::new();
    let mut reason = StopReason::Completed;

    for window in windows {
        if cancel.is_cancelled() {
            return Err(AppError::new(AppErrorCode::Cancelled, "pipeline cancelled"));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            reason = StopReason::Deadline;
            break;
        }
        let window = match window {
            Ok(window) => window,
            Err(error) if error.code == AppErrorCode::Cancelled => return Err(error),
            Err(_) => {
                reason = StopReason::DecodeFailed;
                break;
            }
        };
        match remote.transcribe_window(window.start_ms, &window.samples, cancel, deadline) {
            Ok(mut remote_segments) => segments.append(&mut remote_segments),
            Err(error) if error.code == AppErrorCode::Cancelled => return Err(error),
            Err(error) => return Err(error),
        }
    }

    let available = segments
        .iter()
        .filter(|segment| segment.status == SegmentStatus::Ok && !segment.text.is_empty())
        .count();
    if reason == StopReason::Completed && available == 0 {
        reason = StopReason::Silent;
    }
    let total = available;
    let (exit, partial) = exit_for(reason, total, available);
    let mut partial_decode = false;
    let mut partial_until_ms = None;
    if matches!(reason, StopReason::DecodeFailed | StopReason::Deadline) && available > 0 {
        partial_decode = true;
        partial_until_ms = segments
            .iter()
            .filter(|segment| segment.status == SegmentStatus::Ok)
            .map(|segment| segment.end_ms)
            .max();
    }

    Ok(PipelineOutcome {
        segments,
        stop_reason: reason,
        exit,
        partial,
        partial_decode,
        partial_until_ms,
        failed_segments: 0,
        actual_backend: ActualBackend::Remote,
        remote_fallback: false,
        remote_last_error: None,
        speaker_degraded: false,
        speaker_partial: false,
        speaker_count: None,
    })
}

/// Run remote once; on any non-cancel failure reopen the source and run local.
pub fn run_remote_with_fallback(
    path: &Path,
    remote: &mut dyn RemoteAsr,
    local_asr: &mut dyn AsrEngine,
    vad_model: Option<&Path>,
    cancel: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<PipelineOutcome, AppError> {
    run_remote_with_fallback_diarized(path, remote, local_asr, vad_model, None, cancel, deadline)
}

/// Fallback variant that runs local diarization after a remote failure.
pub fn run_remote_with_fallback_diarized(
    path: &Path,
    remote: &mut dyn RemoteAsr,
    local_asr: &mut dyn AsrEngine,
    vad_model: Option<&Path>,
    diarizer: Option<&mut dyn DiarizationEngine>,
    cancel: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<PipelineOutcome, AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::new(AppErrorCode::Cancelled, "pipeline cancelled"));
    }
    let windows = decode_windows(path, cancel.clone())?;
    match run_remote(windows, remote, cancel, deadline) {
        Ok(outcome) => Ok(outcome),
        Err(error) if error.code == AppErrorCode::Cancelled => Err(error),
        Err(remote_error) => {
            let reason = remote_error
                .details
                .as_ref()
                .and_then(|details| details["reason"].as_str())
                .and_then(parse_reason);
            let windows = decode_windows(path, cancel.clone())?;
            let mut outcome =
                run_local_with_diarizer(windows, vad_model, local_asr, diarizer, cancel, deadline)?;
            outcome.actual_backend = ActualBackend::Local;
            outcome.remote_fallback = true;
            outcome.remote_last_error = reason;
            Ok(outcome)
        }
    }
}

fn parse_reason(value: &str) -> Option<ReasonCode> {
    match value {
        "remote_auth" => Some(ReasonCode::RemoteAuth),
        "remote_quota" => Some(ReasonCode::RemoteQuota),
        "remote_response_too_large" => Some(ReasonCode::RemoteResponseTooLarge),
        "fallback_unavailable" => Some(ReasonCode::FallbackUnavailable),
        _ => None,
    }
}

fn transcribe(
    asr: &mut dyn AsrEngine,
    window: &[f32],
    speech: SpeechSegment,
    cancel: &CancellationToken,
) -> Result<Segment, AppError> {
    let start = ms_to_samples(speech.start_ms);
    let end = ms_to_samples(speech.end_ms).min(window.len());
    let slice = window.get(start..end).unwrap_or(&[]);
    let raw = asr.recognize(slice, speech.start_ms, speech.end_ms, cancel)?;
    let mut segment = Segment::from_raw(raw, speech.start_ms, speech.end_ms);
    if repeat_ratio(&segment.text) > REPEAT_LIMIT {
        let retry = asr.recognize(slice, speech.start_ms, speech.end_ms, cancel);
        if let Ok(raw) = retry {
            segment = Segment::from_raw(raw, speech.start_ms, speech.end_ms);
        }
    }
    Ok(segment)
}

fn ms_to_samples(ms: u64) -> usize {
    (ms.saturating_mul(u64::from(super::TARGET_SAMPLE_RATE)) / 1000) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: u64, end: u64, text: &str) -> Segment {
        let mut segment = Segment::failed(start, end);
        segment.status = SegmentStatus::Ok;
        segment.text = text.into();
        segment
    }

    #[test]
    fn all_failed_wins_over_silence() {
        assert_eq!(
            exit_for(StopReason::AllFailed, 0, 0),
            (StopExit::Failed, false)
        );
        assert_eq!(
            exit_for(StopReason::AllFailed, 3, 0),
            (StopExit::Failed, false)
        );
    }

    #[test]
    fn silent_only_when_successfully_empty() {
        assert_eq!(
            exit_for(StopReason::Silent, 0, 0),
            (StopExit::Releasing, false)
        );
    }

    #[test]
    fn decode_and_deadline_depend_on_available_segments() {
        assert_eq!(
            exit_for(StopReason::DecodeFailed, 2, 1),
            (StopExit::Partial, true)
        );
        assert_eq!(
            exit_for(StopReason::DecodeFailed, 0, 0),
            (StopExit::Failed, false)
        );
        assert_eq!(
            exit_for(StopReason::Deadline, 5, 0),
            (StopExit::Failed, false)
        );
    }

    #[test]
    fn completed_partial_and_full_paths() {
        assert_eq!(
            exit_for(StopReason::Completed, 4, 2),
            (StopExit::Partial, true)
        );
        assert_eq!(
            exit_for(StopReason::Completed, 4, 4),
            (StopExit::Releasing, false)
        );
        assert_eq!(
            exit_for(StopReason::Completed, 4, 0),
            (StopExit::Failed, false)
        );
    }

    #[test]
    fn stop_reason_and_exit_are_written_once() {
        let mut flags = JobFlags::default();
        assert!(flags.set_stop_reason(StopReason::Silent));
        assert!(!flags.set_stop_reason(StopReason::Completed));
        assert!(flags.set_exit(StopExit::Releasing));
        assert!(!flags.set_exit(StopExit::Failed));
        assert_eq!(flags.stop_reason, Some(StopReason::Silent));
        assert_eq!(flags.exit, Some(StopExit::Releasing));
    }

    #[test]
    fn available_counts_only_ok_text() {
        let outcome = PipelineOutcome {
            segments: vec![seg(0, 10, "x"), Segment::failed(10, 20)],
            stop_reason: StopReason::Completed,
            exit: StopExit::Partial,
            partial: true,
            partial_decode: false,
            partial_until_ms: None,
            failed_segments: 1,
            actual_backend: ActualBackend::Local,
            remote_fallback: false,
            remote_last_error: None,
            speaker_degraded: false,
            speaker_partial: false,
            speaker_count: None,
        };
        assert_eq!(outcome.available(), 1);
    }
}
