//! Model Context Protocol server exposed by launching the installed
//! EchoScribe executable with `--mcp`. It uses newline-delimited JSON-RPC over
//! stdio, never exposes a raw SQL primitive, and records tool names (not
//! returned content) in the local diagnostics log.
//!
//! Two tool families:
//! - Read-only knowledge tools that query the local SQLite DB directly and
//!   work whether or not the GUI app is running.
//! - Screen-recording tools (macOS only) forwarded to the running GUI app
//!   over the `mcp_bridge` unix socket.
//!
//! Every tool belongs to a permission category (`mcp_permissions.rs`) shown
//! as a checkbox in Settings → Coding Agents. The category is re-checked on
//! every call by reading the GUI settings file, so unticking a box applies
//! immediately; screen recording is additionally enforced live app-side.

use crate::db::Db;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn audit(tool: &str) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join("Library/Logs").join(crate::data_folder_name());
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("mcp-access.log"))
    {
        let _ = writeln!(file, "{}\t{}", chrono::Utc::now().to_rfc3339(), tool);
    }
}

fn text_result(value: Value) -> Value {
    json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".into())}]})
}

/// Tools that require the running GUI app (forwarded over the local bridge
/// socket — see `mcp_bridge.rs`). Screen recording is macOS-only, so these are
/// only advertised there. All of them additionally require the user to enable
/// recording control in Settings → Coding Agents; calls fail with a
/// remediation message otherwise.
#[cfg(target_os = "macos")]
fn recording_tool_definitions() -> Vec<Value> {
    vec![
        json!({"name":"list_recording_sources","description":"List the windows and displays currently available for screen recording (ids, app names, titles, sizes). Prefer windows with on_screen: true — off-screen windows (other Spaces, minimized) only produce frames when their content updates, so recording them can yield an empty video. Window ids go stale as windows open/close, so call this right before start_recording. Requires the Echo Scribe app to be running and recording control enabled in its Settings → Coding Agents.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"start_recording","description":"Start a screen recording of one window (window_id) or one display (display_id); omit both to record the primary display. Options: mic (default false) records the user's microphone, system_audio (default true) records system sound, camera (default false) also captures the webcam — note the webcam is saved as a SEPARATE video file, never composited into the main video. Returns as soon as capture is running; call stop_recording to finish and get file paths. Requires the Echo Scribe app to be running and recording control enabled in its Settings → Coding Agents.","inputSchema":{"type":"object","properties":{"window_id":{"type":"integer","description":"A window id from list_recording_sources"},"display_id":{"type":"integer","description":"A display id from list_recording_sources"},"mic":{"type":"boolean","default":false},"system_audio":{"type":"boolean","default":true},"camera":{"type":"boolean","default":false}}}}),
        json!({"name":"stop_recording","description":"Stop the in-progress screen recording, save it into the Echo Scribe library, and return absolute file paths: video_path (H.264 MP4 with any recorded audio) plus webcam_video_path and events_path when present. A background audio-cleanup pass may replace video_path with the returned cleaned_video_path shortly after — if video_path is missing when you read it, use cleaned_video_path.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"get_recording_status","description":"Report whether a screen recording is currently in progress, and if so whether it is paused and what source it captures.","inputSchema":{"type":"object","properties":{}}}),
    ]
}

fn tool_definitions() -> Vec<Value> {
    #[allow(unused_mut)]
    let mut tools = vec![
        json!({"name":"search_echoscribe","description":"Search recent local EchoScribe captures by text.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["query"]}}),
        json!({"name":"list_meetings","description":"List recent local meetings and their current summaries.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}}),
        json!({"name":"get_meeting","description":"Read one meeting, including transcript, summary, notes and confirmed speaker labels.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}),
        json!({"name":"list_projects","description":"List active local EchoScribe projects.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"list_tasks","description":"List open local tasks, optionally scoped to a project.","inputSchema":{"type":"object","properties":{"project_id":{"type":"string"}}}}),
        json!({"name":"search_chats","description":"Search the user's Echo Scribe chat conversations by text (case-insensitive). Returns matching messages with their session name, newest first.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["query"]}}),
        json!({"name":"list_chats","description":"List recent Echo Scribe chat sessions, optionally scoped to a project.","inputSchema":{"type":"object","properties":{"project_id":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}}}}),
        json!({"name":"get_chat","description":"Read one Echo Scribe chat session's recent messages (oldest first).","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":500}},"required":["id"]}}),
        json!({"name":"list_people","description":"List confirmed local relationship records.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"list_companies","description":"List confirmed local company records.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"list_recipes","description":"List reusable local meeting Recipes.","inputSchema":{"type":"object","properties":{}}}),
    ];
    #[cfg(target_os = "macos")]
    tools.extend(recording_tool_definitions());
    tools
}

/// Forward one recording request to the GUI app over the bridge socket. The
/// `--mcp` process holds no TCC grants and no sidecar plumbing of its own, so
/// anything that records must run inside the app.
#[cfg(target_os = "macos")]
fn bridge_call(method: &str, params: Value) -> Result<Value, String> {
    use std::io::BufReader;
    use std::os::unix::net::UnixStream;
    let path = crate::mcp_bridge::socket_path()?;
    let mut stream = UnixStream::connect(&path).map_err(|_| {
        "Echo Scribe isn't running, so recording tools are unavailable. Ask the user to open \
         Echo Scribe (or run: open -a \"Echo Scribe\"), then retry."
            .to_string()
    })?;
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
    // Generous read deadline: starting a recording can block on a one-time
    // macOS camera-permission prompt the user has to answer.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(180)));
    writeln!(stream, "{}", json!({"method": method, "params": params})).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let resp: Value = serde_json::from_str(&line)
        .map_err(|e| format!("Echo Scribe returned an invalid bridge response: {e}"))?;
    if resp.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown bridge error")
            .to_string())
    }
}

fn call_tool(db: &Db, name: &str, args: &Value) -> Result<Value, String> {
    audit(name);
    // Per-call permission gate: read the GUI settings file fresh so unticking
    // a checkbox in Settings → Coding Agents applies immediately, even for a
    // client that connected earlier. Screen-recording tools skip the file
    // check — the app-side bridge enforces them against its live state.
    if let Some(perm) = crate::mcp_permissions::tool_permission(name) {
        if perm.id != "screen_recording"
            && !crate::mcp_permissions::enabled_in(
                &crate::mcp_permissions::load_gui_settings(),
                perm,
            )
        {
            return Err(format!(
                "The '{}' permission for coding agents is turned off. Ask the user to enable \
                 it in Echo Scribe → Settings → Coding Agents.",
                perm.label
            ));
        }
    }
    match name {
        "search_echoscribe" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if query.is_empty() {
                return Err("query is required".into());
            }
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 100) as usize;
            let items = db
                .with_conn(|c| crate::db::items::list_items(c, None, None, 500, 0))
                .map_err(|e| e.to_string())?;
            let matches = items
                .into_iter()
                .filter(|item| item.content.to_lowercase().contains(&query))
                .take(limit)
                .collect::<Vec<_>>();
            Ok(text_result(json!(matches)))
        }
        "list_meetings" => {
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(30)
                .clamp(1, 100) as usize;
            let mut meetings = db
                .with_conn(crate::db::meetings::list_meetings)
                .map_err(|e| e.to_string())?;
            meetings.truncate(limit);
            Ok(text_result(json!(meetings)))
        }
        "get_meeting" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or("id is required")?;
            let value = db
                .with_conn(|c| {
                    let meeting = crate::db::meetings::get_meeting(c, id)?;
                    let participants = crate::db::meeting_intelligence::list_participants(c, id)?;
                    let runs = crate::db::meeting_intelligence::list_summary_runs(c, id)?;
                    Ok(json!({"meeting":meeting,"participants":participants,"summary_runs":runs}))
                })
                .map_err(|e| e.to_string())?;
            Ok(text_result(value))
        }
        "list_projects" => Ok(text_result(json!(db
            .with_conn(|c| crate::db::projects::list_projects(c, false))
            .map_err(|e| e.to_string())?))),
        "list_tasks" => {
            let project_id = args.get("project_id").and_then(Value::as_str);
            Ok(text_result(json!(db
                .with_conn(|c| crate::db::tasks::list_tasks(c, false, project_id))
                .map_err(|e| e.to_string())?)))
        }
        "search_chats" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if query.is_empty() {
                return Err("query is required".into());
            }
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 100) as u32;
            Ok(text_result(json!(db
                .with_conn(|c| crate::db::chat::search_messages(c, &query, limit))
                .map_err(|e| e.to_string())?)))
        }
        "list_chats" => {
            let project_id = args
                .get("project_id")
                .and_then(Value::as_str)
                .map(String::from);
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(30)
                .clamp(1, 100) as usize;
            let mut sessions = db
                .with_conn(|c| crate::db::chat::list_sessions(c, project_id.as_deref()))
                .map_err(|e| e.to_string())?;
            sessions.truncate(limit);
            Ok(text_result(json!(sessions)))
        }
        "get_chat" => {
            let id = args.get("id").and_then(Value::as_str).ok_or("id is required")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .clamp(1, 500) as u32;
            let messages = db
                .with_conn(|c| crate::db::chat::load_messages(c, id, limit))
                .map_err(|e| e.to_string())?;
            Ok(text_result(json!({"session_id": id, "messages": messages})))
        }
        "list_people" => Ok(text_result(json!(db
            .with_conn(crate::db::meeting_intelligence::list_people)
            .map_err(|e| e.to_string())?))),
        "list_companies" => Ok(text_result(json!(db
            .with_conn(crate::db::meeting_intelligence::list_companies)
            .map_err(|e| e.to_string())?))),
        "list_recipes" => Ok(text_result(json!(db
            .with_conn(crate::db::meeting_intelligence::list_recipes)
            .map_err(|e| e.to_string())?))),
        #[cfg(target_os = "macos")]
        "list_recording_sources" => bridge_call("list_sources", json!({})).map(text_result),
        #[cfg(target_os = "macos")]
        "start_recording" => bridge_call("start_recording", args.clone()).map(text_result),
        #[cfg(target_os = "macos")]
        "stop_recording" => bridge_call("stop_recording", json!({})).map(text_result),
        #[cfg(target_os = "macos")]
        "get_recording_status" => bridge_call("status", json!({})).map(text_result),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}

pub fn run_stdio() -> Result<(), String> {
    let db = match std::env::var_os("ECHO_SCRIBE_MCP_DB") {
        Some(path) => Db::open_at(std::path::Path::new(&path)).map_err(|e| e.to_string())?,
        None => Db::open_default().map_err(|e| e.to_string())?,
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                writeln!(
                    stdout,
                    "{}",
                    error_response(Value::Null, -32700, error.to_string())
                )
                .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if id.is_none() {
            continue;
        }
        let id = id.unwrap_or(Value::Null);
        let result = match method {
            "initialize" => response(
                id,
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"echo-scribe","version":env!("CARGO_PKG_VERSION")}}),
            ),
            "ping" => response(id, json!({})),
            "tools/list" => response(id, json!({"tools":tool_definitions()})),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match call_tool(&db, name, &args) {
                    Ok(value) => response(id, value),
                    Err(error) => response(
                        id,
                        json!({"content":[{"type":"text","text":error}],"isError":true}),
                    ),
                }
            }
            _ => error_response(id, -32601, format!("method not found: {method}")),
        };
        writeln!(stdout, "{result}").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tools_have_schemas_and_no_mutating_db_tools() {
        let tools = tool_definitions();
        let expected = if cfg!(target_os = "macos") { 15 } else { 11 };
        assert_eq!(tools.len(), expected);
        assert!(tools.iter().all(|tool| tool.get("inputSchema").is_some()));
        // The DB-backed tools stay read-only; the only side-effectful tools
        // are the explicitly named recording ones.
        assert!(tools
            .iter()
            .all(|tool| !tool["name"].as_str().unwrap().contains("update")));
    }

    #[test]
    fn every_tool_maps_to_a_permission_category() {
        for tool in tool_definitions() {
            let name = tool["name"].as_str().unwrap();
            assert!(
                crate::mcp_permissions::tool_permission(name).is_some(),
                "{name} has no permission category — add it to mcp_permissions::tool_permission"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recording_tools_mention_the_opt_in_requirement() {
        for tool in recording_tool_definitions() {
            let name = tool["name"].as_str().unwrap();
            if name.starts_with("list_recording") || name.starts_with("start_recording") {
                let desc = tool["description"].as_str().unwrap();
                assert!(
                    desc.contains("Coding Agents"),
                    "{name} should tell agents where the opt-in lives"
                );
            }
        }
    }
}
