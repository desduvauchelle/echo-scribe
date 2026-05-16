//! Calendar event matching via the `echo-scribe-calmatch` Swift sidecar.
//!
//! At meeting start (and again at stop) we ask the sidecar to find the
//! calendar event most likely to correspond to the recording window. The
//! result is folded into the synthesis prompt so the LLM can name
//! participants and reference the meeting topic.
//!
//! The sidecar is a one-shot binary: each call is `spawn → stdout JSON →
//! exit`. We bound the wait with a hard deadline so a misbehaving sidecar
//! never blocks meeting capture.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tracing::{info, warn};

/// One participant on a calendar event (organizer or attendee).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Attendee {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default, rename = "self")]
    pub self_: bool,
    #[serde(default)]
    pub role: Option<String>,
}

/// Snapshot of a matched calendar event. The shape mirrors the sidecar's
/// stdout JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarMatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub organizer: Option<Attendee>,
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    pub starts_at: String,
    pub ends_at: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub calendar_name: Option<String>,
    #[serde(default)]
    pub conferencing_url: Option<String>,
    pub match_score: f64,
    pub match_reason: String,
}

/// Wire shape of the sidecar's stdout: a single JSON object.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MatchResponse {
    #[serde(default)]
    pub r#match: Option<CalendarMatch>,
    #[serde(default)]
    pub candidates: Vec<CalendarMatch>,
}

/// Result of a match query: best pick + a few ranked candidates the UI can
/// surface as "Wrong match?" alternatives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchOutcome {
    pub best: CalendarMatch,
    pub candidates: Vec<CalendarMatch>,
}

/// Threshold below which we discard matches entirely. Below this score the
/// signal is too weak to be useful — usually means the only overlapping
/// event was a blocked-off "Focus Time" slot or similar.
pub const MIN_MATCH_SCORE: f64 = 0.3;

/// Above this score we treat the match as confidently right; below it we
/// prefix the synthesis prompt with "(low confidence)" so the LLM knows
/// to lean on the transcript more than the calendar.
pub const HIGH_CONFIDENCE_SCORE: f64 = 0.6;

/// Hard cap on how long we wait for the sidecar. The sidecar reads no
/// stdin in match mode, just argv — so this is end-to-end EventKit query
/// budget, not network or IPC time. 2 s is generous for a local DB
/// lookup on a reasonable calendar.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum CalendarError {
    #[error("sidecar binary not found")]
    BinaryNotFound,
    #[error("sidecar spawn failed: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("sidecar timed out after {0:?}")]
    Timeout(Duration),
    #[error("sidecar exited with code {0}")]
    BadExit(i32),
    #[error("invalid sidecar response: {0}")]
    BadResponse(String),
}

/// Resolve the bundled sidecar path inside the .app, or the dev build
/// location. Mirrors `syscap::Syscap::resolve_binary` so a developer's
/// `cargo run` picks up the script-built binary.
fn resolve_binary() -> Result<PathBuf, CalendarError> {
    let triple = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(format!("echo-scribe-calmatch-{}", triple));
            if candidate.exists() {
                return Ok(candidate);
            }
            let no_suffix = parent.join("echo-scribe-calmatch");
            if no_suffix.exists() {
                return Ok(no_suffix);
            }
        }
    }
    // Dev fallback: built by scripts/build-calmatch.sh.
    if let Ok(cwd) = std::env::current_dir() {
        let dev = cwd
            .join("src-tauri/binaries")
            .join(format!("echo-scribe-calmatch-{}", triple));
        if dev.exists() {
            return Ok(dev);
        }
    }
    Err(CalendarError::BinaryNotFound)
}

/// Spawn the sidecar in `--probe` mode and return the authorization label
/// it reports. Never prompts. Returns `None` on any failure.
pub async fn probe_authorization() -> Option<String> {
    let bin = resolve_binary().ok()?;
    let output = tokio::time::timeout(
        SIDECAR_TIMEOUT,
        Command::new(&bin)
            .arg("--probe")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(s.trim()).ok()?;
    v.get("authorization")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Synchronous variant of [`probe_authorization`] for the
/// `permissions::status()` path which the frontend polls. Blocks the
/// calling thread for up to ~500 ms while the sidecar runs. Returns
/// `None` when the sidecar isn't installed (dev build before first
/// release) or the call errors.
pub fn probe_authorization_sync() -> Option<String> {
    let bin = resolve_binary().ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new(&bin)
            .arg("--probe")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .output();
        let _ = tx.send(result);
    });
    let output = rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(s.trim()).ok()?;
    v.get("authorization")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// True when calendar access has been granted at a level that lets us
/// read attendees (macOS 14 `fullAccess` or macOS 13 `authorized`).
pub async fn is_authorized() -> bool {
    // The sidecar emits "full_access" on macOS 14+, "authorized" on older
    // releases. Either represents the read-with-attendees grant we need.
    matches!(
        probe_authorization().await.as_deref(),
        Some("full_access") | Some("authorized")
    )
}

/// Synchronous variant of [`is_authorized`] for sync callers.
pub fn is_authorized_sync() -> bool {
    matches!(
        probe_authorization_sync().as_deref(),
        Some("full_access") | Some("authorized")
    )
}

/// Trigger the system Calendar prompt. Spawns the sidecar with
/// `--request-access`, which calls `requestFullAccessToEvents` and exits 0
/// on grant, 1 on deny.
pub async fn prompt_access() -> bool {
    let Ok(bin) = resolve_binary() else { return false };
    let output = match Command::new(&bin)
        .arg("--request-access")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            warn!(?e, "calmatch --request-access spawn failed");
            return false;
        }
    };
    output.status.success()
}

/// Run a one-shot match query. Returns the best match above
/// [`MIN_MATCH_SCORE`] plus next-ranked candidates, or `None` when
/// nothing useful overlaps the window.
pub async fn match_meeting(
    iso_start: &str,
    iso_end: &str,
    conf_hint: Option<&str>,
) -> Result<Option<MatchOutcome>, CalendarError> {
    let bin = resolve_binary()?;
    let mut cmd = Command::new(&bin);
    cmd.arg("match").arg(iso_start).arg(iso_end);
    if let Some(hint) = conf_hint.filter(|s| !s.is_empty()) {
        cmd.arg(hint);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = cmd.spawn()?;
    let mut stdout = child.stdout.take().expect("stdout piped");

    // Read stdout in parallel with the wait — if the sidecar misbehaves
    // and produces no output, the timeout fires either way.
    let read_fut = async {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    };

    let wait_fut = async {
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(status)
    };

    let combined = async {
        let (buf, status) = tokio::join!(read_fut, wait_fut);
        let status = status.map_err(CalendarError::Spawn)?;
        Ok::<_, CalendarError>((buf, status))
    };

    let (buf, status) = match tokio::time::timeout(SIDECAR_TIMEOUT, combined).await {
        Ok(r) => r?,
        Err(_) => {
            // Best-effort kill. ignore errors.
            let _ = Command::new("kill")
                .arg("-9")
                .arg(format!("{}", std::process::id()))
                .output()
                .await;
            return Err(CalendarError::Timeout(SIDECAR_TIMEOUT));
        }
    };

    if !status.success() {
        return Err(CalendarError::BadExit(status.code().unwrap_or(-1)));
    }

    let stdout_str = String::from_utf8_lossy(&buf);
    let trimmed = stdout_str.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let resp: MatchResponse = serde_json::from_str(trimmed)
        .map_err(|e| CalendarError::BadResponse(format!("{e}: {trimmed}")))?;

    let Some(best) = resp.r#match else { return Ok(None) };
    if best.match_score < MIN_MATCH_SCORE {
        info!(score = best.match_score, "calendar match below threshold; ignoring");
        return Ok(None);
    }

    Ok(Some(MatchOutcome {
        best,
        candidates: resp.candidates,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event_json() -> &'static str {
        r#"{
            "match": {
                "title": "Weekly Standup",
                "organizer": {"name": "Alice", "email": "alice@acme.com", "self": false, "role": "chair"},
                "attendees": [
                    {"name": "Bob", "email": "bob@acme.com", "self": false, "role": "required"},
                    {"name": "Carol", "email": "carol@acme.com", "self": true, "role": "required"}
                ],
                "starts_at": "2026-05-15T16:00:00Z",
                "ends_at": "2026-05-15T16:30:00Z",
                "notes": "Status updates.",
                "calendar_name": "Work",
                "conferencing_url": "https://zoom.us/j/123456789",
                "match_score": 0.92,
                "match_reason": "overlap+conf_url"
            },
            "candidates": []
        }"#
    }

    #[test]
    fn match_response_deserializes_full_payload() {
        let resp: MatchResponse = serde_json::from_str(sample_event_json()).unwrap();
        let m = resp.r#match.unwrap();
        assert_eq!(m.title.as_deref(), Some("Weekly Standup"));
        assert_eq!(m.attendees.len(), 2);
        assert!(m.attendees[1].self_);
        assert_eq!(m.organizer.as_ref().unwrap().email.as_deref(), Some("alice@acme.com"));
        assert!((m.match_score - 0.92).abs() < 1e-9);
        assert_eq!(m.match_reason, "overlap+conf_url");
    }

    #[test]
    fn match_response_handles_null_match() {
        let payload = r#"{"match": null, "candidates": []}"#;
        let resp: MatchResponse = serde_json::from_str(payload).unwrap();
        assert!(resp.r#match.is_none());
    }

    #[test]
    fn match_response_handles_missing_optionals() {
        // Minimal valid payload (only required fields). Missing organizer,
        // notes, conferencing_url; empty attendees.
        let payload = r#"{
            "match": {
                "attendees": [],
                "starts_at": "2026-05-15T16:00:00Z",
                "ends_at":   "2026-05-15T16:30:00Z",
                "match_score": 0.45,
                "match_reason": "overlap"
            },
            "candidates": []
        }"#;
        let resp: MatchResponse = serde_json::from_str(payload).unwrap();
        let m = resp.r#match.unwrap();
        assert!(m.title.is_none());
        assert!(m.organizer.is_none());
        assert!(m.notes.is_none());
        assert!(m.conferencing_url.is_none());
    }

    #[test]
    fn calendar_match_round_trips_through_serde() {
        // The DB stores this as JSON text; if it doesn't round-trip we'd
        // silently lose fields on read.
        let resp: MatchResponse = serde_json::from_str(sample_event_json()).unwrap();
        let m = resp.r#match.unwrap();
        let serialized = serde_json::to_string(&m).unwrap();
        let back: CalendarMatch = serde_json::from_str(&serialized).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn min_score_threshold_is_documented_constant() {
        // Guard against accidental tweaks that would change observable
        // behavior in production.
        assert!((MIN_MATCH_SCORE - 0.3).abs() < 1e-9);
        assert!((HIGH_CONFIDENCE_SCORE - 0.6).abs() < 1e-9);
    }
}
