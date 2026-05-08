//! Detects when the user enters a meeting (supported app frontmost + mic in use)
//! and monitors for meeting end (mic goes silent).

use crate::meeting::MeetingManager;
use crate::settings::{MeetingAppPref, SettingsStore};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tracing::{info, warn};

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
        let mut consecutive_match: HashMap<String, u32> = HashMap::new();
        let mut mic_in_use_since: Option<Instant> = None;
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            if !settings.meeting_auto_detect() {
                continue;
            }
            // While a meeting is active OR we're inside the post-stop cooldown
            // (synthesis still running), keep counters cleared so we don't
            // immediately re-trigger the moment the gate opens.
            if manager.is_active().await || manager.in_cooldown() {
                consecutive_match.clear();
                mic_in_use_since = None;
                continue;
            }

            // Use capture_context() to get both bundle ID and window title.
            let ctx = match crate::input::focus::capture_context() {
                Some(c) => c,
                None => continue,
            };
            let frontmost = match ctx.bundle_id.as_deref() {
                Some(id) => id.to_string(),
                None => continue,
            };
            let Some((name, is_browser)) = lookup(&frontmost) else {
                consecutive_match.clear();
                continue;
            };

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

            // For native apps, require a positive meeting signal in the
            // window title. (Browsers are gated by URL in a later task.)
            if !is_browser {
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

            // All app types require mic active for 5+ seconds.
            // For native apps like Zoom, the mic only activates when the
            // user actually joins a meeting, so this prevents false triggers
            // on app launch.
            let mic_active = is_default_input_running();
            if !mic_active {
                mic_in_use_since = None;
                consecutive_match.clear();
                continue;
            }

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

            if !triggered {
                continue;
            }

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
                    if let Err(e) = manager
                        .clone()
                        .start(Some(frontmost.clone()), Some(display_name.into()))
                        .await
                    {
                        warn!(?e, "auto-start failed");
                    } else {
                        spawn_end_monitor(manager.clone(), Some(app_for_monitor));
                    }
                    consecutive_match.clear();
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
                    consecutive_match.clear();
                }
            }
        }
    });
}

/// Spawns a background task that monitors for meeting end signals.
/// Auto-stops the meeting when the mic has been silent for 30 consecutive
/// seconds (6 checks x 5s interval). This handles the case where the user
/// leaves a Zoom/Teams meeting but forgets to manually stop recording.
pub fn spawn_end_monitor(
    manager: Arc<MeetingManager>,
    detected_app: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_silent: u32 = 0;
        // 6 consecutive silent checks x 5 seconds = 30 seconds of silence.
        let silence_threshold: u32 = 6;
        let mut interval = tokio::time::interval(Duration::from_secs(5));

        loop {
            interval.tick().await;

            // If the meeting was already stopped (manually or by hard cap), exit.
            if !manager.is_active().await {
                info!("end-monitor: meeting no longer active, exiting");
                return;
            }

            let mic_active = is_default_input_running();

            if mic_active {
                consecutive_silent = 0;
                continue;
            }

            // Mic is silent. Check if the meeting app is still frontmost.
            let app_still_frontmost = detected_app.as_ref().map_or(false, |bundle| {
                frontmost_bundle_id()
                    .as_deref()
                    .map_or(false, |f| f == bundle)
            });

            if app_still_frontmost {
                // App is still frontmost but mic is silent — could be a
                // temporary mute or the meeting is transitioning. Be patient.
                consecutive_silent += 1;
            } else {
                // App is not frontmost AND mic is silent — strong signal
                // that the meeting has ended. Count faster (2x weight).
                consecutive_silent += 2;
            }

            if consecutive_silent >= silence_threshold {
                info!(
                    app = ?detected_app,
                    silent_checks = consecutive_silent,
                    "end-monitor: meeting appears to have ended, auto-stopping"
                );
                if let Err(e) = manager.stop().await {
                    warn!(?e, "end-monitor: auto-stop failed");
                }
                return;
            }
        }
    });
}

/// Returns the bundle ID of the frontmost regular app, or None.
fn frontmost_bundle_id() -> Option<String> {
    crate::input::focus::capture_context().and_then(|ctx| ctx.bundle_id)
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
}

/// CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device.
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
