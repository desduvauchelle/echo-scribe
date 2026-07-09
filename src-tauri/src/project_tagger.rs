//! Deferred project auto-tagging: deterministic routing and batch worker glue.

use crate::coordinator::{PipelineState, StateHandle};
use crate::db::projects::Project;
use crate::db::{items, project_tag_jobs, Db, DbError};
use crate::input::focus::FocusContext;
use crate::llm::LlmGenerator;
use rusqlite::Connection;
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Clone, PartialEq)]
pub struct DeterministicRoute {
    pub project_id: Option<String>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct ProjectTaggerRunSummary {
    pub scanned: u32,
    pub assigned: u32,
    pub deferred: u32,
    pub failed: u32,
    /// First LLM classification error of the run, if any — surfaced so the UI
    /// can show *why* a pass assigned nothing instead of a bare zero.
    pub sample_error: Option<String>,
}

pub fn run_deterministic_batch(
    conn: &Connection,
    limit: u32,
    now_iso: &str,
) -> Result<ProjectTaggerRunSummary, DbError> {
    let jobs = project_tag_jobs::list_runnable(conn, limit, now_iso)?;
    let projects = crate::db::projects::list_projects(conn, false)?;
    let mut summary = ProjectTaggerRunSummary::default();

    for job in jobs {
        summary.scanned += 1;
        let item = match items::get_item(conn, &job.item_id)? {
            Some(item) if item.deleted_at.is_none() => item,
            _ => {
                project_tag_jobs::mark_done(conn, &job.item_id, now_iso)?;
                summary.deferred += 1;
                continue;
            }
        };
        if item.project_id.is_some() {
            project_tag_jobs::mark_done(conn, &job.item_id, now_iso)?;
            summary.deferred += 1;
            continue;
        }
        let focus = parse_focus_context(item.capture_context.as_deref());
        let route = route_deterministically(&item.content, focus.as_ref(), &projects);
        if let Some(project_id) = route.project_id {
            items::apply_classification(
                conn,
                &item.id,
                &project_id,
                route.confidence,
                "router-v1",
            )?;
            project_tag_jobs::mark_done(conn, &job.item_id, now_iso)?;
            summary.assigned += 1;
        } else {
            project_tag_jobs::defer(
                conn,
                &job.item_id,
                None,
                Some("no clear deterministic route"),
                now_iso,
            )?;
            summary.deferred += 1;
        }
    }

    Ok(summary)
}

pub async fn run_llm_batch<L: LlmGenerator + ?Sized>(
    conn: &Connection,
    llm: &L,
    limit: u32,
    now_iso: &str,
    now_dow: &str,
) -> Result<ProjectTaggerRunSummary, DbError> {
    let jobs = project_tag_jobs::list_runnable(conn, limit, now_iso)?;
    let projects = crate::db::projects::list_projects(conn, false)?;
    let recents = items::list_items(conn, None, None, 5, 0)?;
    let mut summary = ProjectTaggerRunSummary::default();

    for job in jobs {
        summary.scanned += 1;
        let item = match items::get_item(conn, &job.item_id)? {
            Some(item) if item.deleted_at.is_none() => item,
            _ => {
                project_tag_jobs::mark_done(conn, &job.item_id, now_iso)?;
                summary.deferred += 1;
                continue;
            }
        };
        if item.project_id.is_some() {
            project_tag_jobs::mark_done(conn, &job.item_id, now_iso)?;
            summary.deferred += 1;
            continue;
        }
        let focus = parse_focus_context(item.capture_context.as_deref());
        match crate::classifier::classify(
            llm,
            &item.content,
            &projects,
            &recents,
            now_iso,
            now_dow,
            focus.as_ref(),
        )
        .await
        {
            Ok(c) if c.confidence >= 0.6 => {
                if let Some(project_id) = c.project_id {
                    items::apply_classification(
                        conn,
                        &item.id,
                        &project_id,
                        c.confidence,
                        "ai-background",
                    )?;
                    if !c.tags.is_empty() {
                        items::replace_tags(conn, &item.id, &c.tags)?;
                    }
                    project_tag_jobs::mark_done(conn, &job.item_id, now_iso)?;
                    summary.assigned += 1;
                } else {
                    project_tag_jobs::defer(
                        conn,
                        &job.item_id,
                        None,
                        Some("llm returned no existing project"),
                        now_iso,
                    )?;
                    summary.deferred += 1;
                }
            }
            Ok(_) => {
                project_tag_jobs::defer(
                    conn,
                    &job.item_id,
                    None,
                    Some("llm confidence below threshold"),
                    now_iso,
                )?;
                summary.deferred += 1;
            }
            Err(e) => {
                let msg = format!("llm classification failed: {e}");
                warn!(target: "project_tagger", item_id = %job.item_id, error = %e, "llm classification failed");
                project_tag_jobs::defer(conn, &job.item_id, None, Some(&msg), now_iso)?;
                summary.sample_error.get_or_insert(msg);
                summary.deferred += 1;
            }
        }
    }

    Ok(summary)
}

pub async fn run_llm_batch_db<L: LlmGenerator + ?Sized>(
    db: &Db,
    llm: &L,
    limit: u32,
    now_iso: &str,
    now_dow: &str,
) -> Result<ProjectTaggerRunSummary, DbError> {
    let jobs = db.with_conn(|c| project_tag_jobs::list_runnable(c, limit, now_iso))?;
    let projects = db.with_conn(|c| crate::db::projects::list_projects(c, false))?;
    let recents = db.with_conn(|c| items::list_items(c, None, None, 5, 0))?;
    let mut summary = ProjectTaggerRunSummary::default();

    for job in jobs {
        summary.scanned += 1;
        let item = match db.with_conn(|c| items::get_item(c, &job.item_id))? {
            Some(item) if item.deleted_at.is_none() => item,
            _ => {
                db.with_conn(|c| project_tag_jobs::mark_done(c, &job.item_id, now_iso))?;
                summary.deferred += 1;
                continue;
            }
        };
        if item.project_id.is_some() {
            db.with_conn(|c| project_tag_jobs::mark_done(c, &job.item_id, now_iso))?;
            summary.deferred += 1;
            continue;
        }
        let focus = parse_focus_context(item.capture_context.as_deref());
        let classified = crate::classifier::classify(
            llm,
            &item.content,
            &projects,
            &recents,
            now_iso,
            now_dow,
            focus.as_ref(),
        )
        .await;
        match classified {
            Ok(c) if c.confidence >= 0.6 => {
                if let Some(project_id) = c.project_id {
                    db.with_conn(|conn| {
                        items::apply_classification(
                            conn,
                            &item.id,
                            &project_id,
                            c.confidence,
                            "ai-background",
                        )?;
                        if !c.tags.is_empty() {
                            items::replace_tags(conn, &item.id, &c.tags)?;
                        }
                        project_tag_jobs::mark_done(conn, &job.item_id, now_iso)
                    })?;
                    summary.assigned += 1;
                } else {
                    db.with_conn(|conn| {
                        project_tag_jobs::defer(
                            conn,
                            &job.item_id,
                            None,
                            Some("llm returned no existing project"),
                            now_iso,
                        )
                    })?;
                    summary.deferred += 1;
                }
            }
            Ok(_) => {
                db.with_conn(|conn| {
                    project_tag_jobs::defer(
                        conn,
                        &job.item_id,
                        None,
                        Some("llm confidence below threshold"),
                        now_iso,
                    )
                })?;
                summary.deferred += 1;
            }
            Err(e) => {
                let msg = format!("llm classification failed: {e}");
                warn!(target: "project_tagger", item_id = %job.item_id, error = %e, "llm classification failed");
                db.with_conn(|conn| {
                    project_tag_jobs::defer(conn, &job.item_id, None, Some(&msg), now_iso)
                })?;
                summary.sample_error.get_or_insert(msg);
                summary.deferred += 1;
            }
        }
    }

    Ok(summary)
}

pub fn spawn_worker(
    db: Option<Db>,
    llm: Arc<crate::llm::Llm>,
    settings: crate::settings::SettingsStore,
    pipeline_state: StateHandle,
) {
    let Some(db) = db else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut last_llm_run: Option<std::time::Instant> = None;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15 * 60));
        interval.tick().await;
        loop {
            interval.tick().await;
            if !settings.project_auto_tagging_enabled() {
                continue;
            }
            if !pipeline_is_idle(&pipeline_state) {
                info!(target: "project_tagger", "skipping scheduled pass: voice pipeline is busy");
                continue;
            }
            let configured_interval = settings.project_auto_tagging_interval_minutes();
            let batch_size = settings.project_auto_tagging_batch_size();
            let now = crate::db::items::chrono_now_iso();
            info!(
                target: "project_tagger",
                batch_size,
                configured_interval,
                "starting scheduled project tagger pass"
            );
            match db.with_conn(|c| run_deterministic_batch(c, batch_size, &now)) {
                Ok(summary) => {
                    info!(target: "project_tagger", ?summary, "deterministic pass complete");
                }
                Err(e) => {
                    warn!(target: "project_tagger", error = %e, "deterministic pass failed");
                    continue;
                }
            }
            if !llm.ready() {
                info!(target: "project_tagger", "skipping LLM pass: no ready model");
                continue;
            }
            let interval_elapsed = last_llm_run
                .map(|t| t.elapsed() >= std::time::Duration::from_secs(configured_interval * 60))
                .unwrap_or(true);
            let opportunistic_loaded_run =
                settings.project_auto_tagging_opportunistic() && llm.is_loaded();
            if !interval_elapsed && !opportunistic_loaded_run {
                info!(
                    target: "project_tagger",
                    configured_interval,
                    opportunistic_loaded_run,
                    "skipping LLM pass: interval has not elapsed"
                );
                continue;
            }
            let dow = crate::classifier::dow_from_iso(&now).to_string();
            match run_llm_batch_db(&db, llm.as_ref(), batch_size, &now, &dow).await {
                Ok(summary) => {
                    last_llm_run = Some(std::time::Instant::now());
                    info!(target: "project_tagger", ?summary, "LLM pass complete");
                }
                Err(e) => {
                    warn!(target: "project_tagger", error = %e, "LLM pass failed");
                }
            }
        }
    });
}

fn pipeline_is_idle(pipeline_state: &StateHandle) -> bool {
    pipeline_state
        .lock()
        .map(|state| matches!(*state, PipelineState::Idle))
        .unwrap_or(false)
}

fn parse_focus_context(raw: Option<&str>) -> Option<FocusContext> {
    raw.and_then(|s| serde_json::from_str::<FocusContext>(s).ok())
}

#[derive(Debug, Clone)]
struct Score {
    project_id: String,
    value: i32,
}

pub fn route_deterministically(
    transcript: &str,
    focus: Option<&FocusContext>,
    projects: &[Project],
) -> DeterministicRoute {
    let transcript_l = transcript.to_lowercase();
    let context_l = context_text(focus).to_lowercase();
    let haystack_all = if context_l.is_empty() {
        transcript_l.clone()
    } else {
        format!("{transcript_l}\n{context_l}")
    };

    let mut scores = projects
        .iter()
        .map(|p| Score {
            project_id: p.id.clone(),
            value: score_project(p, &transcript_l, &context_l, &haystack_all),
        })
        .collect::<Vec<_>>();
    scores.sort_by(|a, b| {
        b.value
            .cmp(&a.value)
            .then_with(|| a.project_id.cmp(&b.project_id))
    });

    let Some(best) = scores.first() else {
        return DeterministicRoute {
            project_id: None,
            confidence: 0.0,
        };
    };
    let second = scores.get(1).map(|s| s.value).unwrap_or(0);
    if best.value < 8 || best.value - second < 3 {
        return DeterministicRoute {
            project_id: None,
            confidence: score_to_confidence(best.value),
        };
    }

    DeterministicRoute {
        project_id: Some(best.project_id.clone()),
        confidence: score_to_confidence(best.value),
    }
}

fn score_project(
    project: &Project,
    transcript_l: &str,
    context_l: &str,
    haystack_all: &str,
) -> i32 {
    let mut score = 0;

    for alias in &project.routing_aliases {
        let alias = alias.trim().to_lowercase();
        if alias.is_empty() {
            continue;
        }
        if contains_phrase(transcript_l, &alias) {
            score += 10;
        } else if contains_phrase(context_l, &alias) {
            score += 8;
        }
    }

    for hint in &project.routing_app_hints {
        let hint = hint.trim().to_lowercase();
        if !hint.is_empty() && contains_phrase(context_l, &hint) {
            score += 6;
        }
    }
    for hint in &project.routing_url_hints {
        let hint = hint.trim().to_lowercase();
        if !hint.is_empty() && contains_phrase(context_l, &hint) {
            score += 8;
        }
    }
    for hint in &project.routing_window_hints {
        let hint = hint.trim().to_lowercase();
        if !hint.is_empty() && contains_phrase(context_l, &hint) {
            score += 8;
        }
    }

    for kw in &project.keywords {
        let kw = kw.trim().to_lowercase();
        if !kw.is_empty() && contains_phrase(haystack_all, &kw) {
            score += 3;
        }
    }
    if let Some(desc) = &project.description {
        score += token_overlap_score(desc, haystack_all, 2);
    }
    for example in &project.routing_positive_examples {
        score += token_overlap_score(example, haystack_all, 5);
    }
    for example in &project.routing_negative_examples {
        if example_matches(example, haystack_all) {
            score -= 8;
        }
    }

    score
}

fn context_text(focus: Option<&FocusContext>) -> String {
    let Some(ctx) = focus else {
        return String::new();
    };
    [
        ctx.bundle_id.as_deref(),
        ctx.app_name.as_deref(),
        ctx.window_title.as_deref(),
        ctx.browser_url.as_deref(),
        ctx.browser_tab_title.as_deref(),
        ctx.content_title.as_deref(),
        ctx.content_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

fn contains_phrase(haystack_l: &str, needle_l: &str) -> bool {
    !needle_l.is_empty() && haystack_l.contains(needle_l)
}

fn token_overlap_score(text: &str, haystack_l: &str, weight: i32) -> i32 {
    let tokens = meaningful_tokens(text);
    if tokens.is_empty() {
        return 0;
    }
    let hits = tokens
        .iter()
        .filter(|token| haystack_l.contains(token.as_str()))
        .count();
    if hits >= 2 {
        weight
    } else {
        0
    }
}

fn example_matches(example: &str, haystack_l: &str) -> bool {
    let example_l = example.to_lowercase();
    contains_phrase(haystack_l, &example_l) || token_overlap_score(example, haystack_l, 1) > 0
}

fn meaningful_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 4)
        .map(|t| t.to_string())
        .collect()
}

fn score_to_confidence(score: i32) -> f32 {
    ((score.max(0) as f32) / 10.0).clamp(0.0, 0.98)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::items::{ItemKind, ItemSource};
    use crate::db::projects::Project;
    use crate::db::schema::run_migrations;
    use crate::input::focus::FocusContext;

    fn project(id: &str, name: &str, aliases: &[&str]) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            created_at: "2026-06-25T00:00:00Z".into(),
            archived_at: None,
            routing_aliases: aliases.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn deterministic_router_assigns_exact_alias_match() {
        let livecase = project("p1", "LiveCase", &["livecase", "hbsp"]);
        let echo = project("p2", "Echo Scribe", &["echo scribe"]);

        let result = super::route_deterministically(
            "Update the HBSP proof section for the case simulation page.",
            None,
            &[livecase, echo],
        );

        assert_eq!(result.project_id.as_deref(), Some("p1"));
        assert!(result.confidence >= 0.85);
    }

    #[test]
    fn deterministic_router_uses_capture_context_hints() {
        let mut echo = project("p1", "Echo Scribe", &[]);
        echo.routing_window_hints = vec!["echo-scribe".into()];
        let ctx = FocusContext {
            pid: 1,
            bundle_id: Some("com.microsoft.VSCode".into()),
            app_name: Some("Code".into()),
            window_title: Some("coordinator.rs - echo-scribe".into()),
            browser_url: None,
            browser_tab_title: None,
            content_title: None,
            content_url: None,
            content_source: None,
        };

        let result = super::route_deterministically("Fix the queue worker.", Some(&ctx), &[echo]);

        assert_eq!(result.project_id.as_deref(), Some("p1"));
    }

    #[test]
    fn deterministic_router_uses_generic_content_title_hints() {
        let mut livecase = project("p1", "LiveCase", &[]);
        livecase.routing_window_hints = vec!["livecaseplus-server".into()];
        let ctx = FocusContext {
            pid: 1,
            bundle_id: Some("com.openai.codex".into()),
            app_name: Some("Codex".into()),
            window_title: Some("Codex".into()),
            browser_url: None,
            browser_tab_title: None,
            content_title: Some("Investigate prompt templates - livecaseplus-server".into()),
            content_url: None,
            content_source: Some("ax_web_area".into()),
        };

        let result =
            super::route_deterministically("Make this a bit more robust.", Some(&ctx), &[livecase]);

        assert_eq!(result.project_id.as_deref(), Some("p1"));
    }

    #[test]
    fn deterministic_router_negative_examples_reduce_score() {
        let mut p = project("p1", "LiveCase", &["case"]);
        p.routing_negative_examples = vec!["source-code case statement".into()];

        let result =
            super::route_deterministically("Refactor this source-code case statement.", None, &[p]);

        assert!(result.project_id.is_none());
    }

    #[test]
    fn deterministic_router_does_not_assign_ambiguous_matches() {
        let a = project("p1", "LiveCase", &["simulation"]);
        let b = project("p2", "Recursive", &["simulation"]);

        let result =
            super::route_deterministically("Make the simulation page clearer.", None, &[a, b]);

        assert!(result.project_id.is_none());
    }

    #[test]
    fn run_deterministic_batch_assigns_project_and_marks_job_done() {
        let conn = fresh_db();
        let mut p = project("p1", "LiveCase", &["hbsp"]);
        p.created_at = "2026-06-25T00:00:00Z".into();
        crate::db::projects::insert_project(&conn, &p).unwrap();
        conn.execute(
            "INSERT INTO items
                (id, content, source, kind, captured_at, created_at)
             VALUES ('i1', 'Update the HBSP proof section', ?1, ?2, '2026-06-25T10:00:00Z', '2026-06-25T10:00:00Z')",
            rusqlite::params![ItemSource::VoiceAtCursor.as_str(), ItemKind::Transcription.as_str()],
        )
        .unwrap();
        crate::db::project_tag_jobs::enqueue(&conn, "i1", "2026-06-25T12:00:00Z").unwrap();

        let summary = super::run_deterministic_batch(&conn, 10, "2026-06-25T12:10:00Z").unwrap();

        assert_eq!(summary.assigned, 1);
        let row: (Option<String>, Option<f64>, Option<String>) = conn
            .query_row(
                "SELECT project_id, confidence, classified_by FROM items WHERE id = 'i1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0.as_deref(), Some("p1"));
        assert_eq!(row.2.as_deref(), Some("router-v1"));

        let status: String = conn
            .query_row(
                "SELECT status FROM project_tag_jobs WHERE item_id = 'i1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, crate::db::project_tag_jobs::STATUS_DONE);
    }

    struct StubLlm {
        response: String,
    }

    impl crate::llm::LlmGenerator for StubLlm {
        fn generate<'a>(
            &'a self,
            _req: crate::llm::GenerateRequest,
        ) -> crate::llm::GenerateFuture<'a> {
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
        }
    }

    #[tokio::test]
    async fn run_llm_batch_assigns_existing_project_and_tags() {
        let conn = fresh_db();
        let p = project("p1", "LiveCase", &[]);
        crate::db::projects::insert_project(&conn, &p).unwrap();
        conn.execute(
            "INSERT INTO items
                (id, content, source, kind, captured_at, created_at)
             VALUES ('i1', 'Need to update the case simulation proof', ?1, ?2, '2026-06-25T10:00:00Z', '2026-06-25T10:00:00Z')",
            rusqlite::params![ItemSource::VoiceAtCursor.as_str(), ItemKind::Transcription.as_str()],
        )
        .unwrap();
        crate::db::project_tag_jobs::enqueue(&conn, "i1", "2026-06-25T12:00:00Z").unwrap();
        let llm = StubLlm {
            response: r#"{"kind":"note","project_id":"p1","new_project_name":null,"tags":["LiveCase","Proof"],"deadline_iso":null,"confidence":0.82}"#.into(),
        };

        let summary = super::run_llm_batch(&conn, &llm, 10, "2026-06-25T12:10:00Z", "Thursday")
            .await
            .unwrap();

        assert_eq!(summary.assigned, 1);
        let row: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT project_id, classified_by FROM items WHERE id = 'i1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0.as_deref(), Some("p1"));
        assert_eq!(row.1.as_deref(), Some("ai-background"));
        let tags = crate::db::items::list_tags_for_item(&conn, "i1").unwrap();
        assert_eq!(tags, vec!["livecase".to_string(), "proof".to_string()]);
    }
}
