# Auto-Update Design

**Date:** 2026-05-02  
**Scope:** Background update check, silent download, banner notification, and apply-on-restart for unsigned macOS app

## Context

Echo Scribe is unsigned (no Apple Developer account). Standard `tauri-plugin-updater` expects signed/notarized binaries. Instead we use a custom updater that reuses the same GitHub Releases + `.tar.gz` infrastructure as `install.sh`. Settings survive updates because only `/Applications/Echo Scribe.app` is replaced — `~/Library/Application Support/EchoScribe/` (where `tauri-plugin-store` data lives) is never touched.

## Architecture

Four components:

1. **`src-tauri/src/updater.rs`** — all update logic: version check, download, apply-on-restart
2. **`src/components/UpdateBanner.tsx`** — dismissible frontend banner, listens for `update-ready` event
3. **CI version baking** — `release.yml` writes the git tag into `tauri.conf.json` + `Cargo.toml` before building
4. **`tauri-plugin-store`** (already present) — persists `last_update_check` and `dismissed_update_version`

## Version Baking (CI)

The `release.yml` workflow gains a step before `bun tauri build`:

```bash
VERSION="${GITHUB_REF_NAME#v}"
jq --arg v "$VERSION" '.version = $v' src-tauri/tauri.conf.json > tmp.json && mv tmp.json src-tauri/tauri.conf.json
sed -i "" "s/^version = .*/version = \"$VERSION\"/" src-tauri/Cargo.toml
```

At runtime the app reads its own version via `app.package_info().version`.

## Update Check Flow

Runs asynchronously at startup (never blocks UI) and repeats on a 24-hour timer:

1. Read `last_update_check` from store — skip if checked within the last hour
2. `GET https://api.github.com/repos/denisduvauchelle/echo-scribe/releases/latest` → extract `tag_name`, strip `v`, parse semver
3. Compare against `app.package_info().version`
4. If not newer: write `last_update_check` timestamp, done
5. If newer and `dismissed_update_version` matches: skip (user dismissed this version)
6. If newer: download `EchoScribe-{arch}.tar.gz` silently to `~/Library/Application Support/EchoScribe/pending-update/`
7. Extract `.app` bundle into the same staging folder
8. Emit `update-ready` event to frontend with new version string

Arch detection: `std::env::consts::ARCH` → `"aarch64"` or `"x86_64"`.

## Apply on Restart

Triggered by "Restart Now" button or detected pending update on app quit:

1. Write helper script to `/tmp/echo-scribe-update-{pid}.sh`:

```bash
#!/bin/bash
sleep 2
STAGED="$HOME/Library/Application Support/EchoScribe/pending-update/Echo Scribe.app"
rm -rf "/Applications/Echo Scribe.app"
cp -R "$STAGED" "/Applications/Echo Scribe.app"
xattr -dr com.apple.quarantine "/Applications/Echo Scribe.app"
rm -rf "$HOME/Library/Application Support/EchoScribe/pending-update"
open "/Applications/Echo Scribe.app"
rm -- "$0"
```

2. Launch detached: `nohup bash /tmp/echo-scribe-update-{pid}.sh &`
3. Call `std::process::exit(0)`

On next startup, if `pending-update/` is absent, no action needed.

## Frontend Banner

File: `src/components/UpdateBanner.tsx`

- Listens for `update-ready` Tauri event via `listen()`
- Renders a slim banner at top of main window: `⬆ Echo Scribe {version} is ready  [Restart Now]  [×]`
- **Restart Now**: calls `invoke("apply_update_and_restart")`
- **×**: calls `invoke("dismiss_update", { version })` which writes `dismissed_update_version` to store and hides the banner for this version
- Banner does not block any app functionality
- Mounted in `App.tsx` above existing content

## Tauri Commands Exposed

| Command | Description |
|---|---|
| `apply_update_and_restart` | Writes helper script, launches it, exits app |
| `dismiss_update(version: String)` | Stores dismissed version, frontend hides banner |

## Error Handling

- GitHub API unreachable: log, skip silently, try again next 24h cycle
- Download fails: log, delete partial file, try again next cycle (no banner shown)
- `/Applications` not writable at apply time: helper script logs error to `~/Library/Logs/EchoScribe/update.log`, app relaunches without update applied (user still on old version)

## Settings Preservation

`tauri-plugin-store` data lives at `~/Library/Application Support/EchoScribe/`. The update only replaces `/Applications/Echo Scribe.app`. All settings, hotkey preferences, downloaded models, and SQLite data survive automatically.

## Out of Scope

- Rollback on failed update
- Update release notes / changelog in the banner
- Delta updates (full `.tar.gz` only)
- Manual "Check for updates" menu item
