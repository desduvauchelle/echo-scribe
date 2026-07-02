//! Builds and maintains the embedding index over history items + summaries.

pub mod chunk;
pub mod source;

/// One thing to be embedded: a raw item or a rendered summary.
#[derive(Debug, Clone)]
pub struct SourceDoc {
    /// "item" | "meeting_summary" | "daily_summary"
    pub source_kind: &'static str,
    pub source_id: String,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub text: String,
    /// Max passages to keep (bounds monster meeting transcripts).
    pub max_passages: usize,
}
