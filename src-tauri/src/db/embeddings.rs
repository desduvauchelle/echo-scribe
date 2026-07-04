//! Storage for passage embeddings + per-source index state.

use rusqlite::{params, Connection};

use crate::db::DbError;
use crate::embed::math::{blob_to_vec, vec_to_blob};

#[derive(Debug, Clone)]
pub struct EmbeddingRow {
    pub id: String,
    pub source_kind: String,
    pub source_id: String,
    pub passage_idx: i64,
    pub passage_text: String,
    pub vec: Vec<f32>,
    pub dim: i64,
    pub model_id: String,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub content_hash: String,
    pub created_at: String,
}

/// Replace ALL embeddings for one source in a single transaction (delete then
/// insert), so re-indexing an edited source can't leave stale passages.
pub fn replace_source_embeddings(
    conn: &mut Connection,
    source_kind: &str,
    source_id: &str,
    rows: &[EmbeddingRow],
) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM embeddings WHERE source_kind = ?1 AND source_id = ?2",
        params![source_kind, source_id],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO embeddings
               (id, source_kind, source_id, passage_idx, passage_text, vec, dim,
                model_id, project_id, captured_at, content_hash, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        )?;
        for r in rows {
            stmt.execute(params![
                r.id,
                r.source_kind,
                r.source_id,
                r.passage_idx,
                r.passage_text,
                vec_to_blob(&r.vec),
                r.dim,
                r.model_id,
                r.project_id,
                r.captured_at,
                r.content_hash,
                r.created_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The content hash last successfully indexed for a source, if any.
pub fn get_index_state(
    conn: &Connection,
    source_kind: &str,
    source_id: &str,
) -> Result<Option<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT content_hash FROM embedding_index_state WHERE source_kind = ?1 AND source_id = ?2",
    )?;
    let mut rows = stmt.query(params![source_kind, source_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_index_state(
    conn: &Connection,
    source_kind: &str,
    source_id: &str,
    content_hash: &str,
    model_id: &str,
    indexed_at: &str,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO embedding_index_state (source_kind, source_id, content_hash, model_id, indexed_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(source_kind, source_id)
         DO UPDATE SET content_hash = excluded.content_hash,
                       model_id = excluded.model_id,
                       indexed_at = excluded.indexed_at",
        params![source_kind, source_id, content_hash, model_id, indexed_at],
    )?;
    Ok(())
}

pub fn count_embeddings(conn: &Connection) -> Result<i64, DbError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?)
}

pub fn count_indexed_sources(conn: &Connection) -> Result<i64, DbError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM embedding_index_state", [], |r| r.get(0))?)
}

/// Test/diagnostic helper: fetch a source's passages (vectors decoded).
pub fn fetch_by_source(
    conn: &Connection,
    source_kind: &str,
    source_id: &str,
) -> Result<Vec<EmbeddingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, source_kind, source_id, passage_idx, passage_text, vec, dim,
                model_id, project_id, captured_at, content_hash, created_at
         FROM embeddings WHERE source_kind = ?1 AND source_id = ?2
         ORDER BY passage_idx ASC",
    )?;
    let rows = stmt.query_map(params![source_kind, source_id], |row| {
        let blob: Vec<u8> = row.get(5)?;
        Ok(EmbeddingRow {
            id: row.get(0)?,
            source_kind: row.get(1)?,
            source_id: row.get(2)?,
            passage_idx: row.get(3)?,
            passage_text: row.get(4)?,
            vec: blob_to_vec(&blob),
            dim: row.get(6)?,
            model_id: row.get(7)?,
            project_id: row.get(8)?,
            captured_at: row.get(9)?,
            content_hash: row.get(10)?,
            created_at: row.get(11)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&mut c).unwrap();
        c
    }

    fn row(idx: i64, hash: &str) -> EmbeddingRow {
        EmbeddingRow {
            id: format!("e{idx}"),
            source_kind: "item".into(),
            source_id: "item-1".into(),
            passage_idx: idx,
            passage_text: format!("passage {idx}"),
            vec: vec![0.1, 0.2, 0.3],
            dim: 3,
            model_id: "m".into(),
            project_id: None,
            captured_at: "2026-06-01T00:00:00Z".into(),
            content_hash: hash.into(),
            created_at: "2026-06-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn replace_then_fetch_roundtrips_vectors() {
        let mut c = mem();
        replace_source_embeddings(&mut c, "item", "item-1", &[row(0, "h1"), row(1, "h1")]).unwrap();
        let got = fetch_by_source(&c, "item", "item-1").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].vec, vec![0.1, 0.2, 0.3]);
        assert_eq!(count_embeddings(&c).unwrap(), 2);
    }

    #[test]
    fn replace_deletes_previous_passages() {
        let mut c = mem();
        replace_source_embeddings(&mut c, "item", "item-1", &[row(0, "h1"), row(1, "h1")]).unwrap();
        replace_source_embeddings(&mut c, "item", "item-1", &[row(0, "h2")]).unwrap();
        assert_eq!(count_embeddings(&c).unwrap(), 1);
    }

    #[test]
    fn index_state_upserts() {
        let c = mem();
        assert_eq!(get_index_state(&c, "item", "x").unwrap(), None);
        set_index_state(&c, "item", "x", "h1", "m", "t1").unwrap();
        assert_eq!(get_index_state(&c, "item", "x").unwrap().as_deref(), Some("h1"));
        set_index_state(&c, "item", "x", "h2", "m", "t2").unwrap();
        assert_eq!(get_index_state(&c, "item", "x").unwrap().as_deref(), Some("h2"));
        assert_eq!(count_indexed_sources(&c).unwrap(), 1);
    }
}
