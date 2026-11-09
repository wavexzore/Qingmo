//! Identity/history/view rollback mapping.
//!
//! The tool never deletes identity, history or view data. It maps stable
//! DocumentId buckets back to the legacy path keys so a build without the
//! identity store can still read history and view state. `run` is pure with
//! respect to dry-run mode; only `apply = true` writes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Component, Path};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppErrorCode};

pub const ROLLBACK_SCHEMA_VERSION: u32 = 1;
pub const ROLLBACK_REPORT_FILE: &str = "rollback-report.json";
pub const IDENTITY_SUBDIR: &str = "identity";
pub const HISTORY_SUBDIR: &str = "history";
pub const SESSION_SUBDIR: &str = "session";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackReport {
    pub schema_version: u32,
    pub mode: String,
    pub data_root: String,
    pub identity: IdentityReport,
    pub history: Vec<HistoryMapping>,
    pub view: Vec<ViewMapping>,
    pub problems: Vec<String>,
    pub summary: RollbackSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityReport {
    pub path: String,
    pub schema_version: u32,
    pub entries: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMapping {
    pub document_id: String,
    pub alias: String,
    pub source: String,
    pub target: String,
    pub action: String,
    pub copied_entries: usize,
    pub kept_entries: usize,
    pub missing_payloads: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewMapping {
    pub document_id: String,
    pub alias: String,
    pub action: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackSummary {
    pub documents: usize,
    pub history_mappings: usize,
    pub history_copied_entries: usize,
    pub view_inserted: usize,
    pub conflicts: usize,
    pub problems: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentsFile {
    schema_version: u32,
    entries: BTreeMap<String, StoredEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    path: String,
    #[serde(default)]
    legacy_paths: Vec<String>,
}

struct DocumentMapping {
    id: String,
    aliases: Vec<String>,
}

/// Computes the exact legacy history key used by `HistoryStore`.
pub fn legacy_history_key(path: &str) -> String {
    let full = blake3::hash(path.as_bytes()).to_hex().to_string();
    full[..32].to_string()
}

pub fn run(data_root: &Path, apply: bool) -> Result<RollbackReport, AppError> {
    let identity_path = data_root.join(IDENTITY_SUBDIR).join("documents.json");
    let documents = load_identity(&identity_path)?;
    let identity_schema = documents.schema_version;
    let mut problems = Vec::new();
    let mappings = collect_mappings(documents.entries, &mut problems);

    let history_root = data_root.join(HISTORY_SUBDIR);
    let mut history = Vec::new();
    let mut claimed_targets: HashMap<String, String> = HashMap::new();
    for document in &mappings {
        for alias in &document.aliases {
            let target_key = legacy_history_key(alias);
            if let Some(owner) = claimed_targets.get(&target_key) {
                if owner != &document.id {
                    problems.push(format!(
                        "history alias {alias} is claimed by both {owner} and {}",
                        document.id
                    ));
                    history.push(HistoryMapping {
                        document_id: document.id.clone(),
                        alias: alias.clone(),
                        source: format!("{HISTORY_SUBDIR}/{}", document.id),
                        target: format!("{HISTORY_SUBDIR}/{target_key}"),
                        action: "conflict".to_string(),
                        copied_entries: 0,
                        kept_entries: 0,
                        missing_payloads: 0,
                    });
                    continue;
                }
            } else {
                claimed_targets.insert(target_key.clone(), document.id.clone());
            }
            let mapping = map_history(&history_root, &document.id, alias, &target_key, apply)?;
            if mapping.action == "missing-source" {
                problems.push(format!(
                    "history source is missing for document {}",
                    document.id
                ));
            }
            if mapping.missing_payloads > 0 {
                problems.push(format!(
                    "history payload is missing for {} ({} entries)",
                    document.id, mapping.missing_payloads
                ));
            }
            history.push(mapping);
        }
    }

    let view_path = data_root.join(SESSION_SUBDIR).join("view-state.json");
    let (view, _view_written) = map_view(&view_path, &mappings, apply, &mut problems)?;

    let conflicts = history
        .iter()
        .filter(|mapping| mapping.action == "conflict")
        .count()
        + view
            .iter()
            .filter(|mapping| mapping.action == "conflict" || mapping.action == "duplicate")
            .count();
    let summary = RollbackSummary {
        documents: mappings.len(),
        history_mappings: history.len(),
        history_copied_entries: history.iter().map(|mapping| mapping.copied_entries).sum(),
        view_inserted: view
            .iter()
            .filter(|mapping| mapping.action == "insert")
            .count(),
        conflicts,
        problems: problems.len(),
    };

    Ok(RollbackReport {
        schema_version: ROLLBACK_SCHEMA_VERSION,
        mode: if apply { "apply" } else { "dry-run" }.to_string(),
        data_root: data_root.to_string_lossy().into_owned(),
        identity: IdentityReport {
            path: identity_path.to_string_lossy().into_owned(),
            schema_version: identity_schema,
            entries: mappings.len(),
        },
        history,
        view,
        problems,
        summary,
    })
}

fn load_identity(path: &Path) -> Result<DocumentsFile, AppError> {
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                AppErrorCode::NotFound,
                format!("identity file not found: {}", path.display()),
            )
        } else {
            AppError::from_io(&error)
        }
    })?;
    let documents = serde_json::from_slice::<DocumentsFile>(&bytes).map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("identity file is not valid schema v3: {error}"),
        )
    })?;
    if documents.schema_version != 2 && documents.schema_version != 3 {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            format!(
                "unsupported identity schema version {}",
                documents.schema_version
            ),
        ));
    }
    Ok(documents)
}

fn collect_mappings(
    entries: BTreeMap<String, StoredEntry>,
    problems: &mut Vec<String>,
) -> Vec<DocumentMapping> {
    let mut mappings = Vec::new();
    for (id, entry) in entries {
        if uuid::Uuid::parse_str(&id).is_err() {
            problems.push(format!("identity key {id} is not a UUID"));
            continue;
        }
        let mut aliases = Vec::new();
        if valid_mapping_path(&entry.path) {
            aliases.push(entry.path.clone());
        } else {
            problems.push(format!("document {id} has an invalid primary path"));
        }
        for alias in entry.legacy_paths {
            if valid_mapping_path(&alias) && !aliases.contains(&alias) {
                aliases.push(alias);
            } else if !valid_mapping_path(&alias) {
                problems.push(format!("document {id} has an invalid legacy path"));
            }
        }
        if aliases.is_empty() {
            continue;
        }
        mappings.push(DocumentMapping { id, aliases });
    }
    mappings
}

fn valid_mapping_path(value: &str) -> bool {
    if value.is_empty() || value.contains('\0') {
        return false;
    }
    Path::new(value)
        .components()
        .all(|component| !matches!(component, Component::ParentDir | Component::CurDir))
}

fn map_history(
    history_root: &Path,
    document_id: &str,
    alias: &str,
    target_key: &str,
    apply: bool,
) -> Result<HistoryMapping, AppError> {
    let source_dir = history_root.join(document_id);
    let target_dir = history_root.join(target_key);
    let source_entries = source_dir.join("entries.json");
    let target_entries = target_dir.join("entries.json");
    let mut mapping = HistoryMapping {
        document_id: document_id.to_string(),
        alias: alias.to_string(),
        source: format!("{HISTORY_SUBDIR}/{document_id}"),
        target: format!("{HISTORY_SUBDIR}/{target_key}"),
        action: "missing-source".to_string(),
        copied_entries: 0,
        kept_entries: 0,
        missing_payloads: 0,
    };
    let Ok(source_bytes) = fs::read(&source_entries) else {
        return Ok(mapping);
    };
    let source: Value = match serde_json::from_slice(&source_bytes) {
        Ok(value) => value,
        Err(_) => {
            mapping.action = "invalid-source".to_string();
            return Ok(mapping);
        }
    };
    let source_list = source
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let target_existed = target_entries.is_file();
    let mut target = if target_existed {
        let bytes = fs::read(&target_entries).map_err(|error| AppError::from_io(&error))?;
        let value = serde_json::from_slice::<Value>(&bytes).map_err(|error| {
            AppError::new(
                AppErrorCode::InvalidPath,
                format!("target history file is corrupt: {error}"),
            )
        })?;
        if value.get("entries").and_then(Value::as_array).is_none() {
            return Err(AppError::new(
                AppErrorCode::InvalidPath,
                "target history file has no entries array",
            ));
        }
        value
    } else {
        json!({
            "schemaVersion": source.get("schemaVersion").cloned().unwrap_or(json!(1)),
            "path": alias,
            "entries": [],
        })
    };
    let mut target_ids: BTreeSet<String> = target
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    for entry in source_list {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            mapping.missing_payloads += 1;
            continue;
        };
        if target_ids.contains(id) {
            mapping.kept_entries += 1;
            continue;
        }
        let source_payload = source_dir.join(format!("{id}.bin"));
        if !source_payload.is_file() {
            mapping.missing_payloads += 1;
            continue;
        }
        if apply {
            fs::create_dir_all(&target_dir).map_err(|error| AppError::from_io(&error))?;
            let target_payload = target_dir.join(format!("{id}.bin"));
            if !target_payload.exists() {
                fs::copy(&source_payload, &target_payload)
                    .map_err(|error| AppError::from_io(&error))?;
            }
            let entries = target
                .get_mut("entries")
                .and_then(Value::as_array_mut)
                .expect("entries array checked above");
            entries.push(entry.clone());
        }
        target_ids.insert(id.to_string());
        mapping.copied_entries += 1;
    }

    if apply {
        fs::create_dir_all(&target_dir).map_err(|error| AppError::from_io(&error))?;
        let entries = target
            .get_mut("entries")
            .and_then(Value::as_array_mut)
            .expect("entries array checked above");
        entries.sort_by(|left, right| {
            let left = left.get("createdAtMs").and_then(Value::as_i64).unwrap_or(0);
            let right = right
                .get("createdAtMs")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            right.cmp(&left)
        });
        target["path"] = json!(alias);
        write_json(&target_entries, &target)?;
    }
    mapping.action = if target_existed {
        "merge".to_string()
    } else {
        "copy".to_string()
    };
    Ok(mapping)
}

fn map_view(
    view_path: &Path,
    mappings: &[DocumentMapping],
    apply: bool,
    problems: &mut Vec<String>,
) -> Result<(Vec<ViewMapping>, bool), AppError> {
    let bytes = match fs::read(view_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            problems.push("view-state.json is missing; view rollback skipped".to_string());
            return Ok((Vec::new(), false));
        }
        Err(error) => return Err(AppError::from_io(&error)),
    };
    let mut view: Value = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("view-state.json is corrupt: {error}"),
        )
    })?;
    let schema = view
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if schema != 1 && schema != 2 {
        problems.push(format!("unsupported view-state schema {schema}"));
        return Ok((Vec::new(), false));
    }
    if schema == 1 {
        // v1 keys are paths; move them into legacy and leave ID entries empty.
        let mut legacy = view
            .get("legacy")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(entries) = view.get("entries").and_then(Value::as_object) {
            for (path, state) in entries {
                legacy.entry(path.clone()).or_insert_with(|| state.clone());
            }
        }
        view["schemaVersion"] = json!(2);
        view["entries"] = json!({});
        view["legacy"] = Value::Object(legacy);
        problems.push("view-state schema 1 converted to schema 2 during rollback".to_string());
    }
    let entries = view
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut legacy = view
        .get("legacy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut claimed: HashMap<String, String> = HashMap::new();
    let mut mappings_out = Vec::new();
    let mut changed = schema == 1;

    for document in mappings {
        let state = entries.get(&document.id).cloned();
        for alias in &document.aliases {
            let action = match &state {
                None => "missing-entry".to_string(),
                Some(state) => match legacy.get(alias) {
                    Some(existing) if existing == state => "existing".to_string(),
                    Some(_) => "conflict".to_string(),
                    None => match claimed.get(alias) {
                        Some(owner) if owner != &document.id => {
                            problems.push(format!(
                                "view alias {alias} is claimed by both {owner} and {}",
                                document.id
                            ));
                            "duplicate".to_string()
                        }
                        Some(_) => "existing".to_string(),
                        None => {
                            claimed.insert(alias.clone(), document.id.clone());
                            if apply {
                                legacy.insert(alias.clone(), state.clone());
                                changed = true;
                            }
                            "insert".to_string()
                        }
                    },
                },
            };
            mappings_out.push(ViewMapping {
                document_id: document.id.clone(),
                alias: alias.clone(),
                action,
            });
        }
    }

    if apply && changed {
        view["schemaVersion"] = json!(2);
        view["legacy"] = Value::Object(legacy);
        write_json(view_path, &view)?;
    }
    Ok((mappings_out, changed))
}

fn write_json(path: &Path, value: &Value) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| AppError::from_io(&error))?;
    file.write_all(&bytes)
        .map_err(|error| AppError::from_io(&error))?;
    file.commit().map_err(|error| AppError::from_io(&error))?;
    Ok(())
}
