//! Deterministic bookmark commands, matched only after the command-mode gate.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceWorkflow {
    pub id: String,
    pub phrase: String,
    pub url: String,
    pub enabled: bool,
}

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn validate(workflows: &[VoiceWorkflow]) -> Result<(), String> {
    if workflows.len() > 32 {
        return Err("You can save up to 32 workflows.".into());
    }
    let mut ids = HashSet::new();
    let mut phrases = HashSet::new();
    for workflow in workflows {
        if workflow.id.trim().is_empty() || !ids.insert(&workflow.id) {
            return Err("Each workflow needs a unique ID.".into());
        }
        let phrase = normalize(&workflow.phrase);
        if phrase.is_empty() || workflow.phrase.chars().count() > 120 {
            return Err("Enter a trigger phrase of 1–120 characters.".into());
        }
        if !phrases.insert(phrase) {
            return Err("Each workflow needs a different trigger phrase.".into());
        }
        let url = url::Url::parse(&workflow.url)
            .map_err(|_| "Enter a full website URL starting with https:// or http://.")?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(
                "Use an http:// or https:// website URL without embedded login details.".into(),
            );
        }
    }
    Ok(())
}

pub fn matching<'a>(workflows: &'a [VoiceWorkflow], command: &str) -> Option<&'a VoiceWorkflow> {
    // Invalid persisted settings must never become executable commands.
    validate(workflows).ok()?;
    let command = normalize(command);
    workflows
        .iter()
        .find(|w| w.enabled && normalize(&w.phrase) == command)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bookmark() -> VoiceWorkflow {
        VoiceWorkflow {
            id: "one".into(),
            phrase: "Pipe drive new authors".into(),
            url: "https://example.com/authors?view=new".into(),
            enabled: true,
        }
    }
    #[test]
    fn matches_whole_command_with_speech_punctuation() {
        let workflows = vec![bookmark()];
        assert!(matching(&workflows, "Pipe drive, new authors.").is_some());
        assert!(matching(&workflows, "Please discuss pipe drive new authors").is_none());
        assert!(matching(&workflows, "").is_none());
    }
    #[test]
    fn disabled_and_invalid_bookmarks_do_not_execute() {
        let mut w = bookmark();
        w.enabled = false;
        assert!(matching(&[w.clone()], &w.phrase).is_none());
        w.enabled = true;
        for url in [
            "file:///tmp/test",
            "javascript:alert(1)",
            "https://user:password@example.com",
            "example.com",
        ] {
            w.url = url.into();
            assert!(validate(&[w.clone()]).is_err());
            assert!(matching(&[w.clone()], &w.phrase).is_none());
        }
    }
    #[test]
    fn rejects_duplicate_phrases_and_allows_empty_list() {
        let a = bookmark();
        let mut b = a.clone();
        b.id = "two".into();
        b.phrase = "PIPE DRIVE NEW AUTHORS!".into();
        assert!(validate(&[a, b]).is_err());
        assert!(validate(&[]).is_ok());
    }
}
