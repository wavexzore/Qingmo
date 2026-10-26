#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use qingmo_lib::error::AppError;
use qingmo_lib::ipc::dto::{FilePayload, SaveResult};
use qingmo_lib::services::AtomicWriter;
use qingmo_lib::state::DocumentRegistry;
use tempfile::TempDir;

pub fn write_file(dir: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.path().join(name);
    fs::write(&path, bytes).expect("fixture must be written");
    path
}

pub fn open_file(registry: &DocumentRegistry, path: PathBuf) -> FilePayload {
    registry.open_path(path).expect("file must open")
}

pub fn save(
    registry: &DocumentRegistry,
    token: &str,
    text: &str,
    expected_current_hash: Option<&str>,
) -> Result<SaveResult, AppError> {
    let record = registry.get(token).expect("token must resolve");
    AtomicWriter::write(&record, text, expected_current_hash)
}

pub fn encode_utf16(text: &str, little_endian: bool, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    if bom {
        if little_endian {
            bytes.extend_from_slice(&[0xFF, 0xFE]);
        } else {
            bytes.extend_from_slice(&[0xFE, 0xFF]);
        }
    }
    for unit in text.encode_utf16() {
        if little_endian {
            bytes.extend_from_slice(&unit.to_le_bytes());
        } else {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
    }
    bytes
}

/// Temporary siblings created by `atomic-write-file`, e.g. `.note.md.abc123`.
pub fn temp_siblings(target: &Path) -> Vec<PathBuf> {
    let Some(directory) = target.parent() else {
        return Vec::new();
    };
    let Some(name) = target.file_name() else {
        return Vec::new();
    };
    let prefix = format!(".{}.", name.to_string_lossy());

    fs::read_dir(directory)
        .expect("fixture directory must be readable")
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            path.file_name()?
                .to_string_lossy()
                .starts_with(&prefix)
                .then_some(path)
        })
        .collect()
}
