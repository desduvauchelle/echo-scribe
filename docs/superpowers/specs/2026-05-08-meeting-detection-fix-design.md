# Meeting auto-detection fix — design

**Date:** 2026-05-08
**Status:** Approved, ready for implementation plan
**Owner:** Denis

## Problem

Meeting auto-detection currently false-triggers on app focus alone. Symptoms reported:

- Opening Arc, Safari, or Chrome with any tab using the mic (Notion voice notes, a YouTube tab, a previous Meet that left the device hot) silently starts a recording.
- Launching the Zoom desktop app — without joining a call — starts a recording within 5 seconds.
- The OS notification that fires has no action buttons; the consent prompt is in-app only and invisible when the main Echo Scribe window is hidden, so recordings begin in the background with no actionable signal to the user.
- Once the user has accidentally clicked "Always for {app}", every focus-and-mic event records silently with no further check.

## Root causes

1. **No URL filter for browsers.** [`detector.rs:104`](../../src-tauri/src/meeting/detector.rs) treats any supported-bundle frontmost + mic-active-5s as a meeting. `capture_context()` already returns `browser_url` ([`focus.rs:25`](../../src-tauri/src/input/focus.rs)) but the detector ignores it.
2. **Zoom idle filter is a narrow string denylist.** [`is_idle_window_title()`](../../src-tauri/src/meeting/detector.rs) catches only the exact strings `"Zoom Workplace"` and `"Zoom"`. Other launch states ("Home", "Meetings", splash) slip through, and Zoom keeps the audio device "running somewhere" outside calls.
3. **OS notification is informational.** The `.title().body()` notification has no action buttons. Action buttons live in an in-app overlay that is invisible unless the Echo Scribe window is foreground.
4. **`Always` prefs are sticky and silent.** Once `MeetingAppPref::Always` is set for a bundle, the detector auto-starts with no further user-facing signal.

## Goals

- Browser detection must require a known meeting URL — no exceptions.
- Native-app detection must require a positive meeting signal in the window title for Zoom/Teams; mic-only is not enough.
- Consent must be visible at the OS layer with actionable buttons (Record / Always / Don't record).
- The user must be able to inspect and clear stale `Always` prefs.

## Non-goals

- Detecting Zoom/Teams calls via URL scheme (`zoommtg://...`) — too fragile.
- Detecting Discord voice activity — no reliable URL or title signal.
- Cross-platform browser URL capture. Current capture is macOS-only via AppleScript; Windows/Linux remain a no-op and browser detection there will simply not trigger, which is strictly safer than today.
- Changes to the auto-stop end-monitor (`spawn_end_monitor`) — that subsystem works as intended.

## Design

### 1. Meeting URL allowlist

New module: `src-tauri/src/meeting/url_allowlist.rs`.

```rust
pub fn classify(url: &str) -> Option<&'static str>;
```

Returns the provider display name (e.g. `"Google Meet"`) for known meeting URLs, `None` otherwise. Strict matching — no keyword fallback.

Initial patterns:

| Provider | Match rule |
|---|---|
| Google Meet | host == `meet.google.com`, path matches `/[a-z]{3}-[a-z]{4}-[a-z]{3}(/.*)?` |
| Zoom (web) | host suffix `zoom.us`, path starts with `/j/`, `/wc/`, or `/my/` |
| Microsoft Teams | host == `teams.microsoft.com` (path starts with `/l/meetup-join/`, `/_#/conv/`, or `/v2/`) OR host == `teams.live.com` (path starts with `/meet/`) |
| Slack Huddle | host == `app.slack.com`, path starts with `/huddle/`; OR host suffix `slack.com`, path starts with `/calls/` |
| Whereby | host == `whereby.com`, path is not `/information`, `/pricing`, `/`, or `/about` |
| Webex | host suffix `webex.com`, path contains `/meet/` or `/wbxmjs/joinservice/` |
| Around | host == `around.co`, path starts with `/r/` |
| Gather | host in {`app.gather.town`, `gather.town`}, path starts with `/app/` |
| Jitsi | host == `meet.jit.si`, path is non-root |
| Huddle01 | host == `huddle01.app`, path is non-root |

Implementation uses `url::Url::parse` (the `url` crate is already a transitive dep via reqwest). For each entry, host is matched as exact or suffix; path is matched with a small regex or `starts_with`. The function returns the first match.

Tests live in the same file: ~20 positive cases (one per pattern, plus a couple of common variants like `https://us02web.zoom.us/j/123`) and ~10 negative cases (`meet.google.com/about`, `zoom.us/pricing`, `slack.com/intl/en-gb/`, etc.).

### 2. Detector changes

In `meeting/detector.rs::spawn`, the per-tick logic becomes:

```
1. Fetch FocusContext (already has browser_url and window_title).
2. lookup(bundle_id) — if not a supported app, clear counters, continue.
3. If is_browser:
     - If browser_url is None or url_allowlist::classify(url) is None,
       clear counters, continue.
     - Override the display name with the matched provider name.
4. If !is_browser:
     - Run is_meeting_window_title(bundle_id, title).
       For Zoom/Teams: require positive meeting marker.
       For Slack/Discord/FaceTime: keep "non-idle title" semantics (these
       apps are rarely launched without an active call, and their titles
       don't reliably name the call).
     - If false, clear counters, continue.
5. Mic gate (existing). For native apps, raise threshold from 5s to 12s
   to filter out audio-engine warm-up. Browsers stay at 5s — the URL
   gate is already strong enough.
6. Per-app pref lookup (Ask/Always/Never). Existing behavior, except the
   Always path now also goes through the OS notification on every
   activation? No — Always remains silent (intentional; that's the
   contract). However, the in-app meeting overlay continues to show.
```

`is_idle_window_title` is **replaced** by `is_meeting_window_title(bundle_id, title) -> bool`:

- `us.zoom.xos`: returns true if title contains `"Meeting"` (case-insensitive) or matches participant-count patterns. Excludes the literal strings `"Zoom Workplace"` and `"Zoom"`.
- `com.microsoft.teams2` / `com.microsoft.teams`: returns true if title contains `"| Microsoft Teams"` AND does not equal `"Microsoft Teams"` or `"Microsoft Teams (work or school)"`. Real meeting titles in Teams look like `"John Doe | Microsoft Teams"` or `"Daily Standup | Microsoft Teams"`.
- All other native apps: returns true if title is non-empty (preserves current behavior).

### 3. OS-level consent overlay window

> **Revised during implementation (2026-05-08).** The original plan called for `tauri-plugin-notification` v2 action buttons. On verification, the action APIs (`ActionType`, `Action`, `register_action_types`, `on_action`) are gated behind `#[cfg(mobile)]` in the installed crate (2.3.3) — desktop has no action-button support, and a plain `.title().body().show()` builder produces a non-actionable banner. The user picked **Option A** from the regression proposal: a floating consent overlay window.

Final approach: a small always-on-top Tauri WebView window registered as `consent_overlay`, mirroring the existing `recording_overlay`.

- 320×130 logical points, bottom-right of the primary monitor with a 24pt margin.
- Transparent + borderless + skip-taskbar + always-on-top + non-focusable + non-closable.
- Created hidden at app startup (`crate::overlay::create_consent_overlay`).
- Three buttons: `Record` (primary blue), `Always` (secondary), `Don't record` (muted).

**Trigger flow** (`detector.rs::Ask` arm):

```rust
let _ = app_handle.emit(
    "meeting-detected",
    serde_json::json!({ "bundle_id": frontmost, "app_name": display_name }),
);
crate::overlay::show_consent_overlay(&app_handle, &frontmost, display_name);
```

The `meeting-detected` event continues to be emitted so the existing in-app prompt at `App.tsx:384` still works as a redundant signal when the main window happens to be foreground.

**Decision flow** (consent overlay frontend, `src/consent-overlay/ConsentOverlay.tsx`):

1. `listen("show-consent")` → render with the payload.
2. User clicks → `invoke("meeting_consent", { bundleId, appName, decision })` (existing command, unchanged).
3. Then `invoke("hide_consent_overlay")` to dismiss the overlay window.
4. If 30 seconds pass with no click → frontend hides itself; no decision is recorded.

The overlay reuses the existing `meeting_consent` command exactly as the in-app prompt does, so there is no new dispatcher channel, no new action types, no native-API plumbing. Cross-platform consistent.

### 4. Stale pref cleanup

- **Startup log line** in `lib.rs::run` after settings load:
  ```
  let prefs = settings.meeting_app_prefs();
  if !prefs.is_empty() { tracing::info!(?prefs, "meeting app prefs"); }
  ```
- **New command** `meeting_clear_app_pref(bundle_id: String)`. (The originally-planned `meeting_list_app_prefs` was dropped — the existing settings query already exposes the prefs map to the frontend.)
- **Settings UI** — the existing per-app prefs row in `views/Settings.tsx` gains a `Clear` button next to the Always/Ask/Never dropdown that invokes the new command and removes the entry from local state.

### 5. Tests

- `url_allowlist::classify` — table-driven, ~30 cases.
- `is_meeting_window_title` — replace existing `is_idle_*` tests; add Zoom real-meeting titles, Teams real-meeting titles, and idle-state titles for both.
- `detector` unit-level — extract a pure `should_trigger(ctx, mic_active, since) -> Trigger` helper so the detection decision is testable without spinning up the loop. Cover: browser with non-meeting URL, browser with meeting URL but no mic, browser with meeting URL + mic + 5s, Zoom idle, Zoom in meeting + mic + 12s.
- No new tests for `meeting_consent` (already exercised); add one test that the consent dispatcher channel routes correctly given an action ID.

### 6. File-by-file change summary

| File | Change |
|---|---|
| `src-tauri/src/meeting/url_allowlist.rs` | **New** — classifier + tests |
| `src-tauri/src/meeting/mod.rs` | Add `pub mod url_allowlist;` |
| `src-tauri/src/meeting/detector.rs` | Replace `is_idle_window_title` with `is_meeting_window_title`; add browser URL gate; raise native mic threshold to 12s; extract `should_trigger` helper; switch notification builder to `action_type_id` + `extra` payload |
| `src-tauri/src/lib.rs` | Register `meeting_consent` action category; spawn consent-dispatcher task; pass dispatcher into detector |
| `src-tauri/src/commands.rs` | Add `meeting_list_app_prefs`, `meeting_clear_app_pref` commands |
| `src-tauri/src/settings.rs` | (no API change — existing `meeting_app_prefs` accessors are sufficient) |
| `src/views/sections/...Settings.tsx` | New Meetings settings row listing prefs with Clear buttons |
| `src/lib/api.ts` | Bind the two new commands |

## Risks

- **`tauri-plugin-notification` v2 action API surface** may differ from the sketch above; the implementation will verify and adapt at the call sites. Worst case: action buttons don't fire and we rely entirely on the in-app fallback — still a strict improvement over today, where the OS notification has no buttons at all.
- **AppleScript URL capture latency.** `capture_browser_url_macos` already has a 500 ms deadline; if a browser is unresponsive the URL gate returns `None` and detection is skipped (safe failure mode).
- **Existing user prefs.** Anyone with `MeetingAppPref::Always` for a browser bundle will continue to auto-record on URL match only. The startup log + Settings UI lets them clear the entry. We do not auto-clear existing prefs on upgrade.

## Acceptance criteria

- Launching Zoom (and only Zoom — no joining a call) does not start a recording within 30 seconds, with mic device technically running.
- Opening Arc/Safari/Chrome at `https://news.ycombinator.com` with mic active does not start a recording.
- Opening Arc/Safari/Chrome at `https://meet.google.com/abc-defg-hij` with mic active fires an OS notification within 8 seconds containing three actionable buttons. Clicking `Record` starts a meeting; clicking `Always` starts a meeting AND persists the pref; clicking `Don't record` persists `Never` and does not record.
- Settings → Meetings shows current per-app prefs and a working Clear button per row.
- All existing meeting-related Rust tests still pass.
