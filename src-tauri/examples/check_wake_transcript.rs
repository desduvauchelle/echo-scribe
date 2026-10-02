//! Offline diagnostic: transcribe a WAV and print the wake-command gate result.
//! Never captures a microphone, saves a transcript, or executes an action.
use echo_scribe_lib::{
    asr::{pipeline::AsrPipeline, registry},
    llm::{action_launcher, GenerateFuture, GenerateRequest, LlmError, LlmGenerator},
    wakeword,
};

struct NoModel;
impl LlmGenerator for NoModel {
    fn generate<'a>(&'a self, _request: GenerateRequest) -> GenerateFuture<'a> {
        Box::pin(async { Err(LlmError::NoActiveModel) })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut paths: Vec<String> = std::env::args().skip(1).collect();
    let model_id = if paths.first().is_some_and(|arg| arg == "--model") {
        if paths.len() < 3 {
            return Err("Use --model MODEL_ID followed by WAV paths".into());
        }
        paths.remove(0);
        paths.remove(0)
    } else {
        registry::default_id().to_string()
    };
    if paths.is_empty() {
        return Err("Pass one or more WAV paths".into());
    }
    let asr = AsrPipeline::default();
    asr.set_active_model(
        registry::lookup(&model_id)
            .ok_or("Unknown speech model")?
            .clone(),
    );
    let mut results = Vec::new();
    for path in paths {
        let text = asr.transcribe_file(std::path::Path::new(&path)).await?;
        let command = wakeword::command_from_transcript(&text);
        let action = if let Some(command) = command.as_deref() {
            action_launcher::detect_action(&NoModel, command, &[])
                .await
                .ok()
        } else {
            None
        };
        results.push(serde_json::json!({ "path": path, "transcript": text, "command": command, "action_type": action.and_then(|action| action.action_type) }));
    }
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}
