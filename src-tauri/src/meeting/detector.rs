//! Detects when the user enters a meeting (supported app frontmost OR
//! backgrounded with an active meeting window title + mic in use) and
//! monitors for meeting end (mic goes silent).

use crate::meeting::MeetingManager;
use crate::settings::{MeetingAppPref, SettingsStore};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tracing::{info, warn};

/// Best-effort native desktop notification. Used to surface meeting events
/// (auto-start, ask, failure) when no Echo Scribe window is visible — the
/// daily log still has the full detail.
fn notify_desktop(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

/// A meeting candidate produced by the per-tick detection step. Combines the
/// signals we collect from either the frontmost-app path or the
/// background-window-scan fallback into a single shape the gating logic can
/// consume uniformly.
#[derive(Debug, Clone)]
struct MeetingCandidate {
    bundle_id: String,
    display_name: String,
    is_browser: bool,
    window_title: Option<String>,
    browser_url: Option<String>,
    browser_tab_title: Option<String>,
    /// "frontmost" when the user is looking at the meeting app, "background"
    /// when we found it via CGWindowList enumeration. Drives logging only.
    source: &'static str,
}

/// Static registry of supported meeting apps.
pub const REGISTRY: &[(&str, &str, bool)] = &[
    // (bundle_id, display_name, is_browser)
    ("us.zoom.xos", "Zoom", false),
    ("com.microsoft.teams2", "Microsoft Teams", false),
    ("com.microsoft.teams", "Microsoft Teams (classic)", false),
    ("com.apple.FaceTime", "FaceTime", false),
    ("com.hnc.Discord", "Discord", false),
    ("com.tinyspeck.slackmacgap", "Slack", false),
    ("com.google.Chrome", "Chrome", true),
    ("company.thebrowser.Browser", "Arc", true),
    ("org.mozilla.firefox", "Firefox", true),
    ("com.apple.Safari", "Safari", true),
];

pub fn lookup(bundle_id: &str) -> Option<(&'static str, bool)> {
    REGISTRY
        .iter()
        .find(|(b, _, _)| *b == bundle_id)
        .map(|(_, name, is_browser)| (*name, *is_browser))
}

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
            let lower = trimmed.to_lowercase();
            if lower == "microsoft teams" || lower == "microsoft teams (work or school)" {
                return false;
            }
            lower.contains("| microsoft teams")
        }
        _ => true,
    }
}

/// Returns the meeting-provider display name for a browser URL, or None.
/// Thin wrapper around `url_allowlist::classify` to make the detector loop
/// readable and unit-testable.
fn browser_provider_name(url: Option<&str>) -> Option<&'static str> {
    crate::meeting::url_allowlist::classify(url?)
}

/// Spawns the detection loop. Returns immediately; the loop runs until process exit.
pub fn spawn(
    manager: Arc<MeetingManager>,
    settings: SettingsStore,
    app_handle: tauri::AppHandle,
) {
    tauri::async_runtime::spawn(async move {
        let mut mic_in_use_since: Option<Instant> = None;
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        // Transition-only diagnostic state. Logging every tick would spam
        // the daily log file; logging only on state changes makes the
        // detector's decisions visible without flooding.
        let mut prev_app_in_registry: Option<String> = None;
        let mut prev_title_ok: bool = false;
        let mut prev_mic_active: bool = false;
        let mut prev_browser_provider: Option<&'static str> = None;
        let mut prev_gate_blocked: Option<&'static str> = None; // "active" | "cooldown" | None
        loop {
            interval.tick().await;
            if !settings.meeting_auto_detect() {
                continue;
            }
            // While a meeting is active OR we're inside the post-stop cooldown
            // (synthesis still running), reset the mic timer so we don't
            // immediately re-trigger the moment the gate opens.
            let active = manager.is_active().await;
            let cooldown = manager.in_cooldown();
            if active || cooldown {
                let reason = if active { "active" } else { "cooldown" };
                if prev_gate_blocked != Some(reason) {
                    info!(target: "meeting_detect", reason, "detector idle: manager gate");
                    prev_gate_blocked = Some(reason);
                }
                mic_in_use_since = None;
                continue;
            }
            if prev_gate_blocked.is_some() {
                info!(target: "meeting_detect", "detector gate cleared, resuming checks");
                prev_gate_blocked = None;
            }

            // Use capture_context() to get the frontmost app, window title,
            // and (if it's a browser) the active tab URL.
            let ctx = match crate::input::focus::capture_context() {
                Some(c) => c,
                None => continue,
            };
            let frontmost = ctx.bundle_id.as_deref().map(|s| s.to_string());

            // Build a candidate from the frontmost app first.
            let mut candidate: Option<MeetingCandidate> =
                frontmost.as_deref().and_then(|fm| {
                    let (name, is_browser) = lookup(fm)?;
                    Some(MeetingCandidate {
                        bundle_id: fm.to_string(),
                        display_name: name.to_string(),
                        is_browser,
                        window_title: ctx.window_title.clone(),
                        browser_url: ctx.browser_url.clone(),
                        browser_tab_title: ctx.browser_tab_title.clone(),
                        source: "frontmost",
                    })
                });

            // Fallback: scan all on-screen windows for a backgrounded native
            // meeting app whose title says it's in a call. This is the
            // primary path for users who dictate into another app during the
            // meeting — Zoom is in the background, frontmost is VS Code.
            // Browser meeting providers stay frontmost-only because their
            // URL is only reachable via the AX browser query and that
            // requires the browser to be frontmost.
            if candidate.is_none() {
                if let Some((bg_bundle, bg_name, bg_title)) = find_background_meeting_app() {
                    candidate = Some(MeetingCandidate {
                        bundle_id: bg_bundle,
                        display_name: bg_name.to_string(),
                        is_browser: false,
                        window_title: Some(bg_title),
                        browser_url: None,
                        browser_tab_title: None,
                        source: "background",
                    });
                }
            }

            let Some(cand) = candidate else {
                // No meeting candidate this tick. If we had one before, log
                // the transition out so the user can see when (e.g.) the
                // meeting window closed entirely.
                if let Some(prev) = prev_app_in_registry.take() {
                    info!(
                        target: "meeting_detect",
                        prev_app = %prev,
                        frontmost = ?frontmost,
                        "no meeting candidate this tick"
                    );
                    prev_title_ok = false;
                    prev_browser_provider = None;
                }
                continue;
            };

            if prev_app_in_registry.as_deref() != Some(cand.bundle_id.as_str()) {
                info!(
                    target: "meeting_detect",
                    app = %cand.bundle_id,
                    app_name = %cand.display_name,
                    is_browser = cand.is_browser,
                    source = cand.source,
                    window_title = ?cand.window_title,
                    browser_url = ?cand.browser_url,
                    "meeting candidate selected"
                );
                prev_app_in_registry = Some(cand.bundle_id.clone());
                prev_title_ok = false;
                prev_browser_provider = None;
            }

            // For browsers, require a known meeting URL. The provider name
            // (e.g. "Google Meet") replaces the browser display name in the
            // consent overlay and meeting title.
            let display_name: String = if cand.is_browser {
                match browser_provider_name(cand.browser_url.as_deref()) {
                    Some(provider) => {
                        if prev_browser_provider != Some(provider) {
                            info!(
                                target: "meeting_detect",
                                app = %cand.bundle_id,
                                provider,
                                url = ?cand.browser_url,
                                "browser URL matches a meeting provider"
                            );
                            prev_browser_provider = Some(provider);
                        }
                        provider.to_string()
                    }
                    None => {
                        if prev_browser_provider.is_some() {
                            info!(
                                target: "meeting_detect",
                                app = %cand.bundle_id,
                                url = ?cand.browser_url,
                                "browser URL no longer matches any meeting provider"
                            );
                            prev_browser_provider = None;
                        }
                        mic_in_use_since = None;
                        continue;
                    }
                }
            } else {
                cand.display_name.clone()
            };

            // For native apps, require a positive meeting signal in the
            // window title.
            if !cand.is_browser {
                let title_ok = cand
                    .window_title
                    .as_deref()
                    .map(|t| is_meeting_window_title(&cand.bundle_id, t))
                    .unwrap_or(false);
                if title_ok != prev_title_ok {
                    info!(
                        target: "meeting_detect",
                        app = %cand.bundle_id,
                        title_ok,
                        source = cand.source,
                        window_title = ?cand.window_title,
                        "window title gate state changed"
                    );
                    prev_title_ok = title_ok;
                }
                if !title_ok {
                    mic_in_use_since = None;
                    continue;
                }
            }

            // Mic must be running for the threshold below before we trigger.
            let mic_active = is_default_input_running();
            if mic_active != prev_mic_active {
                info!(
                    target: "meeting_detect",
                    app = %cand.bundle_id,
                    mic_active,
                    "default-input mic running flag changed"
                );
                prev_mic_active = mic_active;
            }
            if !mic_active {
                mic_in_use_since = None;
                continue;
            }

            // Mic-gate: browsers stay at 5s (URL allowlist is already a
            // strong filter); native apps need 12s to ride out audio-engine
            // warm-ups (Zoom in particular keeps the mic device "running"
            // briefly outside of calls).
            let mic_threshold = if cand.is_browser {
                Duration::from_secs(5)
            } else {
                Duration::from_secs(12)
            };
            let just_started_gate = mic_in_use_since.is_none();
            let since = mic_in_use_since.get_or_insert(Instant::now());
            if just_started_gate {
                info!(
                    target: "meeting_detect",
                    app = %cand.bundle_id,
                    threshold_ms = mic_threshold.as_millis() as u64,
                    "mic gate started"
                );
            }
            let triggered = since.elapsed() >= mic_threshold;

            if !triggered {
                continue;
            }
            info!(
                target: "meeting_detect",
                app = %cand.bundle_id,
                source = cand.source,
                elapsed_ms = since.elapsed().as_millis() as u64,
                "mic gate satisfied; evaluating per-app preference"
            );

            let frontmost = cand.bundle_id.clone();
            let ctx = crate::input::focus::FocusContext {
                pid: ctx.pid,
                bundle_id: Some(cand.bundle_id.clone()),
                app_name: Some(cand.display_name.clone()),
                window_title: cand.window_title.clone(),
                browser_url: cand.browser_url.clone(),
                browser_tab_title: cand.browser_tab_title.clone(),
                content_title: cand.browser_tab_title.clone(),
                content_url: cand.browser_url.clone(),
                content_source: cand.browser_tab_title.as_ref().map(|_| "browser_tab".into()),
            };
            let display_name = display_name.as_str();

            // Per-app preference.
            let prefs = settings.meeting_app_prefs();
            match prefs
                .get(&frontmost)
                .copied()
                .unwrap_or(MeetingAppPref::Ask)
            {
                MeetingAppPref::Always => {
                    info!(app = %frontmost, "auto-starting meeting (Always)");
                    let app_for_monitor = frontmost.clone();
                    let start_ctx = crate::meeting::MeetingStartContext {
                        window_title: ctx.window_title.clone(),
                        browser_url: ctx.browser_url.clone(),
                        browser_tab_title: ctx.browser_tab_title.clone(),
                        calendar_match: None,
                        guide_template: None,
                    };
                    if let Err(e) = manager
                        .clone()
                        .start(Some(frontmost.clone()), Some(display_name.into()), start_ctx)
                        .await
                    {
                        warn!(?e, "auto-start failed");
                        notify_desktop(
                            &app_handle,
                            "Couldn't start meeting recording",
                            &format!(
                                "Auto-start for {} failed. See Settings → Diagnostics.",
                                display_name
                            ),
                        );
                    } else {
                        notify_desktop(
                            &app_handle,
                            "Recording meeting",
                            &format!("Echo Scribe is recording your {} meeting.", display_name),
                        );
                        spawn_end_monitor(manager.clone(), Some(app_for_monitor));
                    }
                }
                MeetingAppPref::Never => { /* no-op */ }
                MeetingAppPref::Ask => {
                    info!(app = %frontmost, %display_name, "asking user about new meeting app");
                    // Emit the in-app event for any view that wants to react
                    // (e.g., the existing in-app prompt when the main window
                    // is foreground).
                    let _ = app_handle.emit(
                        "meeting-detected",
                        serde_json::json!({ "bundle_id": frontmost, "app_name": display_name }),
                    );
                    // Show the always-on-top consent overlay window. Visible
                    // regardless of which app is frontmost. The overlay
                    // frontend dispatches `meeting_consent` on click and
                    // hides itself after 30s if no choice is made.
                    crate::overlay::show_consent_overlay(&app_handle, &frontmost, display_name);
                    notify_desktop(
                        &app_handle,
                        &format!("{} meeting detected", display_name),
                        "Open Echo Scribe to record this meeting.",
                    );
                }
            }
        }
    });
}

/// Snapshot of the signals consulted by [`EndMonitorTicker`] on each tick.
///
/// Decoupled from the live system so the ticker can be unit-tested with
/// synthetic scenarios.
#[derive(Debug, Clone)]
pub struct EndMonitorSignals {
    /// Whether [`MeetingManager`] still considers a meeting active. When false
    /// the ticker returns [`EndMonitorDecision::Exit`] regardless of presence.
    pub manager_active: bool,
    /// Bundle id of the meeting app that triggered the recording, e.g.
    /// `"us.zoom.xos"` or `"com.google.Chrome"`. `None` for manual starts —
    /// without it we have no source to track and the ticker stays idle.
    pub detected_app: Option<String>,
    /// Bundle id of the currently frontmost app, or `None`.
    pub frontmost_bundle: Option<String>,
    /// Window title of the frontmost window. Used for native-app meeting
    /// presence (e.g. Zoom/Teams).
    pub frontmost_window_title: Option<String>,
    /// Browser URL when the frontmost app is a known browser. Used for
    /// browser-app meeting presence (Google Meet, Zoom Web, etc.).
    pub frontmost_browser_url: Option<String>,
}

/// Result of a single [`EndMonitorTicker::tick`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndMonitorDecision {
    /// Keep monitoring; the meeting source still appears to be present, or
    /// the signals are inconclusive.
    Continue,
    /// The meeting source has been gone for `threshold` ticks. Caller should
    /// invoke `MeetingManager::stop()`.
    Stop,
    /// `MeetingManager` is no longer active (manually stopped or hard-capped).
    /// Caller should exit the monitoring task.
    Exit,
}

/// Categorical evaluation of whether the meeting source is still observable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presence {
    /// We can see the meeting source and it's still there. Resets the counter.
    Present,
    /// We can see what would be the meeting source and it's gone. Counter +1.
    Gone,
    /// We can't tell from current signals (e.g., user is in a different app).
    /// Counter is left unchanged so we don't false-stop when the user opens
    /// Slack to check messages mid-meeting.
    Unknown,
}

/// Per-tick decision-maker for the meeting end monitor. Pure: no system calls.
/// Caller is responsible for gathering [`EndMonitorSignals`] and acting on the
/// returned [`EndMonitorDecision`].
#[derive(Debug, Clone)]
pub struct EndMonitorTicker {
    consecutive_gone: u32,
    threshold: u32,
}

impl EndMonitorTicker {
    /// Threshold of 6: at the production tick interval of 5s, that's 30s of
    /// continuous "meeting source gone" signal before auto-stop fires.
    pub fn new() -> Self {
        Self::with_threshold(6)
    }

    pub fn with_threshold(threshold: u32) -> Self {
        Self {
            consecutive_gone: 0,
            threshold,
        }
    }

    /// Apply one tick of the end-monitor state machine.
    ///
    /// Note: when frontmost is **not** the detected meeting app we treat the
    /// situation as inconclusive (counter unchanged) rather than confidently
    /// "gone." This avoids false-stops when the user briefly tabs to Slack or
    /// the browser during a native-app meeting. The trade-off: if the user
    /// fully quits the meeting app and never returns, auto-stop won't fire.
    /// They can manually stop or the hard-cap will kick in.
    pub fn tick(&mut self, signals: &EndMonitorSignals) -> EndMonitorDecision {
        if !signals.manager_active {
            return EndMonitorDecision::Exit;
        }
        match evaluate_meeting_presence(signals) {
            Presence::Present => {
                self.consecutive_gone = 0;
                EndMonitorDecision::Continue
            }
            Presence::Gone => {
                self.consecutive_gone = self.consecutive_gone.saturating_add(1);
                if self.consecutive_gone >= self.threshold {
                    EndMonitorDecision::Stop
                } else {
                    EndMonitorDecision::Continue
                }
            }
            Presence::Unknown => EndMonitorDecision::Continue,
        }
    }

    #[cfg(test)]
    fn consecutive_gone(&self) -> u32 {
        self.consecutive_gone
    }
}

impl Default for EndMonitorTicker {
    fn default() -> Self {
        Self::new()
    }
}

/// Decide whether the meeting source (window title / URL) is still observable
/// from the supplied signals.
fn evaluate_meeting_presence(signals: &EndMonitorSignals) -> Presence {
    let Some(detected_app) = signals.detected_app.as_deref() else {
        // Manual start with no detected app — we have no source to track.
        return Presence::Unknown;
    };
    // We can only inspect the meeting app's window title or URL when it's the
    // frontmost app (no cross-app window enumeration). When it isn't, signals
    // are inconclusive.
    if signals.frontmost_bundle.as_deref() != Some(detected_app) {
        return Presence::Unknown;
    }
    let Some((_, is_browser)) = lookup(detected_app) else {
        // Detected app dropped out of the registry (e.g., between releases).
        // Without a way to interpret signals, stay safe.
        return Presence::Unknown;
    };
    if is_browser {
        match browser_provider_name(signals.frontmost_browser_url.as_deref()) {
            Some(_) => Presence::Present,
            None => Presence::Gone,
        }
    } else {
        let title_indicates_meeting = signals
            .frontmost_window_title
            .as_deref()
            .map(|t| is_meeting_window_title(detected_app, t))
            .unwrap_or(false);
        if title_indicates_meeting {
            Presence::Present
        } else {
            Presence::Gone
        }
    }
}

/// Spawns a background task that monitors for meeting end signals.
///
/// Auto-stops the meeting when the meeting source (window title / URL) has
/// been gone for [`EndMonitorTicker::threshold`] consecutive ticks. This
/// handles the common case where the user clicks End in Zoom or Leave in
/// Google Meet but doesn't manually stop the recording.
///
/// History note: an earlier implementation gated on
/// `kAudioDevicePropertyDeviceIsRunningSomewhere` (the system-wide "mic in
/// use" flag). That signal was permanently true once we started recording the
/// meeting ourselves — Echo Scribe's own cpal input stream contaminated the
/// observation. The auto-stop never fired and meetings recorded forever. The
/// current logic uses meeting-source presence (window title / URL) instead.
pub fn spawn_end_monitor(
    manager: Arc<MeetingManager>,
    detected_app: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = EndMonitorTicker::new();
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let signals = gather_end_monitor_signals(&manager, &detected_app).await;
            match ticker.tick(&signals) {
                EndMonitorDecision::Continue => {}
                EndMonitorDecision::Exit => {
                    info!("end-monitor: meeting no longer active, exiting");
                    return;
                }
                EndMonitorDecision::Stop => {
                    info!(
                        app = ?detected_app,
                        "end-monitor: meeting source gone, auto-stopping"
                    );
                    if let Err(e) = manager.stop().await {
                        warn!(?e, "end-monitor: auto-stop failed");
                    }
                    return;
                }
            }
        }
    });
}

/// Snapshot the live signals the end-monitor tick consumes.
async fn gather_end_monitor_signals(
    manager: &Arc<MeetingManager>,
    detected_app: &Option<String>,
) -> EndMonitorSignals {
    let manager_active = manager.is_active().await;
    let ctx = crate::input::focus::capture_context();
    EndMonitorSignals {
        manager_active,
        detected_app: detected_app.clone(),
        frontmost_bundle: ctx.as_ref().and_then(|c| c.bundle_id.clone()),
        frontmost_window_title: ctx.as_ref().and_then(|c| c.window_title.clone()),
        frontmost_browser_url: ctx.as_ref().and_then(|c| c.browser_url.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn is_meeting_title_zoom_in_meeting() {
        assert!(is_meeting_window_title("us.zoom.xos", "Zoom Meeting"));
        assert!(is_meeting_window_title("us.zoom.xos", "Personal Meeting Room"));
        assert!(is_meeting_window_title("us.zoom.xos", "Weekly Standup - Zoom Meeting"));
    }

    #[test]
    fn is_meeting_title_zoom_idle() {
        assert!(!is_meeting_window_title("us.zoom.xos", "Zoom"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Zoom Workplace"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Home"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Contacts"));
        assert!(!is_meeting_window_title("us.zoom.xos", "Settings"));
        assert!(!is_meeting_window_title("us.zoom.xos", ""));
    }

    #[test]
    fn is_meeting_title_teams_in_meeting() {
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
        assert!(is_meeting_window_title("com.hnc.Discord", "General"));
        assert!(is_meeting_window_title("com.tinyspeck.slackmacgap", "Acme Workspace"));
        assert!(is_meeting_window_title("com.apple.FaceTime", "FaceTime"));
        assert!(!is_meeting_window_title("com.hnc.Discord", ""));
    }

    #[test]
    fn browser_provider_name_uses_url_classifier() {
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

    // ---- End-monitor ticker tests ----

    fn signals_with_detected(detected_app: &str) -> EndMonitorSignals {
        EndMonitorSignals {
            manager_active: true,
            detected_app: Some(detected_app.to_string()),
            frontmost_bundle: None,
            frontmost_window_title: None,
            frontmost_browser_url: None,
        }
    }

    /// Regression test for the bug where the end-monitor relied on
    /// `kAudioDevicePropertyDeviceIsRunningSomewhere`. Echo Scribe's own
    /// recorder kept the property `true` for the entire meeting, so the old
    /// silence counter never advanced and auto-stop never fired.
    ///
    /// This test feeds the *exact* situation that used to break the old
    /// monitor: the user has clicked End in Zoom (meeting window now shows
    /// "Home"), but the system mic is still in use because Echo Scribe is
    /// recording. The new ticker ignores mic state entirely and uses
    /// meeting-source presence (window title), so it must reach `Stop`.
    #[test]
    fn regression_end_monitor_stops_even_while_recorder_holds_mic() {
        let mut t = EndMonitorTicker::with_threshold(6);
        // Zoom is frontmost but the meeting window is gone (user clicked End,
        // Zoom now shows its Home view). Note: no mic-state field exists on
        // EndMonitorSignals — by construction the new ticker can't be tricked
        // by Echo Scribe's own recorder holding the input device open.
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("us.zoom.xos".into()),
            frontmost_bundle: Some("us.zoom.xos".into()),
            frontmost_window_title: Some("Home".into()),
            frontmost_browser_url: None,
        };
        let mut decisions = Vec::new();
        for _ in 0..10 {
            let d = t.tick(&signals);
            decisions.push(d);
            if matches!(d, EndMonitorDecision::Stop) {
                break;
            }
        }
        assert!(
            decisions.iter().any(|d| matches!(d, EndMonitorDecision::Stop)),
            "ticker never stopped after Zoom meeting window closed; decisions: {decisions:?}"
        );
    }

    #[test]
    fn end_monitor_stops_when_zoom_meeting_window_closes() {
        let mut t = EndMonitorTicker::with_threshold(6);
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("us.zoom.xos".into()),
            frontmost_bundle: Some("us.zoom.xos".into()),
            frontmost_window_title: Some("Home".into()),
            frontmost_browser_url: None,
        };
        // 6 ticks at +1 each = exactly threshold.
        for _ in 0..5 {
            assert_eq!(t.tick(&signals), EndMonitorDecision::Continue);
        }
        assert_eq!(t.tick(&signals), EndMonitorDecision::Stop);
    }

    #[test]
    fn end_monitor_stops_when_google_meet_url_changes() {
        let mut t = EndMonitorTicker::with_threshold(6);
        // The user clicked Leave call; the URL shifted off the meeting code
        // pattern. Browser is still frontmost and on meet.google.com, but the
        // path no longer matches `is_meet_code` so url_allowlist returns None.
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("com.google.Chrome".into()),
            frontmost_bundle: Some("com.google.Chrome".into()),
            frontmost_window_title: Some("Google Meet".into()),
            frontmost_browser_url: Some("https://meet.google.com/landing".into()),
        };
        for _ in 0..5 {
            assert_eq!(t.tick(&signals), EndMonitorDecision::Continue);
        }
        assert_eq!(t.tick(&signals), EndMonitorDecision::Stop);
    }

    #[test]
    fn end_monitor_continues_during_normal_zoom_meeting() {
        let mut t = EndMonitorTicker::with_threshold(6);
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("us.zoom.xos".into()),
            frontmost_bundle: Some("us.zoom.xos".into()),
            frontmost_window_title: Some("Weekly Standup - Zoom Meeting".into()),
            frontmost_browser_url: None,
        };
        for _ in 0..50 {
            assert_eq!(t.tick(&signals), EndMonitorDecision::Continue);
        }
        assert_eq!(t.consecutive_gone(), 0);
    }

    #[test]
    fn end_monitor_continues_during_normal_google_meet_meeting() {
        let mut t = EndMonitorTicker::with_threshold(6);
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("com.google.Chrome".into()),
            frontmost_bundle: Some("com.google.Chrome".into()),
            frontmost_window_title: Some("Meet — Standup".into()),
            frontmost_browser_url: Some("https://meet.google.com/abc-defg-hij".into()),
        };
        for _ in 0..50 {
            assert_eq!(t.tick(&signals), EndMonitorDecision::Continue);
        }
    }

    #[test]
    fn end_monitor_does_not_stop_when_user_tabs_to_slack_during_meeting() {
        // The user's in a Zoom call but is checking Slack. We can't see Zoom's
        // window state from here (no cross-app enumeration). Must NOT stop —
        // false-stops during meetings would be much worse than late-stops.
        let mut t = EndMonitorTicker::with_threshold(6);
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("us.zoom.xos".into()),
            frontmost_bundle: Some("com.tinyspeck.slackmacgap".into()),
            frontmost_window_title: Some("Acme Workspace".into()),
            frontmost_browser_url: None,
        };
        for tick in 0..50 {
            assert_eq!(
                t.tick(&signals),
                EndMonitorDecision::Continue,
                "tick {tick} should be Continue (user tabbed away mid-meeting)"
            );
        }
        assert_eq!(t.consecutive_gone(), 0);
    }

    #[test]
    fn end_monitor_exits_when_manager_no_longer_active() {
        let mut t = EndMonitorTicker::with_threshold(6);
        let mut signals = signals_with_detected("us.zoom.xos");
        signals.manager_active = false;
        assert_eq!(t.tick(&signals), EndMonitorDecision::Exit);
    }

    #[test]
    fn end_monitor_resets_counter_when_user_returns_to_meeting() {
        // Scenario: Zoom is frontmost on the Home view (user might be looking
        // for the meeting), counter starts climbing. Then they navigate back
        // into the meeting window — counter should reset.
        let mut t = EndMonitorTicker::with_threshold(6);
        let home_signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("us.zoom.xos".into()),
            frontmost_bundle: Some("us.zoom.xos".into()),
            frontmost_window_title: Some("Home".into()),
            frontmost_browser_url: None,
        };
        for _ in 0..3 {
            assert_eq!(t.tick(&home_signals), EndMonitorDecision::Continue);
        }
        assert_eq!(t.consecutive_gone(), 3);
        let meeting_signals = EndMonitorSignals {
            frontmost_window_title: Some("Zoom Meeting".into()),
            ..home_signals
        };
        assert_eq!(t.tick(&meeting_signals), EndMonitorDecision::Continue);
        assert_eq!(t.consecutive_gone(), 0);
    }

    #[test]
    fn end_monitor_unknown_when_detected_app_not_in_registry() {
        // Defensive: if a future release removes an app from the registry but
        // there's still a recording in flight, don't auto-stop just because
        // we can no longer interpret the signals.
        let mut t = EndMonitorTicker::with_threshold(6);
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: Some("com.removed.app".into()),
            frontmost_bundle: Some("com.removed.app".into()),
            frontmost_window_title: Some("Untitled".into()),
            frontmost_browser_url: None,
        };
        for _ in 0..50 {
            assert_eq!(t.tick(&signals), EndMonitorDecision::Continue);
        }
    }

    #[test]
    fn end_monitor_unknown_when_no_detected_app_manual_start() {
        // Manual start: no detected app means we have no source to track.
        // Stay quiet; the user can stop manually.
        let mut t = EndMonitorTicker::with_threshold(6);
        let signals = EndMonitorSignals {
            manager_active: true,
            detected_app: None,
            frontmost_bundle: Some("us.zoom.xos".into()),
            frontmost_window_title: Some("Home".into()),
            frontmost_browser_url: None,
        };
        for _ in 0..50 {
            assert_eq!(t.tick(&signals), EndMonitorDecision::Continue);
        }
    }
}

/// CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device.
#[cfg(target_os = "macos")]
fn is_default_input_running() -> bool {
    use coreaudio_sys::*;
    unsafe {
        let mut device_id: AudioDeviceID = 0;
        let mut size = std::mem::size_of::<AudioDeviceID>() as u32;
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            &mut device_id as *mut _ as *mut _,
        );
        if status != 0 {
            return false;
        }
        let running_addr = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut running: u32 = 0;
        let mut size2 = std::mem::size_of::<u32>() as u32;
        let s2 = AudioObjectGetPropertyData(
            device_id,
            &running_addr,
            0,
            std::ptr::null(),
            &mut size2,
            &mut running as *mut _ as *mut _,
        );
        s2 == 0 && running != 0
    }
}

#[cfg(not(target_os = "macos"))]
fn is_default_input_running() -> bool {
    false
}

/// Scan all on-screen windows for a backgrounded native meeting app whose
/// window title indicates an active meeting. Returns
/// `(bundle_id, display_name, window_title)` on the first hit.
///
/// Used as a fallback when the frontmost app isn't a registered meeting
/// app — the common case where the user is dictating to another app while
/// in a Zoom/Teams/FaceTime call. Browsers are excluded because the URL
/// gate needs an AX browser query that only works when the browser is
/// frontmost.
///
/// Requires Screen Recording permission for `kCGWindowName` to populate
/// (Echo Scribe already has it for the screen recorder sidecar). Without
/// the grant, this scan silently returns `None` and detection falls back
/// to the frontmost-only path — i.e. degrades gracefully.
#[cfg(target_os = "macos")]
fn find_background_meeting_app() -> Option<(String, &'static str, String)> {
    use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionaryGetValueIfPresent, CFDictionaryRef};
    use core_foundation::number::{CFNumber, CFNumberRef};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionAll, kCGWindowName, kCGWindowOwnerPID,
    };
    use objc2_app_kit::NSRunningApplication;
    use std::ffi::c_void;

    unsafe fn dict_get_i32(dict: CFDictionaryRef, key: CFStringRef) -> Option<i32> {
        let mut v: *const c_void = std::ptr::null();
        if CFDictionaryGetValueIfPresent(dict, key as *const c_void, &mut v) == 0 || v.is_null() {
            return None;
        }
        let n: CFNumber = TCFType::wrap_under_get_rule(v as CFNumberRef);
        n.to_i32()
    }

    unsafe fn dict_get_string(dict: CFDictionaryRef, key: CFStringRef) -> Option<String> {
        let mut v: *const c_void = std::ptr::null();
        if CFDictionaryGetValueIfPresent(dict, key as *const c_void, &mut v) == 0 || v.is_null() {
            return None;
        }
        let s: CFString = TCFType::wrap_under_get_rule(v as CFStringRef);
        Some(s.to_string())
    }

    let windows = copy_window_info(
        kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )?;
    let arr_ref = windows.as_concrete_TypeRef();
    let count = unsafe { CFArrayGetCount(arr_ref) };

    for i in 0..count {
        let dict_ref =
            unsafe { CFArrayGetValueAtIndex(arr_ref, i) } as CFDictionaryRef;
        if dict_ref.is_null() {
            continue;
        }
        // Skip menu / dock / overlay windows. Normal app windows live at
        // layer 0.
        let layer = unsafe { dict_get_i32(dict_ref, kCGWindowLayer) };
        if layer != Some(0) {
            continue;
        }
        let pid = match unsafe { dict_get_i32(dict_ref, kCGWindowOwnerPID) } {
            Some(p) if p > 0 => p,
            _ => continue,
        };
        let name = match unsafe { dict_get_string(dict_ref, kCGWindowName) } {
            Some(s) if !s.trim().is_empty() => s,
            _ => continue,
        };
        let bundle_id = match NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .and_then(|a| a.bundleIdentifier())
            .map(|s| s.to_string())
        {
            Some(b) => b,
            None => continue,
        };
        let Some((display_name, is_browser)) = lookup(&bundle_id) else {
            continue;
        };
        if is_browser {
            continue;
        }
        if !is_meeting_window_title(&bundle_id, &name) {
            continue;
        }
        return Some((bundle_id, display_name, name));
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn find_background_meeting_app() -> Option<(String, &'static str, String)> {
    None
}
