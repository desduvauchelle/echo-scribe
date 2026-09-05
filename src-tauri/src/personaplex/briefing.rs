//! Briefing: a compact snapshot of Tucky's data injected into the PersonaPlex
//! persona prompt when a session starts.
//!
//! PersonaPlex has no text channel while a conversation runs — the system
//! prompt is prefilled once, one token per 80 ms frame, into a ~3000-frame
//! rolling context (≈4 minutes). So this is the only way the agent can know
//! anything about the user, AND every token spent here is a frame of
//! conversation memory. The renderer is therefore budgeted hard: sections are
//! filled greedily in priority order with per-item caps, and the result is
//! flattened to a single line before it reaches the tokenizer (newlines are
//! not vocabulary pieces).
//!
//! This file is pure (no DB, no async) so the budgeting is unit-testable; the
//! collector that reads SQLite lives in the parent module.

use serde::{Deserialize, Serialize};

use crate::llm::rag::estimate_tokens;
use crate::llm::GenerateRequest;

pub const DEFAULT_MAX_CHARS: usize = 1400;
/// Above this many estimated tokens the UI warns that the briefing eats a
/// noticeable share of the model's rolling context.
pub const CONTEXT_WARN_TOKENS: usize = 600;

const RECAP_MAX_CHARS: usize = 420;
const RECAP_HIGHLIGHTS: usize = 3;
const HIGHLIGHT_MAX_CHARS: usize = 120;
const TASK_MAX: usize = 8;
const TASK_MAX_CHARS: usize = 110;
const MEETING_MAX: usize = 3;
const MEETING_SUMMARY_MAX_CHARS: usize = 220;
const PROJECT_MAX: usize = 8;
const PROJECT_DESC_MAX_CHARS: usize = 90;
const PERSON_MAX: usize = 10;
const FOCUS_MAX_SNIPPETS: usize = 5;
const FOCUS_SNIPPET_MAX_CHARS: usize = 220;

fn default_true() -> bool {
    true
}
fn default_max_chars() -> usize {
    DEFAULT_MAX_CHARS
}

#[derive(Debug, Clone, Deserialize)]
pub struct BriefingOptions {
    #[serde(default = "default_true")]
    pub recap: bool,
    #[serde(default = "default_true")]
    pub tasks: bool,
    #[serde(default = "default_true")]
    pub meetings: bool,
    #[serde(default = "default_true")]
    pub projects: bool,
    #[serde(default)]
    pub people: bool,
    /// Free-text topic; matching captures are pulled through the same FTS +
    /// chunk ranking the chat uses.
    #[serde(default)]
    pub focus_query: String,
    /// Rewrite the rendered briefing into tight prose with the local Gemma.
    #[serde(default)]
    pub condense: bool,
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
}

#[derive(Debug, Clone, Default)]
pub struct RecapInput {
    /// "Yesterday's", "Today's" or "Sep 3".
    pub label: String,
    pub narrative: String,
    pub highlights: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TaskInput {
    pub text: String,
    pub deadline: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MeetingInput {
    pub date: String,
    pub title: String,
    pub app: Option<String>,
    pub project: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectInput {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PersonInput {
    pub name: String,
    pub role: Option<String>,
    pub company: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FocusInput {
    pub query: String,
    /// (date, kind, content) in relevance order.
    pub snippets: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct BriefingInputs {
    /// "Friday, September 5, 2026"
    pub today: String,
    pub recap: Option<RecapInput>,
    pub tasks: Vec<TaskInput>,
    pub meetings: Vec<MeetingInput>,
    pub projects: Vec<ProjectInput>,
    pub people: Vec<PersonInput>,
    pub focus: Option<FocusInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BriefingPart {
    pub kind: String,
    pub count: usize,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Briefing {
    /// Multi-line, human-readable (the UI shows and lets the user edit this).
    /// [`flatten`] it before handing it to the model.
    pub text: String,
    pub chars: usize,
    pub est_tokens: usize,
    pub parts: Vec<BriefingPart>,
    pub condensed: bool,
    /// Some items did not fit the budget.
    pub truncated: bool,
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Collapse whitespace (including newlines) into single spaces.
pub fn flatten(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whitespace-collapse and cut at a word boundary with an ellipsis.
pub fn clip(text: &str, max_chars: usize) -> String {
    let flat = flatten(text);
    if char_len(&flat) <= max_chars {
        return flat;
    }
    let mut out = String::new();
    for word in flat.split(' ') {
        if char_len(&out) + char_len(word) + 1 > max_chars.saturating_sub(1) {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.is_empty() {
        out = flat.chars().take(max_chars.saturating_sub(1)).collect();
    }
    out.push('…');
    out
}

/// Strip the markdown decoration meeting summaries carry so they read as
/// prose when spoken about.
pub fn strip_markdown(text: &str) -> String {
    text.lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c == '>')
                .trim()
                .replace("**", "")
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn end_sentence(s: &mut String) {
    if !s.ends_with(['.', '!', '?', '…']) {
        s.push('.');
    }
}

struct Section {
    kind: &'static str,
    lead: String,
    items: Vec<String>,
}

fn sections(inputs: &BriefingInputs) -> Vec<Section> {
    let mut out = Vec::new();
    if let Some(f) = &inputs.focus {
        let items: Vec<String> = f
            .snippets
            .iter()
            .take(FOCUS_MAX_SNIPPETS)
            .map(|(date, kind, content)| {
                format!("[{date}, {kind}] {}", clip(content, FOCUS_SNIPPET_MAX_CHARS))
            })
            .collect();
        out.push(Section {
            kind: "focus",
            lead: format!("Their notes about \"{}\":", flatten(&f.query)),
            items,
        });
    }
    if let Some(r) = &inputs.recap {
        let mut items = vec![clip(&r.narrative, RECAP_MAX_CHARS)];
        for h in r.highlights.iter().take(RECAP_HIGHLIGHTS) {
            items.push(clip(h, HIGHLIGHT_MAX_CHARS));
        }
        out.push(Section {
            kind: "recap",
            lead: format!("{} recap:", r.label),
            items,
        });
    }
    let tasks: Vec<String> = inputs
        .tasks
        .iter()
        .take(TASK_MAX)
        .enumerate()
        .map(|(i, t)| {
            let mut s = format!("({}) {}", i + 1, clip(&t.text, TASK_MAX_CHARS));
            if let Some(d) = t.deadline.as_deref().filter(|d| !d.trim().is_empty()) {
                s.push_str(&format!(" (due {})", flatten(d)));
            }
            s
        })
        .collect();
    out.push(Section {
        kind: "tasks",
        lead: "Open tasks:".to_string(),
        items: tasks,
    });
    let meetings: Vec<String> = inputs
        .meetings
        .iter()
        .take(MEETING_MAX)
        .map(|m| {
            let mut s = format!("{}, \"{}\"", m.date, clip(&m.title, 80));
            if let Some(app) = m.app.as_deref().filter(|a| !a.trim().is_empty()) {
                s.push_str(&format!(" on {}", flatten(app)));
            }
            if let Some(p) = m.project.as_deref().filter(|p| !p.trim().is_empty()) {
                s.push_str(&format!(" (project {})", flatten(p)));
            }
            let summary = clip(&strip_markdown(&m.summary), MEETING_SUMMARY_MAX_CHARS);
            if !summary.is_empty() {
                s.push_str(": ");
                s.push_str(&summary);
            }
            s
        })
        .collect();
    out.push(Section {
        kind: "meetings",
        lead: "Recent meetings:".to_string(),
        items: meetings,
    });
    let projects: Vec<String> = inputs
        .projects
        .iter()
        .take(PROJECT_MAX)
        .map(|p| match p.description.as_deref().filter(|d| !d.trim().is_empty()) {
            Some(d) => format!("{} — {}", flatten(&p.name), clip(d, PROJECT_DESC_MAX_CHARS)),
            None => flatten(&p.name),
        })
        .collect();
    out.push(Section {
        kind: "projects",
        lead: "Projects:".to_string(),
        items: projects,
    });
    let people: Vec<String> = inputs
        .people
        .iter()
        .take(PERSON_MAX)
        .map(|p| {
            let extra: Vec<String> = [p.role.as_deref(), p.company.as_deref()]
                .into_iter()
                .flatten()
                .map(flatten)
                .filter(|s| !s.is_empty())
                .collect();
            if extra.is_empty() {
                flatten(&p.name)
            } else {
                format!("{} ({})", flatten(&p.name), extra.join(", "))
            }
        })
        .collect();
    out.push(Section {
        kind: "people",
        lead: "People they work with:".to_string(),
        items: people,
    });
    out
}

/// Render the briefing under `max_chars`, filling sections in priority order
/// (focus → recap → tasks → meetings → projects → people). Items that don't
/// fit are dropped and `truncated` is set; a section with no room for even
/// one item is skipped entirely.
pub fn render(inputs: &BriefingInputs, max_chars: usize) -> Briefing {
    let max_chars = max_chars.max(200);
    let mut text = format!(
        "Today is {}. What you know about the user, from their Tucky notes:",
        flatten(&inputs.today)
    );
    let mut parts = Vec::new();
    let mut truncated = false;

    for sec in sections(inputs) {
        if sec.items.is_empty() {
            continue;
        }
        let mut block = format!("\n{}", sec.lead);
        let mut count = 0usize;
        for item in &sec.items {
            let sep = if count == 0 { " " } else { "; " };
            let needed = char_len(&text) + char_len(&block) + char_len(sep) + char_len(item) + 1;
            if needed > max_chars {
                truncated = true;
                break;
            }
            block.push_str(sep);
            block.push_str(item);
            count += 1;
        }
        if count == 0 {
            continue;
        }
        end_sentence(&mut block);
        parts.push(BriefingPart {
            kind: sec.kind.to_string(),
            count,
            chars: char_len(&block),
        });
        text.push_str(&block);
    }

    if parts.is_empty() {
        // Nothing to say: hand back an empty briefing rather than a bare header.
        return Briefing {
            text: String::new(),
            chars: 0,
            est_tokens: 0,
            parts,
            condensed: false,
            truncated,
        };
    }
    let chars = char_len(&text);
    Briefing {
        est_tokens: estimate_tokens(&text),
        chars,
        text,
        parts,
        condensed: false,
        truncated,
    }
}

/// Swap in a Gemma-condensed rewrite (keeps the section accounting).
pub fn with_condensed_text(mut b: Briefing, text: String) -> Briefing {
    let flat = flatten(&text);
    b.chars = char_len(&flat);
    b.est_tokens = estimate_tokens(&flat);
    b.text = flat;
    b.condensed = true;
    b
}

/// Prompt for the local Gemma to compress a rendered briefing into prose.
pub fn condense_request(raw: &str, target_words: usize) -> GenerateRequest {
    let target_words = target_words.clamp(60, 400);
    GenerateRequest {
        system: Some(format!(
            "You compress background notes into a briefing that a voice assistant reads once \
             before taking a call. Rewrite the notes below as plain prose in at most {target_words} \
             words. Keep every name, date, number, task and project wording exactly as given; do \
             not add facts or advice. Output only the briefing — no preamble, no bullet points, \
             no markdown, no headings."
        )),
        user: raw.to_string(),
        history: Vec::new(),
        max_tokens: 480,
        temperature: 0.2,
        n_ctx: Some(4096),
        ..GenerateRequest::default()
    }
}

/// The text the sidecar receives: persona + briefing, single line.
pub fn compose_prompt(persona: &str, briefing: Option<&str>) -> String {
    let mut out = flatten(persona);
    if let Some(b) = briefing.map(flatten).filter(|b| !b.is_empty()) {
        if !out.is_empty() {
            end_sentence(&mut out);
            out.push(' ');
        }
        out.push_str(&b);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BriefingInputs {
        BriefingInputs {
            today: "Friday, September 5, 2026".into(),
            recap: Some(RecapInput {
                label: "Yesterday's".into(),
                narrative: "The day focused on content delivery strategy and dashboard refinement.".into(),
                highlights: vec!["Shipped the version checker".into()],
            }),
            tasks: vec![
                TaskInput { text: "Send the pricing deck to Acme".into(), deadline: Some("Sep 8".into()) },
                TaskInput { text: "Fix\nthe   export bug".into(), deadline: None },
            ],
            meetings: vec![MeetingInput {
                date: "Sep 4".into(),
                title: "Product delivery sync".into(),
                app: Some("Google Meet".into()),
                project: Some("Recursive Solutions".into()),
                summary: "## Notes\n- Aligned on milestones\n- **Owner**: Denis".into(),
            }],
            projects: vec![ProjectInput { name: "Tucky".into(), description: Some("Voice capture app".into()) }],
            people: vec![PersonInput { name: "Ada".into(), role: Some("CTO".into()), company: Some("Acme".into()) }],
            focus: None,
        }
    }

    #[test]
    fn renders_all_sections_in_priority_order() {
        let b = render(&sample(), 2000);
        assert!(b.text.starts_with("Today is Friday, September 5, 2026."));
        let kinds: Vec<&str> = b.parts.iter().map(|p| p.kind.as_str()).collect();
        assert_eq!(kinds, vec!["recap", "tasks", "meetings", "projects", "people"]);
        assert!(b.text.contains("(1) Send the pricing deck to Acme (due Sep 8); (2) Fix the export bug."));
        assert!(b.text.contains("Sep 4, \"Product delivery sync\" on Google Meet (project Recursive Solutions): Notes Aligned on milestones Owner: Denis."));
        assert!(b.text.contains("Ada (CTO, Acme)."));
        assert!(!b.truncated);
        assert_eq!(b.chars, b.text.chars().count());
        assert!(b.est_tokens > 0);
    }

    #[test]
    fn focus_comes_first_and_budget_drops_items() {
        let mut inputs = sample();
        inputs.focus = Some(FocusInput {
            query: "pricing".into(),
            snippets: vec![("2026-09-01".into(), "note".into(), "Pricing deck needs the enterprise tier".into())],
        });
        let b = render(&inputs, 330);
        assert_eq!(b.parts[0].kind, "focus");
        assert!(b.truncated, "a 330-char budget cannot hold every section");
        assert!(b.chars <= 330);
        // Never emits a section header without at least one item.
        assert!(!b.text.contains("Projects:\n"));
    }

    #[test]
    fn empty_inputs_give_empty_briefing() {
        let b = render(&BriefingInputs { today: "Monday".into(), ..Default::default() }, 1000);
        assert_eq!(b.text, "");
        assert_eq!(b.chars, 0);
        assert!(b.parts.is_empty());
    }

    #[test]
    fn clip_cuts_on_word_boundary() {
        assert_eq!(clip("one two three four", 10), "one two…");
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("  spaced\n\nout  ", 100), "spaced out");
    }

    #[test]
    fn compose_prompt_is_single_line() {
        let p = compose_prompt("You are helpful\n", Some("Today is Monday.\nOpen tasks: (1) a."));
        assert_eq!(p, "You are helpful. Today is Monday. Open tasks: (1) a.");
        assert_eq!(compose_prompt("Persona.", None), "Persona.");
        assert_eq!(compose_prompt("", Some("Brief.")), "Brief.");
    }

    #[test]
    fn condensed_text_is_flattened_and_flagged() {
        let b = with_condensed_text(render(&sample(), 2000), "Line one.\n\nLine two.".into());
        assert!(b.condensed);
        assert_eq!(b.text, "Line one. Line two.");
        assert_eq!(b.chars, 19);
    }
}
