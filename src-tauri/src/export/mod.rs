//! Markdown export to user-configured per-project folders.
//!
//! When the classifier routes an item to a project with a configured
//! `export_folder` AND the classification confidence clears the user's
//! threshold, we render the item as a markdown file under that folder so the
//! user can read / sync / feed it to external AI tools.
//!
//! Hooks fire from:
//!   - `coordinator::persist_log_capture` (overlay-confirmed captures)
//!   - `coordinator::auto_file_log_capture` (high-confidence auto-files)
//!   - `meeting::finalize` (synthesized meetings — always export when folder set)
//!   - `commands::update_item` (re-export on edit)
//!
//! Filename: `YYYY-MM-DD-HHMM-{slug}.md`, in a subfolder by kind
//! (`notes/`, `tasks/`, `transcriptions/`, `meetings/`). Filename is derived
//! from `id` for stability across edits: same id → same filename → overwrite.

pub mod activity;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing::{info, warn};

use crate::db::items::{Item, ItemKind, ItemSource};
use crate::db::meetings::MeetingRow;
use crate::db::projects::Project;
use crate::db::Db;

/// Owner string used for action items.
fn _unused() {}

/// Result of a single export attempt. `None` = nothing exported (folder unset,
/// confidence below threshold, or item kind unsupported); `Some(path)` = wrote
/// markdown to that absolute path.
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
}

#[derive(Debug)]
pub enum ExportSkip {
    NoFolder,
    BelowThreshold { confidence: f32, threshold: f32 },
    UnsupportedKind,
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("db: {0}")]
    Db(#[from] crate::db::DbError),
    #[error("invalid item: {0}")]
    Invalid(String),
}

/// Subfolder name (under `project.export_folder`) for a given item kind.
fn subfolder_for_item(item: &Item) -> Option<&'static str> {
    // Meeting-derived items (kind = task, source = meeting) still go under
    // tasks/. The standalone meeting record uses `export_meeting` instead.
    match item.kind {
        Some(ItemKind::Note) => Some("notes"),
        Some(ItemKind::Task) => Some("tasks"),
        Some(ItemKind::Transcription) => Some("transcriptions"),
        None => None,
    }
}

/// Slug for a filename: first ~40 chars of input, kebab-case, alphanum/dash only.
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(40);
    let mut last_dash = true;
    for ch in s.chars() {
        if out.chars().filter(|&c| c != '-').count() >= 40 {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

/// Build the filename stem from an ISO-8601 UTC timestamp + a human-readable
/// label. Format: `YYYY-MM-DD-HHMM-{slug}`. Does NOT append `.md`.
fn filename_stem(iso_ts: &str, label: &str) -> String {
    // iso_ts looks like "2026-05-26T15:34:21Z". Take the date + first two
    // hour/minute digits.
    let date_part = iso_ts.get(0..10).unwrap_or("0000-00-00");
    let hour = iso_ts.get(11..13).unwrap_or("00");
    let minute = iso_ts.get(14..16).unwrap_or("00");
    format!("{date_part}-{hour}{minute}-{}", slugify(label))
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), ExportError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write to a sibling tmp file then rename — avoids leaving a half-written
    // file if the process dies mid-write.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Remove any prior file in `dir` whose name ends with `-{id_suffix}.md`. Used
/// to clean up stale exports when an item's content (and therefore filename
/// slug) has changed since the last export. Best-effort.
fn remove_stale_exports(dir: &Path, id_suffix: &str, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let suffix_match = format!("-{id_suffix}.md");
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.ends_with(&suffix_match) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn yaml_escape(s: &str) -> String {
    // Conservative: only wrap in double-quotes and escape `"` / backslash.
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn render_item(item: &Item, project: &Project, tags: &[String]) -> String {
    let kind_str = item.kind.map(|k| k.as_str()).unwrap_or("unknown");
    let source_str = item.source.as_str();
    let mut tags_yaml = String::from("[]");
    if !tags.is_empty() {
        tags_yaml = format!(
            "[{}]",
            tags.iter()
                .map(|t| yaml_escape(t))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let confidence_line = item
        .confidence
        .map(|c| format!("confidence: {c:.3}\n"))
        .unwrap_or_default();
    let classified_by_line = item
        .classified_by
        .as_deref()
        .map(|s| format!("classified_by: {}\n", yaml_escape(s)))
        .unwrap_or_default();
    let title_label = match item.kind {
        Some(ItemKind::Task) => "Task",
        Some(ItemKind::Note) => "Note",
        Some(ItemKind::Transcription) => "Transcription",
        None => "Item",
    };

    format!(
        "---\n\
        id: {id}\n\
        kind: {kind}\n\
        source: {source}\n\
        project: {project}\n\
        captured_at: {captured}\n\
        {confidence}{classified}tags: {tags}\n\
        ---\n\
        \n\
        # {title_label}\n\
        \n\
        {content}\n",
        id = item.id,
        kind = kind_str,
        source = source_str,
        project = yaml_escape(&project.name),
        captured = item.captured_at,
        confidence = confidence_line,
        classified = classified_by_line,
        tags = tags_yaml,
        title_label = title_label,
        content = item.content.trim(),
    )
}

fn render_meeting(meeting: &MeetingRow, item: &Item, project: &Project, tags: &[String]) -> String {
    let mut tags_yaml = String::from("[]");
    if !tags.is_empty() {
        tags_yaml = format!(
            "[{}]",
            tags.iter()
                .map(|t| yaml_escape(t))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let stored: Option<crate::meeting::synthesizer::StoredSummary> = meeting
        .summary_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    let title = stored
        .as_ref()
        .map(|s| s.suggested_title.clone())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Meeting".to_string());

    let duration_min = meeting.duration_ms.map(|d| d / 60_000).unwrap_or(0);
    let detected_app = meeting
        .detected_app_name
        .as_deref()
        .unwrap_or("unknown app");

    let mut body = String::new();
    body.push_str(&format!("# {title}\n\n"));
    body.push_str(&format!(
        "**Started:** {} · **Duration:** {} min · **App:** {}\n\n",
        meeting.started_at, duration_min, detected_app
    ));

    if let Some(s) = stored {
        if !s.summary.is_empty() {
            body.push_str("## Summary\n\n");
            for bullet in &s.summary {
                body.push_str(&format!("- {bullet}\n"));
            }
            body.push('\n');
        }
        if !s.action_items.is_empty() {
            body.push_str("## Action items\n\n");
            for a in &s.action_items {
                body.push_str(&format!("- [ ] ({}) {}\n", a.owner, a.text));
            }
            body.push('\n');
        }
    }

    if let Some(notes) = meeting.user_notes.as_deref() {
        let trimmed = notes.trim();
        if !trimmed.is_empty() {
            body.push_str("## User notes\n\n");
            body.push_str(trimmed);
            body.push_str("\n\n");
        }
    }

    if !item.content.trim().is_empty() {
        body.push_str("## Transcript\n\n");
        body.push_str(item.content.trim());
        body.push('\n');
    }

    format!(
        "---\n\
        id: {id}\n\
        kind: meeting\n\
        source: meeting\n\
        project: {project}\n\
        captured_at: {captured}\n\
        duration_ms: {dur}\n\
        tags: {tags}\n\
        ---\n\
        \n\
        {body}",
        id = item.id,
        project = yaml_escape(&project.name),
        captured = meeting.started_at,
        dur = meeting.duration_ms.unwrap_or(0),
        tags = tags_yaml,
        body = body,
    )
}

/// Fire-and-log export for a freshly-persisted or edited Item. Returns the
/// written path on success, or a structured skip reason. Never propagates
/// errors to the caller — logs them and returns `Err` so the caller can
/// optionally surface a friendly toast.
pub fn export_item(
    db: &Db,
    item: &Item,
    threshold: f32,
) -> Result<Result<ExportResult, ExportSkip>, ExportError> {
    // Meetings have their own path (`export_meeting`); reject misuse.
    if matches!(item.source, ItemSource::Meeting) && item.kind.is_none() {
        return Ok(Err(ExportSkip::UnsupportedKind));
    }

    let Some(project_id) = item.project_id.as_deref() else {
        return Ok(Err(ExportSkip::NoFolder));
    };

    let project = db.with_conn(|c| crate::db::projects::get_project(c, project_id))?;
    let Some(project) = project else {
        return Ok(Err(ExportSkip::NoFolder));
    };
    let Some(folder) = project.export_folder.as_deref() else {
        return Ok(Err(ExportSkip::NoFolder));
    };
    if folder.trim().is_empty() {
        return Ok(Err(ExportSkip::NoFolder));
    }

    // Threshold gate: classification confidence must clear bar. If confidence
    // is missing (e.g. manually assigned), allow it — the user explicitly put
    // it here.
    if let Some(c) = item.confidence {
        if c < threshold {
            return Ok(Err(ExportSkip::BelowThreshold {
                confidence: c,
                threshold,
            }));
        }
    }

    let Some(sub) = subfolder_for_item(item) else {
        return Ok(Err(ExportSkip::UnsupportedKind));
    };

    let tags = db
        .with_conn(|c| crate::db::items::list_tags_for_item(c, &item.id))
        .unwrap_or_default();
    let body = render_item(item, &project, &tags);

    let label_seed = if item.content.len() > 60 {
        &item.content[..60]
    } else {
        &item.content
    };
    let stem = filename_stem(&item.captured_at, label_seed);
    // Stable across edits: append id suffix so the same item resolves to the
    // same file (and edits overwrite). `id` is a ULID — first 6 chars are
    // enough to disambiguate.
    let id_suffix = &item.id[..item.id.len().min(6)];
    let filename = format!("{stem}-{id_suffix}.md");

    let dir = PathBuf::from(folder).join(sub);
    let path = dir.join(&filename);
    write_atomic(&path, &body)?;
    remove_stale_exports(&dir, id_suffix, &path);

    info!(
        target: "export",
        item_id = %item.id,
        project = %project.name,
        path = %path.display(),
        "exported item to markdown"
    );
    Ok(Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
    }))
}

/// Export a finalized meeting. Meetings always export when the project has a
/// folder set — no confidence gate (they're user-initiated and reviewed).
pub fn export_meeting(
    db: &Db,
    meeting: &MeetingRow,
    item: &Item,
) -> Result<Result<ExportResult, ExportSkip>, ExportError> {
    let Some(project_id) = item.project_id.as_deref() else {
        return Ok(Err(ExportSkip::NoFolder));
    };

    let project = db.with_conn(|c| crate::db::projects::get_project(c, project_id))?;
    let Some(project) = project else {
        return Ok(Err(ExportSkip::NoFolder));
    };
    let Some(folder) = project.export_folder.as_deref() else {
        return Ok(Err(ExportSkip::NoFolder));
    };
    if folder.trim().is_empty() {
        return Ok(Err(ExportSkip::NoFolder));
    }

    let tags = db
        .with_conn(|c| crate::db::items::list_tags_for_item(c, &item.id))
        .unwrap_or_default();
    let body = render_meeting(meeting, item, &project, &tags);

    // Use suggested_title as filename label if present, else first 60 chars of
    // transcript content.
    let label_seed: String = serde_json::from_str::<serde_json::Value>(
        meeting.summary_json.as_deref().unwrap_or("{}"),
    )
    .ok()
    .and_then(|v| v.get("suggested_title").and_then(|t| t.as_str()).map(|s| s.to_string()))
    .filter(|s| !s.trim().is_empty())
    .unwrap_or_else(|| {
        let c = item.content.trim();
        if c.len() > 60 { c[..60].to_string() } else { c.to_string() }
    });

    let stem = filename_stem(&meeting.started_at, &label_seed);
    let id_suffix = &item.id[..item.id.len().min(6)];
    let filename = format!("{stem}-{id_suffix}.md");
    let dir = PathBuf::from(folder).join("meetings");
    let path = dir.join(&filename);
    write_atomic(&path, &body)?;
    remove_stale_exports(&dir, id_suffix, &path);

    info!(
        target: "export",
        item_id = %item.id,
        project = %project.name,
        path = %path.display(),
        "exported meeting to markdown"
    );
    Ok(Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
    }))
}

/// Wrapper that logs skip / error outcomes at info / warn but never panics or
/// returns an error to the caller. Use this from hook sites that don't want
/// to surface errors to the user beyond a log line.
pub fn try_export_item(db: &Db, item: &Item, threshold: f32) {
    match export_item(db, item, threshold) {
        Ok(Ok(_)) => {}
        Ok(Err(ExportSkip::NoFolder)) => {
            // Silent — the common case is "this project has no export folder".
        }
        Ok(Err(ExportSkip::BelowThreshold { confidence, threshold })) => {
            info!(
                target: "export",
                item_id = %item.id,
                confidence,
                threshold,
                "skipped export: confidence below threshold"
            );
        }
        Ok(Err(ExportSkip::UnsupportedKind)) => {
            info!(
                target: "export",
                item_id = %item.id,
                "skipped export: unsupported item kind"
            );
        }
        Err(e) => {
            warn!(
                target: "export",
                item_id = %item.id,
                error = %e,
                "export failed"
            );
        }
    }
}

pub fn try_export_meeting(db: &Db, meeting: &MeetingRow, item: &Item) {
    match export_meeting(db, meeting, item) {
        Ok(Ok(_)) => {}
        Ok(Err(ExportSkip::NoFolder)) => {}
        Ok(Err(other)) => {
            info!(
                target: "export",
                item_id = %item.id,
                ?other,
                "skipped meeting export"
            );
        }
        Err(e) => {
            warn!(
                target: "export",
                item_id = %item.id,
                error = %e,
                "meeting export failed"
            );
        }
    }
}

/// Backfill: re-export every non-deleted item + meeting for `project_id` to
/// the project's `export_folder`. Returns the number of files written.
pub fn backfill_project(
    db: &Db,
    project_id: &str,
    threshold: f32,
) -> Result<u32, ExportError> {
    let project = db
        .with_conn(|c| crate::db::projects::get_project(c, project_id))?
        .ok_or_else(|| ExportError::Invalid(format!("project {project_id} not found")))?;
    if project.export_folder.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        return Err(ExportError::Invalid(
            "project has no export_folder configured".into(),
        ));
    }

    let mut written: u32 = 0;

    // 1. Items (notes, tasks, transcriptions)
    let items = db.with_conn(|c| crate::db::items::list_items(c, Some(project_id), None, 10_000, 0))?;
    for item in &items {
        // Apply same gate as live hook (confidence threshold, kind support).
        match export_item(db, item, threshold) {
            Ok(Ok(_)) => written += 1,
            Ok(Err(_)) => {}
            Err(e) => warn!(target: "export", item_id = %item.id, error = %e, "backfill item failed"),
        }
    }

    // 2. Meetings: query items where source=meeting AND kind=meeting AND
    //    project_id=project_id, then look up matching meeting row.
    let meeting_items: Vec<Item> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, content, source, kind, project_id, captured_at, created_at,
                    deleted_at, confidence, classified_by, capture_context
             FROM items
             WHERE source = 'meeting' AND kind = 'meeting'
               AND project_id = ?1 AND deleted_at IS NULL",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| {
            let source_s: String = r.get("source")?;
            let kind_s: Option<String> = r.get("kind")?;
            Ok(Item {
                id: r.get("id")?,
                content: r.get("content")?,
                source: ItemSource::parse(&source_s).unwrap_or(ItemSource::Meeting),
                kind: kind_s.and_then(|s| ItemKind::parse(&s)),
                project_id: r.get("project_id")?,
                captured_at: r.get("captured_at")?,
                created_at: r.get("created_at")?,
                deleted_at: r.get("deleted_at")?,
                confidence: r.get::<_, Option<f64>>("confidence")?.map(|v| v as f32),
                classified_by: r.get("classified_by")?,
                capture_context: r.get("capture_context")?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })?;
    for item in &meeting_items {
        let meeting = db.with_conn(|c| crate::db::meetings::get_meeting(c, &item.id))?;
        if let Some(m) = meeting {
            match export_meeting(db, &m, item) {
                Ok(Ok(_)) => written += 1,
                Ok(Err(_)) => {}
                Err(e) => warn!(target: "export", item_id = %item.id, error = %e, "backfill meeting failed"),
            }
        }
    }

    info!(target: "export", project_id, written, "backfill complete");
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::ItemSource;
    use tempfile::TempDir;

    fn fresh_db() -> Db {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db");
        // Leak so the file outlives the dir; tests are short-lived.
        std::mem::forget(dir);
        Db::open_at(&path).unwrap()
    }

    fn make_project(folder: Option<&str>) -> Project {
        Project {
            id: "p1".into(),
            name: "Acme".into(),
            created_at: "2026-05-26T00:00:00Z".into(),
            archived_at: None,
            description: None,
            keywords: vec![],
            color: None,
            emoji: None,
            updated_at: None,
            export_folder: folder.map(|s| s.to_string()),
            ..Default::default()
        }
    }

    fn make_item(id: &str, kind: ItemKind, project_id: &str, confidence: Option<f32>) -> Item {
        Item {
            id: id.into(),
            content: "test content for export".into(),
            source: ItemSource::LogCapture,
            kind: Some(kind),
            project_id: Some(project_id.into()),
            captured_at: "2026-05-26T15:34:21Z".into(),
            created_at: "2026-05-26T15:34:21Z".into(),
            deleted_at: None,
            confidence,
            classified_by: Some("classifier-v1".into()),
            capture_context: None,
        }
    }

    #[test]
    fn slugify_drops_punctuation_and_caps() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  spaces   here  "), "spaces-here");
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("---"), "untitled");
    }

    #[test]
    fn filename_stem_format() {
        let s = filename_stem("2026-05-26T15:34:21Z", "My Test Note!");
        assert_eq!(s, "2026-05-26-1534-my-test-note");
    }

    #[test]
    fn export_skips_when_no_folder() {
        let db = fresh_db();
        let project = make_project(None);
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_item("01HK01", ItemKind::Note, "p1", Some(0.9));
        db.with_conn(|c| crate::db::items::insert_item(c, &item))
            .unwrap();
        let res = export_item(&db, &item, 0.75).unwrap();
        assert!(matches!(res, Err(ExportSkip::NoFolder)));
    }

    #[test]
    fn export_skips_below_threshold() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_item("01HK02", ItemKind::Note, "p1", Some(0.5));
        db.with_conn(|c| crate::db::items::insert_item(c, &item))
            .unwrap();
        let res = export_item(&db, &item, 0.75).unwrap();
        assert!(matches!(res, Err(ExportSkip::BelowThreshold { .. })));
    }

    #[test]
    fn export_writes_file_in_kind_subfolder() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_item("01HK03", ItemKind::Task, "p1", Some(0.95));
        db.with_conn(|c| crate::db::items::insert_item(c, &item))
            .unwrap();
        let res = export_item(&db, &item, 0.75).unwrap().unwrap();
        let p = std::path::Path::new(&res.path);
        assert!(p.exists(), "exported file should exist at {}", p.display());
        assert!(p.starts_with(dir.path().join("tasks")));
        let body = std::fs::read_to_string(p).unwrap();
        assert!(body.contains("kind: task"));
        assert!(body.contains("project: \"Acme\""));
        assert!(body.contains("test content for export"));
    }

    #[test]
    fn export_replaces_stale_file_on_reexport() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let mut item = make_item("01HK04", ItemKind::Note, "p1", Some(0.95));
        db.with_conn(|c| crate::db::items::insert_item(c, &item))
            .unwrap();
        let first = export_item(&db, &item, 0.75).unwrap().unwrap();
        assert!(std::path::Path::new(&first.path).exists());

        // Edit content; filename derives from content slug + id suffix. Re-export
        // should write a new file AND clean up the old one so the project folder
        // never has two files for the same item.
        item.content = "updated content".into();
        let second = export_item(&db, &item, 0.75).unwrap().unwrap();
        assert!(std::path::Path::new(&second.path).exists());

        let notes_dir = dir.path().join("notes");
        let count = std::fs::read_dir(&notes_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
            .count();
        assert_eq!(count, 1, "exactly one md file should remain after re-export");

        let body = std::fs::read_to_string(&second.path).unwrap();
        assert!(body.contains("updated content"));
        assert!(!body.contains("test content for export"));
    }

    // -------------------------------------------------------------------------
    // Gap-filling tests
    // -------------------------------------------------------------------------

    #[test]
    fn export_allows_item_with_no_confidence() {
        // User-confirmed log captures pass `confidence = None`. They must
        // export regardless of threshold (the user explicitly confirmed).
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_item("01HKM1", ItemKind::Note, "p1", None);
        db.with_conn(|c| crate::db::items::insert_item(c, &item))
            .unwrap();
        let res = export_item(&db, &item, 0.99).unwrap().unwrap();
        assert!(std::path::Path::new(&res.path).exists());
    }

    #[test]
    fn export_routes_each_kind_to_its_subfolder() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let cases = [
            (ItemKind::Note, "notes"),
            (ItemKind::Task, "tasks"),
            (ItemKind::Transcription, "transcriptions"),
        ];
        for (i, (kind, sub)) in cases.iter().enumerate() {
            let id = format!("01HKK{i}");
            let item = make_item(&id, *kind, "p1", Some(0.95));
            db.with_conn(|c| crate::db::items::insert_item(c, &item))
                .unwrap();
            let res = export_item(&db, &item, 0.75).unwrap().unwrap();
            let p = std::path::Path::new(&res.path);
            assert!(
                p.starts_with(dir.path().join(sub)),
                "kind {:?} should land in {sub}/, got {}",
                kind,
                p.display()
            );
        }
    }

    #[test]
    fn export_writes_well_formed_frontmatter() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let mut project = make_project(dir.path().to_str());
        // Project name with a quote needs escaping in YAML.
        project.name = "Acme \"Inc\"".into();
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let mut item = make_item("01HKF1", ItemKind::Note, "p1", Some(0.92));
        item.content = "line one\nline two\nline three".into();
        db.with_conn(|c| crate::db::items::insert_item(c, &item))
            .unwrap();
        // Add tags including one with special chars to verify yaml escaping.
        db.with_conn(|c| {
            crate::db::items::replace_tags(c, &item.id, &["alpha".into(), "needs \"review\"".into()])
        })
        .unwrap();
        let res = export_item(&db, &item, 0.75).unwrap().unwrap();
        let body = std::fs::read_to_string(&res.path).unwrap();

        // Frontmatter starts and ends with `---` lines.
        assert!(body.starts_with("---\n"), "missing leading ---");
        let after_first = &body[4..];
        let end_idx = after_first.find("\n---\n").expect("missing closing ---");
        let frontmatter = &after_first[..end_idx];

        // Required keys present.
        for key in ["id:", "kind:", "source:", "project:", "captured_at:", "tags:"] {
            assert!(
                frontmatter.contains(key),
                "frontmatter missing key {key}; got:\n{frontmatter}"
            );
        }
        // Quoted project name must be escaped.
        assert!(
            frontmatter.contains("project: \"Acme \\\"Inc\\\"\""),
            "project name not properly escaped; got:\n{frontmatter}"
        );
        // Confidence + classified_by present (non-null in this case).
        assert!(frontmatter.contains("confidence: 0.920"));
        assert!(frontmatter.contains("classified_by: \"classifier-v1\""));
        // Tags array contains both, including escaped quote.
        assert!(frontmatter.contains("\"alpha\""));
        assert!(frontmatter.contains("\"needs \\\"review\\\"\""));

        // Body preserves multi-line content.
        let body_after = &after_first[end_idx + 5..];
        assert!(body_after.contains("line one\nline two\nline three"));
    }

    #[test]
    fn render_item_omits_confidence_when_none() {
        // Manual-capture path stores confidence = None; rendered frontmatter
        // must NOT emit a stray `confidence:` line.
        let project = make_project(Some("/tmp/x"));
        let mut item = make_item("01HKN0", ItemKind::Note, "p1", None);
        item.classified_by = None;
        let body = render_item(&item, &project, &[]);
        assert!(!body.contains("confidence:"));
        assert!(!body.contains("classified_by:"));
        assert!(body.contains("tags: []"));
    }

    // -------------------------------------------------------------------------
    // Meeting export
    // -------------------------------------------------------------------------

    fn make_meeting_row(item_id: &str, summary_json: Option<&str>) -> MeetingRow {
        MeetingRow {
            item_id: item_id.into(),
            started_at: "2026-05-26T10:00:00Z".into(),
            ended_at: Some("2026-05-26T10:42:00Z".into()),
            duration_ms: Some(42 * 60 * 1000),
            detected_app: Some("zoom.us".into()),
            detected_app_name: Some("Zoom".into()),
            status: "complete".into(),
            transcript_json: None,
            summary_json: summary_json.map(|s| s.to_string()),
            user_notes: Some("Side notes: follow up about pricing.".into()),
            failed_chunk_count: 0,
            mic_only: false,
            calendar_match_json: None,
            guide_template_json: None,
            project_name: None,
        }
    }

    fn make_meeting_item(item_id: &str, project_id: &str) -> Item {
        Item {
            id: item_id.into(),
            content: "You: hello\nThem: hi\n".into(),
            source: ItemSource::Meeting,
            kind: None, // meeting item has kind = 'meeting' in DB but parses to None
            project_id: Some(project_id.into()),
            captured_at: "2026-05-26T10:00:00Z".into(),
            created_at: "2026-05-26T10:00:00Z".into(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context: None,
        }
    }

    #[test]
    fn export_meeting_skips_when_no_folder() {
        let db = fresh_db();
        let project = make_project(None);
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_meeting_item("01HKMT1", "p1");
        let meeting = make_meeting_row("01HKMT1", None);
        let res = export_meeting(&db, &meeting, &item).unwrap();
        assert!(matches!(res, Err(ExportSkip::NoFolder)));
    }

    #[test]
    fn export_meeting_writes_file_in_meetings_subfolder() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let summary = r#"{
            "summary": ["Discussed Q3 roadmap", "Aligned on pricing"],
            "action_items": [
                {"text": "Send pricing draft", "owner": "you"},
                {"text": "Review legal terms", "owner": "them"}
            ],
            "suggested_title": "Q3 Planning",
            "raw": null,
            "tags": ["planning"],
            "project_name": "Acme"
        }"#;
        let item = make_meeting_item("01HKMT2", "p1");
        let meeting = make_meeting_row("01HKMT2", Some(summary));
        let res = export_meeting(&db, &meeting, &item).unwrap().unwrap();
        let p = std::path::Path::new(&res.path);
        assert!(p.exists(), "meeting file should exist at {}", p.display());
        assert!(
            p.starts_with(dir.path().join("meetings")),
            "meeting should live in meetings/ subfolder, got {}",
            p.display()
        );
        let fname = p.file_name().unwrap().to_string_lossy();
        assert!(
            fname.contains("q3-planning"),
            "filename should derive slug from suggested_title; got {fname}"
        );

        let body = std::fs::read_to_string(p).unwrap();
        assert!(body.contains("kind: meeting"));
        assert!(body.contains("# Q3 Planning"));
        assert!(body.contains("## Summary"));
        assert!(body.contains("- Discussed Q3 roadmap"));
        assert!(body.contains("## Action items"));
        assert!(body.contains("- [ ] (you) Send pricing draft"));
        assert!(body.contains("- [ ] (them) Review legal terms"));
        assert!(body.contains("## User notes"));
        assert!(body.contains("follow up about pricing"));
        assert!(body.contains("## Transcript"));
        assert!(body.contains("You: hello"));
        assert!(body.contains("**App:** Zoom"));
        assert!(body.contains("**Duration:** 42 min"));
    }

    #[test]
    fn export_meeting_handles_missing_summary_json() {
        // Failed synthesis leaves summary_json = None. Export should still
        // write the transcript + user notes (no summary / action_items sections).
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_meeting_item("01HKMT3", "p1");
        let meeting = make_meeting_row("01HKMT3", None);
        let res = export_meeting(&db, &meeting, &item).unwrap().unwrap();
        let body = std::fs::read_to_string(&res.path).unwrap();
        assert!(body.contains("# Meeting"), "default title when no synthesis");
        assert!(!body.contains("## Summary"));
        assert!(!body.contains("## Action items"));
        assert!(body.contains("## Transcript"));
        assert!(body.contains("## User notes"));
    }

    // -------------------------------------------------------------------------
    // Backfill
    // -------------------------------------------------------------------------

    #[test]
    fn backfill_writes_items_and_meetings_and_skips_others() {
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        // 2 items above threshold, 1 below (should be skipped).
        let high_a = make_item("01HKB1", ItemKind::Note, "p1", Some(0.91));
        let high_b = make_item("01HKB2", ItemKind::Task, "p1", Some(0.88));
        let low = make_item("01HKB3", ItemKind::Note, "p1", Some(0.3));
        for it in [&high_a, &high_b, &low] {
            db.with_conn(|c| crate::db::items::insert_item(c, it)).unwrap();
        }
        // Manual meeting row + its item.
        let m_item = make_meeting_item("01HKB4", "p1");
        let summary = r#"{
            "summary": ["bullet"],
            "action_items": [],
            "suggested_title": "Sync",
            "raw": null,
            "tags": [],
            "project_name": null
        }"#;
        let meeting = make_meeting_row("01HKB4", Some(summary));
        // Meeting items live in the items table too — need both insertions.
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO items (id, content, source, kind, project_id, captured_at, created_at)
                 VALUES (?1, ?2, 'meeting', 'meeting', ?3, ?4, ?4)",
                rusqlite::params!["01HKB4", "transcript text", "p1", "2026-05-26T10:00:00Z"],
            )?;
            Ok(())
        })
        .unwrap();
        db.with_conn(|c| crate::db::meetings::insert_meeting(c, &meeting))
            .unwrap();
        // Suppress unused-var warning.
        let _ = m_item;

        let n = backfill_project(&db, "p1", 0.75).unwrap();
        // 2 items + 1 meeting = 3 written; low-confidence item skipped.
        assert_eq!(n, 3, "expected 2 high-conf items + 1 meeting exported");

        // Verify directory layout.
        assert!(dir.path().join("notes").exists());
        assert!(dir.path().join("tasks").exists());
        assert!(dir.path().join("meetings").exists());
        let notes_count = std::fs::read_dir(dir.path().join("notes")).unwrap().count();
        let tasks_count = std::fs::read_dir(dir.path().join("tasks")).unwrap().count();
        let meetings_count = std::fs::read_dir(dir.path().join("meetings")).unwrap().count();
        assert_eq!(notes_count, 1);
        assert_eq!(tasks_count, 1);
        assert_eq!(meetings_count, 1);
    }

    #[test]
    fn backfill_errors_when_project_has_no_folder() {
        let db = fresh_db();
        let project = make_project(None);
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let err = backfill_project(&db, "p1", 0.75).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("export_folder"), "got: {msg}");
    }

    #[test]
    fn backfill_errors_when_project_missing() {
        let db = fresh_db();
        let err = backfill_project(&db, "nonexistent", 0.75).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("not found"), "got: {msg}");
    }

    // -------------------------------------------------------------------------
    // try_export_* convenience wrappers (must never panic / propagate errors)
    // -------------------------------------------------------------------------

    #[test]
    fn try_export_item_is_noop_when_no_folder() {
        let db = fresh_db();
        let project = make_project(None);
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_item("01HKE1", ItemKind::Note, "p1", Some(0.95));
        // Should NOT panic, should NOT return an error.
        try_export_item(&db, &item, 0.75);
    }

    #[test]
    fn try_export_meeting_is_noop_when_no_folder() {
        let db = fresh_db();
        let project = make_project(None);
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_meeting_item("01HKE2", "p1");
        let meeting = make_meeting_row("01HKE2", None);
        try_export_meeting(&db, &meeting, &item);
    }

    #[test]
    fn export_skips_meeting_record_with_unsupported_kind() {
        // The "meeting item" (source=meeting, kind=None) is exported via
        // export_meeting, NOT export_item. If accidentally fed to export_item
        // it must return UnsupportedKind, not a file.
        let dir = TempDir::new().unwrap();
        let db = fresh_db();
        let project = make_project(dir.path().to_str());
        db.with_conn(|c| crate::db::projects::insert_project(c, &project))
            .unwrap();
        let item = make_meeting_item("01HKE3", "p1");
        let res = export_item(&db, &item, 0.75).unwrap();
        assert!(matches!(res, Err(ExportSkip::UnsupportedKind)));
    }
}
