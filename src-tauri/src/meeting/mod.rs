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
