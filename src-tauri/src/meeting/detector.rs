//! Detects when the user enters a meeting (supported app frontmost + mic in use).

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
            if manager.is_active().await {
                continue;
            }

            let frontmost = match frontmost_bundle_id() {
                Some(id) => id,
                None => continue,
            };
            let Some((name, is_browser)) = lookup(&frontmost) else {
                consecutive_match.clear();
                continue;
            };

            let mic_active = is_default_input_running();
            let triggered = if is_browser {
                if mic_active {
                    let since = mic_in_use_since.get_or_insert(Instant::now());
                    since.elapsed() >= Duration::from_secs(5)
                } else {
                    mic_in_use_since = None;
                    false
                }
            } else {
                let count = consecutive_match.entry(frontmost.clone()).or_insert(0);
                *count += 1;
                *count >= 2
            };

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
                    if let Err(e) = manager
                        .clone()
                        .start(Some(frontmost.clone()), Some(name.into()))
                        .await
                    {
                        warn!(?e, "auto-start failed");
                    }
                    consecutive_match.clear();
                }
                MeetingAppPref::Never => { /* no-op */ }
                MeetingAppPref::Ask => {
                    info!(app = %frontmost, "asking user about new meeting app");
                    let _ = app_handle.emit(
                        "meeting-detected",
                        serde_json::json!({ "bundle_id": frontmost, "app_name": name }),
                    );
                    consecutive_match.clear();
                }
            }
        }
    });
}

/// Returns the bundle ID of the frontmost regular app, or None.
fn frontmost_bundle_id() -> Option<String> {
    crate::input::focus::capture_context().and_then(|ctx| ctx.bundle_id)
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
