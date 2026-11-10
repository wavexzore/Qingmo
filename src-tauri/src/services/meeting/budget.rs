//! Pure memory-budget functions.
//!
//! Every input is explicit so tests can pin exact numbers. ASR includes the
//! decode window, diarization and VAD only on the local route; the remote route
//! still needs a decode window and the process runtime.

use super::models::ModelPack;

pub const DECODE_WINDOW_MB: u32 = 40;
pub const DIARIZATION_MB: u32 = 160;
pub const VAD_MB: u32 = 20;
pub const RUNTIME_MB: u32 = 300;

pub const ASR_CAP_MB: u32 = 4096;
pub const LLM_CAP_MB: u32 = 8192;
pub const LLM_HEADROOM_MB: u32 = 1024;
const AVAILABLE_SHARE: u32 = 3;
const AVAILABLE_DIV: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrRoute {
    Local,
    Remote,
}

/// Peak ASR demand for the chosen route.
pub fn asr_need_mb(pack: Option<&ModelPack>, route: AsrRoute) -> u32 {
    let runtime = DECODE_WINDOW_MB + RUNTIME_MB;
    match route {
        AsrRoute::Remote => runtime,
        AsrRoute::Local => {
            let weights = pack
                .map(|pack| pack.peak_basis.margin(pack.peak_memory_mb))
                .unwrap_or(1200);
            weights + DIARIZATION_MB + VAD_MB + runtime
        }
    }
}

/// LLM demand: weights (plus estimated margin) and a fixed 200 MB overhead.
pub fn llm_need_mb(pack: &ModelPack) -> u32 {
    pack.peak_basis.margin(pack.peak_memory_mb) + 200
}

pub fn asr_budget_mb(available_mb: u64, total_mb: u64) -> u32 {
    let by_available =
        available_mb.saturating_mul(u64::from(AVAILABLE_SHARE)) / u64::from(AVAILABLE_DIV);
    by_available.min(u64::from(ASR_CAP_MB)).min(total_mb) as u32
}

pub fn asr_fits(need_mb: u32, available_mb: u64, total_mb: u64) -> bool {
    u64::from(need_mb) <= u64::from(asr_budget_mb(available_mb, total_mb))
}

pub fn llm_available_mb(available_mb: u64) -> u64 {
    available_mb.saturating_sub(u64::from(LLM_HEADROOM_MB))
}

pub fn llm_budget_mb(available_mb: u64) -> u32 {
    (llm_available_mb(available_mb).saturating_mul(u64::from(AVAILABLE_SHARE))
        / u64::from(AVAILABLE_DIV))
    .min(u64::from(LLM_CAP_MB)) as u32
}

pub fn llm_fits(need_mb: u32, available_mb: u64) -> bool {
    u64::from(need_mb) <= u64::from(llm_budget_mb(available_mb))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::models::find;

    #[test]
    fn remote_only_counts_decoding_and_runtime() {
        assert_eq!(asr_need_mb(None, AsrRoute::Remote), 340);
    }

    #[test]
    fn firedered_rejects_on_four_gib_and_remote_passes() {
        let firered = find("fireredasr2-ctc-int8").unwrap();
        let local = asr_need_mb(Some(firered), AsrRoute::Local);
        assert_eq!(local, 3020);
        assert!(!asr_fits(local, 2560, 4096));
        let remote = asr_need_mb(None, AsrRoute::Remote);
        assert!(asr_fits(remote, 2560, 4096));
    }

    #[test]
    fn eight_b_rejects_on_eight_gib() {
        let eight = find("qwen3-8b-instruct-q4km").unwrap();
        let need = llm_need_mb(eight);
        assert_eq!(need, 7700);
        assert!(!llm_fits(need, 8192));
        assert!(llm_fits(need, 16384));
    }

    #[test]
    fn llm_headroom_is_saturated() {
        assert_eq!(llm_available_mb(512), 0);
        assert_eq!(llm_budget_mb(512), 0);
    }

    #[test]
    fn cap_limits_the_budget() {
        assert_eq!(asr_budget_mb(64 * 1024, 64 * 1024), ASR_CAP_MB);
    }
}
