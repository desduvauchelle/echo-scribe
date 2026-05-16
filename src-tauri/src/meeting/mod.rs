//! Meeting capture: passive recording of mic + system audio during calls,
//! chunked transcription via Parakeet, and LLM synthesis of summary + tasks.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod detector;
pub mod grammar;
pub mod pipeline;
pub mod recorder;
pub mod syscap;
pub mod synthesizer;
pub mod url_allowlist;

/// Which audio stream a transcript segment came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    /// User's mic input.
    You,
    /// Other side, captured via ScreenCaptureKit.
    Them,
}

/// One transcribed chunk, projected onto the meeting's wall-clock timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub speaker: Speaker,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Lifecycle state of a meeting (mirrors the `meetings.status` column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeetingStatus {
    Recording,
    Transcribing,
    Summarizing,
    Complete,
    Failed,
    Recovered,
}

impl MeetingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recording => "recording",
            Self::Transcribing => "transcribing",
            Self::Summarizing => "summarizing",
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::Recovered => "recovered",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "recording" => Self::Recording,
            "transcribing" => Self::Transcribing,
            "summarizing" => Self::Summarizing,
            "complete" => Self::Complete,
            "failed" => Self::Failed,
            "recovered" => Self::Recovered,
            _ => return None,
        })
    }
}

/// A finalized chunk WAV file, ready for transcription.
#[derive(Debug, Clone)]
pub struct ChunkReady {
    pub speaker: Speaker,
    pub path: PathBuf,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Errors that can surface from any meeting subsystem.
#[derive(Debug, thiserror::Error)]
pub enum MeetingError {
    #[error("meeting already in progress")]
    AlreadyRecording,
    #[error("no meeting in progress")]
    NotRecording,
    #[error("ASR not ready")]
    AsrNotReady,
    #[error("audio: {0}")]
    Audio(String),
    #[error("syscap: {0}")]
    Syscap(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("db: {0}")]
    Db(String),
}

use std::sync::Arc;
use tauri::Emitter;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

use crate::asr::pipeline::AsrPipeline;
use crate::db::Db;
use crate::llm::Llm;
use crate::meeting::pipeline::Pipeline;
use crate::meeting::recorder::Recorder;
use crate::meeting::synthesizer::StoredSummary;

/// Cooldown after a meeting stops during which the auto-detector must not
/// auto-start a new meeting. Prevents the detector from racing in while the
/// previous meeting is still synthesizing (state is cleared early in `stop()`).
const POST_STOP_COOLDOWN_MS: u64 = 60_000;

/// Public lifecycle manager. One per app process. Holds the active meeting (if any)
/// and orchestrates record → transcribe → synthesize → persist.
pub struct MeetingManager {
    pub asr: Arc<AsrPipeline>,
    pub llm: Arc<Llm>,
    pub db: Db,
    pub data_dir: std::path::PathBuf,
    pub app_handle: tauri::AppHandle,
    state: AsyncMutex<Option<ActiveMeeting>>,
    /// Wall-clock millis (UTC) when the most recent `stop()` cleared `state`.
    /// Detector consults `in_cooldown()` to avoid auto-restarting immediately.
    last_stopped_at_ms: AtomicU64,
}

struct ActiveMeeting {
    item_id: String,
    started_at: String,
    started_at_ms: u64,
    detected_app: Option<String>,
    detected_app_name: Option<String>,
    /// Frontmost window title at meeting-start time. For Zoom/Teams this often
    /// contains the meeting topic (e.g. "Weekly Standup - Zoom Meeting").
    start_window_title: Option<String>,
    /// Browser URL at meeting-start time for browser-based meetings
    /// (Google Meet, Zoom Web, WebEx, etc.).
    start_browser_url: Option<String>,
    /// Active tab title at meeting-start time. Often includes participant
    /// hints for Google Meet ("Meeting – Alice, Bob").
    start_browser_tab_title: Option<String>,
    /// Calendar event we matched at start time. Refined at stop time when we
    /// know the actual end timestamp.
    calendar_match: Option<crate::calendar::CalendarMatch>,
    recorder: Recorder,
    chunk_drain_handle: tokio::task::JoinHandle<()>,
    pipeline: Option<Pipeline>,
}

/// Optional context captured at meeting-start time, fed into the synthesis
/// prompt to give the LLM hints about topic and participants.
#[derive(Debug, Clone, Default)]
pub struct MeetingStartContext {
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    pub browser_tab_title: Option<String>,
    pub calendar_match: Option<crate::calendar::CalendarMatch>,
}

impl MeetingManager {
    pub fn new(
        asr: Arc<AsrPipeline>,
        llm: Arc<Llm>,
        db: Db,
        data_dir: std::path::PathBuf,
        app_handle: tauri::AppHandle,
    ) -> Arc<Self> {
        Arc::new(Self {
            asr,
            llm,
            db,
            data_dir,
            app_handle,
            state: AsyncMutex::new(None),
            last_stopped_at_ms: AtomicU64::new(0),
        })
    }

    pub async fn is_active(&self) -> bool {
        self.state.lock().await.is_some()
    }

    /// True while the post-stop cooldown is in effect. The auto-detector should
    /// skip auto-starting during this window.
    pub fn in_cooldown(&self) -> bool {
        let stopped = self.last_stopped_at_ms.load(Ordering::Relaxed);
        if stopped == 0 {
            return false;
        }
        let now = chrono::Utc::now().timestamp_millis() as u64;
        now.saturating_sub(stopped) < POST_STOP_COOLDOWN_MS
    }

    pub async fn active_id(&self) -> Option<String> {
        self.state.lock().await.as_ref().map(|a| a.item_id.clone())
    }

    pub async fn start(
        self: Arc<Self>,
        detected_app: Option<String>,
        detected_app_name: Option<String>,
        start_context: MeetingStartContext,
    ) -> Result<String, MeetingError> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Err(MeetingError::AlreadyRecording);
        }
        if !self.asr.ready() {
            return Err(MeetingError::AsrNotReady);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let started_at = now.to_rfc3339();
        let started_at_ms = now.timestamp_millis() as u64;
        let dir = self.data_dir.join("meetings").join(&id);

        let id_for_db = id.clone();
        let started_for_db = started_at.clone();
        let detected_app_for_db = detected_app.clone();
        let detected_app_name_for_db = detected_app_name.clone();
        let title = detected_app_name_for_db
            .clone()
            .map(|n| format!("Meeting with {n}"))
            .unwrap_or_else(|| "Untitled meeting".into());
        self.db
            .with_conn(move |conn| {
                conn.execute(
                    "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
                     VALUES (?1, ?2, 'meeting', 'visible', 'meeting', ?3, ?3)",
                    rusqlite::params![id_for_db, title, started_for_db],
                )?;
                crate::db::meetings::insert_meeting(
                    conn,
                    &crate::db::meetings::MeetingRow {
                        item_id: id_for_db.clone(),
                        started_at: started_for_db,
                        ended_at: None,
                        duration_ms: None,
                        detected_app: detected_app_for_db,
                        detected_app_name: detected_app_name_for_db,
                        status: "recording".into(),
                        transcript_json: None,
                        summary_json: None,
                        user_notes: None,
                        failed_chunk_count: 0,
                        mic_only: false,
                        calendar_match_json: None,
                    },
                )?;
                Ok(())
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;

        let (chunk_tx, chunk_rx) = mpsc::unbounded_channel();
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel();
        let recorder = Recorder::start(id.clone(), dir.clone(), chunk_tx, evt_tx).await?;

        let id_for_evt = id.clone();
        tokio::spawn(async move {
            let mut heartbeat_count: u32 = 0;
            while let Some(evt) = evt_rx.recv().await {
                match evt {
                    syscap::SyscapEvent::Error { kind, msg } => {
                        tracing::error!(meeting = %id_for_evt, %kind, %msg, "syscap error");
                    }
                    syscap::SyscapEvent::Warn(msg) => {
                        tracing::warn!(meeting = %id_for_evt, %msg, "syscap warn");
                    }
                    syscap::SyscapEvent::Ready => {
                        tracing::info!(meeting = %id_for_evt, "syscap ready (SCStream started)");
                    }
                    syscap::SyscapEvent::Heartbeat { ts } => {
                        heartbeat_count = heartbeat_count.saturating_add(1);
                        // Log first heartbeat and every 30th after (so we see liveness without spam).
                        if heartbeat_count == 1 || heartbeat_count % 30 == 0 {
                            tracing::info!(
                                meeting = %id_for_evt,
                                count = heartbeat_count,
                                ts,
                                "syscap heartbeat"
                            );
                        }
                    }
                    syscap::SyscapEvent::Exited(code) => {
                        tracing::warn!(meeting = %id_for_evt, code, "syscap exited");
                    }
                }
            }
        });

        let pipeline = Pipeline::new(self.asr.clone(), dir.join("failed"));
        let chunk_drain_handle = pipeline.spawn_drain(chunk_rx);

        let _ = self.app_handle.emit(
            "meeting-started",
            serde_json::json!({
                "id": id,
                "detected_app_name": detected_app_name,
            }),
        );
        crate::overlay::show_meeting_overlay(&self.app_handle, detected_app_name.as_deref());

        // Soft-warn timer (emit event after N minutes).
        let app_handle_warn = self.app_handle.clone();
        let id_for_warn = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(120 * 60)).await;
            let _ = app_handle_warn
                .emit("meeting-soft-warn", serde_json::json!({"id": id_for_warn}));
        });

        // Hard-cap timer (auto-stop after N minutes).
        let manager_weak = Arc::downgrade(&self);
        let id_for_cap = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(240 * 60)).await;
            if let Some(mgr) = manager_weak.upgrade() {
                let active_id = mgr.active_id().await;
                if active_id.as_deref() == Some(&id_for_cap) {
                    tracing::warn!(id = %id_for_cap, "hard cap reached, auto-stopping");
                    let _ = mgr.stop().await;
                }
            }
        });

        // Calendar match: best-effort. We probe a wide window (now → now+30m)
        // because the actual end time isn't known yet; the score-based match
        // is refined at stop() with the real end. If the start-time match
        // came from the caller (e.g. the consent overlay already had one),
        // prefer that. Otherwise spawn the sidecar and store whatever it
        // returns. Permission failure / sidecar miss → no match, no crash.
        let mut calendar_match = start_context.calendar_match.clone();
        if calendar_match.is_none() {
            calendar_match =
                resolve_calendar_match(&started_at, 30 * 60, start_context.browser_url.as_deref())
                    .await;
        }
        // Persist on the DB row so retry_summary / UI can read it before
        // stop() runs. None remains None (cleared column).
        let initial_match_json = calendar_match
            .as_ref()
            .and_then(|m| serde_json::to_string(m).ok());
        if initial_match_json.is_some() {
            let id_for_match = id.clone();
            let json_for_db = initial_match_json.clone();
            if let Err(e) = self.db.with_conn(move |conn| {
                crate::db::meetings::update_calendar_match(
                    conn,
                    &id_for_match,
                    json_for_db.as_deref(),
                )
            }) {
                tracing::warn!(?e, "persisting start-time calendar match failed");
            }
        }

        *guard = Some(ActiveMeeting {
            item_id: id.clone(),
            started_at,
            started_at_ms,
            detected_app,
            detected_app_name,
            start_window_title: start_context.window_title,
            start_browser_url: start_context.browser_url,
            start_browser_tab_title: start_context.browser_tab_title,
            calendar_match,
            recorder,
            chunk_drain_handle,
            pipeline: Some(pipeline),
        });
        Ok(id)
    }

    pub async fn stop(&self) -> Result<String, MeetingError> {
        let mut guard = self.state.lock().await;
        let Some(mut active) = guard.take() else {
            return Err(MeetingError::NotRecording);
        };
        // Stamp the cooldown the moment state is cleared, so the auto-detector
        // can't race in while synthesis is still running below.
        self.last_stopped_at_ms.store(
            chrono::Utc::now().timestamp_millis() as u64,
            Ordering::Relaxed,
        );
        drop(guard);

        // Step 1: Stop recording.
        active.recorder.stop().await?;
        // Capture fields we need later before dropping the recorder.
        let mic_only = active.recorder.mic_only;
        // Drop the recorder so its ChunkedWavWriter senders are released, closing the chunk
        // channel and allowing the pipeline drain task to exit its recv loop.
        drop(active.recorder);

        // Step 2: Flag UI state as "transcribing".
        let id = active.item_id.clone();
        let id_for_db = id.clone();
        self.db
            .with_conn(move |conn| {
                crate::db::meetings::update_status(conn, &id_for_db, MeetingStatus::Transcribing)
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;
        let _ = self.app_handle.emit(
            "meeting-status",
            serde_json::json!({"id": id, "status": "transcribing"}),
        );

        // Step 3: Wait for pipeline to drain (chunk channel is now closed — drain exits cleanly).
        let _ = active.chunk_drain_handle.await;

        // Step 4: Pull segments out of the pipeline.
        let pipeline = active.pipeline.take().expect("set in start");
        let (segments, failed) = pipeline.finalize().await;
        let failed_count = failed.len() as i64;

        // Step 5: Run synthesis.
        let _ = self.app_handle.emit(
            "meeting-status",
            serde_json::json!({"id": id, "status": "summarizing"}),
        );
        let id_db2 = id.clone();
        self.db
            .with_conn(move |conn| {
                crate::db::meetings::update_status(conn, &id_db2, MeetingStatus::Summarizing)
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;

        let now = chrono::Utc::now();
        let duration_ms = (now.timestamp_millis() as u64).saturating_sub(active.started_at_ms);

        // Fetch existing project names so the LLM can match against them.
        let existing_projects = self
            .db
            .with_conn(|conn| crate::db::projects::list_projects(conn, false))
            .unwrap_or_default();
        let project_names: Vec<String> = existing_projects.iter().map(|p| p.name.clone()).collect();

        // Refine the calendar match now that we know the actual end time.
        // Compare scores: keep whichever is higher. A second sidecar query
        // is cheap (one-shot EventKit lookup) and often promotes a "low
        // confidence" start-time match to a confident one when the recording
        // ends near the event's scheduled end.
        let refined_match = {
            let duration_secs = (duration_ms / 1000).max(1);
            let refined = resolve_calendar_match(
                &active.started_at,
                duration_secs,
                active.start_browser_url.as_deref(),
            )
            .await;
            match (active.calendar_match.clone(), refined) {
                (Some(start), Some(end)) => {
                    if end.match_score > start.match_score {
                        Some(end)
                    } else {
                        Some(start)
                    }
                }
                (None, Some(end)) => Some(end),
                (Some(start), None) => Some(start),
                (None, None) => None,
            }
        };
        // Persist refined match before synthesis so the row is correct even
        // if synthesis fails partway.
        let refined_json = refined_match
            .as_ref()
            .and_then(|m| serde_json::to_string(m).ok());
        if let Some(ref s) = refined_json {
            let id_for_match = id.clone();
            let s_owned = s.clone();
            if let Err(e) = self.db.with_conn(move |conn| {
                crate::db::meetings::update_calendar_match(
                    conn,
                    &id_for_match,
                    Some(s_owned.as_str()),
                )
            }) {
                tracing::warn!(?e, "persisting refined calendar match failed");
            }
        }

        let start_context = MeetingStartContext {
            window_title: active.start_window_title.clone(),
            browser_url: active.start_browser_url.clone(),
            browser_tab_title: active.start_browser_tab_title.clone(),
            calendar_match: refined_match.clone(),
        };
        let synthesis = synthesizer::synthesize(
            self.llm.clone(),
            &segments,
            active.detected_app_name.as_deref(),
            duration_ms,
            &project_names,
            &start_context,
        )
        .await;

        // Step 6: Build the transcript JSON, serialize summary, write to DB.
        let transcript_json = serde_json::json!({
            "segments": segments,
            "duration_ms": duration_ms,
            "asr_model": self.asr.active_model_id().unwrap_or_else(|| "unknown".into()),
            "chunk_seconds": 60,
            "failed_chunk_count": failed_count,
            "mic_only": mic_only,
        });
        let summary_json = match &synthesis {
            Ok(s) => Some(serde_json::to_string(s).unwrap_or_else(|_| "{}".into())),
            Err(e) => {
                tracing::error!(?e, "synthesis returned error");
                None
            }
        };

        // Step 7: Persist + flatten body for FTS, assign project/tags, and
        // create action-item tasks — all in a single atomic transaction so a
        // partial failure can't leave the meeting in an inconsistent state
        // (e.g. status = 'complete' but no project/tags assigned).
        let body = build_flattened_body(&segments, summary_json.as_deref(), None);
        let id_db3 = id.clone();
        let ended_at = now.to_rfc3339();
        let transcript_str = serde_json::to_string(&transcript_json).unwrap();
        let summary_for_db = summary_json.clone();
        let synthesis_for_db = synthesis.as_ref().ok().cloned();
        let existing_projects_clone = existing_projects.clone();
        self.db
            .with_conn(move |conn| {
                // Finalize meeting row (sets status = 'complete').
                crate::db::meetings::finalize_meeting(
                    conn,
                    &id_db3,
                    &ended_at,
                    duration_ms as i64,
                    &transcript_str,
                    summary_for_db.as_deref(),
                    failed_count,
                )?;
                // Update the items.content with the flattened body for FTS —
                // only touches `content`, never resets status or other fields.
                conn.execute(
                    "UPDATE items SET content = ?1 WHERE id = ?2",
                    rusqlite::params![body, id_db3],
                )?;

                // If synthesis succeeded, assign project/tags and create tasks.
                if let Some(s) = &synthesis_for_db {
                    let meeting_project_id = resolve_project_name(
                        conn,
                        s.project_name.as_deref(),
                        &existing_projects_clone,
                    )?;

                    if let Some(ref pid) = meeting_project_id {
                        conn.execute(
                            "UPDATE items SET project_id = ?1 WHERE id = ?2",
                            rusqlite::params![pid, id_db3],
                        )?;
                    }
                    if !s.tags.is_empty() {
                        crate::db::items::replace_tags(conn, &id_db3, &s.tags)?;
                    }

                    for action in &s.action_items {
                        let task_id = uuid::Uuid::new_v4().to_string();
                        let now_iso = chrono::Utc::now().to_rfc3339();

                        let task_project_id = if action.project_name.is_some() {
                            resolve_project_name(
                                conn,
                                action.project_name.as_deref(),
                                &existing_projects_clone,
                            )?
                        } else {
                            meeting_project_id.clone()
                        };

                        conn.execute(
                            "INSERT INTO items (id, content, source, visibility, kind, project_id, captured_at, created_at)
                             VALUES (?1, ?2, 'meeting', 'visible', 'task', ?3, ?4, ?4)",
                            rusqlite::params![task_id, action.text, task_project_id, now_iso],
                        )?;
                        conn.execute(
                            "INSERT INTO tasks (item_id, deadline, completed_at) VALUES (?1, NULL, NULL)",
                            rusqlite::params![task_id],
                        )?;
                        let task_tags = if action.tags.is_empty() {
                            &s.tags
                        } else {
                            &action.tags
                        };
                        if !task_tags.is_empty() {
                            crate::db::items::replace_tags(conn, &task_id, task_tags)?;
                        }
                        crate::db::meetings::link_action(conn, &id_db3, &task_id, &now_iso)?;
                    }
                }
                Ok(())
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;

        // Step 8: Emit "complete" event and hide the overlay.
        let _ = self.app_handle.emit(
            "meeting-complete",
            serde_json::json!({"id": id}),
        );
        crate::overlay::hide_recording_overlay(&self.app_handle);

        // Step 9: Best-effort cleanup of empty meeting dir if no failed chunks.
        if failed.is_empty() {
            let _ = std::fs::remove_dir_all(self.data_dir.join("meetings").join(&id));
        }

        Ok(id)
    }
}

impl MeetingManager {
    /// Re-run synthesis using the persisted transcript JSON. Used when the
    /// initial summary call failed (no llm) or returned malformed JSON.
    pub async fn retry_summary(&self, id: &str) -> Result<(), MeetingError> {
        let id_for_db = id.to_string();
        let row = self
            .db
            .with_conn(move |conn| crate::db::meetings::get_meeting(conn, &id_for_db))
            .map_err(|e| MeetingError::Db(e.to_string()))?
            .ok_or_else(|| MeetingError::Db("meeting not found".into()))?;

        let transcript: serde_json::Value = row
            .transcript_json
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(serde_json::json!({})))
            .unwrap_or(serde_json::json!({}));
        let segments: Vec<Segment> = serde_json::from_value(
            transcript
                .get("segments")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        )
        .unwrap_or_default();
        let duration_ms = transcript
            .get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let existing_projects = self
            .db
            .with_conn(|conn| crate::db::projects::list_projects(conn, false))
            .unwrap_or_default();
        let project_names: Vec<String> = existing_projects.iter().map(|p| p.name.clone()).collect();

        // Retry path: window/URL context wasn't persisted, but the
        // calendar match snapshot is — surface it back into the prompt so
        // attendees / topic don't disappear on retry.
        let persisted_match: Option<crate::calendar::CalendarMatch> = row
            .calendar_match_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());
        let retry_context = MeetingStartContext {
            calendar_match: persisted_match,
            ..Default::default()
        };
        let synthesis = synthesizer::synthesize(
            self.llm.clone(),
            &segments,
            row.detected_app_name.as_deref(),
            duration_ms,
            &project_names,
            &retry_context,
        )
        .await;
        if let Ok(s) = synthesis {
            let summary_str = serde_json::to_string(&s).unwrap_or_default();
            let id_for_db = id.to_string();
            let actions = s.action_items.clone();
            let meeting_tags = s.tags.clone();
            let meeting_project_name = s.project_name.clone();
            let existing_projects_clone = existing_projects.clone();
            self.db
                .with_conn(move |conn| {
                    // Only advance status to 'complete' from expected
                    // pre-states; never regress from 'recovered' or other
                    // terminal states — updating the summary should not
                    // overwrite unrelated meeting state.
                    conn.execute(
                        "UPDATE meetings SET summary_json = ?1,
                            status = CASE WHEN status IN ('failed', 'summarizing') THEN 'complete' ELSE status END
                         WHERE item_id = ?2",
                        rusqlite::params![summary_str, id_for_db],
                    )?;

                    // Bring project + tag + task assignment to parity with the
                    // primary stop() path. Skip task creation if this meeting
                    // already has linked action items so retries don't dupe.
                    let existing_action_count: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM meeting_action_links WHERE meeting_id = ?1",
                        rusqlite::params![id_for_db],
                        |row| row.get(0),
                    )?;

                    let meeting_project_id = resolve_project_name(
                        conn,
                        meeting_project_name.as_deref(),
                        &existing_projects_clone,
                    )?;
                    if let Some(ref pid) = meeting_project_id {
                        conn.execute(
                            "UPDATE items SET project_id = ?1 WHERE id = ?2",
                            rusqlite::params![pid, id_for_db],
                        )?;
                    }
                    if !meeting_tags.is_empty() {
                        crate::db::items::replace_tags(conn, &id_for_db, &meeting_tags)?;
                    }

                    if existing_action_count == 0 {
                        for action in &actions {
                            let task_id = uuid::Uuid::new_v4().to_string();
                            let now_iso = chrono::Utc::now().to_rfc3339();
                            let task_project_id = if action.project_name.is_some() {
                                resolve_project_name(
                                    conn,
                                    action.project_name.as_deref(),
                                    &existing_projects_clone,
                                )?
                            } else {
                                meeting_project_id.clone()
                            };
                            conn.execute(
                                "INSERT INTO items (id, content, source, visibility, kind, project_id, captured_at, created_at)
                                 VALUES (?1, ?2, 'meeting', 'visible', 'task', ?3, ?4, ?4)",
                                rusqlite::params![task_id, action.text, task_project_id, now_iso],
                            )?;
                            conn.execute(
                                "INSERT INTO tasks (item_id, deadline, completed_at) VALUES (?1, NULL, NULL)",
                                rusqlite::params![task_id],
                            )?;
                            let task_tags = if action.tags.is_empty() {
                                &meeting_tags
                            } else {
                                &action.tags
                            };
                            if !task_tags.is_empty() {
                                crate::db::items::replace_tags(conn, &task_id, task_tags)?;
                            }
                            crate::db::meetings::link_action(conn, &id_for_db, &task_id, &now_iso)?;
                        }
                    }
                    Ok(())
                })
                .map_err(|e| MeetingError::Db(e.to_string()))?;
        }
        Ok(())
    }

    /// Re-transcribe each WAV in `failed/`, append to existing transcript.
    pub async fn retry_chunks(&self, id: &str) -> Result<(), MeetingError> {
        let dir = self.data_dir.join("meetings").join(id).join("failed");
        if !dir.exists() {
            return Ok(());
        }
        let entries: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("wav"))
            .collect();

        let id_for_load = id.to_string();
        let row = self
            .db
            .with_conn(move |conn| crate::db::meetings::get_meeting(conn, &id_for_load))
            .map_err(|e| MeetingError::Db(e.to_string()))?
            .ok_or_else(|| MeetingError::Db("meeting not found".into()))?;
        let mut transcript: serde_json::Value = row
            .transcript_json
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(serde_json::json!({})))
            .unwrap_or(serde_json::json!({}));

        let mut still_failed: Vec<std::path::PathBuf> = Vec::new();
        for path in &entries {
            let speaker = match path.file_name().and_then(|s| s.to_str()) {
                Some(name) if name.starts_with("mic-") => Speaker::You,
                Some(name) if name.starts_with("sys-") => Speaker::Them,
                _ => continue,
            };
            match self.asr.transcribe_file(path).await {
                Ok(text) if !text.trim().is_empty() => {
                    let seg = Segment {
                        speaker,
                        start_ms: 0,
                        end_ms: 0,
                        text,
                    };
                    if let Some(arr) = transcript
                        .get_mut("segments")
                        .and_then(|v| v.as_array_mut())
                    {
                        arr.push(serde_json::to_value(&seg).unwrap());
                    }
                    let _ = std::fs::remove_file(path);
                }
                _ => still_failed.push(path.clone()),
            }
        }

        let id_for_save = id.to_string();
        let transcript_str = serde_json::to_string(&transcript).unwrap();
        let still_count = still_failed.len() as i64;
        self.db
            .with_conn(move |conn| {
                conn.execute(
                    "UPDATE meetings SET transcript_json = ?1, failed_chunk_count = ?2 WHERE item_id = ?3",
                    rusqlite::params![transcript_str, still_count, id_for_save],
                )?;
                Ok(())
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;
        Ok(())
    }
}

/// Scan for meeting rows whose status is non-terminal (interrupted by crash).
/// Returns the IDs that need user attention.
pub fn scan_orphans(_data_dir: &std::path::Path, db: &Db) -> Vec<String> {
    let result = db.with_conn(|conn| -> Result<Vec<String>, crate::db::DbError> {
        let mut stmt = conn.prepare(
            "SELECT item_id FROM meetings WHERE status IN ('recording', 'transcribing', 'summarizing')",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    });
    match result {
        Ok(ids) => {
            for id in &ids {
                tracing::warn!(meeting = %id, "orphaned meeting found");
            }
            ids
        }
        Err(e) => {
            tracing::error!(?e, "scan_orphans query failed");
            Vec::new()
        }
    }
}

/// Mark all orphans as `failed` so the UI shows them as broken.
pub fn finalize_orphans_as_failed(db: &Db, ids: &[String]) {
    for id in ids {
        let id = id.clone();
        let _ = db.with_conn(move |conn| {
            crate::db::meetings::update_status(conn, &id, MeetingStatus::Failed)
        });
    }
}

/// Spawn the `echo-scribe-calmatch` sidecar to look up the calendar event
/// most likely corresponding to a recording starting at `iso_start`. Returns
/// the parsed match (best pick only) if its score clears the threshold.
/// Failures (no permission, no overlap, sidecar timeout) collapse to `None`
/// so meeting capture is never blocked.
async fn resolve_calendar_match(
    iso_start: &str,
    duration_secs: u64,
    conf_hint: Option<&str>,
) -> Option<crate::calendar::CalendarMatch> {
    let end = match chrono::DateTime::parse_from_rfc3339(iso_start) {
        Ok(dt) => (dt + chrono::Duration::seconds(duration_secs as i64))
            .with_timezone(&chrono::Utc)
            .to_rfc3339(),
        Err(e) => {
            tracing::warn!(?e, %iso_start, "calendar match: invalid iso_start");
            return None;
        }
    };
    match crate::calendar::match_meeting(iso_start, &end, conf_hint).await {
        Ok(Some(outcome)) => {
            tracing::info!(
                title = outcome.best.title.as_deref().unwrap_or(""),
                score = outcome.best.match_score,
                reason = %outcome.best.match_reason,
                "calendar match resolved"
            );
            Some(outcome.best)
        }
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(?e, "calendar match query failed");
            None
        }
    }
}

/// Resolve a project name from the LLM to a project ID.
/// If the name matches an existing project (case-insensitive), return its ID.
/// If it's a new name, create the project and return its ID.
fn resolve_project_name(
    conn: &rusqlite::Connection,
    name: Option<&str>,
    existing: &[crate::db::projects::Project],
) -> Result<Option<String>, crate::db::DbError> {
    let name = match name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => n,
        None => return Ok(None),
    };
    // Try to match existing project (case-insensitive).
    let lower = name.to_lowercase();
    if let Some(p) = existing.iter().find(|p| p.name.to_lowercase() == lower) {
        return Ok(Some(p.id.clone()));
    }
    // Create new project.
    let pid = ulid::Ulid::new().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let proj = crate::db::projects::Project {
        id: pid.clone(),
        name: name.to_string(),
        created_at: now,
        archived_at: None,
    };
    crate::db::projects::insert_project(conn, &proj)?;
    tracing::info!(project_id = %pid, project_name = %name, "auto-created project from meeting");
    Ok(Some(pid))
}

/// Build the flattened body that goes into items.content for FTS5 indexing.
pub fn build_flattened_body(
    segments: &[Segment],
    summary_json: Option<&str>,
    user_notes: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("[Summary]\n");
    if let Some(s) = summary_json {
        if let Ok(stored) = serde_json::from_str::<StoredSummary>(s) {
            for bullet in &stored.summary {
                out.push_str("- ");
                out.push_str(bullet);
                out.push('\n');
            }
        }
    }
    out.push_str("\n[Transcript]\n");
    out.push_str(&synthesizer::flatten_transcript(segments));
    if let Some(notes) = user_notes {
        if !notes.trim().is_empty() {
            out.push_str("\n[Notes]\n");
            out.push_str(notes);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh_conn() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make_project(id: &str, name: &str) -> crate::db::projects::Project {
        crate::db::projects::Project {
            id: id.into(),
            name: name.into(),
            created_at: "2026-05-01T00:00:00Z".into(),
            archived_at: None,
        }
    }

    #[test]
    fn resolve_project_name_returns_none_for_none() {
        let conn = fresh_conn();
        assert!(resolve_project_name(&conn, None, &[]).unwrap().is_none());
    }

    #[test]
    fn resolve_project_name_returns_none_for_empty_string() {
        let conn = fresh_conn();
        assert!(resolve_project_name(&conn, Some("  "), &[]).unwrap().is_none());
    }

    #[test]
    fn resolve_project_name_matches_existing_case_insensitive() {
        let conn = fresh_conn();
        let existing = vec![make_project("p1", "Alpha Project")];
        let result = resolve_project_name(&conn, Some("alpha project"), &existing).unwrap();
        assert_eq!(result, Some("p1".into()));
    }

    #[test]
    fn resolve_project_name_creates_new_project() {
        let conn = fresh_conn();
        let result = resolve_project_name(&conn, Some("New Project"), &[]).unwrap();
        assert!(result.is_some());
        // Verify it was actually created in the DB.
        let proj = crate::db::projects::get_project(&conn, &result.unwrap()).unwrap();
        assert!(proj.is_some());
        assert_eq!(proj.unwrap().name, "New Project");
    }

    /// Helper: insert a minimal meeting row for testing.
    fn insert_test_meeting(conn: &rusqlite::Connection, id: &str) {
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
             VALUES (?1, 'test', 'meeting', 'visible', 'meeting', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')",
            rusqlite::params![id],
        ).unwrap();
        crate::db::meetings::insert_meeting(conn, &crate::db::meetings::MeetingRow {
            item_id: id.into(),
            started_at: "2026-05-01T00:00:00Z".into(),
            ended_at: None,
            duration_ms: None,
            detected_app: None,
            detected_app_name: None,
            status: "recording".into(),
            transcript_json: None,
            summary_json: None,
            user_notes: None,
            failed_chunk_count: 0,
            mic_only: false,
            calendar_match_json: None,
        }).unwrap();
    }

    #[test]
    fn retry_summary_sql_does_not_regress_recovered_status() {
        // Simulates the conditional UPDATE used in retry_summary: status
        // should only advance to 'complete' from 'failed' or 'summarizing',
        // never regress from 'recovered'.
        let conn = fresh_conn();
        insert_test_meeting(&conn, "m-retry");
        crate::db::meetings::update_status(&conn, "m-retry", MeetingStatus::Recovered).unwrap();

        // Run the same conditional UPDATE that retry_summary uses.
        conn.execute(
            "UPDATE meetings SET summary_json = ?1,
                status = CASE WHEN status IN ('failed', 'summarizing') THEN 'complete' ELSE status END
             WHERE item_id = ?2",
            rusqlite::params![r#"{"summary":["x"]}"#, "m-retry"],
        ).unwrap();

        let got = crate::db::meetings::get_meeting(&conn, "m-retry").unwrap().unwrap();
        assert_eq!(got.status, "recovered", "status must not regress from 'recovered' to 'complete'");
        assert!(got.summary_json.is_some(), "summary_json should still be updated");
    }

    #[test]
    fn retry_summary_sql_advances_failed_to_complete() {
        let conn = fresh_conn();
        insert_test_meeting(&conn, "m-fail");
        crate::db::meetings::update_status(&conn, "m-fail", MeetingStatus::Failed).unwrap();

        conn.execute(
            "UPDATE meetings SET summary_json = ?1,
                status = CASE WHEN status IN ('failed', 'summarizing') THEN 'complete' ELSE status END
             WHERE item_id = ?2",
            rusqlite::params![r#"{"summary":["x"]}"#, "m-fail"],
        ).unwrap();

        let got = crate::db::meetings::get_meeting(&conn, "m-fail").unwrap().unwrap();
        assert_eq!(got.status, "complete");
    }
}
