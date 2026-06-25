use echo_scribe_lib::llm::action_launcher::{detect_action, normalize_spoken_email, strip_trigger_prefix};
use echo_scribe_lib::llm::{GenerateFuture, GenerateRequest, LlmGenerator};
use std::sync::{Arc, Mutex};

struct MockLlm {
    responses: Arc<Mutex<Vec<String>>>,
    requests: Arc<Mutex<Vec<GenerateRequest>>>,
}

impl LlmGenerator for MockLlm {
    fn generate<'a>(&'a self, req: GenerateRequest) -> GenerateFuture<'a> {
        let responses = Arc::clone(&self.responses);
        let requests = Arc::clone(&self.requests);
        Box::pin(async move {
            requests.lock().unwrap().push(req);
            let mut list = responses.lock().unwrap();
            if list.is_empty() {
                Ok("{}".to_string())
            } else {
                Ok(list.remove(0))
            }
        })
    }
}

#[tokio::test]
async fn test_detect_action_success() {
    let mock_json = r#"{
        "is_action": true,
        "action_type": "launch_app",
        "app_name": "Slack",
        "email_to": null,
        "email_subject": null,
        "email_body": null,
        "url": null,
        "confidence": 0.95
    }"#;

    let mock = MockLlm {
        responses: Arc::new(Mutex::new(vec![mock_json.to_string()])),
        requests: Arc::new(Mutex::new(vec![])),
    };

    let cmd = detect_action(&mock, "open Slack", &[]).await.unwrap();

    assert!(cmd.is_action);
    assert_eq!(cmd.action_type, Some("launch_app".to_string()));
    assert_eq!(cmd.app_name, Some("Slack".to_string()));
    assert_eq!(cmd.confidence, 0.95);
    
    // Verify request had n_ctx: Some(2048) optimization
    let reqs = mock.requests.lock().unwrap();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].n_ctx, Some(2048));
}

#[tokio::test]
async fn test_detect_action_handles_markdown_fences() {
    let mock_json_fenced = r#"Here is the action you requested:
```json
{
  "is_action": true,
  "action_type": "open_url",
  "app_name": null,
  "email_to": null,
  "email_subject": null,
  "email_body": null,
  "url": "https://google.com",
  "confidence": 0.88
}
```
Hope that helps!"#;

    let mock = MockLlm {
        responses: Arc::new(Mutex::new(vec![mock_json_fenced.to_string()])),
        requests: Arc::new(Mutex::new(vec![])),
    };

    let cmd = detect_action(&mock, "go to google", &[]).await.unwrap();

    assert!(cmd.is_action);
    assert_eq!(cmd.action_type, Some("open_url".to_string()));
    assert_eq!(cmd.url, Some("https://google.com".to_string()));
    assert_eq!(cmd.confidence, 0.88);
}

#[tokio::test]
async fn test_detect_action_retry_logic() {
    // First response is completely invalid JSON that doesn't even contain braces
    let invalid_json = "I cannot classify this message. Please ask again.";
    
    // Second response is correct JSON
    let valid_json = r#"{
        "is_action": false,
        "action_type": null,
        "app_name": null,
        "email_to": null,
        "email_subject": null,
        "email_body": null,
        "url": null,
        "confidence": 0.1
    }"#;

    let mock = MockLlm {
        responses: Arc::new(Mutex::new(vec![invalid_json.to_string(), valid_json.to_string()])),
        requests: Arc::new(Mutex::new(vec![])),
    };

    let cmd = detect_action(&mock, "some random voice dictation", &[]).await.unwrap();

    assert!(!cmd.is_action);
    assert_eq!(cmd.action_type, None);
    assert_eq!(cmd.confidence, 0.1);

    // Verify retry happened (2 requests total)
    let reqs = mock.requests.lock().unwrap();
    assert_eq!(reqs.len(), 2);
    assert!(reqs[1].user.contains("previous response failed to parse"));
}

#[tokio::test]
async fn test_detect_action_failed_twice_returns_error() {
    let invalid_json_1 = "bad response 1";
    let invalid_json_2 = "bad response 2";

    let mock = MockLlm {
        responses: Arc::new(Mutex::new(vec![invalid_json_1.to_string(), invalid_json_2.to_string()])),
        requests: Arc::new(Mutex::new(vec![])),
    };

    let err = detect_action(&mock, "open Slack", &[]).await.unwrap_err();
    assert!(err.to_string().contains("json parsing failed"));
}

#[test]
fn test_normalize_spoken_email() {
    // Test exact transcript spoken by the user
    let raw_email = "D-E-S-D-U-V-A-U-C-H-E-L-L E at gmail.com";
    let normalized = normalize_spoken_email(raw_email);
    assert_eq!(normalized, "desduvauchelle@gmail.com");

    // Test spoken "@" representations
    assert_eq!(normalize_spoken_email("test at example.com"), "test@example.com");
    assert_eq!(normalize_spoken_email("john [at] github.com"), "john@github.com");
    assert_eq!(normalize_spoken_email("admin (at) livecase.org"), "admin@livecase.org");

    // Test spelling hyphens in local part without domain (fallback)
    assert_eq!(normalize_spoken_email("d-e-n-i-s"), "denis");

    // Test that a normal email remains unaffected
    assert_eq!(normalize_spoken_email("denis@livecase.com"), "denis@livecase.com");
    
    // Test that a normal email with single hyphen remains unaffected
    assert_eq!(normalize_spoken_email("jean-paul@example.com"), "jean-paul@example.com");
}

#[test]
fn test_strip_trigger_prefix() {
    // Valid trigger cases with various casings and spacing
    assert_eq!(strip_trigger_prefix("echo open terminal"), Some("open terminal".to_string()));
    assert_eq!(strip_trigger_prefix("Echo open terminal"), Some("open terminal".to_string()));
    assert_eq!(strip_trigger_prefix("echo, open terminal"), Some("open terminal".to_string()));
    assert_eq!(strip_trigger_prefix("echo - open terminal"), Some("open terminal".to_string()));
    assert_eq!(strip_trigger_prefix("Echo... open terminal"), Some("open terminal".to_string()));
    
    // Phonetic/Robust triggers
    assert_eq!(strip_trigger_prefix("eco launch slack"), Some("launch slack".to_string()));
    assert_eq!(strip_trigger_prefix("hecho draft an email"), Some("draft an email".to_string()));
    assert_eq!(strip_trigger_prefix("ekko show counter"), Some("show counter".to_string()));
    
    // Trigger word alone
    assert_eq!(strip_trigger_prefix("echo"), Some("".to_string()));
    assert_eq!(strip_trigger_prefix("  hecho  "), Some("".to_string()));
    
    // Non-trigger cases (trigger words embedded or as part of other words)
    assert_eq!(strip_trigger_prefix("ecosystem is good"), None);
    assert_eq!(strip_trigger_prefix("today we are going to echo our voices"), None);
    assert_eq!(strip_trigger_prefix("re-echo the command"), None);
    assert_eq!(strip_trigger_prefix("my hecho is done"), None);
}
