//! Meeting-minutes audio pipeline.
//!
//! Everything that touches the audio file, models, and network lives here; the
//! WebView only receives progress events and the final Markdown.

pub mod asr;
pub mod asr_route;
pub mod budget;
pub mod cards;
pub mod decode;
pub mod diarize;
pub mod download;
pub mod keys;
pub mod lang;
pub mod llm;
pub mod llm_local;
pub mod models;
pub mod pipeline;
pub mod reduce;
pub mod remote_asr;
pub mod render;
pub mod runtime;
pub mod speaker;
pub mod summarize;
pub mod vad;
pub mod validate;

pub use asr::{AsrEngine, Segment, SegmentStatus, SherpaAsr, Token};
pub use asr_route::{decide as decide_asr_route, AsrMode, RouteDecision, RouteKind};
pub use cards::{Card, CardKind, CardWindow, GenerateError};
pub use decode::{
    decode_windows, ensure_duration, probe_audio, AudioProbe, DecodeWindow, DecodedWindow,
};
pub use lang::{detect_language, Lang};
pub use llm::{validate_base_url, LlmClient, LlmError, LlmErrorCode, RemoteLlm, RemoteLlmConfig};
pub use llm_local::{LocalLlm, LocalLlmSpec};
pub use models::{ManifestCatalog, ModelCatalog, ModelState};
pub use pipeline::{
    run_local, run_remote, run_remote_with_fallback, ActualBackend, JobFlags, PipelineOutcome,
    StopExit, StopReason,
};
pub use reduce::reduce_cards;
pub use remote_asr::{endpoint, HttpRemoteAsr, RemoteAsr, RemoteAsrConfig, RemoteProvider};
pub use runtime::{Accel, HardwareProfile, RuntimePlan};
pub use speaker::{
    join, DiarizationEngine, DiarizeError, SpeakerJoinStats, SpeakerModels, SpeakerStitcher,
    SpeakerTurn, Word,
};
pub use summarize::{
    summarize, DefaultLlmFactory, LlmFactory, LlmMode, SummarizeOutcome, SummarizePlan,
};
pub use vad::{segment_window, Segmentation, SpeechSegment};
pub use validate::{validate_cards, ValidationStats};

/// Hard ceiling for one source file (500 MiB).
pub const MAX_AUDIO_BYTES: u64 = 500 * 1024 * 1024;
/// Every decoded window handed to VAD/ASR is at most ten minutes.
pub const DECODE_WINDOW_MS: u64 = 10 * 60 * 1000;
/// ASR models and diarization both expect 16 kHz mono.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;
