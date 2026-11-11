//! Manifest completeness and on-disk state mapping.

use std::path::Path;

use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::services::meeting::download::{
    ensure_space, recover_orphans, required_bytes, DiskProbe, STAGING_DIR,
};
use qingmo_lib::services::meeting::models::{
    find, manifest, resolve_pack, sha256_file, FileRole, License, ModelFile, ModelKind, ModelPack,
    ModelState, PeakBasis, SourceUrl,
};
use qingmo_lib::services::meeting::ManifestCatalog;
use qingmo_lib::state::meeting::config::MeetingConfigPatch;
use qingmo_lib::state::MeetingConfigStore;

static TEST_SOURCE: [SourceUrl; 1] = [SourceUrl {
    url: "https://example.invalid/file",
    commit: "test",
}];
static TEST_FILES: [ModelFile; 2] = [
    ModelFile {
        name: "file.bin",
        role: FileRole::Vad,
        sha256: "",
        bytes: 2,
        source: TEST_SOURCE[0],
    },
    ModelFile {
        name: "extra.bin",
        role: FileRole::Vad,
        sha256: "",
        bytes: 1,
        source: TEST_SOURCE[0],
    },
];
static TEST_PACK: ModelPack = ModelPack {
    id: "test-pack",
    display: "Test",
    kind: ModelKind::Vad,
    family: None,
    license: License::Mit,
    license_url: "https://example.invalid",
    languages: &[],
    peak_memory_mb: 1,
    peak_basis: PeakBasis::MeasuredRss,
    group: None,
    download_bytes: 3,
    install_bytes: 3,
    source: &TEST_SOURCE,
    archive: None,
    files: &TEST_FILES,
};

fn temp_root() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-model-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct FixedDisk(u64);

impl DiskProbe for FixedDisk {
    fn free_bytes(&self, _path: &Path) -> Result<u64, AppError> {
        Ok(self.0)
    }
}

#[test]
fn every_pack_declares_sources_files_and_roles() {
    for pack in manifest() {
        assert!(!pack.source.is_empty(), "{} has no source", pack.id);
        assert!(!pack.files.is_empty(), "{} has no files", pack.id);
        assert!(pack.download_bytes > 0, "{} has no download bytes", pack.id);
        for file in pack.files {
            assert!(!file.name.is_empty());
            assert!(file.bytes > 0);
            assert!(
                !file.sha256.is_empty(),
                "{}/{} has no hash",
                pack.id,
                file.name
            );
            assert!(!file.source.url.is_empty());
        }
        if let Some(archive) = pack.archive {
            assert!(!archive.root.is_empty());
            assert_eq!(archive.root_files.len(), pack.files.len());
            for file in pack.files {
                assert!(archive.root_files.contains(&file.name));
            }
        }
        match pack.kind {
            ModelKind::Asr => {
                assert!(pack.family.is_some(), "{} is ASR without family", pack.id);
                let single_model = pack.files.iter().any(|file| file.role == FileRole::Model);
                let transducer = pack.files.iter().any(|file| file.role == FileRole::Encoder)
                    && pack.files.iter().any(|file| file.role == FileRole::Joiner);
                assert!(single_model || transducer, "{} has no model files", pack.id);
                assert!(pack.files.iter().any(|file| file.role == FileRole::Tokens));
            }
            ModelKind::Llm => {
                assert_eq!(pack.files.len(), 1);
                assert_eq!(pack.files[0].role, FileRole::Model);
            }
            ModelKind::Vad => {
                assert!(pack.files.iter().all(|file| file.role == FileRole::Vad));
            }
            ModelKind::Segmentation => {
                assert_eq!(pack.group, Some("speaker-pack"));
                assert!(pack
                    .files
                    .iter()
                    .all(|file| file.role == FileRole::Segmentation));
            }
            ModelKind::Embedding => {
                assert_eq!(pack.group, Some("speaker-pack"));
                assert!(pack
                    .files
                    .iter()
                    .all(|file| file.role == FileRole::Embedding));
            }
        }
    }
    assert_eq!(find("paraformer-zh-en-int8").unwrap().kind, ModelKind::Asr);
    assert_eq!(manifest().len(), 11);
}

#[test]
fn manifest_byte_counts_match_the_declared_files() {
    for pack in manifest() {
        if pack.archive.is_some() {
            continue;
        }
        let sum: u64 = pack.files.iter().map(|file| file.bytes).sum();
        assert_eq!(pack.download_bytes, sum, "{}", pack.id);
        assert_eq!(pack.install_bytes, sum, "{}", pack.id);
    }
}

#[test]
fn disk_formula_and_disk_full_details() {
    assert_eq!(required_bytes(10_000, 0), 10_000 + 64 * 1024 * 1024);
    assert_eq!(required_bytes(100_000_000, 100), 200_000_000);
    let pack = find("paraformer-zh-en-int8").unwrap();
    let required = required_bytes(pack.download_bytes, pack.install_bytes);
    let error = ensure_space(&FixedDisk(required - 1), Path::new("/tmp"), pack)
        .expect_err("one byte short must fail");
    assert_eq!(error.code, AppErrorCode::ModelDownloadFailed);
    assert_eq!(error.details.as_ref().unwrap()["reason"], "disk_full");
    assert_eq!(error.details.as_ref().unwrap()["requiredBytes"], required);
    ensure_space(&FixedDisk(required), Path::new("/tmp"), pack).expect("exact headroom");
}

#[test]
fn state_mapping_distinguishes_missing_partial_and_corrupt() {
    let root = temp_root();
    let pack = &TEST_PACK;
    assert_eq!(resolve_pack(&root, pack, 1), ModelState::NotDownloaded);
    let dir = root.join(pack.id);
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(resolve_pack(&root, pack, 1), ModelState::Missing);

    let file = dir.join(pack.files[0].name);
    std::fs::write(&file, b"x").unwrap();
    assert_eq!(resolve_pack(&root, pack, 1), ModelState::Corrupt);

    std::fs::write(&file, b"ok").unwrap();
    assert_eq!(resolve_pack(&root, pack, 1), ModelState::Partial);
    std::fs::write(dir.join(pack.files[1].name), b"x").unwrap();
    assert_eq!(resolve_pack(&root, pack, 1), ModelState::NotVerified);
    let marker = serde_json::json!({
        "manifest_version": 1,
        "verified_at": 1,
        "files": [
            {
                "name": pack.files[0].name,
                "bytes": pack.files[0].bytes,
                "sha256": sha256_file(&file).unwrap(),
            },
            {
                "name": pack.files[1].name,
                "bytes": pack.files[1].bytes,
                "sha256": sha256_file(&dir.join(pack.files[1].name)).unwrap(),
            },
        ],
    });
    std::fs::write(dir.join(".ready"), serde_json::to_vec(&marker).unwrap()).unwrap();
    assert_eq!(resolve_pack(&root, pack, 2), ModelState::Ready);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn orphan_commit_restores_the_backup() {
    let root = temp_root();
    let id = "paraformer-zh-en-int8";
    let staging_root = root.join(STAGING_DIR);
    let backup = staging_root.join(format!("{id}.old-test"));
    std::fs::create_dir_all(&backup).unwrap();
    std::fs::write(backup.join("silero_vad.onnx"), b"old").unwrap();
    let log = serde_json::json!({
        "id": id,
        "staging": staging_root.join("download").to_string_lossy(),
        "backup": backup.to_string_lossy(),
    });
    std::fs::write(
        staging_root.join("download.commit.json"),
        serde_json::to_vec(&log).unwrap(),
    )
    .unwrap();

    recover_orphans(&root);
    assert!(root.join(id).join("silero_vad.onnx").is_file());
    assert!(!backup.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn removing_the_current_local_model_clears_it() {
    let root = temp_root();
    let catalog: std::sync::Arc<dyn qingmo_lib::services::meeting::ModelCatalog> =
        std::sync::Arc::new(ManifestCatalog::new(root.clone()));
    let store = MeetingConfigStore::open(root.join("meeting/config.json"), catalog).unwrap();
    let revision = store
        .set(
            MeetingConfigPatch {
                asr_local_model: Some("paraformer-zh-en-int8".into()),
                ..MeetingConfigPatch::default()
            },
            0,
        )
        .unwrap();
    let next = store.clear_local_model("paraformer-zh-en-int8").unwrap();
    assert_eq!(next, revision + 1);
    assert_eq!(store.get().config.asr.local_model, None);
    assert_eq!(store.clear_local_model("other").unwrap(), next);
}

#[test]
fn expired_ready_marker_rehashes_once() {
    let root = temp_root();
    let dir = root.join(TEST_PACK.id);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(TEST_PACK.files[0].name);
    std::fs::write(&file, b"ok").unwrap();
    std::fs::write(dir.join(TEST_PACK.files[1].name), b"x").unwrap();
    let marker = serde_json::json!({
        "manifest_version": 1,
        "verified_at": 1,
        "files": [
            {
                "name": TEST_PACK.files[0].name,
                "bytes": 2,
                "sha256": "wrong",
            },
            {
                "name": TEST_PACK.files[1].name,
                "bytes": 1,
                "sha256": "wrong",
            },
        ],
    });
    std::fs::write(dir.join(".ready"), serde_json::to_vec(&marker).unwrap()).unwrap();
    // The recorded hash is stale, but the manifest hash is empty here, so the
    // TTL expiry path must re-hash and rewrite the marker; both accept it.
    assert_eq!(
        resolve_pack(&root, &TEST_PACK, 40 * 24 * 60 * 60),
        ModelState::Ready
    );
    let refreshed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(".ready")).unwrap()).unwrap();
    assert_ne!(refreshed["verified_at"], 1);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_packs_declare_the_exact_archive_length_and_hash() {
    for pack in manifest().iter().filter(|pack| pack.archive.is_some()) {
        let spec = pack.archive.expect("archive");
        assert_eq!(
            pack.download_bytes, spec.bytes,
            "{} download bytes must be the archive length",
            pack.id
        );
        assert!(
            spec.sha256.len() == 64 && spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
            "{} needs a hex sha256",
            pack.id
        );
        assert!(spec.bytes > 0);
        let installed: u64 = pack.files.iter().map(|file| file.bytes).sum();
        assert_eq!(pack.install_bytes, installed, "{} install bytes", pack.id);
    }
}
