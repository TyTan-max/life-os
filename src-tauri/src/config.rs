use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// Where the app-data directory lives — resolved once at startup and handed
/// to every command that needs to read/write config.json, so nothing has to
/// re-resolve the platform-specific path on every call.
pub struct ConfigPaths {
    pub app_data_dir: PathBuf,
}

/// The live vault root, held only on the Rust side for the lifetime of the
/// app. Every note command (save/trash/rescan) reads it from here instead
/// of taking a path argument — the TypeScript frontend never constructs,
/// joins, or reasons about a filesystem path; it only ever gets an opaque
/// "connected" signal plus an optional display string for the UI.
///
/// This is the seam a future mobile/cloud-sync backend would swap out:
/// same command signatures (`save_note(note)`, `list_notes()`, ...), a
/// completely different `VaultState` implementation behind them (e.g. a
/// cloud document id instead of a PathBuf).
pub struct VaultState(pub Mutex<Option<PathBuf>>);

pub fn require_vault_root(state: &VaultState) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No vault connected yet — pick a folder first.".to_string())
}

/// Persisted app settings. Right now this is just the chosen vault folder,
/// but it's the natural place to add e.g. "last opened note" later.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    pub vault_root: Option<String>,
}

impl AppConfig {
    fn config_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("config.json")
    }

    pub fn load(app_data_dir: &Path) -> Self {
        std::fs::read_to_string(Self::config_path(app_data_dir))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app_data_dir: &Path) -> std::io::Result<()> {
        std::fs::write(Self::config_path(app_data_dir), serde_json::to_string_pretty(self)?)
    }
}

/// Purely informational — lets the onboarding UI show "connected: <path>"
/// for the human's benefit. Nothing in the frontend feeds this value back
/// into a command; every mutating command re-derives the root itself from
/// `VaultState`. Returns `None` before a vault has ever been chosen.
#[tauri::command]
pub fn get_vault_root(vault: State<VaultState>) -> Option<String> {
    vault.0.lock().unwrap().as_ref().map(|p| p.to_string_lossy().to_string())
}

/// Called once from the onboarding picker with whatever path the native OS
/// folder dialog returned. Persists it, updates the in-memory VaultState,
/// does an initial full index, and starts watching it for external changes
/// — after this the frontend can immediately call list_notes with no
/// further path knowledge required.
#[tauri::command]
pub fn set_vault_root(
    paths: State<ConfigPaths>,
    db: State<crate::db::Db>,
    vault: State<VaultState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<usize, String> {
    let root = PathBuf::from(&path);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let cfg = AppConfig { vault_root: Some(path) };
    cfg.save(&paths.app_data_dir).map_err(|e| e.to_string())?;
    *vault.0.lock().unwrap() = Some(root.clone());

    crate::notes::reindex_vault(db.inner(), &root).map_err(|e| e.to_string())?;
    crate::watcher::watch_vault(app, root);

    let conn = db.0.lock().unwrap();
    let count: usize = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(count)
}
