#[allow(dead_code)]
mod contract {
    include!("src/ipc/contract.rs");
}

/// Integration tests link the GUI stack but Cargo embeds no manifest into test
/// binaries. Without the Common-Controls v6 dependency Windows loads
/// `comctl32.dll` v5, which lacks `TaskDialogIndirect`, and the test executable
/// dies with STATUS_ENTRYPOINT_NOT_FOUND before the harness starts.
#[cfg(windows)]
fn embed_test_manifest() {
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTUAC:NO");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}

fn main() {
    #[cfg(windows)]
    embed_test_manifest();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(contract::COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
