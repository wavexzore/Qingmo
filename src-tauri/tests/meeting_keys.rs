//! Keyring fallback and clear-set semantics.

use std::sync::Arc;

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::KeyStatus;
use qingmo_lib::services::meeting::keys::{clear_set, BrokenKeyStore, KeyService, MemoryKeyStore};
use qingmo_lib::state::meeting::MeetingConfig;

#[test]
fn memory_keyring_reports_present_then_absent() {
    let service = KeyService::new(Arc::new(MemoryKeyStore::default()));
    assert_eq!(service.status("asr.openai"), KeyStatus::Absent);
    service.set("asr.openai", "sk-test").expect("set");
    assert_eq!(service.status("asr.openai"), KeyStatus::Present);
    assert_eq!(service.get("asr.openai").as_deref(), Some("sk-test"));
    service.clear("asr.openai");
    assert_eq!(service.status("asr.openai"), KeyStatus::Absent);
}

#[test]
fn a_broken_keyring_keeps_the_key_in_memory_for_the_session() {
    let service = KeyService::new(Arc::new(BrokenKeyStore));
    assert_eq!(service.status("llm.default"), KeyStatus::KeyringUnavailable);
    service.set("llm.default", "sk-test").expect("fallback set");
    assert_eq!(service.get("llm.default").as_deref(), Some("sk-test"));
    assert_eq!(service.status("llm.default"), KeyStatus::KeyringUnavailable);
    service.clear("llm.default");
    assert!(service.get("llm.default").is_none());
}

#[test]
fn derived_refs_follow_the_provider_and_base_url() {
    let mut config = MeetingConfig::default();
    assert_eq!(config.asr_key_ref(), "asr.openai");
    config.asr.provider = qingmo_lib::services::meeting::RemoteProvider::Groq;
    assert_eq!(config.asr_key_ref(), "asr.groq");
    assert_eq!(config.llm_key_ref(), "llm.default");
    config.llm.base_url = "https://example.test/v1/chat/completions".into();
    assert!(config.llm_key_ref().starts_with("llm."));
    assert_ne!(config.llm_key_ref(), "llm.default");
    config.asr.api_key_ref = "asr.custom".into();
    assert_eq!(config.asr_key_ref(), "asr.custom");
}

#[test]
fn clear_all_covers_history_and_current_refs_without_duplicates() {
    let mut config = MeetingConfig {
        key_refs: vec![
            "asr.openai".into(),
            "llm.default".into(),
            "llm.old".into(),
            "llm.old".into(),
        ],
        ..MeetingConfig::default()
    };
    assert_eq!(
        clear_set(&config, "", true).expect("clear all"),
        ["asr.openai", "llm.default", "llm.old"]
    );
    config.llm.base_url = "https://example.test".into();
    assert_eq!(
        clear_set(&config, "llm", false).expect("single"),
        [config.llm_key_ref()]
    );
    let error = clear_set(&config, "other", false).expect_err("unknown slot");
    assert_eq!(error.code, AppErrorCode::InvalidConfig);
}
