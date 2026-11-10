//! Meeting task registry, progress, asset scope and configuration.

pub mod asset_scope;
pub mod config;
pub mod job;
pub mod progress;
pub mod registry;

pub use asset_scope::{AssetAllow, AssetScope, TauriAssetAllow};
pub use config::{
    AsrConfig, LlmConfig, MeetingConfig, MeetingConfigPatch, MeetingConfigSnapshot,
    MeetingConfigStore, RuntimeConfig, RuntimeMode,
};
pub use job::{
    AsrBackend, Degraded, MeetingJob, MeetingOutcome, MeetingProgress, MeetingResult,
    MeetingSource, MeetingStage, MeetingStats, Terminal, WindowPhase, WindowProgress,
};
pub use progress::{ProgressEmitter, TauriProgressEmitter, EVENT_MEETING_PROGRESS};
pub use registry::MeetingRegistry;
