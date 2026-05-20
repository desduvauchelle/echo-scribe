use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Manager};
use tracing::{debug, info, warn};
use url::form_urlencoded;

use crate::commands::AppState;
use crate::llm::{GenerateRequest, LlmError, LlmGenerator};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionCommand {
    pub is_action: bool,
    pub action_type: Option<String>, // "launch_app" | "draft_email" | "open_url" | "increment_counter" | "reset_counter" | "show_counter"
    pub app_name: Option<String>,
    pub email_to: Option<String>,
    pub email_subject: Option<String>,
    pub email_body: Option<String>,
    pub url: Option<String>,
    pub confidence: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum ActionError {
    #[error("llm error: {0}")]
    Llm(#[from] LlmError),
    #[error("json parsing failed: {0}")]
    Parse(String),
    #[error("execution failed: {0}")]
    Execute(String),
    #[error("settings error: {0}")]
    Settings(String),
}

const ACTION_SYSTEM_PROMPT: &str = "\
You are Echo Scribe's system action classifier.
Analyze the user's voice dictation and classify if it represents a system action/command.
Respond ONLY with a single JSON object matching this schema:
{
  \"is_action\": true | false,
  \"action_type\": \"launch_app\" | \"draft_email\" | \"open_url\" | \"increment_counter\" | \"reset_counter\" | \"show_counter\" | null,
  \"app_name\": \"<name of app to launch or null>\",
  \"email_to\": \"<recipient name or email address or null>\",
  \"email_subject\": \"<subject line or null>\",
  \"email_body\": \"<body content or null>\",
  \"url\": \"<url to open or null>\",
  \"confidence\": <float between 0.0 and 1.0>
}

Common templates:
- Launch app: 'open Slack', 'launch Safari', 'open Growthinator', 'launch LiveCase'. action_type: 'launch_app'
- Draft email: 'email denis about Growthinator saying tests passed', 'email John about meeting saying I will be there'. action_type: 'draft_email'
- Open URL: 'open google', 'go to github.com', 'open website echo-scribe.com'. action_type: 'open_url'
- Increment counter: 'increment counter', 'add one to counter', 'add to count'. action_type: 'increment_counter'
- Reset counter: 'reset counter', 'clear count', 'reset action count'. action_type: 'reset_counter'
- Show counter: 'show counter', 'how many actions', 'what is the count'. action_type: 'show_counter'

Rules:
- If the user's transcript matches any of these command intents, set is_action to true, appropriate action_type, extract details, and set confidence high (e.g. >= 0.85).
- If it's just regular dictation (like a note, task, diary thoughts, or description), set is_action to false and all other fields to null.
- Respond ONLY with the raw JSON object. No surrounding markdown, no backticks, no prose.";

/// Detect if the spoken transcript represents a system command action
pub async fn detect_action<L: LlmGenerator + ?Sized>(
    llm: &L,
    transcript: &str,
) -> Result<ActionCommand, ActionError> {
    let req = GenerateRequest {
        system: Some(ACTION_SYSTEM_PROMPT.to_string()),
        user: transcript.to_string(),
        history: Vec::new(),
        max_tokens: 256,
        temperature: 0.1,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
        n_ctx: Some(2048), // Dynamic context optimization: lean 2048 context window for speed
    };

    let raw = llm.generate(req.clone()).await?;
    debug!(raw = %raw, "action classifier raw output");

    let parsed = match parse_raw_action(&raw) {
        Ok(cmd) => cmd,
        Err(e) => {
            warn!(?e, "action first-pass parse failed; retrying with stricter prompt");
            let mut req_retry = req;
            req_retry.user = format!(
                "{transcript}\n\n(Your previous response failed to parse: {e}. \
                 Respond ONLY with a single JSON object matching the action schema. \
                 No prose, no code fences.)"
            );
            let raw2 = llm.generate(req_retry).await?;
            parse_raw_action(&raw2).map_err(|e2| {
                ActionError::Parse(format!("primary: {e}; retry: {e2}"))
            })?
        }
    };

    Ok(parsed)
}

fn parse_raw_action(raw: &str) -> Result<ActionCommand, String> {
    let start = raw.find('{').ok_or_else(|| "no '{' in output".to_string())?;
    let end = raw.rfind('}').ok_or_else(|| "no '}' in output".to_string())?;
    if end <= start {
        return Err(format!("malformed braces: start={start} end={end}"));
    }
    let slice = &raw[start..=end];
    serde_json::from_str::<ActionCommand>(slice).map_err(|e| e.to_string())
}

/// Execute a classified action on macOS on behalf of the user
pub fn execute_action(app: &AppHandle, cmd: &ActionCommand) -> Result<String, ActionError> {
    let action_type = cmd.action_type.as_deref().unwrap_or("");
    info!(action_type, "executing voice action command");

    match action_type {
        "launch_app" => {
            let app_name = cmd.app_name.as_deref().ok_or_else(|| {
                ActionError::Execute("launch_app missing app_name".to_string())
            })?;
            
            // On macOS, `open -a` is standard, robust, and handles spaces perfectly.
            let status = Command::new("open")
                .arg("-a")
                .arg(app_name)
                .status()
                .map_err(|e| ActionError::Execute(e.to_string()))?;

            if !status.success() {
                return Err(ActionError::Execute(format!(
                    "Failed to launch app '{}'. Check if it is installed.",
                    app_name
                )));
            }

            // Increment action stats
            increment_stats(app)?;

            Ok(format!("Launched application '{}'", app_name))
        }
        "draft_email" => {
            let to = cmd.email_to.as_deref().unwrap_or("");
            let subject = cmd.email_subject.as_deref().unwrap_or("");
            let body = cmd.email_body.as_deref().unwrap_or("");

            // URL encode headers for mailto URL
            let encoded_subject: String = form_urlencoded::byte_serialize(subject.as_bytes()).collect();
            let encoded_body: String = form_urlencoded::byte_serialize(body.as_bytes()).collect();
            
            let mailto_url = format!(
                "mailto:{}?subject={}&body={}",
                to, encoded_subject, encoded_body
            );

            let status = Command::new("open")
                .arg(&mailto_url)
                .status()
                .map_err(|e| ActionError::Execute(e.to_string()))?;

            if !status.success() {
                return Err(ActionError::Execute("Failed to open mail client draft".to_string()));
            }

            increment_stats(app)?;

            Ok(format!(
                "Drafted email to '{}' with subject '{}'",
                if to.is_empty() { "default recipient" } else { to },
                if subject.is_empty() { "no subject" } else { subject }
            ))
        }
        "open_url" => {
            let raw_url = cmd.url.as_deref().ok_or_else(|| {
                ActionError::Execute("open_url missing url parameter".to_string())
            })?;

            // Simple sanitization: prepends https:// if schema is missing
            let mut sanitized_url = raw_url.to_string();
            if !sanitized_url.starts_with("http://") && !sanitized_url.starts_with("https://") && !sanitized_url.starts_with("mailto:") {
                sanitized_url = format!("https://{}", sanitized_url);
            }

            let status = Command::new("open")
                .arg(&sanitized_url)
                .status()
                .map_err(|e| ActionError::Execute(e.to_string()))?;

            if !status.success() {
                return Err(ActionError::Execute(format!("Failed to open URL '{}'", sanitized_url)));
            }

            increment_stats(app)?;

            Ok(format!("Opened URL '{}'", sanitized_url))
        }
        "increment_counter" => {
            let app_state = app.try_state::<AppState>().ok_or_else(|| {
                ActionError::Settings("app state unavailable".to_string())
            })?;
            let next_val = app_state
                .settings
                .increment_action_counter()
                .map_err(|e| ActionError::Settings(e.to_string()))?;

            Ok(format!("Incremented action counter. Current count: {}", next_val))
        }
        "reset_counter" => {
            let app_state = app.try_state::<AppState>().ok_or_else(|| {
                ActionError::Settings("app state unavailable".to_string())
            })?;
            app_state
                .settings
                .set_action_counter(0)
                .map_err(|e| ActionError::Settings(e.to_string()))?;

            Ok("Action counter has been reset to 0".to_string())
        }
        "show_counter" => {
            let app_state = app.try_state::<AppState>().ok_or_else(|| {
                ActionError::Settings("app state unavailable".to_string())
            })?;
            let count = app_state.settings.action_counter();

            Ok(format!("The current action counter value is {}", count))
        }
        _ => Err(ActionError::Execute(format!(
            "Unsupported or unrecognized action type: '{}'",
            action_type
        ))),
    }
}

fn increment_stats(app: &AppHandle) -> Result<(), ActionError> {
    if let Some(app_state) = app.try_state::<AppState>() {
        app_state
            .settings
            .increment_action_counter()
            .map_err(|e| ActionError::Settings(e.to_string()))?;
    }
    Ok(())
}
