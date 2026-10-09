//! Local review drafts and account metadata. OAuth material lives only in Keychain.
use super::api::MailMessage;
use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub connected_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Fields {
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub body: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Draft {
    pub id: String,
    pub account_id: String,
    pub from: String,
    pub revision: u64,
    pub fields: Fields,
    pub reply_to: Option<MailMessage>,
    pub gmail_id: Option<String>,
    pub saved_revision: Option<u64>,
    /// Unknown means the server may have accepted a write. Never retry automatically.
    pub status: String,
    pub sent_message_id: Option<String>,
}
pub fn accounts(c: &Connection) -> Result<Vec<Account>, DbError> {
    let mut q =
        c.prepare("SELECT id,email,connected_at FROM gmail_accounts ORDER BY connected_at,id")?;
    let rows = q
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                email: r.get(1)?,
                connected_at: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
pub fn account(c: &Connection, id: &str) -> Result<Option<Account>, DbError> {
    Ok(accounts(c)?.into_iter().find(|a| a.id == id))
}
pub fn put_account(c: &Connection, a: &Account) -> Result<(), DbError> {
    c.execute("INSERT INTO gmail_accounts(id,email,connected_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET email=excluded.email,connected_at=excluded.connected_at", params![a.id,a.email,a.connected_at])?;
    Ok(())
}
pub fn put_draft(c: &Connection, d: &Draft) -> Result<(), DbError> {
    c.execute("INSERT INTO gmail_drafts(id,account_id,revision,data,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at", params![d.id,d.account_id,d.revision,serde_json::to_string(d).expect("draft serializes"),crate::db::items::chrono_now_iso()])?;
    Ok(())
}
pub fn draft(c: &Connection, id: &str) -> Result<Option<Draft>, DbError> {
    let data: Option<String> = c
        .query_row("SELECT data FROM gmail_drafts WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    data.map(|s| {
        serde_json::from_str(&s)
            .map_err(|_| DbError::Io(std::io::Error::other("Invalid saved email draft")))
    })
    .transpose()
}
pub fn latest(c: &Connection) -> Result<Option<Draft>, DbError> {
    let id: Option<String> = c
        .query_row(
            "SELECT id FROM gmail_drafts ORDER BY updated_at DESC,rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match id {
        Some(id) => draft(c, &id),
        None => Ok(None),
    }
}
pub fn update(c: &Connection, id: &str, revision: u64, fields: Fields) -> Result<Draft, DbError> {
    let mut d = draft(c, id)?
        .ok_or_else(|| DbError::Io(std::io::Error::other("Draft no longer exists")))?;
    if d.revision != revision || d.status != "review" {
        return Err(DbError::Io(std::io::Error::other(
            "Draft changed or is being sent. Reload it before editing.",
        )));
    }
    if d.fields != fields {
        d.fields = fields;
        d.revision += 1;
        put_draft(c, &d)?;
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_prevent_stale_edits_and_sent_drafts_cannot_be_reused() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&mut c).unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        let a = Account {
            id: "a".into(),
            email: "me@example.com".into(),
            connected_at: "now".into(),
        };
        put_account(&c, &a).unwrap();
        let mut d = Draft {
            id: "d".into(),
            account_id: a.id,
            from: a.email,
            revision: 1,
            fields: Fields::default(),
            reply_to: None,
            gmail_id: None,
            saved_revision: None,
            status: "review".into(),
            sent_message_id: None,
        };
        put_draft(&c, &d).unwrap();
        let fields = Fields {
            body: "new".into(),
            ..Default::default()
        };
        assert_eq!(update(&c, "d", 1, fields.clone()).unwrap().revision, 2);
        assert!(update(&c, "d", 1, Fields::default()).is_err());
        d = draft(&c, "d").unwrap().unwrap();
        d.status = "sent".into();
        put_draft(&c, &d).unwrap();
        assert!(update(&c, "d", 2, fields).is_err());
        c.execute("DELETE FROM gmail_accounts WHERE id='a'", [])
            .unwrap();
        assert!(draft(&c, "d").unwrap().is_none());
    }
}
