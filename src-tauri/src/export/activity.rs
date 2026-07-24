//! Activity export: render a time-bounded slice of all captured text
//! (transcriptions, notes, tasks, meetings) as one Markdown or CSV document.
//!
//! Used by the dashboard "Export" button so the user can feed a day's worth
//! of activity to external tools (e.g. drafting social media content).

use crate::db::items::{Item, ItemKind, ItemSource};
use crate::db::meetings::MeetingRow;
use crate::meeting::synthesizer::StoredSummary;

/// One exportable unit: the item plus everything needed to render it without
/// further DB access.
pub struct ActivityEntry {
    pub item: Item,
    pub project_name: Option<String>,
    /// Present when the item is a meeting record (source = meeting, kind
    /// column = 'meeting') — carries the synthesized summary + notes.
    pub meeting: Option<MeetingRow>,
}

/// Human label for an entry's kind. Meeting records parse `kind` to `None`,
/// so detect them via the attached meeting row / source.
fn kind_label(e: &ActivityEntry) -> &'static str {
    if e.meeting.is_some() {
        return "Meeting";
    }
    match e.item.kind {
        Some(ItemKind::Note) => "Note",
        Some(ItemKind::Task) => "Task",
        Some(ItemKind::Transcription) => "Transcription",
        None => {
            if matches!(e.item.source, ItemSource::Meeting) {
                "Meeting"
            } else {
                "Capture"
            }
        }
    }
}

fn parse_summary(m: &MeetingRow) -> Option<StoredSummary> {
    m.summary_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
}

/// "2026-06-11T18:04:21Z" → "2026-06-11 18:04". Falls back to the raw string.
fn short_ts(iso: &str) -> String {
    match (iso.get(0..10), iso.get(11..16)) {
        (Some(d), Some(t)) => format!("{d} {t}"),
        _ => iso.to_string(),
    }
}

pub fn render_markdown(entries: &[ActivityEntry], range_label: &str, generated_at: &str) -> String {
    let mut out = String::new();
    out.push_str("# Echo Scribe activity export\n\n");
    out.push_str(&format!(
        "**Range:** {range_label} · **Items:** {} · **Generated:** {}\n\n",
        entries.len(),
        short_ts(generated_at)
    ));

    for e in entries {
        let kind = kind_label(e);
        let project = e.project_name.as_deref().unwrap_or("No project");
        out.push_str(&format!(
            "## {} — {kind} ({project})\n\n",
            short_ts(&e.item.captured_at)
        ));

        if let Some(m) = &e.meeting {
            let summary = parse_summary(m);
            if let Some(s) = &summary {
                if !s.suggested_title.trim().is_empty() {
                    out.push_str(&format!("**{}**\n\n", s.suggested_title.trim()));
                }
                if !s.summary.is_empty() {
                    out.push_str("### Summary\n\n");
                    for bullet in &s.summary {
                        out.push_str(&format!("- {bullet}\n"));
                    }
                    out.push('\n');
                }
                if !s.action_items.is_empty() {
                    out.push_str("### Action items\n\n");
                    for a in &s.action_items {
                        out.push_str(&format!("- ({}) {}\n", a.owner, a.text));
                    }
                    out.push('\n');
                }
            }
            if let Some(notes) = m.user_notes.as_deref() {
                if !notes.trim().is_empty() {
                    out.push_str("### Notes\n\n");
                    out.push_str(notes.trim());
                    out.push_str("\n\n");
                }
            }
            if !e.item.content.trim().is_empty() {
                out.push_str("### Transcript\n\n");
                out.push_str(e.item.content.trim());
                out.push_str("\n\n");
            }
        } else {
            out.push_str(e.item.content.trim());
            out.push_str("\n\n");
        }
    }

    out
}

/// RFC-4180-ish escaping: wrap in quotes when the field contains a comma,
/// quote, or newline; double any inner quotes.
fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn render_csv(entries: &[ActivityEntry]) -> String {
    let mut out = String::from("captured_at,kind,project,source,content\n");
    for e in entries {
        // For meetings, prepend the synthesized summary so the CSV row is
        // useful without the markdown export.
        let content = if let Some(m) = &e.meeting {
            let mut c = String::new();
            if let Some(s) = parse_summary(m) {
                if !s.suggested_title.trim().is_empty() {
                    c.push_str(&format!("{}\n", s.suggested_title.trim()));
                }
                for bullet in &s.summary {
                    c.push_str(&format!("- {bullet}\n"));
                }
            }
            c.push_str(e.item.content.trim());
            c
        } else {
            e.item.content.trim().to_string()
        };
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            csv_field(&e.item.captured_at),
            csv_field(kind_label(e)),
            csv_field(e.project_name.as_deref().unwrap_or("")),
            csv_field(e.item.source.as_str()),
            csv_field(&content),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_item(id: &str, kind: Option<ItemKind>, content: &str) -> Item {
        Item {
            id: id.into(),
            content: content.into(),
            source: ItemSource::VoiceAtCursor,
            kind,
            project_id: None,
            captured_at: "2026-06-11T09:30:00Z".into(),
            created_at: "2026-06-11T09:30:00Z".into(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context: None,
        }
    }

    fn entry(item: Item, project: Option<&str>) -> ActivityEntry {
        ActivityEntry {
            item,
            project_name: project.map(|s| s.to_string()),
            meeting: None,
        }
    }

    #[test]
    fn markdown_renders_header_and_items() {
        let entries = vec![
            entry(
                make_item("a", Some(ItemKind::Transcription), "hello world"),
                Some("Acme"),
            ),
            entry(make_item("b", Some(ItemKind::Note), "a note"), None),
        ];
        let md = render_markdown(&entries, "Past 24 hours", "2026-06-11T10:00:00Z");
        assert!(md.contains("# Echo Scribe activity export"));
        assert!(md.contains("**Range:** Past 24 hours · **Items:** 2"));
        assert!(md.contains("## 2026-06-11 09:30 — Transcription (Acme)"));
        assert!(md.contains("hello world"));
        assert!(md.contains("## 2026-06-11 09:30 — Note (No project)"));
        assert!(md.contains("a note"));
    }

    #[test]
    fn markdown_renders_meeting_summary_and_transcript() {
        let mut item = make_item("m", None, "You: hi\nThem: hello");
        item.source = ItemSource::Meeting;
        let meeting = MeetingRow {
            item_id: "m".into(),
            started_at: "2026-06-11T09:00:00Z".into(),
            ended_at: None,
            duration_ms: Some(60_000),
            detected_app: None,
            detected_app_name: None,
            status: "complete".into(),
            transcript_json: None,
            summary_json: Some(
                r#"{"summary":["Talked roadmap"],"action_items":[{"text":"Ship it","owner":"you"}],"suggested_title":"Sync","raw":null}"#
                    .into(),
            ),
            user_notes: Some("remember pricing".into()),
            failed_chunk_count: 0,
            mic_only: false,
            guide_template_json: None,
            project_name: None,
        };
        let entries = vec![ActivityEntry {
            item,
            project_name: None,
            meeting: Some(meeting),
        }];
        let md = render_markdown(&entries, "Today", "2026-06-11T10:00:00Z");
        assert!(md.contains("— Meeting (No project)"));
        assert!(md.contains("**Sync**"));
        assert!(md.contains("- Talked roadmap"));
        assert!(md.contains("- (you) Ship it"));
        assert!(md.contains("remember pricing"));
        assert!(md.contains("You: hi"));
    }

    #[test]
    fn csv_escapes_commas_quotes_newlines() {
        let entries = vec![entry(
            make_item("a", Some(ItemKind::Note), "line one, with \"quotes\"\nline two"),
            Some("Acme, Inc"),
        )];
        let csv = render_csv(&entries);
        let mut lines = csv.lines();
        assert_eq!(lines.next(), Some("captured_at,kind,project,source,content"));
        let row = &csv[csv.find('\n').unwrap() + 1..];
        assert!(row.contains("\"Acme, Inc\""));
        assert!(row.contains("\"line one, with \"\"quotes\"\"\nline two\""));
    }
}
