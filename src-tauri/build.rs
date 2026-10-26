#[allow(dead_code)]
mod contract {
    include!("src/ipc/contract.rs");
}

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(contract::COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
