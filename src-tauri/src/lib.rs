use tauri::Manager;
use tracing_subscriber::EnvFilter;

pub mod commands;
pub mod error;
pub mod ipc;
pub mod services;
pub mod state;

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::DocumentRegistry::new())
        .setup(|app| {
            app.manage(app.handle().clone());
            Ok(())
        })
        .invoke_handler(commands::handler())
        .run(tauri::generate_context!())
        .expect("error while running Qingmo");
}
