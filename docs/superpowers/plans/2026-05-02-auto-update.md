# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Background update checker that downloads new releases silently, shows a banner when ready, and applies the update via a helper script on restart.

**Architecture:** A `updater.rs` Rust module polls the GitHub API on startup + every 24 h, downloads the matching `.tar.gz` to a staging folder, and emits a `update-ready` event. The frontend `UpdateBanner` component listens for this event and shows a dismissible banner. "Restart Now" invokes `apply_update_and_restart` which writes a shell script, launches it detached, and exits — the helper swaps the `.app` bundle while the process is gone. CI gains a version-baking step so the binary knows its own version at runtime.

**Tech Stack:** Rust (`reqwest`, `tokio::time`, `dirs`, `serde_json` — all already in `Cargo.toml`), React/TypeScript, `tauri-plugin-store` (already present), GitHub Actions

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/src/settings.rs` | Modify | Add `last_update_check` and `dismissed_update_version` keys |
| `src-tauri/src/updater.rs` | Create | Version check, download, helper script launch, background task |
| `src-tauri/src/commands.rs` | Modify | Add `apply_update_and_restart` and `dismiss_update` commands |
| `src-tauri/src/lib.rs` | Modify | Register new module, register commands, spawn updater in setup |
| `.github/workflows/release.yml` | Modify | Bake git tag version into `tauri.conf.json` + `Cargo.toml` before build |
| `src/lib/api.ts` | Modify | Add typed `applyUpdateAndRestart` and `dismissUpdate` wrappers |
| `src/components/UpdateBanner.tsx` | Create | Dismissible banner, listens for `update-ready`, calls commands |
| `src/App.tsx` | Modify | Mount `UpdateBanner` above main content |

---

### Task 1: SettingsStore — updater persistence keys

**Files:**
- Modify: `src-tauri/src/settings.rs`

- [ ] **Step 1: Write the failing tests**

Add at the bottom of `settings.rs` inside the existing `#[cfg(test)]` block (or create one):

```rust
#[cfg(test)]
mod updater_tests {
    // NOTE: These tests require a running Tauri app to construct a real store,
    // so they validate the constant values and default logic only.

    use super::*;

    #[test]
    fn last_update_check_constant_is_correct() {
        assert_eq!(KEY_LAST_UPDATE_CHECK, "last_update_check");
    }

    #[test]
    fn dismissed_update_version_constant_is_correct() {
        assert_eq!(KEY_DISMISSED_UPDATE_VERSION, "dismissed_update_version");
    }
}
```

- [ ] **Step 2: Run tests to see them fail**

```bash
cd src-tauri && cargo test --lib settings::updater_tests 2>&1 | tail -6
```

Expected: FAIL — `KEY_LAST_UPDATE_CHECK` and `KEY_DISMISSED_UPDATE_VERSION` not defined.

- [ ] **Step 3: Add constants and accessors to `settings.rs`**

After the existing constants block (after `KEY_LLM_UNLOAD_SECS`), add:

```rust
const KEY_LAST_UPDATE_CHECK: &str = "last_update_check";
const KEY_DISMISSED_UPDATE_VERSION: &str = "dismissed_update_version";
```

After the `set_llm_unload_secs` method, add:

```rust
/// Unix timestamp (seconds) of the last update check. Defaults to 0 (never checked).
pub fn last_update_check(&self) -> i64 {
    self.store
        .get(KEY_LAST_UPDATE_CHECK)
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

pub fn set_last_update_check(&self, ts: i64) -> Result<(), SettingsError> {
    self.store
        .set(KEY_LAST_UPDATE_CHECK, serde_json::Value::Number(ts.into()));
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))?;
    Ok(())
}

/// Version string the user last dismissed (e.g. `"0.2.0"`). `None` if never dismissed.
pub fn dismissed_update_version(&self) -> Option<String> {
    self.store
        .get(KEY_DISMISSED_UPDATE_VERSION)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

pub fn set_dismissed_update_version(&self, version: &str) -> Result<(), SettingsError> {
    self.store.set(
        KEY_DISMISSED_UPDATE_VERSION,
        serde_json::Value::String(version.to_string()),
    );
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))?;
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test --lib settings::updater_tests 2>&1 | tail -6
```

Expected: `test result: ok. 2 passed`

---

### Task 2: Create `src-tauri/src/updater.rs`

**Files:**
- Create: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod updater;`)

- [ ] **Step 1: Write failing unit tests for `is_newer`**

Create `src-tauri/src/updater.rs` with just the tests + stub:

```rust
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

use crate::commands::AppState;

const REPO: &str = "desduvauchelle/echo-scribe";
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const MIN_CHECK_INTERVAL_SECS: i64 = 60 * 60;

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
}

/// Returns true if `remote` is a newer semver than `current`.
/// Expects "MAJOR.MINOR.PATCH" strings; returns false on any parse error.
pub fn is_newer(current: &str, remote: &str) -> bool {
    todo!()
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
```

- [ ] **Step 2: Add `pub mod updater;` to `lib.rs`**

In `src-tauri/src/lib.rs`, add after the other `pub mod` declarations at the top:

```rust
pub mod updater;
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd src-tauri && cargo test --lib updater::tests 2>&1 | tail -8
```

Expected: compile error or panic from `todo!()`.

- [ ] **Step 4: Implement `is_newer`**

Replace `todo!()` with:

```rust
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd src-tauri && cargo test --lib updater::tests 2>&1 | tail -8
```

Expected: `test result: ok. 6 passed`

- [ ] **Step 6: Add the rest of `updater.rs` — version fetch, download, helper, background task**

Append after the `is_newer` function (before `#[cfg(test)]`):

```rust
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
            return false;
        }
        Err(e) => { error!(error = %e, "failed to run tar"); return false; }
    }

    let _ = std::fs::remove_file(&archive_path);

    let app_path = staging_dir.join("Echo Scribe.app");
    if !app_path.exists() {
        warn!("Echo Scribe.app not found after extraction");
        return false;
    }

    true
}

/// Write a helper shell script, launch it detached, then exit the process.
/// The script waits for the app to exit, replaces the bundle, strips quarantine,
/// relaunches, and self-deletes.
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

    match std::process::Command::new("bash")
        .arg(&script_path)
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
```

- [ ] **Step 7: Run all lib tests to verify no regressions**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -6
```

Expected: same pass/fail count as before (1 pre-existing failure in `asr::downloader`, rest pass).

---

### Task 3: Tauri commands + wiring

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `apply_update_and_restart` and `dismiss_update` to `commands.rs`**

Append at the end of `commands.rs`:

```rust
/// Applies the staged update by writing a helper shell script, launching it
/// detached, then exiting the process. The helper swaps the .app bundle while
/// the process is gone, strips quarantine, and relaunches the app.
#[tauri::command]
pub fn apply_update_and_restart() {
    crate::updater::launch_update_helper();
}

/// Persists the dismissed version so the update banner doesn't reappear for it.
#[tauri::command]
pub fn dismiss_update(state: State<'_, AppState>, version: String) {
    if let Err(e) = state.settings.set_dismissed_update_version(&version) {
        tracing::error!(error = %e, "failed to persist dismissed update version");
    }
}
```

- [ ] **Step 2: Register the new commands and spawn updater in `lib.rs`**

In `lib.rs`, add `apply_update_and_restart` and `dismiss_update` to the imports from `commands`:

```rust
use crate::commands::{
    // ... existing imports ...
    apply_update_and_restart,
    dismiss_update,
    // ... rest of imports ...
};
```

Add them to `tauri::generate_handler!` in the `.invoke_handler(...)` call:

```rust
apply_update_and_restart,
dismiss_update,
```

At the end of the `setup` closure, just before `Ok(())`, spawn the updater. `spawn_updater` is synchronous — it internally calls `tauri::async_runtime::spawn`, so call it directly:

```rust
// Spawn background update checker.
{
    let handle = app.handle().clone();
    crate::updater::spawn_updater(handle);
}
```

- [ ] **Step 3: Run all lib tests**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -6
```

Expected: same pass/fail count as before.

- [ ] **Step 4: Verify it compiles cleanly**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error" | head -10
```

Expected: no output (no errors).

---

### Task 4: CI version baking

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add version-baking step to `release.yml`**

In `.github/workflows/release.yml`, insert a new step between "Install Node dependencies" and "Build app bundle":

```yaml
      - name: Bake version from tag
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          jq --arg v "$VERSION" '.version = $v' src-tauri/tauri.conf.json > tmp.json && mv tmp.json src-tauri/tauri.conf.json
          sed -i "" "s/^version = .*/version = \"$VERSION\"/" src-tauri/Cargo.toml
```

The full steps block should read:

```yaml
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install Node dependencies
        run: bun install

      - name: Bake version from tag
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          jq --arg v "$VERSION" '.version = $v' src-tauri/tauri.conf.json > tmp.json && mv tmp.json src-tauri/tauri.conf.json
          sed -i "" "s/^version = .*/version = \"$VERSION\"/" src-tauri/Cargo.toml

      - name: Build app bundle
        run: bun tauri build --bundles app

      - name: Package
        run: |
          tar -czf "EchoScribe-${{ matrix.arch }}.tar.gz" \
            -C src-tauri/target/release/bundle/macos \
            "Echo Scribe.app"

      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          files: "EchoScribe-${{ matrix.arch }}.tar.gz"
```

- [ ] **Step 2: Validate YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"
```

Expected: `ok`

---

### Task 5: Frontend — api.ts wrappers

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add `applyUpdateAndRestart` and `dismissUpdate` to `api.ts`**

Append at the end of `src/lib/api.ts`:

```typescript
export const applyUpdateAndRestart = (): Promise<void> =>
  invoke("apply_update_and_restart");

export const dismissUpdate = (version: string): Promise<void> =>
  invoke("dismiss_update", { version });
```

---

### Task 6: Frontend — `UpdateBanner` component

**Files:**
- Create: `src/components/UpdateBanner.tsx`

- [ ] **Step 1: Create `src/components/UpdateBanner.tsx`**

```tsx
import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { applyUpdateAndRestart, dismissUpdate } from "../lib/api";

type UpdateInfo = {
  version: string;
};

export default function UpdateBanner() {
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<UpdateInfo>("update-ready", (event) => {
        setUpdateVersion(event.payload.version);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  if (!updateVersion) return null;

  const handleRestart = async () => {
    await applyUpdateAndRestart();
  };

  const handleDismiss = async () => {
    setUpdateVersion(null);
    await dismissUpdate(updateVersion);
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-blue-900/60 bg-blue-950/40 px-4 py-2 text-xs text-blue-100">
      <span>
        ↑ Echo Scribe {updateVersion} is ready
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRestart}
          className="shrink-0 rounded border border-blue-700 bg-blue-900/50 px-2 py-0.5 font-semibold text-blue-100 hover:bg-blue-900/70"
        >
          Restart Now
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 text-blue-400 hover:text-blue-200"
          aria-label="Dismiss update"
        >
          ×
        </button>
      </div>
    </div>
  );
}
```

---

### Task 7: Mount `UpdateBanner` in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import and mount `UpdateBanner` in `App.tsx`**

Add the import at the top of `src/App.tsx` with the other component imports:

```typescript
import UpdateBanner from "./components/UpdateBanner";
```

In the `AppShell` function, mount the banner above `<PermissionWarningBanner>` in the `main` view return block. The final `return` at the bottom of `AppShell` should become:

```tsx
  return (
    <>
      {dragBar}
      <UpdateBanner />
      <PermissionWarningBanner onOpenSettings={() => setView("settings")} />
      <Main key={mainKey} onOpenSettings={() => setView("settings")} />
      {overlay}
    </>
  );
```

- [ ] **Step 2: Also add it to the `onboarding` and `settings` views so it shows regardless of which view is active**

In the `onboarding` return:

```tsx
  if (view === "onboarding") {
    return (
      <>
        {dragBar}
        <UpdateBanner />
        <Onboarding
          initialStatus={initialStatus}
          resumeNotice={resumeNotice}
          onStarted={() => {
            setResumeNotice(null);
            setView("main");
          }}
        />
        {overlay}
      </>
    );
  }
```

In the `settings` return:

```tsx
  if (view === "settings") {
    return (
      <>
        {dragBar}
        <UpdateBanner />
        <Settings
          onBack={() => {
            setMainKey((k) => k + 1);
            setView("main");
          }}
        />
        {overlay}
      </>
    );
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bunx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Run all Rust tests one final time**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -6
```

Expected: same pass/fail count as baseline (1 pre-existing failure, rest pass).

- [ ] **Step 5: Commit everything**

```bash
git add \
  src-tauri/src/settings.rs \
  src-tauri/src/updater.rs \
  src-tauri/src/commands.rs \
  src-tauri/src/lib.rs \
  .github/workflows/release.yml \
  src/lib/api.ts \
  src/components/UpdateBanner.tsx \
  src/App.tsx
git commit -m "feat(updater): background update check, silent download, restart-to-apply banner"
```
