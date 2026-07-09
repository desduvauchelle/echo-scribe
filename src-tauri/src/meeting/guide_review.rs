//! Whole-transcript guide review, generated once per attached guide after a
//! meeting stops. Produces a coaching scorecard (one graded criterion per
//! template `notes` line), 1-2 emergent observations, and a synthesis vs the
//! template `goal`. Reuses the synthesizer's chunked map-reduce for long
//! transcripts. JSON is parsed loosely, mirroring the live guidance engine.

use crate::db::guide_templates::GuideTemplate;
use crate::llm::{GenerateRequest, Llm};
use crate::meeting::guidance::isolate_json_object;
use crate::meeting::Segment;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

/// Byte budget for the transcript in the review prompt; above this we condense
/// via the synthesizer's map-reduce first. Matches the synthesizer's own budget.
const MAX_REVIEW_BYTES: usize = 18_000;

/// `max_tokens` for the review JSON (scorecard can be long).
const REVIEW_MAX_TOKENS: usize = 1536;

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
    #[serde(default)]
    pub evidence: String,
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
}

pub async fn generate_review(
    llm: Arc<Llm>,
    template: &GuideTemplate,
    segments: &[Segment],
) -> Result<GuideReview, String> {
    let flat = crate::meeting::synthesizer::flatten_transcript(segments);
    if flat.trim().is_empty() {
        return Err("empty transcript".into());
    }
    let transcript = if flat.len() <= MAX_REVIEW_BYTES {
        flat
    } else {
        let condensed = crate::meeting::synthesizer::condense_transcript(llm.as_ref(), &flat).await?;
        format!("[Note: transcript condensed due to length]\n\n{condensed}")
    };

    let (system, user) =
        crate::llm::prompt::build_guide_review_prompt(&template.goal, &template.notes, &transcript);

    let mut last_raw = String::new();
    for attempt in 0..2u8 {
        let temperature = if attempt == 0 { 0.3 } else { 0.1 };
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: REVIEW_MAX_TOKENS,
            temperature,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(16384),
        };
        let raw = match llm.generate(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(target: "guide", ?e, attempt, "[guide-review] generate failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {e}"));
                }
                continue;
            }
        };
        last_raw = raw.clone();
        let isolated = isolate_json_object(&raw).unwrap_or_else(|| raw.clone());
        match serde_json::from_str::<GuideReview>(&isolated) {
            Ok(review) => {
                info!(
                    target: "guide",
                    criteria = review.scorecard.len(),
                    emergent = review.emergent.len(),
                    overall = %review.overall,
                    "[guide-review] parsed ok"
                );
                return Ok(review);
            }
            Err(e) => warn!(target: "guide", ?e, attempt, "[guide-review] JSON parse failed"),
        }
    }
    Err(format!("guide review JSON parse failed after 2 attempts: {last_raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_loose_review_json_with_missing_fields() {
        // Missing `tip`/`emergent`/`why` must default, not error.
        let json = r#"{
            "overall":"mixed",
            "synthesis":"Clear but light on closure.",
            "scorecard":[{"criterion":"owner + date","verdict":"missed","evidence":"no dates"}]
        }"#;
        let r: GuideReview = serde_json::from_str(json).unwrap();
        assert_eq!(r.overall, "mixed");
        assert_eq!(r.scorecard.len(), 1);
        assert_eq!(r.scorecard[0].verdict, "missed");
        assert_eq!(r.scorecard[0].tip, "");
        assert!(r.emergent.is_empty());
    }

    #[test]
    fn review_round_trips_through_serde() {
        let r = GuideReview {
            overall: "strong".into(),
            synthesis: "s".into(),
            scorecard: vec![ScorecardItem {
                criterion: "c".into(),
                verdict: "met".into(),
                evidence: "e".into(),
                why: "w".into(),
                tip: "".into(),
            }],
            emergent: vec![EmergentItem { observation: "o".into(), evidence: "e".into() }],
        };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<GuideReview>(&s).unwrap(), r);
    }
}
