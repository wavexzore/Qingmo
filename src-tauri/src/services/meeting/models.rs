//! Compiled model manifest and on-disk resolution.
//!
//! The installer ships zero models. Every pack below is downloaded into
//! `app_local_data_dir/models/<id>/` and resolved through the
//! `.ready` marker so a normal task never re-hashes gigabytes of weights.
//!
//! Every file pins its official URL, commit and SHA-256. An empty hash is
//! still accepted as "not pinned yet" for future packs, but the shipped
//! manifest has no empty hash.

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
    /// Direct download location for this file.
    pub source: SourceUrl,
}

#[derive(Debug, Clone, Copy)]
pub struct ArchiveSpec {
    pub format: ArchiveFormat,
    pub root: &'static str,
    /// Files that must exist under `root` and are moved to the pack root.
    pub root_files: &'static [&'static str],
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

    /// File a runtime loads directly (VAD/LLM). ASR drivers still take the
    /// pack directory because they read several files by name.
    fn model_file(&self, id: &str) -> Option<PathBuf> {
        let pack = self.pack(id)?;
        let role = match pack.kind {
            ModelKind::Vad => FileRole::Vad,
            _ => FileRole::Model,
        };
        let file = pack.files.iter().find(|file| file.role == role)?;
        self.path(id).map(|dir| dir.join(file.name))
    }
}

const ASR_LANGS: &[Lang] = &[Lang::Zh, Lang::En];

const PARAFORMER_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model.int8.onnx",
        role: FileRole::Model,
        sha256: "f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945",
        bytes: 243_371_218,
        source: PARA_SOURCE[0],
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
        bytes: 75_756,
        source: PARA_SOURCE[0],
    },
];

const ZIPFORMER_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder-epoch-34-avg-19.int8.onnx",
        role: FileRole::Encoder,
        sha256: "28780a73b0fc5a05ec579ad4dbbc7d8fcd09fed5e6c431f84dcaab8f8170d9bf",
        bytes: 69_037_476,
        source: ZIP_SOURCE[0],
    },
    ModelFile {
        name: "decoder-epoch-34-avg-19.onnx",
        role: FileRole::Decoder,
        sha256: "110dc19143f0731ce0f64513e524d7d8f729e37107e1392da790f66d6c936a0b",
        bytes: 5_165_101,
        source: ZIP_SOURCE[0],
    },
    ModelFile {
        name: "joiner-epoch-34-avg-19.int8.onnx",
        role: FileRole::Joiner,
        sha256: "498861ff0963ecbbff101a940ed533a715e5d68ee96431a3b092d0ca00c3ba38",
        bytes: 1_033_479,
        source: ZIP_SOURCE[0],
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "2d5d6245197582cea396b23fa29d592705be31bac9a97bb74a8d1bca3ca6a0e0",
        bytes: 25_645,
        source: ZIP_SOURCE[0],
    },
];

const VAD_FILES: &[ModelFile] = &[ModelFile {
    name: "silero_vad.onnx",
    role: FileRole::Vad,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    bytes: 643_854,
    source: VAD_SOURCE[0],
}];
const SMALL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model.int8.onnx",
        role: FileRole::Model,
        sha256: "3ef6c19369b912f7caf3cef8e545c5ccd1a33d9d7ec792a46668dc41c4b229ec",
        bytes: 81_828_675,
        source: SMALL_SOURCE[0],
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "4b2d964e18b9cf139b473003b6698fb2ed9a2a5ec55b93daa677b28f578897aa",
        bytes: 75_352,
        source: SMALL_SOURCE[0],
    },
];

const FIRE_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model.int8.onnx",
        role: FileRole::Model,
        sha256: "ca3dbabd82170110cc0b343c2890866d449984bc9cd92b9a18371ff80a81bb99",
        bytes: 775_861_420,
        source: FIRE_SOURCE[0],
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "1bc613de2112d257e61a349c3e72d1b1a9cf19c33d3ca954197ad2171e5ea07b",
        bytes: 79_172,
        source: FIRE_SOURCE[0],
    },
];

const SENSE_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model.int8.onnx",
        role: FileRole::Model,
        sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
        bytes: 239_233_841,
        source: SENSE_SOURCE[0],
    },
    ModelFile {
        name: "tokens.txt",
        role: FileRole::Tokens,
        sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
        bytes: 315_894,
        source: SENSE_SOURCE[0],
    },
];

const QWEN_17_FILES: &[ModelFile] = &[ModelFile {
    name: "Qwen3-1.7B-Q4_K_M.gguf",
    role: FileRole::Model,
    sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    bytes: 1_107_409_472,
    source: QWEN_17_SOURCE[0],
}];
const QWEN_4_FILES: &[ModelFile] = &[ModelFile {
    name: "Qwen3-4B-Q4_K_M.gguf",
    role: FileRole::Model,
    sha256: "f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a",
    bytes: 2_497_281_312,
    source: QWEN_4_SOURCE[0],
}];
const QWEN_8_FILES: &[ModelFile] = &[ModelFile {
    name: "Qwen3-8B-Q4_K_M.gguf",
    role: FileRole::Model,
    sha256: "120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4",
    bytes: 5_027_784_512,
    source: QWEN_8_SOURCE[0],
}];
const SPEAKER_SEG_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main",
    commit: "9403a6902bb58e3d5ae8c7e77c3422de279db2e0",
}];
const SPEAKER_EMB_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main",
    commit: "0743f301363dec56491a490f6d6cbc9d67f9a3bf",
}];
const SPEAKER_SEG_FILES: &[ModelFile] = &[ModelFile {
    name: "model.int8.onnx",
    role: FileRole::Segmentation,
    sha256: "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d",
    bytes: 1_540_506,
    source: SPEAKER_SEG_SOURCE[0],
}];
const SPEAKER_EMB_FILES: &[ModelFile] = &[ModelFile {
    name: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    role: FileRole::Embedding,
    sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    bytes: 28_281_164,
    source: SPEAKER_EMB_SOURCE[0],
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
const SMALL_SOURCE: &[SourceUrl] = &[SourceUrl {
    url:
        "https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main",
    commit: "63ddc3cd0f2810b68289a7b3876e62ef5d53d6df",
}];
const FIRE_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/csukuangfj2/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/resolve/main",
    commit: "423be1acfdc5d8aaa5a485fb6263fe4ea8570b06",
}];
const SENSE_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
    commit: "2365baeacb507f821a0c8120fcee3d484dba7a07",
}];
const QWEN_17_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main",
    commit: "d7f544eead698dbd1f15126ef60b45a1e1933222",
}];
const QWEN_4_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main",
    commit: "22c9fc8a8c7700b76a1789366280a6a5a1ad1120",
}];
const QWEN_8_SOURCE: &[SourceUrl] = &[SourceUrl {
    url: "https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main",
    commit: "a6adef130ffb23ddaf1a62fec9dced968c9bc482",
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
        download_bytes: 234_051_698,
        install_bytes: 243_446_974,
        source: PARA_SOURCE,
        archive: Some(ArchiveSpec {
            format: ArchiveFormat::TarBz2,
            root: "sherpa-onnx-paraformer-zh-2023-09-14",
            root_files: &["model.int8.onnx", "tokens.txt"],
            bytes: 234_051_698,
            sha256: "9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03",
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
        download_bytes: 81_904_027,
        install_bytes: 81_904_027,
        source: SMALL_SOURCE,
        archive: None,
        files: SMALL_FILES,
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
        download_bytes: 312_398_028,
        install_bytes: 75_261_701,
        source: ZIP_SOURCE,
        archive: Some(ArchiveSpec {
            format: ArchiveFormat::TarBz2,
            root: "sherpa-onnx-zipformer-zh-en-2023-11-22",
            root_files: &[
                "encoder-epoch-34-avg-19.int8.onnx",
                "decoder-epoch-34-avg-19.onnx",
                "joiner-epoch-34-avg-19.int8.onnx",
                "tokens.txt",
            ],
            bytes: 312_398_028,
            sha256: "0c3f2b9c884335a6931b8ccee6ede30e8dd3f89efc289ff64cd79d530a3bcf91",
        }),
        files: ZIPFORMER_FILES,
    },
    ModelPack {
        id: "fireredasr2-ctc-int8",
        display: "FireRedASR2-CTC · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::FireRedCtc),
        license: License::Apache2,
        license_url: "https://github.com/FireRedTeam/FireRedASR/blob/main/LICENSE",
        languages: ASR_LANGS,
        peak_memory_mb: 2000,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 775_940_592,
        install_bytes: 775_940_592,
        source: FIRE_SOURCE,
        archive: None,
        files: FIRE_FILES,
    },
    ModelPack {
        id: "sensevoice-small-int8",
        display: "SenseVoice Small · int8",
        kind: ModelKind::Asr,
        family: Some(AsrFamily::SenseVoice),
        license: License::FunAsr,
        license_url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
        languages: ASR_LANGS,
        peak_memory_mb: 1000,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 239_549_735,
        install_bytes: 239_549_735,
        source: SENSE_SOURCE,
        archive: None,
        files: SENSE_FILES,
    },
    ModelPack {
        id: "pyannote-segmentation-3-int8",
        display: "pyannote segmentation 3.0 · int8",
        kind: ModelKind::Segmentation,
        family: None,
        license: License::Mit,
        license_url: "https://github.com/pyannote/pyannote-audio/blob/develop/LICENSE",
        languages: &[],
        peak_memory_mb: 40,
        peak_basis: PeakBasis::Estimated,
        group: Some("speaker-pack"),
        download_bytes: 1_540_506,
        install_bytes: 1_540_506,
        source: SPEAKER_SEG_SOURCE,
        archive: None,
        files: SPEAKER_SEG_FILES,
    },
    ModelPack {
        id: "campplus-zh-en-advanced",
        display: "CAM++ zh_en · advanced",
        kind: ModelKind::Embedding,
        family: None,
        license: License::Apache2,
        license_url: "https://github.com/modelscope/3D-Speaker/blob/main/LICENSE",
        languages: &[],
        peak_memory_mb: 60,
        peak_basis: PeakBasis::Estimated,
        group: Some("speaker-pack"),
        download_bytes: 28_281_164,
        install_bytes: 28_281_164,
        source: SPEAKER_EMB_SOURCE,
        archive: None,
        files: SPEAKER_EMB_FILES,
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
        download_bytes: 643_854,
        install_bytes: 643_854,
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
        license_url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF",
        languages: ASR_LANGS,
        peak_memory_mb: 2050,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 1_107_409_472,
        install_bytes: 1_107_409_472,
        source: QWEN_17_SOURCE,
        archive: None,
        files: QWEN_17_FILES,
    },
    ModelPack {
        id: "qwen3-4b-instruct-q4km",
        display: "Qwen3 4B Instruct · Q4_K_M",
        kind: ModelKind::Llm,
        family: None,
        license: License::Apache2,
        license_url: "https://huggingface.co/unsloth/Qwen3-4B-GGUF",
        languages: ASR_LANGS,
        peak_memory_mb: 3560,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 2_497_281_312,
        install_bytes: 2_497_281_312,
        source: QWEN_4_SOURCE,
        archive: None,
        files: QWEN_4_FILES,
    },
    ModelPack {
        id: "qwen3-8b-instruct-q4km",
        display: "Qwen3 8B Instruct · Q4_K_M",
        kind: ModelKind::Llm,
        family: None,
        license: License::Apache2,
        license_url: "https://huggingface.co/unsloth/Qwen3-8B-GGUF",
        languages: ASR_LANGS,
        peak_memory_mb: 6000,
        peak_basis: PeakBasis::Estimated,
        group: None,
        download_bytes: 5_027_784_512,
        install_bytes: 5_027_784_512,
        source: QWEN_8_SOURCE,
        archive: None,
        files: QWEN_8_FILES,
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

/// Downloaded-pack root. Release builds used to store packs under
/// `meeting-models/`; rename that directory once so existing installs keep
/// working without a second download.
pub fn data_root(app_local_data: &Path) -> PathBuf {
    let root = app_local_data.join("models");
    let legacy = app_local_data.join("meeting-models");
    if !root.exists() && legacy.is_dir() {
        let _ = fs::rename(&legacy, &root);
    }
    root
}

pub fn resolve_pack(root: &Path, pack: &ModelPack, now_secs: u64) -> ModelState {
    let dir = root.join(pack.id);
    if !dir.is_dir() {
        return ModelState::NotDownloaded;
    }

    let mut sizes = Vec::with_capacity(pack.files.len());
    for (index, file) in pack.files.iter().enumerate() {
        let path = dir.join(file.name);
        let Ok(meta) = fs::metadata(&path) else {
            return if index > 0 {
                ModelState::Partial
            } else {
                ModelState::Missing
            };
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
        let path = dir.join(file.name);
        if fs::metadata(&path)
            .map_err(|error| AppError::from_io(&error))?
            .len()
            != file.bytes
        {
            return Err(AppError::new(
                AppErrorCode::ModelNotReady,
                "model length mismatch",
            ));
        }
        let actual = sha256_file(&path)?;
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

pub fn unix_now_public() -> u64 {
    unix_now()
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
    fn data_root_migrates_the_legacy_models_directory() {
        let dir = temp_root();
        fs::create_dir_all(dir.join("meeting-models")).unwrap();
        fs::write(dir.join("meeting-models").join("pack.bin"), b"x").unwrap();

        let root = data_root(&dir);

        assert!(root.ends_with("models"));
        assert!(root.join("pack.bin").is_file());
        assert!(!dir.join("meeting-models").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn model_file_joins_the_runtime_file_for_vad_and_llm() {
        let root = temp_root();
        let catalog = ManifestCatalog::new(root.clone());
        let vad = catalog.model_file("silero-vad").unwrap();
        assert_eq!(vad.file_name().unwrap(), "silero_vad.onnx");
        let llm = catalog.model_file("qwen3-4b-instruct-q4km").unwrap();
        assert_eq!(llm.file_name().unwrap(), "Qwen3-4B-Q4_K_M.gguf");
        assert_eq!(catalog.model_file("unknown-pack"), None);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn license_links_point_at_the_license_not_the_repository() {
        let url = |id: &str| {
            manifest()
                .iter()
                .find(|pack| pack.id == id)
                .unwrap()
                .license_url
        };
        assert!(url("fireredasr2-ctc-int8").ends_with("/LICENSE"));
        assert!(url("sensevoice-small-int8").ends_with("/MODEL_LICENSE"));
        for id in [
            "qwen3-1.7b-instruct-q4km",
            "qwen3-4b-instruct-q4km",
            "qwen3-8b-instruct-q4km",
        ] {
            assert!(url(id).starts_with("https://huggingface.co/unsloth/Qwen3-"));
        }
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
