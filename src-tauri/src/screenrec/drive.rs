//! Google Drive integration for screen recordings: OAuth (loopback + PKCE),
//! refresh-token storage in the macOS Keychain, resumable upload, anyone-reader
//! share link. Scope is `drive.file` (app only sees files it created).

// Bundled OAuth client (Google "Desktop app" type). The secret is non-confidential
// for installed apps. Empty / placeholder = configure before release or use BYO.
pub const BUNDLED_CLIENT_ID: &str = "PASTE_CLIENT_ID_HERE.apps.googleusercontent.com";
pub const BUNDLED_CLIENT_SECRET: &str = "PASTE_CLIENT_SECRET_HERE";

// AUTH_ENDPOINT and SCOPE are now used by auth_url(); no dead_code allow needed.
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
#[allow(dead_code)]
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
// SCOPE is used by auth_url(); no dead_code allow needed.
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file openid email";
#[allow(dead_code)]
const FOLDER_NAME: &str = "Echo Scribe";

#[allow(dead_code)]
const KEYCHAIN_SERVICE: &str = "com.echoscribe.app";
#[allow(dead_code)]
const KEYCHAIN_ACCOUNT: &str = "google_drive_refresh_token";

use base64::Engine;
use sha2::{Digest, Sha256};

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
    fn email_from_id_token_decodes_payload() {
        use base64::Engine;
        let payload = r#"{"email":"x@y.com","email_verified":true}"#;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let jwt = format!("header.{b64}.sig");
        assert_eq!(email_from_id_token(&jwt).as_deref(), Some("x@y.com"));
        assert_eq!(email_from_id_token("garbage"), None);
    }
}
