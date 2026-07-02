//! Embeds pending sources into the vector store. Idempotent + incremental via
//! a per-source content hash. Embedding happens OUTSIDE the DB lock so a
//! multi-minute backfill never blocks voice capture / other DB writers.

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tracing::info;

use crate::db::embeddings::{self, EmbeddingRow};
use crate::db::{Db, DbError};
use crate::embed::{EmbedDocs, EmbedError, EMBED_DIM};

use super::source::collect_source_docs;
use super::{chunk, SourceDoc};

#[derive(Debug, Default, Clone, Copy)]
pub struct IndexStats {
    pub sources_indexed: usize,
    pub sources_skipped: usize,
    pub passages_written: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Embed(#[from] EmbedError),
}

fn content_hash(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn build_rows(
    doc: &SourceDoc,
    passages: &[String],
    vectors: &[Vec<f32>],
    hash: &str,
    model_id: &str,
    created_at: &str,
) -> Vec<EmbeddingRow> {
    passages
        .iter()
        .zip(vectors.iter())
        .enumerate()
        .map(|(i, (text, vec))| EmbeddingRow {
            id: format!("{}:{}:{}", doc.source_kind, doc.source_id, i),
            source_kind: doc.source_kind.to_string(),
            source_id: doc.source_id.clone(),
            passage_idx: i as i64,
            passage_text: text.clone(),
            vec: vec.clone(),
            dim: EMBED_DIM as i64,
            model_id: model_id.to_string(),
            project_id: doc.project_id.clone(),
            captured_at: doc.captured_at.clone(),
            content_hash: hash.to_string(),
            created_at: created_at.to_string(),
        })
        .collect()
}

/// Chunk + embed one doc (NO database access). Returns `None` if the doc is
/// unchanged (hash match) or produces no passages. Embedding errors surface
/// here, outside any DB lock.
fn prepare_doc(
    doc: &SourceDoc,
    prev_hash: Option<&str>,
    embedder: &dyn EmbedDocs,
    model_id: &str,
    created_at: &str,
) -> Result<Option<(String, Vec<EmbeddingRow>)>, IndexError> {
    let hash = content_hash(&doc.text);
    if prev_hash == Some(hash.as_str()) {
        return Ok(None);
    }
    let passages = chunk::passages(&doc.text, doc.max_passages);
    if passages.is_empty() {
        return Ok(None);
    }
    let vectors = embedder.embed_documents(&passages)?;
    let rows = build_rows(doc, &passages, &vectors, &hash, model_id, created_at);
    Ok(Some((hash, rows)))
}

/// Index a batch against a single owned connection. Used by tests (which have a
/// `Connection`, not a `Db`) and by any caller that already holds the conn.
pub fn index_docs(
    conn: &mut Connection,
    docs: &[SourceDoc],
    embedder: &dyn EmbedDocs,
    model_id: &str,
) -> Result<IndexStats, IndexError> {
    let mut stats = IndexStats::default();
    for doc in docs {
        let prev = embeddings::get_index_state(conn, doc.source_kind, &doc.source_id)?;
        let created = now_iso();
        match prepare_doc(doc, prev.as_deref(), embedder, model_id, &created)? {
            None => stats.sources_skipped += 1,
            Some((hash, rows)) => {
                embeddings::replace_source_embeddings(conn, doc.source_kind, &doc.source_id, &rows)?;
                embeddings::set_index_state(
                    conn,
                    doc.source_kind,
                    &doc.source_id,
                    &hash,
                    model_id,
                    &created,
                )?;
                stats.sources_indexed += 1;
                stats.passages_written += rows.len();
            }
        }
    }
    Ok(stats)
}

/// Live entry point: collect all sources and index the pending ones. Acquires
/// the DB lock per-doc (reads state, writes rows) and embeds BETWEEN locks, so
/// a long backfill never holds the connection during model inference.
pub fn index_pending(
    db: &Db,
    embedder: &dyn EmbedDocs,
    model_id: &str,
) -> Result<IndexStats, IndexError> {
    let docs = db.with_conn(collect_source_docs)?;
    let mut stats = IndexStats::default();
    for doc in &docs {
        let prev = db.with_conn(|c| embeddings::get_index_state(c, doc.source_kind, &doc.source_id))?;
        let created = now_iso();
        match prepare_doc(doc, prev.as_deref(), embedder, model_id, &created)? {
            None => stats.sources_skipped += 1,
            Some((hash, rows)) => {
                db.with_conn_mut(|c| {
                    embeddings::replace_source_embeddings(c, doc.source_kind, &doc.source_id, &rows)?;
                    embeddings::set_index_state(
                        c,
                        doc.source_kind,
                        &doc.source_id,
                        &hash,
                        model_id,
                        &created,
                    )?;
                    Ok(())
                })?;
                stats.sources_indexed += 1;
                stats.passages_written += rows.len();
                if stats.sources_indexed % 50 == 0 {
                    info!(target: "index", indexed = stats.sources_indexed, passages = stats.passages_written, "indexing progress");
                }
            }
        }
    }
    if stats.sources_indexed > 0 {
        info!(target: "index", indexed = stats.sources_indexed, skipped = stats.sources_skipped, passages = stats.passages_written, "index pass complete");
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Stub;
    impl EmbedDocs for Stub {
        fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
            Ok(texts.iter().map(|_| vec![0.1_f32; EMBED_DIM]).collect())
        }
    }

    fn mem() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&mut c).unwrap();
        c
    }

    fn insert_item(c: &Connection, id: &str, content: &str) {
        c.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES (?1, ?2, 'voice_at_cursor', 'note', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
            rusqlite::params![id, content],
        )
        .unwrap();
    }

    fn docs(c: &Connection) -> Vec<SourceDoc> {
        collect_source_docs(c).unwrap()
    }

    #[test]
    fn indexes_items_then_is_idempotent() {
        let mut c = mem();
        insert_item(&c, "i1", "first note about pricing");
        insert_item(&c, "i2", "second note about scheduling");

        let d = docs(&c);
        let s1 = index_docs(&mut c, &d, &Stub, "m").unwrap();
        assert_eq!(s1.sources_indexed, 2);
        assert_eq!(embeddings::count_embeddings(&c).unwrap(), 2);

        // Second pass: nothing changed -> all skipped, no new rows.
        let d2 = docs(&c);
        let s2 = index_docs(&mut c, &d2, &Stub, "m").unwrap();
        assert_eq!(s2.sources_indexed, 0);
        assert_eq!(s2.sources_skipped, 2);
        assert_eq!(embeddings::count_embeddings(&c).unwrap(), 2);
    }

    #[test]
    fn reindexes_when_content_changes() {
        let mut c = mem();
        insert_item(&c, "i1", "original content");
        let d = docs(&c);
        index_docs(&mut c, &d, &Stub, "m").unwrap();

        c.execute("UPDATE items SET content = 'edited content' WHERE id = 'i1'", [])
            .unwrap();
        let d2 = docs(&c);
        let s = index_docs(&mut c, &d2, &Stub, "m").unwrap();
        assert_eq!(s.sources_indexed, 1);
        assert_eq!(embeddings::count_embeddings(&c).unwrap(), 1);
    }
}
