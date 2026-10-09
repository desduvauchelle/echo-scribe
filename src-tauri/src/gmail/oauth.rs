//! Google desktop OAuth: loopback + PKCE, state verification, per-account Keychain grants.
//! Uses the same installed-app approach as Drive and Tamias, without reusing their grants.
use super::api::{client, json_response, Gmail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const READ_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
pub const COMPOSE_SCOPE: &str = "https://www.googleapis.com/auth/gmail.compose";
const CONFIG_KEY: &str = "gmail_oauth_client";

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub client_id: String,
    pub client_secret: String,
}
#[derive(Serialize, Deserialize)]
struct Grant {
    config: Config,
    refresh_token: String,
}

fn read(key: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let entry = keyring::Entry::new(crate::bundle_id(), key)
            .map_err(|_| "Gmail Keychain is unavailable.".to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Could not read Gmail credentials from Keychain.".into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Err("Gmail account connections currently require macOS Keychain.".into())
    }
}
fn write(key: &str, value: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        keyring::Entry::new(crate::bundle_id(), key)
            .and_then(|e| e.set_password(value))
            .map_err(|_| "Could not save Gmail credentials in Keychain.".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (key, value);
        Err("Gmail account connections currently require macOS Keychain.".into())
    }
}
pub fn delete(id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match keyring::Entry::new(crate::bundle_id(), &format!("gmail_account_{id}"))
            .and_then(|e| e.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the Gmail credential from Keychain.".into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("Gmail account connections currently require macOS Keychain.".into())
    }
}
pub fn config() -> Result<Option<Config>, String> {
    read(CONFIG_KEY)?
        .map(|s| {
            serde_json::from_str(&s).map_err(|_| "Import the Gmail OAuth client again.".into())
        })
        .transpose()
}
pub fn parse_config(raw: &str) -> Result<Config, String> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|_| "Select Google's downloaded Desktop app OAuth JSON.".to_string())?;
    let installed = &v["installed"];
    let id = installed["client_id"].as_str().unwrap_or("").trim();
    let secret = installed["client_secret"].as_str().unwrap_or("").trim();
    if !id.ends_with(".apps.googleusercontent.com")
        || id.contains(char::is_whitespace)
        || id.len() > 300
        || secret.is_empty()
        || secret.len() > 300
    {
        return Err("This must be a Google Desktop app OAuth client, not Tamias's Web application client. Create a Desktop app client in the same Google project.".into());
    }
    // Endpoint overrides in downloaded/imported JSON are never trusted.
    Ok(Config {
        client_id: id.into(),
        client_secret: secret.into(),
    })
}
pub fn import(raw: &str) -> Result<(), String> {
    write(
        CONFIG_KEY,
        &serde_json::to_string(&parse_config(raw)?)
            .map_err(|_| "Could not encode OAuth client.".to_string())?,
    )
}
fn has_scopes(scope: &str) -> bool {
    let scopes = scope.split_whitespace().collect::<Vec<_>>();
    scopes.contains(&READ_SCOPE) && scopes.contains(&COMPOSE_SCOPE)
}
pub fn authorization_url(config: &Config, redirect: &str, challenge: &str, state: &str) -> String {
    let mut url =
        url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").expect("fixed URL");
    url.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", format!("{READ_SCOPE} {COMPOSE_SCOPE}").as_str()),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    url.to_string()
}
pub fn parse_callback(target: &str, state: &str) -> Result<String, String> {
    if !target.starts_with("/?") {
        return Err("Invalid OAuth callback.".into());
    }
    let pairs =
        url::form_urlencoded::parse(target.split_once('?').map(|p| p.1).unwrap_or("").as_bytes())
            .collect::<Vec<_>>();
    let values = |name: &str| {
        pairs
            .iter()
            .filter(|p| p.0 == name)
            .map(|p| p.1.to_string())
            .collect::<Vec<_>>()
    };
    if values("state") != vec![state.to_string()] {
        return Err("Google sign-in state did not match. Please connect again.".into());
    }
    if !values("error").is_empty() {
        return Err("Google sign-in was cancelled or denied.".into());
    }
    let codes = values("code");
    if codes.len() != 1 || codes[0].is_empty() {
        return Err("Google did not return a sign-in code.".into());
    }
    Ok(codes[0].clone())
}
pub async fn connect() -> Result<(String, String), String> {
    let config =
        config()?.ok_or("Import a Google Desktop app OAuth client in Settings → Gmail first.")?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not open the Google sign-in callback.".to_string())?;
    let redirect = format!(
        "http://127.0.0.1:{}/",
        listener
            .local_addr()
            .map_err(|_| "Could not read callback port.".to_string())?
            .port()
    );
    let (verifier, challenge) = crate::screenrec::drive::pkce();
    let state = uuid::Uuid::new_v4().to_string();
    let url = authorization_url(&config, &redirect, &challenge, &state);
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|_| "Could not open Google sign-in in your browser.".to_string())?;
    let code=tokio::task::spawn_blocking(move ||->Result<String,String> {
        listener.set_nonblocking(true).map_err(|_|"Callback unavailable.".to_string())?;
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(180);
        loop {
            if std::time::Instant::now()>deadline { return Err("Google sign-in timed out. Try connecting again.".into()); }
            let (mut stream,_)=match listener.accept() {
                Ok(v)=>v,
                Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(std::time::Duration::from_millis(100));continue;},
                Err(_)=>return Err("Could not receive Google sign-in.".into()),
            };
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).ok();
            stream.set_write_timeout(Some(std::time::Duration::from_secs(3))).ok();
            let mut bytes=[0;8192];
            let n=match stream.read(&mut bytes){Ok(n)=>n,Err(_)=>continue};
            let request=String::from_utf8_lossy(&bytes[..n]);
            let first=request.lines().next().unwrap_or("").split_whitespace().collect::<Vec<_>>();
            if first.first()!=Some(&"GET") {continue;}
            let result=parse_callback(first.get(1).copied().unwrap_or(""),&state);
            let text=if result.is_ok(){"Google sign-in received. Return to Tucky to finish connecting."}else{"This sign-in callback was not accepted. Return to Tucky or finish your original sign-in."};
            let status=if result.is_ok(){"200 OK"}else{"400 Bad Request"};
            let _=write!(stream,"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",text.len());
            // Unrelated localhost requests cannot consume the legitimate callback.
            if let Ok(code)=result { return Ok(code); }
            if first.get(1).is_some_and(|t|t.contains("error=") && t.contains(&state)) { return Err("Google sign-in was cancelled or denied.".into()); }
        }
    }).await.map_err(|_|"Google sign-in callback stopped.".to_string())??;
    let v = json_response(
        client()?
            .post(TOKEN_URL)
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|_| "Google token exchange failed.".to_string())?,
    )
    .await?;
    if !has_scopes(v["scope"].as_str().unwrap_or("")) {
        return Err(
            "Grant both Gmail read and draft/send permissions on the Google consent screen.".into(),
        );
    }
    let refresh = v["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Google did not grant offline access. Reconnect and approve access.")?;
    let access = v["access_token"]
        .as_str()
        .ok_or("Google did not return an access token.")?;
    let email = Gmail::new(access.into())?.profile().await?;
    // Stable account IDs let a reconnect preserve that account's existing review drafts.
    use sha2::{Digest, Sha256};
    let id = format!("{:x}", Sha256::digest(email.to_lowercase().as_bytes()));
    write(
        &format!("gmail_account_{id}"),
        &serde_json::to_string(&Grant {
            config,
            refresh_token: refresh.into(),
        })
        .map_err(|_| "Could not save Google grant.".to_string())?,
    )?;
    Ok((id, email))
}
pub async fn token(id: &str) -> Result<String, String> {
    let raw = read(&format!("gmail_account_{id}"))?
        .ok_or("Reconnect this Gmail account in Settings → Gmail.")?;
    let grant: Grant =
        serde_json::from_str(&raw).map_err(|_| "Reconnect this Gmail account.".to_string())?;
    let response = client()?
        .post(TOKEN_URL)
        .form(&[
            ("client_id", grant.config.client_id.as_str()),
            ("client_secret", grant.config.client_secret.as_str()),
            ("refresh_token", grant.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|_| "Could not refresh Gmail sign-in. Try again when online.".to_string())?;
    if response.status().as_u16() == 400 {
        return Err(
            "Gmail access expired or was revoked. Reconnect this account in Settings → Gmail."
                .into(),
        );
    }
    let v = json_response(response).await?;
    if let Some(scope) = v["scope"].as_str() {
        if !has_scopes(scope) {
            return Err("Reconnect Gmail and grant both email permissions.".into());
        }
    }
    Ok(v["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Google did not return an access token.")?
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oauth_requires_desktop_client_and_exact_state_and_scopes() {
        assert!(parse_config(
            r#"{"web":{"client_id":"x.apps.googleusercontent.com","client_secret":"x"}}"#
        )
        .is_err());
        let c=parse_config(r#"{"installed":{"client_id":"x.apps.googleusercontent.com","client_secret":"x","token_uri":"http://evil.test"}}"#).unwrap();
        let u = authorization_url(&c, "http://127.0.0.1:4567/", "challenge", "random-state");
        assert!(u.starts_with("https://accounts.google.com/"));
        assert!(u.contains("code_challenge_method=S256"));
        assert!(!u.contains("mail.google.com"));
        assert_eq!(
            parse_callback("/?code=secret&state=correct", "correct").unwrap(),
            "secret"
        );
        assert!(parse_callback("/?code=secret&state=wrong", "correct").is_err());
        assert!(parse_callback("/?code=secret&state=correct&state=correct", "correct").is_err());
        assert!(!has_scopes(READ_SCOPE));
        assert!(has_scopes(&format!("{READ_SCOPE} {COMPOSE_SCOPE}")));
    }
}
