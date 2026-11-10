//! Compiled model manifest and on-disk resolution.
//!
//! The installer ships zero models. Every pack below is downloaded into
//! `app_local_data_dir/meeting-models/<id>/` and resolved through the
//! `.ready` marker so a normal task never re-hashes gigabytes of weights.
//!
//! SHA-256 values are filled from the official release on first download
//! (T-011); an empty hash is treated as "not pinned yet" and only checked for
//! length until T-011 replaces it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::lang::Lang;
use crate::error::{AppError, AppErrorCode};

pub const MANIFEST_VERSION: u32 = 1;
const READY_TTL_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRole {
    Model,
    Encoder,
    Decoder,
    Joiner,
    Tokens,
    Segmentation,
    Embedding,
    Vad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarBz2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeakBasis {
    MeasuredRss,
    Estimated,
}

impl PeakBasis {
    pub fn margin(self, peak_mb: u32) -> u32 {
        match self {
            Self::MeasuredRss => peak_mb,
            Self::Estimated => peak_mb.saturating_mul(5) / 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    Asr,
    Segmentation,
    Embedding,
    Vad,
    Llm,
}

impl ModelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asr => "asr",
            Self::Segmentation => "segmentation",
            Self::Embedding => "embedding",
            Self::Vad => "vad",
            Self::Llm => "llm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrFamily {
    Paraformer,
    SenseVoice,
    ZipformerTransducer,
    FireRedCtc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum License {
    Apache2,
    Mit,
    FunAsr,
}

impl License {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Apache2 => "Apache-2.0",
            Self::Mit => "MIT",
            Self::FunAsr => "FunASR model license",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SourceUrl {
    pub url: &'static str,
    pub commit: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelFile {
    pub name: &'static str,
    pub role: FileRole,
    pub sha256: &'static str,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ArchiveSpec {
    pub format: ArchiveFormat,
    pub root: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelPack {
    pub id: &'static str,
    pub display: &'static str,
    pub kind: ModelKind,
    pub family: Option<AsrFamily>,
    pub license: License,
    pub license_url: &'static str,
    pub languages: &'static [Lang],
    pub peak_memory_mb: u32,
    pub peak_basis: PeakBasis,
    pub group: Option<&'static str>,
    pub download_bytes: u64,
    pub install_bytes: u64,
    pub source: &'static [SourceUrl],
    pub archive: Option<ArchiveSpec>,
    pub files: &'static [ModelFile],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelState {
    Ready,
    NotVerified,
    NotDownloaded,
    Partial,
    Missing,
    Verifying,
    Downloading,
    Corrupt,
    Failed,
}

pub trait ModelCatalog: Send + Sync {
    fn pack(&self, id: &str) -> Option<&'static ModelPack>;
    fn state(&self, id: &str) -> ModelState;
    fn path(&self, id: &str) -> Option<PathBuf>;
    fn root(&self) -> &Path;
}

const ASR_LANGS: &[Lang] = &[Lang::Zh, Lang::En];

const PARAFORMER_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model.int8.onnx",
        role: FileRole::Model,
        sha256: "f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945",
        bytes: 243_371_218,
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
        bytes: 75_756,
    },
];

const ZIPFORMER_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder-epoch-34-avg-19.int8.onnx",
        role: FileRole::Encoder,
        sha256: "28780a73b0fc5a05ec579ad4dbbc7d8fcd09fed5e6c431f84dcaab8f8170d9bf",
        bytes: 68_779_404,
    },
    ModelFile {
        name: "decoder-epoch-34-avg-19.onnx",
        role: FileRole::Decoder,
        sha256: "110dc19143f0731ce0f64513e524d7d8f729e37107e1392da790f66d6c936a0b",
        bytes: 5_089_010,
    },
    ModelFile {
        name: "joiner-epoch-34-avg-19.int8.onnx",
        role: FileRole::Joiner,
        sha256: "498861ff0963ecbbff101a940ed533a715e5d68ee96431a3b092d0ca00c3ba38",
        bytes: 1_048_576,
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "2d5d6245197582cea396b23fa29d592705be31bac9a97bb74a8d1bca3ca6a0e0",
        bytes: 25_600,
    },
];

const VAD_FILES: &[ModelFile] = &[ModelFile {
    name: "silero_vad.onnx",
    role: FileRole::Vad,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    bytes: 629_145,
}];

const PARA_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2",
    commit: "asr-models",
}];
const ZIP_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-zh-en-2023-11-22.tar.bz2",
    commit: "asr-models",
}];
const VAD_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    commit: "asr-models",
}];

pub static CATALOG: &[ModelPack] = &[
    ModelPack {
        id: "paraformer-zh-en-int8",
        display: "Paraformer 中英 · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::Paraformer),
        license: License::Apache2,
        license_url: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
        languages: ASR_LANGS,
        peak_memory_mb: 1200,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 223_400_000,
        install_bytes: 223_400_000,
        source: PARA_SOURCE,
        archive: Some(ArchiveSpec {
            format: ArchiveFormat::TarBz2,
            root: "sherpa-onnx-paraformer-zh-2023-09-14",
            bytes: 223_400_000,
            sha256: "",
        }),
        files: PARAFORMER_FILES,
    },
    ModelPack {
        id: "paraformer-zh-small-int8",
        display: "Paraformer 中文 small · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::Paraformer),
        license: License::Apache2,
        license_url: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
        languages: ASR_LANGS,
        peak_memory_mb: 700,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 81_800_000,
        install_bytes: 81_800_000,
        source: PARA_SOURCE,
        archive: None,
        files: PARAFORMER_FILES,
    },
    ModelPack {
        id: "zipformer-zh-en-int8",
        display: "Zipformer 中英 · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::ZipformerTransducer),
        license: License::Apache2,
        license_url: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
        languages: ASR_LANGS,
        peak_memory_mb: 1400,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 312_400_000,
        install_bytes: 316_000_000,
        source: ZIP_SOURCE,
        archive: Some(ArchiveSpec {
            format: ArchiveFormat::TarBz2,
            root: "sherpa-onnx-zipformer-zh-en-2023-11-22",
            bytes: 312_400_000,
            sha256: "",
        }),
        files: ZIPFORMER_FILES,
    },
    ModelPack {
        id: "fireredasr2-ctc-int8",
        display: "FireRedASR2-CTC · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::FireRedCtc),
        license: License::Apache2,
        license_url: "https://github.com/FireRedTeam/FireRedASR",
        languages: ASR_LANGS,
        peak_memory_mb: 2000,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 740_000_000,
        install_bytes: 742_000_000,
        source: &[],
        archive: None,
        files: &[],
    },
    ModelPack {
        id: "sensevoice-small-int8",
        display: "SenseVoice Small · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::SenseVoice),
        license: License::FunAsr,
        license_url: "https://github.com/FunAudioLLM/SenseVoice",
        languages: ASR_LANGS,
        peak_memory_mb: 1000,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 239_200_000,
        install_bytes: 239_200_000,
        source: &[],
        archive: None,
        files: &[],
    },
    ModelPack {
        id: "silero-vad",
        display: "Silero VAD",
        kind: ModelKind::Vad,
        family: None,
        license: License::Mit,
        license_url: "https://github.com/snakers4/silero-vad/blob/master/LICENSE",
        languages: &[],
        peak_memory_mb: 20,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 629_145,
        install_bytes: 629_145,
        source: VAD_SOURCE,
        archive: None,
        files: VAD_FILES,
    },
    ModelPack {
        id: "qwen3-1.7b-instruct-q4km",
        display: "Qwen3 1.7B Instruct · Q4_K_M",
        kind: ModelKind::Llm,
        family: None,
        license: License::Apache2,
        license_url: "https://huggingface.co/unsloth",
        languages: ASR_LANGS,
        peak_memory_mb: 2050,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 1_100_000_000,
        install_bytes: 1_100_000_000,
        source: &[],
        archive: None,
        files: &[],
    },
    ModelPack {
        id: "qwen3-4b-instruct-q4km",
        display: "Qwen3 4B Instruct · Q4_K_M",
        kind: ModelKind::Llm,
        family: None,
        license: License::Apache2,
        license_url: "https://huggingface.co/unsloth",
        languages: ASR_LANGS,
        peak_memory_mb: 3560,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 2_500_000_000,
        install_bytes: 2_500_000_000,
        source: &[],
        archive: None,
        files: &[],
    },
    ModelPack {
        id: "qwen3-8b-instruct-q4km",
        display: "Qwen3 8B Instruct · Q4_K_M",
        kind: ModelKind::Llm,
        family: None,
        license: License::Apache2,
        license_url: "https://huggingface.co/unsloth",
        languages: ASR_LANGS,
        peak_memory_mb: 6000,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 4_900_000_000,
        install_bytes: 4_900_000_000,
        source: &[],
        archive: None,
        files: &[],
    },
];

pub fn find(id: &str) -> Option<&'static ModelPack> {
    CATALOG.iter().find(|pack| pack.id == id)
}

pub fn manifest() -> &'static [ModelPack] {
    CATALOG
}

pub struct ManifestCatalog {
    root: PathBuf,
}

impl ManifestCatalog {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn resolve(&self, id: &str) -> ModelState {
        let Some(pack) = find(id) else {
            return ModelState::NotDownloaded;
        };
        resolve_pack(&self.root, pack, unix_now())
    }
}

impl ModelCatalog for ManifestCatalog {
    fn pack(&self, id: &str) -> Option<&'static ModelPack> {
        find(id)
    }

    fn state(&self, id: &str) -> ModelState {
        self.resolve(id)
    }

    fn path(&self, id: &str) -> Option<PathBuf> {
        find(id).map(|pack| self.root.join(pack.id))
    }

    fn root(&self) -> &Path {
        &self.root
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReadyMarker {
    manifest_version: u32,
    verified_at: u64,
    files: Vec<ReadyFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ReadyFile {
    name: String,
    bytes: u64,
    sha256: String,
}

pub fn resolve_pack(root: &Path, pack: &ModelPack, now_secs: u64) -> ModelState {
    let dir = root.join(pack.id);
    if !dir.is_dir() {
        return ModelState::NotDownloaded;
    }

    let mut sizes = Vec::with_capacity(pack.files.len());
    for file in pack.files {
        let path = dir.join(file.name);
        let Ok(meta) = fs::metadata(&path) else {
            return ModelState::Missing;
        };
        if !meta.is_file() {
            return ModelState::Missing;
        }
        if meta.len() != file.bytes {
            return ModelState::Corrupt;
        }
        sizes.push(meta.len());
    }

    let marker_path = dir.join(".ready");
    let marker = fs::read(&marker_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ReadyMarker>(&bytes).ok());

    let Some(marker) = marker else {
        return ModelState::NotVerified;
    };
    if marker.manifest_version != MANIFEST_VERSION || marker.files.len() != pack.files.len() {
        return ModelState::NotVerified;
    }
    for (file, recorded) in pack.files.iter().zip(&marker.files) {
        if recorded.name != file.name || recorded.bytes != file.bytes {
            return ModelState::NotVerified;
        }
        if !file.sha256.is_empty() && recorded.sha256 != file.sha256 {
            return ModelState::NotVerified;
        }
    }
    if now_secs.saturating_sub(marker.verified_at) <= READY_TTL_SECS {
        return ModelState::Ready;
    }

    // Expired: re-hash once and refresh the marker.
    for file in pack.files {
        if file.sha256.is_empty() {
            continue;
        }
        let Ok(actual) = sha256_file(&dir.join(file.name)) else {
            return ModelState::Corrupt;
        };
        if actual != file.sha256 {
            return ModelState::Corrupt;
        }
    }
    if write_ready(&dir, pack, now_secs).is_err() {
        return ModelState::Corrupt;
    }
    ModelState::Ready
}

/// Write the `.ready` marker after every file hash has been verified.
pub fn write_ready(dir: &Path, pack: &ModelPack, now_secs: u64) -> Result<(), AppError> {
    let mut files = Vec::with_capacity(pack.files.len());
    for file in pack.files {
        let actual = sha256_file(&dir.join(file.name))?;
        if !file.sha256.is_empty() && actual != file.sha256 {
            return Err(AppError::new(
                AppErrorCode::ModelNotReady,
                "model hash mismatch",
            ));
        }
        files.push(ReadyFile {
            name: file.name.to_owned(),
            bytes: file.bytes,
            sha256: actual,
        });
    }
    let marker = ReadyMarker {
        manifest_version: MANIFEST_VERSION,
        verified_at: now_secs,
        files,
    };
    let encoded = serde_json::to_vec_pretty(&marker)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
    fs::write(dir.join(".ready"), encoded)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))
}

pub fn sha256_file(path: &Path) -> Result<String, AppError> {
    let bytes =
        fs::read(path).map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qingmo-models-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_pack(root: &Path, pack: &ModelPack) {
        let dir = root.join(pack.id);
        fs::create_dir_all(&dir).unwrap();
        for file in pack.files {
            fs::write(dir.join(file.name), vec![7u8; file.bytes as usize]).unwrap();
        }
    }

    fn pack() -> &'static ModelPack {
        find("silero-vad").unwrap()
    }

    #[test]
    fn missing_directory_is_not_downloaded() {
        let root = temp_root();
        assert_eq!(resolve_pack(&root, pack(), 1), ModelState::NotDownloaded);
    }

    #[test]
    fn length_mismatch_is_corrupt() {
        let root = temp_root();
        write_pack(&root, pack());
        fs::write(root.join(pack().id).join("silero_vad.onnx"), b"short").unwrap();
        assert_eq!(resolve_pack(&root, pack(), 1), ModelState::Corrupt);
    }

    #[test]
    fn no_marker_is_not_verified() {
        let root = temp_root();
        write_pack(&root, pack());
        assert_eq!(resolve_pack(&root, pack(), 1), ModelState::NotVerified);
    }

    #[test]
    fn fresh_marker_is_ready_without_hashes() {
        let root = temp_root();
        write_pack(&root, pack());
        let marker = ReadyMarker {
            manifest_version: MANIFEST_VERSION,
            verified_at: 1_000,
            files: pack()
                .files
                .iter()
                .map(|file| ReadyFile {
                    name: file.name.to_owned(),
                    bytes: file.bytes,
                    sha256: file.sha256.to_owned(),
                })
                .collect(),
        };
        fs::write(
            root.join(pack().id).join(".ready"),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        assert_eq!(resolve_pack(&root, pack(), 1_010), ModelState::Ready);
    }

    #[test]
    fn expired_marker_rehashes_and_fails_on_wrong_hash() {
        let root = temp_root();
        write_pack(&root, pack());
        let wrong = ReadyMarker {
            manifest_version: MANIFEST_VERSION,
            verified_at: 1,
            files: pack()
                .files
                .iter()
                .map(|file| ReadyFile {
                    name: file.name.to_owned(),
                    bytes: file.bytes,
                    sha256: "deadbeef".into(),
                })
                .collect(),
        };
        fs::write(
            root.join(pack().id).join(".ready"),
            serde_json::to_vec(&wrong).unwrap(),
        )
        .unwrap();
        assert_eq!(
            resolve_pack(&root, pack(), READY_TTL_SECS + 10),
            ModelState::NotVerified
        );
    }

    #[test]
    fn catalog_kinds_and_families_cross_check() {
        for pack in manifest() {
            match pack.kind {
                ModelKind::Asr => assert!(pack.family.is_some(), "{}", pack.id),
                _ => assert!(pack.family.is_none(), "{}", pack.id),
            }
            assert!(!pack.license_url.is_empty(), "{}", pack.id);
        }
    }
}
