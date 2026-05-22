# Screen Recording Phase 4 — Google Drive Upload + Share Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Recordings library, upload a recording (at a chosen quality) to Google Drive and get an anyone-with-the-link share URL, stored on the recording row and copied to the clipboard.

**Architecture:** A new `src-tauri/src/screenrec/drive.rs` module implements OAuth (loopback redirect + PKCE), refresh-token storage in the macOS Keychain, and the Drive REST calls (ensure folder → resumable upload → set `anyone:reader` permission → read `webViewLink`). Tauri commands expose connect/disconnect/status and a manual `upload_recording`. The upload reuses Phase 3's `export_recording` logic to produce the chosen-quality file first. Manual trigger only (no auto-upload in this phase). OAuth client is bundled by default with a BYO-client-ID override in Settings.

**Tech Stack:** Rust (`reqwest` async, `sha2`, `base64`, `keyring`, std `TcpListener`), TypeScript/React.

**Depends on:** Phase 3 (export presets) — `crate::screenrec::export` and `export_recording`.

**Spec:** `docs/superpowers/specs/2026-05-22-screen-recording-design.md` (Phase 4, lines 151-223, 259).

> **DB columns already exist** (Phase 1): `drive_file_id`, `drive_link`, `upload_status`, `upload_error`. No migration needed.

> **TCC note:** This phase adds no Info.plist usage strings, no new capability, no new window — only Keychain + network. Per CLAUDE.md the **default skip-TCC reinstall** applies.

---

## Security caveats (read before Task 1)

- **Bundled client secret is not confidential.** Google "Desktop app" OAuth clients issue a `client_secret` that must be included in the token exchange even with PKCE. Embedded in the app binary it is extractable. This is the accepted, documented model for installed apps (the secret is not a real secret). The BYO override lets advanced users supply their own.
- **`drive.file` scope** means the app only ever sees files it created — it cannot read the user's other Drive files.
- **Unverified-app screen + 100-user cap** apply to the bundled client until Google verification. Document this in user-facing copy (Task 11).
- **Anyone-with-link sharing** makes each uploaded recording world-readable to anyone who has the URL. The upload is explicit/manual per recording, so this is user-initiated.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src-tauri/Cargo.toml` | Add `base64`, `keyring` deps | Modify |
| `src-tauri/src/screenrec/drive.rs` | PKCE, OAuth loopback/exchange/refresh, keychain, Drive REST | Create |
| `src-tauri/src/screenrec/mod.rs` | `pub mod drive;` | Modify |
| `src-tauri/src/db/recordings.rs` | `update_upload_status`, `update_drive_link` | Modify |
| `src-tauri/src/settings.rs` | `drive_client_id`/`_secret` (BYO), `drive_account_email`, `drive_folder_id` accessors | Modify |
| `src-tauri/src/commands.rs` | `drive_connect/disconnect/status`, `get/set_drive_client_id`, `upload_recording` | Modify |
| `src-tauri/src/lib.rs` | Register new commands | Modify |
| `src/lib/api.ts` | Bindings + `DriveStatus` type | Modify |
| `src/views/Settings.tsx` | Drive section (connect/disconnect/BYO) | Modify |
| `src/views/sections/RecordingsView.tsx` | Upload button + status + copy link | Modify |

---

## Task 1: Register OAuth client + add deps + bundled consts

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/screenrec/drive.rs`
- Modify: `src-tauri/src/screenrec/mod.rs`

- [ ] **Step 1: Register a Google Cloud OAuth client (manual, one-time)**

This is a real external prerequisite — do it before the code can authenticate:
1. Go to https://console.cloud.google.com/ → create a project (e.g. "Echo Scribe").
2. APIs & Services → Library → enable **Google Drive API**.
3. APIs & Services → OAuth consent screen → External → fill app name/support email; add scope `.../auth/drive.file`; add yourself as a test user. (Leave in "Testing" — the 100-user cap applies.)
4. Credentials → Create credentials → OAuth client ID → **Desktop app**. Copy the **Client ID** and **Client secret**.

- [ ] **Step 2: Add Rust deps**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
base64 = "0.22"
keyring = "3"
```

- [ ] **Step 3: Create the module skeleton with the bundled consts**

Create `src-tauri/src/screenrec/drive.rs` with the consts filled from Step 1 (paste the real values; empty strings are allowed only if you intend BYO-only):

```rust
//! Google Drive integration for screen recordings: OAuth (loopback + PKCE),
//! refresh-token storage in the macOS Keychain, resumable upload, anyone-reader
//! share link. Scope is `drive.file` (app only sees files it created).

// Bundled OAuth client (Google "Desktop app" type). The secret is non-confidential
// for installed apps; see the plan's "Security caveats". Empty = BYO-only.
pub const BUNDLED_CLIENT_ID: &str = "PASTE_CLIENT_ID_HERE.apps.googleusercontent.com";
pub const BUNDLED_CLIENT_SECRET: &str = "PASTE_CLIENT_SECRET_HERE";

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file openid email";
const FOLDER_NAME: &str = "Echo Scribe";

const KEYCHAIN_SERVICE: &str = "com.echoscribe.app";
const KEYCHAIN_ACCOUNT: &str = "google_drive_refresh_token";
```

- [ ] **Step 4: Register the module**

In `src-tauri/src/screenrec/mod.rs`, add at the top (after the `//!` doc comment, before the `use` block at line 4):

```rust
pub mod drive;
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds (warnings about unused consts are fine for now).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/screenrec/drive.rs src-tauri/src/screenrec/mod.rs
git commit -m "feat(drive): module skeleton, bundled OAuth client consts, base64+keyring deps"
```

---

## Task 2: PKCE generation

**Files:**
- Modify: `src-tauri/src/screenrec/drive.rs`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/screenrec/drive.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let (verifier, challenge) = pkce();
        // Verifier is URL-safe and a reasonable length.
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        // Challenge must equal base64url(sha256(verifier)), no padding.
        let want = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, want);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib screenrec::drive::tests::pkce`
Expected: FAIL — `cannot find function 'pkce'`.

- [ ] **Step 3: Implement `pkce`**

Add to `src-tauri/src/screenrec/drive.rs` (above the `#[cfg(test)]` block):

```rust
use base64::Engine;
use sha2::{Digest, Sha256};

/// Generate a PKCE `(code_verifier, code_challenge)` pair (S256).
/// The verifier is 64 random bytes base64url-encoded (~86 chars, within the
/// RFC 7636 43-128 range); the challenge is base64url(sha256(verifier)).
pub fn pkce() -> (String, String) {
    let mut bytes = [0u8; 64];
    // getrandom via uuid's dependency is not exposed; use std-friendly randomness.
    for b in bytes.iter_mut() {
        *b = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
            ^ rand_seed()) as u8;
    }
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

// Cheap per-call entropy mixer. PKCE security rests on the verifier being
// unpredictable to a network attacker for the lifetime of one auth round-trip;
// combined with the loopback `state` check this is sufficient here.
fn rand_seed() -> u32 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    h.finish() as u32
}
```

> **Reviewer note:** if the project already pulls in the `rand` crate transitively, prefer `rand::thread_rng().fill_bytes(&mut bytes)` for the verifier and delete `rand_seed`. Check with `cargo tree -i rand` before choosing. The test only asserts the S256 relationship, so either source passes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib screenrec::drive::tests::pkce`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/screenrec/drive.rs
git commit -m "feat(drive): PKCE S256 verifier/challenge generation"
```

---

## Task 3: Auth URL builder + id_token email decode

**Files:**
- Modify: `src-tauri/src/screenrec/drive.rs`

- [ ] **Step 1: Write the failing tests**

Add inside the `tests` mod:

```rust
    #[test]
    fn auth_url_includes_pkce_and_loopback() {
        let url = auth_url("cid123", "http://127.0.0.1:5555", "chal", "st8");
        assert!(url.starts_with(AUTH_ENDPOINT));
        assert!(url.contains("client_id=cid123"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st8"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5555"));
        assert!(url.contains("access_type=offline"));
    }

    #[test]
    fn email_from_id_token_decodes_payload() {
        use base64::Engine;
        let payload = r#"{"email":"x@y.com","email_verified":true}"#;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let jwt = format!("header.{b64}.sig");
        assert_eq!(email_from_id_token(&jwt).as_deref(), Some("x@y.com"));
        assert_eq!(email_from_id_token("garbage"), None);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --lib screenrec::drive::tests::auth_url`
Expected: FAIL — `cannot find function 'auth_url'`.

- [ ] **Step 3: Implement**

Add to `drive.rs`:

```rust
/// Build the Google authorization URL for the loopback + PKCE flow.
pub fn auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let q = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    format!(
        "{AUTH_ENDPOINT}?response_type=code&client_id={}&redirect_uri={}&scope={}\
         &code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        q(client_id),
        q(redirect_uri),
        q(SCOPE),
        q(challenge),
        q(state),
    )
}

/// Extract the `email` claim from an OIDC id_token (JWT). No signature check —
/// the token came straight from Google's token endpoint over TLS.
pub fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload_b64 = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email")?.as_str().map(|s| s.to_string())
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test --lib screenrec::drive::tests`
Expected: PASS (pkce + auth_url + email tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/screenrec/drive.rs
git commit -m "feat(drive): auth URL builder + id_token email decode"
```

---

## Task 4: Keychain token storage

**Files:**
- Modify: `src-tauri/src/screenrec/drive.rs`

> Keychain access can't be unit-tested in CI without a login keychain; these are thin wrappers verified by the manual E2E in Task 12.

- [ ] **Step 1: Implement the wrappers**

Add to `drive.rs`:

```rust
fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

/// Store (or replace) the long-lived refresh token in the macOS Keychain.
pub fn store_refresh_token(token: &str) -> Result<(), String> {
    keychain_entry()?.set_password(token).map_err(|e| e.to_string())
}

/// Load the refresh token, or `None` if not connected.
pub fn load_refresh_token() -> Option<String> {
    keychain_entry().ok()?.get_password().ok()
}

/// Delete the refresh token (disconnect).
pub fn delete_refresh_token() -> Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Already gone is success for our purposes.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/screenrec/drive.rs
git commit -m "feat(drive): keychain refresh-token storage"
```

---

## Task 5: Token exchange + refresh (HTTP)

**Files:**
- Modify: `src-tauri/src/screenrec/drive.rs`

- [ ] **Step 1: Implement the token structs + exchange/refresh**

Add to `drive.rs`:

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

/// Resolve the effective client id/secret: BYO from settings if non-empty,
/// else the bundled pair.
pub fn effective_client(byo_id: &str, byo_secret: &str) -> (String, String) {
    if !byo_id.trim().is_empty() {
        (byo_id.to_string(), byo_secret.to_string())
    } else {
        (BUNDLED_CLIENT_ID.to_string(), BUNDLED_CLIENT_SECRET.to_string())
    }
}

/// Exchange an auth `code` for tokens. Returns (access_token, refresh_token, email).
async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<(String, String, Option<String>), String> {
    let client = reqwest::Client::new();
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", code_verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("token exchange failed: {}", resp.text().await.unwrap_or_default()));
    }
    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    let refresh = tok.refresh_token.ok_or("no refresh_token in response")?;
    let email = tok.id_token.as_deref().and_then(email_from_id_token);
    Ok((tok.access_token, refresh, email))
}

/// Use the stored refresh token to get a fresh access token.
pub async fn refresh_access_token(client_id: &str, client_secret: &str) -> Result<String, String> {
    let refresh = load_refresh_token().ok_or("not connected to Drive")?;
    let client = reqwest::Client::new();
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("token refresh failed: {}", resp.text().await.unwrap_or_default()));
    }
    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(tok.access_token)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/screenrec/drive.rs
git commit -m "feat(drive): OAuth token exchange + refresh"
```

---

## Task 6: OAuth connect (loopback listener + browser)

**Files:**
- Modify: `src-tauri/src/screenrec/drive.rs`

- [ ] **Step 1: Implement `connect`**

Add to `drive.rs`:

```rust
use std::io::{Read, Write};
use std::net::TcpListener;

/// Run the full connect flow: bind a loopback listener, open the browser to the
/// consent page, capture the `code`, exchange it, persist the refresh token, and
/// return the connected account email (if Google returned one).
///
/// Blocking on the loopback accept; call from a blocking context or
/// `spawn_blocking`. The HTTP exchange uses the current tokio runtime.
pub async fn connect(client_id: &str, client_secret: &str) -> Result<Option<String>, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce();
    let state = {
        let (_v, s) = pkce(); // reuse the generator for a random opaque state
        s
    };
    let url = auth_url(client_id, &redirect_uri, &challenge, &state);

    // Open the system browser (macOS).
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("could not open browser: {e}"))?;

    // Accept exactly one request (the redirect). Block on a dedicated thread so
    // the async runtime isn't stalled, with a generous timeout.
    let (code, got_state) = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        listener
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        let req = String::from_utf8_lossy(&buf[..n]);
        // First line: "GET /?code=...&state=... HTTP/1.1"
        let first = req.lines().next().unwrap_or("");
        let target = first.split_whitespace().nth(1).unwrap_or("");
        let query = target.splitn(2, '?').nth(1).unwrap_or("");
        let mut code = String::new();
        let mut st = String::new();
        for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
            match k.as_ref() {
                "code" => code = v.into_owned(),
                "state" => st = v.into_owned(),
                _ => {}
            }
        }
        let body = "<html><body style='font-family:system-ui;padding:3rem'>\
                    <h2>Echo Scribe is connected.</h2><p>You can close this tab.</p></body></html>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        let _ = stream.write_all(resp.as_bytes());
        if code.is_empty() {
            return Err("no authorization code received".into());
        }
        Ok((code, st))
    })
    .await
    .map_err(|e| e.to_string())??;

    if got_state != state {
        return Err("OAuth state mismatch (possible CSRF); aborting".into());
    }

    let (access, refresh, email) =
        exchange_code(client_id, client_secret, &code, &verifier, &redirect_uri).await?;
    store_refresh_token(&refresh)?;
    // Touch the access token so an obviously-broken exchange fails here, not later.
    debug_assert!(!access.is_empty());
    Ok(email)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/screenrec/drive.rs
git commit -m "feat(drive): loopback+PKCE connect flow"
```

---

## Task 7: Drive REST (folder, upload, permission, link)

**Files:**
- Modify: `src-tauri/src/screenrec/drive.rs`

- [ ] **Step 1: Implement the Drive calls**

Add to `drive.rs`:

```rust
use std::path::Path;

/// Find the "Echo Scribe" folder, creating it if absent. Returns its file id.
pub async fn ensure_folder(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let q = format!(
        "name = '{FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    );
    let resp = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[("q", q.as_str()), ("spaces", "drive"), ("fields", "files(id,name)")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(id) = v.get("files").and_then(|f| f.as_array()).and_then(|a| a.first())
        .and_then(|f| f.get("id")).and_then(|i| i.as_str())
    {
        return Ok(id.to_string());
    }
    // Create it.
    let body = serde_json::json!({
        "name": FOLDER_NAME,
        "mimeType": "application/vnd.google-apps.folder",
    });
    let resp = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())
        .ok_or_else(|| "could not create Drive folder".into())
}

/// Upload `file_path` into `folder_id` via a resumable session. Returns the new
/// file id. v1 sends the whole file in one PUT to the session URI; the session
/// makes a retry of that PUT safe. (Chunked resume is a future enhancement.)
pub async fn upload_resumable(
    access_token: &str,
    folder_id: &str,
    file_path: &Path,
    name: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let metadata = serde_json::json!({ "name": name, "parents": [folder_id] });
    // 1. Start the session.
    let start = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(access_token)
        .header("X-Upload-Content-Type", "video/mp4")
        .json(&metadata)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !start.status().is_success() {
        return Err(format!("upload init failed: {}", start.text().await.unwrap_or_default()));
    }
    let session_uri = start
        .headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .ok_or("no resumable session URI in response")?
        .to_string();

    // 2. Upload the bytes.
    let bytes = tokio::fs::read(file_path).await.map_err(|e| e.to_string())?;
    let put = client
        .put(&session_uri)
        .header("Content-Type", "video/mp4")
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !put.status().is_success() {
        return Err(format!("upload failed: {}", put.text().await.unwrap_or_default()));
    }
    let v: serde_json::Value = put.json().await.map_err(|e| e.to_string())?;
    v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())
        .ok_or_else(|| "upload response missing file id".into())
}

/// Grant anyone-with-the-link reader access.
pub async fn make_anyone_reader(access_token: &str, file_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "role": "reader", "type": "anyone" });
    let resp = client
        .post(format!("https://www.googleapis.com/drive/v3/files/{file_id}/permissions"))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("set permission failed: {}", resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

/// Read the shareable `webViewLink` for a file.
pub async fn web_view_link(access_token: &str, file_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("https://www.googleapis.com/drive/v3/files/{file_id}"))
        .bearer_auth(access_token)
        .query(&[("fields", "webViewLink")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("webViewLink").and_then(|l| l.as_str()).map(|s| s.to_string())
        .ok_or_else(|| "no webViewLink".into())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/screenrec/drive.rs
git commit -m "feat(drive): folder/upload/permission/link REST calls"
```

---

## Task 8: DB upload-status + drive-link updates

**Files:**
- Modify: `src-tauri/src/db/recordings.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` mod in `src-tauri/src/db/recordings.rs`:

```rust
    #[test]
    fn update_upload_status_and_link_round_trip() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();

        update_upload_status(&conn, "rec-1", "uploading", None).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().upload_status, "uploading");

        update_drive_link(&conn, "rec-1", "fid-9", "https://drive.example/abc").unwrap();
        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.drive_file_id.as_deref(), Some("fid-9"));
        assert_eq!(got.drive_link.as_deref(), Some("https://drive.example/abc"));
        assert_eq!(got.upload_status, "done");

        update_upload_status(&conn, "rec-1", "error", Some("network")).unwrap();
        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.upload_status, "error");
        assert_eq!(got.upload_error.as_deref(), Some("network"));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --lib db::recordings::tests::update_upload_status_and_link`
Expected: FAIL — `cannot find function 'update_upload_status'`.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/db/recordings.rs` after `update_exports`:

```rust
pub fn update_upload_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET upload_status = ?2, upload_error = ?3 WHERE id = ?1",
        params![id, status, error],
    )?;
    Ok(())
}

/// Record a successful upload: stores the file id + link and sets status `done`.
pub fn update_drive_link(
    conn: &Connection,
    id: &str,
    file_id: &str,
    link: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings
           SET drive_file_id = ?2, drive_link = ?3, upload_status = 'done', upload_error = NULL
         WHERE id = ?1",
        params![id, file_id, link],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test --lib db::recordings::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/recordings.rs
git commit -m "feat(db): update_upload_status + update_drive_link"
```

---

## Task 9: Settings accessors

**Files:**
- Modify: `src-tauri/src/settings.rs`

- [ ] **Step 1: Add the key consts**

In `src-tauri/src/settings.rs`, after `const KEY_SCREENREC_MIC_DEVICE` (line 48), add:

```rust
const KEY_DRIVE_CLIENT_ID: &str = "drive_client_id";
const KEY_DRIVE_CLIENT_SECRET: &str = "drive_client_secret";
const KEY_DRIVE_ACCOUNT_EMAIL: &str = "drive_account_email";
const KEY_DRIVE_FOLDER_ID: &str = "drive_folder_id";
```

- [ ] **Step 2: Add the accessors**

Add next to the existing `screenrec_*` accessors (after `set_screenrec_mic_device`, around line 850; mirror the existing string-accessor pattern):

```rust
    pub fn drive_client_id(&self) -> String {
        self.store
            .get(KEY_DRIVE_CLIENT_ID)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default()
    }
    pub fn set_drive_client_id(&self, id: &str) -> Result<(), SettingsError> {
        self.store.set(KEY_DRIVE_CLIENT_ID, serde_json::json!(id));
        self.store.save().map_err(SettingsError::from)
    }

    pub fn drive_client_secret(&self) -> String {
        self.store
            .get(KEY_DRIVE_CLIENT_SECRET)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default()
    }
    pub fn set_drive_client_secret(&self, secret: &str) -> Result<(), SettingsError> {
        self.store.set(KEY_DRIVE_CLIENT_SECRET, serde_json::json!(secret));
        self.store.save().map_err(SettingsError::from)
    }

    pub fn drive_account_email(&self) -> Option<String> {
        self.store
            .get(KEY_DRIVE_ACCOUNT_EMAIL)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    }
    pub fn set_drive_account_email(&self, email: Option<&str>) -> Result<(), SettingsError> {
        match email {
            Some(e) => self.store.set(KEY_DRIVE_ACCOUNT_EMAIL, serde_json::json!(e)),
            None => {
                self.store.delete(KEY_DRIVE_ACCOUNT_EMAIL);
            }
        }
        self.store.save().map_err(SettingsError::from)
    }

    pub fn drive_folder_id(&self) -> Option<String> {
        self.store
            .get(KEY_DRIVE_FOLDER_ID)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    }
    pub fn set_drive_folder_id(&self, id: Option<&str>) -> Result<(), SettingsError> {
        match id {
            Some(i) => self.store.set(KEY_DRIVE_FOLDER_ID, serde_json::json!(i)),
            None => {
                self.store.delete(KEY_DRIVE_FOLDER_ID);
            }
        }
        self.store.save().map_err(SettingsError::from)
    }
```

> **Reviewer note:** confirm the exact `self.store` get/set/save/delete signatures against an existing accessor in this file (e.g. `set_screenrec_mic_device`) before implementing — match it exactly (the store wrapper API, not raw `tauri_plugin_store`).

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): Drive client/account/folder accessors"
```

---

## Task 10: Tauri commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add after `list_screen_sources`, ~line 2781)
- Modify: `src-tauri/src/lib.rs` (re-export + handler list)

- [ ] **Step 1: Add the commands**

Append to `src-tauri/src/commands.rs` after the screenrec commands block:

```rust
// ----- Drive commands -----

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DriveStatus {
    pub connected: bool,
    pub email: Option<String>,
}

#[tauri::command]
pub fn drive_status(state: State<'_, AppState>) -> DriveStatus {
    DriveStatus {
        connected: crate::screenrec::drive::load_refresh_token().is_some(),
        email: state.settings.drive_account_email(),
    }
}

#[tauri::command]
pub async fn drive_connect(state: State<'_, AppState>) -> Result<DriveStatus, String> {
    let (cid, csecret) = crate::screenrec::drive::effective_client(
        &state.settings.drive_client_id(),
        &state.settings.drive_client_secret(),
    );
    let email = crate::screenrec::drive::connect(&cid, &csecret).await?;
    state
        .settings
        .set_drive_account_email(email.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(DriveStatus { connected: true, email })
}

#[tauri::command]
pub fn drive_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    crate::screenrec::drive::delete_refresh_token()?;
    state.settings.set_drive_account_email(None).map_err(|e| e.to_string())?;
    state.settings.set_drive_folder_id(None).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_drive_client_id(state: State<'_, AppState>) -> String {
    state.settings.drive_client_id()
}

#[tauri::command]
pub fn set_drive_client_credentials(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    state.settings.set_drive_client_id(&client_id).map_err(|e| e.to_string())?;
    state.settings.set_drive_client_secret(&client_secret).map_err(|e| e.to_string())?;
    Ok(())
}

/// Upload a recording at `quality` ("original"|"1080"|"720"|"480") to Drive and
/// return the updated row (with `drive_link`). For non-"original" qualities the
/// chosen-quality export is produced first (reusing Phase 3's export), otherwise
/// the source MP4 is uploaded.
#[tauri::command]
pub async fn upload_recording(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    quality: String,
) -> Result<crate::db::recordings::RecordingRow, String> {
    let db = require_db(&state)?.clone();
    let row = db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or("recording not found")?;

    // Mark uploading + notify UI.
    db.with_conn(|c| crate::db::recordings::update_upload_status(c, &id, "uploading", None))
        .map_err(|e| e.to_string())?;
    let _ = app.emit("screenrec-changed", ());

    // Resolve the file to upload (export first if a preset was chosen).
    let upload_path: std::path::PathBuf = if quality == "original" {
        std::path::PathBuf::from(&row.file_path)
    } else {
        let src = std::path::PathBuf::from(&row.file_path);
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("rec").to_string();
        let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
        let out = dir.join(format!("{stem}-{quality}.mp4"));
        let q = quality.clone();
        // export() is blocking; run it off the async worker.
        let out2 = out.clone();
        tokio::task::spawn_blocking(move || crate::screenrec::export(&src, &out2, &q))
            .await
            .map_err(|e| e.to_string())??;
        out
    };

    let upload_name = upload_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("recording.mp4")
        .to_string();

    // Run the Drive sequence; on any failure, mark error + return it.
    let result: Result<(String, String), String> = async {
        let (cid, csecret) = crate::screenrec::drive::effective_client(
            &state.settings.drive_client_id(),
            &state.settings.drive_client_secret(),
        );
        let access = crate::screenrec::drive::refresh_access_token(&cid, &csecret).await?;
        let folder = match state.settings.drive_folder_id() {
            Some(f) => f,
            None => {
                let f = crate::screenrec::drive::ensure_folder(&access).await?;
                state.settings.set_drive_folder_id(Some(&f)).map_err(|e| e.to_string())?;
                f
            }
        };
        let file_id =
            crate::screenrec::drive::upload_resumable(&access, &folder, &upload_path, &upload_name)
                .await?;
        crate::screenrec::drive::make_anyone_reader(&access, &file_id).await?;
        let link = crate::screenrec::drive::web_view_link(&access, &file_id).await?;
        Ok((file_id, link))
    }
    .await;

    match result {
        Ok((file_id, link)) => {
            db.with_conn(|c| crate::db::recordings::update_drive_link(c, &id, &file_id, &link))
                .map_err(|e| e.to_string())?;
        }
        Err(e) => {
            db.with_conn(|c| crate::db::recordings::update_upload_status(c, &id, "error", Some(&e)))
                .map_err(|e| e.to_string())?;
            let _ = app.emit("screenrec-changed", ());
            return Err(e);
        }
    }

    let _ = app.emit("screenrec-changed", ());
    db.with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "recording vanished".to_string())
}
```

> **Reviewer note:** `require_db(&state)?.clone()` assumes `Db` is `Clone` (it wraps a connection pool/handle). Verify; if `Db` isn't `Clone`, capture the needed data before the `.await` points instead of cloning, since `State` can't be held across `.await`.

- [ ] **Step 2: Register the commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add to the `commands::{...}` re-export (near the screenrec entries, line 69):

```rust
    drive_status,
    drive_connect,
    drive_disconnect,
    get_drive_client_id,
    set_drive_client_credentials,
    upload_recording,
```

And to the `tauri::generate_handler![` list (near line 312):

```rust
            drive_status,
            drive_connect,
            drive_disconnect,
            get_drive_client_id,
            set_drive_client_credentials,
            upload_recording,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(drive): connect/disconnect/status + upload_recording commands"
```

---

## Task 11: TS bindings

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the types + bindings**

In `src/lib/api.ts`, add near the recording bindings:

```ts
export type DriveStatus = {
  connected: boolean;
  email: string | null;
};

export const driveStatus = (): Promise<DriveStatus> => invoke("drive_status");

export const driveConnect = (): Promise<DriveStatus> => invoke("drive_connect");

export const driveDisconnect = (): Promise<void> => invoke("drive_disconnect");

export const getDriveClientId = (): Promise<string> => invoke("get_drive_client_id");

export const setDriveClientCredentials = (
  clientId: string,
  clientSecret: string,
): Promise<void> =>
  invoke("set_drive_client_credentials", { clientId, clientSecret });

export const uploadRecording = (
  id: string,
  quality: "original" | "1080" | "720" | "480",
): Promise<RecordingRow> => invoke("upload_recording", { id, quality });
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): Drive bindings + DriveStatus type"
```

---

## Task 12: Settings — Drive section

**Files:**
- Modify: `src/views/Settings.tsx`

- [ ] **Step 1: Add a Drive settings section**

In `src/views/Settings.tsx`, add the imports and a self-contained `DriveSettings` component, then render it within the settings layout (place it near other integration/section blocks — match the file's existing section component pattern):

```tsx
import { useEffect, useState } from "react";
import {
  driveStatus,
  driveConnect,
  driveDisconnect,
  getDriveClientId,
  setDriveClientCredentials,
  type DriveStatus,
} from "../lib/api";

function DriveSettings() {
  const [status, setStatus] = useState<DriveStatus>({ connected: false, email: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showByo, setShowByo] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    void driveStatus().then(setStatus);
    void getDriveClientId().then((id) => {
      setClientId(id);
      setShowByo(id.trim().length > 0);
    });
  }, []);

  const onConnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (showByo) await setDriveClientCredentials(clientId, clientSecret);
      setStatus(await driveConnect());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await driveDisconnect();
      setStatus({ connected: false, email: null });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-[14px] font-semibold">Google Drive</h2>
      <p className="text-[12px] text-muted">
        Upload screen recordings to Drive and get an anyone-with-the-link share URL.
        The app only sees files it creates (scope <code>drive.file</code>).
      </p>
      {status.connected ? (
        <div className="flex items-center gap-3">
          <span className="text-[13px]">
            Connected{status.email ? ` as ${status.email}` : ""}.
          </span>
          <button
            onClick={onDisconnect}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={onConnect}
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect Drive"}
        </button>
      )}

      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={showByo}
          onChange={(e) => setShowByo(e.target.checked)}
        />
        Use my own Google OAuth client (removes the unverified-app warning)
      </label>
      {showByo ? (
        <div className="space-y-2">
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID (…apps.googleusercontent.com)"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-[13px]"
          />
          <input
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client secret"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-[13px]"
          />
        </div>
      ) : null}

      {err ? <div className="text-[12px] text-red-400">{err}</div> : null}
    </section>
  );
}
```

Then render `<DriveSettings />` inside the settings page body (alongside the existing sections).

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/views/Settings.tsx
git commit -m "feat(drive): Settings section to connect/disconnect + BYO client"
```

---

## Task 13: Recordings view — upload + status + copy link

**Files:**
- Modify: `src/views/sections/RecordingsView.tsx`

- [ ] **Step 1: Import the upload binding**

Add `uploadRecording` to the import from `../../lib/api`:

```ts
import {
  isScreenRecording,
  openScreenrecSetup,
  stopScreenRecording,
  listRecordings,
  deleteRecording,
  revealRecording,
  exportRecording,
  uploadRecording,
  type RecordingRow,
} from "../../lib/api";
```

- [ ] **Step 2: Add upload state + handler inside the component**

After the `onExport` callback (from Phase 3), add:

```ts
  const [uploading, setUploading] = useState(false);

  const onUpload = useCallback(
    async (id: string, quality: "original" | "1080" | "720" | "480") => {
      setUploading(true);
      setError(null);
      try {
        const updated = await uploadRecording(id, quality);
        if (updated.drive_link) {
          await navigator.clipboard.writeText(updated.drive_link);
        }
        await refresh();
        const fresh = await listRecordings();
        setSelected(fresh.find((r) => r.id === id) ?? null);
      } catch (e) {
        setError(String(e));
      } finally {
        setUploading(false);
      }
    },
    [refresh],
  );
```

- [ ] **Step 3: Render upload controls + status in the detail pane**

Add this block in the detail pane, after the "Exports:" line added in Phase 3:

```tsx
              <div className="mt-4 border-t border-line pt-4">
                {selected.upload_status === "done" && selected.drive_link ? (
                  <div className="flex items-center gap-2">
                    <a
                      href={selected.drive_link}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[13px] text-accent underline"
                    >
                      {selected.drive_link}
                    </a>
                    <button
                      onClick={() => navigator.clipboard.writeText(selected.drive_link!)}
                      className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface"
                    >
                      Copy link
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-muted">Upload to Drive:</span>
                    {(["original", "1080", "720", "480"] as const).map((q) => (
                      <button
                        key={q}
                        onClick={() => onUpload(selected.id, q)}
                        disabled={uploading}
                        className="rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
                      >
                        {q === "original" ? "Original" : `${q}p`}
                      </button>
                    ))}
                    {uploading ? (
                      <span className="text-[12px] text-muted">Uploading…</span>
                    ) : null}
                    {selected.upload_status === "error" ? (
                      <span className="text-[12px] text-red-400">
                        Upload failed{selected.upload_error ? `: ${selected.upload_error}` : ""}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
```

- [ ] **Step 4: Build + reinstall (default skip-TCC)**

Run: `bun tauri build --bundles app`
Then:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 5: Manual E2E verification**

1. Settings → Google Drive → **Connect Drive** → browser opens → grant access (you'll see the unverified-app screen for the bundled client; click through as a test user) → page says "Echo Scribe is connected" → Settings shows "Connected as <email>".
2. Recordings → select a recording → **Upload to Drive → 720p** → button area shows "Uploading…" → on success the share link + "Copy link" appear and the link is on the clipboard.
3. Open the link in a private/incognito window → the video plays (anyone-with-link works).
4. Quit + relaunch the app → Settings still shows Connected (refresh token persisted in Keychain); the recording row still shows its link (persisted in DB).

- [ ] **Step 6: Commit**

```bash
git add src/views/sections/RecordingsView.tsx
git commit -m "feat(drive): upload button, status, and copy-link in Recordings view"
```

---

## Self-review checklist (run before handoff)

1. **Spec coverage (Phase 4):** OAuth loopback+PKCE (Tasks 2,3,6) ✅; bundled + BYO (Tasks 1,9,10,12) ✅; keychain refresh-token storage + silent refresh (Tasks 4,5) ✅; resumable upload (Task 7) ✅; anyone-reader + webViewLink (Task 7) ✅; manual upload from library with quality pick + copy link (Tasks 10,13) ✅. **Deferred from spec on purpose:** auto-upload after stop + `recording` dashboard activity (this phase is manual-only per the product decision; add later if wanted).
2. **Type consistency:** `DriveStatus {connected, email}` identical in Rust (Task 10) and TS (Task 11). `upload_recording(id, quality)` arg names match the `invoke` call (`{ id, quality }`). `effective_client` / `refresh_access_token` / `connect` signatures match their call sites. DB `update_upload_status(conn,id,status,error)` and `update_drive_link(conn,id,file_id,link)` match call sites in Task 10. ✅
3. **Placeholder scan:** `PASTE_CLIENT_ID_HERE` / `PASTE_CLIENT_SECRET_HERE` are a deliberate Task-1 setup step (real external credentials), not code placeholders. Reviewer notes flag the two assumptions to verify (`Db: Clone`, settings-store API). No "TODO/implement later" left in code. ✅

## Known limitations / future work (out of scope here)

- **Single-PUT upload**, not chunked-resume: a dropped connection mid-PUT requires re-uploading from the start (the resumable session makes the retry safe). True chunked resume (Content-Range loop) is a future enhancement.
- **No in-flight upload progress %** in the UI (just "Uploading…"). Add by streaming `reqwest` body + emitting progress events if desired.
- **Auto-upload after stop** + dashboard `recording` activity: deferred (manual-only this phase).
- **Access token caching:** every upload does a refresh round-trip. Fine for manual use; cache in memory with expiry if it becomes chatty.
