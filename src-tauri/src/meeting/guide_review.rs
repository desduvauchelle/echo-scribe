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
    #[serde(default)]
    pub overall: String,
    #[serde(default)]
    pub synthesis: String,
    #[serde(default)]
    pub scorecard: Vec<ScorecardItem>,
    #[serde(default)]
    pub emergent: Vec<EmergentItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ScorecardItem {
    #[serde(default)]
    pub criterion: String,
    #[serde(default)]
    pub verdict: String,
    /// Kept for backwards compatibility with reviews created before evidence
    /// references were introduced.
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub tip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EmergentItem {
    #[serde(default)]
    pub observation: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
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
        let isolated = isolate_json_object(&raw).unwrap_or(raw);
        match serde_json::from_str::<GuideReview>(&isolated) {
            Ok(review) => {
                info!(target: "guide", criteria=review.scorecard.len(), emergent=review.emergent.len(), overall=%review.overall, "[guide-review] parsed ok");
                return Ok(review);
            }
            Err(error) => {
                warn!(target: "guide", ?error, attempt, "[guide-review] JSON parse failed")
            }
        }
    }
    Err(format!(
        "guide review JSON parse failed after 2 attempts: {last_raw}"
    ))
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
