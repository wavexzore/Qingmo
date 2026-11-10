//! Tier table, platform strategy and pinned-model edges.

use qingmo_lib::services::meeting::budget::AsrRoute;
use qingmo_lib::services::meeting::runtime::{
    build_plan, preview, resolve_models, tier_defaults, Accel, Arch, HardwareProfile, Os,
    ReasonCode, RuntimeNote,
};

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
fn every_tier_and_platform_resolves() {
    for os in [Os::Macos, Os::Windows, Os::Linux] {
        for arch in [Arch::Aarch64, Arch::X86_64] {
            for total in [4096u64, 8192, 12_288, 16_384, 32_768, 65_536] {
                let p = profile(os, arch, total);
                let defaults = tier_defaults(&p);
                assert!(resolve_models(None, None, &p).is_ok());
                assert!(!defaults.asr_model.is_empty());
                assert!(defaults.threads <= 4 && defaults.threads >= 2);
            }
        }
    }
}

#[test]
fn asr_is_cpu_but_macos_arm_llm_gets_metal() {
    let p = profile(Os::Macos, Arch::Aarch64, 16_384);
    assert_eq!(tier_defaults(&p).accel, Accel::Metal);
    let plan = build_plan(None, None, &p, false, AsrRoute::Local).unwrap();
    assert_eq!(plan.accel, Accel::Metal);
    let cpu = build_plan(None, None, &p, true, AsrRoute::Local).unwrap();
    assert_eq!(cpu.accel, Accel::Cpu);
}

#[test]
fn windows_gets_the_slow_note() {
    let p = profile(Os::Windows, Arch::X86_64, 16_384);
    assert!(tier_defaults(&p)
        .notes
        .contains(&RuntimeNote::WindowsSlowLlm));
}

#[test]
fn eight_b_is_rejected_below_32_gib_for_pins_and_preview() {
    let p = profile(Os::Linux, Arch::X86_64, 8192);
    let error = resolve_models(None, Some("qwen3-8b-instruct-q4km"), &p).unwrap_err();
    assert!(error.details.unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("model_unsupported"));
    let preview = preview(None, Some("qwen3-8b-instruct-q4km"), &p);
    assert_eq!(preview.unsupported, Some(ReasonCode::ModelUnsupported));
}

#[test]
fn wrong_kind_pin_is_rejected() {
    let p = profile(Os::Macos, Arch::Aarch64, 16_384);
    assert!(resolve_models(Some("qwen3-4b-instruct-q4km"), None, &p).is_err());
    assert!(resolve_models(None, Some("zipformer-zh-en-int8"), &p).is_err());
}

#[test]
fn exact_eight_gib_boundary_uses_the_small_model() {
    let p = profile(Os::Linux, Arch::X86_64, 8192);
    assert_eq!(tier_defaults(&p).asr_model, "paraformer-zh-small-int8");
    let just_over = profile(Os::Linux, Arch::X86_64, 8193);
    assert_eq!(tier_defaults(&just_over).asr_model, "paraformer-zh-en-int8");
}
