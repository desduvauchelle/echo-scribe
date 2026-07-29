//! Persistence for meeting-intelligence workflows layered on top of the
//! original meeting snapshot tables. Everything here is additive so older
//! meetings remain readable and reversible edits can preserve their source.

use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SummaryTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub sections_json: String,
    pub is_builtin: bool,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub default_scope: String,
    pub is_builtin: bool,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Company {
    pub id: String,
    pub name: String,
    pub domain: Option<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub role: Option<String>,
    pub company_id: Option<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingParticipant {
    pub meeting_id: String,
    pub speaker_key: String,
    pub person_id: Option<String>,
    pub display_name: String,
    pub source: String,
    pub confirmed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingArtifact {
    pub id: String,
    pub kind: String,
    pub meeting_id: Option<String>,
    pub person_id: Option<String>,
    pub company_id: Option<String>,
    pub project_id: Option<String>,
    pub title: String,
    pub content: String,
    pub sources_json: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingPreferences {
    pub meeting_id: String,
    pub summary_template_id: Option<String>,
    pub transparency_ack: bool,
    pub consent_message: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingSummaryRun {
    pub id: String,
    pub meeting_id: String,
    pub template_id: Option<String>,
    pub template_snapshot_json: Option<String>,
    pub summary_json: Option<String>,
    pub user_notes_snapshot: String,
    pub transcript_hash: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

pub fn seed_builtins(conn: &Connection, now: &str) -> Result<(), DbError> {
    let templates = [
        ("builtin-general", "General", "Balanced notes for any conversation", "Summarize the key points, decisions, risks, and next steps.", r#"["Summary","Decisions","Action items"]"#),
        ("builtin-discovery", "Customer discovery", "Needs, behavior, quotes, and opportunities", "Emphasize the participant's current workflow, pain points, desired outcomes, evidence, and exact language.", r#"["Current workflow","Pain points","Evidence","Opportunities","Next steps"]"#),
        ("builtin-sales-summary", "Sales", "Discovery, objections, commitments, and follow-up", "Emphasize goals, qualification signals, objections, stakeholders, commitments, and next steps.", r#"["Goals","Signals","Objections","Commitments","Next steps"]"#),
        ("builtin-recruiting", "Recruiting", "Evidence-based interview notes", "Separate demonstrated evidence from inference. Summarize strengths, concerns, and follow-up questions without inventing a hiring recommendation.", r#"["Evidence","Strengths","Concerns","Follow-up"]"#),
        ("builtin-one-on-one", "1:1", "Private coaching and commitments", "Capture wins, concerns, feedback, commitments, and topics to revisit while avoiding unsupported judgments.", r#"["Wins","Topics","Feedback","Commitments","Revisit"]"#),
        ("builtin-project-update", "Project update", "Progress, decisions, risks, and owners", "Summarize progress, decisions, blockers, risks, and owner-specific action items.", r#"["Progress","Decisions","Blockers","Risks","Actions"]"#),
    ];
    for (id, name, description, instructions, sections) in templates {
        conn.execute(
            "INSERT OR IGNORE INTO summary_templates
             (id,name,description,instructions,sections_json,is_builtin,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,1,?6,?6)",
            params![id, name, description, instructions, sections, now],
        )?;
    }
    let recipes = [
        ("builtin-research-patterns", "Research patterns", "Synthesize repeated needs and contradictions", "Identify recurring needs, behaviors, contradictions, and supporting evidence. Separate observations from inference.", "project"),
        ("builtin-sales-objections", "Sales objections", "Group objections and responses", "Group objections by theme, quote the strongest evidence, and propose grounded follow-up questions.", "meeting"),
        ("builtin-candidate-scorecard", "Candidate evidence", "Evidence for an interview scorecard", "Organize demonstrated evidence, missing evidence, strengths, concerns, and follow-up questions. Do not make unsupported judgments.", "meeting"),
        ("builtin-prd-inputs", "PRD inputs", "Turn conversations into product inputs", "Extract user problems, desired outcomes, constraints, open questions, and evidence suitable for a product brief.", "project"),
        ("builtin-decisions", "Decision log", "Find decisions and rationale", "List decisions, rationale, alternatives considered, owners, and unresolved questions with source evidence.", "meeting"),
        ("builtin-action-review", "Action review", "Review commitments and status", "List commitments by owner, deadlines when stated, blockers, and follow-up needed. Do not invent dates.", "meeting"),
    ];
    for (id, name, description, prompt, scope) in recipes {
        conn.execute(
            "INSERT OR IGNORE INTO recipes
             (id,name,description,prompt,default_scope,is_builtin,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,1,?6,?6)",
            params![id, name, description, prompt, scope, now],
        )?;
    }
    Ok(())
}

pub fn list_summary_templates(conn: &Connection) -> Result<Vec<SummaryTemplate>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id,name,description,instructions,sections_json,is_builtin,archived_at,created_at,updated_at
         FROM summary_templates WHERE archived_at IS NULL ORDER BY is_builtin DESC,name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SummaryTemplate {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            instructions: r.get(3)?,
            sections_json: r.get(4)?,
            is_builtin: r.get::<_, i64>(5)? != 0,
            archived_at: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

pub fn get_summary_template(
    conn: &Connection,
    id: &str,
) -> Result<Option<SummaryTemplate>, DbError> {
    conn.query_row(
        "SELECT id,name,description,instructions,sections_json,is_builtin,archived_at,created_at,updated_at FROM summary_templates WHERE id=?1",
        [id],
        |r| Ok(SummaryTemplate { id:r.get(0)?, name:r.get(1)?, description:r.get(2)?, instructions:r.get(3)?, sections_json:r.get(4)?, is_builtin:r.get::<_,i64>(5)? != 0, archived_at:r.get(6)?, created_at:r.get(7)?, updated_at:r.get(8)? }),
    ).optional().map_err(DbError::from)
}

pub fn upsert_summary_template(conn: &Connection, t: &SummaryTemplate) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO summary_templates(id,name,description,instructions,sections_json,is_builtin,archived_at,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,instructions=excluded.instructions,sections_json=excluded.sections_json,archived_at=excluded.archived_at,updated_at=excluded.updated_at",
        params![t.id,t.name,t.description,t.instructions,t.sections_json,t.is_builtin as i64,t.archived_at,t.created_at,t.updated_at],
    )?;
    Ok(())
}

pub fn list_recipes(conn: &Connection) -> Result<Vec<Recipe>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id,name,description,prompt,default_scope,is_builtin,archived_at,created_at,updated_at
         FROM recipes WHERE archived_at IS NULL ORDER BY is_builtin DESC,name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Recipe {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            prompt: r.get(3)?,
            default_scope: r.get(4)?,
            is_builtin: r.get::<_, i64>(5)? != 0,
            archived_at: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

pub fn get_recipe(conn: &Connection, id: &str) -> Result<Option<Recipe>, DbError> {
    conn.query_row(
        "SELECT id,name,description,prompt,default_scope,is_builtin,archived_at,created_at,updated_at FROM recipes WHERE id=?1",
        [id],
        |r| Ok(Recipe { id:r.get(0)?, name:r.get(1)?, description:r.get(2)?, prompt:r.get(3)?, default_scope:r.get(4)?, is_builtin:r.get::<_,i64>(5)? != 0, archived_at:r.get(6)?, created_at:r.get(7)?, updated_at:r.get(8)? }),
    ).optional().map_err(DbError::from)
}

pub fn get_company(conn: &Connection, id: &str) -> Result<Option<Company>, DbError> {
    conn.query_row(
        "SELECT id,name,domain,notes,created_at,updated_at FROM companies WHERE id=?1 AND deleted_at IS NULL",
        [id],
        |r| Ok(Company { id:r.get(0)?,name:r.get(1)?,domain:r.get(2)?,notes:r.get(3)?,created_at:r.get(4)?,updated_at:r.get(5)? }),
    ).optional().map_err(DbError::from)
}

pub fn get_person(conn: &Connection, id: &str) -> Result<Option<Person>, DbError> {
    conn.query_row(
        "SELECT id,name,email,role,company_id,notes,created_at,updated_at FROM people WHERE id=?1 AND deleted_at IS NULL",
        [id],
        |r| Ok(Person { id:r.get(0)?,name:r.get(1)?,email:r.get(2)?,role:r.get(3)?,company_id:r.get(4)?,notes:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)? }),
    ).optional().map_err(DbError::from)
}

pub fn upsert_recipe(conn: &Connection, rcp: &Recipe) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO recipes(id,name,description,prompt,default_scope,is_builtin,archived_at,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,prompt=excluded.prompt,default_scope=excluded.default_scope,archived_at=excluded.archived_at,updated_at=excluded.updated_at",
        params![rcp.id,rcp.name,rcp.description,rcp.prompt,rcp.default_scope,rcp.is_builtin as i64,rcp.archived_at,rcp.created_at,rcp.updated_at],
    )?;
    Ok(())
}

pub fn set_chat_scope(
    conn: &Connection,
    session_id: &str,
    kind: &str,
    id: &str,
    now: &str,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO chat_session_scopes(session_id,scope_kind,scope_id,created_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(session_id) DO UPDATE SET scope_kind=excluded.scope_kind,scope_id=excluded.scope_id",
        params![session_id,kind,id,now],
    )?;
    Ok(())
}

pub fn get_preferences(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Option<MeetingPreferences>, DbError> {
    conn.query_row(
        "SELECT meeting_id,summary_template_id,transparency_ack,consent_message,updated_at FROM meeting_preferences WHERE meeting_id=?1",
        [meeting_id],
        |r| Ok(MeetingPreferences { meeting_id:r.get(0)?, summary_template_id:r.get(1)?, transparency_ack:r.get::<_,i64>(2)? != 0, consent_message:r.get(3)?, updated_at:r.get(4)? }),
    ).optional().map_err(DbError::from)
}

pub fn upsert_preferences(conn: &Connection, p: &MeetingPreferences) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meeting_preferences(meeting_id,summary_template_id,transparency_ack,consent_message,updated_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(meeting_id) DO UPDATE SET summary_template_id=excluded.summary_template_id,transparency_ack=excluded.transparency_ack,consent_message=excluded.consent_message,updated_at=excluded.updated_at",
        params![p.meeting_id,p.summary_template_id,p.transparency_ack as i64,p.consent_message,p.updated_at],
    )?;
    Ok(())
}

pub fn insert_summary_run(conn: &Connection, r: &MeetingSummaryRun) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meeting_summary_runs(id,meeting_id,template_id,template_snapshot_json,summary_json,user_notes_snapshot,transcript_hash,status,error,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![r.id,r.meeting_id,r.template_id,r.template_snapshot_json,r.summary_json,r.user_notes_snapshot,r.transcript_hash,r.status,r.error,r.created_at],
    )?;
    Ok(())
}

pub fn list_summary_runs(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingSummaryRun>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id,meeting_id,template_id,template_snapshot_json,summary_json,user_notes_snapshot,transcript_hash,status,error,created_at
         FROM meeting_summary_runs WHERE meeting_id=?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([meeting_id], |r| {
        Ok(MeetingSummaryRun {
            id: r.get(0)?,
            meeting_id: r.get(1)?,
            template_id: r.get(2)?,
            template_snapshot_json: r.get(3)?,
            summary_json: r.get(4)?,
            user_notes_snapshot: r.get(5)?,
            transcript_hash: r.get(6)?,
            status: r.get(7)?,
            error: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

pub fn get_chat_scope(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, String)>, DbError> {
    conn.query_row(
        "SELECT scope_kind,scope_id FROM chat_session_scopes WHERE session_id=?1",
        [session_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(DbError::from)
}

pub fn upsert_company(conn: &Connection, c: &Company) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO companies(id,name,domain,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,domain=excluded.domain,notes=excluded.notes,updated_at=excluded.updated_at,deleted_at=NULL",
        params![c.id,c.name,c.domain,c.notes,c.created_at,c.updated_at],
    )?;
    Ok(())
}

pub fn list_companies(conn: &Connection) -> Result<Vec<Company>, DbError> {
    let mut stmt = conn.prepare("SELECT id,name,domain,notes,created_at,updated_at FROM companies WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| {
        Ok(Company {
            id: r.get(0)?,
            name: r.get(1)?,
            domain: r.get(2)?,
            notes: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

pub fn upsert_person(conn: &Connection, p: &Person) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO people(id,name,email,role,company_id,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,company_id=excluded.company_id,notes=excluded.notes,updated_at=excluded.updated_at,deleted_at=NULL",
        params![p.id,p.name,p.email,p.role,p.company_id,p.notes,p.created_at,p.updated_at],
    )?;
    Ok(())
}

pub fn list_people(conn: &Connection) -> Result<Vec<Person>, DbError> {
    let mut stmt = conn.prepare("SELECT id,name,email,role,company_id,notes,created_at,updated_at FROM people WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| {
        Ok(Person {
            id: r.get(0)?,
            name: r.get(1)?,
            email: r.get(2)?,
            role: r.get(3)?,
            company_id: r.get(4)?,
            notes: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

pub fn upsert_participant(conn: &Connection, p: &MeetingParticipant) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meeting_participants(meeting_id,speaker_key,person_id,display_name,source,confirmed,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(meeting_id,speaker_key) DO UPDATE SET person_id=excluded.person_id,display_name=excluded.display_name,source=excluded.source,confirmed=excluded.confirmed,updated_at=excluded.updated_at",
        params![p.meeting_id,p.speaker_key,p.person_id,p.display_name,p.source,p.confirmed as i64,p.created_at,p.updated_at],
    )?;
    Ok(())
}

pub fn list_participants(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingParticipant>, DbError> {
    let mut stmt = conn.prepare("SELECT meeting_id,speaker_key,person_id,display_name,source,confirmed,created_at,updated_at FROM meeting_participants WHERE meeting_id=?1 ORDER BY speaker_key")?;
    let rows = stmt.query_map([meeting_id], |r| {
        Ok(MeetingParticipant {
            meeting_id: r.get(0)?,
            speaker_key: r.get(1)?,
            person_id: r.get(2)?,
            display_name: r.get(3)?,
            source: r.get(4)?,
            confirmed: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

pub fn insert_artifact(conn: &Connection, a: &MeetingArtifact) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meeting_artifacts(id,kind,meeting_id,person_id,company_id,project_id,title,content,sources_json,status,error,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![a.id,a.kind,a.meeting_id,a.person_id,a.company_id,a.project_id,a.title,a.content,a.sources_json,a.status,a.error,a.created_at,a.updated_at],
    )?;
    Ok(())
}

pub fn get_artifact(conn: &Connection, id: &str) -> Result<Option<MeetingArtifact>, DbError> {
    conn.query_row(
        "SELECT id,kind,meeting_id,person_id,company_id,project_id,title,content,sources_json,status,error,created_at,updated_at FROM meeting_artifacts WHERE id=?1",
        [id],
        |r| Ok(MeetingArtifact { id:r.get(0)?,kind:r.get(1)?,meeting_id:r.get(2)?,person_id:r.get(3)?,company_id:r.get(4)?,project_id:r.get(5)?,title:r.get(6)?,content:r.get(7)?,sources_json:r.get(8)?,status:r.get(9)?,error:r.get(10)?,created_at:r.get(11)?,updated_at:r.get(12)? }),
    ).optional().map_err(DbError::from)
}

pub fn list_artifacts(
    conn: &Connection,
    kind: Option<&str>,
    meeting_id: Option<&str>,
) -> Result<Vec<MeetingArtifact>, DbError> {
    let mut sql = "SELECT id,kind,meeting_id,person_id,company_id,project_id,title,content,sources_json,status,error,created_at,updated_at FROM meeting_artifacts WHERE 1=1".to_string();
    let mut args: Vec<String> = Vec::new();
    if let Some(k) = kind {
        sql.push_str(" AND kind=?");
        args.push(k.to_string());
    }
    if let Some(m) = meeting_id {
        sql.push_str(" AND meeting_id=?");
        args.push(m.to_string());
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(MeetingArtifact {
            id: r.get(0)?,
            kind: r.get(1)?,
            meeting_id: r.get(2)?,
            person_id: r.get(3)?,
            company_id: r.get(4)?,
            project_id: r.get(5)?,
            title: r.get(6)?,
            content: r.get(7)?,
            sources_json: r.get(8)?,
            status: r.get(9)?,
            error: r.get(10)?,
            created_at: r.get(11)?,
            updated_at: r.get(12)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&mut c).unwrap();
        c
    }

    #[test]
    fn builtins_are_seeded_idempotently() {
        let c = fresh();
        seed_builtins(&c, "2026-07-29T00:00:00Z").unwrap();
        seed_builtins(&c, "2026-07-29T00:00:00Z").unwrap();
        assert_eq!(list_summary_templates(&c).unwrap().len(), 6);
        assert_eq!(list_recipes(&c).unwrap().len(), 6);
    }

    #[test]
    fn chat_scope_round_trip() {
        let c = fresh();
        c.execute(
            "INSERT INTO chat_sessions(id,name,created_at,updated_at) VALUES ('s','Chat','n','n')",
            [],
        )
        .unwrap();
        set_chat_scope(&c, "s", "meeting", "m", "n").unwrap();
        assert_eq!(
            get_chat_scope(&c, "s").unwrap(),
            Some(("meeting".into(), "m".into()))
        );
    }
}
