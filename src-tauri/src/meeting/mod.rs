//! Meeting capture: passive recording of mic + system audio during calls,
//! chunked transcription via Parakeet, and LLM synthesis of summary + tasks.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod detector;
pub mod grammar;
pub mod guidance;
pub mod guide_review;
pub mod pipeline;
pub mod recorder;
pub mod stitch;
pub mod synthesizer;
pub mod syscap;
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

use std::sync::atomic::{AtomicU64, Ordering};
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
    /// A detected meeting that the user explicitly stopped. Auto-detection
    /// must not start it again until the detector observes that session end.
    user_suppressed_detection: std::sync::Mutex<Option<MeetingDetectionKey>>,
}

struct ActiveMeeting {
    item_id: String,
    started_at_ms: u64,
    detection_key: Option<MeetingDetectionKey>,
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
    recorder: Recorder,
    chunk_drain_handle: tokio::task::JoinHandle<()>,
    pipeline: Option<Pipeline>,
    /// Guide engines attached to this meeting (0..=2). Mutated by
    /// attach_guide/detach_guide while the segment observer reads it — the
    /// observer clones the Vec under the lock, then dispatches lock-free.
    guide_engines: Arc<std::sync::Mutex<Vec<crate::meeting::guidance::GuidanceEngine>>>,
    /// Full transcript so far, in stitch order. Backs the HUD's live
    /// transcript backlog (`get_live_transcript`) and guide seeding.
    transcript: Arc<std::sync::Mutex<Vec<Segment>>>,
}

pub(crate) fn spawn_guide_review_job(
    db: Db,
    llm: Arc<Llm>,
    app: tauri::AppHandle,
    run_id: String,
    meeting_id: String,
    template: crate::db::guide_templates::GuideTemplate,
    segments: Vec<Segment>,
    options: crate::meeting::guide_review::ReviewOptions,
    transcript_hash: String,
) {
    tokio::spawn(async move {
        match crate::meeting::guide_review::generate_review_with_options(
            llm, &template, &segments, &options,
        )
        .await
        {
            Ok(review) => {
                let review_json = serde_json::to_string(&review).unwrap_or_else(|_| "{}".into());
                let generated_at = chrono::Utc::now().to_rfc3339();
                let run_for_write = run_id.clone();
                if let Err(error) = db.with_conn(move |conn| {
                    crate::db::meeting_guide_runs::complete_guide_run_review(
                        conn,
                        &run_for_write,
                        review_json.as_str(),
                        generated_at.as_str(),
                        transcript_hash.as_str(),
                    )
                }) {
                    tracing::error!(target: "guide", ?error, run=%run_id, "persist guide review failed");
                }
            }
            Err(error) => {
                let run_for_write = run_id.clone();
                let error_for_write = error.clone();
                if let Err(write_error) = db.with_conn(move |conn| {
                    crate::db::meeting_guide_runs::set_guide_run_status(
                        conn,
                        &run_for_write,
                        "failed",
                        Some(error_for_write.as_str()),
                    )
                }) {
                    tracing::warn!(target: "guide", ?write_error, run=%run_id, "guide run status write failed");
                }
            }
        }
        let _ = app.emit(
            "guide-review-updated",
            serde_json::json!({ "meetingId": meeting_id, "runId": run_id }),
        );
    });
}

/// Optional context captured at meeting-start time, fed into the synthesis
/// prompt to give the LLM hints about topic and participants.
#[derive(Debug, Clone, Default)]
pub struct MeetingStartContext {
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    pub browser_tab_title: Option<String>,
}

/// Stable-enough identity for the detected meeting source whose auto-start the
/// user stopped. Native meetings are scoped to the app's current meeting-window
/// lifecycle. Browser meetings also retain the provider so switching to a
/// different provider in the same browser can re-arm immediately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MeetingDetectionKey {
    pub(crate) bundle_id: String,
    pub(crate) browser_provider: Option<String>,
}

impl MeetingDetectionKey {
    fn from_start(bundle_id: &str, browser_url: Option<&str>) -> Self {
        Self {
            bundle_id: bundle_id.to_string(),
            browser_provider: browser_url
                .and_then(crate::meeting::url_allowlist::classify)
                .map(str::to_string),
        }
    }
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
            user_suppressed_detection: std::sync::Mutex::new(None),
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

    /// Meeting source whose auto-start was explicitly stopped by the user.
    pub(crate) fn user_suppressed_detection(&self) -> Option<MeetingDetectionKey> {
        self.user_suppressed_detection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Clear only the suppression the detector actually evaluated, so a
    /// concurrent user stop cannot be accidentally overwritten.
    pub(crate) fn clear_user_suppressed_detection(&self, expected: &MeetingDetectionKey) -> bool {
        let mut guard = self
            .user_suppressed_detection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.as_ref() != Some(expected) {
            return false;
        }
        guard.take();
        true
    }

    pub async fn active_id(&self) -> Option<String> {
        self.state.lock().await.as_ref().map(|a| a.item_id.clone())
    }

    /// Engine lookup by guide session id (HUD commands).
    pub async fn guide_engine_by_id(
        &self,
        session_id: &str,
    ) -> Option<crate::meeting::guidance::GuidanceEngine> {
        self.state.lock().await.as_ref().and_then(|a| {
            a.guide_engines
                .lock()
                .unwrap()
                .iter()
                .find(|e| e.session_id() == session_id)
                .cloned()
        })
    }

    /// Snapshot of the live transcript (empty when no meeting is active).
    pub async fn transcript_snapshot(&self) -> Vec<Segment> {
        self.state
            .lock()
            .await
            .as_ref()
            .map(|a| a.transcript.lock().unwrap().clone())
            .unwrap_or_default()
    }

    /// Snapshot of active guide sessions in HUD `guide-init` payload shape.
    /// Lets the HUD recover state on (re)mount instead of depending on
    /// having been alive when `guide-init` fired.
    pub async fn active_guides_snapshot(&self) -> Vec<serde_json::Value> {
        self.state
            .lock()
            .await
            .as_ref()
            .map(|a| {
                a.guide_engines
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|e| {
                        let t = e.template_snapshot();
                        serde_json::json!({
                            "sessionId": e.session_id(),
                            "slot": e.slot(),
                            "templateName": t.name,
                            "goal": t.goal,
                            "mode": match e.mode() {
                                crate::meeting::guidance::Mode::Auto => "auto",
                                crate::meeting::guidance::Mode::OnDemand => "on_demand",
                            },
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Attach a guide template to the active meeting. Caps at two concurrent
    /// guides. Seeds the new engine with the recent transcript, persists the
    /// template snapshot on the meeting row, shows the HUD, and (in Auto
    /// mode) fires an immediate first cycle.
    pub async fn attach_guide(
        &self,
        template: crate::db::guide_templates::GuideTemplate,
    ) -> Result<String, String> {
        let (meeting_id, engines_arc, transcript_arc) = {
            let guard = self.state.lock().await;
            let active = guard.as_ref().ok_or("No meeting is recording")?;
            (
                active.item_id.clone(),
                active.guide_engines.clone(),
                active.transcript.clone(),
            )
        };

        let initial_mode = match crate::settings::SettingsStore::load(&self.app_handle)
            .ok()
            .and_then(|s| s.guide_overlay_mode())
        {
            Some(crate::meeting::guidance::Mode::OnDemand) => {
                crate::meeting::guidance::Mode::OnDemand
            }
            _ => crate::meeting::guidance::Mode::Auto,
        };
        let session_id = uuid::Uuid::new_v4().to_string();

        let engine = {
            let mut engines = engines_arc.lock().unwrap();
            if engines.len() >= 2 {
                tracing::info!(target: "guide", template = %template.name, "attach rejected: cap reached");
                return Err("Two guides are already running. Close one to add another.".into());
            }
            let slot = crate::meeting::guidance::next_free_slot(
                &engines.iter().map(|e| e.slot()).collect::<Vec<_>>(),
            );
            let engine = crate::meeting::guidance::GuidanceEngine::new(
                session_id.clone(),
                slot,
                meeting_id.clone(),
                template.clone(),
                self.llm.clone(),
                self.app_handle.clone(),
                initial_mode,
            );
            let seed = crate::meeting::guidance::seed_text_from_history(
                &transcript_arc.lock().unwrap(),
                crate::meeting::guidance::ROLLING_BYTES,
            );
            if !seed.is_empty() {
                engine.seed_rolling(seed);
            }
            engines.push(engine.clone());
            engine
        };

        match serde_json::to_value(&template) {
            Ok(snap) => {
                let mid = meeting_id.clone();
                if let Err(e) = self.db.with_conn(move |c| {
                    crate::db::meetings::append_guide_template_snapshot(c, &mid, &snap)
                }) {
                    tracing::warn!(target: "guide", ?e, "persisting guide template snapshot failed");
                }
            }
            Err(e) => tracing::warn!(target: "guide", ?e, "template snapshot serialize failed"),
        }

        // Create the guide-run row (status = pending). Survives crashes; the
        // timeline + review fill in at stop. Stash the id on the engine so
        // stop() can find the row for this guide.
        {
            let now = chrono::Utc::now().to_rfc3339();
            let run = crate::db::meeting_guide_runs::GuideRunRow {
                id: ulid::Ulid::new().to_string(),
                meeting_id: meeting_id.clone(),
                template_id: template.id.clone(),
                template_name: template.name.clone(),
                template_json: serde_json::to_string(&template).unwrap_or_else(|_| "{}".into()),
                slot: engine.slot() as i64,
                started_at: now.clone(),
                timeline_json: None,
                review_json: None,
                status: "pending".into(),
                error: None,
                generated_at: None,
                created_at: now,
                run_kind: "attached".into(),
                insight_kind: "rubric".into(),
                subject_scope: "you".into(),
                transcript_hash: String::new(),
            };
            engine.set_run_id(run.id.clone());
            let db = self.db.clone();
            if let Err(e) =
                db.with_conn(move |c| crate::db::meeting_guide_runs::insert_guide_run(c, &run))
            {
                tracing::warn!(target: "guide", ?e, "insert guide run row failed");
            }
        }

        let mode_str = match initial_mode {
            crate::meeting::guidance::Mode::Auto => "auto",
            crate::meeting::guidance::Mode::OnDemand => "on_demand",
        };
        crate::overlay::show_meeting_hud(&self.app_handle, Some("guides"));
        crate::overlay::emit_guide_init(
            &self.app_handle,
            serde_json::json!({
                "sessionId": session_id,
                "slot": engine.slot(),
                "templateName": template.name,
                "goal": template.goal,
                "mode": mode_str,
            }),
        );
        if matches!(initial_mode, crate::meeting::guidance::Mode::Auto) {
            // Harmless when the seed was empty: the cycle no-ops on an
            // empty rolling window.
            engine.fire_cycle();
        }
        tracing::info!(
            target: "guide",
            session = %session_id,
            template = %template.name,
            slot = engine.slot(),
            "guide attached"
        );
        Ok(session_id)
    }

    /// Detach one guide session. The meeting keeps recording.
    pub async fn detach_guide(&self, session_id: &str) -> Result<(), String> {
        let guard = self.state.lock().await;
        let active = guard.as_ref().ok_or("No meeting is recording")?;
        let removed = {
            let mut engines = active.guide_engines.lock().unwrap();
            let before = engines.len();
            engines.retain(|e| e.session_id() != session_id);
            before != engines.len()
        };
        if !removed {
            return Err("Guide session not found".into());
        }
        let _ = self.app_handle.emit(
            "guide-detached",
            serde_json::json!({ "sessionId": session_id }),
        );
        tracing::info!(target: "guide", session = %session_id, "guide detached");
        Ok(())
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
        let detection_key = detected_app.as_deref().map(|bundle_id| {
            MeetingDetectionKey::from_start(bundle_id, start_context.browser_url.as_deref())
        });

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
                    "INSERT INTO items (id, content, source, kind, captured_at, created_at)
                     VALUES (?1, ?2, 'meeting', 'meeting', ?3, ?3)",
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
                        guide_template_json: None,
                        project_name: None,
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

        // Build the pipeline with an always-installed segment observer. It
        // feeds (a) the transcript history + live `meeting-segment` events
        // and (b) whatever guide engines are attached at dispatch time —
        // which is what lets guides attach/detach mid-meeting even though
        // the observer itself is captured once at spawn_drain time.
        let mut pipeline = Pipeline::new(self.asr.clone(), dir.join("failed"));
        let guide_engines: Arc<std::sync::Mutex<Vec<crate::meeting::guidance::GuidanceEngine>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let transcript: Arc<std::sync::Mutex<Vec<Segment>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let engines_obs = guide_engines.clone();
            let transcript_obs = transcript.clone();
            let app_obs = self.app_handle.clone();
            let id_obs = id.clone();
            let cb: crate::meeting::pipeline::SegmentObserver = std::sync::Arc::new(move |seg| {
                transcript_obs.lock().unwrap().push(seg.clone());
                if let Err(e) = app_obs.emit(
                    "meeting-segment",
                    serde_json::json!({ "meetingId": id_obs, "segment": seg }),
                ) {
                    tracing::warn!(target: "hud", ?e, "meeting-segment emit failed");
                }
                let engines: Vec<_> = engines_obs.lock().unwrap().clone();
                for engine in engines {
                    if engine.ingest_segment(&seg) {
                        engine.fire_cycle();
                    }
                }
            });
            pipeline = pipeline.with_observer(cb);
        }
        let chunk_drain_handle = pipeline.spawn_drain(chunk_rx);

        let _ = self.app_handle.emit(
            "meeting-started",
            serde_json::json!({
                "id": id,
                "detected_app_name": detected_app_name,
            }),
        );
        crate::audio::feedback::play(crate::audio::feedback::Sfx::Start);
        crate::overlay::show_meeting_overlay(&self.app_handle, detected_app_name.as_deref());
        crate::overlay::show_meeting_start_toast(&self.app_handle, detected_app_name.as_deref());

        // Inactivity backstop: auto-stop after a sustained silence even when
        // window-based end detection is blind (e.g. the user ends a call but
        // stays focused in another app, so the window monitor only ever sees
        // `Presence::Unknown`). Polls the pipeline's last-speech clock.
        let manager_weak_inact = Arc::downgrade(&self);
        let id_for_inact = id.clone();
        let activity_clock = pipeline.activity_clock();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(INACTIVITY_POLL_SECS));
            loop {
                interval.tick().await;
                let Some(mgr) = manager_weak_inact.upgrade() else {
                    return;
                };
                if mgr.active_id().await.as_deref() != Some(&id_for_inact) {
                    return; // meeting stopped or replaced
                }
                let last = activity_clock.load(std::sync::atomic::Ordering::Relaxed);
                let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
                if inactivity_should_stop(now, last, INACTIVITY_STOP_MS) {
                    tracing::info!(
                        id = %id_for_inact,
                        silent_ms = now.saturating_sub(last),
                        "inactivity backstop: no speech, auto-stopping"
                    );
                    let _ = mgr.stop().await;
                    return;
                }
            }
        });

        *guard = Some(ActiveMeeting {
            item_id: id.clone(),
            started_at_ms,
            detection_key,
            detected_app_name,
            start_window_title: start_context.window_title,
            start_browser_url: start_context.browser_url,
            start_browser_tab_title: start_context.browser_tab_title,
            recorder,
            chunk_drain_handle,
            pipeline: Some(pipeline),
            guide_engines,
            transcript,
        });
        Ok(id)
    }

    pub async fn stop(&self) -> Result<String, MeetingError> {
        self.stop_with_intent(false).await
    }

    /// Stop requested by an explicit user action. If this recording came from
    /// meeting detection, remember that source so automation cannot restart
    /// the same still-running call.
    pub async fn stop_by_user(&self) -> Result<String, MeetingError> {
        self.stop_with_intent(true).await
    }

    async fn stop_with_intent(&self, user_initiated: bool) -> Result<String, MeetingError> {
        let mut guard = self.state.lock().await;
        let Some(mut active) = guard.take() else {
            return Err(MeetingError::NotRecording);
        };
        if user_initiated {
            if let Some(key) = active.detection_key.clone() {
                tracing::info!(
                    app = %key.bundle_id,
                    provider = ?key.browser_provider,
                    "user stopped detected meeting; suppressing auto-start until source ends"
                );
                self.user_suppressed_detection
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .replace(key);
            }
        }
        // Stamp the cooldown the moment state is cleared, so the auto-detector
        // can't race in while synthesis is still running below.
        self.last_stopped_at_ms.store(
            chrono::Utc::now().timestamp_millis() as u64,
            Ordering::Relaxed,
        );
        drop(guard);

        // From here on the overlay pill must never be left saying
        // "Recording · <app>" — that recording is over. This guard hides the
        // pill + HUD on every exit path (including the `?` error returns
        // below); the happy path re-shows it with "Transcribing…" /
        // "Summarizing…" labels as post-processing advances.
        struct OverlayCleanup(tauri::AppHandle);
        impl Drop for OverlayCleanup {
            fn drop(&mut self) {
                crate::overlay::hide_recording_overlay(&self.0);
                crate::overlay::hide_meeting_start_toast(&self.0);
                crate::overlay::hide_meeting_hud(&self.0);
            }
        }
        let _overlay_cleanup = OverlayCleanup(self.app_handle.clone());

        // Step 1: Stop recording.
        active.recorder.stop().await?;
        crate::audio::feedback::play(crate::audio::feedback::Sfx::Stop);
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
        // Flip the overlay pill from "Recording · <app>" to a processing
        // state so the user can see the recording has actually ended and the
        // app is now catching up on transcription.
        crate::overlay::show_processing_overlay(&self.app_handle, "Transcribing meeting…");

        // Step 3: Wait for pipeline to drain (chunk channel is now closed — drain exits cleanly).
        let _ = active.chunk_drain_handle.await;

        // Step 4: Pull segments out of the pipeline.
        let pipeline = active.pipeline.take().expect("set in start");
        crate::util::rss::log_rss("before pipeline.finalize");
        let (segments, failed) = pipeline.finalize().await;
        crate::util::rss::log_rss("after pipeline.finalize");
        tracing::info!(seg_count = segments.len(), "[mem] segments materialized");
        let failed_count = failed.len() as i64;

        // Step 5: Run synthesis.
        let _ = self.app_handle.emit(
            "meeting-status",
            serde_json::json!({"id": id, "status": "summarizing"}),
        );
        crate::overlay::show_processing_overlay(&self.app_handle, "Summarizing meeting…");
        let id_db2 = id.clone();
        self.db
            .with_conn(move |conn| {
                crate::db::meetings::update_status(conn, &id_db2, MeetingStatus::Summarizing)
            })
            .map_err(|e| MeetingError::Db(e.to_string()))?;

        let now = chrono::Utc::now();
        let duration_ms = (now.timestamp_millis() as u64).saturating_sub(active.started_at_ms);

        // Fetch existing projects (with description + keywords) so the LLM
        // can route this meeting using the same rich context the LogCapture
        // classifier uses.
        let existing_projects = self
            .db
            .with_conn(|conn| crate::db::projects::list_projects(conn, false))
            .unwrap_or_default();

        let meeting_inputs = {
            let meeting_id = id.clone();
            self.db
                .with_conn(move |conn| {
                    let row = crate::db::meetings::get_meeting(conn, &meeting_id)?;
                    let prefs =
                        crate::db::meeting_intelligence::get_preferences(conn, &meeting_id)?;
                    let template = match prefs.and_then(|p| p.summary_template_id) {
                        Some(template_id) => crate::db::meeting_intelligence::get_summary_template(
                            conn,
                            &template_id,
                        )?,
                        None => crate::db::meeting_intelligence::get_summary_template(
                            conn,
                            "builtin-general",
                        )?,
                    };
                    Ok((row.and_then(|r| r.user_notes).unwrap_or_default(), template))
                })
                .unwrap_or_default()
        };
        let (user_notes, summary_template) = meeting_inputs;

        let start_context = MeetingStartContext {
            window_title: active.start_window_title.clone(),
            browser_url: active.start_browser_url.clone(),
            browser_tab_title: active.start_browser_tab_title.clone(),
        };
        let settings = crate::settings::SettingsStore::load(&self.app_handle).ok();
        let custom_prompt = settings.as_ref().map(|s| s.meeting_summary_prompt());

        crate::util::rss::log_rss("before synthesize");
        let synthesis = synthesizer::synthesize(
            self.llm.clone(),
            &segments,
            active.detected_app_name.as_deref(),
            duration_ms,
            &existing_projects,
            &start_context,
            custom_prompt.as_deref(),
            Some(&user_notes),
            summary_template.as_ref(),
        )
        .await;
        crate::util::rss::log_rss("after synthesize");

        // Step 6: Build the transcript JSON, serialize summary, write to DB.
        let transcript_json = serde_json::json!({
            "segments": segments,
            "duration_ms": duration_ms,
            "asr_model": self.asr.active_model_id().unwrap_or_else(|| "unknown".into()),
            "chunk_seconds": crate::meeting::recorder::CHUNK_TARGET_SECONDS_PUB,
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
        let body = build_flattened_body(&segments, summary_json.as_deref(), Some(&user_notes));
        let id_db3 = id.clone();
        let ended_at = now.to_rfc3339();
        let transcript_str = serde_json::to_string(&transcript_json).unwrap();
        let summary_for_db = summary_json.clone();
        let summary_run_json = summary_json.clone();
        let summary_run_error = synthesis.as_ref().err().cloned();
        let summary_template_id = summary_template.as_ref().map(|t| t.id.clone());
        let summary_template_snapshot = summary_template
            .as_ref()
            .and_then(|t| serde_json::to_string(t).ok());
        let user_notes_snapshot = user_notes.clone();
        let transcript_hash = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(transcript_str.as_bytes()))
        };
        let guide_transcript_hash = transcript_hash.clone();
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
                crate::db::meeting_intelligence::insert_summary_run(
                    conn,
                    &crate::db::meeting_intelligence::MeetingSummaryRun {
                        id: uuid::Uuid::new_v4().to_string(),
                        meeting_id: id_db3.clone(),
                        template_id: summary_template_id,
                        template_snapshot_json: summary_template_snapshot,
                        summary_json: summary_run_json,
                        user_notes_snapshot,
                        transcript_hash,
                        status: if summary_run_error.is_some() { "failed".into() } else { "ready".into() },
                        error: summary_run_error,
                        created_at: ended_at.clone(),
                    },
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
                    } else {
                        // Synthesis couldn't name a project — let the
                        // auto-tagger retry with the router + classifier.
                        crate::db::project_tag_jobs::enqueue(
                            conn,
                            &id_db3,
                            &chrono::Utc::now().to_rfc3339(),
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
                            "INSERT INTO items (id, content, source, kind, project_id, captured_at, created_at)
                             VALUES (?1, ?2, 'meeting', 'task', ?3, ?4, ?4)",
                            rusqlite::params![task_id, action.text, task_project_id, now_iso],
                        )?;
                        if task_project_id.is_none() {
                            crate::db::project_tag_jobs::enqueue(conn, &task_id, &now_iso)?;
                        }
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

        // Step 7.5: post-meeting insight jobs are deliberately independent of
        // the main summary. Attached guides keep their timeline and review;
        // opt-in tracked templates get their own review rows. Meeting completion
        // never waits for these secondary LLM calls.
        {
            use std::collections::{HashMap, HashSet};

            let enabled_templates = self
                .db
                .with_conn(crate::db::guide_templates::list_enabled_insight_templates)
                .unwrap_or_else(|error| {
                    tracing::warn!(target: "guide", ?error, "load tracked insight templates failed");
                    Vec::new()
                });
            let config_by_template: HashMap<_, _> = enabled_templates
                .iter()
                .map(|(template, config)| (template.id.clone(), config.clone()))
                .collect();
            let guide_engines: Vec<_> = active.guide_engines.lock().unwrap().clone();
            let mut reviewed_template_ids = HashSet::new();

            for engine in &guide_engines {
                let Some(run_id) = engine.run_id() else {
                    continue;
                };
                let template = engine.template_snapshot();
                reviewed_template_ids.insert(template.id.clone());
                let timeline = engine.drain_timeline();
                if let Ok(timeline_json) = serde_json::to_string(&timeline) {
                    let run_for_write = run_id.clone();
                    let config = config_by_template.get(&template.id).cloned();
                    let insight_kind = config
                        .as_ref()
                        .map(|value| value.insight_kind.as_str())
                        .unwrap_or("rubric");
                    let subject_scope = config
                        .as_ref()
                        .map(|value| value.subject_scope.as_str())
                        .unwrap_or("you");
                    if let Err(error) = self.db.with_conn(|conn| {
                        crate::db::meeting_guide_runs::update_guide_run_timeline(
                            conn,
                            &run_for_write,
                            Some(timeline_json.as_str()),
                        )?;
                        crate::db::meeting_guide_runs::update_guide_run_analysis_contract(
                            conn,
                            &run_for_write,
                            "attached",
                            insight_kind,
                            subject_scope,
                            &guide_transcript_hash,
                        )
                    }) {
                        tracing::warn!(target: "guide", ?error, "persist guide run metadata failed");
                    }
                }
                let config = config_by_template.get(&template.id);
                spawn_guide_review_job(
                    self.db.clone(),
                    self.llm.clone(),
                    self.app_handle.clone(),
                    run_id,
                    id.clone(),
                    template,
                    segments.clone(),
                    crate::meeting::guide_review::ReviewOptions {
                        insight_kind: config
                            .map(|value| value.insight_kind.clone())
                            .unwrap_or_else(|| "rubric".into()),
                        subject_scope: config
                            .map(|value| value.subject_scope.clone())
                            .unwrap_or_else(|| "you".into()),
                    },
                    guide_transcript_hash.clone(),
                );
            }

            let meeting_started_at =
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(active.started_at_ms as i64)
                    .unwrap_or_else(chrono::Utc::now)
                    .to_rfc3339();
            for (index, (template, config)) in enabled_templates.into_iter().enumerate() {
                if reviewed_template_ids.contains(&template.id) {
                    continue;
                }
                let run_id = ulid::Ulid::new().to_string();
                let created_at = chrono::Utc::now().to_rfc3339();
                let run = crate::db::meeting_guide_runs::GuideRunRow {
                    id: run_id.clone(),
                    meeting_id: id.clone(),
                    template_id: template.id.clone(),
                    template_name: template.name.clone(),
                    template_json: serde_json::to_string(&template).unwrap_or_else(|_| "{}".into()),
                    slot: 100 + index as i64,
                    started_at: meeting_started_at.clone(),
                    timeline_json: None,
                    review_json: None,
                    status: "pending".into(),
                    error: None,
                    generated_at: None,
                    created_at,
                    run_kind: "tracked".into(),
                    insight_kind: config.insight_kind.clone(),
                    subject_scope: config.subject_scope.clone(),
                    transcript_hash: guide_transcript_hash.clone(),
                };
                if let Err(error) = self
                    .db
                    .with_conn(|conn| crate::db::meeting_guide_runs::insert_guide_run(conn, &run))
                {
                    tracing::warn!(target: "guide", ?error, template=%template.id, "insert tracked insight run failed");
                    continue;
                }
                spawn_guide_review_job(
                    self.db.clone(),
                    self.llm.clone(),
                    self.app_handle.clone(),
                    run_id,
                    id.clone(),
                    template,
                    segments.clone(),
                    crate::meeting::guide_review::ReviewOptions {
                        insight_kind: config.insight_kind,
                        subject_scope: config.subject_scope,
                    },
                    guide_transcript_hash.clone(),
                );
            }
        }

        // Keep both the global meeting folder and any project-specific mirror
        // in sync before announcing completion. Export failure never rolls back
        // the safely persisted meeting.
        let meeting_export_error =
            try_export_meeting_after_finalize(&self.db, settings.as_ref(), &id);

        // Step 8: Emit "complete" event and hide the overlay.
        let _ = self
            .app_handle
            .emit("meeting-complete", serde_json::json!({"id": id}));
        crate::overlay::hide_recording_overlay(&self.app_handle);
        crate::overlay::hide_meeting_hud(&self.app_handle);

        // Native desktop notification so the user sees the saved meeting is
        // ready even when no Echo Scribe window is visible. Title falls back
        // through synthesis → detected app name → generic "Meeting".
        {
            use tauri_plugin_notification::NotificationExt;
            let dur_min = duration_ms / 60_000;
            let dur_sec = (duration_ms % 60_000) / 1000;
            let title_str = synthesis
                .as_ref()
                .ok()
                .map(|s| s.suggested_title.clone())
                .filter(|t| !t.is_empty())
                .or_else(|| active.detected_app_name.clone())
                .unwrap_or_else(|| "Meeting".to_string());
            let (notification_title, notification_body) = if meeting_export_error.is_some() {
                (
                    "Meeting saved, export failed",
                    format!("{} • Check Settings → Diagnostics", title_str),
                )
            } else {
                (
                    "Meeting saved",
                    format!("{} • {}m {}s", title_str, dur_min, dur_sec),
                )
            };
            let _ = self
                .app_handle
                .notification()
                .builder()
                .title(notification_title)
                .body(&notification_body)
                .show();
        }

        // Step 9: Best-effort cleanup of empty meeting dir if no failed chunks.
        if failed.is_empty() {
            let _ = std::fs::remove_dir_all(self.data_dir.join("meetings").join(&id));
        }

        Ok(id)
    }
}

/// Refresh the just-finalized meeting's configured Markdown mirrors.
/// Best-effort: return an error string only so the caller can make export
/// failure visible without failing the meeting lifecycle itself.
fn try_export_meeting_after_finalize(
    db: &Db,
    settings: Option<&crate::settings::SettingsStore>,
    meeting_id: &str,
) -> Option<String> {
    let global_folder = settings.and_then(|s| s.meeting_export_folder());
    match crate::export::sync_finalized_meeting_exports(db, meeting_id, global_folder.as_deref()) {
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(
                target: "export",
                meeting_id,
                error = %e,
                "sync meeting markdown exports failed"
            );
            Some(e.to_string())
        }
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

        // Retry path: window/URL context wasn't persisted, so synthesis runs
        // from the transcript alone.
        let retry_context = MeetingStartContext::default();
        let settings = crate::settings::SettingsStore::load(&self.app_handle).ok();
        let custom_prompt = settings.as_ref().map(|s| s.meeting_summary_prompt());

        let prefs = self
            .db
            .with_conn(|conn| crate::db::meeting_intelligence::get_preferences(conn, id))
            .unwrap_or_default();
        let summary_template = match prefs.and_then(|p| p.summary_template_id) {
            Some(template_id) => self
                .db
                .with_conn(|conn| {
                    crate::db::meeting_intelligence::get_summary_template(conn, &template_id)
                })
                .unwrap_or_default(),
            None => self
                .db
                .with_conn(|conn| {
                    crate::db::meeting_intelligence::get_summary_template(conn, "builtin-general")
                })
                .unwrap_or_default(),
        };
        let user_notes = row.user_notes.clone().unwrap_or_default();

        let synthesis = synthesizer::synthesize(
            self.llm.clone(),
            &segments,
            row.detected_app_name.as_deref(),
            duration_ms,
            &existing_projects,
            &retry_context,
            custom_prompt.as_deref(),
            Some(&user_notes),
            summary_template.as_ref(),
        )
        .await;
        if let Ok(s) = synthesis {
            let summary_str = serde_json::to_string(&s).unwrap_or_default();
            let id_for_db = id.to_string();
            let actions = s.action_items.clone();
            let meeting_tags = s.tags.clone();
            let meeting_project_name = s.project_name.clone();
            let existing_projects_clone = existing_projects.clone();
            let template_id = summary_template.as_ref().map(|t| t.id.clone());
            let template_snapshot_json = summary_template
                .as_ref()
                .and_then(|t| serde_json::to_string(t).ok());
            let transcript_hash = {
                use sha2::{Digest, Sha256};
                format!(
                    "{:x}",
                    Sha256::digest(
                        row.transcript_json
                            .as_deref()
                            .unwrap_or_default()
                            .as_bytes()
                    )
                )
            };
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
                    crate::db::meeting_intelligence::insert_summary_run(
                        conn,
                        &crate::db::meeting_intelligence::MeetingSummaryRun {
                            id: uuid::Uuid::new_v4().to_string(),
                            meeting_id: id_for_db.clone(),
                            template_id,
                            template_snapshot_json,
                            summary_json: Some(summary_str.clone()),
                            user_notes_snapshot: user_notes,
                            transcript_hash,
                            status: "ready".into(),
                            error: None,
                            created_at: chrono::Utc::now().to_rfc3339(),
                        },
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
                    } else {
                        crate::db::project_tag_jobs::enqueue(
                            conn,
                            &id_for_db,
                            &chrono::Utc::now().to_rfc3339(),
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
                                "INSERT INTO items (id, content, source, kind, project_id, captured_at, created_at)
                                 VALUES (?1, ?2, 'meeting', 'task', ?3, ?4, ?4)",
                                rusqlite::params![task_id, action.text, task_project_id, now_iso],
                            )?;
                            if task_project_id.is_none() {
                                crate::db::project_tag_jobs::enqueue(conn, &task_id, &now_iso)?;
                            }
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
            let _ = try_export_meeting_after_finalize(&self.db, settings.as_ref(), id);
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
        let settings = crate::settings::SettingsStore::load(&self.app_handle).ok();
        let _ = try_export_meeting_after_finalize(&self.db, settings.as_ref(), id);
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
        ..Default::default()
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

/// Inactivity backstop threshold: after this much continuous silence (no
/// transcribed speech from anyone — mic or system audio), the meeting
/// auto-stops even when window-based end detection can't see the meeting app.
/// This is the safety net for the case where the user ends a call but stays
/// focused in another app, so the window monitor only ever observes
/// `Presence::Unknown`. See `detector::evaluate_meeting_presence`.
const INACTIVITY_STOP_MS: u64 = 5 * 60 * 1000;

/// Poll interval for the inactivity backstop timer.
const INACTIVITY_POLL_SECS: u64 = 30;

/// Pure decision for the inactivity backstop: stop once silence has lasted at
/// least `threshold_ms`. Kept side-effect-free so it can be unit-tested without
/// timers or a live meeting.
fn inactivity_should_stop(now_ms: u64, last_activity_ms: u64, threshold_ms: u64) -> bool {
    now_ms.saturating_sub(last_activity_ms) >= threshold_ms
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
            ..Default::default()
        }
    }

    #[test]
    fn inactivity_should_stop_fires_only_after_threshold() {
        let threshold = 5 * 60 * 1000; // 5 min
                                       // Fresh activity (just talked) — keep recording.
        assert!(!inactivity_should_stop(10 * 60_000, 10 * 60_000, threshold));
        // 4 minutes of silence — still under threshold, keep recording.
        assert!(!inactivity_should_stop(4 * 60_000, 0, threshold));
        // Exactly at the threshold — stop.
        assert!(inactivity_should_stop(5 * 60_000, 0, threshold));
        // Well past the threshold — stop.
        assert!(inactivity_should_stop(30 * 60_000, 10 * 60_000, threshold));
    }

    #[test]
    fn resolve_project_name_returns_none_for_none() {
        let conn = fresh_conn();
        assert!(resolve_project_name(&conn, None, &[]).unwrap().is_none());
    }

    #[test]
    fn resolve_project_name_returns_none_for_empty_string() {
        let conn = fresh_conn();
        assert!(resolve_project_name(&conn, Some("  "), &[])
            .unwrap()
            .is_none());
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
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES (?1, 'test', 'meeting', 'meeting', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')",
            rusqlite::params![id],
        ).unwrap();
        crate::db::meetings::insert_meeting(
            conn,
            &crate::db::meetings::MeetingRow {
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
                guide_template_json: None,
                project_name: None,
            },
        )
        .unwrap();
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

        let got = crate::db::meetings::get_meeting(&conn, "m-retry")
            .unwrap()
            .unwrap();
        assert_eq!(
            got.status, "recovered",
            "status must not regress from 'recovered' to 'complete'"
        );
        assert!(
            got.summary_json.is_some(),
            "summary_json should still be updated"
        );
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

        let got = crate::db::meetings::get_meeting(&conn, "m-fail")
            .unwrap()
            .unwrap();
        assert_eq!(got.status, "complete");
    }
}
