pub mod agent;
pub mod api;
pub mod oauth;
pub mod store;

use crate::{commands::AppState, db::Db};
use agent::{Report, ResultData, ToolFuture, Tools};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use store::{Account, Draft, Fields};
use tauri::{AppHandle, Emitter, Listener, Manager, State, WebviewWindow};

pub const WINDOW: &str = "gmail_assistant";
static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static REPORT: Mutex<Option<Report>> = Mutex::new(None);
struct Guard;
impl Guard {
    fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                "Tucky is already handling an email operation. Wait for it to finish.".to_string()
            })?;
        Ok(Self)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}
fn db(app: &AppHandle) -> Result<Db, String> {
    app.state::<AppState>()
        .db
        .clone()
        .ok_or("Tucky's database is unavailable.".into())
}
fn review_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != WINDOW {
        Err("Email writes require Tucky's review window.".into())
    } else {
        Ok(())
    }
}
fn draft_by_id(app: &AppHandle, id: &str) -> Result<Draft, String> {
    db(app)?
        .with_conn(|c| store::draft(c, id))
        .map_err(|e| e.to_string())?
        .ok_or("Draft no longer exists.".into())
}
fn put_draft(app: &AppHandle, d: &Draft) -> Result<(), String> {
    db(app)?
        .with_conn(|c| store::put_draft(c, d))
        .map_err(|e| e.to_string())
}
fn checked_account(app: &AppHandle, id: &str) -> Result<Account, String> {
    db(app)?
        .with_conn(|c| store::account(c, id))
        .map_err(|e| e.to_string())?
        .ok_or("That Gmail account is disconnected.".into())
}
async fn connection(app: &AppHandle, id: &str) -> Result<api::Gmail, String> {
    checked_account(app, id)?;
    api::Gmail::new(oauth::token(id).await?)
}
fn publish(app: &AppHandle, report: &Report) {
    if let Ok(mut state) = REPORT.lock() {
        *state = Some(report.clone());
    }
    let _ = app.emit_to(WINDOW, "gmail:report", report);
}

#[derive(Serialize)]
pub struct Status {
    configured: bool,
    accounts: Vec<Account>,
}
#[tauri::command]
pub fn gmail_status(state: State<'_, AppState>) -> Result<Status, String> {
    Ok(Status {
        configured: oauth::config()?.is_some(),
        accounts: state
            .db
            .as_ref()
            .ok_or("Database unavailable.")?
            .with_conn(store::accounts)
            .map_err(|e| e.to_string())?,
    })
}
#[tauri::command]
pub async fn gmail_import_client(app: AppHandle) -> Result<bool, String> {
    let _guard = Guard::acquire()?;
    use tauri_plugin_dialog::DialogExt;
    let app2 = app.clone();
    let file = tokio::task::spawn_blocking(move || {
        app2.dialog()
            .file()
            .add_filter("Google OAuth JSON", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "File chooser stopped.".to_string())?;
    let Some(file) = file else { return Ok(false) };
    let path = file
        .into_path()
        .map_err(|_| "Select a local JSON file.".to_string())?;
    if std::fs::metadata(&path)
        .map_err(|_| "Could not read OAuth JSON.".to_string())?
        .len()
        > 64000
    {
        return Err("OAuth JSON is too large.".into());
    }
    let raw =
        std::fs::read_to_string(path).map_err(|_| "Could not read OAuth JSON.".to_string())?;
    oauth::import(&raw)?;
    Ok(true)
}
#[tauri::command]
pub async fn gmail_connect(app: AppHandle) -> Result<Account, String> {
    let _guard = Guard::acquire()?;
    let (id, email) = oauth::connect().await?;
    let a = Account {
        id,
        email,
        connected_at: crate::db::items::chrono_now_iso(),
    };
    if let Err(e) = db(&app)?.with_conn(|c| store::put_account(c, &a)) {
        return Err(format!(
            "Gmail authorized but account metadata could not be saved: {e}"
        ));
    }
    let _ = app.emit("gmail:accounts-changed", ());
    Ok(a)
}
#[tauri::command]
pub fn gmail_disconnect(app: AppHandle, account_id: String) -> Result<(), String> {
    let _guard = Guard::acquire()?;
    checked_account(&app, &account_id)?;
    oauth::delete(&account_id)?;
    db(&app)?
        .with_conn(|c| {
            c.execute("DELETE FROM gmail_accounts WHERE id=?1", [&account_id])?;
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    if let Ok(mut report) = REPORT.lock() {
        *report = None;
    }
    let _ = app.emit("gmail:accounts-changed", ());
    Ok(())
}
#[tauri::command]
pub fn gmail_open_assistant(app: AppHandle) -> Result<(), String> {
    open(&app)
}
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().ok();
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::webview::WebviewWindowBuilder::new(
        app,
        WINDOW,
        tauri::WebviewUrl::App("src/gmail-assistant/index.html".into()),
    )
    .title("Tucky — Email assistant")
    .inner_size(780.0, 760.0)
    .min_inner_size(420.0, 480.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[derive(Serialize)]
pub struct AssistantState {
    report: Option<Report>,
    draft: Option<Draft>,
    busy: bool,
}
#[tauri::command]
pub fn gmail_assistant_state(app: AppHandle) -> Result<AssistantState, String> {
    let report = REPORT
        .lock()
        .map_err(|_| "Email state unavailable.")?
        .clone();
    let draft = match report.as_ref().and_then(|r| r.draft.as_ref()) {
        Some(d) => db(&app)?
            .with_conn(|c| store::draft(c, &d.id))
            .map_err(|e| e.to_string())?,
        None => db(&app)?
            .with_conn(store::latest)
            .map_err(|e| e.to_string())?,
    };
    Ok(AssistantState {
        report,
        draft,
        busy: BUSY.load(Ordering::SeqCst),
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FocusSnapshot {
    pub draft_id: String,
    pub revision: u64,
    pub fields: Fields,
    pub selection: Option<String>,
}
/// Snapshot DOM edits before the recording overlay takes focus. Unacknowledged
/// snapshots never fall back to another window or a stale stored draft.
pub async fn capture_focus(app: &AppHandle) -> Option<FocusSnapshot> {
    let window = app.get_webview_window(WINDOW)?;
    if !window.is_focused().unwrap_or(false) {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(Mutex::new(Some(tx)));
    let listener = window.listen(format!("gmail:captured:{id}"), move |event| {
        if let Some(tx) = sender.lock().ok().and_then(|mut s| s.take()) {
            let _ = tx.send(
                serde_json::from_str::<Option<FocusSnapshot>>(event.payload())
                    .ok()
                    .flatten(),
            );
        }
    });
    let _ = app.emit_to(WINDOW, "gmail:capture", id);
    let snapshot = tokio::time::timeout(std::time::Duration::from_millis(500), rx)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    window.unlisten(listener);
    let mut snapshot = snapshot?;
    // Flush DOM edits now, before ASR processing and its delayed completion.
    // A later manual edit advances the revision and makes this snapshot stale.
    let _guard = Guard::acquire().ok()?;
    validate_fields(&snapshot.fields).ok()?;
    let d = db(app)
        .ok()?
        .with_conn(|c| {
            store::update(
                c,
                &snapshot.draft_id,
                snapshot.revision,
                snapshot.fields.clone(),
            )
        })
        .ok()?;
    snapshot.revision = d.revision;
    let _ = app.emit_to(WINDOW, "gmail:draft", d);
    Some(snapshot)
}
#[tauri::command]
pub async fn gmail_run_assistant(
    app: AppHandle,
    request: String,
    focus: Option<FocusSnapshot>,
) -> Result<Report, String> {
    run_request(app, request, focus).await
}
#[tauri::command]
pub fn gmail_stop_assistant() {
    CANCEL.store(true, Ordering::SeqCst);
}
pub async fn run_request(
    app: AppHandle,
    request: String,
    focus: Option<FocusSnapshot>,
) -> Result<Report, String> {
    if request.trim().is_empty() || request.len() > 4000 {
        return Err("Enter an email request of up to 4,000 bytes.".into());
    }
    let _guard = Guard::acquire()?;
    CANCEL.store(false, Ordering::SeqCst);
    let focused = if let Some(snapshot) = focus {
        validate_fields(&snapshot.fields)?;
        if snapshot.fields.body.chars().count() > 12000 {
            return Err("This draft is too long for a contextual local-model edit. Edit it manually or shorten it first.".into());
        }
        let d = db(&app)?
            .with_conn(|c| store::update(c, &snapshot.draft_id, snapshot.revision, snapshot.fields))
            .map_err(|e| e.to_string())?;
        Some((
            d,
            snapshot
                .selection
                .map(|s| s.chars().take(8000).collect::<String>()),
        ))
    } else {
        None
    };
    let context = focused
        .as_ref()
        .map(|(d, s)| json!({"draft":d,"selected_text":s}))
        .unwrap_or(Value::Null);
    let tools = NativeTools {
        app: app.clone(),
        request: request.clone(),
        focused: focused.map(|(d, _)| d),
        seen: Mutex::new(HashSet::new()),
        read_messages: Mutex::new(HashSet::new()),
    };
    open(&app)?;
    let llm = app.state::<AppState>().llm.clone();
    Ok(
        agent::run(llm.as_ref(), &tools, &request, context, &CANCEL, |report| {
            publish(&app, report)
        })
        .await,
    )
}
fn validate_fields(fields: &Fields) -> Result<(), String> {
    if fields.to.len() > 2000
        || fields.cc.len() > 2000
        || fields.subject.len() > 1000
        || fields.subject.contains(['\r', '\n'])
        || fields.body.len() > 64000
    {
        return Err("Email fields exceed their size limit or contain multiline headers.".into());
    }
    if !fields.to.trim().is_empty() {
        api::addresses(&fields.to)?;
    }
    if !fields.cc.trim().is_empty() {
        api::addresses(&fields.cc)?;
    }
    Ok(())
}
#[tauri::command]
pub fn gmail_update_draft(
    app: AppHandle,
    window: WebviewWindow,
    draft_id: String,
    revision: u64,
    fields: Fields,
) -> Result<Draft, String> {
    review_window(&window)?;
    let _guard = Guard::acquire()?;
    validate_fields(&fields)?;
    let d = db(&app)?
        .with_conn(|c| store::update(c, &draft_id, revision, fields))
        .map_err(|e| e.to_string())?;
    let _ = app.emit_to(WINDOW, "gmail:draft", &d);
    Ok(d)
}
#[tauri::command]
pub async fn gmail_save_draft(
    app: AppHandle,
    window: WebviewWindow,
    draft_id: String,
    revision: u64,
) -> Result<Draft, String> {
    review_window(&window)?;
    write_reviewed(&app, &draft_id, revision, false).await
}
#[tauri::command]
pub async fn gmail_send_draft(
    app: AppHandle,
    window: WebviewWindow,
    draft_id: String,
    revision: u64,
) -> Result<Draft, String> {
    review_window(&window)?;
    write_reviewed(&app, &draft_id, revision, true).await
}
fn reviewed(d: &Draft, revision: u64) -> Result<(), String> {
    if d.revision != revision || d.status != "review" {
        return Err("The draft changed or a previous send/save is unresolved. Review the current draft before continuing.".into());
    }
    api::message_payload(d)?;
    Ok(())
}
async fn write_reviewed(
    app: &AppHandle,
    id: &str,
    revision: u64,
    send: bool,
) -> Result<Draft, String> {
    let _guard = Guard::acquire()?;
    let mut d = draft_by_id(app, id)?;
    reviewed(&d, revision)?;
    if !send && d.saved_revision == Some(revision) {
        return Ok(d);
    }
    let api = connection(app, &d.account_id).await?;
    // Persist before the network write so a crash cannot permit a blind resend.
    d.status = if send { "sending" } else { "saving" }.into();
    put_draft(app, &d)?;
    let _ = app.emit_to(WINDOW, "gmail:draft", &d);
    let result = if send {
        api.send(&d).await
    } else {
        api.save(&d).await
    };
    match result {
        Ok(id) => {
            if send {
                d.status = "sent".into();
                d.sent_message_id = Some(id);
            } else {
                d.status = "review".into();
                d.gmail_id = Some(id);
                d.saved_revision = Some(d.revision);
            }
            put_draft(app, &d)?;
            let _ = app.emit_to(WINDOW, "gmail:draft", &d);
            Ok(d)
        }
        Err(e) => {
            // Definite provider rejections cannot have accepted the message.
            d.status = if e.contains("HTTP 400")
                || e.contains("HTTP 404")
                || e.contains("sign-in expired")
                || e.contains("refused access")
                || e.contains("rate limiting")
            {
                "review"
            } else {
                "write_unknown"
            }
            .into();
            put_draft(app, &d)?;
            let _ = app.emit_to(WINDOW, "gmail:draft", &d);
            Err(e)
        }
    }
}
#[tauri::command]
pub fn gmail_open_draft(app: AppHandle, draft_id: String) -> Result<(), String> {
    let d = draft_by_id(&app, &draft_id)?;
    checked_account(&app, &d.account_id)?;
    open_gmail(&d.from, "drafts")
}
pub fn open_gmail(account: &str, fragment: &str) -> Result<(), String> {
    let mut url = url::Url::parse("https://mail.google.com/mail/u/").expect("fixed URL");
    url.query_pairs_mut().append_pair("authuser", account);
    url.set_fragment(Some(fragment));
    std::process::Command::new("open")
        .arg(url.as_str())
        .spawn()
        .map_err(|_| "Could not open Gmail in your browser.".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn gmail_open_thread(
    app: AppHandle,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    let account = checked_account(&app, &account_id)?;
    api::identifier(&thread_id)?;
    open_gmail(&account.email, &format!("all/{thread_id}"))
}

struct NativeTools {
    app: AppHandle,
    request: String,
    focused: Option<Draft>,
    seen: Mutex<HashSet<(String, String)>>,
    read_messages: Mutex<HashSet<(String, String)>>,
}
fn arg<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required."))
}
impl Tools for NativeTools {
    fn execute<'a>(&'a self, tool: &'a str, args: Value) -> ToolFuture<'a> {
        Box::pin(async move {
            if CANCEL.load(Ordering::SeqCst) {
                return Err("Stopped.".into());
            }
            if tool == "list_accounts" {
                return Ok(ResultData::data(json!(db(&self.app)?
                    .with_conn(store::accounts)
                    .map_err(|e| e.to_string())?)));
            }
            if tool == "search_memory" {
                let query = crate::commands::build_rag_query(arg(&args, "query")?);
                let items = db(&self.app)?
                    .with_conn(|c| crate::db::search::search_items(c, &query, None, 6))
                    .map_err(|e| e.to_string())?;
                return Ok(ResultData::data(json!(items.into_iter().map(|i|json!({"id":i.id,"date":i.captured_at,"text":i.content.chars().take(3000).collect::<String>()})).collect::<Vec<_>>())));
            }
            if tool == "edit_draft" {
                let d = self
                    .focused
                    .as_ref()
                    .ok_or("Focus a draft before asking Tucky to edit it.")?;
                let fields: Fields = serde_json::from_value(args)
                    .map_err(|_| "Return to, cc, subject and body only.".to_string())?;
                validate_fields(&fields)?;
                if d.reply_to.is_some() && fields.subject != d.fields.subject {
                    return Err("Preserve the original subject for this reply.".into());
                }
                let d = db(&self.app)?
                    .with_conn(|c| store::update(c, &d.id, d.revision, fields))
                    .map_err(|e| e.to_string())?;
                return Ok(ResultData {
                    data: json!({"local_draft_id":d.id,"saved_to_gmail":false,"sent":false}),
                    draft: Some(d),
                    sources: vec![],
                });
            }
            let account_id = arg(&args, "account_id")?;
            let account = checked_account(&self.app, account_id)?;
            match tool {
                "search_email" => {
                    let result = connection(&self.app, account_id)
                        .await?
                        .search(arg(&args, "query")?, args["page_token"].as_str())
                        .await?;
                    let mut seen = self
                        .seen
                        .lock()
                        .map_err(|_| "Email evidence unavailable.")?;
                    for m in result["messages"].as_array().into_iter().flatten() {
                        for field in ["id", "thread_id"] {
                            if let Some(id) = m[field].as_str() {
                                seen.insert((account_id.into(), id.into()));
                            }
                        }
                    }
                    let sources = result["messages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|m| agent::EmailSource {
                            account_id: account_id.into(),
                            account: account.email.clone(),
                            thread_id: m["thread_id"].as_str().unwrap_or("").into(),
                            subject: m["subject"].as_str().unwrap_or("").into(),
                            from: m["from"].as_str().unwrap_or("").into(),
                            date: m["date"].as_str().unwrap_or("").into(),
                        })
                        .collect();
                    Ok(ResultData {
                        data: result,
                        draft: None,
                        sources,
                    })
                }
                "read_thread" => {
                    let id = arg(&args, "thread_id")?;
                    if !self
                        .seen
                        .lock()
                        .map_err(|_| "Email evidence unavailable.")?
                        .contains(&(account_id.into(), id.into()))
                        && !self.focused.as_ref().is_some_and(|d| {
                            d.account_id == account_id
                                && d.reply_to.as_ref().is_some_and(|m| m.thread_id == id)
                        })
                    {
                        return Err("Search this account first; use a returned thread ID.".into());
                    }
                    let data = connection(&self.app, account_id).await?.thread(id).await?;
                    let mut sources = vec![];
                    let mut seen = self
                        .seen
                        .lock()
                        .map_err(|_| "Email evidence unavailable.")?;
                    for m in data["messages"].as_array().into_iter().flatten() {
                        if let Some(mid) = m["id"].as_str() {
                            seen.insert((account_id.into(), mid.into()));
                            self.read_messages
                                .lock()
                                .map_err(|_| "Email evidence unavailable.")?
                                .insert((account_id.into(), mid.into()));
                        }
                        sources.push(agent::EmailSource {
                            account_id: account_id.into(),
                            account: account.email.clone(),
                            thread_id: id.into(),
                            subject: m["subject"].as_str().unwrap_or("").into(),
                            from: m["from"].as_str().unwrap_or("").into(),
                            date: m["date"].as_str().unwrap_or("").into(),
                        });
                    }
                    Ok(ResultData {
                        data,
                        draft: None,
                        sources,
                    })
                }
                "prepare_draft" => {
                    if !agent::draft_intent(&self.request) {
                        return Err("The user did not request a draft.".into());
                    }
                    let reply = if let Some(id) =
                        args["reply_message_id"].as_str().filter(|s| !s.is_empty())
                    {
                        if !self
                            .read_messages
                            .lock()
                            .map_err(|_| "Email evidence unavailable.")?
                            .contains(&(account_id.into(), id.into()))
                        {
                            return Err("Read the conversation with read_thread before preparing its reply.".into());
                        }
                        Some(
                            connection(&self.app, account_id)
                                .await?
                                .message(id, "full")
                                .await?,
                        )
                    } else {
                        None
                    };
                    let mut fields = Fields {
                        to: args["to"].as_str().unwrap_or("").into(),
                        cc: args["cc"].as_str().unwrap_or("").into(),
                        subject: args["subject"].as_str().unwrap_or("").into(),
                        body: arg(&args, "body")?.into(),
                    };
                    if let Some(m) = &reply {
                        fields.subject = m.subject.clone();
                        if fields.to.trim().is_empty() {
                            let from = api::addresses(&m.from)?;
                            fields.to =
                                api::addresses(if from.eq_ignore_ascii_case(&account.email) {
                                    &m.to
                                } else if m.reply_to.trim().is_empty() {
                                    &m.from
                                } else {
                                    &m.reply_to
                                })?;
                        }
                    }
                    validate_fields(&fields)?;
                    let d = Draft {
                        id: uuid::Uuid::new_v4().to_string(),
                        account_id: account_id.into(),
                        from: account.email,
                        revision: 1,
                        fields,
                        reply_to: reply,
                        gmail_id: None,
                        saved_revision: None,
                        status: "review".into(),
                        sent_message_id: None,
                    };
                    put_draft(&self.app, &d)?;
                    Ok(ResultData {
                        data: json!({"local_draft_id":d.id,"saved_to_gmail":false,"sent":false}),
                        draft: Some(d),
                        sources: vec![],
                    })
                }
                _ => Err("Unknown email tool.".into()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_or_unresolved_draft_cannot_be_sent() {
        let mut d = Draft {
            id: "draft".into(),
            account_id: "a".into(),
            from: "me@example.com".into(),
            revision: 2,
            fields: Fields {
                to: "you@example.com".into(),
                cc: String::new(),
                subject: "Hello".into(),
                body: "Hi".into(),
            },
            reply_to: None,
            gmail_id: None,
            saved_revision: None,
            status: "review".into(),
            sent_message_id: None,
        };
        assert!(reviewed(&d, 1).is_err());
        assert!(reviewed(&d, 2).is_ok());
        for status in ["sending", "saving", "write_unknown", "sent"] {
            d.status = status.into();
            assert!(reviewed(&d, 2).is_err());
        }
    }
}
