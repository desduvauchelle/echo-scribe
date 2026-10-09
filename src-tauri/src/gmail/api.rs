//! Bounded Gmail REST reads and reviewed writes. No labels, delete, archive or mailbox sync.
use super::store::Draft;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BYTES: usize = 4 * 1024 * 1024;

pub fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start Gmail connection.".into())
}
pub async fn json_response(mut response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "Gmail sign-in expired. Reconnect the account in Settings → Gmail.".into(),
            403 => "Gmail refused access. Check Gmail API is enabled and grant both email permissions when reconnecting.".into(),
            429 => "Gmail is rate limiting requests. Try again later.".into(),
            _ => format!("Gmail request failed (HTTP {}).",status.as_u16()),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Gmail response was interrupted.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("Gmail response was too large. Narrow the search.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Gmail returned an invalid response.".into())
}
pub struct Gmail {
    client: Client,
    base: String,
    token: String,
}
impl Gmail {
    pub fn new(token: String) -> Result<Self, String> {
        Ok(Self {
            client: client()?,
            base: API.into(),
            token,
        })
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .query(query);
        if let Some(body) = body {
            request = request.json(&body);
        }
        json_response(request.send().await.map_err(|_| "Gmail connection failed. For a write, check Gmail before retrying: it may have been accepted.".to_string())?).await
    }
    pub async fn profile(&self) -> Result<String, String> {
        let v = self.request(Method::GET, "/profile", &[], None).await?;
        let email = v["emailAddress"]
            .as_str()
            .ok_or("Gmail did not return the account address.")?;
        addresses(email)?;
        Ok(email.to_string())
    }
    pub async fn search(&self, query: &str, page: Option<&str>) -> Result<Value, String> {
        if query.len() > 1000 || page.is_some_and(|p| p.len() > 2000) {
            return Err("Search query is too long.".into());
        }
        let mut params = vec![("q", query), ("maxResults", "8")];
        if let Some(page) = page {
            params.push(("pageToken", page));
        }
        let v = self
            .request(Method::GET, "/messages", &params, None)
            .await?;
        let mut results = vec![];
        for item in v["messages"].as_array().into_iter().flatten().take(8) {
            let id = item["id"].as_str().ok_or("Invalid Gmail search result.")?;
            let message = self.message(id, "metadata").await?;
            results.push(message);
        }
        Ok(
            json!({"messages":results,"next_page_token":v["nextPageToken"],"result_size_estimate":v["resultSizeEstimate"]}),
        )
    }
    pub async fn message(&self, id: &str, format: &str) -> Result<MailMessage, String> {
        identifier(id)?;
        let v = self
            .request(
                Method::GET,
                &format!("/messages/{id}"),
                &[("format", format)],
                None,
            )
            .await?;
        parse_message(&v)
    }
    pub async fn thread(&self, id: &str) -> Result<Value, String> {
        identifier(id)?;
        let v = self
            .request(
                Method::GET,
                &format!("/threads/{id}"),
                &[("format", "full")],
                None,
            )
            .await?;
        let messages = v["messages"]
            .as_array()
            .ok_or("Gmail returned no thread messages.")?;
        let start = messages.len().saturating_sub(12);
        let parsed = messages[start..]
            .iter()
            .map(parse_message)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"id":id,"messages":parsed,"partial":start>0,"total_messages":messages.len()}))
    }
    pub async fn save(&self, d: &Draft) -> Result<String, String> {
        let message = message_payload(d)?;
        let (method, path) = match &d.gmail_id {
            Some(id) => {
                identifier(id)?;
                (Method::PUT, format!("/drafts/{id}"))
            }
            None => (Method::POST, "/drafts".into()),
        };
        let v = self
            .request(method, &path, &[], Some(json!({"message":message})))
            .await?;
        let id=v["id"].as_str().ok_or("Gmail accepted the request but did not return a draft ID. Check Gmail before retrying.")?;
        identifier(id)?;
        Ok(id.into())
    }
    pub async fn send(&self, d: &Draft) -> Result<String, String> {
        // Send the exact reviewed MIME, even if a saved Gmail draft was edited externally.
        // drafts.send with raw replaces that draft and consumes it on success.
        let message = message_payload(d)?;
        let (path, body) = match &d.gmail_id {
            Some(id) => {
                identifier(id)?;
                ("/drafts/send", json!({"id":id,"message":message}))
            }
            None => ("/messages/send", message),
        };
        let v = self.request(Method::POST, path, &[], Some(body)).await?;
        Ok(v["id"]
            .as_str()
            .ok_or("Gmail did not return a sent message ID. Check Sent before retrying.")?
            .to_string())
    }
}
pub fn identifier(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err("Invalid Gmail identifier.".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MailMessage {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub to: String,
    pub cc: String,
    pub reply_to: String,
    pub subject: String,
    pub date: String,
    pub snippet: String,
    pub body: String,
    pub partial: bool,
    pub message_id: String,
    pub references: String,
}
fn header(v: &Value, name: &str) -> String {
    let raw = v["payload"]["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|h| {
            h["name"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(name))
        })
        .and_then(|h| h["value"].as_str())
        .unwrap_or("");
    let decoded = if name == "Subject" {
        mailparse::parse_header(format!("Subject: {raw}").as_bytes())
            .ok()
            .map(|(h, _)| h.get_value())
            .unwrap_or_else(|| raw.into())
    } else {
        raw.into()
    };
    decoded.chars().take(4000).collect()
}
fn body_part(part: &Value, mime: &str, depth: usize) -> Result<String, String> {
    if depth > 16 {
        return Ok(String::new());
    }
    if !part["filename"].as_str().unwrap_or("").is_empty() {
        return Ok(String::new());
    }
    if part["mimeType"] == mime {
        if let Some(encoded) = part["body"]["data"].as_str() {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .or_else(|_| URL_SAFE.decode(encoded))
                .map_err(|_| "Invalid Gmail message body.".to_string())?;
            // MIME charset matters even though the transfer encoding is base64url.
            let charset = part["headers"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|h| {
                    h["name"]
                        .as_str()
                        .is_some_and(|s| s.eq_ignore_ascii_case("Content-Type"))
                })
                .and_then(|h| h["value"].as_str())
                .map(|s| mailparse::parse_content_type(s).charset)
                .unwrap_or("utf-8".into());
            let encoding =
                encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
            return Ok(encoding.decode(&bytes).0.into_owned());
        }
    }
    let mut found = vec![];
    for p in part["parts"].as_array().into_iter().flatten() {
        let text = body_part(p, mime, depth + 1)?;
        if !text.is_empty() {
            found.push(text);
        }
    }
    Ok(found.join("\n"))
}
pub fn parse_message(v: &Value) -> Result<MailMessage, String> {
    let id = v["id"]
        .as_str()
        .ok_or("Gmail message has no ID.")?
        .to_string();
    identifier(&id)?;
    let thread_id = v["threadId"]
        .as_str()
        .ok_or("Gmail message has no thread ID.")?
        .to_string();
    identifier(&thread_id)?;
    let mut body = body_part(&v["payload"], "text/plain", 0)?;
    if body.is_empty() {
        let html = body_part(&v["payload"], "text/html", 0)?;
        if !html.is_empty() {
            body = html2text::from_read(html.as_bytes(), 100)
                .map_err(|_| "Couldn't read the HTML email.".to_string())?;
        }
    }
    let partial = body.chars().count() > 10000 || body.is_empty();
    Ok(MailMessage {
        id,
        thread_id,
        from: header(v, "From"),
        to: header(v, "To"),
        cc: header(v, "Cc"),
        reply_to: header(v, "Reply-To"),
        subject: header(v, "Subject"),
        date: header(v, "Date"),
        snippet: v["snippet"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(600)
            .collect(),
        body: body.chars().take(10000).collect(),
        partial,
        message_id: header(v, "Message-ID"),
        references: header(v, "References"),
    })
}
pub fn addresses(raw: &str) -> Result<String, String> {
    if raw.contains(['\r', '\n']) || raw.len() > 2000 {
        return Err("Invalid recipient address.".into());
    }
    let encoded = format!("To: {raw}");
    let (header, _) = mailparse::parse_header(encoded.as_bytes())
        .map_err(|_| "Invalid address header.".to_string())?;
    let parsed = mailparse::addrparse_header(&header)
        .map_err(|_| "Enter valid email addresses, separated by commas.".to_string())?;
    let mut addresses = vec![];
    for a in parsed.iter() {
        match a {
            mailparse::MailAddr::Single(info) => addresses.push(info.addr.clone()),
            _ => return Err("Use individual email addresses rather than a group.".into()),
        }
    }
    if addresses.is_empty()
        || addresses.len() > 30
        || addresses.iter().any(|a| {
            !a.is_ascii()
                || a.split_once('@').is_none_or(|(local, domain)| {
                    local.is_empty() || domain.is_empty() || domain.contains('@')
                })
                || a.contains(['\r', '\n', '<', '>', ' ', ':', ';'])
        })
    {
        return Err("Enter valid email addresses, separated by commas.".into());
    }
    Ok(addresses.join(", "))
}
fn message_ids(raw: &str) -> Result<String, String> {
    if raw.contains(['\r', '\n']) {
        return Err("Unsafe reply headers.".into());
    }
    let ids = raw.split_whitespace().collect::<Vec<_>>();
    if ids.is_empty()
        || ids
            .iter()
            .any(|s| !s.starts_with('<') || !s.ends_with('>') || !s.contains('@') || !s.is_ascii())
    {
        return Err(
            "This email has no usable Message-ID; Tucky cannot create a safely threaded reply."
                .into(),
        );
    }
    Ok(ids.join(" "))
}
pub fn message_payload(d: &Draft) -> Result<Value, String> {
    let to = addresses(&d.fields.to)?;
    let from = addresses(&d.from)?;
    let cc = if d.fields.cc.trim().is_empty() {
        String::new()
    } else {
        addresses(&d.fields.cc)?
    };
    if d.fields.subject.contains(['\r', '\n'])
        || d.fields.subject.len() > 1000
        || d.fields.body.len() > 64000
        || d.fields.body.trim().is_empty()
    {
        return Err(
            "Add a subject and email body without multiline headers (body limit: 64 KB).".into(),
        );
    }
    let subject = d
        .reply_to
        .as_ref()
        .map(|m| m.subject.as_str())
        .unwrap_or(&d.fields.subject);
    if subject != d.fields.subject {
        return Err(
            "Keep the original subject to reply in this conversation, or start a new email.".into(),
        );
    }
    // Encode Unicode headers/body without header injection or line-length violations.
    let encoded_subject = subject
        .chars()
        .collect::<Vec<_>>()
        .chunks(10)
        .map(|c| {
            format!(
                "=?UTF-8?B?{}?=",
                STANDARD.encode(c.iter().collect::<String>())
            )
        })
        .collect::<Vec<_>>()
        .join("\r\n ");
    let mut mime = format!("From: {from}\r\nTo: {to}\r\nSubject: {encoded_subject}\r\n");
    if !cc.is_empty() {
        mime.push_str(&format!("Cc: {cc}\r\n"));
    }
    if let Some(reply) = &d.reply_to {
        let parent = message_ids(&reply.message_id)?;
        let references = if reply.references.trim().is_empty() {
            parent.clone()
        } else {
            format!("{} {parent}", message_ids(&reply.references)?)
        };
        mime.push_str(&format!(
            "In-Reply-To: {parent}\r\nReferences: {}\r\n",
            references
                .split_whitespace()
                .collect::<Vec<_>>()
                .join("\r\n ")
        ));
    }
    let body = d
        .fields
        .body
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n");
    let encoded_body = STANDARD.encode(body);
    mime.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    for chunk in encoded_body.as_bytes().chunks(76) {
        mime.push_str(std::str::from_utf8(chunk).expect("base64 ascii"));
        mime.push_str("\r\n");
    }
    let mut payload = json!({"raw":URL_SAFE_NO_PAD.encode(mime)});
    if let Some(reply) = &d.reply_to {
        identifier(&reply.thread_id)?;
        payload["threadId"] = json!(reply.thread_id);
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::super::store::Fields;
    use super::*;
    use std::{
        io::{Read, Write},
        sync::{Arc, Mutex},
    };
    fn email(id: &str, thread: &str, html: bool) -> Value {
        json!({"id":id,"threadId":thread,"snippet":"An excerpt","payload":{"mimeType":if html{"text/html"}else{"text/plain"},"headers":[
            {"name":"From","value":"Alex <alex@example.com>"},{"name":"To","value":"me@example.com"},
            {"name":"Subject","value":"Proposal — café"},{"name":"Message-ID","value":"<parent@example.com>"},
            {"name":"References","value":"<root@example.com>"}],"body":{"data":URL_SAFE_NO_PAD.encode(if html{"<p>Hi <b>Denis</b></p>"}else{"Can we meet Tuesday?"})}}})
    }
    fn review() -> Draft {
        Draft {
            id: "local".into(),
            account_id: "account".into(),
            from: "me@example.com".into(),
            revision: 1,
            fields: Fields {
                to: "alex@example.com".into(),
                cc: "team@example.com".into(),
                subject: "Proposal — café".into(),
                body: "Yes, Tuesday works.\nÀ bientôt.".into(),
            },
            reply_to: Some(parse_message(&email("123", "abc", false)).unwrap()),
            gmail_id: None,
            saved_revision: None,
            status: "review".into(),
            sent_message_id: None,
        }
    }
    #[test]
    fn reply_mime_preserves_thread_and_unicode_and_rejects_injection() {
        let mut d = review();
        let payload = message_payload(&d).unwrap();
        assert_eq!(payload["threadId"], "abc");
        let bytes = URL_SAFE_NO_PAD
            .decode(payload["raw"].as_str().unwrap())
            .unwrap();
        let parsed = mailparse::parse_mail(&bytes).unwrap();
        use mailparse::MailHeaderMap;
        assert_eq!(
            parsed.headers.get_first_value("Subject").unwrap(),
            "Proposal — café"
        );
        assert_eq!(
            parsed.headers.get_first_value("In-Reply-To").unwrap(),
            "<parent@example.com>"
        );
        assert_eq!(
            parsed.headers.get_first_value("References").unwrap(),
            "<root@example.com> <parent@example.com>"
        );
        assert_eq!(
            parsed.get_body().unwrap(),
            "Yes, Tuesday works.\r\nÀ bientôt."
        );
        d.fields.to = "alex@example.com\r\nBcc: evil@example.com".into();
        assert!(message_payload(&d).is_err());
        d = review();
        d.fields.subject = "Different thread".into();
        assert!(message_payload(&d).is_err());
        d = review();
        d.reply_to.as_mut().unwrap().message_id = "<x@example.com>\r\nBcc:evil@example.com".into();
        assert!(message_payload(&d).is_err());
        d = review();
        d.reply_to.as_mut().unwrap().message_id = String::new();
        assert!(message_payload(&d).is_err());
    }
    #[test]
    fn plain_html_and_charsets_are_read_without_attachments() {
        let html = parse_message(&email("123", "abc", true)).unwrap();
        assert!(html.body.contains("Denis"));
        assert!(!html.body.contains("<p>"));
        let mut v = email("123", "abc", false);
        v["payload"] = json!({"mimeType":"multipart/mixed","parts":[
            {"mimeType":"text/plain","headers":[{"name":"Content-Type","value":"text/plain; charset=iso-8859-1"}],"body":{"data":URL_SAFE_NO_PAD.encode(b"caf\xe9")}},
            {"mimeType":"text/plain","filename":"secret.txt","body":{"data":URL_SAFE_NO_PAD.encode("attachment")}}
        ]});
        assert_eq!(parse_message(&v).unwrap().body, "café");
        v["payload"] = json!({"mimeType":"text/plain","body":{"data":URL_SAFE_NO_PAD.encode("x".repeat(12000))}});
        let long = parse_message(&v).unwrap();
        assert!(long.partial);
        assert_eq!(long.body.len(), 10000);
    }
    /// Real HTTP requests against loopback fixtures, with no credentials/accounts.
    fn server(
        responses: Vec<(u16, Value)>,
    ) -> (
        Gmail,
        Arc<Mutex<Vec<(String, Value)>>>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let recorded = Arc::new(Mutex::new(vec![]));
        let requests = recorded.clone();
        let handle = std::thread::spawn(move || {
            for (status, response) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                let mut buf = [0; 4096];
                let header_end = loop {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                let size = header
                    .lines()
                    .find_map(|s| {
                        s.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + size {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                }
                let body = if size == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[header_end..header_end + size]).unwrap()
                };
                assert!(header
                    .to_lowercase()
                    .contains("authorization: bearer fixture"));
                requests
                    .lock()
                    .unwrap()
                    .push((header.lines().next().unwrap().into(), body));
                let body = response.to_string();
                write!(stream,"HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        (
            Gmail {
                client: client().unwrap(),
                base,
                token: "fixture".into(),
            },
            recorded,
            handle,
        )
    }
    #[tokio::test]
    async fn search_paginate_read_create_update_and_send_exact_reviewed_reply() {
        let (api, requests, handle) = server(vec![
            (
                200,
                json!({"messages":[{"id":"123","threadId":"abc"}],"nextPageToken":"next","resultSizeEstimate":22}),
            ),
            (200, email("123", "abc", false)),
            (
                200,
                json!({"id":"abc","messages":[email("123","abc",false)]}),
            ),
            (200, json!({"id":"draft-1"})),
            (200, json!({"id":"draft-1"})),
            (200, json!({"id":"sent-1"})),
        ]);
        let search = api
            .search("from:alex@example.com proposal", Some("page+1"))
            .await
            .unwrap();
        assert_eq!(search["next_page_token"], "next");
        let thread = api.thread("abc").await.unwrap();
        assert_eq!(thread["messages"][0]["body"], "Can we meet Tuesday?");
        let mut d = review();
        d.gmail_id = Some(api.save(&d).await.unwrap());
        d.fields.body = "Edited locally after Gmail save".into();
        assert_eq!(api.save(&d).await.unwrap(), "draft-1");
        assert_eq!(api.send(&d).await.unwrap(), "sent-1");
        handle.join().unwrap();
        let req = requests.lock().unwrap();
        assert!(req[0].0.contains("maxResults=8"));
        assert!(req[0].0.contains("pageToken=page%2B1"));
        assert!(req[3].0.starts_with("POST /drafts "));
        assert!(req[4].0.starts_with("PUT /drafts/draft-1 "));
        assert!(req[5].0.starts_with("POST /drafts/send "));
        assert_eq!(req[5].1["id"], "draft-1");
        assert_eq!(req[5].1["message"]["threadId"], "abc");
        let bytes = URL_SAFE_NO_PAD
            .decode(req[5].1["message"]["raw"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            mailparse::parse_mail(&bytes).unwrap().get_body().unwrap(),
            "Edited locally after Gmail save"
        );
    }
    #[tokio::test]
    async fn provider_failures_are_not_empty_success_or_retried_writes() {
        let (api, requests, handle) = server(vec![(403, json!({"error":"private provider text"}))]);
        let error = api.search("anything", None).await.unwrap_err();
        assert!(error.contains("refused access"));
        assert!(!error.contains("private provider text"));
        handle.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
        let (api, requests, handle) = server(vec![(503, json!({"error":"private"}))]);
        assert!(api.send(&review()).await.is_err());
        handle.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}
