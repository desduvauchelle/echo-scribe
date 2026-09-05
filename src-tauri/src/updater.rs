use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

use crate::commands::AppState;

const REPO: &str = "desduvauchelle/echo-scribe";
const APP_EXECUTABLE: &str = "echo-scribe";
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const MIN_CHECK_INTERVAL_SECS: i64 = 60 * 60;

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
}

/// Outcome of a user-triggered "Check for Updates" so the UI can show feedback.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ManualCheckResult {
    /// Already running the latest release (`version` is the installed one).
    UpToDate { version: String },
    /// A newer release exists and is now downloading in the background; the
    /// `update-ready` event will fire once it's staged.
    Downloading { version: String },
    /// The check itself failed (network, parse, etc.). `message` is UI-safe.
    Error { message: String },
}

/// Returns true if `remote` is a newer semver than `current`.
/// Expects "MAJOR.MINOR.PATCH" strings; returns false on any parse error.
pub fn is_newer(current: &str, remote: &str) -> bool {
    let parse = |s: &str| -> Option<(u64, u64, u64)> {
        let mut parts = s.splitn(3, '.');
        let major = parts.next()?.parse::<u64>().ok()?;
        let minor = parts.next()?.parse::<u64>().ok()?;
        let patch = parts.next()?.parse::<u64>().ok()?;
        Some((major, minor, patch))
    };
    match (parse(current), parse(remote)) {
        (Some(c), Some(r)) => r > c,
        _ => false,
    }
}

fn staging_app_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library/Application Support")
            .join(crate::data_folder_name())
            .join("pending-update/Tucky.app")
    })
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn fetch_latest_version() -> Option<String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let client = reqwest::Client::builder()
        .user_agent("tucky-updater")
        .build()
        .ok()?;
    let json: serde_json::Value = client.get(&url).send().await.ok()?.json().await.ok()?;
    let tag = json["tag_name"].as_str()?;
    Some(tag.trim_start_matches('v').to_string())
}

async fn download_and_stage(version: &str) -> bool {
    let arch = if std::env::consts::ARCH == "aarch64" {
        "aarch64"
    } else {
        "x86_64"
    };
    let filename = format!("Tucky-{arch}.tar.gz");
    let url = format!("https://github.com/{REPO}/releases/download/v{version}/{filename}");

    let staging_dir = match dirs::home_dir() {
        Some(h) => h
            .join("Library/Application Support")
            .join(crate::data_folder_name())
            .join("pending-update"),
        None => return false,
    };

    if let Err(e) = std::fs::create_dir_all(&staging_dir) {
        error!(error = %e, "failed to create staging dir");
        return false;
    }

    let archive_path = staging_dir.join(&filename);

    let client = match reqwest::Client::builder()
        .user_agent("tucky-updater")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            error!(error = %e, "failed to build HTTP client");
            return false;
        }
    };

    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            warn!(status = %r.status(), "update download returned non-2xx");
            return false;
        }
        Err(e) => {
            error!(error = %e, "update download request failed");
            return false;
        }
    };

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            error!(error = %e, "failed to read update bytes");
            return false;
        }
    };

    if let Err(e) = std::fs::write(&archive_path, &bytes) {
        error!(error = %e, "failed to write archive to staging dir");
        return false;
    }

    let extract = std::process::Command::new("tar")
        .args([
            "-xzf",
            archive_path.to_str().unwrap_or(""),
            "-C",
            staging_dir.to_str().unwrap_or(""),
        ])
        .output();

    match extract {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            warn!(stderr = %String::from_utf8_lossy(&out.stderr), "tar extraction failed");
            let _ = std::fs::remove_dir_all(&staging_dir);
            return false;
        }
        Err(e) => {
            error!(error = %e, "failed to run tar");
            let _ = std::fs::remove_dir_all(&staging_dir);
            return false;
        }
    }

    let _ = std::fs::remove_file(&archive_path);

    let app_path = staging_dir.join("Tucky.app");
    if !app_path.exists() {
        warn!("Tucky.app not found after extraction");
        let _ = std::fs::remove_dir_all(&staging_dir);
        return false;
    }

    let binary_path = staging_dir.join(format!("Tucky.app/Contents/MacOS/{APP_EXECUTABLE}"));
    if !binary_path.exists() {
        warn!("staged binary missing — archive may be corrupt");
        let _ = std::fs::remove_dir_all(&staging_dir);
        return false;
    }

    true
}

/// Path of the `.app` bundle containing the running executable, if any.
fn current_bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(std::path::Path::to_path_buf)
}

/// Spawn and detach a tiny shell script, ignoring its stdio (the scripts log
/// to a file themselves). Returns true when the helper was spawned.
#[cfg(target_os = "macos")]
fn spawn_detached_script(script_path: &std::path::Path, script: &str, what: &str) -> bool {
    if let Err(e) = std::fs::write(script_path, script) {
        error!(error = %e, what, "failed to write helper script");
        return false;
    }
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(script_path, std::fs::Permissions::from_mode(0o755));
    match std::process::Command::new("nohup")
        .args(["bash", script_path.to_str().unwrap_or("")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(_) => {
            info!(what, "helper launched");
            true
        }
        Err(e) => {
            error!(error = %e, what, "failed to spawn helper");
            false
        }
    }
}

/// Arrange for the app to reopen after this process exits: a detached helper
/// waits for our pid to disappear, then `open`s the bundle. Used by every
/// quit-for-effect flow (TCC reset, update install) — without it the app
/// "quits to restart" and simply never comes back, which reads as broken.
/// Helper output goes to `<log-dir>/relaunch-helper.log` so a failed relaunch
/// is diagnosable without a rebuild. Returns false when not running from an
/// `.app` bundle (dev builds) or the helper couldn't start.
#[cfg(target_os = "macos")]
pub fn spawn_relauncher() -> bool {
    let Some(bundle) = current_bundle_path() else {
        warn!("not running from an .app bundle; skipping self-relaunch");
        return false;
    };
    let pid = std::process::id();
    let log = crate::log_dir().join("relaunch-helper.log");
    let script_path = std::env::temp_dir().join(format!("tucky-relaunch-{pid}.sh"));
    let script = format!(
        "#!/bin/bash\n\
         exec >>\"{log}\" 2>&1\n\
         echo \"[$(date)] relaunch helper: waiting for pid {pid} to exit\"\n\
         for _ in $(seq 1 120); do kill -0 {pid} 2>/dev/null || break; sleep 0.5; done\n\
         if kill -0 {pid} 2>/dev/null; then echo \"pid {pid} never exited; giving up\"; rm -- \"$0\"; exit 1; fi\n\
         echo \"[$(date)] reopening {bundle}\"\n\
         open \"{bundle}\"\n\
         rm -- \"$0\"\n",
        log = log.display(),
        bundle = bundle.display(),
    );
    spawn_detached_script(&script_path, &script, "relaunch")
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_relauncher() -> bool {
    false
}

/// Write a helper shell script, launch it detached, then exit the process.
/// The script waits for the app to exit, replaces the bundle, strips quarantine,
/// relaunches, and self-deletes.
#[cfg(target_os = "macos")]
pub fn launch_update_helper() {
    // The helper script replaces /Applications/Tucky.app in place. An
    // isolated variant (fresh-install simulator) must never do that — it
    // would overwrite the real install.
    if crate::data_folder_name() != "EchoScribe" {
        error!("self-update disabled for isolated variant builds");
        return;
    }
    let staging = match staging_app_path() {
        Some(p) if p.exists() => p,
        _ => {
            error!("no staged update found");
            return;
        }
    };

    let staging_dir = match staging.parent() {
        Some(p) => p.to_string_lossy().to_string(),
        None => {
            error!("could not determine staging dir parent");
            return;
        }
    };

    // Replace the bundle we're actually running from; /Applications/Echo
    // Scribe.app is only the conventional install location.
    let target = current_bundle_path()
        .unwrap_or_else(|| PathBuf::from("/Applications/Tucky.app"));
    let pid = std::process::id();
    let log = crate::log_dir().join("update-helper.log");
    let script_path = std::env::temp_dir().join(format!("tucky-update-{pid}.sh"));

    // The old script slept a fixed 2s and then called `open`. If the app took
    // longer than that to exit, `open` merely activated the dying instance —
    // and once it finished quitting, nothing relaunched ("update → the app
    // never came back"). Wait for the pid instead, and log every step.
    let script = format!(
        "#!/bin/bash\n\
         exec >>\"{log}\" 2>&1\n\
         echo \"[$(date)] update helper: waiting for pid {pid} to exit\"\n\
         for _ in $(seq 1 240); do kill -0 {pid} 2>/dev/null || break; sleep 0.5; done\n\
         if kill -0 {pid} 2>/dev/null; then echo \"pid {pid} never exited; aborting update\"; rm -- \"$0\"; exit 1; fi\n\
         echo \"[$(date)] swapping {target}\"\n\
         rm -rf \"{target}\"\n\
         cp -R \"{staged}\" \"{target}\"\n\
         xattr -dr com.apple.quarantine \"{target}\" 2>/dev/null || true\n\
         rm -rf \"{staging_dir}\"\n\
         echo \"[$(date)] relaunching {target}\"\n\
         open \"{target}\"\n\
         rm -- \"$0\"\n",
        log = log.display(),
        target = target.display(),
        staged = staging.display(),
        staging_dir = staging_dir,
    );

    if !spawn_detached_script(&script_path, &script, "update") {
        return;
    }

    std::process::exit(0);
}

#[cfg(not(target_os = "macos"))]
pub fn launch_update_helper() {
    warn!("self-update restart is only supported on macOS");
}

pub async fn check_and_download(app: &AppHandle) {
    let state = app.state::<AppState>();

    let now = now_unix();
    if now - state.settings.last_update_check() < MIN_CHECK_INTERVAL_SECS {
        return;
    }

    let current = app.package_info().version.to_string();

    let latest = match fetch_latest_version().await {
        Some(v) => v,
        None => {
            warn!("could not fetch latest release");
            return;
        }
    };

    let _ = state.settings.set_last_update_check(now);

    if !is_newer(&current, &latest) {
        info!(current = %current, latest = %latest, "already up to date");
        return;
    }

    if state.settings.dismissed_update_version().as_deref() == Some(latest.as_str()) {
        info!(version = %latest, "update dismissed by user, skipping");
        return;
    }

    info!(current = %current, latest = %latest, "downloading update");

    if download_and_stage(&latest).await {
        info!(version = %latest, "update ready, notifying frontend");
        let _ = app.emit("update-ready", UpdateInfo { version: latest });
    }
}

/// User-triggered check (menu item / Settings button). Unlike the background
/// [`check_and_download`] this ignores the throttle and always reports an
/// outcome so the UI can toast "up to date" or "downloading". When a newer
/// release exists it clears any prior dismissal, kicks off the download in the
/// background, and the existing `update-ready` event drives the banner once
/// staging completes. Non-mac builds report "up to date" — self-update only
/// swaps a macOS `.app` bundle (see [`launch_update_helper`]).
pub async fn check_now(app: &AppHandle) -> ManualCheckResult {
    let current = app.package_info().version.to_string();

    if cfg!(not(target_os = "macos")) {
        return ManualCheckResult::UpToDate { version: current };
    }

    let latest = match fetch_latest_version().await {
        Some(v) => v,
        None => {
            warn!(target: "updater", "manual check: could not fetch latest release");
            return ManualCheckResult::Error {
                message:
                    "Couldn't reach the update server. See Settings → Diagnostics → logs for details."
                        .into(),
            };
        }
    };

    let state = app.state::<AppState>();
    let _ = state.settings.set_last_update_check(now_unix());

    if !is_newer(&current, &latest) {
        info!(target: "updater", current = %current, latest = %latest, "manual check: up to date");
        return ManualCheckResult::UpToDate { version: current };
    }

    // The user explicitly asked to update, so undo any earlier "dismiss" of this
    // version — otherwise the background checker would keep skipping it.
    let _ = state.settings.set_dismissed_update_version("");

    info!(target: "updater", current = %current, latest = %latest, "manual check: downloading update");

    let app = app.clone();
    let version = latest.clone();
    tauri::async_runtime::spawn(async move {
        if download_and_stage(&version).await {
            info!(target: "updater", version = %version, "manual check: update staged, notifying frontend");
            let _ = app.emit("update-ready", UpdateInfo { version });
        } else {
            warn!(target: "updater", "manual check: download/stage failed");
            let _ = app.emit(
                "update-error",
                "Update download failed. See Settings → Diagnostics → logs for details."
                    .to_string(),
            );
        }
    });

    ManualCheckResult::Downloading { version: latest }
}

pub fn spawn_updater(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        check_and_download(&app).await;
        let mut interval = tokio::time::interval(Duration::from_secs(CHECK_INTERVAL_SECS));
        interval.tick().await; // consume the immediate first tick (already ran above)
        loop {
            interval.tick().await;
            check_and_download(&app).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_minor_is_detected() {
        assert!(is_newer("0.1.0", "0.2.0"));
    }

    #[test]
    fn local_version_newer_than_server_is_not_an_update() {
        assert!(!is_newer("1.0.3", "1.0.2"));
    }

    #[test]
    fn same_version_is_not_newer() {
        assert!(!is_newer("0.1.0", "0.1.0"));
    }

    #[test]
    fn major_bump_is_detected() {
        assert!(is_newer("0.9.9", "1.0.0"));
    }

    #[test]
    fn patch_bump_is_detected() {
        assert!(is_newer("0.1.0", "0.1.1"));
    }

    #[test]
    fn garbage_returns_false() {
        assert!(!is_newer("not-a-version", "also-not"));
    }
}
