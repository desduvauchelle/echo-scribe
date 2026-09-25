//! Prompt assembly + JSON parsing for the daily recap.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::daily_summary::collector::DailySummaryInput;

/// Per-section bullet emitted by the LLM. `source_id` may be missing — the
/// renderer degrades to a non-clickable bullet in that case.
///
/// Tolerant deserialization: accepts either the structured form
/// `{"text": "...", "source_id": "..."}` or a bare string. Models without
/// GBNF enforcement sometimes emit `["foo", "bar"]` instead of
/// `[{"text":"foo"}, {"text":"bar"}]`, especially for shorter sections.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SectionItem {
    pub text: String,
    #[serde(default)]
    pub source_id: Option<String>,
}

impl<'de> Deserialize<'de> for SectionItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Untagged enum trick: try object form first, fall back to bare string.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Object {
                text: String,
                #[serde(default)]
                source_id: Option<String>,
            },
            String(String),
        }
        Ok(match Either::deserialize(deserializer)? {
            Either::Object { text, source_id } => SectionItem { text, source_id },
            Either::String(s) => SectionItem {
                text: s,
                source_id: None,
            },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Sections {
    #[serde(default)]
    pub what_happened: Vec<SectionItem>,
    #[serde(default)]
    pub what_mattered: Vec<SectionItem>,
    #[serde(default)]
    pub whats_next: Vec<SectionItem>,

    // Recaps generated before the outcome-based format used source-type
    // sections. Keep reading those rows so an app update does not make
    // existing history look empty; newly generated recaps never write them.
    #[serde(default)]
    #[serde(skip_serializing)]
    pub meetings: Vec<SectionItem>,
    #[serde(default)]
    #[serde(skip_serializing)]
    pub focus_work: Vec<SectionItem>,
    #[serde(default)]
    #[serde(skip_serializing)]
    pub notes: Vec<SectionItem>,
    #[serde(default)]
    #[serde(skip_serializing)]
    pub things_that_came_up: Vec<SectionItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DailySummaryOutput {
    pub narrative: String,
    #[serde(default)]
    pub sections: Sections,
}

/// Days with at most this many (non-noise) dictations send them to the
/// recap prompt verbatim. Above it, dictations are first digested into
/// chronological work sessions so the recap sees the *whole* day — the old
/// "first 15 per app" cap silently dropped ~75% of a busy day.
const RAW_DICTATION_LIMIT: usize = 15;

/// Per-item character caps. Tokens are roughly chars/4 for English-ish
/// content; these caps keep the per-item contribution bounded.
const MEETING_SUMMARY_CAP_CHARS: usize = 1_500;
const NOTE_CAP_CHARS: usize = 600;
const DICTATION_CAP_CHARS: usize = 400;
/// Dictation length inside a session-digest sub-prompt.
const SESSION_DICTATION_CAP_CHARS: usize = 350;

/// A work session closes when the next dictation is this far away…
const SESSION_GAP_MINUTES: i64 = 60;
/// …or when its digest input would exceed this many chars / dictations.
const SESSION_MAX_CHARS: usize = 6_000;
const SESSION_MAX_ITEMS: usize = 30;

/// Soft budget for the assembled user-prompt string. Targets ~12K tokens
/// (rule of thumb 4 chars/token), leaving headroom inside the runtime's 16K
/// n_ctx for the system prompt + response.
const MAX_USER_PROMPT_CHARS: usize = 48_000;

fn truncate(s: &str, max: usize) -> String {
    crate::daily_summary::collector::truncate_chars(s, max)
}

/// One chronological stretch of dictations, digested by the LLM into a few
/// "topic: what happened" lines.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkSession {
    pub start: String,
    pub end: String,
    pub count: usize,
    pub apps: Vec<String>,
    pub digest: String,
}

/// What the final recap prompt sees for dictations.
#[derive(Debug, Clone, PartialEq)]
pub enum DictationView<'a> {
    Raw(Vec<&'a ItemForSummary>),
    Sessions(Vec<WorkSession>),
}

/// Dictations that carry no information about the day: agent housekeeping
/// ("commit and push", "do it", "yes please") and one-to-three word replies.
/// Left in, the model dutifully turns them into "What's next: commit and push".
pub fn is_noise_dictation(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    let words = lower.split_whitespace().count();
    if words <= 3 {
        return true;
    }
    if words <= 10 && lower.contains("commit") && lower.contains("push") {
        return true;
    }
    const FILLERS: &[&str] = &[
        "do it", "go ahead", "go for it", "sounds good", "yes please", "yes, please",
        "let's do it", "make it happen", "continue", "alright, add it",
    ];
    words <= 6 && FILLERS.iter().any(|f| lower.contains(f))
}

pub fn meaningful_dictations(input: &DailySummaryInput) -> Vec<&ItemForSummary> {
    input
        .dictations
        .iter()
        .filter(|d| !is_noise_dictation(&d.content))
        .collect()
}

fn dictation_line(d: &ItemForSummary, cap: usize) -> String {
    let place = match &d.context {
        Some(c) => format!("{} · {}", d.app, c),
        None => d.app.clone(),
    };
    format!(
        "{} [{}] {}",
        local_clock(&d.captured_at),
        place,
        truncate(d.content.trim(), cap).replace('\n', " ")
    )
}

/// Split dictations into chronological chunks: a new chunk starts after a
/// long gap or once the chunk is big enough to digest in one small call.
pub fn chunk_sessions<'a>(items: &[&'a ItemForSummary]) -> Vec<Vec<&'a ItemForSummary>> {
    let mut out: Vec<Vec<&ItemForSummary>> = Vec::new();
    let mut cur: Vec<&ItemForSummary> = Vec::new();
    let mut cur_chars = 0usize;
    let mut last_ts: Option<chrono::DateTime<chrono::FixedOffset>> = None;
    for &d in items {
        let ts = chrono::DateTime::parse_from_rfc3339(&d.captured_at).ok();
        let gap = matches!((last_ts, ts), (Some(a), Some(b)) if (b - a).num_minutes() >= SESSION_GAP_MINUTES);
        let line_len = dictation_line(d, SESSION_DICTATION_CAP_CHARS).len() + 1;
        if !cur.is_empty()
            && (gap || cur.len() >= SESSION_MAX_ITEMS || cur_chars + line_len > SESSION_MAX_CHARS)
        {
            out.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        cur.push(d);
        cur_chars += line_len;
        if ts.is_some() {
            last_ts = ts;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Build the system + user prompt strings. Enforces per-item caps and the
/// total prompt budget so the model never sees more than its context holds.
pub fn build_prompt(input: &DailySummaryInput, dictations: &DictationView) -> (String, String) {
    let system = full_system_prompt();
    let mut user = build_user_prompt(input, dictations, usize::MAX);
    // Raw dictations are only used on light days, but a handful of very long
    // meeting summaries could still overflow — shrink the raw list if so.
    let mut keep = match dictations {
        DictationView::Raw(v) => v.len(),
        DictationView::Sessions(_) => 0,
    };
    while user.len() > MAX_USER_PROMPT_CHARS && keep > 0 {
        keep = keep.saturating_sub(2);
        user = build_user_prompt(input, dictations, keep);
    }
    (system, user)
}

fn build_user_prompt(input: &DailySummaryInput, dictations: &DictationView, raw_keep: usize) -> String {
    let mut user = String::new();
    user.push_str(&format!("Date: {}\n\n", input.date));

    if !input.meetings.is_empty() {
        user.push_str("# Meetings (most reliable source for decisions and action items)\n");
        for (i, m) in input.meetings.iter().enumerate() {
            user.push_str(&format!(
                "- [m{}] {} at {}\n",
                i + 1,
                truncate(&m.title, 200),
                local_clock(&m.started_at)
            ));
            if let Some(s) = &m.summary {
                let s = truncate(s, MEETING_SUMMARY_CAP_CHARS);
                for line in s.lines().filter(|l| !l.trim().is_empty()) {
                    user.push_str(&format!("    {}\n", line.trim_end()));
                }
            }
        }
        user.push('\n');
    }

    if !input.notes.is_empty() {
        user.push_str("# Notes the person captured for themselves\n");
        for (i, n) in input.notes.iter().enumerate() {
            let content = truncate(n.content.trim(), NOTE_CAP_CHARS).replace('\n', " ");
            user.push_str(&format!(
                "- [n{}] {} {}\n",
                i + 1,
                local_clock(&n.captured_at),
                content
            ));
        }
        user.push('\n');
    }

    match dictations {
        DictationView::Raw(items) if !items.is_empty() && raw_keep > 0 => {
            user.push_str("# Dictations (mostly spoken to AI assistants; time [app · place] text)\n");
            for (i, d) in items.iter().take(raw_keep).enumerate() {
                user.push_str(&format!(
                    "- [d{}] {}\n",
                    i + 1,
                    dictation_line(d, DICTATION_CAP_CHARS)
                ));
            }
            if items.len() > raw_keep {
                user.push_str(&format!("- ...and {} more dictations\n", items.len() - raw_keep));
            }
            user.push('\n');
        }
        DictationView::Sessions(sessions) if !sessions.is_empty() => {
            user.push_str("# Work sessions (digested from dictations, chronological)\n");
            for (i, s) in sessions.iter().enumerate() {
                user.push_str(&format!(
                    "- [s{}] {}–{} ({} dictations in {})\n",
                    i + 1,
                    s.start,
                    s.end,
                    s.count,
                    s.apps.join(", ")
                ));
                for line in s.digest.lines().filter(|l| !l.trim().is_empty()) {
                    user.push_str(&format!("    {}\n", line.trim()));
                }
            }
            user.push('\n');
        }
        _ => {}
    }

    user.push_str(STYLE_GUIDANCE);
    user
}

const SYSTEM_PROMPT: &str =
    "You write a short, specific end-of-day recap for one person, like a sharp chief of staff would. Be concrete and honest about the shape of the day. Do not inflate. Respond with strict JSON matching the provided schema.";

/// Meetings, notes, and dictations for one day can each be in a different
/// language (Parakeet transcribes 25 of them); without an explicit rule the
/// model defaults to English, so a French/German-heavy day still produced an
/// English recap. There's no earlier instruction here for the rule to yield
/// to, so this always resolves to "match the sources".
fn language_directive() -> String {
    format!(
        "{} The day's sources may mix languages — follow whichever language dominates.",
        crate::llm::prompt::language_rule(
            "the day's source material below (meetings, notes, and dictations)"
        )
    )
}

/// Full system prompt, including the language directive. Shared by
/// [`build_prompt`] and [`prompt_version`] so the version hash always
/// reflects what the model is actually told.
fn full_system_prompt() -> String {
    format!("{SYSTEM_PROMPT} {}", language_directive())
}

const STYLE_GUIDANCE: &str = r#"
Produce JSON with this shape:
{
  "narrative": "1-2 sentences naming the day's main threads",
  "sections": {
    "what_happened": [{ "text": "Topic: what happened", "source_id": "s1" }],
    "what_mattered": [{ "text": "Topic: the decision or consequence", "source_id": "m1" }],
    "whats_next":    [{ "text": "Topic: the open item", "source_id": "m1" }]
  }
}

How to read the input:
- The person builds software products. Most dictations are them talking to AI assistants and coding agents (Claude, ChatGPT, Codex, Cursor, terminals): instructions, feedback, and thinking out loud. Use them to tell what the person worked on. They are NOT the person's to-do list — the agent usually did that work on the spot.
- Meetings are the most reliable source for decisions and action items.
- Transcripts contain speech-recognition errors. Use the obviously intended word, or leave a garbled term out. Never repeat nonsense.

Writing rules:
- Every bullet starts with a short topic (the product, feature, customer, or person), a colon, then what happened. Example: "LiveCase nurturing emails: rewrote the follow-up so it speaks to case writers, not instructors."
- Use the concrete names from the input. Active voice, past tense, at most 25 words per bullet.
- Banned filler: "a discussion centered on", "there was a focus on", "various", "several dictations", "significant", "heavily focused", "refinement", "exploration of".
- narrative: 1-2 plain sentences naming the 2-3 main threads. Example: "Mostly LiveCase: nurturing emails and the Lucy task list, plus a pricing call about creator monetization."
- what_happened: 3-7 bullets, one per main thread, biggest first. Cover every work session and meeting: merge sessions about the same product into one bullet, and never spend two bullets on one thread.
- what_mattered: 0-4 bullets. Only real decisions, changes of direction, problems discovered, or things shipped. Do not restate a what_happened bullet; state the decision or its consequence. Leave it empty rather than pad it.
- whats_next: 0-5 bullets. Only open items: meeting action items, things the person said they will do later or put on hold, unresolved problems. Never list an instruction the person gave an AI agent (like "commit and push", "fix the padding", "add a button"). Leave it empty rather than pad it. Never invent a task, decision, commitment, owner, date, or urgency.
- For each bullet, set `source_id` to the [m#]/[n#]/[s#]/[d#] tag it draws from. If it draws from several or you are unsure, omit `source_id`.
- Do not include any text outside the JSON object.
"#;

const SESSION_DIGEST_PROMPT: &str = "You turn a stretch of one person's voice dictations into a short work log. Most dictations are the person talking to AI assistants and coding agents (instructions, feedback, thinking out loud) or writing messages. Infer what they were working on and what changed. Output 1-4 lines, each starting with \"- \". Start each line with the real product or feature name taken from the dictations, a colon, then what they worked on, decided, or asked for. Good: \"- Lucy task list: merged loop tasks into the main task list, with filters per loop.\" Bad: \"- Project: Task management: unify tasks.\" Never use the words Project, Feature, or Topic as the name. At most 25 words per line. Merge related dictations into one line. Keep it if the person states a decision or a plan for later, and say so (\"decided…\", \"put … on hold\", \"plans to…\"). Skip housekeeping (commit/push, \"do it\", \"yes\"). Speech-recognition errors are common (\"Cloud\" or \"Clod\" usually means Claude): use the obviously intended word or leave it out. Never invent details. Plain text lines only, no preamble.";

/// GBNF grammar that forces the model to emit JSON matching the schema.
///
/// Loose-typed (strings/arrays only), permissive about whitespace. The model
/// can still produce empty arrays, missing optional fields, etc.
pub const OUTPUT_GRAMMAR: &str = r##"
root        ::= ws "{" ws "\"narrative\"" ws ":" ws string ws "," ws "\"sections\"" ws ":" ws sections ws "}" ws
sections    ::= "{" ws section-entry ("," ws section-entry)* ws "}"
section-entry ::= section-key ws ":" ws section-arr
section-key ::= "\"what_happened\"" | "\"what_mattered\"" | "\"whats_next\""
section-arr ::= "[" ws ( item ( ws "," ws item )* )? ws "]"
item        ::= "{" ws "\"text\"" ws ":" ws string ( ws "," ws "\"source_id\"" ws ":" ws ( string | "null" ) )? ws "}"
string      ::= "\"" char* "\""
char        ::= [^"\\] | "\\" ["\\/bfnrt]
ws          ::= [ \t\n\r]*
"##;

/// Stable short hash of the prompt so we can identify the prompt version
/// alongside the LLM model id in `daily_summaries.model_version`.
pub fn prompt_version() -> String {
    let mut h = Sha256::new();
    h.update(full_system_prompt().as_bytes());
    h.update(STYLE_GUIDANCE.as_bytes());
    h.update(SESSION_DIGEST_PROMPT.as_bytes());
    h.update(OUTPUT_GRAMMAR.as_bytes());
    let digest = h.finalize();
    digest[..4].iter().map(|b| format!("{:02x}", b)).collect()
}

use tracing::{info, warn};

use crate::daily_summary::collector::{local_clock, ItemForSummary};
use crate::llm::{GenerateRequest, Llm, LlmError};

/// Generate a daily summary with the local LLM.
///
/// Light days send dictations verbatim. Busier days first digest dictations
/// into chronological work sessions (one small LLM call each) so the final
/// prompt covers the whole day instead of a truncated slice of it.
pub async fn generate(
    llm: &Llm,
    input: &DailySummaryInput,
) -> Result<DailySummaryOutput, GenerateError> {
    let meaningful = meaningful_dictations(input);
    info!(
        target: "daily_summary",
        dictations = input.dictations.len(),
        meaningful = meaningful.len(),
        "daily_summary: filtered noise dictations"
    );
    let view = if meaningful.len() <= RAW_DICTATION_LIMIT {
        DictationView::Raw(meaningful)
    } else {
        DictationView::Sessions(digest_sessions(llm, &meaningful).await)
    };
    let (system, user) = build_prompt(input, &view);
    info!(
        target: "daily_summary",
        prompt_chars = user.len(),
        sessions = matches!(view, DictationView::Sessions(ref s) if !s.is_empty()),
        "daily_summary: recap prompt built"
    );
    call(llm, system, user).await
}

async fn call(
    llm: &Llm,
    system: String,
    user: String,
) -> Result<DailySummaryOutput, GenerateError> {
    // GBNF intentionally not used: llama.cpp's grammar sampler aborts the
    // entire process via `ggml_abort` when no candidate token matches the
    // grammar at a given step, which is unrecoverable from Rust. We rely
    // instead on prompt-based JSON instruction (see STYLE_GUIDANCE) plus
    // the lenient `parse_response`; malformed output becomes a `failed`
    // row, not a SIGABRT.
    let raw = llm
        .generate(GenerateRequest {
            system: Some(system),
            user,
            history: Vec::new(),
            max_tokens: 1536,
            temperature: 0.3,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(16384),
        })
        .await
        .map_err(GenerateError::Llm)?;
    parse_response(&raw).map_err(|e| {
        // Log a generous prefix of the raw output so future parse failures
        // are diagnosable without re-running. Truncated to keep one line.
        let preview: String = raw.chars().take(800).collect();
        warn!(
            error = %e,
            raw_len = raw.len(),
            raw_preview = %preview,
            "daily_summary: parse failure"
        );
        GenerateError::Parse(e)
    })
}

/// Digest each chronological chunk of dictations. A chunk whose digest call
/// fails degrades to its first few raw dictations rather than vanishing.
async fn digest_sessions(llm: &Llm, items: &[&ItemForSummary]) -> Vec<WorkSession> {
    let chunks = chunk_sessions(items);
    let mut out = Vec::with_capacity(chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        let mut apps: Vec<String> = Vec::new();
        for d in chunk {
            if !apps.contains(&d.app) {
                apps.push(d.app.clone());
            }
        }
        let start = local_clock(&chunk[0].captured_at);
        let end = local_clock(&chunk[chunk.len() - 1].captured_at);
        let digest = match digest_one_session(llm, chunk).await {
            Ok(d) if !d.trim().is_empty() => d,
            Ok(_) | Err(_) => {
                warn!(
                    target: "daily_summary",
                    session = i + 1,
                    items = chunk.len(),
                    "daily_summary: session digest failed or empty; using raw excerpt"
                );
                chunk
                    .iter()
                    .take(5)
                    .map(|d| format!("- {}", truncate(d.content.trim(), 160).replace('\n', " ")))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        };
        info!(
            target: "daily_summary",
            session = i + 1,
            items = chunk.len(),
            %start,
            %end,
            digest = %digest.replace('\n', " | "),
            "daily_summary: session digested"
        );
        out.push(WorkSession {
            start,
            end,
            count: chunk.len(),
            apps,
            digest,
        });
    }
    out
}

async fn digest_one_session(llm: &Llm, chunk: &[&ItemForSummary]) -> Result<String, GenerateError> {
    let lines: String = chunk
        .iter()
        .map(|d| format!("{}\n", dictation_line(d, SESSION_DICTATION_CAP_CHARS)))
        .collect();
    let req = GenerateRequest {
        system: Some(SESSION_DIGEST_PROMPT.into()),
        user: format!("Dictations (time [app · place] text):\n{lines}\nWork log:"),
        history: Vec::new(),
        max_tokens: 260,
        temperature: 0.2,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
        n_ctx: Some(4096),
    };
    let raw = llm.generate(req).await.map_err(GenerateError::Llm)?;
    Ok(clean_digest(&raw))
}

/// The 2B model sometimes copies the prompt's placeholder as the topic
/// ("Project: Task list: …", "Project or feature: …"). Drop that prefix.
fn strip_placeholder_topic(line: &str) -> &str {
    const PLACEHOLDERS: &[&str] = &["project or feature:", "project:", "feature:", "topic:"];
    let lower = line.to_lowercase();
    for p in PLACEHOLDERS {
        if lower.starts_with(p) {
            return line[p.len()..].trim_start();
        }
    }
    line
}

/// Keep only bullet-ish lines, normalised to "- …". Drops any preamble the
/// model adds ("Here is the work log:").
pub fn clean_digest(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter_map(|l| {
            let body = l
                .strip_prefix("- ")
                .or_else(|| l.strip_prefix("* "))
                .or_else(|| l.strip_prefix("• "))?;
            let body = strip_placeholder_topic(body.trim());
            (!body.is_empty()).then(|| format!("- {body}"))
        })
        .take(5)
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, thiserror::Error)]
pub enum GenerateError {
    #[error("llm failure: {0}")]
    Llm(LlmError),
    #[error("parse failure: {0}")]
    Parse(ParseError),
}

/// Parse the LLM response into a typed output. Tolerates code fences,
/// leading/trailing prose, and other slop the model emits when not
/// constrained by a grammar — we extract the first balanced `{...}` object
/// from the raw text and parse that.
pub fn parse_response(raw: &str) -> Result<DailySummaryOutput, ParseError> {
    let json_slice = extract_first_json_object(raw)
        .ok_or_else(|| ParseError::Json("no balanced JSON object found in response".into()))?;
    let v: serde_json::Value =
        serde_json::from_str(json_slice).map_err(|e| ParseError::Json(e.to_string()))?;
    let mut out: DailySummaryOutput =
        serde_json::from_value(v).map_err(|e| ParseError::Schema(e.to_string()))?;
    for item in out
        .sections
        .what_happened
        .iter_mut()
        .chain(out.sections.what_mattered.iter_mut())
        .chain(out.sections.whats_next.iter_mut())
    {
        item.text = strip_trailing_source_tag(&item.text);
    }
    if out.narrative.trim().is_empty() {
        return Err(ParseError::Schema("narrative is empty".into()));
    }
    Ok(out)
}

/// Models sometimes echo the source tag into the text ("… pricing. (m1)").
/// The tag already lives in `source_id`; drop it from the prose.
fn strip_trailing_source_tag(text: &str) -> String {
    let t = text.trim_end();
    let Some(open) = t.rfind(['(', '[']) else {
        return t.to_string();
    };
    let tail = &t[open..];
    let inner = tail.trim_start_matches(['(', '[']).trim_end_matches([')', ']']);
    let is_tag = (tail.ends_with(')') || tail.ends_with(']'))
        && inner
            .split([',', ' '])
            .filter(|p| !p.is_empty())
            .all(|p| {
                let mut c = p.chars();
                matches!(c.next(), Some('m' | 'n' | 's' | 'd'))
                    && !c.as_str().is_empty()
                    && c.as_str().chars().all(|ch| ch.is_ascii_digit())
            });
    if is_tag {
        t[..open].trim_end().to_string()
    } else {
        t.to_string()
    }
}

/// Scan `raw` for the first balanced `{...}` JSON object, respecting strings
/// and escapes so that braces inside string literals don't count toward
/// depth. Returns a slice into `raw` or `None` if no balanced object is
/// found. This is good-enough JSON extraction — it doesn't validate the
/// JSON, just finds the slice boundaries; full validation happens at the
/// `serde_json::from_str` step.
fn extract_first_json_object(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&raw[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("invalid JSON: {0}")]
    Json(String),
    #[error("schema mismatch: {0}")]
    Schema(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daily_summary::collector::{ItemForSummary, MeetingForSummary};

    fn empty_input(date: &str) -> DailySummaryInput {
        DailySummaryInput {
            date: date.into(),
            meetings: vec![],
            notes: vec![],
            dictations: vec![],
        }
    }

    fn dictation(id: &str, at: &str, text: &str) -> ItemForSummary {
        ItemForSummary {
            id: id.into(),
            content: text.into(),
            captured_at: at.into(),
            app: "Claude".into(),
            context: None,
        }
    }

    fn prompt(input: &DailySummaryInput) -> (String, String) {
        let view = DictationView::Raw(meaningful_dictations(input));
        build_prompt(input, &view)
    }

    #[test]
    fn prompt_includes_date_and_schema() {
        let (system, user) = prompt(&empty_input("2026-05-12"));
        assert!(system.contains("Respond with strict JSON"));
        assert!(user.contains("Date: 2026-05-12"));
        assert!(user.contains("\"narrative\""));
        assert!(user.contains("\"what_happened\""));
        assert!(user.contains("\"what_mattered\""));
        assert!(user.contains("\"whats_next\""));
        assert!(user.contains("They are NOT the person's to-do list"));
        assert!(user.contains("Never invent a task, decision, commitment, owner, date, or urgency"));
    }

    // ── language-follow rule ─────────────────────────────────────────────
    //
    // The day's source material (meetings, notes, dictations) can be in any
    // of Parakeet's 25 languages; the recap must follow it instead of
    // defaulting to English.

    #[test]
    fn prompt_system_carries_the_language_rule() {
        let (system, _user) = prompt(&empty_input("2026-05-12"));
        assert!(
            system.contains(&crate::llm::prompt::language_rule(
                "the day's source material below (meetings, notes, and dictations)"
            )),
            "got: {system}"
        );
    }

    #[test]
    fn prompt_system_notes_dominant_language_for_mixed_sources() {
        // A day can mix a German meeting with English dictations; the
        // recap should follow whichever language dominates, not just "the
        // transcript" (singular) framing the other prompts use.
        let (system, _user) = prompt(&empty_input("2026-05-12"));
        assert!(
            system.contains("follow whichever language dominates"),
            "got: {system}"
        );
    }

    #[test]
    fn prompt_version_reflects_the_full_system_prompt_not_just_the_static_part() {
        // Regression guard: prompt_version must hash the language-directive-
        // inclusive system prompt, not just the static SYSTEM_PROMPT
        // constant — otherwise this change would silently keep serving
        // cached recaps tagged with the old (English-only) prompt version.
        let mut static_only = Sha256::new();
        static_only.update(SYSTEM_PROMPT.as_bytes());
        static_only.update(STYLE_GUIDANCE.as_bytes());
        static_only.update(SESSION_DIGEST_PROMPT.as_bytes());
        static_only.update(OUTPUT_GRAMMAR.as_bytes());
        let static_digest = static_only.finalize();
        let static_hash: String = static_digest[..4]
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert_ne!(prompt_version(), static_hash);
    }

    #[test]
    fn prompt_includes_meetings_with_title_and_summary_lines() {
        let mut input = empty_input("2026-05-12");
        input.meetings.push(MeetingForSummary {
            id: "long-uuid-1".into(),
            started_at: "2026-05-12T09:00:00Z".into(),
            ended_at: None,
            title: "Roadmap sync".into(),
            summary: Some("## Summary\n- Discussed Q3".into()),
        });
        let (_, user) = prompt(&input);
        assert!(user.contains("[m1] Roadmap sync at "));
        assert!(user.contains("    - Discussed Q3"));
    }

    #[test]
    fn prompt_caps_long_meeting_summary() {
        let mut input = empty_input("2026-05-12");
        input.meetings.push(MeetingForSummary {
            id: "m-1".into(),
            started_at: "2026-05-12T09:00:00Z".into(),
            ended_at: None,
            title: "Call".into(),
            summary: Some("x".repeat(10_000)),
        });
        let (_, user) = prompt(&input);
        assert!(user.len() < 2_000 + STYLE_GUIDANCE.len(), "got {} chars", user.len());
        assert!(user.contains('…'));
    }

    #[test]
    fn noise_dictations_are_filtered() {
        assert!(is_noise_dictation("Add commit and push please."));
        assert!(is_noise_dictation("Add everything, commit and push."));
        assert!(is_noise_dictation("Do it now."));
        assert!(is_noise_dictation("Alright, can you make it happen?"));
        assert!(!is_noise_dictation(
            "The save flow archive and delete should be on top of the page"
        ));
        assert!(!is_noise_dictation("Give it to Lucy tomorrow morning."));
    }

    #[test]
    fn raw_prompt_lists_dictations_with_ids_and_skips_noise() {
        let mut input = empty_input("2026-05-12");
        input.dictations = vec![
            dictation("a", "2026-05-12T10:00:00Z", "Unify the loop tasks with the main task list"),
            dictation("b", "2026-05-12T10:01:00Z", "Commit and push please."),
            dictation("c", "2026-05-12T10:02:00Z", "Hide the workflow ending option for now"),
        ];
        let (_, user) = prompt(&input);
        assert!(user.contains("[d1]"));
        assert!(user.contains("[d2]"));
        assert!(!user.contains("[d3]"));
        assert!(!user.contains("Commit and push"));
        assert!(user.contains("[Claude] Unify the loop tasks"));
    }

    #[test]
    fn sessions_split_on_gap_and_size() {
        let items: Vec<ItemForSummary> = (0..40)
            .map(|i| {
                let hour = if i < 35 { 10 } else { 14 };
                dictation(&format!("d{i}"), &format!("2026-05-12T{hour}:{:02}:00Z", i % 60), "some words here to count")
            })
            .collect();
        let refs: Vec<&ItemForSummary> = items.iter().collect();
        let chunks = chunk_sessions(&refs);
        // 35 items at 10:xx → 30 + 5 (size cap), then a >60min gap → new chunk.
        let sizes: Vec<usize> = chunks.iter().map(|c| c.len()).collect();
        assert_eq!(sizes, vec![30, 5, 5]);
    }

    #[test]
    fn session_view_renders_digests() {
        let input = empty_input("2026-05-12");
        let view = DictationView::Sessions(vec![WorkSession {
            start: "09:00".into(),
            end: "10:30".into(),
            count: 12,
            apps: vec!["Claude".into(), "Arc".into()],
            digest: "- LiveCase emails: rewrote follow-up".into(),
        }]);
        let (_, user) = build_prompt(&input, &view);
        assert!(user.contains("[s1] 09:00–10:30 (12 dictations in Claude, Arc)"));
        assert!(user.contains("    - LiveCase emails: rewrote follow-up"));
    }

    #[test]
    fn clean_digest_drops_preamble_and_normalises_bullets() {
        let raw = "Here is the work log:\n* Tucky: fixed recap\n- Project: LiveCase: emails\n\n• Project or feature: Lucy: tasks\n";
        assert_eq!(
            clean_digest(raw),
            "- Tucky: fixed recap\n- LiveCase: emails\n- Lucy: tasks"
        );
    }

    #[test]
    fn parse_handles_leading_prose() {
        let raw = r#"Sure! Here's your recap:
{"narrative":"x","sections":{"notes":[{"text":"y"}]}}"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "x");
    }

    #[test]
    fn parse_handles_code_fences() {
        let raw = "```json\n{\"narrative\":\"x\",\"sections\":{}}\n```";
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "x");
    }

    #[test]
    fn parse_handles_trailing_prose() {
        let raw = r#"{"narrative":"x","sections":{}} -- generated by AI"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "x");
    }

    #[test]
    fn parse_accepts_bare_string_section_items() {
        // The model sometimes emits ["foo", "bar"] instead of
        // [{"text":"foo"},{"text":"bar"}] without GBNF enforcement.
        let raw = r#"{
            "narrative": "x",
            "sections": {
                "whats_next": [
                    "Gonzalo to conduct a 30-minute discovery call.",
                    "Follow up on Q3 hiring."
                ]
            }
        }"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.sections.whats_next.len(), 2);
        assert_eq!(
            out.sections.whats_next[0].text,
            "Gonzalo to conduct a 30-minute discovery call."
        );
        assert_eq!(out.sections.whats_next[0].source_id, None);
    }

    #[test]
    fn parse_accepts_mixed_string_and_object_section_items() {
        let raw = r#"{
            "narrative": "x",
            "sections": {
                "what_happened": [
                    {"text": "Structured note", "source_id": "n1"},
                    "Bare string note"
                ]
            }
        }"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.sections.what_happened.len(), 2);
        assert_eq!(
            out.sections.what_happened[0].source_id.as_deref(),
            Some("n1")
        );
        assert_eq!(out.sections.what_happened[1].text, "Bare string note");
        assert_eq!(out.sections.what_happened[1].source_id, None);
    }

    #[test]
    fn parse_strips_echoed_source_tags_from_text() {
        let raw = r#"{"narrative":"x","sections":{"what_happened":[
            {"text":"Pricing: usage-based. (m1)","source_id":"m1"},
            {"text":"CDI index: auto-sync [s4, s5]"},
            {"text":"Keep (this part) intact"}]}}"#;
        let out = parse_response(raw).unwrap();
        let texts: Vec<_> = out.sections.what_happened.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["Pricing: usage-based.", "CDI index: auto-sync", "Keep (this part) intact"]
        );
    }

    #[test]
    fn parse_ignores_braces_inside_strings() {
        let raw = r#"{"narrative":"my { brace } content","sections":{}}"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "my { brace } content");
    }

    #[test]
    fn parse_returns_error_when_no_json_object() {
        assert!(matches!(
            parse_response("just plain text, no json"),
            Err(ParseError::Json(_))
        ));
    }

    #[test]
    fn truncate_respects_unicode_boundaries() {
        // 4 code points; max=2 → 2 chars + ellipsis.
        let out = truncate("café", 2);
        assert_eq!(out.chars().count(), 3); // 2 chars + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn parse_valid_output() {
        let raw = r#"{
            "narrative": "Quiet day, mostly focused work.",
            "sections": {
                "what_happened": [],
                "what_mattered": [{"text": "The roadmap decision was ready for review.", "source_id": "d5"}],
                "whats_next": []
            }
        }"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "Quiet day, mostly focused work.");
        assert_eq!(out.sections.what_mattered.len(), 1);
        assert_eq!(
            out.sections.what_mattered[0].source_id.as_deref(),
            Some("d5")
        );
    }

    #[test]
    fn parse_rejects_bad_json() {
        assert!(matches!(
            parse_response("{not json"),
            Err(ParseError::Json(_))
        ));
    }

    #[test]
    fn parse_rejects_empty_narrative() {
        let raw = r#"{"narrative": "", "sections": {}}"#;
        assert!(matches!(parse_response(raw), Err(ParseError::Schema(_))));
    }

    #[test]
    fn parse_handles_missing_source_id() {
        let raw = r#"{"narrative":"x","sections":{"notes":[{"text":"y"}]}}"#;
        let out = parse_response(raw).unwrap();
        assert!(out.sections.notes[0].source_id.is_none());
    }

    #[test]
    fn parses_legacy_sections_without_writing_them_back() {
        let raw = r#"{"narrative":"x","sections":{"meetings":[{"text":"Legacy meeting"}]}}"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.sections.meetings.len(), 1);
        let serialized = serde_json::to_string(&out.sections).unwrap();
        assert!(!serialized.contains("meetings"));
        assert!(serialized.contains("what_happened"));
    }

    #[test]
    fn prompt_version_is_stable() {
        let a = prompt_version();
        let b = prompt_version();
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
    }
}
