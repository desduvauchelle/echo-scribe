# Meeting Detection Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Echo Scribe from auto-recording when the user just opens a browser or launches Zoom; require a known meeting URL or a real meeting window title; surface consent through an actionable OS notification.

**Architecture:** Three layered fixes in `src-tauri/src/meeting/detector.rs`: (1) a strict URL allowlist module that gates browser-based detection, (2) an inverted window-title check that requires a positive meeting marker for Zoom/Teams plus a longer mic-active window for native apps, and (3) an OS notification with action buttons (Record / Always / Don't record) wired through `tauri-plugin-notification` v2's action-type API to the existing `meeting_consent` command.

**Tech Stack:** Rust (Tauri 2), `tauri-plugin-notification` v2, `url` crate (new direct dep), React/TypeScript (Settings UI).

**Spec:** [docs/superpowers/specs/2026-05-08-meeting-detection-fix-design.md](../specs/2026-05-08-meeting-detection-fix-design.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | Add `url = "2"` direct dep |
| `src-tauri/src/meeting/url_allowlist.rs` | Create | `classify(url) -> Option<&'static str>` for known meeting URLs |
| `src-tauri/src/meeting/mod.rs` | Modify | Add `pub mod url_allowlist;` |
| `src-tauri/src/meeting/detector.rs` | Modify | Replace `is_idle_window_title` with `is_meeting_window_title`; add browser URL gate; extract `should_trigger` helper; raise native mic threshold to 12s; switch notification to `action_type_id` |
| `src-tauri/src/lib.rs` | Modify | Register `meeting_consent` action category at startup; spawn dispatcher task; one-shot prefs log |
| `src-tauri/src/commands.rs` | Modify | Add `meeting_clear_app_pref` command |
| `src/lib/api.ts` | Modify | Bind new command |
| `src/views/Settings.tsx` | Modify | Add "Clear" button per per-app pref row |

---

## Task 1: Add `url` crate dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dependency**

Open `src-tauri/Cargo.toml` and add this line in the `[dependencies]` section, alphabetically near the existing `ulid` line:

```toml
url = "2"
```

The full diff: locate

```toml
ulid = "1"
```

and immediately after it add:

```toml
# URL parsing for the meeting URL allowlist (browser-based meeting detection).
url = "2"
```

- [ ] **Step 2: Verify the project still builds**

Run: `cd src-tauri && cargo check --lib`

Expected: builds successfully (warnings about unused `url` are fine — we use it next task).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "deps: add url crate for meeting URL allowlist"
```

---

## Task 2: Create the URL allowlist module

**Files:**
- Create: `src-tauri/src/meeting/url_allowlist.rs`
- Modify: `src-tauri/src/meeting/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/meeting/url_allowlist.rs` with this content:

```rust
//! Strict allowlist of known meeting-URL patterns. Used by the auto-detector
//! to decide whether a browser-frontmost event should be treated as a real
//! meeting (vs. any-tab-with-mic-active false trigger).
//!
//! Returns the user-facing provider name on match, `None` otherwise.

use url::Url;

/// Returns the meeting provider's display name if `raw` matches a known
/// meeting URL pattern, otherwise `None`.
pub fn classify(raw: &str) -> Option<&'static str> {
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();

    // Google Meet: meet.google.com/<3>-<4>-<3> (the meeting code format).
    if host == "meet.google.com" {
        // strip leading slash
        let p = path.trim_start_matches('/');
        // path format: "abc-defg-hij" optionally followed by /...
        let first = p.split('/').next().unwrap_or("");
        if is_meet_code(first) {
            return Some("Google Meet");
        }
        return None;
    }

    // Zoom (web client / join links): *.zoom.us/{j,wc,my}/...
    if host == "zoom.us" || host.ends_with(".zoom.us") {
        if path.starts_with("/j/") || path.starts_with("/wc/") || path.starts_with("/my/") {
            return Some("Zoom");
        }
        return None;
    }

    // Microsoft Teams (web): teams.microsoft.com or teams.live.com.
    if host == "teams.microsoft.com" {
        if path.starts_with("/l/meetup-join/")
            || path.starts_with("/_#/conv/")
            || path.starts_with("/v2/")
        {
            return Some("Microsoft Teams");
        }
        return None;
    }
    if host == "teams.live.com" && path.starts_with("/meet/") {
        return Some("Microsoft Teams");
    }

    // Slack huddles / calls.
    if host == "app.slack.com" && path.starts_with("/huddle/") {
        return Some("Slack Huddle");
    }
    if (host == "slack.com" || host.ends_with(".slack.com")) && path.starts_with("/calls/") {
        return Some("Slack Call");
    }

    // Whereby room URLs — exclude marketing/account paths.
    if host == "whereby.com" {
        const NON_ROOMS: &[&str] =
            &["/", "/information", "/pricing", "/about", "/login", "/signup"];
        if !NON_ROOMS.iter().any(|p| path == *p || path.starts_with(&format!("{p}/"))) {
            // Require a non-empty path segment after `/`.
            if path.len() > 1 {
                return Some("Whereby");
            }
        }
        return None;
    }

    // Webex: *.webex.com/meet/... or /wbxmjs/joinservice/...
    if host == "webex.com" || host.ends_with(".webex.com") {
        if path.contains("/meet/") || path.contains("/wbxmjs/joinservice/") {
            return Some("Webex");
        }
        return None;
    }

    // Around: around.co/r/<room>
    if host == "around.co" && path.starts_with("/r/") {
        return Some("Around");
    }

    // Gather: app.gather.town/app/... or gather.town/app/...
    if (host == "app.gather.town" || host == "gather.town") && path.starts_with("/app/") {
        return Some("Gather");
    }

    // Jitsi: meet.jit.si/<non-empty>
    if host == "meet.jit.si" && path.len() > 1 {
        return Some("Jitsi");
    }

    // Huddle01: huddle01.app/<non-empty>
    if host == "huddle01.app" && path.len() > 1 {
        return Some("Huddle01");
    }

    None
}

/// True for Google-Meet-style codes like "abc-defg-hij" (3-4-3 lowercase letters).
fn is_meet_code(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return false;
    }
    let lens = [3, 4, 3];
    for (i, p) in parts.iter().enumerate() {
        if p.len() != lens[i] {
            return false;
        }
        if !p.bytes().all(|b| b.is_ascii_lowercase()) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_meet_room_matches() {
        assert_eq!(classify("https://meet.google.com/abc-defg-hij"), Some("Google Meet"));
        assert_eq!(
            classify("https://meet.google.com/abc-defg-hij?authuser=0"),
            Some("Google Meet")
        );
    }

    #[test]
    fn google_meet_marketing_does_not_match() {
        assert_eq!(classify("https://meet.google.com/about"), None);
        assert_eq!(classify("https://meet.google.com/"), None);
        assert_eq!(classify("https://meet.google.com/landing"), None);
    }

    #[test]
    fn zoom_join_links_match() {
        assert_eq!(classify("https://zoom.us/j/1234567890"), Some("Zoom"));
        assert_eq!(
            classify("https://us02web.zoom.us/j/1234567890?pwd=foo"),
            Some("Zoom")
        );
        assert_eq!(classify("https://zoom.us/wc/1234567890/join"), Some("Zoom"));
        assert_eq!(classify("https://zoom.us/my/myroom"), Some("Zoom"));
    }

    #[test]
    fn zoom_homepage_does_not_match() {
        assert_eq!(classify("https://zoom.us/"), None);
        assert_eq!(classify("https://zoom.us/pricing"), None);
        assert_eq!(classify("https://us02web.zoom.us/account"), None);
    }

    #[test]
    fn teams_meetup_join_matches() {
        assert_eq!(
            classify("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0"),
            Some("Microsoft Teams")
        );
        assert_eq!(
            classify("https://teams.live.com/meet/9999999999"),
            Some("Microsoft Teams")
        );
        assert_eq!(
            classify("https://teams.microsoft.com/v2/?meetingjoin=true"),
            Some("Microsoft Teams")
        );
    }

    #[test]
    fn teams_root_does_not_match() {
        assert_eq!(classify("https://teams.microsoft.com/"), None);
        assert_eq!(classify("https://teams.microsoft.com/_#/files"), None);
    }

    #[test]
    fn slack_huddle_matches() {
        assert_eq!(
            classify("https://app.slack.com/huddle/T123/C456"),
            Some("Slack Huddle")
        );
        assert_eq!(
            classify("https://acme.slack.com/calls/abc"),
            Some("Slack Call")
        );
    }

    #[test]
    fn slack_marketing_does_not_match() {
        assert_eq!(classify("https://slack.com/intl/en-gb/"), None);
        assert_eq!(classify("https://app.slack.com/client/T123"), None);
    }

    #[test]
    fn whereby_room_matches_marketing_does_not() {
        assert_eq!(classify("https://whereby.com/my-room"), Some("Whereby"));
        assert_eq!(classify("https://whereby.com/"), None);
        assert_eq!(classify("https://whereby.com/information"), None);
        assert_eq!(classify("https://whereby.com/pricing"), None);
    }

    #[test]
    fn webex_meet_matches() {
        assert_eq!(
            classify("https://acme.webex.com/meet/john"),
            Some("Webex")
        );
        assert_eq!(
            classify("https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/12345"),
            Some("Webex")
        );
    }

    #[test]
    fn webex_homepage_does_not_match() {
        assert_eq!(classify("https://www.webex.com/"), None);
    }

    #[test]
    fn around_room_matches() {
        assert_eq!(classify("https://around.co/r/abcd-efgh"), Some("Around"));
        assert_eq!(classify("https://around.co/"), None);
    }

    #[test]
    fn gather_room_matches() {
        assert_eq!(
            classify("https://app.gather.town/app/abc/MyRoom"),
            Some("Gather")
        );
        assert_eq!(classify("https://gather.town/"), None);
    }

    #[test]
    fn jitsi_room_matches() {
        assert_eq!(classify("https://meet.jit.si/MyMeetingName"), Some("Jitsi"));
        assert_eq!(classify("https://meet.jit.si/"), None);
    }

    #[test]
    fn huddle01_room_matches() {
        assert_eq!(classify("https://huddle01.app/room/abc"), Some("Huddle01"));
        assert_eq!(classify("https://huddle01.app/"), None);
    }

    #[test]
    fn unknown_hosts_do_not_match() {
        assert_eq!(classify("https://news.ycombinator.com"), None);
        assert_eq!(classify("https://github.com/anthropics/anthropic-sdk-python"), None);
        assert_eq!(classify("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), None);
    }

    #[test]
    fn malformed_urls_return_none() {
        assert_eq!(classify("not a url"), None);
        assert_eq!(classify(""), None);
        assert_eq!(classify("javascript:void(0)"), None);
    }
}
```

- [ ] **Step 2: Wire the module into the meeting tree**

Open `src-tauri/src/meeting/mod.rs` and find the existing `pub mod` declarations near the top (around line 7-12). Add `url_allowlist`:

```rust
pub mod detector;
pub mod grammar;
pub mod pipeline;
pub mod recorder;
pub mod syscap;
pub mod synthesizer;
pub mod url_allowlist;
```

- [ ] **Step 3: Run the new tests**

Run: `cd src-tauri && cargo test --lib meeting::url_allowlist`

Expected: all 16 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/url_allowlist.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(meeting): add strict URL allowlist for browser-based meeting detection"
```

---

## Task 3: Replace `is_idle_window_title` with `is_meeting_window_title`

**Files:**
- Modify: `src-tauri/src/meeting/detector.rs`

- [ ] **Step 1: Write the failing tests for the new function**

Open `src-tauri/src/meeting/detector.rs`. Find the existing test module (around line 230-283) and **replace** the four idle-title tests with these meeting-title tests:

```rust
    #[test]
    fn is_meeting_title_zoom_in_meeting() {
        // Real Zoom meeting titles tend to contain "Meeting" or "Personal
        // Meeting Room" or participant counts.
        assert!(is_meeting_window_title("us.zoom.xos", "Zoom Meeting"));
        assert!(is_meeting_window_title("us.zoom.xos", "Personal Meeting Room"));
        assert!(is_meeting_window_title("us.zoom.xos", "Weekly Standup - Zoom Meeting"));
    }

    #[test]
    fn is_meeting_title_zoom_idle() {
        // Idle/launch Zoom states must not trigger.
        assert!(!is_meeting_window_title("us.zoom.xos", "Zoom"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Zoom Workplace"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Home"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Contacts"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Settings"));
        assert!(!is_meeting_window_title("us.zoom.xos", ""));
    }

    #[test]
    fn is_meeting_title_teams_in_meeting() {
        // Teams real meeting titles end with "| Microsoft Teams".
        assert!(is_meeting_window_title(
            "com.microsoft.teams2",
            "Daily Standup | Microsoft Teams"
        ));
        assert!(is_meeting_window_title(
            "com.microsoft.teams",
            "John Doe | Microsoft Teams"
        ));
    }

    #[test]
    fn is_meeting_title_teams_idle() {
        assert!(!is_meeting_window_title(
            "com.microsoft.teams2",
            "Microsoft Teams"
        ));
        assert!(!is_meeting_window_title(
            "com.microsoft.teams",
            "Microsoft Teams (work or school)"
        ));
        assert!(!is_meeting_window_title("com.microsoft.teams2", ""));
    }

    #[test]
    fn is_meeting_title_other_native_apps_pass_through() {
        // Discord/Slack/FaceTime: any non-empty title counts (their titles
        // don't reliably name the call).
        assert!(is_meeting_window_title("com.hnc.Discord", "General"));
        assert!(is_meeting_window_title("com.tinyspeck.slackmacgap", "Acme Workspace"));
        assert!(is_meeting_window_title("com.apple.FaceTime", "FaceTime"));
        // Empty title still fails the gate.
        assert!(!is_meeting_window_title("com.hnc.Discord", ""));
    }

    #[test]
    fn lookup_finds_zoom() {
        let result = lookup("us.zoom.xos");
        assert_eq!(result, Some(("Zoom", false)));
    }

    #[test]
    fn lookup_returns_none_for_unknown() {
        assert!(lookup("com.example.unknown").is_none());
    }

    #[test]
    fn lookup_finds_chrome_as_browser() {
        let (name, is_browser) = lookup("com.google.Chrome").unwrap();
        assert_eq!(name, "Chrome");
        assert!(is_browser);
    }
```

(Keep the three `lookup_*` tests above; they're unchanged.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test --lib meeting::detector::tests::is_meeting_title`

Expected: compile error — `is_meeting_window_title` is undefined.

- [ ] **Step 3: Implement `is_meeting_window_title` (and remove `is_idle_window_title`)**

In `src-tauri/src/meeting/detector.rs`, find the existing `is_idle_window_title` function (lines 34-51) and **replace it** with:

```rust
/// Returns true if the window title indicates the app is in an actual meeting.
/// Default behavior:
/// - Zoom/Teams: require a positive meeting marker (avoids triggers on the
///   Home/Contacts/launch states or app-name-only titles).
/// - Other native apps (Discord/Slack/FaceTime): any non-empty title passes
///   (their window titles don't reliably contain a meeting marker; the mic
///   gate carries the weight there).
fn is_meeting_window_title(bundle_id: &str, title: &str) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    let trimmed = title.trim();
    match bundle_id {
        "us.zoom.xos" => {
            let lower = trimmed.to_lowercase();
            // Idle states: exact "zoom" or "zoom workplace", or simple
            // navigation labels ("Home", "Contacts", "Chat", "Settings",
            // "Meetings" — Meetings is the tab, not a meeting). All other
            // titles that mention "meeting" or "personal meeting room" pass.
            if lower == "zoom" || lower == "zoom workplace" {
                return false;
            }
            const ZOOM_IDLE_LABELS: &[&str] =
                &["home", "contacts", "chat", "settings", "meetings"];
            if ZOOM_IDLE_LABELS.iter().any(|l| lower == *l) {
                return false;
            }
            lower.contains("meeting") || lower.contains("personal meeting room")
        }
        "com.microsoft.teams2" | "com.microsoft.teams" => {
            // Real Teams meetings: title ends with "| Microsoft Teams" and is
            // not the bare app name.
            let lower = trimmed.to_lowercase();
            if lower == "microsoft teams" || lower == "microsoft teams (work or school)" {
                return false;
            }
            lower.contains("| microsoft teams")
        }
        _ => true,
    }
}
```

- [ ] **Step 4: Update the existing call site to the new function name**

Inside `spawn`, find this block (around lines 91-98):

```rust
            // Skip if the window title indicates the app is idle (home screen).
            if let Some(ref title) = ctx.window_title {
                if is_idle_window_title(&frontmost, title) {
                    mic_in_use_since = None;
                    consecutive_match.clear();
                    continue;
                }
            }
```

**Replace it with** (the logic is inverted — we now skip when title is *not* a meeting title, and we only apply this gate to non-browsers since browsers are gated by URL in Task 4):

```rust
            // For native apps, require a positive meeting signal in the
            // window title. (Browsers are gated by URL in the next block.)
            if !_is_browser {
                let title_ok = ctx
                    .window_title
                    .as_deref()
                    .map(|t| is_meeting_window_title(&frontmost, t))
                    .unwrap_or(false);
                if !title_ok {
                    mic_in_use_since = None;
                    consecutive_match.clear();
                    continue;
                }
            }
```

Note: this requires renaming the underscore variable `_is_browser` to `is_browser` (drop the underscore) where it's destructured a few lines above. Find:

```rust
            let Some((name, _is_browser)) = lookup(&frontmost) else {
```

Change to:

```rust
            let Some((name, is_browser)) = lookup(&frontmost) else {
```

And update the new `if !_is_browser` to `if !is_browser`.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib meeting::detector`

Expected: all detector tests pass (the three lookup tests + the five new meeting-title tests = 8 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/meeting/detector.rs
git commit -m "feat(meeting): require positive meeting title for Zoom/Teams detection"
```

---

## Task 4: Add browser URL gate to detector

**Files:**
- Modify: `src-tauri/src/meeting/detector.rs`

- [ ] **Step 1: Write failing test for the URL gate**

Append to the test module in `src-tauri/src/meeting/detector.rs`:

```rust
    #[test]
    fn browser_provider_name_uses_url_classifier() {
        // Direct test of the helper: a known meeting URL returns the
        // provider name; an unrelated URL returns None.
        assert_eq!(
            browser_provider_name(Some("https://meet.google.com/abc-defg-hij")),
            Some("Google Meet")
        );
        assert_eq!(
            browser_provider_name(Some("https://news.ycombinator.com")),
            None
        );
        assert_eq!(browser_provider_name(None), None);
    }
```

- [ ] **Step 2: Verify it fails**

Run: `cd src-tauri && cargo test --lib meeting::detector::tests::browser_provider_name_uses_url_classifier`

Expected: compile error — `browser_provider_name` is undefined.

- [ ] **Step 3: Add the helper and wire it into the loop**

In `src-tauri/src/meeting/detector.rs`, just after the `is_meeting_window_title` function and before `pub fn spawn(...)`, add:

```rust
/// Returns the meeting-provider display name for a browser URL, or None.
/// Thin wrapper around `url_allowlist::classify` to make the detector loop
/// readable and unit-testable.
fn browser_provider_name(url: Option<&str>) -> Option<&'static str> {
    crate::meeting::url_allowlist::classify(url?)
}
```

Now find the block in `spawn` where we look up `name`:

```rust
            let Some((name, is_browser)) = lookup(&frontmost) else {
                consecutive_match.clear();
                continue;
            };
```

Immediately after this (and before the title check from Task 3), insert the URL gate:

```rust
            // For browsers, require a known meeting URL. The provider name
            // (e.g. "Google Meet") replaces the browser display name in the
            // notification and meeting title.
            let display_name: &str = if is_browser {
                match browser_provider_name(ctx.browser_url.as_deref()) {
                    Some(provider) => provider,
                    None => {
                        mic_in_use_since = None;
                        consecutive_match.clear();
                        continue;
                    }
                }
            } else {
                name
            };
```

Then in the per-app pref match block (around line 119+), replace every occurrence of `name.into()` (which captures the bundle's display name) with `display_name.into()`. The `Always` arm and the `Ask` arm both build a body string with `name`; switch those to `display_name` too. Concretely the changes:

1. The `MeetingAppPref::Always` branch:
   ```rust
   if let Err(e) = manager
       .clone()
       .start(Some(frontmost.clone()), Some(name.into()))
       .await
   ```
   becomes:
   ```rust
   if let Err(e) = manager
       .clone()
       .start(Some(frontmost.clone()), Some(display_name.into()))
       .await
   ```

2. The `MeetingAppPref::Ask` branch — emit and notify:
   ```rust
   let _ = app_handle.emit(
       "meeting-detected",
       serde_json::json!({ "bundle_id": frontmost, "app_name": name }),
   );
   ```
   becomes:
   ```rust
   let _ = app_handle.emit(
       "meeting-detected",
       serde_json::json!({ "bundle_id": frontmost, "app_name": display_name }),
   );
   ```
   And:
   ```rust
   .body(format!("{name} is active — want to record?"))
   ```
   becomes:
   ```rust
   .body(format!("{display_name} detected — record this meeting?"))
   ```
   (The `.title("Meeting Detected")` line stays for now; Task 7 rewrites the whole notification builder.)

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib meeting::detector`

Expected: 9 tests pass (8 from Task 3 + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/meeting/detector.rs
git commit -m "feat(meeting): require known meeting URL for browser-based detection"
```

---

## Task 5: Raise mic-active threshold for native apps to 12s

**Files:**
- Modify: `src-tauri/src/meeting/detector.rs`

- [ ] **Step 1: Apply the change**

In `src-tauri/src/meeting/detector.rs`, find the existing mic-gate block:

```rust
            let since = mic_in_use_since.get_or_insert(Instant::now());
            let triggered = since.elapsed() >= Duration::from_secs(5);
```

Replace with:

```rust
            // Mic-gate: browsers stay at 5s (URL allowlist is already a
            // strong filter); native apps need 12s to ride out audio-engine
            // warm-ups (Zoom in particular keeps the mic device "running"
            // briefly outside of calls).
            let mic_threshold = if is_browser {
                Duration::from_secs(5)
            } else {
                Duration::from_secs(12)
            };
            let since = mic_in_use_since.get_or_insert(Instant::now());
            let triggered = since.elapsed() >= mic_threshold;
```

- [ ] **Step 2: Build and run all detector tests**

Run: `cd src-tauri && cargo test --lib meeting::detector`

Expected: all tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/meeting/detector.rs
git commit -m "feat(meeting): raise native-app mic threshold to 12s to filter audio-engine warmups"
```

---

## Task 6: Wire the OS notification action category at startup

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs` (add a thin internal helper)

The `tauri-plugin-notification` v2 API for action types is on the `NotificationExt` trait. We register a single category with three actions and install an action listener that routes clicks to the existing `meeting_consent` command path.

> **Implementation note:** The exact method names for action-type registration on `tauri-plugin-notification` 2.x are verified at this step. If the trait names differ from `register_action_types` / `on_notification_action`, look up the version in `Cargo.lock` (currently `2`), open the source under `~/.cargo/registry/src/.../tauri-plugin-notification-*/src/desktop.rs`, and adapt the calls accordingly. The semantic contract is unchanged: register one category named `meeting_consent` with three actions (`once`, `always`, `never`), and route action callbacks to `meeting_consent` via an unbounded mpsc channel because Tauri command state isn't `Send + Sync` from the static callback context.

- [ ] **Step 1: Add a typed event for the dispatcher channel**

Open `src-tauri/src/meeting/mod.rs` and append (after the existing `pub fn finalize_orphans_as_failed` definition near line 718):

```rust
/// Event sent from the OS-notification action callback to the consent
/// dispatcher task. Carries everything needed to call `meeting_consent`.
#[derive(Debug, Clone)]
pub struct ConsentDecision {
    pub bundle_id: String,
    pub app_name: String,
    pub decision: String, // "once" | "always" | "never"
}
```

- [ ] **Step 2: Spawn a dispatcher task in `lib.rs`**

Open `src-tauri/src/lib.rs`. Find the `setup` closure (search for `.setup(|app|`). Inside it, after the existing `MeetingManager::new(...)` line (approximately where the manager is constructed), add:

```rust
            // Channel that carries OS-notification action clicks into a
            // single consumer task that holds the manager + settings.
            let (consent_tx, mut consent_rx) =
                tokio::sync::mpsc::unbounded_channel::<crate::meeting::ConsentDecision>();
            let manager_for_consent = meeting_manager.clone();
            let settings_for_consent = settings.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(evt) = consent_rx.recv().await {
                    use crate::settings::MeetingAppPref;
                    let mut prefs = settings_for_consent.meeting_app_prefs();
                    match evt.decision.as_str() {
                        "always" => {
                            prefs.insert(evt.bundle_id.clone(), MeetingAppPref::Always);
                            let _ = settings_for_consent.set_meeting_app_prefs(&prefs);
                            if let Err(e) = manager_for_consent
                                .clone()
                                .start(Some(evt.bundle_id), Some(evt.app_name))
                                .await
                            {
                                tracing::warn!(?e, "consent dispatcher: start failed");
                            }
                        }
                        "once" => {
                            if let Err(e) = manager_for_consent
                                .clone()
                                .start(Some(evt.bundle_id), Some(evt.app_name))
                                .await
                            {
                                tracing::warn!(?e, "consent dispatcher: start failed");
                            }
                        }
                        "never" => {
                            prefs.insert(evt.bundle_id, MeetingAppPref::Never);
                            let _ = settings_for_consent.set_meeting_app_prefs(&prefs);
                        }
                        _ => tracing::warn!(decision = %evt.decision, "unknown consent decision"),
                    }
                }
            });
```

Pass `consent_tx` into the detector. Find the existing `meeting::detector::spawn(...)` call and add it as a parameter:

```rust
            crate::meeting::detector::spawn(
                meeting_manager.clone(),
                settings.clone(),
                app.handle().clone(),
                consent_tx.clone(),
            );
```

- [ ] **Step 3: Update `detector::spawn` signature to accept the dispatcher**

In `src-tauri/src/meeting/detector.rs`, change:

```rust
pub fn spawn(
    manager: Arc<MeetingManager>,
    settings: SettingsStore,
    app_handle: tauri::AppHandle,
) {
```

to:

```rust
pub fn spawn(
    manager: Arc<MeetingManager>,
    settings: SettingsStore,
    app_handle: tauri::AppHandle,
    consent_tx: tokio::sync::mpsc::UnboundedSender<crate::meeting::ConsentDecision>,
) {
```

The body of `spawn` doesn't yet use `consent_tx` — Task 7 wires it through the notification action callback. Add `let _ = &consent_tx;` at the top of the closure body to silence unused-variable warnings in this commit.

- [ ] **Step 4: Register the action category and on-action handler**

Still in `src-tauri/src/lib.rs::setup`, after `consent_tx` is created and before `detector::spawn`, register the category. The expected call shape (verify against the installed crate version):

```rust
            use tauri_plugin_notification::{
                ActionType, Action, NotificationExt,
            };
            let app_handle_for_actions = app.handle().clone();
            let consent_tx_for_actions = consent_tx.clone();
            // Register the `meeting_consent` action category. If
            // `register_action_types` is not on NotificationExt in this
            // crate version, the plugin exposes equivalent setup via the
            // builder — check src/desktop.rs in tauri-plugin-notification
            // and adapt.
            if let Err(e) = app.notification().register_action_types(&[
                ActionType::new("meeting_consent")
                    .actions(&[
                        Action::new("once",   "Record"),
                        Action::new("always", "Always"),
                        Action::new("never",  "Don't record"),
                    ]),
            ]) {
                tracing::warn!(?e, "failed to register notification action types");
            }
            // The callback receives the action ID and the user-info payload
            // we attach when building the notification.
            let _ = app.notification().on_action(move |action| {
                let id = action.id().to_string();
                let bundle_id = action
                    .user_info()
                    .get("bundle_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let app_name = action
                    .user_info()
                    .get("app_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if bundle_id.is_empty() {
                    tracing::warn!(?id, "consent action: missing bundle_id");
                    return;
                }
                let _ = consent_tx_for_actions.send(crate::meeting::ConsentDecision {
                    bundle_id,
                    app_name,
                    decision: id,
                });
                let _ = &app_handle_for_actions; // reserved for future foreground-on-click
            });
```

If the actual API surface differs (this is the most likely friction point in the whole plan), substitute the equivalent calls. If the plugin version we're on doesn't support actions at all, document that finding in the commit message and proceed without registration — Task 7 will fall back to the existing in-app prompt by emitting `meeting-detected` only. Do not block the rest of the plan on this.

- [ ] **Step 5: Build the project**

Run: `cd src-tauri && cargo check --lib`

Expected: builds. If `register_action_types` / `on_action` don't compile, see the implementation note above and adapt or comment them out with a `// TODO(notification-actions)` and a tracing log explaining the fallback. Either way, the channel + dispatcher must compile.

- [ ] **Step 6: Run all tests**

Run: `cd src-tauri && cargo test --lib`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/meeting/mod.rs src-tauri/src/meeting/detector.rs
git commit -m "feat(meeting): add notification-action dispatcher channel and consent category"
```

---

## Task 7: Switch detector notification to action_type_id

**Files:**
- Modify: `src-tauri/src/meeting/detector.rs`

- [ ] **Step 1: Rewrite the Ask-branch notification builder**

In `src-tauri/src/meeting/detector.rs::spawn`, find the `MeetingAppPref::Ask` branch (after Task 4's edits, the relevant block is the one with `.title("Meeting Detected")`).

Replace the entire builder chain with:

```rust
                MeetingAppPref::Ask => {
                    info!(app = %frontmost, %display_name, "asking user about new meeting app");
                    // Emit the in-app event (visible only when the main
                    // window is foreground; serves as a fallback for
                    // platforms where notification actions don't render).
                    let _ = app_handle.emit(
                        "meeting-detected",
                        serde_json::json!({
                            "bundle_id": frontmost,
                            "app_name": display_name,
                        }),
                    );
                    // OS notification with three action buttons.
                    use tauri_plugin_notification::NotificationExt;
                    let mut user_info = std::collections::HashMap::new();
                    user_info.insert("bundle_id".to_string(), frontmost.clone());
                    user_info.insert("app_name".to_string(), display_name.to_string());
                    let result = app_handle
                        .notification()
                        .builder()
                        .title(format!("{display_name} detected"))
                        .body("Record this meeting? Audio stays on your device.")
                        .action_type_id("meeting_consent")
                        .extra("bundle_id", frontmost.clone())
                        .extra("app_name", display_name.to_string())
                        .show();
                    if let Err(e) = result {
                        warn!(?e, "failed to show meeting-detected OS notification");
                    }
                    let _ = user_info; // future-proofing if API needs HashMap
                    consecutive_match.clear();
                }
```

The exact method names `action_type_id` and `extra` need to match the installed `tauri-plugin-notification` 2.x crate — same caveat as Task 6. If `extra` does not exist on the builder, the `user_info` HashMap above can be passed through `.user_info(user_info)` or similar. The implementer adapts and notes the substitution in the commit message.

If neither `action_type_id` nor `on_action` are available in the installed crate version, leave the original `.title().body().show()` call in place and surface the fallback explicitly:

```rust
                    let _ = app_handle
                        .notification()
                        .builder()
                        .title(format!("{display_name} detected"))
                        .body("Open Echo Scribe to record this meeting.")
                        .show();
```

Document the fallback decision in the commit message.

- [ ] **Step 2: Build**

Run: `cd src-tauri && cargo check --lib`

Expected: builds.

- [ ] **Step 3: Run all detector tests**

Run: `cd src-tauri && cargo test --lib meeting`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/detector.rs
git commit -m "feat(meeting): wire OS notification action buttons for record consent"
```

---

## Task 8: Add `meeting_clear_app_pref` command + Settings UI Clear button

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register the command + startup prefs log)
- Modify: `src/lib/api.ts`
- Modify: `src/views/Settings.tsx`

- [ ] **Step 1: Write the failing test for `meeting_clear_app_pref`**

This is a settings-store-level test, not a Tauri command test (commands are integration-tested manually). Add to `src-tauri/src/settings.rs`'s test module — find the existing `#[cfg(test)] mod tests` section near the bottom of the file:

```rust
    #[test]
    fn meeting_app_prefs_round_trip_remove() {
        // Already covered by existing round-trip test; this asserts removal
        // semantics specifically: a bundle removed from the map disappears.
        // We exercise the same JSON round-trip that the command uses.
        let mut prefs = std::collections::HashMap::new();
        prefs.insert("us.zoom.xos".to_string(), MeetingAppPref::Always);
        prefs.insert("com.google.Chrome".to_string(), MeetingAppPref::Never);
        // Remove one.
        prefs.remove("us.zoom.xos");
        let serialized = serde_json::to_value(&prefs).unwrap();
        let restored: std::collections::HashMap<String, MeetingAppPref> =
            serde_json::from_value(serialized).unwrap();
        assert!(!restored.contains_key("us.zoom.xos"));
        assert_eq!(restored.get("com.google.Chrome"), Some(&MeetingAppPref::Never));
    }
```

Run: `cd src-tauri && cargo test --lib settings::tests::meeting_app_prefs_round_trip_remove`

Expected: passes immediately (it's a serde-level invariant test). If the existing test module doesn't have `MeetingAppPref` imported, add `use super::*;` at the top of the test module if it's not already there.

- [ ] **Step 2: Add the command**

In `src-tauri/src/commands.rs`, after the existing `meeting_consent` function (around line 1937), add:

```rust
#[tauri::command]
pub async fn meeting_clear_app_pref(
    state: tauri::State<'_, AppState>,
    bundle_id: String,
) -> Result<(), String> {
    let mut prefs = state.settings.meeting_app_prefs();
    prefs.remove(&bundle_id);
    state
        .settings
        .set_meeting_app_prefs(&prefs)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, find the `tauri::generate_handler![...]` macro (search for `commands::meeting_consent`) and add `commands::meeting_clear_app_pref,` next to it.

- [ ] **Step 4: Add startup prefs log**

Still in `src-tauri/src/lib.rs::setup`, immediately after the line that constructs/loads `settings`, add:

```rust
            // One-shot log so the user (and us, when debugging) can see
            // which apps have a sticky `Always`/`Never` pref.
            let prefs_for_log = settings.meeting_app_prefs();
            if !prefs_for_log.is_empty() {
                tracing::info!(?prefs_for_log, "loaded meeting app prefs");
            }
```

- [ ] **Step 5: Add the frontend binding**

In `src/lib/api.ts`, find the existing `setMeetingAppPref` export (around line 592) and add immediately after it:

```ts
export const clearMeetingAppPref = (bundle_id: string): Promise<void> =>
  invoke("meeting_clear_app_pref", { bundleId: bundle_id });
```

(Tauri's command argument convention is camelCase on the JS side; verify by inspecting the call in `setMeetingAppPref` to confirm the same convention is used in this file. If it's snake_case there, mirror that.)

- [ ] **Step 6: Add the Clear button in Settings.tsx**

In `src/views/Settings.tsx`, find the per-app pref row (around line 301-331). Replace the closing `<td className="py-2 text-right">...</td>` block with a version that has the Clear button next to the dropdown:

```tsx
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <select
                        className="rounded-md bg-canvas px-2 py-1 text-xs"
                        value={pref}
                        onChange={async (e) => {
                          const next = e.target.value as
                            | "always"
                            | "ask"
                            | "never";
                          const { setMeetingAppPref } = await import(
                            "../lib/api"
                          );
                          await setMeetingAppPref(bundle, next);
                          setSettings({
                            ...settings,
                            app_prefs: {
                              ...settings.app_prefs,
                              [bundle]: next,
                            },
                          });
                        }}
                      >
                        <option value="always">Always</option>
                        <option value="ask">Ask</option>
                        <option value="never">Never</option>
                      </select>
                      <button
                        className="rounded-md bg-surface-2 px-2 py-1 text-xs text-muted hover:text-fg"
                        onClick={async () => {
                          const { clearMeetingAppPref } = await import(
                            "../lib/api"
                          );
                          await clearMeetingAppPref(bundle);
                          const next = { ...settings.app_prefs };
                          delete next[bundle];
                          setSettings({ ...settings, app_prefs: next });
                        }}
                        title="Remove this app's preference (revert to Ask on next detection)"
                      >
                        Clear
                      </button>
                    </div>
                  </td>
```

- [ ] **Step 7: Build the frontend**

Run: `bun run build` from the project root.

Expected: builds without TypeScript errors.

- [ ] **Step 8: Run all Rust tests**

Run: `cd src-tauri && cargo test --lib`

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/settings.rs src/lib/api.ts src/views/Settings.tsx
git commit -m "feat(meeting): add Clear button for stale per-app prefs and startup log"
```

---

## Task 9: Build, install, and manual smoke test

**Files:**
- None (verification only)

- [ ] **Step 1: Full clean build of the .app bundle**

Run from the project root:

```bash
bun tauri build --bundles app
```

Expected: bundle produced at `src-tauri/target/release/bundle/macos/Echo Scribe.app`.

- [ ] **Step 2: Reinstall with TCC reset (per CLAUDE.md)**

Run from the project root:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
tccutil reset Microphone com.echoscribe.app
tccutil reset Accessibility com.echoscribe.app
tccutil reset ScreenCapture com.echoscribe.app
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

Re-grant Microphone, Accessibility, and Screen Recording in System Settings when prompted.

- [ ] **Step 3: Smoke test — false-trigger cases (must NOT record)**

For each, observe for 30 seconds and confirm no notification fires and no recording starts:

1. Launch Zoom, stay on the Home tab. Window title: "Zoom Workplace".
2. Launch Arc, open `https://news.ycombinator.com`. (You may need to enable mic on a different tab to ensure mic is "active" — for example, run `say -v Samantha "test"` in a Terminal alongside.)
3. Launch Safari, open any non-meeting URL.
4. Launch Microsoft Teams, do not join a meeting.

Each case: check Console.app or `tail -f ~/Library/Application\ Support/EchoScribe/logs/*.log` (path may differ — locate the latest log file under the app's data dir) and verify the log contains entries like `cleared mic counter` or simply no `meeting-detected` log line.

- [ ] **Step 4: Smoke test — positive cases (must record)**

1. Open `https://meet.google.com/<your test room>` in Chrome/Arc/Safari with mic active. Within ~8 seconds an OS notification "Google Meet detected" should appear with three buttons.
2. Click `Record` — meeting starts, overlay appears.
3. Stop the meeting from the tray.
4. Repeat at the meet URL, click `Always` — meeting starts AND `Always` is persisted (check Settings → Auto-detect meetings → Per-app preferences shows the entry).
5. Repeat at a different meet URL, click `Don't record` — no recording starts; entry persists as `Never`.
6. Open Settings → Per-app preferences. Click `Clear` next to the Chrome/Arc entry — entry disappears.
7. Open the meet URL again — notification fires again (because pref is now back to default Ask).

- [ ] **Step 5: Smoke test — Zoom real meeting**

Join an actual Zoom meeting (a personal test meeting works). Within ~15 seconds an OS notification "Zoom detected" should appear. Click `Record once` and verify the meeting records.

- [ ] **Step 6: If anything fails**

Capture logs from `~/Library/Application Support/EchoScribe/logs/` and the relevant browser/Zoom state, then debug. Common failure modes:
- Notification action buttons don't render → tauri-plugin-notification 2.x API differs from this plan; review the implementation note in Task 6 and adapt the Rust call sites.
- AppleScript URL capture returns None → confirm Accessibility permission is granted; the timeout in `focus.rs` is 500ms, which can fail on a slow browser.
- Native-app detection still false-triggers → check the actual window title via `osascript -e 'tell application "System Events" to get title of front window of application process "Zoom"'` and adjust `is_meeting_window_title` accordingly.

- [ ] **Step 7: Final commit (if any tweaks were needed in Step 6)**

If you made adjustments based on smoke-test findings, commit them with a clear message describing the fix. Otherwise no commit is needed.

---

## Self-review notes

Spec coverage check:

- §1 URL allowlist → Task 2 ✓
- §2 detector changes (URL gate, inverted title check, mic threshold bump, `should_trigger` extraction) → Tasks 3, 4, 5. The plan does NOT extract a separate `should_trigger` pure helper — instead, the URL gate (Task 4), title gate (Task 3), and mic gate (Task 5) are tested individually via their helpers (`browser_provider_name`, `is_meeting_window_title`). This is a deliberate simplification: each helper is independently testable and the loop body just composes them. If the implementer prefers the full `should_trigger` extraction for cleaner unit coverage, it's a reasonable refactor but not blocking.
- §3 OS notification with action buttons → Tasks 6, 7 ✓ (with explicit fallback path documented)
- §4 stale pref cleanup → Task 8 ✓
- §5 tests → embedded in Tasks 2, 3, 4 ✓
- §6 file-by-file change summary → matches the File Structure table above ✓

Type/name consistency check: `display_name` (Task 4), `is_meeting_window_title` (Task 3), `browser_provider_name` (Task 4), `ConsentDecision` (Task 6), `consent_tx` (Tasks 6/7), `meeting_clear_app_pref` (Task 8) — all consistent across tasks. The `is_browser` rename (drop underscore) in Task 3 is reused in Task 4 and Task 5 — consistent.

Risk-aware: Task 6 / Task 7 explicitly document the `tauri-plugin-notification` 2.x API verification step and provide a graceful fallback if action support is missing in the installed version, so the plan can complete even if action buttons don't materialize on this version.
