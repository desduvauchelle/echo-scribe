//! Explicit voice requests to focus an existing app or window. No shell or LLM
//! supplies executable code; ambiguous window names never choose arbitrarily.

pub fn command_target(text: &str) -> Option<String> {
    let text = text
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_punctuation());
    let lower = text.to_ascii_lowercase();
    let text = if lower.starts_with("please ") {
        &text[7..]
    } else {
        text
    };
    let lower = text.to_ascii_lowercase();
    let prefix = ["move focus to ", "switch to ", "focus on ", "focus "]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix))?;
    let mut target = text[prefix.len()..].trim();
    if target.to_ascii_lowercase().ends_with(" please") {
        target = target[..target.len() - 7].trim_end_matches(',').trim();
    }
    if target.to_ascii_lowercase().starts_with("the ") {
        target = &target[4..];
    }
    if target.to_ascii_lowercase().ends_with(" window") {
        target = &target[..target.len() - 7];
    }
    let target = target.trim();
    // Keep existing task/focus-list requests on their project-assistant route.
    if target.is_empty()
        || target.split_whitespace().any(|word| {
            matches!(
                word.to_ascii_lowercase().as_str(),
                "task" | "tasks" | "list" | "tomorrow"
            )
        })
    {
        return None;
    }
    Some(target.to_string())
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Prefer an exact title; partial matches must be unique. Optional "in App"
/// narrows the candidates without silently accepting a different app.
fn choose_window(query: &str, windows: &[(String, String)]) -> Result<usize, String> {
    let query = normalized(query);
    if query.is_empty() {
        return Err("Name the app or window to focus.".into());
    }
    let (title, app) = query
        .rsplit_once(" in ")
        .map_or((query.as_str(), None), |(title, app)| (title, Some(app)));
    let candidates: Vec<_> = windows
        .iter()
        .enumerate()
        .filter(|(_, (name, _))| app.is_none_or(|app| normalized(name) == app))
        .collect();
    let exact: Vec<_> = candidates
        .iter()
        .filter(|(_, (_, name))| normalized(name) == title)
        .map(|(i, _)| *i)
        .collect();
    let matches = if exact.is_empty() {
        candidates
            .iter()
            .filter(|(_, (_, name))| {
                format!(" {} ", normalized(name)).contains(&format!(" {title} "))
            })
            .map(|(i, _)| *i)
            .collect()
    } else {
        exact
    };
    match matches.as_slice() {
        [index] => Ok(*index),
        [] => Err("I couldn’t find that open window. Say its window title, optionally followed by ‘in’ and the app name.".into()),
        _ => Err("More than one window matches. Say a more specific title and app name.".into()),
    }
}

#[cfg(target_os = "macos")]
pub async fn focus(query: &str) -> Result<String, String> {
    use super::focus::{
        activate_app, activate_via_launch_services, current_frontmost_pid, FocusContext,
    };
    use objc2_app_kit::NSWorkspace;
    use objc2_application_services::AXUIElement;
    use objc2_core_foundation::{CFArray, CFBoolean, CFRetained, CFString, CFType};
    use std::ptr::NonNull;

    if normalized(query).is_empty() {
        return Err("Name the app or window to focus.".into());
    }

    fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
        unsafe {
            let mut raw = std::ptr::null();
            if element
                .copy_attribute_value(&CFString::from_str(name), NonNull::from(&mut raw))
                .0
                != 0
            {
                return None;
            }
            NonNull::new(raw as *mut CFType).map(|ptr| CFRetained::from_raw(ptr))
        }
    }
    let apps = NSWorkspace::sharedWorkspace().runningApplications();
    let exact_apps: Vec<_> = apps
        .iter()
        .filter(|app| {
            app.localizedName()
                .is_some_and(|name| normalized(&name.to_string()) == normalized(query))
        })
        .collect();
    let (pid, label, window) = if exact_apps.len() == 1 {
        let app = &exact_apps[0];
        (
            app.processIdentifier(),
            app.localizedName().unwrap().to_string(),
            None,
        )
    } else {
        if !crate::permissions::status().accessibility {
            return Err("Allow Accessibility in Settings to focus a specific window.".into());
        }
        let mut windows = Vec::new();
        let mut labels = Vec::new();
        for app in apps.iter() {
            let pid = app.processIdentifier();
            let Some(name) = app.localizedName() else {
                continue;
            };
            let element = unsafe { AXUIElement::new_application(pid) };
            unsafe {
                let _ = element.set_messaging_timeout(0.05);
            }
            let Some(array) =
                attribute(&element, "AXWindows").and_then(|value| value.downcast::<CFArray>().ok())
            else {
                continue;
            };
            // Keep runtime type checks on each value rather than assuming the
            // accessibility provider returned a well-typed array.
            let array: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(array) };
            for value in array.iter().take(100) {
                let Ok(window) = value.downcast::<AXUIElement>() else {
                    continue;
                };
                let Some(title) = attribute(&window, "AXTitle")
                    .and_then(|value| value.downcast::<CFString>().ok())
                else {
                    continue;
                };
                labels.push((name.to_string(), title.to_string()));
                windows.push((pid, window));
            }
        }
        let index = choose_window(query, &labels)?;
        let (pid, window) = windows.swap_remove(index);
        (
            pid,
            format!("{} in {}", labels[index].1, labels[index].0),
            Some(window),
        )
    };
    let context = FocusContext {
        pid,
        ..Default::default()
    };
    activate_app(&context);
    if current_frontmost_pid() != Some(pid) {
        activate_via_launch_services(&context);
    }
    for _ in 0..20 {
        if current_frontmost_pid() == Some(pid) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if current_frontmost_pid() != Some(pid) {
        return Err(format!("macOS could not bring {label} forward."));
    }
    if let Some(window) = window {
        unsafe {
            let _ = window
                .set_attribute_value(&CFString::from_str("AXMinimized"), CFBoolean::new(false));
            let _ = window.set_attribute_value(&CFString::from_str("AXMain"), CFBoolean::new(true));
            if window.perform_action(&CFString::from_str("AXRaise")).0 != 0 {
                return Err(format!("macOS could not raise {label}."));
            }
        }
        let app = unsafe { AXUIElement::new_application(pid) };
        unsafe {
            let _ = app.set_messaging_timeout(0.1);
        }
        let mut verified = false;
        for _ in 0..10 {
            verified = attribute(&app, "AXFocusedWindow")
                .and_then(|v| v.downcast::<AXUIElement>().ok())
                .is_some_and(|focused| focused == window);
            if verified {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        if !verified {
            return Err(format!(
                "The app opened, but I couldn’t confirm focus on {label}."
            ));
        }
    }
    Ok(format!("Focused {label}"))
}

#[cfg(not(target_os = "macos"))]
pub async fn focus(_query: &str) -> Result<String, String> {
    Err("Window focus is currently available on macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_selection_requires_a_unique_match() {
        assert!(choose_window("...", &[("TextEdit".into(), "".into())]).is_err());
        let windows = vec![
            ("Safari".into(), "Roadmap — Q4".into()),
            ("TextEdit".into(), "Roadmap — notes".into()),
        ];
        assert!(choose_window("Roadmap", &windows).is_err());
        assert_eq!(choose_window("Roadmap in TextEdit", &windows), Ok(1));
        assert_eq!(choose_window("Roadmap Q4", &windows), Ok(0));
        assert!(choose_window("Road", &windows).is_err());
        assert!(choose_window("Roadmap in Mail", &windows).is_err());
    }
    #[test]
    fn task_and_indirect_requests_are_not_window_commands() {
        for text in [
            "focus on my tasks",
            "move focus to the task list",
            "I want to focus on pricing",
            "don't switch to Safari",
            "how do I switch to Safari",
            "switch to",
        ] {
            assert_eq!(command_target(text), None, "{text}");
        }
    }
}
