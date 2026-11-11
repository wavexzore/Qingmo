//! Meeting configuration defaults, patch protocol, migration and validation.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::services::meeting::asr_route::AsrMode;
use qingmo_lib::services::meeting::models::ManifestCatalog;
use qingmo_lib::services::meeting::remote_asr::RemoteProvider;
use qingmo_lib::services::meeting::summarize::LlmMode;
use qingmo_lib::state::meeting::config::{
    MeetingConfigPatch, MeetingConfigStore, RuntimeMode, MAX_KEY_REFS,
};

fn dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "qingmo-meeting-config-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn store(name: &str) -> (MeetingConfigStore, PathBuf) {
    let dir = dir(name);
    let catalog = Arc::new(ManifestCatalog::new(dir.join("models")));
    let path = store_path(name);
    (MeetingConfigStore::open(&path, catalog).unwrap(), path)
}

fn raw(name: &str, value: &str) -> (MeetingConfigStore, PathBuf) {
    let dir = dir(name);
    let path = store_path(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, value).unwrap();
    let catalog = Arc::new(ManifestCatalog::new(dir.join("models")));
    (MeetingConfigStore::open(&path, catalog).unwrap(), path)
}

#[test]
fn defaults_are_stable_and_revision_starts_at_zero() {
    let (store, path) = store("defaults");
    let snapshot = store.get();
    assert_eq!(snapshot.revision, 0);
    assert_eq!(snapshot.config.asr.mode, AsrMode::Local);
    assert_eq!(snapshot.config.asr.provider, RemoteProvider::OpenAi);
    assert_eq!(snapshot.config.llm.mode, LlmMode::Local);
    assert!(snapshot.config.llm.base_url.is_empty());
    assert!(snapshot.config.keep_transcript);
    assert_eq!(snapshot.config.max_minutes, 180);
    assert_eq!(snapshot.config.asr.local_model, None);
    assert!(!path.exists(), "defaults are not written until a change");
}

#[test]
fn patch_writes_only_given_fields_and_persists() {
    let (store, path) = store("patch");
    let revision = store
        .set(
            MeetingConfigPatch {
                runtime_mode: Some(RuntimeMode::Cpu),
                keep_transcript: Some(false),
                max_minutes: Some(45),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    assert_eq!(revision, 1);
    assert!(path.exists());
    let reloaded = {
        let catalog = Arc::new(ManifestCatalog::new(
            path.parent().unwrap().join("../models"),
        ));
        MeetingConfigStore::open(&path, catalog).unwrap()
    };
    let snapshot = reloaded.get();
    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.config.runtime.mode, RuntimeMode::Cpu);
    assert!(!snapshot.config.keep_transcript);
    assert_eq!(snapshot.config.max_minutes, 45);
    assert_eq!(snapshot.config.asr.mode, AsrMode::Local);
}

#[test]
fn revision_conflict_does_not_overwrite() {
    let (store, _) = store("conflict");
    store
        .set(
            MeetingConfigPatch {
                keep_transcript: Some(false),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    let error = store
        .set(
            MeetingConfigPatch {
                keep_transcript: Some(true),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert_eq!(
        error.details.unwrap()["reason"].as_str(),
        Some("config_revision")
    );
    assert!(!store.get().config.keep_transcript);
}

#[test]
fn invalid_values_do_not_reach_disk() {
    let (store, path) = store("invalid");
    let before = store.get().revision;

    let cases = [
        MeetingConfigPatch {
            asr_local_model: Some("qwen3-1.7b-instruct-q4km".into()),
            ..MeetingConfigPatch::default()
        },
        MeetingConfigPatch {
            llm_local_model: Some("paraformer-zh-en-int8".into()),
            ..MeetingConfigPatch::default()
        },
        MeetingConfigPatch {
            asr_api_key_ref: Some("Bad Ref".into()),
            ..MeetingConfigPatch::default()
        },
        MeetingConfigPatch {
            max_minutes: Some(4),
            ..MeetingConfigPatch::default()
        },
        MeetingConfigPatch {
            llm_base_url: Some("http://example.test".into()),
            ..MeetingConfigPatch::default()
        },
    ];
    for patch in cases {
        assert_eq!(
            store.set(patch, before).unwrap_err().code,
            AppErrorCode::InvalidConfig
        );
        assert_eq!(store.get().revision, before);
    }
    assert!(!path.exists());
}

#[test]
fn provider_change_clears_the_old_model_before_the_same_patch() {
    let (store, _) = store("provider");
    store
        .set(
            MeetingConfigPatch {
                asr_model: Some("whisper-1".into()),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    store
        .set(
            MeetingConfigPatch {
                asr_provider: Some(RemoteProvider::Groq),
                ..MeetingConfigPatch::default()
            },
            1,
        )
        .unwrap();
    assert_eq!(store.get().config.asr.model, "");

    store
        .set(
            MeetingConfigPatch {
                asr_provider: Some(RemoteProvider::Deepgram),
                asr_model: Some("nova-3".into()),
                ..MeetingConfigPatch::default()
            },
            2,
        )
        .unwrap();
    assert_eq!(store.get().config.asr.provider, RemoteProvider::Deepgram);
    assert_eq!(store.get().config.asr.model, "nova-3");
}

#[test]
fn empty_local_model_resets_to_automatic() {
    let (store, _) = store("reset");
    store
        .set(
            MeetingConfigPatch {
                asr_local_model: Some("paraformer-zh-en-int8".into()),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    assert_eq!(
        store.get().config.asr.local_model.as_deref(),
        Some("paraformer-zh-en-int8")
    );
    store
        .set(
            MeetingConfigPatch {
                asr_local_model: Some(String::new()),
                ..MeetingConfigPatch::default()
            },
            1,
        )
        .unwrap();
    assert_eq!(store.get().config.asr.local_model, None);
}

#[test]
fn base_url_is_normalized() {
    let (store, _) = store("base-url");
    store
        .set(
            MeetingConfigPatch {
                llm_base_url: Some("https://example.test/v1/".into()),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    assert_eq!(
        store.get().config.llm.base_url,
        "https://example.test/v1/chat/completions"
    );
    store
        .set(
            MeetingConfigPatch {
                llm_base_url: Some(String::new()),
                ..MeetingConfigPatch::default()
            },
            1,
        )
        .unwrap();
    assert!(store.get().config.llm.base_url.is_empty());
}

#[test]
fn schema_zero_is_migrated_once_and_missing_ids_fall_back() {
    let legacy = r#"{
        "schemaVersion": 0,
        "revision": 5,
        "meeting": {
            "enabled": true,
            "language": "zh",
            "speakerSeparate": true,
            "asr": {
                "backend": "local",
                "mode": "remote",
                "localModel": "missing-model",
                "provider": "groq",
                "model": "whisper-large-v3",
                "apiKeyRef": "Bad Ref"
            },
            "llm": {
                "mode": "remote",
                "localModel": "",
                "baseUrl": "http://localhost:11434/",
                "model": "local",
                "apiKeyRef": ""
            },
            "keepTranscript": false,
            "maxMinutes": 30
        },
        "keyRefs": ["asr.openai", "bad ref", "asr.openai"]
    }"#;
    let (store, path) = raw("migrate", legacy);
    let first = store.get();
    assert_eq!(first.schema_version, 1);
    assert_eq!(first.config.asr.local_model, None);
    assert_eq!(first.config.llm.local_model, None);
    assert_eq!(first.config.asr.api_key_ref, "");
    assert_eq!(first.config.asr.mode, AsrMode::Remote);
    assert_eq!(first.config.llm.mode, LlmMode::Remote);
    assert_eq!(first.config.max_minutes, 30);
    assert!(!first.config.keep_transcript);
    assert!(first.config.llm.base_url.ends_with("/v1/chat/completions"));
    assert!(first.config.key_refs.contains(&"asr.groq".to_owned()));
    assert!(!first.config.key_refs.contains(&"bad ref".to_owned()));
    assert_eq!(
        first
            .config
            .key_refs
            .iter()
            .filter(|item| *item == "asr.openai")
            .count(),
        1
    );

    let stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored["schemaVersion"], 1);
    let revision = store.get().revision;

    let catalog = Arc::new(ManifestCatalog::new(
        path.parent().unwrap().join("../models"),
    ));
    let second = MeetingConfigStore::open(&path, catalog).unwrap();
    assert_eq!(second.get().revision, revision);
    assert_eq!(second.get().config, first.config);
}

#[test]
fn key_ref_history_is_deduplicated_and_capped() {
    let (store, _) = store("key-refs");
    for index in 0..20 {
        store.note_key_ref(&format!("llm.k{index}")).unwrap();
    }
    let config = store.get().config;
    assert_eq!(config.key_refs.len(), MAX_KEY_REFS);
    assert!(config.key_refs.contains(&"llm.k19".to_owned()));
    assert!(config.key_refs.contains(&"asr.openai".to_owned()));
    let before = store.get().revision;
    store.note_key_ref("llm.k19").unwrap();
    assert_eq!(store.get().revision, before + 1);
    assert_eq!(
        store
            .get()
            .config
            .key_refs
            .iter()
            .filter(|item| *item == "llm.k19")
            .count(),
        1
    );
    assert_eq!(
        store.note_key_ref("Bad Ref").unwrap_err().code,
        AppErrorCode::InvalidConfig
    );
}

#[test]
fn derived_llm_ref_uses_the_base_url_hash() {
    let (store, _) = store("derived");
    store
        .set(
            MeetingConfigPatch {
                llm_base_url: Some("https://example.test".into()),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    let config = store.get().config;
    let reference = config.llm_key_ref();
    assert!(reference.starts_with("llm."));
    assert_eq!(reference.len(), 12);
    assert!(config.key_refs.contains(&reference));
}

#[test]
fn modes_round_trip_in_lowercase() {
    let (store, _) = store("modes");
    store
        .set(
            MeetingConfigPatch {
                runtime_mode: Some(RuntimeMode::Cpu),
                asr_mode: Some(AsrMode::Remote),
                llm_mode: Some(LlmMode::Remote),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    let json = fs::read_to_string(store_path("modes")).unwrap();
    assert!(json.contains("\"mode\": \"cpu\""));
    assert!(json.contains("\"mode\": \"remote\""));
}

fn store_path(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "qingmo-meeting-config-{}-{name}",
            std::process::id()
        ))
        .join("meeting")
        .join("config.json")
}
