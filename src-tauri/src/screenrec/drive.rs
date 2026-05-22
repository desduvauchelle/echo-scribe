//! Google Drive integration for screen recordings: OAuth (loopback + PKCE),
//! refresh-token storage in the macOS Keychain, resumable upload, anyone-reader
//! share link. Scope is `drive.file` (app only sees files it created).

// Bundled OAuth client (Google "Desktop app" type). The secret is non-confidential
// for installed apps. Empty / placeholder = configure before release or use BYO.
pub const BUNDLED_CLIENT_ID: &str = "PASTE_CLIENT_ID_HERE.apps.googleusercontent.com";
pub const BUNDLED_CLIENT_SECRET: &str = "PASTE_CLIENT_SECRET_HERE";

#[allow(dead_code)]
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
#[allow(dead_code)]
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
#[allow(dead_code)]
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file openid email";
#[allow(dead_code)]
const FOLDER_NAME: &str = "Echo Scribe";

#[allow(dead_code)]
const KEYCHAIN_SERVICE: &str = "com.echoscribe.app";
#[allow(dead_code)]
const KEYCHAIN_ACCOUNT: &str = "google_drive_refresh_token";
