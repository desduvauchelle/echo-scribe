//! CI first-launch smoke-test mode.
//!
//! When the app is launched with `ECHO_SCRIBE_SMOKE=1` (only ever done by
//! `scripts/smoke-test.sh` on the release runners), we verify that a fresh
//! install actually boots: the backend arms a watchdog at startup, and the
//! frontend reports in via the `smoke_checkpoint` command once React routing
//! settles on a real view (onboarding/main). On check-in we additionally
//! verify the sidecar binaries were packaged into the bundle — the failure
//! class we've shipped before — then exit 0. If the frontend never reports
//! (bundle broken, webview blank, JS crash), the watchdog exits nonzero and
//! fails the release job.
//!
//! Outside smoke mode `smoke_checkpoint` is a no-op, so this file changes
//! nothing for real users.

use tracing::{error, info};

/// How long the frontend gets to boot and check in before the run is
/// declared a failure. Generous: CI runners cold-start WebKit slowly.
const WATCHDOG_SECS: u64 = 90;

/// Grace period for the non-blocking log appender to flush before exit.
const LOG_FLUSH_MS: u64 = 400;

pub fn enabled() -> bool {
    std::env::var("ECHO_SCRIBE_SMOKE").map(|v| v == "1").unwrap_or(false)
}

/// Called once from `run()` right after logging is initialized.
pub fn arm_watchdog() {
    if !enabled() {
        return;
    }
    info!(target: "smoke", timeout_secs = WATCHDOG_SECS, "smoke mode armed, waiting for frontend checkpoint");
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(WATCHDOG_SECS));
        error!(target: "smoke", "SMOKE FAIL: frontend never checked in within {WATCHDOG_SECS}s");
        eprintln!("SMOKE FAIL: frontend never checked in within {WATCHDOG_SECS}s");
        std::thread::sleep(std::time::Duration::from_millis(LOG_FLUSH_MS));
        std::process::exit(1);
    });
}

/// Sidecars that must ship inside the bundle, next to the main binary.
/// Keep in sync with `bundle.externalBin` in tauri.conf.json.
const SIDECARS: [&str; 3] = [
    "echo-scribe-syscap",
    "echo-scribe-calmatch",
    "echo-scribe-screenrec",
];

fn missing_sidecars() -> Vec<String> {
    let exe_dir = match std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => return vec!["<could not resolve current_exe>".to_string()],
    };
    let mut missing = Vec::new();
    for name in SIDECARS {
        let path = exe_dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        let ok = match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    m.permissions().mode() & 0o111 != 0
                }
                #[cfg(not(unix))]
                {
                    true
                }
            }
            _ => false,
        };
        if !ok {
            missing.push(path.display().to_string());
        }
    }
    missing
}

/// Frontend check-in. Fire-and-forget from App.tsx whenever routing leaves
/// the "checking" state; a no-op unless smoke mode is on.
#[tauri::command]
pub fn smoke_checkpoint(view: String) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let missing = missing_sidecars();
    if !missing.is_empty() {
        error!(target: "smoke", ?missing, "SMOKE FAIL: sidecar binaries missing from bundle");
        eprintln!("SMOKE FAIL: sidecar binaries missing or not executable: {missing:?}");
        std::thread::sleep(std::time::Duration::from_millis(LOG_FLUSH_MS));
        std::process::exit(1);
    }
    info!(target: "smoke", %view, "SMOKE OK: frontend rendered and sidecars present");
    println!("SMOKE OK view={view}");
    std::thread::sleep(std::time::Duration::from_millis(LOG_FLUSH_MS));
    std::process::exit(0);
}
