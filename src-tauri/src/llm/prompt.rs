//! Chat-message helpers.
//!
//! Provides both the [`LlamaChatMessage`] path (used when `apply_chat_template`
//! succeeds) and a manual Gemma 4 prompt builder that bypasses llama.cpp's
//! template engine entirely.
//!
//! ## Why the manual builder?
//!
//! Gemma 4 uses `<|turn>role\n{content}<turn|>` as its turn format, but
//! llama.cpp's built-in named templates only know the Gemma 1–3 format
//! (`<start_of_turn>/<end_of_turn>`). Gemma 4 GGUFs embed a Jinja2 template
//! that llama.cpp cannot parse (returns ffi error -1). The manual builder
//! produces a correctly structured prompt without any template machinery.

use llama_cpp_2::model::LlamaChatMessage;
use llama_cpp_2::NewLlamaChatMessageError;

/// Build a multi-turn chat message vector.
///
/// `history` is `(role, content)` pairs — alternating "user" / "assistant"
/// from oldest to most recent, NOT including the current turn.
pub fn build_chat_messages(
    system: Option<&str>,
    history: &[(String, String)],
    user: &str,
) -> Result<Vec<LlamaChatMessage>, NewLlamaChatMessageError> {
    let mut msgs = Vec::new();
    if let Some(sys) = system {
        if !sys.is_empty() {
            msgs.push(LlamaChatMessage::new(
                "system".to_string(),
                sys.to_string(),
            )?);
        }
    }
    for (role, content) in history {
        msgs.push(LlamaChatMessage::new(role.clone(), content.clone())?);
    }
    msgs.push(LlamaChatMessage::new("user".to_string(), user.to_string())?);
    Ok(msgs)
}

/// Build the chat-message vector for a prompt with optional system message.
///
/// Note: [`LlamaChatMessage::new`] only fails if the role/content contains a
/// nul byte; we surface that via the returned `Result` rather than panicking,
/// since the user's prompt may be arbitrary text.
pub fn build_messages(
    system: Option<&str>,
    user: &str,
) -> Result<Vec<LlamaChatMessage>, NewLlamaChatMessageError> {
    build_chat_messages(system, &[], user)
}

/// Strip any of `stops` from the trailing edge of `text`, then trim
/// whitespace. Used after generation to clean up output that ran into a stop
/// string (we don't always detect stops mid-token).
/// Build a raw prompt string in Gemma 4's native turn format.
///
/// Gemma 4 format (per Google AI docs):
/// ```text
/// <|turn>system
/// {system}<turn|>
/// <|turn>user
/// {user_message}<turn|>
/// <|turn>model
/// {assistant_reply}<turn|>
/// ...
/// <|turn>user
/// {current_message}<turn|>
/// <|turn>model
/// ```
/// The prompt ends with `<|turn>model\n` (no closing `<turn|>`) to signal
/// the model should start generating. BOS must be prepended by the tokenizer
/// (`AddBos::Add`), NOT included in this string.
///
/// `history` is `(role, content)` pairs — "user" or "assistant", oldest first,
/// NOT including the current turn. The role "assistant" is mapped to "model"
/// as required by Gemma.
pub fn build_gemma4_prompt(
    system: Option<&str>,
    history: &[(String, String)],
    user: &str,
) -> String {
    let mut out = String::new();

    if let Some(sys) = system {
        if !sys.is_empty() {
            out.push_str("<|turn>system\n");
            out.push_str(sys.trim());
            out.push_str("<turn|>\n");
        }
    }

    for (role, content) in history {
        let gemma_role = if role == "assistant" {
            "model"
        } else {
            role.as_str()
        };
        out.push_str("<|turn>");
        out.push_str(gemma_role);
        out.push('\n');
        out.push_str(content.trim());
        out.push_str("<turn|>\n");
    }

    out.push_str("<|turn>user\n");
    out.push_str(user.trim());
    out.push_str("<turn|>\n");
    out.push_str("<|turn>model\n");

    out
}

pub fn strip_trailing_stops(text: &str, stops: &[String]) -> String {
    let mut out = text.to_string();
    loop {
        let trimmed_len = out.trim_end().len();
        let trimmed = &out[..trimmed_len];
        let mut found_any = false;
        for s in stops {
            if !s.is_empty() && trimmed.ends_with(s.as_str()) {
                out = trimmed[..trimmed.len() - s.len()].to_string();
                found_any = true;
                break;
            }
        }
        if !found_any {
            break;
        }
    }
    out.trim().to_string()
}

/// Render the language-follow rule for a prompt whose output is prose the user
/// reads.
///
/// Parakeet v3 transcribes 25 European languages, but every prompt in this file
/// is written in English — without an explicit rule the model answers in
/// English, so a German or Spanish meeting produced English notes. `source_label`
/// names the text the answer must match ("the transcript", "the meeting notes",
/// …); the rule deliberately yields to an explicit language instruction earlier
/// in the prompt (a user's custom summary prompt or recipe may ask for one).
///
/// NOT for prompts whose output is matched against fixed vocabulary or parsed
/// structurally — enum verdicts/statuses, project names matched against the
/// user's project list, tags that group across meetings, and action/intent
/// classification all break when translated. See the call sites for which
/// individual JSON fields opt in.
pub fn language_rule(source_label: &str) -> String {
    format!(
        "Language: write the entire response in the same language as {source_label} — \
German source → German response, Spanish → Spanish, French → French, and so on for every \
language. Use English only when the source is in English, or when an instruction above \
explicitly names a different output language. Never silently translate the content."
    )
}

/// Pin prose to a language already detected from the original source.
///
/// This is stronger than [`language_rule`] for multi-pass generation: an
/// intermediate summary cannot accidentally become the language signal for
/// the next pass. The escape hatch preserves an explicit user-authored output
/// language in a custom prompt or recipe.
pub fn pinned_language_rule(output_language: &str) -> String {
    format!(
        "Output language: {output_language}. Write every user-visible word in {output_language}. \
Do not translate into any other language. Only use a different output language when an \
instruction above explicitly names one."
    )
}

/// Build the prompt for meeting transcript → free-form markdown notes.
///
/// Stage 1 of synthesis: the model writes readable markdown following the
/// user's summary template. Deliberately no structured output — whatever the
/// template asks for, the result is displayable as-is, so a template change
/// can never break the pipeline. Title/tags/project come from a separate
/// small extraction pass (`build_meeting_metadata_prompt`).
pub fn build_meeting_notes_prompt(
    flattened_transcript: &str,
    detected_app_name: Option<&str>,
    duration_minutes: u64,
    start_context: &crate::meeting::MeetingStartContext,
    custom_prompt: Option<&str>,
    user_notes: Option<&str>,
    summary_template: Option<&crate::db::meeting_intelligence::SummaryTemplate>,
) -> (Option<String>, String) {
    build_meeting_notes_prompt_with_language(
        flattened_transcript,
        detected_app_name,
        duration_minutes,
        start_context,
        custom_prompt,
        user_notes,
        summary_template,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_meeting_notes_prompt_with_language(
    flattened_transcript: &str,
    detected_app_name: Option<&str>,
    duration_minutes: u64,
    start_context: &crate::meeting::MeetingStartContext,
    custom_prompt: Option<&str>,
    user_notes: Option<&str>,
    summary_template: Option<&crate::db::meeting_intelligence::SummaryTemplate>,
    output_language: Option<&str>,
) -> (Option<String>, String) {
    let app = detected_app_name.unwrap_or("a meeting");

    // Compose a short context block from window title / URL / tab title. The
    // LLM uses this to seed the meeting topic and (for Meet/Zoom titles)
    // sometimes the participant list, even before reading the transcript.
    let context_block = build_start_context_block(start_context);

    let base_guidelines = custom_prompt.unwrap_or(
        "You are an expert meeting note-taker. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. \
The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side)."
    );
    let resolved_guidelines = base_guidelines
        .replace("{duration_minutes}", &duration_minutes.to_string())
        .replace("{app}", app);

    let template_block = summary_template
        .map(|t| {
            let sections: Vec<String> =
                serde_json::from_str(&t.sections_json).unwrap_or_default();
            let sections_line = if sections.is_empty() {
                String::new()
            } else {
                format!(
                    "\nOrganize the notes under these '##' headings, in this order (skip a heading when the conversation had nothing for it): {}. Reuse these heading names exactly as written above, whatever language the transcript is in.",
                    sections.join(", ")
                )
            };
            format!(
                "\nFollow the '{}' template. {}{}",
                t.name, t.instructions, sections_line
            )
        })
        .unwrap_or_default();

    // Notes are free-form prose the user reads, and nothing downstream parses
    // the section headings (the exporter writes its own '## Summary' wrapper),
    // so headings follow the transcript language too — except heading names a
    // template pinned above.
    let (language, heading_language) = match output_language {
        Some(output_language) => (
            pinned_language_rule(output_language),
            "Use that output language for headings and bullets alike.",
        ),
        None => (
            language_rule("the transcript"),
            "Headings and bullets alike — a German transcript gets German headings.",
        ),
    };
    let system = format!(
        "{resolved_guidelines}{template_block}\n\
Write the meeting notes as clean markdown:\n\
- Use '##' headings for sections and short '-' bullet points under them.\n\
- Bullets are self-contained factual statements — decisions, key topics, outcomes, and explicit commitments (with who owns them).\n\
- Be concise: capture what matters, skip filler and pleasantries.\n\
- Never invent facts, names, dates, or commitments that are not in the transcript.\n\
- Do not start with a document title heading and do not add commentary before or after the notes.\n\
- {language} {heading_language}\n\
Output markdown only."
    );
    let notes_block = user_notes
        .filter(|n| !n.trim().is_empty())
        .map(|n| {
            format!(
                "User-authored notes (prioritize these, but do not treat them as transcript evidence):\n{}\n\n",
                n.trim()
            )
        })
        .unwrap_or_default();
    let user = if context_block.is_empty() {
        format!(
            "{notes_block}Transcript:\n\n{flattened_transcript}\n\nWrite the markdown notes now."
        )
    } else {
        format!(
            "Context at meeting start:\n{context_block}\n{notes_block}Transcript:\n\n{flattened_transcript}\n\nWrite the markdown notes now."
        )
    };
    (Some(system), user)
}

/// Build the prompt for markdown notes → `{suggested_title, tags, project_name}`.
///
/// Stage 2 of synthesis. Runs over the (short) notes rather than the full
/// transcript, so it is cheap; a parse failure degrades to a heuristic title
/// in the synthesizer instead of failing the meeting.
pub fn build_meeting_metadata_prompt(
    markdown_notes: &str,
    existing_projects: &[crate::db::projects::Project],
) -> (Option<String>, String) {
    let project_hint = if existing_projects.is_empty() {
        "If the meeting clearly relates to a specific project or initiative, set \"project_name\" to a short name for it. \
Otherwise set it to null.".to_string()
    } else {
        // Rich block: name + description + keywords for each project, so the
        // LLM can route on meaning, not just name matching. Same format as
        // the LogCapture classifier prompt — keeps routing consistent.
        let block = crate::classifier::format_projects_for_prompt(existing_projects);
        format!(
            "The user has these existing projects (use their description and keywords to decide which one — if any — this meeting belongs to):\n\
{block}\n\
If the meeting clearly relates to one of them, set \"project_name\" to that project's EXACT name from the list above. \
If it relates to a new project not in the list, set \"project_name\" to a short name for it. \
Otherwise set it to null."
        )
    };

    // Only `suggested_title` is prose the user reads. `tags` group meetings
    // across the whole app and `project_name` is matched against the user's
    // existing project names — translating either would break that matching, so
    // the language rule is scoped to the title alone.
    let title_language = language_rule("the meeting notes");
    let system = format!(
        "You label meeting notes. Produce a JSON object with exactly these fields:\n\
- suggested_title: short string (max 60 characters) capturing the meeting's purpose. {title_language}\n\
- tags: array of 1-3 short keyword strings that categorize the overall meeting topic (e.g. \"design\", \"planning\", \"bugfix\"). Always write tags in English, even when the notes are in another language, so they group with tags from other meetings.\n\
- project_name: string or null. {project_hint}\n\
Output JSON only — no preamble, no commentary, no markdown fences."
    );
    let user = format!("Meeting notes:\n\n{markdown_notes}\n\nProduce the JSON now.");
    (Some(system), user)
}

/// Build the system prompt for a scoped artifact (a recipe, follow-up email
/// draft, or prep brief) generated from local meeting/person/company/project
/// context.
///
/// `instruction` is either a built-in instruction (follow-up/prep brief) or a
/// user-authored recipe prompt — a recipe can itself pin an output language
/// ("always write this in French"), so the language rule is appended *after*
/// `instruction` and yields to it via its own escape hatch.
pub fn build_scoped_artifact_system_prompt(instruction: &str) -> String {
    let language = language_rule("the source context");
    format!(
        "You are Tucky's private local meeting assistant. {instruction} Use only the supplied source context. If evidence is missing, say so. Never invent people, commitments, dates, or facts. {language}"
    )
}

/// Render the optional start-of-meeting context (window title, URL, tab title)
/// as a bullet list. Returns an empty string when no fields are set.
fn build_start_context_block(ctx: &crate::meeting::MeetingStartContext) -> String {
    let mut out = String::new();
    if let Some(t) = ctx.window_title.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("- Window title: ");
        out.push_str(t.trim());
        out.push('\n');
    }
    if let Some(t) = ctx
        .browser_tab_title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        // Skip when the tab title equals the window title (Safari often
        // duplicates them — no value in repeating).
        let same_as_window = ctx
            .window_title
            .as_deref()
            .map(|w| w.trim() == t.trim())
            .unwrap_or(false);
        if !same_as_window {
            out.push_str("- Tab title: ");
            out.push_str(t.trim());
            out.push('\n');
        }
    }
    if let Some(u) = ctx.browser_url.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("- URL: ");
        out.push_str(u.trim());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_messages_includes_system_when_set() {
        let msgs = build_messages(Some("be helpful"), "hello").unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn build_messages_omits_empty_system() {
        let msgs = build_messages(None, "hi").unwrap();
        assert_eq!(msgs.len(), 1);
        let msgs = build_messages(Some(""), "hi").unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn strip_trailing_stops_removes_known_stops_and_whitespace() {
        let stops = vec!["</s>".to_string(), "<end>".to_string()];
        assert_eq!(
            strip_trailing_stops("hello world</s>", &stops),
            "hello world"
        );
        assert_eq!(strip_trailing_stops("hello   <end>  \n", &stops), "hello");
        // Stack of stops.
        assert_eq!(strip_trailing_stops("answer<end></s>", &stops), "answer");
        // Untouched if no stop matches.
        assert_eq!(strip_trailing_stops("plain text", &stops), "plain text");
    }

    #[test]
    fn strip_trailing_stops_handles_empty_stops() {
        assert_eq!(strip_trailing_stops("hi  ", &[]), "hi");
    }

    #[test]
    fn build_chat_messages_includes_history() {
        let history = vec![
            ("user".to_string(), "hello".to_string()),
            ("assistant".to_string(), "hi there".to_string()),
        ];
        let msgs = build_chat_messages(Some("be helpful"), &history, "follow up").unwrap();
        // system + 2 history turns + user = 4
        assert_eq!(msgs.len(), 4);
    }

    #[test]
    fn build_chat_messages_empty_history_matches_build_messages() {
        let a = build_messages(Some("sys"), "user msg").unwrap();
        let b = build_chat_messages(Some("sys"), &[], "user msg").unwrap();
        assert_eq!(a.len(), b.len());
    }

    // ── build_gemma4_prompt ───────────────────────────────────────────────

    #[test]
    fn gemma4_prompt_no_system_no_history() {
        let p = build_gemma4_prompt(None, &[], "hello");
        assert_eq!(p, "<|turn>user\nhello<turn|>\n<|turn>model\n");
    }

    #[test]
    fn gemma4_prompt_with_system() {
        let p = build_gemma4_prompt(Some("be helpful"), &[], "hi");
        assert!(
            p.starts_with("<|turn>system\nbe helpful<turn|>\n"),
            "got: {p}"
        );
        assert!(p.ends_with("<|turn>model\n"), "got: {p}");
        assert!(p.contains("<|turn>user\nhi<turn|>\n"), "got: {p}");
    }

    #[test]
    fn gemma4_prompt_empty_system_omitted() {
        let p = build_gemma4_prompt(Some(""), &[], "hi");
        assert!(
            !p.contains("<|turn>system"),
            "empty system should be omitted"
        );
        assert!(p.starts_with("<|turn>user\n"), "got: {p}");
    }

    #[test]
    fn gemma4_prompt_with_history() {
        let history = vec![
            ("user".to_string(), "hello".to_string()),
            ("assistant".to_string(), "hi there".to_string()),
        ];
        let p = build_gemma4_prompt(None, &history, "how are you?");
        // assistant role must be mapped to "model"
        assert!(p.contains("<|turn>model\nhi there<turn|>\n"), "got: {p}");
        assert!(p.contains("<|turn>user\nhello<turn|>\n"), "got: {p}");
        assert!(
            p.ends_with("<|turn>model\n"),
            "prompt must end with model turn opener"
        );
    }

    #[test]
    fn gemma4_prompt_ends_with_model_opener() {
        // The prompt must end with <|turn>model\n (no closing <turn|>)
        // so the model generates starting from that position.
        let p = build_gemma4_prompt(Some("sys"), &[], "question");
        assert!(
            p.ends_with("<|turn>model\n"),
            "prompt must end with model turn opener, got: {p}"
        );
        assert!(
            !p.ends_with("<turn|>\n<|turn>model\n") || p.ends_with("<|turn>model\n"),
            "got: {p}"
        );
    }

    #[test]
    fn gemma4_prompt_no_bos_token() {
        // BOS is prepended by the tokenizer (AddBos::Add), not baked in.
        let p = build_gemma4_prompt(Some("sys"), &[], "q");
        assert!(
            !p.starts_with("<bos>"),
            "prompt must not include <bos>: {p}"
        );
    }

    // ── meeting notes prompt tests ───────────────────────────────────────

    #[test]
    fn meeting_notes_omits_context_block_when_empty() {
        let ctx = crate::meeting::MeetingStartContext::default();
        let (_sys, user) = build_meeting_notes_prompt(
            "You: hi\nThem: hello\n",
            Some("Zoom"),
            5,
            &ctx,
            None,
            None,
            None,
        );
        assert!(
            !user.contains("Context at meeting start"),
            "empty context must not produce a context block, got: {user}"
        );
    }

    #[test]
    fn meeting_notes_includes_window_title_and_url() {
        let ctx = crate::meeting::MeetingStartContext {
            window_title: Some("Weekly Standup - Zoom Meeting".into()),
            browser_url: Some("https://meet.google.com/abc-defg-hij".into()),
            browser_tab_title: Some("Meeting – Alice, Bob".into()),
        };
        let (_sys, user) =
            build_meeting_notes_prompt("You: hi\n", Some("Zoom"), 30, &ctx, None, None, None);
        assert!(user.contains("Context at meeting start"));
        assert!(user.contains("Weekly Standup - Zoom Meeting"));
        assert!(user.contains("https://meet.google.com/abc-defg-hij"));
        assert!(user.contains("Meeting – Alice, Bob"));
    }

    #[test]
    fn meeting_notes_drops_redundant_tab_title() {
        // Safari often returns the same string for window title and tab title;
        // the renderer should not repeat it.
        let ctx = crate::meeting::MeetingStartContext {
            window_title: Some("Tucky — pricing".into()),
            browser_url: None,
            browser_tab_title: Some("Tucky — pricing".into()),
        };
        let (_sys, user) = build_meeting_notes_prompt("You: hi\n", None, 1, &ctx, None, None, None);
        let occurrences = user.matches("Tucky — pricing").count();
        assert_eq!(
            occurrences, 1,
            "redundant tab title should not be repeated; got {occurrences} occurrences in: {user}"
        );
    }

    #[test]
    fn meeting_notes_custom_prompt_substitutions() {
        let ctx = crate::meeting::MeetingStartContext::default();
        let custom = "Tone: formal. Duration: {duration_minutes}m, platform: {app}. Be concise.";
        let (sys, _user) = build_meeting_notes_prompt(
            "You: hi\n",
            Some("Google Meet"),
            45,
            &ctx,
            Some(custom),
            None,
            None,
        );
        let sys_content = sys.unwrap();
        assert!(
            sys_content.contains("Tone: formal. Duration: 45m, platform: Google Meet. Be concise."),
            "got: {sys_content}"
        );
        assert!(
            sys_content.contains("Output markdown only."),
            "got: {sys_content}"
        );
    }

    #[test]
    fn meeting_notes_template_sections_become_headings_hint() {
        let ctx = crate::meeting::MeetingStartContext::default();
        let template = crate::db::meeting_intelligence::SummaryTemplate {
            id: "t1".into(),
            name: "Sales".into(),
            description: "d".into(),
            instructions: "Emphasize objections.".into(),
            sections_json: r#"["Goals","Objections"]"#.into(),
            is_builtin: false,
            archived_at: None,
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
        };
        let (sys, _user) =
            build_meeting_notes_prompt("You: hi\n", None, 10, &ctx, None, None, Some(&template));
        let sys_content = sys.unwrap();
        assert!(sys_content.contains("Follow the 'Sales' template."));
        assert!(sys_content.contains("Emphasize objections."));
        assert!(sys_content.contains("Goals, Objections"));
    }

    #[test]
    fn meeting_metadata_prompt_lists_projects_and_requires_json() {
        let projects = vec![crate::db::projects::Project {
            id: "p1".into(),
            name: "Alpha".into(),
            created_at: "2026-01-01".into(),
            archived_at: None,
            ..Default::default()
        }];
        let (sys, user) = build_meeting_metadata_prompt("## Notes\n- point", &projects);
        let sys_content = sys.unwrap();
        assert!(sys_content.contains("suggested_title"));
        assert!(sys_content.contains("Alpha"));
        assert!(user.contains("## Notes"));
    }

    #[test]
    fn guide_review_prompt_numbers_criteria_and_embeds_goal() {
        let (system, user) = build_guide_review_prompt(
            "Listen more than you speak.",
            "speak last\n\ngive credit by name\n",
            "You: hi\nThem: hello\n",
        );
        let sys = system.unwrap();
        assert!(sys.contains("Listen more than you speak."));
        assert!(sys.contains("1. speak last"));
        assert!(sys.contains("2. give credit by name")); // blank line skipped, renumbered
        assert!(sys.contains("\"scorecard\""));
        assert!(user.contains("You: hi"));
    }

    // ── language-follow rule ─────────────────────────────────────────────
    //
    // Parakeet v3 transcribes 25 European languages; prose the user reads must
    // come back in the transcript's language, while anything matched against
    // fixed vocabulary must stay English.

    #[test]
    fn meeting_notes_prompt_asks_for_the_transcript_language() {
        let ctx = crate::meeting::MeetingStartContext::default();
        let (sys, _user) =
            build_meeting_notes_prompt("Them: Guten Tag\n", None, 5, &ctx, None, None, None);
        let sys = sys.unwrap();
        assert!(
            sys.contains(&language_rule("the transcript")),
            "notes prompt must carry the language rule, got: {sys}"
        );
        assert!(
            sys.contains("German transcript gets German headings"),
            "headings follow the transcript language too, got: {sys}"
        );
    }

    #[test]
    fn meeting_notes_language_rule_survives_a_custom_prompt() {
        // A user-supplied summary prompt replaces the guidelines block only —
        // the language rule lives in the shared tail and must still be there.
        let ctx = crate::meeting::MeetingStartContext::default();
        let (sys, _user) = build_meeting_notes_prompt(
            "You: hi\n",
            None,
            5,
            &ctx,
            Some("Tone: formal."),
            None,
            None,
        );
        assert!(sys.unwrap().contains(&language_rule("the transcript")));
    }

    #[test]
    fn meeting_notes_use_the_language_pinned_from_the_original_transcript() {
        let ctx = crate::meeting::MeetingStartContext::default();
        let (sys, _user) = build_meeting_notes_prompt_with_language(
            "--- Chronological Segment 1/2 ---\nintermediate text\n",
            None,
            60,
            &ctx,
            None,
            None,
            None,
            Some("English"),
        );
        let sys = sys.unwrap();
        assert!(sys.contains("Output language: English"), "got: {sys}");
        assert!(
            !sys.contains("German source") && !sys.contains("German transcript"),
            "a pinned prompt must not prime other languages: {sys}"
        );
    }

    #[test]
    fn meeting_notes_template_headings_are_pinned_across_languages() {
        // Template section names are user-authored; the language rule must not
        // make the model translate them.
        let ctx = crate::meeting::MeetingStartContext::default();
        let template = crate::db::meeting_intelligence::SummaryTemplate {
            id: "t1".into(),
            name: "Sales".into(),
            description: "d".into(),
            instructions: "Emphasize objections.".into(),
            sections_json: r#"["Goals","Objections"]"#.into(),
            is_builtin: false,
            archived_at: None,
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
        };
        let (sys, _user) =
            build_meeting_notes_prompt("You: hi\n", None, 10, &ctx, None, None, Some(&template));
        let sys = sys.unwrap();
        assert!(
            sys.contains("Reuse these heading names exactly as written above"),
            "got: {sys}"
        );
    }

    #[test]
    fn meeting_metadata_localizes_the_title_but_not_tags_or_projects() {
        let projects = vec![crate::db::projects::Project {
            id: "p1".into(),
            name: "Alpha".into(),
            created_at: "2026-01-01".into(),
            archived_at: None,
            ..Default::default()
        }];
        let (sys, _user) = build_meeting_metadata_prompt("## Notizen\n- Punkt", &projects);
        let sys = sys.unwrap();
        // The title is prose the user reads.
        assert!(
            sys.contains(&language_rule("the meeting notes")),
            "got: {sys}"
        );
        // Tags group meetings app-wide — translating them fragments the facet.
        assert!(sys.contains("Always write tags in English"), "got: {sys}");
        // Project routing still matches the user's exact project names.
        assert!(sys.contains("EXACT name from the list above"), "got: {sys}");
    }

    #[test]
    fn guide_review_localizes_narrative_but_pins_matched_fields() {
        let (sys, _user) = build_guide_review_prompt("Be clear.", "speak last\n", "You: hi\n");
        let sys = sys.unwrap();
        assert!(sys.contains(&language_rule("the transcript")), "got: {sys}");
        assert!(
            sys.contains("\"synthesis\", \"why\", \"tip\", and \"observation\" only"),
            "got: {sys}"
        );
        assert!(
            sys.contains("keep \"overall\" and \"verdict\" as the exact English values listed"),
            "got: {sys}"
        );
        assert!(
            sys.contains("copy each \"criterion\" verbatim"),
            "got: {sys}"
        );
    }

    #[test]
    fn guide_review_signals_variant_also_carries_the_language_rule() {
        let (sys, _user) = build_configured_guide_review_prompt(
            "Be clear.",
            "frustration\n",
            "You: hi\n",
            "signals",
            "interaction",
            true,
        );
        assert!(sys.unwrap().contains(&language_rule("the transcript")));
    }

    #[test]
    fn guide_review_reduce_prompt_inherits_the_language_rule() {
        let (sys, user) =
            build_guide_review_reduce_prompt("Be clear.", "speak last\n", "[]", "rubric", "you");
        let sys = sys.unwrap();
        assert!(sys.contains(&language_rule("the transcript")), "got: {sys}");
        assert!(user.contains("Validated excerpt reviews:"));
    }

    #[test]
    fn language_rule_yields_to_an_explicit_instruction() {
        // A custom summary prompt or recipe may name an output language; the
        // rule must not override it.
        let rule = language_rule("the transcript");
        assert!(
            rule.contains("explicitly names a different output language"),
            "got: {rule}"
        );
    }

    #[test]
    fn scoped_artifact_prompt_carries_the_language_rule() {
        let sys = build_scoped_artifact_system_prompt(
            "Draft a concise follow-up email with a useful subject line.",
        );
        assert!(
            sys.contains(&language_rule("the source context")),
            "got: {sys}"
        );
    }

    #[test]
    fn scoped_artifact_prompt_keeps_the_instruction_ahead_of_the_rule() {
        // A recipe's own prompt may pin an output language ("always answer in
        // Spanish"); the rule's escape hatch only fires for "an instruction
        // above", so the recipe instruction must come first.
        let sys = build_scoped_artifact_system_prompt("Always answer in Spanish.");
        let instruction_pos = sys
            .find("Always answer in Spanish.")
            .expect("instruction present");
        let rule_pos = sys
            .find(&language_rule("the source context"))
            .expect("language rule present");
        assert!(instruction_pos < rule_pos, "got: {sys}");
    }
}

/// One key point the LLM is asked to track during a guided session.
/// Mirrored in `meeting/guidance.rs` — fields stay aligned with the JSON
/// schema the LLM is asked to emit so deserialization is cheap.
pub const GUIDANCE_JSON_HINT: &str = r#"{
  "key_points": [
    { "id": "<short stable id, lowercase_with_underscores>",
      "label": "<short label shown to the user>",
      "status": "covered" | "partial" | "open" }
  ],
  "suggestions": ["<at most one short next-best action; omit entirely if nothing new to add>"]
}"#;

/// Build the system+user prompt for one live guidance cycle.
///
/// `kind` selects the guide's persona (see `db::guide_templates::TEMPLATE_KINDS`):
/// - `checklist` — coverage tracking of agenda points derived from the notes.
/// - `coach` — notes are principles; contextual nudges only, silence is normal.
/// - `tracker` — silent note-taker; key_points ARE the live bullet notes and
///   suggestions carry conversation *updates*, never advice.
///
/// All kinds share the same JSON contract so the engine, HUD, and timeline
/// persistence are kind-agnostic. The LLM also receives a bounded recent
/// transcript window and the prior derived points (for stable IDs).
pub fn build_guidance_prompt(
    kind: &str,
    goal: &str,
    notes: &str,
    rolling_transcript: &str,
    prior_points_json: Option<&str>,
    recent_suggestions: &[String],
) -> (Option<String>, String) {
    // `label` and `suggestions` are shown live in the HUD, so they follow the
    // conversation's language. `id` and `status` are matched (ids must stay
    // stable across cycles; status is compared against covered/partial/open in
    // both Rust and the frontend), so they stay English/ASCII.
    let language = format!(
        "- {} This applies to every 'label' and every suggestion. Keep each \
         'id' lowercase ASCII English and each 'status' exactly one of \
         covered/partial/open, untranslated.",
        language_rule("the transcript")
    );
    let system = match kind {
        "tracker" => format!(
            "You are a silent note-taker keeping live bullet notes on a \
             conversation. Maintain the running list of the MAIN things \
             discussed so far — topics, decisions, numbers, names, action \
             items. You never give advice. Return ONLY a single JSON object \
             matching this exact schema (no prose, no markdown, no code \
             fences):\n{GUIDANCE_JSON_HINT}\n\n\
             Rules:\n\
             - key_points ARE the notes: 3-10 short bullets (≤ 12 words each) \
             covering the whole conversation so far, oldest first.\n\
             - Merge related remarks into one bullet; do not log every comment.\n\
             - Reuse the SAME id for the same point across cycles; you may \
             reword its label as your understanding improves.\n\
             - status: 'open' while a point is still being discussed or \
             unresolved, 'partial' when a direction is tentative, 'covered' \
             once it is settled, decided, or the conversation moved past it.\n\
             - suggestions carry UPDATES, not advice: at most 2 short lines, \
             ONLY for a genuinely new development in the recent transcript \
             (a decision made, an earlier point changed or reopened, a new \
             commitment). No coaching, no questions to ask, no opinions. An \
             empty array is correct when nothing new happened.\n\
             - Do NOT repeat anything under 'already noted'.\n\
             {language}\n\
             - Output JSON only.",
        ),
        "coach" => format!(
            "You are a quiet, real-time conversation coach. The user is the \
             speaker labeled 'you'. The notes are principles the user wants \
             to embody — they are NOT a checklist to complete and NOT rules \
             to enforce. Judge only what is actually happening in the recent \
             transcript. Return ONLY a single JSON object matching this exact \
             schema (no prose, no markdown, no code fences):\n{GUIDANCE_JSON_HINT}\n\n\
             Rules:\n\
             - key_points: up to 4 short observations about how the \
             conversation is actually going relative to the principles (e.g. \
             who is getting airtime, whether decisions are landing, rising \
             tension). Only include what the transcript shows. status: \
             'covered' = going well, 'partial' = mixed, 'open' = worth \
             attention.\n\
             - Reuse the SAME id for an observation that already appeared in \
             'previous points'; drop observations that no longer apply.\n\
             - suggestions: at most ONE, ≤ 14 words, and ONLY when a \
             principle clearly applies to what JUST happened. Tie it to the \
             specific moment — a name, a topic, a number from the recent \
             transcript. Generic advice ('listen more', 'speak last') is \
             forbidden. A real coach is mostly silent: an empty array is the \
             right answer for most cycles.\n\
             - Do NOT restate the goal or a note as a suggestion, and do NOT \
             repeat or rephrase anything under 'already suggested'.\n\
             {language}\n\
             - Output JSON only.",
        ),
        _ => format!(
            "You are a real-time meeting facilitator. Track whether the conversation \
             has covered each key point implied by the user's goal and notes. Return \
             ONLY a single JSON object matching this exact schema (no prose, no \
             markdown, no code fences):\n{GUIDANCE_JSON_HINT}\n\n\
             Rules:\n\
             - Reuse the SAME id for a point that already appeared in 'previous \
             points'. Do not invent new ids for the same concept.\n\
             - status: 'covered' if clearly addressed, 'partial' if touched but \
             incomplete, 'open' otherwise.\n\
             - 3-6 key_points total.\n\
             - suggestions: emit AT MOST ONE, and ONLY if the recent transcript \
             introduced something new and actionable. Otherwise return an empty \
             suggestions array — silence is correct when nothing has changed.\n\
             - A suggestion must be ≤ 12 words, concrete, and specific to the most \
             recent transcript. Do NOT restate the goal or notes as a suggestion, \
             and do NOT repeat or rephrase anything under 'already suggested'.\n\
             {language}\n\
             - Output JSON only.",
        ),
    };
    let prior = prior_points_json.unwrap_or("[]");
    let already = if recent_suggestions.is_empty() {
        "(none yet)".to_string()
    } else {
        recent_suggestions
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let already_label = if kind == "tracker" {
        "Already noted (do NOT repeat)"
    } else {
        "Already suggested (do NOT repeat or rephrase)"
    };
    let user = format!(
        "Goal: {goal}\n\nNotes:\n{notes}\n\nPrevious points (carry ids forward):\n{prior}\n\n{already_label}:\n{already}\n\nRecent transcript:\n{rolling_transcript}\n\nReturn the JSON now."
    );
    (Some(system), user)
}

/// Build the prompt for a whole-transcript guide review: coaching scorecard
/// (one graded criterion per non-empty `notes` line) + 1-2 emergent
/// observations + a synthesis vs the `goal`. Parsed loosely into `GuideReview`.
pub fn build_guide_review_prompt(
    goal: &str,
    notes: &str,
    transcript: &str,
) -> (Option<String>, String) {
    build_configured_guide_review_prompt(goal, notes, transcript, "rubric", "you", false)
}

/// Prompt contract for both conventional rubrics and cautious conversation
/// signal tracking. Every positive conclusion must include exact, machine-
/// validated transcript coordinates so the UI can show its proof.
pub fn build_configured_guide_review_prompt(
    goal: &str,
    notes: &str,
    transcript: &str,
    insight_kind: &str,
    subject_scope: &str,
    partial_chunk: bool,
) -> (Option<String>, String) {
    let criteria: Vec<&str> = notes
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let numbered = criteria
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}. {}", i + 1, c))
        .collect::<Vec<_>>()
        .join("\n");
    let subject = match subject_scope {
        "them" => "the speaker labeled 'Them'",
        "interaction" => "the interaction between 'You' and 'Them'",
        _ => "the speaker labeled 'You'",
    };
    let (assessment, verdicts) = if insight_kind == "signals" {
        (
            format!("Assess whether each language or interaction signal is observable in {subject}. Describe signals as language observed, never as a diagnosis of anyone's internal emotion."),
            "not_observed | light | clear | strong",
        )
    } else {
        (
            format!("Assess how well {subject} met each criterion"),
            "met | partial | missed | unknown",
        )
    };
    let chunk_rule = if partial_chunk {
        "This is one excerpt from a longer meeting. Use 'unknown' for rubric criteria or 'not_observed' for signals absent from this excerpt; absence here is not proof of absence from the whole meeting."
    } else {
        "Review the supplied meeting transcript as a whole."
    };
    // Only the narrative fields are prose the user reads. `overall` and
    // `verdict` are matched against fixed English vocabulary (validate_review in
    // meeting/guide_review.rs and verdictClass in the frontend), `criterion` is
    // keyed on for the trend table, and evidence quotes must stay exact
    // substrings of the transcript — so none of those may be translated.
    let language = format!(
        "{} That covers \"synthesis\", \"why\", \"tip\", and \"observation\" only: \
copy each \"criterion\" verbatim from the list above, keep \"overall\" and \"verdict\" as the \
exact English values listed, and copy every quote exactly as it appears in the transcript.",
        language_rule("the transcript")
    );
    let system = format!(
        "You are a careful communication analyst reviewing a meeting transcript. The user is the speaker labeled 'You'; the other side is labeled 'Them'. \
{assessment}, using only words present in the transcript. {chunk_rule}\n\
Objective: {goal}\n\
Criteria:\n{numbered}\n\n\
Produce a JSON object with exactly these fields:\n\
- \"overall\": one of \"strong\", \"mixed\", \"weak\".\n\
- \"synthesis\": a 2-4 sentence narrative of how the conversation went against the objective.\n\
- \"scorecard\": an array with ONE object per criterion above, in the same order: {{ \"criterion\": the criterion text, \"verdict\": one of {verdicts}, \"evidence\": the first exact quote or empty string, \"evidence_refs\": zero or more exact sources shaped {{ \"segment_index\": N, \"start_ms\": N, \"end_ms\": N, \"quote\": \"exact substring from that segment\" }}, \"why\": a one-line assessment, \"tip\": one concrete next step or empty string }}.\n\
- \"emergent\": an array of 0-2 objects {{ \"observation\": something notable NOT covered by the criteria, \"evidence\": the first exact quote, \"evidence_refs\": one or more exact sources in the same shape }}.\n\
The transcript labels each segment [sINDEX|START_MS-END_MS|SPEAKER]. Copy the index, times, and quote exactly. Never invent or paraphrase evidence. Every signal verdict other than not_observed and every rubric verdict other than unknown requires exact evidence; use missed only for an evidenced counterexample, not merely because a behavior is absent. Do not infer vocal tone, facial expression, intent, or a clinical/emotional state that the words do not establish.\n\
{language}\n\
Output JSON only — no preamble, no commentary, no markdown fences."
    );
    let user = format!("Transcript:\n\n{transcript}\n\nProduce the JSON now.");
    (Some(system), user)
}

pub fn build_guide_review_reduce_prompt(
    goal: &str,
    notes: &str,
    candidates_json: &str,
    insight_kind: &str,
    subject_scope: &str,
) -> (Option<String>, String) {
    let (system, _) =
        build_configured_guide_review_prompt(goal, notes, "", insight_kind, subject_scope, false);
    let mut system = system.unwrap_or_default();
    system.push_str(
        "\nYou are now reducing several validated excerpt reviews into one meeting review. Preserve the criterion order. Copy evidence_refs and their exact quotes unchanged from the candidates; do not create new references. For signals, use the strongest supported level. For rubrics, reconcile all excerpts and use unknown only when the candidates contain no evidence either way.",
    );
    let user =
        format!("Validated excerpt reviews:\n{candidates_json}\n\nReturn the final JSON now.");
    (Some(system), user)
}

#[cfg(test)]
mod guidance_prompt_tests {
    use super::*;

    #[test]
    fn embeds_goal_notes_transcript_and_prior() {
        let (sys, user) = build_guidance_prompt(
            "checklist",
            "Customer discovery",
            "ask about tools\nask about budget",
            "they said spreadsheets break daily",
            Some(r#"[{"id":"current_tools","label":"Current tools","status":"covered"}]"#),
            &[],
        );
        assert!(sys.is_some());
        assert!(user.contains("Goal: Customer discovery"));
        assert!(user.contains("ask about tools"));
        assert!(user.contains("spreadsheets break daily"));
        assert!(user.contains("current_tools"));
        assert!(user.contains("Return the JSON now."));
    }

    #[test]
    fn empty_prior_defaults_to_empty_array() {
        let (_sys, user) = build_guidance_prompt("checklist", "g", "n", "t", None, &[]);
        assert!(user.contains("Previous points (carry ids forward):\n[]"));
    }

    #[test]
    fn no_recent_suggestions_renders_placeholder() {
        let (_sys, user) = build_guidance_prompt("checklist", "g", "n", "t", None, &[]);
        assert!(user.contains("Already suggested (do NOT repeat or rephrase):\n(none yet)"));
    }

    #[test]
    fn recent_suggestions_are_listed_for_the_model() {
        let recent = vec![
            "Ask who owns the LinkedIn task".to_string(),
            "Confirm the Titanic case decision".to_string(),
        ];
        let (_sys, user) = build_guidance_prompt("checklist", "g", "n", "t", None, &recent);
        assert!(user.contains("- Ask who owns the LinkedIn task"));
        assert!(user.contains("- Confirm the Titanic case decision"));
    }

    #[test]
    fn rules_enforce_single_suggestion_and_silence() {
        let (sys, _user) = build_guidance_prompt("checklist", "g", "n", "t", None, &[]);
        let sys = sys.unwrap();
        assert!(sys.contains("AT MOST ONE"), "got: {sys}");
        assert!(sys.contains("empty suggestions array"), "got: {sys}");
        assert!(sys.contains("Do NOT restate the goal"), "got: {sys}");
    }

    #[test]
    fn unknown_kind_falls_back_to_checklist_persona() {
        let (sys, _user) = build_guidance_prompt("bogus", "g", "n", "t", None, &[]);
        assert!(sys.unwrap().contains("meeting facilitator"));
    }

    #[test]
    fn tracker_kind_is_a_note_taker_not_an_advisor() {
        let (sys, user) = build_guidance_prompt("tracker", "g", "n", "t", None, &[]);
        let sys = sys.unwrap();
        assert!(sys.contains("note-taker"), "got: {sys}");
        assert!(sys.contains("never give advice"), "got: {sys}");
        assert!(sys.contains("UPDATES, not advice"), "got: {sys}");
        assert!(sys.contains("3-10 short bullets"), "got: {sys}");
        assert!(user.contains("Already noted (do NOT repeat):"));
    }

    #[test]
    fn coach_kind_treats_notes_as_principles_and_forbids_generic_advice() {
        let (sys, _user) = build_guidance_prompt("coach", "g", "n", "t", None, &[]);
        let sys = sys.unwrap();
        assert!(sys.contains("NOT a checklist"), "got: {sys}");
        assert!(sys.contains("Generic advice"), "got: {sys}");
        assert!(sys.contains("mostly silent"), "got: {sys}");
        assert!(sys.contains("at most ONE"), "got: {sys}");
    }

    #[test]
    fn every_kind_asks_for_the_transcript_language() {
        // The HUD shows `label` and `suggestions` verbatim, so all three
        // personas must answer in the conversation's language.
        for kind in ["checklist", "coach", "tracker", "bogus"] {
            let (sys, _user) = build_guidance_prompt(kind, "g", "n", "t", None, &[]);
            let sys = sys.unwrap();
            assert!(
                sys.contains(&language_rule("the transcript")),
                "{kind} prompt is missing the language rule, got: {sys}"
            );
        }
    }

    #[test]
    fn guidance_keeps_ids_and_statuses_english() {
        // `id` must stay stable across cycles and `status` is compared against
        // covered/partial/open in both Rust and the frontend.
        let (sys, _user) = build_guidance_prompt("checklist", "g", "n", "t", None, &[]);
        let sys = sys.unwrap();
        assert!(
            sys.contains("Keep each 'id' lowercase ASCII English"),
            "got: {sys}"
        );
        assert!(
            sys.contains("covered/partial/open, untranslated"),
            "got: {sys}"
        );
    }
}
