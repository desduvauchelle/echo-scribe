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
        h.join("Library/Application Support/EchoScribe/pending-update/Echo Scribe.app")
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
        .user_agent("echo-scribe-updater")
        .build()
        .ok()?;
    let json: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let tag = json["tag_name"].as_str()?;
    Some(tag.trim_start_matches('v').to_string())
}

async fn download_and_stage(version: &str) -> bool {
    let arch = if std::env::consts::ARCH == "aarch64" { "aarch64" } else { "x86_64" };
    let filename = format!("EchoScribe-{arch}.tar.gz");
    let url = format!(
        "https://github.com/{REPO}/releases/download/v{version}/{filename}"
    );

    let staging_dir = match dirs::home_dir() {
        Some(h) => h.join("Library/Application Support/EchoScribe/pending-update"),
        None => return false,
    };

    if let Err(e) = std::fs::create_dir_all(&staging_dir) {
        error!(error = %e, "failed to create staging dir");
        return false;
    }

    let archive_path = staging_dir.join(&filename);

    let client = match reqwest::Client::builder().user_agent("echo-scribe-updater").build() {
        Ok(c) => c,
        Err(e) => { error!(error = %e, "failed to build HTTP client"); return false; }
    };

    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => { warn!(status = %r.status(), "update download returned non-2xx"); return false; }
        Err(e) => { error!(error = %e, "update download request failed"); return false; }
    };

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => { error!(error = %e, "failed to read update bytes"); return false; }
    };

    if let Err(e) = std::fs::write(&archive_path, &bytes) {
        error!(error = %e, "failed to write archive to staging dir");
        return false;
    }

    let extract = std::process::Command::new("tar")
        .args(["-xzf", archive_path.to_str().unwrap_or(""), "-C", staging_dir.to_str().unwrap_or("")])
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

    let app_path = staging_dir.join("Echo Scribe.app");
    if !app_path.exists() {
        warn!("Echo Scribe.app not found after extraction");
        let _ = std::fs::remove_dir_all(&staging_dir);
        return false;
    }

    let binary_path = staging_dir.join(format!("Echo Scribe.app/Contents/MacOS/{APP_EXECUTABLE}"));
    if !binary_path.exists() {
        warn!("staged binary missing — archive may be corrupt");
        let _ = std::fs::remove_dir_all(&staging_dir);
        return false;
    }

    true
}

/// Write a helper shell script, launch it detached, then exit the process.
/// The script waits for the app to exit, replaces the bundle, strips quarantine,
/// relaunches, and self-deletes.
#[cfg(target_os = "macos")]
pub fn launch_update_helper() {
    let staging = match staging_app_path() {
        Some(p) if p.exists() => p,
        _ => { error!("no staged update found"); return; }
    };

    let staging_dir = match staging.parent() {
        Some(p) => p.to_string_lossy().to_string(),
        None => { error!("could not determine staging dir parent"); return; }
    };

    let pid = std::process::id();
    let script_path = std::env::temp_dir().join(format!("echo-scribe-update-{pid}.sh"));

    let script = format!(
        "#!/bin/bash\nsleep 2\nrm -rf \"/Applications/Echo Scribe.app\"\ncp -R \"{staged}\" \"/Applications/Echo Scribe.app\"\nxattr -dr com.apple.quarantine \"/Applications/Echo Scribe.app\" 2>/dev/null || true\nrm -rf \"{staging_dir}\"\nopen \"/Applications/Echo Scribe.app\"\nrm -- \"$0\"\n",
        staged = staging.display(),
        staging_dir = staging_dir,
    );

    if let Err(e) = std::fs::write(&script_path, &script) {
        error!(error = %e, "failed to write update helper script");
        return;
    }

    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));

    match std::process::Command::new("nohup")
        .args(["bash", script_path.to_str().unwrap_or("")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(_) => info!("update helper launched"),
        Err(e) => { error!(error = %e, "failed to spawn update helper"); return; }
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
        None => { warn!("could not fetch latest release"); return; }
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
    fn older_is_not_newer() {
        assert!(!is_newer("0.2.0", "0.1.0"));
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
