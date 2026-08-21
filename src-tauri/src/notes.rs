use crate::db::Db;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteRecord {
    pub id: String,
    /// Path relative to the vault root — the vault root itself is never
    /// stored here so the vault folder can move without invalidating ids.
    pub path: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub mtime: i64,
}

fn wikilink_targets(body: &str) -> Vec<String> {
    // [[Title]] or [[Title|id]] — id (if present) is preferred for
    // resolution on the frontend, but the cache just records the raw
    // title text here; resolving to a real note is a frontend concern.
    let re = regex::Regex::new(r"\[\[([^\]|]+)(\|[^\]]+)?\]\]").expect("static regex");
    re.captures_iter(body).map(|c| c[1].trim().to_string()).collect()
}

fn hash_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Splits `---\nyaml\n---\nbody` into (frontmatter, body). Hand-rolled
/// rather than pulling in a frontmatter crate — the format is simple enough
/// that owning the parsing outright is less risky than trusting an
/// unfamiliar crate's exact API surface.
fn split_frontmatter(raw: &str) -> (serde_json::Value, String) {
    if let Some(rest) = raw.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let (fm_str, remainder) = rest.split_at(end);
            let body = &remainder[5..]; // skip "\n---\n"
            let fm_yaml: serde_yaml::Value = serde_yaml::from_str(fm_str).unwrap_or(serde_yaml::Value::Null);
            let fm_json = serde_json::to_value(&fm_yaml).unwrap_or_else(|_| serde_json::json!({}));
            return (fm_json, body.to_string());
        }
    }
    (serde_json::json!({}), raw.to_string())
}

fn render_with_frontmatter(fm: &serde_json::Value, body: &str) -> String {
    let fm_yaml: serde_yaml::Value = serde_json::from_value(fm.clone()).unwrap_or(serde_yaml::Value::Null);
    format!("---\n{}---\n{}", serde_yaml::to_string(&fm_yaml).unwrap_or_default(), body)
}

/// Writes to a temp file in the same directory, then renames over the
/// target — atomic on POSIX, near-atomic on NTFS, so a crash mid-write
/// never corrupts the real .md file.
pub fn atomic_write(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("md.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Writes `new_id` into the file's frontmatter and returns the freshly
/// written content (so the caller can hash what's actually on disk now,
/// rather than the pre-stamp bytes it started with).
fn restamp_id(path: &Path, fm: &mut serde_json::Value, body: &str, new_id: &str) -> anyhow::Result<String> {
    fm["id"] = serde_json::json!(new_id);
    let stamped = render_with_frontmatter(fm, body);
    atomic_write(path, &stamped)?;
    Ok(stamped)
}

/// Parses one file and upserts it into the cache. Stamps a fresh id into
/// the file's frontmatter the first time it's seen (a one-time write, not
/// part of the hot save path) so wikilinks can resolve by id even across
/// a rename.
pub fn index_file(db: &Db, vault_root: &Path, path: &Path) -> anyhow::Result<()> {
    // Normalize CRLF up front — split_frontmatter looks for an exact "---\n"
    // prefix, and a file touched by a Windows editor defaulting to \r\n
    // would otherwise silently fail to parse, making the frontmatter (and
    // the id inside it) look empty on every subsequent read.
    let raw = fs::read_to_string(path)?.replace("\r\n", "\n");
    let (mut fm, body) = split_frontmatter(&raw);
    let rel_path = path.strip_prefix(vault_root).unwrap_or(path).to_string_lossy().to_string();

    let frontmatter_id = fm.get("id").and_then(|v| v.as_str()).map(String::from);

    // The path is known and unambiguous before we've looked at the file's
    // contents at all — unlike a freshly-parsed frontmatter id, it can't be
    // wrong. So it's checked first: if the cache already has a row for this
    // path, that row's id wins, and self-heals the file if its frontmatter
    // disagrees (missing, or corrupted by a hand-edit) instead of minting a
    // second id that collides with the first on the `path` UNIQUE
    // constraint — which is exactly the bug that produced the error above.
    let existing_id: Option<String> = {
        let conn = db.0.lock().unwrap();
        conn.query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |r| r.get(0)).ok()
    };

    let (id, final_raw) = if let Some(known) = existing_id {
        if frontmatter_id.as_deref() == Some(known.as_str()) {
            (known, raw)
        } else {
            let stamped = restamp_id(path, &mut fm, &body, &known)?;
            (known, stamped)
        }
    } else if let Some(fm_id) = frontmatter_id {
        // Same id, different path (never seen this path before) usually
        // means the file was copied rather than renamed — reusing the id
        // here would silently steal the original file's cache row out from
        // under it, so a copy gets its own fresh identity instead.
        let claimed_elsewhere: bool = {
            let conn = db.0.lock().unwrap();
            conn.query_row(
                "SELECT 1 FROM notes WHERE id = ?1 AND path != ?2",
                rusqlite::params![fm_id, rel_path],
                |_| Ok(()),
            )
            .is_ok()
        };
        if claimed_elsewhere {
            let new_id = Uuid::new_v4().to_string();
            let stamped = restamp_id(path, &mut fm, &body, &new_id)?;
            (new_id, stamped)
        } else {
            (fm_id, raw)
        }
    } else {
        let new_id = Uuid::new_v4().to_string();
        let stamped = restamp_id(path, &mut fm, &body, &new_id)?;
        (new_id, stamped)
    };

    let title = fm
        .get("title")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());

    let tags: Vec<String> = fm
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mtime = fs::metadata(path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    let hash = hash_of(final_raw.as_bytes());

    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO notes (id, path, title, body, tags, mtime, hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            path = excluded.path,
            title = excluded.title,
            body = excluded.body,
            tags = excluded.tags,
            mtime = excluded.mtime,
            hash = excluded.hash,
            deleted_at = NULL",
        rusqlite::params![id, rel_path, title, body, serde_json::to_string(&tags)?, mtime, hash],
    )?;

    conn.execute("DELETE FROM links WHERE source_id = ?1", [&id])?;
    for target in wikilink_targets(&body) {
        conn.execute(
            "INSERT INTO links (source_id, target_title, target_id)
             VALUES (?1, ?2, (SELECT id FROM notes WHERE title = ?2 LIMIT 1))",
            rusqlite::params![id, target],
        )?;
    }
    Ok(())
}

/// Full-vault walk. Cheap enough to call on every app launch and after
/// picking a new vault folder — later this can be made incremental by
/// comparing each file's mtime/hash against the cached row before
/// re-parsing, but a flat walk is the right starting point.
pub fn reindex_vault(db: &Db, vault_root: &Path) -> anyhow::Result<()> {
    for entry in walkdir::WalkDir::new(vault_root)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".trash")
        .filter_map(Result::ok)
    {
        let is_md = entry.file_type().is_file()
            && entry.path().extension().map_or(false, |ext| ext == "md");
        if is_md {
            // A single malformed note shouldn't abort indexing the rest of
            // the vault — log and move on.
            if let Err(err) = index_file(db, vault_root, entry.path()) {
                eprintln!("failed to index {}: {err}", entry.path().display());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_notes(db: State<Db>) -> Vec<NoteRecord> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, path, title, body, tags, mtime FROM notes WHERE deleted_at IS NULL ORDER BY mtime DESC")
        .expect("valid query");
    stmt.query_map([], |row| {
        Ok(NoteRecord {
            id: row.get(0)?,
            path: row.get(1)?,
            title: row.get(2)?,
            body: row.get(3)?,
            tags: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
            mtime: row.get(5)?,
        })
    })
    .expect("valid mapping")
    .filter_map(Result::ok)
    .collect()
}

/// Writes the note to disk (frontmatter + body) and re-indexes it in the
/// same call — the indexer is the single source of truth for "what does
/// this file mean," so save and index never drift out of sync.
///
/// Takes no path — the vault root is read from VaultState, so the frontend
/// only ever hands over the note's own id/relative-path/title/body/tags,
/// never a filesystem location it had to construct itself.
#[tauri::command]
pub fn save_note(
    db: State<Db>,
    vault: State<crate::config::VaultState>,
    note: NoteRecord,
) -> Result<(), String> {
    let vault_root = crate::config::require_vault_root(&vault)?;
    let full_path = vault_root.join(&note.path);
    let frontmatter = serde_json::json!({ "id": note.id, "title": note.title, "tags": note.tags });
    let content = render_with_frontmatter(&frontmatter, &note.body);
    atomic_write(&full_path, &content).map_err(|e| e.to_string())?;
    index_file(db.inner(), &vault_root, &full_path).map_err(|e| e.to_string())
}

/// Soft-delete: move the file into .trash/ (never hard-delete on the first
/// action) and mark the cache row so it drops out of every normal query.
#[tauri::command]
pub fn trash_note(
    db: State<Db>,
    vault: State<crate::config::VaultState>,
    note_id: String,
) -> Result<(), String> {
    let vault_root = crate::config::require_vault_root(&vault)?;

    let conn = db.0.lock().unwrap();
    let path: String = conn
        .query_row("SELECT path FROM notes WHERE id = ?1", [&note_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    drop(conn);

    let src = vault_root.join(&path);
    let trash_dir = vault_root.join(".trash");
    fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
    let dest: PathBuf = trash_dir.join(format!(
        "{}-{}.md",
        chrono::Utc::now().timestamp(),
        note_id
    ));
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;

    let conn = db.0.lock().unwrap();
    conn.execute(
        "UPDATE notes SET deleted_at = strftime('%s','now') WHERE id = ?1",
        [&note_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-scans the vault on demand (e.g. a manual "refresh" button, or after
/// the watcher reports external changes) and returns the current note
/// count so the frontend can show it without a second round-trip.
#[tauri::command]
pub fn rescan_vault(db: State<Db>, vault: State<crate::config::VaultState>) -> Result<usize, String> {
    let vault_root = crate::config::require_vault_root(&vault)?;
    reindex_vault(db.inner(), &vault_root).map_err(|e| e.to_string())?;
    let conn = db.0.lock().unwrap();
    conn.query_row("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}
