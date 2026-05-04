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
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

use crate::asr::pipeline::AsrPipeline;
use crate::db::Db;
use crate::llm::Llm;
use crate::meeting::pipeline::Pipeline;
use crate::meeting::recorder::Recorder;
use crate::meeting::synthesizer::StoredSummary;

/// Public lifecycle manager. One per app process. Holds the active meeting (if any)
/// and orchestrates record → transcribe → synthesize → persist.
pub struct MeetingManager {
    pub asr: Arc<AsrPipeline>,
    pub llm: Arc<Llm>,
    pub db: Db,
    pub data_dir: std::path::PathBuf,
    pub app_handle: tauri::AppHandle,
    state: AsyncMutex<Option<ActiveMeeting>>,
}

struct ActiveMeeting {
    item_id: String,
    started_at: String,
    started_at_ms: u64,
    detected_app: Option<String>,
    detected_app_name: Option<String>,
    recorder: Recorder,
    chunk_drain_handle: tokio::task::JoinHandle<()>,
    pipeline: Option<Pipeline>,
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
        })
    }

    pub async fn is_active(&self) -> bool {
        self.state.lock().await.is_some()
    }

    pub async fn active_id(&self) -> Option<String> {
        self.state.lock().await.as_ref().map(|a| a.item_id.clone())
    }

    pub async fn start(
        self: Arc<Self>,
        detected_app: Option<String>,
        detected_app_name: Option<String>,
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
            while let Some(evt) = evt_rx.recv().await {
                match evt {
                    syscap::SyscapEvent::Error { kind, msg } => {
                        tracing::error!(meeting = %id_for_evt, %kind, %msg, "syscap error");
                    }
                    syscap::SyscapEvent::Warn(msg) => {
                        tracing::warn!(meeting = %id_for_evt, %msg, "syscap warn");
                    }
                    _ => {}
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

        *guard = Some(ActiveMeeting {
            item_id: id.clone(),
            started_at,
            started_at_ms,
            detected_app,
            detected_app_name,
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
        drop(guard);

        // Step 1: Stop recording.
        active.recorder.stop().await?;

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

        // Step 3: Wait for pipeline to drain (the chunk channel sender was dropped by recorder.stop()).
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

        let synthesis = synthesizer::synthesize(
            self.llm.clone(),
            &segments,
            active.detected_app_name.as_deref(),
            duration_ms,
        )
        .await;

        // Step 6: Build the transcript JSON, serialize summary, write to DB.
        let transcript_json = serde_json::json!({
            "segments": segments,
            "duration_ms": duration_ms,
            "asr_model": self.asr.active_model_id().unwrap_or_else(|| "unknown".into()),
            "chunk_seconds": 60,
            "failed_chunk_count": failed_count,
            "mic_only": active.recorder.mic_only,
        });
        let summary_json = match &synthesis {
            Ok(s) => Some(serde_json::to_string(s).unwrap_or_else(|_| "{}".into())),
            Err(e) => {
                tracing::error!(?e, "synthesis returned error");
                None
            }
        };

        // Step 7: Persist + flatten body for FTS.
        let body = build_flattened_body(&segments, summary_json.as_deref(), None);
        let id_db3 = id.clone();
        let ended_at = now.to_rfc3339();
        let transcript_str = serde_json::to_string(&transcript_json).unwrap();
        let summary_for_db = summary_json.clone();
        self.db
            .with_conn(move |conn| {
                crate::db::meetings::finalize_meeting(
                    conn,
                    &id_db3,
                    &ended_at,
                    duration_ms as i64,
                    &transcript_str,
                    summary_for_db.as_deref(),
                    failed_count,
                )?;
                conn.execute(
                    "UPDATE items SET content = ?1 WHERE id = ?2",
                    rusqlite::params![body, id_db3],
                )?;
                Ok(())
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;

        // Step 8: If synthesis succeeded, write each action_item as a task + link.
        if let Ok(s) = &synthesis {
            let actions = s.action_items.clone();
            let meeting_id_clone = id.clone();
            self.db
                .with_conn(move |conn| {
                    for action in &actions {
                        let task_id = uuid::Uuid::new_v4().to_string();
                        let now_iso = chrono::Utc::now().to_rfc3339();
                        conn.execute(
                            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
                             VALUES (?1, ?2, 'meeting', 'visible', 'task', ?3, ?3)",
                            rusqlite::params![task_id, action.text, now_iso],
                        )?;
                        conn.execute(
                            "INSERT INTO tasks (item_id, deadline, completed_at) VALUES (?1, NULL, NULL)",
                            rusqlite::params![task_id],
                        )?;
                        crate::db::meetings::link_action(conn, &meeting_id_clone, &task_id, &now_iso)?;
                    }
                    Ok(())
                })
                .map_err(|e| MeetingError::Db(e.to_string()))?;
        }

        // Step 9: Emit "complete" event and hide the overlay.
        let _ = self.app_handle.emit(
            "meeting-complete",
            serde_json::json!({"id": id}),
        );
        crate::overlay::hide_recording_overlay(&self.app_handle);

        // Step 10: Best-effort cleanup of empty meeting dir if no failed chunks.
        if failed.is_empty() {
            let _ = std::fs::remove_dir_all(self.data_dir.join("meetings").join(&id));
        }

        Ok(id)
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
