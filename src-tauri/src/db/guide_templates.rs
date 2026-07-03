//! CRUD for user-authored guide templates. A template is reusable context
//! (goal + freeform notes) the user attaches to a guided meeting session.

use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuideTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub goal: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_template(row: &Row<'_>) -> rusqlite::Result<GuideTemplate> {
    Ok(GuideTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        goal: row.get("goal")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_template(conn: &Connection, t: &GuideTemplate) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO guide_templates
            (id, name, description, goal, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![t.id, t.name, t.description, t.goal, t.notes, t.created_at, t.updated_at],
    )?;
    Ok(())
}

pub fn list_templates(conn: &Connection) -> Result<Vec<GuideTemplate>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, goal, notes, created_at, updated_at
         FROM guide_templates ORDER BY name COLLATE NOCASE ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_template)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_template(conn: &Connection, id: &str) -> Result<Option<GuideTemplate>, DbError> {
    conn.query_row(
        "SELECT id, name, description, goal, notes, created_at, updated_at
         FROM guide_templates WHERE id = ?1",
        [id],
        row_to_template,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn update_template(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    goal: &str,
    notes: &str,
    updated_at: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE guide_templates
         SET name = ?1, description = ?2, goal = ?3, notes = ?4, updated_at = ?5
         WHERE id = ?6",
        params![name, description, goal, notes, updated_at, id],
    )?;
    Ok(())
}

pub fn delete_template(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM guide_templates WHERE id = ?1", [id])?;
    Ok(())
}

/// Built-in starter templates. Seeded once at startup (guarded by a settings
/// flag so user deletions stick); afterwards they behave exactly like
/// user-authored templates — editable, deletable.
pub struct BuiltinTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub goal: &'static str,
    pub notes: &'static str,
}

pub const BUILTIN_TEMPLATES: &[BuiltinTemplate] = &[
    BuiltinTemplate {
        id: "builtin-sales",
        name: "Sales conversation",
        description: "Guide a sales call toward a clear next step.",
        goal: "Understand their problem, budget, timeline, and decision process; agree on a concrete next step before the call ends.",
        notes: "ask what prompted them to take this call\nget specific about the problem: frequency, cost, who feels it\nask what they've tried already and why it fell short\nidentify who else is involved in the decision\nask about timeline and budget range\ndon't pitch until the problem is confirmed\nclose with a concrete next step: date, owner, deliverable",
    },
    BuiltinTemplate {
        id: "builtin-discovery",
        name: "Customer discovery",
        description: "Validate the problem before the solution.",
        goal: "Learn their current workflow, pains, and workarounds without pitching; validate whether the problem is real and painful.",
        notes: "ask them to walk through their current workflow step by step\ndig into the last time the problem actually happened\nask what workarounds they use today\nask how much time or money the problem costs\navoid pitching or leading the witness\nask who else has this problem\nask what would make them switch from their current approach",
    },
    BuiltinTemplate {
        id: "builtin-communication",
        name: "Clear communication",
        description: "Keep the conversation crisp and mutual.",
        goal: "Keep statements short and concrete, check understanding often, and close every loop explicitly.",
        notes: "one idea per statement; pause after key points\nreplace abstractions with concrete examples\ncheck understanding: 'does that match how you see it?'\nlet them finish; don't interrupt\nsummarize agreements out loud before moving on\nflag open questions explicitly instead of letting them drop",
    },
    BuiltinTemplate {
        id: "builtin-deescalate",
        name: "De-escalate / avoid arguments",
        description: "Lower the temperature and find the shared goal.",
        goal: "Acknowledge before countering, name emotions, slow the pace, and steer toward the shared goal instead of winning the point.",
        notes: "acknowledge their point before responding to it\nname the emotion you hear: 'sounds like this has been frustrating'\nslow down and lower your volume when tension rises\nask questions instead of stating counterpoints\nfind and restate the shared goal\nif it keeps heating up, suggest a pause or a follow-up",
    },
    BuiltinTemplate {
        id: "builtin-leadership",
        name: "Leadership presence",
        description: "Lead the room by listening and committing clearly.",
        goal: "Listen more than you speak, ask before telling, give specific credit, and end with clear owners and dates.",
        notes: "speak last: gather everyone's view first\nask 'what do you think?' before giving your answer\ngive credit by name for specific contributions\nstate decisions and the reasoning plainly\nevery action item gets an owner and a date\nadmit uncertainty openly; it builds trust",
    },
];

/// Insert any missing builtin templates. `INSERT OR IGNORE` keyed on the
/// fixed ids means user edits and deletions are never overwritten here —
/// the caller's settings flag is what prevents deleted builtins from
/// reappearing on later launches.
pub fn seed_builtin_templates(conn: &Connection, now_iso: &str) -> Result<usize, DbError> {
    let mut inserted = 0;
    for b in BUILTIN_TEMPLATES {
        inserted += conn.execute(
            "INSERT OR IGNORE INTO guide_templates
                (id, name, description, goal, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![b.id, b.name, b.description, b.goal, b.notes, now_iso],
        )?;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make(id: &str, name: &str) -> GuideTemplate {
        GuideTemplate {
            id: id.into(),
            name: name.into(),
            description: "desc".into(),
            goal: "the goal".into(),
            notes: "ask about tools\nask about bottlenecks".into(),
            created_at: "2026-05-18T00:00:00Z".into(),
            updated_at: "2026-05-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn insert_get_round_trip() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        let got = get_template(&c, "t1").unwrap().unwrap();
        assert_eq!(got, make("t1", "Discovery"));
    }

    #[test]
    fn get_missing_is_none() {
        let c = fresh();
        assert!(get_template(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn list_sorted_by_name_nocase() {
        let c = fresh();
        insert_template(&c, &make("t1", "zebra")).unwrap();
        insert_template(&c, &make("t2", "Alpha")).unwrap();
        let names: Vec<String> = list_templates(&c).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["Alpha".to_string(), "zebra".to_string()]);
    }

    #[test]
    fn update_changes_fields_and_timestamp() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        update_template(&c, "t1", "Renamed", "d2", "g2", "n2", "2026-05-19T00:00:00Z").unwrap();
        let got = get_template(&c, "t1").unwrap().unwrap();
        assert_eq!(got.name, "Renamed");
        assert_eq!(got.description, "d2");
        assert_eq!(got.goal, "g2");
        assert_eq!(got.notes, "n2");
        assert_eq!(got.updated_at, "2026-05-19T00:00:00Z");
        assert_eq!(got.created_at, "2026-05-18T00:00:00Z");
    }

    #[test]
    fn delete_removes_row() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        delete_template(&c, "t1").unwrap();
        assert!(get_template(&c, "t1").unwrap().is_none());
    }

    #[test]
    fn seed_builtins_inserts_five_then_zero() {
        let c = fresh();
        assert_eq!(seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap(), 5);
        assert_eq!(seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap(), 0);
        assert_eq!(list_templates(&c).unwrap().len(), 5);
    }

    #[test]
    fn seed_builtins_does_not_clobber_user_edits() {
        let c = fresh();
        seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap();
        update_template(&c, "builtin-sales", "My sales", "d", "g", "n", "2026-07-04T00:00:00Z").unwrap();
        seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap();
        assert_eq!(get_template(&c, "builtin-sales").unwrap().unwrap().name, "My sales");
    }
}
