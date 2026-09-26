use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::DbError;

#[derive(Debug, Clone, Serialize)]
pub struct DailyFocusNote {
    pub local_date: String,
    pub content: String,
    pub updated_at: String,
}

pub fn get(conn: &Connection, local_date: &str) -> Result<Option<DailyFocusNote>, DbError> {
    conn.query_row(
        "SELECT local_date, content, updated_at FROM daily_focus_notes WHERE local_date = ?1",
        params![local_date],
        |row| Ok(DailyFocusNote {
            local_date: row.get(0)?,
            content: row.get(1)?,
            updated_at: row.get(2)?,
        }),
    ).optional().map_err(Into::into)
}

pub fn save(conn: &Connection, local_date: &str, content: &str) -> Result<DailyFocusNote, DbError> {
    let updated_at = crate::db::items::chrono_now_iso();
    if content.is_empty() {
        conn.execute("DELETE FROM daily_focus_notes WHERE local_date = ?1", params![local_date])?;
    } else {
        conn.execute(
            "INSERT INTO daily_focus_notes (local_date, content, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(local_date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            params![local_date, content, updated_at],
        )?;
    }
    Ok(DailyFocusNote { local_date: local_date.to_owned(), content: content.to_owned(), updated_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_replaces_one_note_per_local_day() {
        let db = crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap();
        db.with_conn(|conn| {
            assert!(get(conn, "2026-09-25")?.is_none());
            save(conn, "2026-09-25", "First")?;
            save(conn, "2026-09-25", "Revised")?;
            assert_eq!(get(conn, "2026-09-25")?.unwrap().content, "Revised");
            assert!(get(conn, "2026-09-26")?.is_none());
            save(conn, "2026-09-25", "")?;
            assert!(get(conn, "2026-09-25")?.is_none());
            Ok(())
        }).unwrap();
    }
}
