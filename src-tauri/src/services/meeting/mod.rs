//! Meeting-minutes audio pipeline.
//!
//! Everything that touches the audio file, models, and network lives here; the
//! WebView only receives progress events and the final Markdown.

pub mod decode;
pub mod vad;

pub use decode::{decode_windows, ensure_duration, probe_audio, AudioProbe, DecodeWindow};
pub use vad::{segment_window, Segmentation, SpeechSegment};

/// Hard ceiling for one source file (500 MiB).
pub const MAX_AUDIO_BYTES: u64 = 500 * 1024 * 1024;
/// Every decoded window handed to VAD/ASR is at most ten minutes.
pub const DECODE_WINDOW_MS: u64 = 10 * 60 * 1000;
/// ASR models and diarization both expect 16 kHz mono.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;
