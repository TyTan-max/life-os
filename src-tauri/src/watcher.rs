use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Watches the vault folder for changes made outside the app (another
/// editor, Obsidian, git checkout, sync client, etc.) and emits a
/// `vault-changed` event with the list of changed .md paths so the
/// frontend can reindex and, if one of those notes is open, offer a merge
/// instead of silently clobbering it.
///
/// Runs its own manual debounce (collect + 400ms of quiet before emitting)
/// rather than depending on a second watcher crate's exact event-type
/// shape, which tends to drift between versions.
///
/// Known limitation: if the user re-picks a different vault folder while
/// the app is running, this spawns a second watcher thread rather than
/// stopping the first — acceptable for now since re-picking is rare;
/// revisit with a stored JoinHandle/stop-flag if that becomes a real flow.
pub fn watch_vault(app: AppHandle, vault_root: PathBuf) {
    std::thread::spawn(move || {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(err) => {
                eprintln!("failed to start vault watcher: {err}");
                return;
            }
        };
        if let Err(err) = watcher.watch(&vault_root, RecursiveMode::Recursive) {
            eprintln!("failed to watch {}: {err}", vault_root.display());
            return;
        }

        let mut pending: HashSet<String> = HashSet::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(400)) {
                Ok(Ok(event)) => {
                    for p in event.paths {
                        if p.extension().map_or(false, |ext| ext == "md") {
                            pending.insert(p.to_string_lossy().to_string());
                        }
                    }
                }
                Ok(Err(err)) => eprintln!("vault watch error: {err}"),
                Err(RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        let batch: Vec<String> = pending.drain().collect();
                        app.emit("vault-changed", batch).ok();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}
