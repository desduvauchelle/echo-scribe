//! Read-only Model Context Protocol server exposed by launching the installed
//! EchoScribe executable with `--mcp`. It uses newline-delimited JSON-RPC over
//! stdio, never exposes a raw SQL primitive, and records tool names (not
//! returned content) in the local diagnostics log.

use crate::db::Db;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn audit(tool: &str) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join("Library/Logs/EchoScribe");
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

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({"name":"search_echoscribe","description":"Search recent local EchoScribe captures by text.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["query"]}}),
        json!({"name":"list_meetings","description":"List recent local meetings and their current summaries.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}}),
        json!({"name":"get_meeting","description":"Read one meeting, including transcript, summary, notes and confirmed speaker labels.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}),
        json!({"name":"list_projects","description":"List active local EchoScribe projects.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"list_tasks","description":"List open local tasks, optionally scoped to a project.","inputSchema":{"type":"object","properties":{"project_id":{"type":"string"}}}}),
        json!({"name":"list_people","description":"List confirmed local relationship records.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"list_companies","description":"List confirmed local company records.","inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"list_recipes","description":"List reusable local meeting Recipes.","inputSchema":{"type":"object","properties":{}}}),
    ]
}

fn call_tool(db: &Db, name: &str, args: &Value) -> Result<Value, String> {
    audit(name);
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
        "list_people" => Ok(text_result(json!(db
            .with_conn(crate::db::meeting_intelligence::list_people)
            .map_err(|e| e.to_string())?))),
        "list_companies" => Ok(text_result(json!(db
            .with_conn(crate::db::meeting_intelligence::list_companies)
            .map_err(|e| e.to_string())?))),
        "list_recipes" => Ok(text_result(json!(db
            .with_conn(crate::db::meeting_intelligence::list_recipes)
            .map_err(|e| e.to_string())?))),
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
    fn tools_are_read_only_and_have_schemas() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 8);
        assert!(tools.iter().all(|tool| tool.get("inputSchema").is_some()));
        assert!(tools
            .iter()
            .all(|tool| !tool["name"].as_str().unwrap().contains("update")));
    }
}
