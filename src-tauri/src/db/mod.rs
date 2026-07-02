//! SQLite persistence for Echo Scribe.
//!
//! Connection lives at `~/Library/Application Support/EchoScribe/echo.db`.
//! The `Db` handle wraps an `Arc<Mutex<Connection>>` so it can be cloned
//! freely into Tauri's managed state and the coordinator. SQLite's threading
//! model + a single-file DB + a single mutex is plenty for our write rate
//! (one row per voice capture). FTS5 is provided via `rusqlite`'s `bundled`
//! feature.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use thiserror::Error;

pub mod items;
pub mod projects;
pub mod schema;
pub mod chat;
pub mod events;
pub mod search;
pub mod stats;
pub mod meetings;
pub mod tasks;
pub mod daily_summaries;
pub mod guide_templates;
pub mod recordings;
pub mod embeddings;

pub use chat::{ChatMessage, ChatSession};
pub use items::{Item, ItemKind, ItemSource};

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("home directory not available")]
    NoHome,
}

/// Cloneable handle to the application database.
#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
}

impl Db {
    /// Open the on-disk DB at the default path, ensuring its parent
    /// directory exists and that all migrations have run.
    pub fn open_default() -> Result<Self, DbError> {
        let path = default_db_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::open_at(&path)
    }

    pub fn open_at(path: &std::path::Path) -> Result<Self, DbError> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", &"WAL")?;
        conn.pragma_update(None, "foreign_keys", &"ON")?;
        schema::run_migrations(&mut conn)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run a closure against the underlying connection. Locks the mutex for
    /// the duration of the closure — keep work short.
    pub fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> Result<R, DbError>) -> Result<R, DbError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| DbError::Sqlite(rusqlite::Error::InvalidQuery))?;
        f(&guard)
    }

    /// Same as `with_conn` but hands out `&mut Connection` so the closure can
    /// open a `Transaction`. Use for operations that need atomic multi-statement
    /// commits.
    pub fn with_conn_mut<R>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<R, DbError>,
    ) -> Result<R, DbError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| DbError::Sqlite(rusqlite::Error::InvalidQuery))?;
        f(&mut guard)
    }
}

/// Default on-disk DB path: `~/Library/Application Support/EchoScribe/echo.db`.
pub fn default_db_path() -> Result<PathBuf, DbError> {
    let home = dirs::home_dir().ok_or(DbError::NoHome)?;
    Ok(home
        .join("Library")
        .join("Application Support")
        .join("EchoScribe")
        .join("echo.db"))
}
