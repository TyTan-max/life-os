// Prevents an extra console window from popping up on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod db;
mod notes;
mod watcher;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir available on this platform");
            std::fs::create_dir_all(&app_data_dir).ok();

            let db = db::init(&app_data_dir);
            let existing_vault = config::AppConfig::load(&app_data_dir).vault_root;

            app.manage(db);
            app.manage(config::ConfigPaths { app_data_dir: app_data_dir.clone() });

            // The one Rust-side mutable slot that holds where the vault
            // lives. Every note command reads from this instead of taking a
            // path argument, so the frontend never has to carry filesystem
            // knowledge between calls.
            let initial_root = existing_vault
                .as_ref()
                .map(std::path::PathBuf::from)
                .filter(|p| p.exists());
            app.manage(config::VaultState(std::sync::Mutex::new(initial_root.clone())));

            // A vault was already chosen on a previous run — index it and
            // start watching immediately so the frontend can call
            // list_notes right away without re-running the picker flow.
            if let Some(root) = initial_root {
                let db_state = app.state::<db::Db>();
                if let Err(err) = notes::reindex_vault(db_state.inner(), &root) {
                    eprintln!("initial vault reindex failed: {err}");
                }
                watcher::watch_vault(app.handle().clone(), root);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_vault_root,
            config::set_vault_root,
            notes::list_notes,
            notes::save_note,
            notes::trash_note,
            notes::rescan_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
