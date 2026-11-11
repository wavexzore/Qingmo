//! Runtime tiering, model resolution and plan construction.
//!
//! Tiering only fills defaults; pinned models win unless the machine cannot
//! honor them. ASR is CPU-only in this version; Metal is reserved for the
//! macOS local LLM.

use serde::{Deserialize, Serialize};

use super::budget::{self, AsrRoute};
use super::models::{find, ModelKind};
use crate::error::{AppError, AppErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Os {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Arch {
    Aarch64,
    X86_64,
}

#[derive(Debug, Clone, Copy)]
pub struct HardwareProfile {
    pub os: Os,
    pub arch: Arch,
    pub total_memory_mb: u64,
    pub available_memory_mb: u64,
    pub performance_cores: u16,
    pub metal_available: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct LiveMemory {
    pub total_memory_mb: u64,
    pub available_memory_mb: u64,
}

impl HardwareProfile {
    /// Detect the live machine. `MEETING_E2E_PROFILE` wins in debug builds so
    /// E2E runs can pin every tier on one runner.
    pub fn detect() -> Self {
        #[cfg(debug_assertions)]
        if let Some(profile) = Self::from_env() {
            return profile;
        }
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        let total_mb = system.total_memory() / 1024 / 1024;
        let available_mb = system.available_memory() / 1024 / 1024;
        let logical = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(8);
        let cores = (logical / 2).max(1) as u16;
        Self {
            os: if cfg!(target_os = "macos") {
                Os::Macos
            } else if cfg!(target_os = "windows") {
                Os::Windows
            } else {
                Os::Linux
            },
            arch: if cfg!(target_arch = "aarch64") {
                Arch::Aarch64
            } else {
                Arch::X86_64
            },
            total_memory_mb: total_mb,
            available_memory_mb: available_mb,
            performance_cores: cores,
            metal_available: cfg!(all(target_os = "macos", target_arch = "aarch64")),
        }
    }

    #[cfg(debug_assertions)]
    fn from_alias(raw: &str) -> Option<Self> {
        let (os, arch, total, available, cores, metal) = match raw {
            "8g-mac" => (Os::Macos, Arch::Aarch64, 8 * 1024, 6 * 1024, 4, true),
            "16g-mac" => (Os::Macos, Arch::Aarch64, 16 * 1024, 12 * 1024, 6, true),
            "32g-mac" => (Os::Macos, Arch::Aarch64, 32 * 1024, 24 * 1024, 8, true),
            "8g-win" => (Os::Windows, Arch::X86_64, 8 * 1024, 6 * 1024, 4, false),
            _ => return None,
        };
        Some(Self {
            os,
            arch,
            total_memory_mb: total,
            available_memory_mb: available,
            performance_cores: cores,
            metal_available: metal,
        })
    }

    #[cfg(debug_assertions)]
    pub fn from_env() -> Option<Self> {
        let raw = super::e2e::var("MEETING_E2E_PROFILE")?;
        if let Some(profile) = Self::from_alias(&raw) {
            return Some(profile);
        }
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let os = match value.get("os")?.as_str()? {
            "macos" => Os::Macos,
            "windows" => Os::Windows,
            "linux" => Os::Linux,
            _ => return None,
        };
        let arch = match value.get("arch")?.as_str()? {
            "aarch64" => Arch::Aarch64,
            "x86_64" => Arch::X86_64,
            _ => return None,
        };
        Some(Self {
            os,
            arch,
            total_memory_mb: value.get("totalMemoryMb")?.as_u64()?,
            available_memory_mb: value.get("availableMemoryMb")?.as_u64()?,
            performance_cores: value.get("performanceCores")?.as_u64()? as u16,
            metal_available: value.get("metalAvailable")?.as_bool()?,
        })
    }
}

pub trait MemoryProbe: Send + Sync {
    fn available_mb(&self) -> u64;
    fn profile(&self) -> LiveMemory;
}

/// Re-samples memory right before the summary model loads. `detect()` wins in
/// debug so an E2E profile also pins the re-sample.
pub struct SystemMemory;

impl MemoryProbe for SystemMemory {
    fn available_mb(&self) -> u64 {
        HardwareProfile::detect().available_memory_mb
    }

    fn profile(&self) -> LiveMemory {
        let profile = HardwareProfile::detect();
        LiveMemory {
            total_memory_mb: profile.total_memory_mb,
            available_memory_mb: profile.available_memory_mb,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Accel {
    Cpu,
    Metal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeNote {
    FireRedHighMemory,
    LlmEightBRequires32GiB,
    WindowsSlowLlm,
}

#[derive(Debug, Clone)]
pub struct TierDefaults {
    pub asr_model: &'static str,
    pub llm_model: &'static str,
    pub threads: u16,
    pub accel: Accel,
    pub notes: Vec<RuntimeNote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Auto,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedModels {
    pub asr: &'static str,
    pub llm: &'static str,
    pub asr_origin: Origin,
    pub llm_origin: Origin,
}

#[derive(Debug, Clone)]
pub struct RuntimePreview {
    pub defaults: TierDefaults,
    pub resolved: Option<ResolvedModels>,
    pub unsupported: Option<ReasonCode>,
    pub asr_budget_mb: u32,
    pub llm_budget_mb: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimePlan {
    pub resolved: ResolvedModels,
    pub threads: u16,
    pub accel: Accel,
    pub asr_budget_mb: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonCode {
    RemoteAuth,
    RemoteQuota,
    RemoteKeyMissing,
    RemoteResponseTooLarge,
    FallbackUnavailable,
    DiskFull,
    ArchiveBomb,
    ArchiveEscape,
    MemoryBudget,
    ModelUnsupported,
    ConfigRevision,
    KeyringUnavailable,
}

impl ReasonCode {
    pub const ALL: [Self; 12] = [
        Self::RemoteAuth,
        Self::RemoteQuota,
        Self::RemoteKeyMissing,
        Self::RemoteResponseTooLarge,
        Self::FallbackUnavailable,
        Self::DiskFull,
        Self::ArchiveBomb,
        Self::ArchiveEscape,
        Self::MemoryBudget,
        Self::ModelUnsupported,
        Self::ConfigRevision,
        Self::KeyringUnavailable,
    ];
}

pub fn tier_defaults(profile: &HardwareProfile) -> TierDefaults {
    let (asr_model, llm_model) = if profile.total_memory_mb <= 8 * 1024 {
        ("paraformer-zh-small-int8", "qwen3-1.7b-instruct-q4km")
    } else if profile.total_memory_mb < 16 * 1024 {
        ("paraformer-zh-en-int8", "qwen3-1.7b-instruct-q4km")
    } else {
        ("paraformer-zh-en-int8", "qwen3-4b-instruct-q4km")
    };

    let threads = profile.performance_cores.saturating_sub(1).clamp(2, 4);
    let accel =
        if profile.os == Os::Macos && profile.arch == Arch::Aarch64 && profile.metal_available {
            Accel::Metal
        } else {
            Accel::Cpu
        };

    let mut notes = Vec::new();
    if profile.total_memory_mb < 32 * 1024 {
        notes.push(RuntimeNote::LlmEightBRequires32GiB);
    }
    if profile.total_memory_mb <= 32 * 1024 {
        notes.push(RuntimeNote::FireRedHighMemory);
    }
    if profile.os == Os::Windows {
        notes.push(RuntimeNote::WindowsSlowLlm);
    }

    TierDefaults {
        asr_model,
        llm_model,
        threads,
        accel,
        notes,
    }
}

pub fn resolve_models(
    asr_pin: Option<&str>,
    llm_pin: Option<&str>,
    profile: &HardwareProfile,
) -> Result<ResolvedModels, AppError> {
    let defaults = tier_defaults(profile);

    let (asr, asr_origin) = match asr_pin.filter(|id| !id.is_empty()) {
        Some(id) => {
            let pack = find(id).ok_or_else(|| unsupported(id))?;
            if pack.kind != ModelKind::Asr || pack.family.is_none() {
                return Err(unsupported(id));
            }
            (pack.id, Origin::Pinned)
        }
        None => (defaults.asr_model, Origin::Auto),
    };

    let (llm, llm_origin) = match llm_pin.filter(|id| !id.is_empty()) {
        Some(id) => {
            let pack = find(id).ok_or_else(|| unsupported(id))?;
            if pack.kind != ModelKind::Llm {
                return Err(unsupported(id));
            }
            if id.starts_with("qwen3-8b") && profile.total_memory_mb < 32 * 1024 {
                return Err(unsupported(id));
            }
            (pack.id, Origin::Pinned)
        }
        None => (defaults.llm_model, Origin::Auto),
    };

    Ok(ResolvedModels {
        asr,
        llm,
        asr_origin,
        llm_origin,
    })
}

pub fn build_plan(
    asr_pin: Option<&str>,
    llm_pin: Option<&str>,
    profile: &HardwareProfile,
    cpu_only: bool,
    route: AsrRoute,
) -> Result<RuntimePlan, AppError> {
    let defaults = tier_defaults(profile);
    let resolved = resolve_models(asr_pin, llm_pin, profile)?;
    let asr = find(resolved.asr);
    let accel = if cpu_only { Accel::Cpu } else { defaults.accel };
    Ok(RuntimePlan {
        resolved,
        threads: defaults.threads,
        accel,
        asr_budget_mb: budget::asr_need_mb(asr, route),
    })
}

pub fn preview(
    asr_pin: Option<&str>,
    llm_pin: Option<&str>,
    profile: &HardwareProfile,
) -> RuntimePreview {
    let defaults = tier_defaults(profile);
    let resolved = resolve_models(asr_pin, llm_pin, profile);
    let (resolved, unsupported) = match resolved {
        Ok(models) => (Some(models), None),
        Err(_) => (None, Some(ReasonCode::ModelUnsupported)),
    };
    let asr = resolved.and_then(|models| find(models.asr));
    let llm = resolved.and_then(|models| find(models.llm));
    RuntimePreview {
        defaults,
        resolved,
        unsupported,
        asr_budget_mb: budget::asr_need_mb(asr, AsrRoute::Local),
        llm_budget_mb: llm.map(budget::llm_need_mb).unwrap_or(0),
    }
}

pub const RTF_WARMUP_SEGMENTS: u8 = 2;
pub const RTF_SAMPLE_SEGMENTS: usize = 3;
pub const RTF_MIN_SEGMENT_MS: u64 = 2_000;
pub const RTF_SLOW: f32 = 0.6;

#[derive(Debug, Clone, PartialEq)]
pub struct RtfProfile {
    pub rtf: f32,
    pub slow: bool,
    pub cache_key: String,
}

/// Collects the first three RTF samples after two warm-up segments.
#[derive(Debug)]
pub struct RtfCalibrator {
    cache_key: String,
    warmup: u8,
    samples: Vec<f32>,
}

impl RtfCalibrator {
    pub fn new(cache_key: impl Into<String>) -> Self {
        Self {
            cache_key: cache_key.into(),
            warmup: 0,
            samples: Vec::with_capacity(RTF_SAMPLE_SEGMENTS),
        }
    }

    pub fn cache_key(app_version: &str, model: &str, threads: u16, accel: Accel) -> String {
        format!("{app_version}|{model}|{threads}|{accel:?}")
    }

    /// Feed one segment; returns the profile once three samples exist.
    pub fn observe(&mut self, duration_ms: u64, elapsed_ms: u64) -> Option<RtfProfile> {
        if duration_ms < RTF_MIN_SEGMENT_MS {
            return None;
        }
        if self.warmup < RTF_WARMUP_SEGMENTS {
            self.warmup += 1;
            return None;
        }
        self.samples
            .push(elapsed_ms as f32 / duration_ms.max(1) as f32);
        if self.samples.len() < RTF_SAMPLE_SEGMENTS {
            return None;
        }
        let mut sorted = self.samples.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let rtf = sorted[sorted.len() / 2];
        Some(RtfProfile {
            rtf,
            slow: rtf > RTF_SLOW,
            cache_key: self.cache_key.clone(),
        })
    }
}

/// Use a cached profile only when its key still matches.
pub fn cached_profile(key: &str, cached: Option<RtfProfile>) -> Option<RtfProfile> {
    cached.filter(|profile| profile.cache_key == key)
}

pub fn unsupported(id: &str) -> AppError {
    AppError::new(
        AppErrorCode::InvalidConfig,
        format!("model {id} is not supported on this machine"),
    )
    .with_details(serde_json::json!({
        "reason": ReasonCode::ModelUnsupported,
        "model": id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(os: Os, arch: Arch, total: u64) -> HardwareProfile {
        HardwareProfile {
            os,
            arch,
            total_memory_mb: total,
            available_memory_mb: total,
            performance_cores: 8,
            metal_available: arch == Arch::Aarch64,
        }
    }

    #[test]
    fn four_tiers_pick_the_documented_defaults() {
        let low = tier_defaults(&profile(Os::Macos, Arch::Aarch64, 8 * 1024));
        assert_eq!(low.asr_model, "paraformer-zh-small-int8");
        let mid = tier_defaults(&profile(Os::Macos, Arch::Aarch64, 12 * 1024));
        assert_eq!(mid.asr_model, "paraformer-zh-en-int8");
        let high = tier_defaults(&profile(Os::Macos, Arch::Aarch64, 32 * 1024));
        assert_eq!(high.llm_model, "qwen3-4b-instruct-q4km");
    }

    #[test]
    fn threads_are_clamped() {
        let mut p = profile(Os::Linux, Arch::X86_64, 16384);
        p.performance_cores = 1;
        assert_eq!(tier_defaults(&p).threads, 2);
        p.performance_cores = 64;
        assert_eq!(tier_defaults(&p).threads, 4);
    }

    #[test]
    fn metal_is_macos_arm_only() {
        assert_eq!(
            tier_defaults(&profile(Os::Macos, Arch::Aarch64, 16384)).accel,
            Accel::Metal
        );
        assert_eq!(
            tier_defaults(&profile(Os::Windows, Arch::X86_64, 16384)).accel,
            Accel::Cpu
        );
    }

    #[test]
    fn pinned_eight_b_needs_32_gib() {
        let p = profile(Os::Macos, Arch::Aarch64, 8192);
        let error = resolve_models(None, Some("qwen3-8b-instruct-q4km"), &p).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidConfig);
        assert_eq!(
            error.details.unwrap().get("reason").unwrap(),
            &serde_json::json!("model_unsupported")
        );
    }

    #[test]
    fn pinned_models_win_and_cpu_mode_wins_over_accel() {
        let p = profile(Os::Macos, Arch::Aarch64, 32768);
        let plan = build_plan(None, None, &p, false, AsrRoute::Local).unwrap();
        assert_eq!(plan.accel, Accel::Metal);
        let cpu = build_plan(None, None, &p, true, AsrRoute::Local).unwrap();
        assert_eq!(cpu.accel, Accel::Cpu);
        let pinned = build_plan(
            Some("zipformer-zh-en-int8"),
            Some("qwen3-8b-instruct-q4km"),
            &p,
            false,
            AsrRoute::Local,
        )
        .unwrap();
        assert_eq!(pinned.resolved.asr_origin, Origin::Pinned);
        assert_eq!(pinned.resolved.asr, "zipformer-zh-en-int8");
    }

    #[test]
    fn preview_reports_unsupported_instead_of_failing() {
        let p = profile(Os::Linux, Arch::X86_64, 8192);
        let preview = preview(None, Some("qwen3-8b-instruct-q4km"), &p);
        assert!(preview.resolved.is_none());
        assert_eq!(preview.unsupported, Some(ReasonCode::ModelUnsupported));
    }

    #[test]
    fn rtf_skips_warmup_and_takes_the_median() {
        let mut calibrator = RtfCalibrator::new("k");
        assert!(calibrator.observe(3_000, 100).is_none());
        assert!(calibrator.observe(3_000, 100).is_none());
        assert!(calibrator.observe(3_000, 300).is_none());
        assert!(calibrator.observe(3_000, 900).is_none());
        let profile = calibrator.observe(3_000, 600).unwrap();
        assert_eq!(profile.rtf, 0.2);
        assert!(!profile.slow);
        assert!(calibrator.observe(500, 5).is_none());
    }

    #[test]
    fn rtf_marks_slow_and_invalidates_cache_key() {
        let mut calibrator = RtfCalibrator::new(RtfCalibrator::cache_key("1", "m", 2, Accel::Cpu));
        for elapsed in [100, 100, 2_000, 2_000] {
            let _ = calibrator.observe(3_000, elapsed);
        }
        let profile = calibrator.observe(3_000, 2_000).unwrap();
        assert!(profile.slow);
        let cached = Some(profile.clone());
        assert!(cached_profile(&profile.cache_key, cached.clone()).is_some());
        assert!(cached_profile("other", cached).is_none());
    }

    #[test]
    #[cfg(debug_assertions)]
    fn e2e_profile_is_parsed() {
        std::env::set_var(
            "MEETING_E2E_PROFILE",
            r#"{"os":"linux","arch":"x86_64","totalMemoryMb":16384,"availableMemoryMb":8000,"performanceCores":6,"metalAvailable":false}"#,
        );
        let profile = HardwareProfile::from_env().unwrap();
        assert_eq!(profile.total_memory_mb, 16_384);
        assert_eq!(profile.performance_cores, 6);
        std::env::remove_var("MEETING_E2E_PROFILE");
    }

    #[test]
    fn reason_codes_have_twelve_entries() {
        assert_eq!(ReasonCode::ALL.len(), 12);
    }
}
