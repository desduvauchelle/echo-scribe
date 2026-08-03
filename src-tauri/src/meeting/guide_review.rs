//! Evidence-backed whole-transcript review for attached guides and opt-in
//! tracked insights. Long meetings are reviewed in segment-preserving chunks,
//! then reduced without losing the source coordinates needed by the UI.

use crate::db::guide_templates::GuideTemplate;
use crate::llm::{GenerateRequest, Llm};
use crate::meeting::guidance::isolate_json_object;
use crate::meeting::synthesizer::EvidenceRef;
use crate::meeting::{Segment, Speaker};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

const MAX_REVIEW_BYTES: usize = 14_000;
const REVIEW_MAX_TOKENS: usize = 2_048;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewOptions {
    pub insight_kind: String,
    pub subject_scope: String,
}

impl Default for ReviewOptions {
    fn default() -> Self {
        Self {
            insight_kind: "rubric".into(),
            subject_scope: "you".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct GuideReview {
    #[serde(default, deserialize_with = "flex_string")]
    pub overall: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub synthesis: String,
    #[serde(default)]
    pub scorecard: Vec<ScorecardItem>,
    #[serde(default)]
    pub emergent: Vec<EmergentItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ScorecardItem {
    #[serde(default, deserialize_with = "flex_string")]
    pub criterion: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub verdict: String,
    /// Kept for backwards compatibility with reviews created before evidence
    /// references were introduced.
    #[serde(default, deserialize_with = "flex_string")]
    pub evidence: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    #[serde(default, deserialize_with = "flex_string")]
    pub why: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub tip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EmergentItem {
    #[serde(default, deserialize_with = "flex_string")]
    pub observation: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub evidence: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

/// Accept whatever the model put where a string belongs. Gemma sometimes
/// emits an array of quotes for `evidence` (seen in production on
/// 2026-08-03) — join list items instead of failing the whole review; map
/// null to empty and scalars to their display form.
fn flex_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value_to_string(&value))
}

fn value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(value_to_string)
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("; "),
        serde_json::Value::Object(_) => String::new(),
    }
}

pub async fn generate_review(
    llm: Arc<Llm>,
    template: &GuideTemplate,
    segments: &[Segment],
) -> Result<GuideReview, String> {
    generate_review_with_options(llm, template, segments, &ReviewOptions::default()).await
}

pub async fn generate_review_with_options(
    llm: Arc<Llm>,
    template: &GuideTemplate,
    segments: &[Segment],
    options: &ReviewOptions,
) -> Result<GuideReview, String> {
    if segments
        .iter()
        .all(|segment| segment.text.trim().is_empty())
    {
        return Err("empty transcript".into());
    }

    let chunks = build_review_chunks(segments);
    if chunks.len() == 1 {
        let (system, user) = crate::llm::prompt::build_configured_guide_review_prompt(
            &template.goal,
            &template.notes,
            &chunks[0],
            &options.insight_kind,
            &options.subject_scope,
            false,
        );
        let mut review = call_review(llm.as_ref(), system, user).await?;
        validate_review(&mut review, segments, options);
        return Ok(review);
    }

    let mut partials = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let (system, user) = crate::llm::prompt::build_configured_guide_review_prompt(
            &template.goal,
            &template.notes,
            &chunk,
            &options.insight_kind,
            &options.subject_scope,
            true,
        );
        let mut partial = call_review(llm.as_ref(), system, user).await?;
        validate_review(&mut partial, segments, options);
        partials.push(partial);
    }

    let candidates = serde_json::to_string(&partials)
        .map_err(|error| format!("serialize guide review candidates: {error}"))?;
    let (system, user) = crate::llm::prompt::build_guide_review_reduce_prompt(
        &template.goal,
        &template.notes,
        &candidates,
        &options.insight_kind,
        &options.subject_scope,
    );
    let mut review = call_review(llm.as_ref(), system, user).await?;
    validate_review(&mut review, segments, options);
    Ok(review)
}

async fn call_review(
    llm: &Llm,
    system: Option<String>,
    user: String,
) -> Result<GuideReview, String> {
    let mut last_raw = String::new();
    for attempt in 0..2u8 {
        let request = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: REVIEW_MAX_TOKENS,
            temperature: if attempt == 0 { 0.2 } else { 0.1 },
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(16_384),
        };
        let raw = match llm.generate(request).await {
            Ok(raw) => raw,
            Err(error) => {
                warn!(target: "guide", ?error, attempt, "[guide-review] generate failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {error}"));
                }
                continue;
            }
        };
        last_raw = raw.clone();
        match parse_review(&raw) {
            Ok((review, repaired)) => {
                info!(target: "guide", criteria=review.scorecard.len(), emergent=review.emergent.len(), overall=%review.overall, repaired, "[guide-review] parsed ok");
                return Ok(review);
            }
            Err(error) => {
                warn!(target: "guide", ?error, attempt, "[guide-review] JSON parse failed (repair did not help)")
            }
        }
    }
    Err(format!(
        "guide review JSON parse failed after 2 attempts: {last_raw}"
    ))
}

/// Parse a raw model reply into a review: isolate the JSON object, and if a
/// straight parse fails, run the bracket repairer and try once more. The
/// returned flag says whether repair was needed (for the log).
fn parse_review(raw: &str) -> Result<(GuideReview, bool), serde_json::Error> {
    let isolated = isolate_json_object(raw).unwrap_or_else(|| raw.to_string());
    match serde_json::from_str::<GuideReview>(&isolated) {
        Ok(review) => Ok((review, false)),
        Err(error) => {
            // Almost-valid output (missing bracket, truncated tail) is common
            // from the local model — repair before spending another
            // generation attempt.
            let Some(repaired) = crate::meeting::json_repair::repair_json(&isolated) else {
                return Err(error);
            };
            match serde_json::from_str::<GuideReview>(&repaired) {
                Ok(review) => Ok((review, true)),
                Err(_) => Err(error),
            }
        }
    }
}

fn build_review_chunks(segments: &[Segment]) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for (index, segment) in segments.iter().enumerate() {
        if segment.text.trim().is_empty() {
            continue;
        }
        let speaker = match segment.speaker {
            Speaker::You => "You",
            Speaker::Them => "Them",
        };
        let line = format!(
            "[s{index}|{}-{}|{speaker}] {}\n",
            segment.start_ms,
            segment.end_ms,
            segment.text.trim()
        );
        if !current.is_empty() && current.len() + line.len() > MAX_REVIEW_BYTES {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(&line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn validate_review(review: &mut GuideReview, segments: &[Segment], options: &ReviewOptions) {
    for item in &mut review.scorecard {
        item.evidence_refs
            .retain(|evidence| valid_evidence_ref(evidence, segments));
        if let Some(first) = item.evidence_refs.first() {
            item.evidence = first.quote.clone();
        }
        let verdict = item.verdict.to_ascii_lowercase();
        if options.insight_kind == "signals" {
            if !matches!(
                verdict.as_str(),
                "not_observed" | "light" | "clear" | "strong"
            ) {
                item.verdict = "not_observed".into();
            } else if verdict != "not_observed" && item.evidence_refs.is_empty() {
                item.verdict = "not_observed".into();
                item.evidence.clear();
                item.why = "No exact transcript evidence was available.".into();
            }
        } else if !matches!(verdict.as_str(), "met" | "partial" | "missed" | "unknown") {
            item.verdict = "unknown".into();
        } else if matches!(verdict.as_str(), "met" | "partial" | "missed")
            && item.evidence_refs.is_empty()
        {
            item.verdict = "unknown".into();
            item.evidence.clear();
            item.why = "No exact transcript evidence was available.".into();
        }
    }
    for item in &mut review.emergent {
        item.evidence_refs
            .retain(|evidence| valid_evidence_ref(evidence, segments));
        if let Some(first) = item.evidence_refs.first() {
            item.evidence = first.quote.clone();
        }
    }
    review
        .emergent
        .retain(|item| !item.evidence_refs.is_empty());
}

fn valid_evidence_ref(reference: &EvidenceRef, segments: &[Segment]) -> bool {
    let Some(segment) = segments.get(reference.segment_index) else {
        return false;
    };
    if reference.start_ms != segment.start_ms || reference.end_ms != segment.end_ms {
        return false;
    }
    let quote = reference.quote.trim().to_lowercase();
    !quote.is_empty() && segment.text.to_lowercase().contains(&quote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str) -> Segment {
        Segment {
            speaker: Speaker::You,
            start_ms: 100,
            end_ms: 400,
            text: text.into(),
        }
    }

    #[test]
    fn parses_review_with_array_where_string_expected() {
        // Real failure 2026-08-03 ("Emotional signals"): the model emitted an
        // array of quotes for `evidence`, which must not fail the review.
        let json = r#"{
            "overall": "mixed",
            "synthesis": "Functional exchange.",
            "scorecard": [{
                "criterion": "frustration",
                "verdict": "partial",
                "evidence": ["j'ai ce que tu veux.", "Il y a trop de trucs."],
                "evidence_refs": [],
                "why": "",
                "tip": ""
            }]
        }"#;
        let (review, repaired) = parse_review(json).unwrap();
        assert!(!repaired);
        assert_eq!(
            review.scorecard[0].evidence,
            "j'ai ce que tu veux.; Il y a trop de trucs."
        );
    }

    #[test]
    fn parses_review_with_unclosed_emergent_list() {
        // Real failure 2026-08-03 ("Leadership presence"): missing `]` before
        // the final `}` — the bracket repairer must recover it.
        let json = r#"{
            "overall": "weak",
            "synthesis": "Lacked structure.",
            "scorecard": [],
            "emergent": [
                {"observation": "drifted", "evidence": "", "evidence_refs": []},
                {"observation": "contention", "evidence": "", "evidence_refs": []}
        }"#;
        let (review, repaired) = parse_review(json).unwrap();
        assert!(repaired);
        assert_eq!(review.emergent.len(), 2);
        assert_eq!(review.overall, "weak");
    }

    #[test]
    fn parses_review_truncated_mid_structure() {
        // Real failure 2026-08-03 ("Sales conversation"): output stops before
        // the root object closes.
        let json = r#"{
            "overall": "mixed",
            "synthesis": "ok",
            "scorecard": [
                {"criterion": "x", "verdict": "met", "evidence": "", "evidence_refs": [], "why": "solid", "tip": ""},
                {"criterion": "y", "verdict": "part"#;
        let (review, repaired) = parse_review(json).unwrap();
        assert!(repaired);
        assert_eq!(review.overall, "mixed");
        assert!(!review.scorecard.is_empty());
        assert_eq!(review.scorecard[0].criterion, "x");
    }

    #[test]
    fn unrepairable_output_still_errors() {
        assert!(parse_review("total nonsense, no json").is_err());
    }

    // Real-data harness (no-op in CI): point ECHO_SCRIBE_RAW_REVIEW_DIR at a
    // directory of raw model outputs (e.g. extracted from failed
    // meeting_guide_runs.error rows) to check they all parse. Used to verify
    // the 2026-08-03 production failures end-to-end.
    #[test]
    fn real_failed_payloads_parse_when_dir_provided() {
        let Ok(dir) = std::env::var("ECHO_SCRIBE_RAW_REVIEW_DIR") else {
            return;
        };
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).unwrap();
            let (review, repaired) = parse_review(&raw)
                .unwrap_or_else(|e| panic!("{} still fails: {e}", path.display()));
            assert!(
                !review.scorecard.is_empty() || !review.emergent.is_empty(),
                "{} parsed to an empty review",
                path.display()
            );
            eprintln!(
                "{}: ok (repaired={repaired}, criteria={}, emergent={})",
                path.file_name().unwrap().to_string_lossy(),
                review.scorecard.len(),
                review.emergent.len()
            );
        }
    }

    #[test]
    fn parses_legacy_review_json_with_missing_fields() {
        let json = r#"{
            "overall":"mixed",
            "synthesis":"Clear but light on closure.",
            "scorecard":[{"criterion":"owner + date","verdict":"missed","evidence":"no dates"}]
        }"#;
        let review: GuideReview = serde_json::from_str(json).unwrap();
        assert_eq!(review.scorecard[0].verdict, "missed");
        assert!(review.scorecard[0].evidence_refs.is_empty());
    }

    #[test]
    fn chunks_preserve_segment_coordinates() {
        let chunks = build_review_chunks(&[segment("Thanks for helping")]);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains("[s0|100-400|You] Thanks for helping"));
    }

    #[test]
    fn fabricated_signal_evidence_is_downgraded() {
        let segments = [segment("Thanks for helping")];
        let mut review = GuideReview {
            scorecard: vec![ScorecardItem {
                criterion: "anger".into(),
                verdict: "strong".into(),
                evidence_refs: vec![EvidenceRef {
                    segment_index: 0,
                    start_ms: 100,
                    end_ms: 400,
                    quote: "I am furious".into(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        validate_review(
            &mut review,
            &segments,
            &ReviewOptions {
                insight_kind: "signals".into(),
                subject_scope: "interaction".into(),
            },
        );
        assert_eq!(review.scorecard[0].verdict, "not_observed");
        assert!(review.scorecard[0].evidence_refs.is_empty());
    }
}
