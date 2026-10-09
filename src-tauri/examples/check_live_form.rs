//! Offline live-form check through the real local LLM and evidence validator.
//! Uses synthetic transcript text; never records audio or writes meeting data.
use echo_scribe_lib::{
    llm::{engine::GenerateRequest, registry, Llm},
    meeting::{guidance::GuidanceResponse, live_form, Segment, Speaker},
};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let id = std::env::args()
        .nth(1)
        .unwrap_or_else(|| registry::default_id().to_string());
    let llm = Llm::new(Duration::from_secs(60));
    llm.set_active_model(registry::lookup(&id).ok_or("Unknown local model")?.clone());
    if !llm.ready() {
        return Err("Local model weights are not installed".into());
    }
    let config = live_form::starter_config();
    let segments = vec![Segment { speaker:Speaker::Them,start_ms:0,end_ms:15000,text:"My name is Maya Chen. My work email is maya@example.com. We work in healthcare. We want to reduce the time spent copying call notes into the CRM. We are interested in your Team plan.".into() }];
    let (system, user) = live_form::build_prompt(&config, &segments, &[]);
    let raw = llm
        .generate(GenerateRequest {
            system,
            user,
            history: vec![],
            max_tokens: 1600,
            temperature: 0.1,
            stop_strings: vec![],
            grammar_gbnf: None,
            n_ctx: Some(8192),
        })
        .await?;
    let start = raw.find('{').ok_or("Missing JSON")?;
    let end = raw.rfind('}').ok_or("Missing JSON end")?;
    println!("MODEL_RESPONSE: {}", &raw[start..=end]);
    let response: GuidanceResponse = serde_json::from_str(&raw[start..=end])?;
    let mut answers = vec![];
    live_form::merge_answers(&config, &mut answers, response.form_answers, &segments);
    for (id, expected) in [("name", "Maya Chen"), ("email", "maya@example.com")] {
        if !answers.iter().any(|a| a.id == id && a.value == expected) {
            return Err(format!(
                "Local extraction did not produce the expected {id}; validated {} fields",
                answers.len()
            )
            .into());
        }
    }
    if answers.len() != config.fields.len() {
        return Err(format!("Expected 5 evidenced fields, got {}", answers.len()).into());
    }
    println!("PASS: local model {id} filled all 5 fields with validated transcript evidence.");
    Ok(())
}
