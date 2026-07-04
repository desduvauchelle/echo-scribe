//! Turns DB rows (items, meeting summaries, daily summaries) into SourceDocs.

use rusqlite::Connection;

use crate::db::DbError;
use crate::meeting::synthesizer::StoredSummary;

use super::SourceDoc;

/// Items get up to this many passages (bounds 40k-token meeting transcripts).
const ITEM_MAX_PASSAGES: usize = 40;
const SUMMARY_MAX_PASSAGES: usize = 8;

/// Render a meeting's `summary_json` into plain text for embedding.
/// Returns None if the JSON is missing/unparseable/empty.
pub fn render_meeting_summary(summary_json: &str) -> Option<String> {
    let s: StoredSummary = serde_json::from_str(summary_json).ok()?;
    let mut parts: Vec<String> = Vec::new();
    if !s.suggested_title.trim().is_empty() {
        parts.push(s.suggested_title.trim().to_string());
    }
    for b in &s.summary {
        if !b.trim().is_empty() {
            parts.push(format!("- {}", b.trim()));
        }
    }
    if !s.action_items.is_empty() {
        parts.push("Action items:".to_string());
        for a in &s.action_items {
            if !a.text.trim().is_empty() {
                parts.push(format!("- {} ({})", a.text.trim(), a.owner));
            }
        }
    }
    let text = parts.join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Collect every embeddable source currently in the DB.
pub fn collect_source_docs(conn: &Connection) -> Result<Vec<SourceDoc>, DbError> {
    let mut docs = Vec::new();

    // 1) Raw items (voice notes, log captures, meeting transcript items).
    for it in crate::db::items::list_items_since(conn, None)? {
        if it.content.trim().is_empty() {
            continue;
        }
        docs.push(SourceDoc {
            source_kind: "item",
            source_id: it.id,
            project_id: it.project_id,
            captured_at: it.captured_at,
            text: it.content,
            max_passages: ITEM_MAX_PASSAGES,
        });
    }

    // 2) Meeting summaries (concise overviews of the monster transcripts).
    for m in crate::db::meetings::list_meetings(conn)? {
        if let Some(json) = &m.summary_json {
            if let Some(text) = render_meeting_summary(json) {
                docs.push(SourceDoc {
                    source_kind: "meeting_summary",
                    source_id: m.item_id.clone(),
                    project_id: None,
                    captured_at: m.started_at.clone(),
                    text,
                    max_passages: SUMMARY_MAX_PASSAGES,
                });
            }
        }
    }

    // 3) Daily summaries (the rolling per-day narrative).
    for d in crate::db::daily_summaries::list_recent(conn, u32::MAX)? {
        if d.narrative.trim().is_empty() {
            continue;
        }
        docs.push(SourceDoc {
            source_kind: "daily_summary",
            source_id: d.date.clone(),
            project_id: None,
            captured_at: d.generated_at.clone(),
            text: d.narrative.clone(),
            max_passages: SUMMARY_MAX_PASSAGES,
        });
    }

    Ok(docs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::synthesizer::{ActionItem, StoredSummary};

    #[test]
    fn renders_meeting_summary_with_actions() {
        let s = StoredSummary {
            summary: vec!["Discussed Q3 launch".into()],
            action_items: vec![ActionItem {
                text: "Send pricing deck".into(),
                owner: "you".into(),
                tags: vec![],
                project_name: None,
            }],
            suggested_title: "Q3 Planning".into(),
            raw: None,
            tags: vec![],
            project_name: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        let text = render_meeting_summary(&json).unwrap();
        assert!(text.contains("Q3 Planning"));
        assert!(text.contains("Discussed Q3 launch"));
        assert!(text.contains("Send pricing deck (you)"));
    }

    #[test]
    fn unparseable_summary_returns_none() {
        assert!(render_meeting_summary("not json").is_none());
    }
}
