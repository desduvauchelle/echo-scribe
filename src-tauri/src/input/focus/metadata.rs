//! Read metadata from the captured window only. No navigation, message bodies,
//! clipboard use, or cross-window "most recent" guesses.
use super::*;
use crate::input::context::{push_signal, url_signals, ContextKind, ContextSignal};
use objc2_core_foundation::{CFBoolean, CFString, CFType};
use std::{
    collections::VecDeque,
    ptr::NonNull,
    time::{Duration, Instant},
};

type Metadata = (
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<ContextSignal>,
    CaptureDiagnostics,
);

pub(super) fn capture(
    pid: i32,
    app: Option<&str>,
    window_title: Option<&str>,
    tab: Option<&str>,
    browser_url: Option<&str>,
    bundle: Option<&str>,
) -> Metadata {
    let start = Instant::now();
    let mut diagnostics = CaptureDiagnostics {
        reader_version: 2,
        stop_reason: "complete".into(),
        ..Default::default()
    };
    let mut signals = Vec::new();
    let mut best = normalize_content_candidate(tab, app, window_title)
        .map(|s| (85, s, "browser_tab".to_string()));
    let mut url = browser_url.and_then(normalize_url_candidate);
    if let Some(raw) = url.as_deref() {
        url_signals(raw, &mut signals);
    }
    let Some(window) = focused_window_element_macos(pid) else {
        return (
            best.as_ref().map(|x| x.1.clone()),
            url,
            best.map(|x| x.2),
            signals,
            CaptureDiagnostics {
                elapsed_ms: start.elapsed().as_millis() as u64,
                stop_reason: "no_focused_window".into(),
                ..diagnostics
            },
        );
    };
    let mail = is_mail_surface(bundle, browser_url);
    let claude = bundle == Some("com.anthropic.claudefordesktop");
    let mut claude_headers = std::collections::HashSet::new();
    let mut popups = Vec::new();
    if matches!(
        bundle,
        Some("com.microsoft.VSCode" | "com.microsoft.VSCodeInsiders")
    ) {
        if let Some((_, workspace)) = window_title.and_then(|s| s.rsplit_once(" — ")) {
            push_signal(
                &mut signals,
                ContextKind::Workspace,
                workspace,
                "vscode_window",
            );
        }
    }
    let mut queue = VecDeque::from([(window, 0usize, None::<ContextKind>, 0usize, 0usize)]);
    // Retain the old focused-document path without accepting a generic input
    // label as the final answer. Depth 20 limits this probe to the element itself.
    if let Some(focused) = focused_ui_element_macos(pid) {
        queue.push_front((focused, 20, None, 0, usize::MAX));
    }
    let mut visited = 0;
    while let Some((element, depth, inherited, inherited_depth, parent)) = queue.pop_front() {
        if start.elapsed() >= Duration::from_millis(350) || visited >= 160 {
            diagnostics.stop_reason = if visited >= 160 { "node_limit" } else { "time_limit" }.into();
            diagnostics.pending = queue.len() + 1;
            break;
        }
        visited += 1;
        let read = |attr| {
            if start.elapsed() < Duration::from_millis(350) {
                copy_ax_string_attribute(&element, attr)
            } else {
                None
            }
        };
        let role = read("AXRole").unwrap_or_default();
        // Count roles only; never log labels, values, URLs, or message text.
        *diagnostics.roles.entry(role.clone()).or_default() += 1;
        if role == "AXSecureTextField" {
            continue;
        }
        if claude && role == "AXWebArea" {
            if let Some(raw) = copy_ax_url_like_attribute(&element, "AXURL") {
                let own = raw.contains(".app/Contents/")
                    || raw.starts_with("claude.ai/")
                    || raw.starts_with("https://claude.ai/");
                if !own {
                    diagnostics.skipped_surfaces += 1;
                    continue;
                }
            }
        }
        let title = read("AXTitle");
        let description = read("AXDescription");
        let label = title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(description.as_deref());
        // Skip known conversation bodies and the app-wide sidebar entirely.
        // In Claude, these contain many OTHER projects and message headings.
        if matches!(
            label,
            Some("Sidebar" | "Chat messages" | "Conversation messages")
        ) {
            diagnostics.skipped_surfaces += 1;
            continue;
        }
        if label.is_some_and(|s| {
            s.starts_with("You said:")
                || s.starts_with("Claude responded:")
                || s.starts_with("ChatGPT said:")
        }) {
            continue;
        }
        if claude {
            if let Some(conversation) = label.and_then(|s| s.strip_suffix(", rename session")) {
                push_signal(
                    &mut signals,
                    ContextKind::Conversation,
                    conversation,
                    "claude_session_header",
                );
                consider_title(&mut best, 100, conversation.into(), "claude_session_header");
                claude_headers.insert(parent);
            }
            if role == "AXPopUpButton" {
                if let Some(label) = label {
                    popups.push((parent, label.to_string()));
                }
            }
        }
        if bundle == Some("com.apple.mail") && role == "AXWebArea" {
            continue;
        }
        if mail && read("AXIdentifier").as_deref() == Some("message.header.content") {
            if let Some(header) = read("AXValue") {
                push_signal(
                    &mut signals,
                    ContextKind::MailHeader,
                    &header,
                    "apple_mail_header",
                );
            }
        }
        let selected = matches!(
            role.as_str(),
            "AXRow" | "AXTab" | "AXButton" | "AXRadioButton"
        ) && start.elapsed() < Duration::from_millis(350)
            && selected(&element);
        let field = if mail {
            mail_field(label.unwrap_or(""))
        } else {
            None
        };
        let kind = field.clone().or_else(|| match role.as_str() {
            "AXHeading" => Some(ContextKind::Heading),
            _ if selected && !mail => Some(ContextKind::SelectedItem),
            _ => inherited.clone(),
        });
        // Read values only for headings, selected labels, and explicitly named
        // mail header fields. Never read arbitrary composer/editor values.
        if let Some(kind) = kind.as_ref() {
            if role != "AXTextArea" || field.is_some() {
                let value = read("AXValue");
                let value = value.as_deref().filter(|v| v.parse::<u32>().is_err());
                let candidate = if matches!(kind, ContextKind::Heading | ContextKind::SelectedItem)
                {
                    label.or(value)
                } else {
                    value.or(label)
                };
                if let Some(value) =
                    candidate.and_then(|s| normalize_content_candidate(Some(s), app, None))
                {
                    if mail_field(&value).is_none() {
                        let source = if field.is_some()
                            || matches!(
                                kind,
                                ContextKind::Recipient | ContextKind::Sender | ContextKind::Subject
                            ) {
                            "ax_mail_header"
                        } else if *kind == ContextKind::SelectedItem {
                            "ax_selected_item"
                        } else {
                            "ax_heading"
                        };
                        push_signal(&mut signals, kind.clone(), &value, source);
                        let score = match kind {
                            ContextKind::Subject => 95,
                            ContextKind::Heading => 90,
                            ContextKind::SelectedItem => 65,
                            _ => 0,
                        };
                        consider_title(&mut best, score, value, source);
                    }
                }
            }
        }
        if matches!(
            role.as_str(),
            "AXWindow" | "AXWebArea" | "AXDocument" | "AXGroup"
        ) || parent == usize::MAX
        {
            for candidate in [title.as_deref(), description.as_deref()] {
                if let Some(value) = normalize_content_candidate(candidate, app, window_title) {
                    // Generic group descriptions never outrank a page or heading.
                    let score = if role == "AXWebArea" || role == "AXDocument" {
                        80
                    } else {
                        20
                    };
                    consider_title(&mut best, score, value, "ax_content_surface");
                }
            }
            if start.elapsed() < Duration::from_millis(350) {
                let document = copy_ax_url_like_attribute(&element, "AXDocument")
                    .or_else(|| copy_ax_url_like_attribute(&element, "AXURL"))
                    .and_then(|s| normalize_url_candidate(&s));
                if let Some(document) = document {
                    // Electron's shell document is not the user's document.
                    if !document.contains(".app/Contents/") {
                        url_signals(&document, &mut signals);
                        if document.starts_with('/') {
                            push_signal(
                                &mut signals,
                                ContextKind::Document,
                                &document,
                                "ax_document",
                            );
                            if let Ok(u) = url::Url::from_file_path(&document) {
                                url_signals(u.as_str(), &mut signals);
                            }
                        }
                        if url.is_none() {
                            url = Some(document);
                        }
                    }
                }
            }
        }
        if (role == "AXTextArea" || role == "AXTextField") && field.is_none() {
            continue;
        }
        if depth >= 20 {
            if parent != usize::MAX {
                diagnostics.depth_limited += 1;
            }
            continue;
        }
        if start.elapsed() >= Duration::from_millis(350) {
            diagnostics.stop_reason = "time_limit".into();
            diagnostics.pending = queue.len() + 1;
            break;
        }
        let next_kind = if field.is_some() || selected || role == "AXHeading" {
            kind
        } else if inherited_depth < 3 {
            inherited
        } else {
            None
        };
        let next_depth = if field.is_some() || selected || role == "AXHeading" {
            0
        } else {
            inherited_depth + 1
        };
        let children = copy_ax_children(&element);
        if children.len() >= 24 {
            diagnostics.child_lists_at_limit += 1;
        }
        for child in children.into_iter().take(24) {
            if queue.len() + visited >= 160 {
                diagnostics.queue_limited += 1;
                break;
            }
            queue.push_back((child, depth + 1, next_kind.clone(), next_depth, visited));
        }
    }
    diagnostics.claude_headers = claude_headers.len();
    diagnostics.popup_controls = popups.len();
    diagnostics.visited = visited;
    diagnostics.elapsed_ms = start.elapsed().as_millis() as u64;
    tracing::info!(target: "capture_context", pid, bundle = ?bundle,
        diagnostics = ?diagnostics, signal_count = signals.len(),
        "context capture diagnostics");
    for (parent, label) in popups {
        if claude_headers.contains(&parent)
            && label != "Remote Control"
            && !label.starts_with("More options")
        {
            push_signal(
                &mut signals,
                ContextKind::Workspace,
                &label,
                "claude_session_header",
            );
        }
    }
    (
        best.as_ref().map(|x| x.1.clone()),
        url,
        best.map(|x| x.2),
        signals,
        diagnostics,
    )
}

fn consider_title(best: &mut Option<(u8, String, String)>, score: u8, value: String, source: &str) {
    if score > 0 && best.as_ref().is_none_or(|b| score > b.0) {
        *best = Some((score, value.chars().take(240).collect(), source.into()));
    }
}

fn is_mail_surface(bundle: Option<&str>, raw_url: Option<&str>) -> bool {
    matches!(
        bundle,
        Some("com.apple.mail" | "com.microsoft.Outlook" | "com.readdle.smartemail-Mac")
    ) || raw_url
        .and_then(|s| url::Url::parse(s).ok())
        .and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|h| {
            matches!(
                h.as_str(),
                "mail.google.com"
                    | "outlook.office.com"
                    | "outlook.office365.com"
                    | "outlook.live.com"
            )
        })
}

fn mail_field(label: &str) -> Option<ContextKind> {
    match label
        .trim()
        .trim_end_matches(':')
        .trim()
        .to_lowercase()
        .as_str()
    {
        "to" | "cc" | "recipients" | "recipient" | "à" | "destinataires" => {
            Some(ContextKind::Recipient)
        }
        "from" | "sender" | "de" | "expéditeur" => Some(ContextKind::Sender),
        "subject" | "objet" => Some(ContextKind::Subject),
        // Bcc is deliberately not collected for classification.
        _ => None,
    }
}

fn selected(element: &AXUIElement) -> bool {
    unsafe {
        let mut raw: *const CFType = std::ptr::null();
        let err = element.copy_attribute_value(
            &CFString::from_str("AXSelected"),
            NonNull::new(&mut raw).unwrap(),
        );
        if err.0 != 0 || raw.is_null() {
            return false;
        }
        let value: CFRetained<CFType> =
            CFRetained::from_raw(NonNull::new(raw as *mut CFType).unwrap());
        value
            .downcast::<CFBoolean>()
            .ok()
            .is_some_and(|b| b.value())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn specific_heading_beats_generic_surface_and_selected_sidebar_item() {
        let mut best = Some((20, "Work with ChatGPT".into(), "ax_content_surface".into()));
        consider_title(&mut best, 90, "LiveCase launch".into(), "ax_heading");
        consider_title(&mut best, 65, "Another project".into(), "ax_selected_item");
        assert_eq!(best.unwrap().1, "LiveCase launch");
    }
    #[test]
    fn mail_only_reads_explicit_headers() {
        assert_eq!(mail_field("To:"), Some(ContextKind::Recipient));
        assert_eq!(mail_field("Subject"), Some(ContextKind::Subject));
        assert_eq!(mail_field("Message body"), None);
        assert_eq!(mail_field("Bcc:"), None);
        assert!(!is_mail_surface(
            None,
            Some("https://example.com/mail.google.com")
        ));
    }
}
