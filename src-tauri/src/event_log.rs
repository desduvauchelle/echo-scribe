//! Append-only event log on disk.
//!
//! Each event becomes a single JSON file at
//! `<root>/events/YYYY/MM/<ulid>.json`. One file per event (NOT JSONL):
//! easier to back up, easier to audit by hand, no concurrent-writer
//! coordination needed. The ULID filename sorts chronologically.
//!
//! `root` defaults to `~/EchoScribe/` — the user-facing archive — distinct
//! from the SQLite database under `~/Library/Application Support/EchoScribe/`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EventLogError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("invalid event: {0}")]
    Invalid(String),
    #[error("home directory not available")]
    NoHome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub id: String,
    pub event_type: String,
    pub created_at: String,
    pub payload: serde_json::Value,
}

/// Default root for the event archive: `~/EchoScribe/`.
pub fn default_root() -> Result<PathBuf, EventLogError> {
    Ok(dirs::home_dir().ok_or(EventLogError::NoHome)?.join("EchoScribe"))
}

/// Append a single event as a JSON file under
/// `<root>/events/YYYY/MM/<ulid>.json`. Creates parent directories as needed.
///
/// The YYYY/MM bucket is derived from `created_at` (expected ISO-8601 UTC,
/// `YYYY-MM-DDTHH:MM:SSZ`). If the timestamp can't be parsed we fall back
/// to `events/_unknown/`.
pub fn append_event(root: &Path, evt: &EventEnvelope) -> Result<PathBuf, EventLogError> {
    if evt.id.is_empty() {
        return Err(EventLogError::Invalid("event id is empty".into()));
    }
    if evt.event_type.is_empty() {
        return Err(EventLogError::Invalid("event_type is empty".into()));
    }

    let (year, month) = year_month_from_iso(&evt.created_at);
    let dir = match (year, month) {
        (Some(y), Some(m)) => root.join("events").join(format!("{y:04}")).join(format!("{m:02}")),
        _ => root.join("events").join("_unknown"),
    };
    std::fs::create_dir_all(&dir)?;

    let path = dir.join(format!("{}.json", evt.id));
    let json = serde_json::to_vec_pretty(evt)?;
    // Atomic-ish: write to temp then rename. Avoids leaving a half-written
    // file if we crash mid-write.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

fn year_month_from_iso(s: &str) -> (Option<u32>, Option<u32>) {
    // Expect "YYYY-MM-DD..." — only need first 7 chars.
    if s.len() < 7 {
        return (None, None);
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-' {
        return (None, None);
    }
    let year = std::str::from_utf8(&bytes[0..4]).ok().and_then(|s| s.parse().ok());
    let month = std::str::from_utf8(&bytes[5..7]).ok().and_then(|s| s.parse().ok());
    (year, month)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_event_writes_file() {
        let tmp = tempfile::tempdir().unwrap();
        let evt = EventEnvelope {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string(),
            event_type: "voice.captured".to_string(),
            created_at: "2026-05-01T12:34:56Z".to_string(),
            payload: serde_json::json!({"item_id": "01ARZ", "preview": "hello"}),
        };
        let path = append_event(tmp.path(), &evt).unwrap();
        assert!(path.exists());
        assert_eq!(
            path,
            tmp.path()
                .join("events")
                .join("2026")
                .join("05")
                .join("01ARZ3NDEKTSV4RRFFQ69G5FAV.json"),
        );

        let read: EventEnvelope =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read.event_type, "voice.captured");
        assert_eq!(read.id, evt.id);
    }

    #[test]
    fn append_event_falls_back_for_unparseable_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let evt = EventEnvelope {
            id: "abc".to_string(),
            event_type: "test".to_string(),
            created_at: "not-a-date".to_string(),
            payload: serde_json::json!({}),
        };
        let path = append_event(tmp.path(), &evt).unwrap();
        assert!(path.starts_with(tmp.path().join("events").join("_unknown")));
    }

    #[test]
    fn append_event_rejects_empty_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let evt = EventEnvelope {
            id: String::new(),
            event_type: "x".to_string(),
            created_at: "2026-05-01T00:00:00Z".to_string(),
            payload: serde_json::json!({}),
        };
        assert!(append_event(tmp.path(), &evt).is_err());
    }
}
