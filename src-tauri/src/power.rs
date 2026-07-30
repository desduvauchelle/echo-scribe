//! Keep awake ("caffeine") — holds an OS power assertion for as long as the
//! user has the tray's **Keep awake** mode engaged, so the Mac doesn't
//! idle-sleep and the display doesn't blank mid-recording, mid-meeting or
//! mid-presentation.
//!
//! We take the assertion through IOKit rather than by spawning `caffeinate`
//! on purpose: an IOKit assertion is owned by *this process*, so macOS drops
//! it automatically if Echo Scribe crashes or is force-quit. A `caffeinate`
//! child would outlive a crashed parent and leave the machine awake forever.
//!
//! Timed sessions are session-scoped — a 2-hour hold does not survive a quit.
//! An *indefinite* hold does: it's persisted in settings and re-engaged at
//! launch (see `SettingsStore::keep_awake_mode`).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tracing::{info, warn};

/// The durations offered in the tray submenu, in menu order. `Off` is added
/// by the tray as a separate leading item.
pub const KEEP_AWAKE_OPTIONS: &[KeepAwakeMode] = &[
    KeepAwakeMode::Indefinite,
    KeepAwakeMode::Minutes(15),
    KeepAwakeMode::Minutes(30),
    KeepAwakeMode::Minutes(60),
    KeepAwakeMode::Minutes(120),
    KeepAwakeMode::Minutes(240),
    KeepAwakeMode::Minutes(480),
];

/// Shown to the OS in the assertion name — this is the string that appears in
/// `pmset -g assertions`, so make it recognisable.
const ASSERTION_REASON: &str = "Echo Scribe: Keep awake";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepAwakeMode {
    /// No assertion held — normal system sleep behaviour.
    Off,
    /// Held until the user turns it off (or quits).
    Indefinite,
    /// Held for a fixed number of minutes, then released automatically.
    Minutes(u32),
}

impl KeepAwakeMode {
    /// Stable identifier used both as the settings-store value and as the
    /// suffix of the tray menu item id (`keep_awake:<key>`).
    pub fn storage_key(&self) -> String {
        match self {
            KeepAwakeMode::Off => "off".to_string(),
            KeepAwakeMode::Indefinite => "indefinite".to_string(),
            KeepAwakeMode::Minutes(m) => m.to_string(),
        }
    }

    pub fn from_storage_key(key: &str) -> Option<Self> {
        match key {
            "off" => Some(KeepAwakeMode::Off),
            "indefinite" => Some(KeepAwakeMode::Indefinite),
            other => other
                .parse::<u32>()
                .ok()
                .filter(|m| *m > 0)
                .map(KeepAwakeMode::Minutes),
        }
    }

    /// Label for this option's own row in the tray submenu.
    pub fn menu_label(&self) -> String {
        match self {
            KeepAwakeMode::Off => "Off".to_string(),
            KeepAwakeMode::Indefinite => "Indefinitely".to_string(),
            KeepAwakeMode::Minutes(m) => format!("For {}", human_duration(*m)),
        }
    }

    pub fn is_off(&self) -> bool {
        matches!(self, KeepAwakeMode::Off)
    }
}

/// A point-in-time view of the keep-awake state, safe to hand to the tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeepAwakeStatus {
    pub mode: KeepAwakeMode,
    /// `Some` only for a live `Minutes(_)` hold.
    pub remaining_secs: Option<u64>,
}

impl KeepAwakeStatus {
    /// Label for the parent "Keep awake" row, so the state is legible without
    /// opening the submenu.
    pub fn menu_label(&self) -> String {
        match (self.mode, self.remaining_secs) {
            (KeepAwakeMode::Off, _) => "Keep awake".to_string(),
            (KeepAwakeMode::Indefinite, _) => "Keep awake: on".to_string(),
            (KeepAwakeMode::Minutes(_), Some(secs)) => {
                format!("Keep awake: {}", remaining_label(secs))
            }
            // A timed mode with no remaining time is a state we expire out of
            // before anyone observes it; fall back to the plain label.
            (KeepAwakeMode::Minutes(_), None) => "Keep awake".to_string(),
        }
    }
}

/// "15 minutes", "1 hour", "4 hours".
fn human_duration(minutes: u32) -> String {
    if minutes >= 60 && minutes.is_multiple_of(60) {
        let hours = minutes / 60;
        if hours == 1 {
            "1 hour".to_string()
        } else {
            format!("{hours} hours")
        }
    } else if minutes == 1 {
        "1 minute".to_string()
    } else {
        format!("{minutes} minutes")
    }
}

/// "1h 23m left", "42m left", "<1m left". Minutes round *up* so a fresh
/// 15-minute hold reads "15m left" rather than "14m left".
fn remaining_label(secs: u64) -> String {
    let mins = secs.div_ceil(60);
    if mins >= 60 {
        let h = mins / 60;
        let m = mins % 60;
        if m == 0 {
            format!("{h}h left")
        } else {
            format!("{h}h {m}m left")
        }
    } else if mins >= 1 {
        format!("{mins}m left")
    } else {
        "<1m left".to_string()
    }
}

/// Whether this platform can hold a keep-awake assertion at all. The tray
/// omits the whole submenu when false rather than offering a no-op.
pub fn is_supported() -> bool {
    cfg!(target_os = "macos")
}

struct Inner {
    /// Dropping this releases the OS assertion.
    assertion: Option<sys::Assertion>,
    mode: KeepAwakeMode,
    expires_at: Option<Instant>,
}

/// Owns the process-wide keep-awake assertion. One instance lives in
/// `AppState` for the lifetime of the app.
pub struct KeepAwake {
    inner: Mutex<Inner>,
}

impl KeepAwake {
    pub fn new() -> Self {
        KeepAwake {
            inner: Mutex::new(Inner {
                assertion: None,
                mode: KeepAwakeMode::Off,
                expires_at: None,
            }),
        }
    }

    /// Engage, re-arm or release the assertion. Returns the resulting status
    /// so the caller can update the menu without a second lock round-trip.
    ///
    /// Re-selecting a timed mode restarts its countdown — that's the useful
    /// reading of "keep awake for 30 minutes" clicked twice.
    pub fn set(&self, mode: KeepAwakeMode) -> Result<KeepAwakeStatus, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "keep-awake state is poisoned".to_string())?;

        match mode {
            KeepAwakeMode::Off => {
                // Drop before clearing the mode so the release is logged
                // against the state it belonged to.
                if inner.assertion.take().is_some() {
                    info!(target: "power", "keep awake released");
                }
                inner.mode = KeepAwakeMode::Off;
                inner.expires_at = None;
            }
            KeepAwakeMode::Indefinite | KeepAwakeMode::Minutes(_) => {
                if inner.assertion.is_none() {
                    let assertion = sys::Assertion::acquire(ASSERTION_REASON)?;
                    inner.assertion = Some(assertion);
                    info!(target: "power", "keep awake assertion acquired");
                }
                inner.mode = mode;
                inner.expires_at = match mode {
                    KeepAwakeMode::Minutes(m) => {
                        Some(Instant::now() + Duration::from_secs(u64::from(m) * 60))
                    }
                    _ => None,
                };
            }
        }

        Ok(status_of(&inner))
    }

    /// Current status, releasing the assertion first if a timed hold has run
    /// out. Called on a timer by the tray ticker, which is what actually ends
    /// a timed session — there is no separate expiry task to get out of sync.
    pub fn status(&self) -> KeepAwakeStatus {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!(target: "power", "keep-awake state poisoned: {e}");
                return KeepAwakeStatus {
                    mode: KeepAwakeMode::Off,
                    remaining_secs: None,
                };
            }
        };
        if let Some(expiry) = inner.expires_at {
            if Instant::now() >= expiry {
                inner.assertion = None;
                inner.mode = KeepAwakeMode::Off;
                inner.expires_at = None;
                info!(target: "power", "keep awake expired, assertion released");
            }
        }
        status_of(&inner)
    }
}

impl Default for KeepAwake {
    fn default() -> Self {
        Self::new()
    }
}

fn status_of(inner: &Inner) -> KeepAwakeStatus {
    KeepAwakeStatus {
        mode: inner.mode,
        remaining_secs: inner
            .expires_at
            .map(|at| at.saturating_duration_since(Instant::now()).as_secs()),
    }
}

#[cfg(target_os = "macos")]
mod sys {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use tracing::warn;

    type IOPMAssertionID = u32;
    type IOReturn = std::os::raw::c_int;

    const KIO_RETURN_SUCCESS: IOReturn = 0;
    const KIOPM_ASSERTION_LEVEL_ON: u32 = 255;

    /// Keeps the display lit. Implies the system stays awake while the display
    /// is on, which covers the presentation / "watch the export finish" case.
    const PREVENT_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
    /// Keeps the machine itself awake even when the display is off (clamshell,
    /// external monitor asleep) — the "long render overnight" case.
    const PREVENT_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    /// RAII handle over the pair of assertions. Dropping it releases both.
    pub struct Assertion {
        ids: Vec<IOPMAssertionID>,
    }

    impl Assertion {
        pub fn acquire(reason: &str) -> Result<Self, String> {
            let name = CFString::new(reason);
            let mut ids: Vec<IOPMAssertionID> = Vec::with_capacity(2);
            for kind in [PREVENT_DISPLAY_SLEEP, PREVENT_SYSTEM_SLEEP] {
                let assertion_type = CFString::new(kind);
                let mut id: IOPMAssertionID = 0;
                let rc = unsafe {
                    IOPMAssertionCreateWithName(
                        assertion_type.as_concrete_TypeRef(),
                        KIOPM_ASSERTION_LEVEL_ON,
                        name.as_concrete_TypeRef(),
                        &mut id,
                    )
                };
                if rc != KIO_RETURN_SUCCESS {
                    // Never leave a half-acquired pair behind.
                    for taken in ids {
                        unsafe { IOPMAssertionRelease(taken) };
                    }
                    return Err(format!(
                        "IOPMAssertionCreateWithName({kind}) failed with IOReturn 0x{rc:08x}"
                    ));
                }
                ids.push(id);
            }
            Ok(Assertion { ids })
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            for id in self.ids.drain(..) {
                let rc = unsafe { IOPMAssertionRelease(id) };
                if rc != KIO_RETURN_SUCCESS {
                    warn!(
                        target: "power",
                        id,
                        rc = format!("0x{rc:08x}"),
                        "IOPMAssertionRelease failed"
                    );
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    /// Non-macOS has no implementation yet (Windows would use
    /// `SetThreadExecutionState` pinned to a dedicated thread). `is_supported`
    /// returns false there, so the tray never offers the menu and this is only
    /// reachable if something calls `KeepAwake::set` directly.
    pub struct Assertion;

    impl Assertion {
        pub fn acquire(_reason: &str) -> Result<Self, String> {
            Err("Keep awake is only available on macOS".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_keys_round_trip() {
        for mode in [
            KeepAwakeMode::Off,
            KeepAwakeMode::Indefinite,
            KeepAwakeMode::Minutes(15),
            KeepAwakeMode::Minutes(480),
        ] {
            let key = mode.storage_key();
            assert_eq!(KeepAwakeMode::from_storage_key(&key), Some(mode), "{key}");
        }
    }

    #[test]
    fn every_menu_option_round_trips() {
        for mode in KEEP_AWAKE_OPTIONS {
            assert_eq!(
                KeepAwakeMode::from_storage_key(&mode.storage_key()),
                Some(*mode)
            );
        }
    }

    #[test]
    fn unknown_storage_keys_are_rejected() {
        assert_eq!(KeepAwakeMode::from_storage_key("nonsense"), None);
        assert_eq!(KeepAwakeMode::from_storage_key(""), None);
        // A zero-minute hold would engage then immediately expire; reject it
        // so a corrupted store can't produce a flickering assertion.
        assert_eq!(KeepAwakeMode::from_storage_key("0"), None);
        assert_eq!(KeepAwakeMode::from_storage_key("-5"), None);
    }

    #[test]
    fn durations_read_naturally() {
        assert_eq!(human_duration(15), "15 minutes");
        assert_eq!(human_duration(60), "1 hour");
        assert_eq!(human_duration(120), "2 hours");
        assert_eq!(human_duration(90), "90 minutes");
    }

    #[test]
    fn remaining_rounds_up_so_a_fresh_hold_shows_its_full_duration() {
        assert_eq!(remaining_label(15 * 60), "15m left");
        assert_eq!(remaining_label(15 * 60 - 1), "15m left");
        assert_eq!(remaining_label(14 * 60), "14m left");
        assert_eq!(remaining_label(3600), "1h left");
        assert_eq!(remaining_label(3600 + 23 * 60), "1h 23m left");
        assert_eq!(remaining_label(30), "1m left");
        assert_eq!(remaining_label(0), "<1m left");
    }

    #[test]
    fn parent_label_reflects_state() {
        let off = KeepAwakeStatus {
            mode: KeepAwakeMode::Off,
            remaining_secs: None,
        };
        assert_eq!(off.menu_label(), "Keep awake");

        let forever = KeepAwakeStatus {
            mode: KeepAwakeMode::Indefinite,
            remaining_secs: None,
        };
        assert_eq!(forever.menu_label(), "Keep awake: on");

        let timed = KeepAwakeStatus {
            mode: KeepAwakeMode::Minutes(30),
            remaining_secs: Some(25 * 60),
        };
        assert_eq!(timed.menu_label(), "Keep awake: 25m left");
    }

    #[test]
    fn off_releases_and_reports_off() {
        let ka = KeepAwake::new();
        let status = ka.set(KeepAwakeMode::Off).expect("off always succeeds");
        assert_eq!(status.mode, KeepAwakeMode::Off);
        assert_eq!(status.remaining_secs, None);
        assert_eq!(ka.status().mode, KeepAwakeMode::Off);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn timed_hold_reports_remaining_then_releases_on_expiry() {
        let ka = KeepAwake::new();
        let status = ka
            .set(KeepAwakeMode::Minutes(30))
            .expect("assertion should be grantable on macOS");
        assert_eq!(status.mode, KeepAwakeMode::Minutes(30));
        let remaining = status.remaining_secs.expect("timed hold has a countdown");
        assert!(remaining > 29 * 60 && remaining <= 30 * 60, "{remaining}");

        // Force the deadline into the past and confirm `status` expires it.
        {
            let mut inner = ka.inner.lock().unwrap();
            inner.expires_at = Some(Instant::now() - Duration::from_secs(1));
        }
        let expired = ka.status();
        assert_eq!(expired.mode, KeepAwakeMode::Off);
        assert_eq!(expired.remaining_secs, None);
        assert!(ka.inner.lock().unwrap().assertion.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reselecting_a_timed_mode_restarts_the_countdown() {
        let ka = KeepAwake::new();
        ka.set(KeepAwakeMode::Minutes(15)).unwrap();
        {
            let mut inner = ka.inner.lock().unwrap();
            inner.expires_at = Some(Instant::now() + Duration::from_secs(60));
        }
        let restarted = ka.set(KeepAwakeMode::Minutes(15)).unwrap();
        assert!(
            restarted.remaining_secs.unwrap() > 14 * 60,
            "re-clicking the same duration should re-arm the full window"
        );
        ka.set(KeepAwakeMode::Off).unwrap();
    }
}
