//! Bounded, local retrieval of user-confirmed project assignments.
//! Historical project_changed events support assignments made before the manual
//! provenance marker existed. Automatic assignments never become training data.

use super::{projects::Project, DbError};
use crate::input::focus::FocusContext;
use rusqlite::Connection;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

fn terms(text: &str) -> BTreeSet<String> {
    const STOP: &str = "the and for with that this from have your you our are was were will would could should about they them their there these those then than into just what when where how not but meeting summary transcript notes speaker avec pour dans nous vous une les des est sur pas que qui der die das und mit den dem ein eine ich sie wir";
    static STOP_WORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    let stop = STOP_WORDS.get_or_init(|| STOP.split_whitespace().collect());
    text.chars()
        .take(20_000)
        .collect::<String>()
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|s| s.chars().count() >= 3 && !stop.contains(s.as_str()))
        .collect()
}

pub fn context_text(focus: Option<&FocusContext>) -> String {
    let Some(focus) = focus else {
        return String::new();
    };
    let mut values: Vec<&str> = focus.signals.iter().map(|s| s.value.as_str()).collect();
    values.extend(
        [
            focus.window_title.as_deref(),
            focus.browser_tab_title.as_deref(),
            focus.content_title.as_deref(),
        ]
        .into_iter()
        .flatten(),
    );
    values.join("\n").chars().take(2_000).collect()
}

/// Only confirmed participant names; no inferred identities or deleted people.
pub fn meeting_people(conn: &Connection, id: &str) -> Result<String, DbError> {
    Ok(conn
        .query_row(
            "SELECT COALESCE(group_concat(display_name, ', '), '') FROM (
            SELECT mp.display_name FROM meeting_participants mp
             WHERE mp.meeting_id = ?1 AND mp.confirmed = 1
               AND (mp.person_id IS NULL OR EXISTS (
                   SELECT 1 FROM people p WHERE p.id = mp.person_id AND p.deleted_at IS NULL))
             ORDER BY mp.speaker_key LIMIT 16)",
            [id],
            |r| r.get::<_, String>(0),
        )?
        .chars()
        .take(500)
        .collect())
}

/// Returns prompt-only project copies. Never pass these enriched examples to
/// the deterministic router: lexical similarity is evidence, not a routing rule.
pub fn with_history(
    conn: &Connection,
    projects: &[Project],
    text: &str,
    focus: Option<&FocusContext>,
    exclude_id: Option<&str>,
) -> Result<Vec<Project>, DbError> {
    let people = exclude_id
        .map(|id| meeting_people(conn, id))
        .transpose()?
        .unwrap_or_default();
    let query_text = format!("{}\n{}\n{}", people, context_text(focus), text);
    let query = terms(&query_text);
    let mut enriched = projects.to_vec();
    if query.is_empty() {
        return Ok(enriched);
    }
    let mut stmt = conn.prepare(
        "SELECT i.project_id, substr(i.content,1,12000), i.capture_context, i.id
           FROM items i JOIN projects p ON p.id = i.project_id
          WHERE i.deleted_at IS NULL AND p.archived_at IS NULL
            AND (?1 IS NULL OR i.id != ?1)
            AND (i.classified_by = 'manual' OR (
                SELECT CASE WHEN e.event_type = 'project_assigned' THEN 'assigned to project ' || e.detail ELSE e.detail END
                  FROM item_events e
                 WHERE e.item_id = i.id AND (e.event_type = 'project_changed'
                    OR (e.event_type = 'project_assigned' AND i.source = 'meeting' AND i.kind = 'meeting'))
                 ORDER BY e.created_at DESC, e.id DESC LIMIT 1
            ) = 'assigned to project ' || i.project_id)
          ORDER BY i.captured_at DESC, i.id ASC LIMIT 500"
    )?;
    let rows = stmt
        .query_map([exclude_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut candidates = Vec::new();
    let mut frequencies: HashMap<String, usize> = HashMap::new();
    for (pid, body, raw, id) in rows {
        let ctx = raw.and_then(|s| serde_json::from_str::<FocusContext>(&s).ok());
        let body = format!(
            "{}\n{}\n{}",
            meeting_people(conn, &id)?,
            context_text(ctx.as_ref()),
            body
        );
        let words = terms(&body);
        for word in words.intersection(&query) {
            *frequencies.entry(word.clone()).or_default() += 1;
        }
        candidates.push((pid, body, words));
    }
    let language = whatlang::detect(text)
        .filter(|l| l.is_reliable())
        .map(|l| l.lang());
    let mut ranked = Vec::new();
    for (pid, body, words) in candidates {
        let shared: Vec<_> = words.intersection(&query).collect();
        if shared.is_empty() {
            continue;
        }
        // One shared generic word is insufficient. A rare distinctive name or
        // topic can retrieve an example; the model still decides membership.
        if shared.len() < 2
            && !shared
                .iter()
                .any(|w| w.chars().count() >= 5 && frequencies[*w] == 1)
        {
            continue;
        }
        let mut score: f64 = shared.iter().map(|w| 1.0 / frequencies[*w] as f64).sum();
        if language.is_some()
            && whatlang::detect(&body)
                .filter(|l| l.is_reliable())
                .map(|l| l.lang())
                == language
        {
            score += 0.1;
        }
        ranked.push((score, pid, body));
    }
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut per_project = HashMap::new();
    let mut added = 0;
    for (_, pid, body) in ranked {
        let count = per_project.entry(pid.clone()).or_insert(0);
        if *count >= 2 {
            continue;
        }
        if let Some(project) = enriched.iter_mut().find(|p| p.id == pid) {
            // Keep the relevant passage, including matches late in long meetings.
            let mut best_start = 0;
            let chars: Vec<char> = body.chars().collect();
            let mut best_score = 0;
            for start in (0..chars.len()).step_by(200) {
                let window: String = chars[start..(start + 400).min(chars.len())]
                    .iter()
                    .collect();
                let n = terms(&window).intersection(&query).count();
                if n > best_score {
                    best_score = n;
                    best_start = start;
                }
            }
            let excerpt: String = chars[best_start..(best_start + 400).min(chars.len())]
                .iter()
                .collect();
            project.routing_positive_examples.push(excerpt);
            *count += 1;
            added += 1;
            if added == 4 {
                break;
            }
        }
    }
    Ok(enriched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Connection, Vec<Project>) {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&mut conn).unwrap();
        let projects = vec![
            Project {
                id: "p1".into(),
                name: "LiveCase".into(),
                ..Default::default()
            },
            Project {
                id: "p2".into(),
                name: "Tucky".into(),
                ..Default::default()
            },
        ];
        for p in &projects {
            crate::db::projects::insert_project(&conn, p).unwrap();
        }
        (conn, projects)
    }

    fn add(conn: &Connection, id: &str, project: &str, text: &str, manual: bool) {
        conn.execute(
            "INSERT INTO items(id,content,source,project_id,classified_by,captured_at,created_at)
            VALUES (?1,?2,'meeting',?3,?4,'2026-09-01','2026-09-01')",
            rusqlite::params![
                id,
                text,
                project,
                if manual { "manual" } else { "ai-background" }
            ],
        )
        .unwrap();
    }

    #[test]
    fn only_confirmed_current_active_assignments_are_examples() {
        let (conn, projects) = setup();
        add(
            &conn,
            "confirmed",
            "p1",
            "Camille publisher licensing",
            true,
        );
        add(
            &conn,
            "automatic",
            "p2",
            "Camille publisher licensing AUTO",
            false,
        );
        add(
            &conn,
            "deleted",
            "p1",
            "Camille publisher licensing DELETED",
            true,
        );
        conn.execute(
            "UPDATE items SET deleted_at='2026-09-02' WHERE id='deleted'",
            [],
        )
        .unwrap();
        let got = with_history(&conn, &projects, "Camille publisher", None, None).unwrap();
        assert_eq!(got[0].routing_positive_examples.len(), 1);
        assert!(got[1].routing_positive_examples.is_empty());
        assert!(
            projects[0].routing_positive_examples.is_empty(),
            "never mutate stored project configuration"
        );
        crate::db::items::update_item(&conn, "confirmed", None, Some(Some("p2")), None, None)
            .unwrap();
        let corrected = with_history(&conn, &projects, "Camille publisher", None, None).unwrap();
        assert!(corrected[0].routing_positive_examples.is_empty());
        assert_eq!(corrected[1].routing_positive_examples.len(), 1);
        conn.execute(
            "UPDATE projects SET archived_at='2026-09-02' WHERE id='p2'",
            [],
        )
        .unwrap();
        assert!(
            with_history(&conn, &projects, "Camille publisher", None, None)
                .unwrap()
                .iter()
                .all(|p| p.routing_positive_examples.is_empty())
        );
    }

    #[test]
    fn legacy_events_teach_but_removed_assignments_and_self_do_not() {
        let (conn, projects) = setup();
        add(&conn, "legacy", "p1", "Camille publisher licensing", false);
        crate::db::events::insert_event(
            &conn,
            "legacy",
            "project_changed",
            Some("assigned to project p1"),
        )
        .unwrap();
        assert_eq!(
            with_history(&conn, &projects, "Camille publisher", None, None).unwrap()[0]
                .routing_positive_examples
                .len(),
            1
        );
        assert!(
            with_history(&conn, &projects, "Camille publisher", None, Some("legacy")).unwrap()[0]
                .routing_positive_examples
                .is_empty()
        );
        crate::db::items::update_item(&conn, "legacy", None, Some(None), None, None).unwrap();
        assert!(
            with_history(&conn, &projects, "Camille publisher", None, None).unwrap()[0]
                .routing_positive_examples
                .is_empty()
        );
    }

    #[test]
    fn observed_people_and_topic_retrieve_history_and_conflicting_projects() {
        let (conn, projects) = setup();
        for (id, pid) in [("one", "p1"), ("two", "p2")] {
            add(&conn, id, pid, "Camille publisher licensing", true);
        }
        let focus = FocusContext {
            browser_tab_title: Some("Camille publisher review".into()),
            ..Default::default()
        };
        let got = with_history(&conn, &projects, "Follow up on this", Some(&focus), None).unwrap();
        assert!(got.iter().all(|p| p.routing_positive_examples.len() == 1));
        assert!(with_history(
            &conn,
            &projects,
            "Tomorrow we discuss gardening and vegetables",
            None,
            None
        )
        .unwrap()
        .iter()
        .all(|p| p.routing_positive_examples.is_empty()));
    }

    #[test]
    fn debrief_assignments_and_confirmed_participants_teach_future_meetings() {
        let (conn, projects) = setup();
        for id in ["past", "future"] {
            add(
                &conn,
                id,
                "p1",
                if id == "past" {
                    "Licensing agreement"
                } else {
                    "Quarterly review"
                },
                false,
            );
            conn.execute("UPDATE items SET kind='meeting' WHERE id=?1", [id])
                .unwrap();
            conn.execute("INSERT INTO meetings(item_id,started_at,status) VALUES (?1,'2026-09-01','complete')", [id]).unwrap();
            conn.execute("INSERT INTO meeting_participants(meeting_id,speaker_key,display_name,confirmed,created_at,updated_at)
                VALUES (?1,'them','Camille Laurent',1,'2026-09-01','2026-09-01')", [id]).unwrap();
        }
        crate::db::meeting_debrief::set_meeting_project(&conn, "past", Some("p1")).unwrap();
        // Simulate a pre-marker debrief assignment: the event must still count.
        conn.execute("UPDATE items SET classified_by=NULL WHERE id='past'", [])
            .unwrap();
        let got = with_history(&conn, &projects, "Quarterly review", None, Some("future")).unwrap();
        assert_eq!(got[0].routing_positive_examples.len(), 1);
        assert!(got[0].routing_positive_examples[0].contains("Camille Laurent"));
        crate::db::meeting_debrief::set_meeting_project(&conn, "past", None).unwrap();
        assert!(
            with_history(&conn, &projects, "Quarterly review", None, Some("future")).unwrap()[0]
                .routing_positive_examples
                .is_empty()
        );
        assert_eq!(
            conn.query_row("SELECT classified_by FROM items WHERE id='past'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "manual"
        );
    }

    #[test]
    fn evidence_is_bounded_and_preserves_relevant_late_passages() {
        let (conn, projects) = setup();
        for n in 0..12 {
            add(
                &conn,
                &format!("item-{n}"),
                if n % 2 == 0 { "p1" } else { "p2" },
                &format!(
                    "{} Camille publisher licensing",
                    "unrelated background ".repeat(200)
                ),
                true,
            );
        }
        let got =
            with_history(&conn, &projects, "Camille publisher licensing", None, None).unwrap();
        let examples: Vec<_> = got
            .iter()
            .flat_map(|p| &p.routing_positive_examples)
            .collect();
        assert_eq!(examples.len(), 4);
        assert!(examples
            .iter()
            .all(|s| s.chars().count() <= 400 && s.contains("Camille")));
        let (prompt, _) =
            crate::llm::prompt::build_meeting_metadata_prompt("Camille publisher review", &got);
        let prompt = prompt.unwrap();
        assert!(prompt.contains("positive routing examples"));
        assert!(prompt.contains("Camille"));
        assert!(prompt.contains("language alone never establishes membership"));
    }
}
