use std::path::PathBuf;

use qingmo_lib::services::AtomicWriter;
use qingmo_lib::state::DocumentRegistry;

/// Fault-injection helper for `scripts/fault-injection/kill-after-temp.sh`.
///
/// It performs a normal atomic write. In debug builds, setting
/// `QINGMO_FAULT_AFTER_TEMP_MS` pauses after the temporary file has been
/// written but before `commit()`, giving the script a deterministic window to
/// send SIGKILL.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: fault_write <path>")?;

    let registry = DocumentRegistry::new();
    let payload = registry.open_path(target)?;
    let record = registry.get(&payload.doc_token)?;

    AtomicWriter::write(&record, "new-content\n", None)?;
    println!("committed {}", record.canonical_target.display());
    Ok(())
}
