use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

/// The SQLite cache — the fast, queryable layer between the .md files on
/// disk (source of truth) and the UI. The UI never reads/writes markdown
/// files directly; it goes through this cache, which is kept in sync by
/// the indexer (see notes::index_file) whenever a file is saved or changes
/// externally.
pub struct Db(pub Mutex<Connection>);

pub fn init(app_data_dir: &Path) -> Db {
    std::fs::create_dir_all(app_data_dir).ok();
    let conn = Connection::open(app_data_dir.join("cache.sqlite")).expect("failed to open cache db");
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS notes (
            id          TEXT PRIMARY KEY,
            path        TEXT NOT NULL UNIQUE,
            title       TEXT NOT NULL DEFAULT '',
            body        TEXT NOT NULL DEFAULT '',
            tags        TEXT NOT NULL DEFAULT '[]',
            mtime       INTEGER NOT NULL,
            hash        TEXT NOT NULL,
            deleted_at  INTEGER
        );
        CREATE TABLE IF NOT EXISTS links (
            source_id     TEXT NOT NULL,
            target_title  TEXT NOT NULL,
            target_id     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_title);
        CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
        ",
    )
    .expect("failed to initialize cache schema");
    Db(Mutex::new(conn))
}
