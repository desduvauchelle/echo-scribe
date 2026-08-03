//! Google Drive integration for screen recordings: OAuth (loopback + PKCE),
//! refresh-token storage in the macOS Keychain, resumable upload, anyone-reader
//! share link. Scope is `drive.file` (app only sees files it created).

// Bundled OAuth client (Google "Desktop app" type). The secret is non-confidential
// for installed apps. Empty / placeholder = configure before release or use BYO.
pub const BUNDLED_CLIENT_ID: &str = "PASTE_CLIENT_ID_HERE.apps.googleusercontent.com";
pub const BUNDLED_CLIENT_SECRET: &str = "PASTE_CLIENT_SECRET_HERE";

// AUTH_ENDPOINT and SCOPE are now used by auth_url(); no dead_code allow needed.
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
// SCOPE is used by auth_url(); no dead_code allow needed.
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file openid email";
/// The one scope uploads actually need. Google's consent screen shows it as its
/// own checkbox (granular consent), and *unticking it still yields a valid
/// token* — one that carries `openid email` only. Every `files.create` then
/// fails 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` while the app looks connected,
/// so we verify this scope was actually granted instead of trusting consent.
const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

const KEYCHAIN_SERVICE: &str = "com.echoscribe.app";
const KEYCHAIN_ACCOUNT: &str = "google_drive_refresh_token";

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;

use base64::Engine;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// Generate a PKCE `(code_verifier, code_challenge)` pair (S256).
/// The verifier is two concatenated UUIDv4s (64 hex chars — unreserved per
/// RFC 7636, within the 43-128 range) drawn from the OS CSPRNG via `uuid`'s
/// getrandom backend, so it's unpredictable to a network attacker. The
/// challenge is base64url(sha256(verifier)), no padding.
pub fn pkce() -> (String, String) {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// A random opaque value for the OAuth `state` parameter (CSRF guard).
pub fn random_state() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

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

use serde::Deserialize;

#[cfg(target_os = "macos")]
fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

/// Store (or replace) the long-lived refresh token in the macOS Keychain.
#[cfg(target_os = "macos")]
pub fn store_refresh_token(token: &str) -> Result<(), String> {
    match keychain_entry()?.set_password(token) {
        Ok(()) => {
            info!(target: "drive", chars = token.len(), "stored Drive refresh token in keychain");
            Ok(())
        }
        Err(e) => {
            warn!(target: "drive", error = %e, "failed to store Drive refresh token");
            Err(e.to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn store_refresh_token(_token: &str) -> Result<(), String> {
    Err("Google Drive credential storage is not supported on this platform".to_string())
}

/// Load the refresh token, or `None` if not connected.
#[cfg(target_os = "macos")]
pub fn load_refresh_token() -> Option<String> {
    let entry = match keychain_entry() {
        Ok(e) => e,
        Err(e) => {
            warn!(target: "drive", error = %e, "keychain entry init failed on load");
            return None;
        }
    };
    match entry.get_password() {
        Ok(t) => {
            info!(target: "drive", chars = t.len(), "loaded Drive refresh token from keychain");
            Some(t)
        }
        Err(e) => {
            warn!(target: "drive", error = %e, "no Drive refresh token in keychain");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn load_refresh_token() -> Option<String> {
    None
}

/// Delete the refresh token (disconnect). Already-absent is treated as success.
#[cfg(target_os = "macos")]
pub fn delete_refresh_token() -> Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) => {
            info!(target: "drive", "deleted Drive refresh token from keychain");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            warn!(target: "drive", error = %e, "failed to delete Drive refresh token");
            Err(e.to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn delete_refresh_token() -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    /// Space-separated list of the scopes Google actually granted, which can be
    /// a strict subset of what we asked for. Absent on some responses — treated
    /// as "unknown", never as "missing".
    #[serde(default)]
    scope: Option<String>,
}

/// True when a space-separated `scope` string from Google's token endpoint
/// includes the Drive scope uploads need. Exact-token match, so a lookalike
/// scope (`drive.file.readonly`, `drive.appdata`) doesn't pass.
pub fn grants_drive_file(scope: &str) -> bool {
    scope.split_whitespace().any(|s| s == DRIVE_FILE_SCOPE)
}

/// Whether a token response's granted scopes are usable for uploads.
/// `None` (Google didn't tell us) is optimistic — we let the API be the judge
/// rather than deleting a token that may be fine.
fn scope_is_usable(scope: Option<&str>) -> bool {
    match scope {
        Some(s) => grants_drive_file(s),
        None => true,
    }
}

/// Resolve the effective client id/secret: BYO from settings if non-empty,
/// else the bundled pair.
pub fn effective_client(byo_id: &str, byo_secret: &str) -> (String, String) {
    if !byo_id.trim().is_empty() {
        (byo_id.to_string(), byo_secret.to_string())
    } else {
        (
            BUNDLED_CLIENT_ID.to_string(),
            BUNDLED_CLIENT_SECRET.to_string(),
        )
    }
}

/// A successful authorization-code exchange.
pub struct Exchanged {
    pub access_token: String,
    pub refresh_token: String,
    pub email: Option<String>,
    /// Space-separated scopes Google granted, when it reported them.
    pub granted_scope: Option<String>,
}

/// Exchange an auth `code` for tokens.
pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<Exchanged, String> {
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
        return Err(format!(
            "token exchange failed: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    let refresh = tok.refresh_token.ok_or("no refresh_token in response")?;
    let email = tok.id_token.as_deref().and_then(email_from_id_token);
    // Scopes are not secret and are the single most useful thing to see when an
    // upload 403s later.
    info!(
        target: "drive",
        granted_scope = tok.scope.as_deref().unwrap_or("(not reported)"),
        "exchanged auth code for tokens"
    );
    Ok(Exchanged {
        access_token: tok.access_token,
        refresh_token: refresh,
        email,
        granted_scope: tok.scope,
    })
}

/// Use the stored refresh token to get a fresh access token.
pub async fn refresh_access_token(client_id: &str, client_secret: &str) -> Result<String, String> {
    let Some(refresh) = load_refresh_token() else {
        warn!(
            target: "drive",
            "refresh_access_token: no refresh token in keychain (treated as not connected)"
        );
        return Err("not connected to Drive".into());
    };
    info!(target: "drive", "refreshing Drive access token");
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
        let body = resp.text().await.unwrap_or_default();
        warn!(target: "drive", body = %body, "Drive token refresh failed");
        // `invalid_grant` means Google revoked/expired the refresh token itself
        // (password change, access revoked in the Google account, server-side
        // expiry). It will never work again — drop it so the UI flips to
        // "not connected" and offers the Connect button.
        if body.contains("invalid_grant") {
            clear_unusable_token("revoked by Google (invalid_grant)");
            return Err(RECONNECT_REQUIRED.into());
        }
        return Err(format!("token refresh failed: {body}"));
    }
    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    info!(
        target: "drive",
        granted_scope = tok.scope.as_deref().unwrap_or("(not reported)"),
        "refreshed Drive access token"
    );
    // A token can refresh perfectly well and still be useless: if the Drive
    // checkbox wasn't ticked at consent, this grant is `openid email` forever.
    // Catch it here so the failure names itself instead of surfacing later as a
    // 403 from files.create.
    if !scope_is_usable(tok.scope.as_deref()) {
        warn!(
            target: "drive",
            granted_scope = tok.scope.as_deref().unwrap_or(""),
            "Drive grant is missing the drive.file scope; upload cannot work"
        );
        clear_unusable_token("granted without the drive.file scope");
        return Err(SCOPE_MISSING.into());
    }
    Ok(tok.access_token)
}

/// Drop the stored refresh token because Google will never accept it for
/// uploads. Logs the reason either way; an already-absent token is success.
pub fn clear_unusable_token(why: &str) {
    match delete_refresh_token() {
        Ok(()) => info!(target: "drive", why, "cleared unusable refresh token; reconnect required"),
        Err(e) => warn!(target: "drive", error = %e, why, "failed to clear unusable refresh token"),
    }
}

/// Sentinel error returned when Google permanently rejected the refresh token
/// (`invalid_grant`) and the user must run the Connect flow again. Callers
/// match on this to show a reconnect-specific message instead of a generic
/// upload failure.
pub const RECONNECT_REQUIRED: &str = "drive_reconnect_required";

/// Sentinel returned when the grant itself is intact but carries no Drive
/// scope — the consent screen's Drive checkbox was left unticked, so Google
/// issues a working `openid email` token that 403s on every `files.create`.
/// Distinct from [`RECONNECT_REQUIRED`] because the user must do something
/// extra on the consent page, not just reconnect.
pub const SCOPE_MISSING: &str = "drive_scope_missing";

/// True when a Drive API error body is Google's "your token lacks the scope"
/// rejection, as opposed to any other 403 (quota, file-level permission).
pub fn is_scope_error(body: &str) -> bool {
    body.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
        || body.contains("insufficient authentication scopes")
}

/// Run the full connect flow: bind a loopback listener, open the browser to the
/// consent page, capture the `code`, exchange it, persist the refresh token, and
/// return the connected account email (if Google returned one).
///
/// The loopback accept runs on a blocking task; the HTTP exchange uses the
/// current tokio runtime.
pub async fn connect(client_id: &str, client_secret: &str) -> Result<Option<String>, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce();
    let state = random_state();
    let url = auth_url(client_id, &redirect_uri, &challenge, &state);

    // Open the system browser (macOS).
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("could not open browser: {e}"))?;

    // Accept exactly one request (the redirect) on a blocking task so the async
    // runtime isn't stalled.
    let expected_state = state.clone();
    let (code, got_state) =
        tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_secs(180);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return Err(
                                "Drive connection timed out (no response from browser)".into(),
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(e) => return Err(e.to_string()),
                }
            };
            stream.set_nonblocking(false).ok();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).ok();
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
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            if code.is_empty() {
                return Err("no authorization code received".into());
            }
            Ok((code, st))
        })
        .await
        .map_err(|e| e.to_string())??;

    if got_state != expected_state {
        return Err("OAuth state mismatch (possible CSRF); aborting".into());
    }

    let tokens = exchange_code(client_id, client_secret, &code, &verifier, &redirect_uri).await?;

    // Consent can succeed while granting nothing useful: Google's granular
    // consent lets the user clear the Drive checkbox and continue, and the
    // resulting token still carries `openid email` — enough to look connected,
    // never enough to upload. Reject it here rather than storing a token that
    // reports "Connected" and 403s on every upload. The previous (working)
    // token, if any, is deliberately left untouched.
    if !scope_is_usable(tokens.granted_scope.as_deref()) {
        warn!(
            target: "drive",
            granted_scope = tokens.granted_scope.as_deref().unwrap_or(""),
            "Drive consent completed without the drive.file scope; not storing token"
        );
        return Err(SCOPE_MISSING.into());
    }

    store_refresh_token(&tokens.refresh_token)?;
    info!(
        target: "drive",
        email = tokens.email.as_deref().unwrap_or("(unknown)"),
        granted_scope = tokens.granted_scope.as_deref().unwrap_or("(not reported)"),
        "Drive connect complete; refresh token persisted"
    );
    debug_assert!(!tokens.access_token.is_empty());
    Ok(tokens.email)
}

/// Find the `folder_name` folder, creating it if absent. Returns its file id.
pub async fn ensure_folder(access_token: &str, folder_name: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    // Escape single quotes for the Drive query string.
    let escaped = folder_name.replace('\'', "\\'");
    let q = format!(
        "name = '{escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    );
    let resp = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("q", q.as_str()),
            ("spaces", "drive"),
            ("fields", "files(id,name)"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if is_scope_error(&body) {
            return Err(format!("{SCOPE_MISSING}: Drive folder lookup failed: {body}"));
        }
        return Err(format!("Drive folder lookup failed: {body}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(id) = v
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("id"))
        .and_then(|i| i.as_str())
    {
        return Ok(id.to_string());
    }
    let body = serde_json::json!({
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
    });
    let resp = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if is_scope_error(&body) {
            return Err(format!("{SCOPE_MISSING}: Drive folder create failed: {body}"));
        }
        return Err(format!("Drive folder create failed: {body}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("id")
        .and_then(|i| i.as_str())
        .map(|s| s.to_string())
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
    let start = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(access_token)
        .header("X-Upload-Content-Type", "video/mp4")
        .json(&metadata)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !start.status().is_success() {
        let body = start.text().await.unwrap_or_default();
        // Tag the scope rejection so callers can offer "reconnect and tick the
        // Drive box" instead of a generic upload failure.
        if is_scope_error(&body) {
            return Err(format!("{SCOPE_MISSING}: upload init failed: {body}"));
        }
        return Err(format!("upload init failed: {body}"));
    }
    let session_uri = start
        .headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .ok_or("no resumable session URI in response")?
        .to_string();

    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| e.to_string())?;
    let put = client
        .put(&session_uri)
        .header("Content-Type", "video/mp4")
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !put.status().is_success() {
        return Err(format!(
            "upload failed: {}",
            put.text().await.unwrap_or_default()
        ));
    }
    let v: serde_json::Value = put.json().await.map_err(|e| e.to_string())?;
    v.get("id")
        .and_then(|i| i.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "upload response missing file id".into())
}

/// Grant anyone-with-the-link reader access.
pub async fn make_anyone_reader(access_token: &str, file_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "role": "reader", "type": "anyone" });
    let resp = client
        .post(format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}/permissions"
        ))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "set permission failed: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(())
}

/// Read the shareable `webViewLink` for a file.
pub async fn web_view_link(access_token: &str, file_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}"
        ))
        .bearer_auth(access_token)
        .query(&[("fields", "webViewLink")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "fetch share link failed: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("webViewLink")
        .and_then(|l| l.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no webViewLink".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let (verifier, challenge) = pkce();
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        let want = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, want);
    }

    #[test]
    fn pkce_is_unique_per_call() {
        let (v1, _) = pkce();
        let (v2, _) = pkce();
        assert_ne!(v1, v2);
    }

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
    fn requested_scope_includes_the_drive_scope_we_verify() {
        assert!(grants_drive_file(SCOPE));
    }

    #[test]
    fn granted_scope_detects_the_unticked_drive_checkbox() {
        // What Google returns when consent granted everything.
        assert!(grants_drive_file(
            "https://www.googleapis.com/auth/drive.file openid \
             https://www.googleapis.com/auth/userinfo.email"
        ));
        // What it returns when the Drive checkbox was left unticked — the exact
        // shape that produced 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT on upload.
        assert!(!grants_drive_file(
            "openid https://www.googleapis.com/auth/userinfo.email"
        ));
        assert!(!grants_drive_file(""));
        // Lookalikes must not pass as the real thing.
        assert!(!grants_drive_file(
            "https://www.googleapis.com/auth/drive.appdata"
        ));
        assert!(!grants_drive_file(
            "https://www.googleapis.com/auth/drive.file.readonly"
        ));
    }

    #[test]
    fn unreported_scope_is_not_treated_as_missing() {
        // Google omitting `scope` must never delete a working token.
        assert!(scope_is_usable(None));
        assert!(scope_is_usable(Some(SCOPE)));
        assert!(!scope_is_usable(Some("openid email")));
    }

    #[test]
    fn scope_errors_are_told_apart_from_other_403s() {
        assert!(is_scope_error(
            r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}"#
        ));
        // A quota / rate 403 is a different problem and must not trigger a
        // reconnect prompt or wipe the stored token.
        assert!(!is_scope_error(
            r#"{"error":{"code":403,"message":"The user has exceeded their Drive storage quota.","errors":[{"reason":"storageQuotaExceeded"}]}}"#
        ));
        assert!(!is_scope_error(r#"{"error":{"code":404}}"#));
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
}
