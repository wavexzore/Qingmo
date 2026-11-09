//! Cross-process save helper for `scripts/ci/two-process-save.sh`.
//!
//! Each process opens the same document through the production
//! `DocumentRegistry`, waits for a shared start file, then saves through
//! `AtomicWriter` with the same on-disk `FileLockStore` the app uses. The
//! script asserts the final bytes are one complete payload, never an
//! interleaving, and that a SIGKILLed holder does not leave a permanent lock.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use qingmo_lib::services::FileLockStore;
use qingmo_lib::state::DocumentRegistry;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let target = PathBuf::from(
        args.next()
            .ok_or("usage: two_process_save <path> <payload-file> <locks-dir> [start-file]")?,
    );
    let payload_path = PathBuf::from(args.next().ok_or("missing payload file")?);
    let locks = PathBuf::from(args.next().ok_or("missing locks directory")?);
    let start = args.next().map(PathBuf::from);

    let text = fs::read_to_string(payload_path)?;
    let registry = DocumentRegistry::new();
    registry.configure_services(None, Some(FileLockStore::open(locks)?), None);
    let payload = registry.open_path(target)?;

    // The barrier makes both processes finish opening, then contend for the
    // same sidecar lock at (almost) the same instant.
    if let Some(start) = start {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !start.exists() {
            if Instant::now() > deadline {
                return Err("start barrier timed out".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    let result = registry.write_atomic(&payload.doc_token, &text, None)?;
    println!(
        "{{\"ok\":true,\"hash\":\"{}\",\"size\":{}}}",
        result.hash, result.size
    );
    Ok(())
}
