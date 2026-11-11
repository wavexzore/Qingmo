//! Seed a `MEETING_E2E_MODELS` root from an unpacked probe directory.
//!
//! Usage: seed_meeting_models <source> <destination> [id ...]
//!
//! Copies the manifest-named files from the probe layout and writes the
//! `.ready` marker `ManifestCatalog` expects, so native E2E runs never hash the
//! same weights mid-test.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use qingmo_lib::services::meeting::models::{find, write_ready, FileRole};

fn source_for(root: &Path, id: &str, name: &str, role: FileRole) -> Option<PathBuf> {
    let candidates = [
        Some(root.join(id).join(name)),
        Some(root.join("models").join(id).join(name)),
        Some(root.join(name)),
        match role {
            FileRole::Segmentation => Some(root.join("seg.onnx")),
            FileRole::Embedding => Some(root.join("emb.onnx")),
            FileRole::Vad => Some(root.join("silero_vad.onnx")),
            _ => None,
        },
    ];
    candidates.into_iter().flatten().find(|path| path.is_file())
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 2 {
        eprintln!("usage: seed_meeting_models <source> <destination> [id ...]");
        std::process::exit(2);
    }
    let source = PathBuf::from(&args[0]);
    let destination = PathBuf::from(&args[1]);
    let ids = if args.len() > 2 {
        args[2..].to_vec()
    } else {
        vec![
            "paraformer-zh-en-int8".into(),
            "zipformer-zh-en-int8".into(),
            "pyannote-segmentation-3-int8".into(),
            "campplus-zh-en-advanced".into(),
            "silero-vad".into(),
        ]
    };
    for id in ids {
        let pack = find(&id).unwrap_or_else(|| panic!("unknown pack {id}"));
        let dir = destination.join(&id);
        fs::create_dir_all(&dir).expect("create pack dir");
        for file in pack.files {
            let from = source_for(&source, &id, file.name, file.role)
                .unwrap_or_else(|| panic!("missing source for {id}/{}", file.name));
            let to = dir.join(file.name);
            // `fs::copy` truncates the destination first, so seeding in place
            // (`<dir>` to `<dir>`) would leave an empty file.
            if from != to {
                fs::copy(&from, &to).expect("copy model");
            }
        }
        write_ready(
            &dir,
            pack,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        )
        .expect("write ready marker");
        println!("seeded {id}");
    }
}
