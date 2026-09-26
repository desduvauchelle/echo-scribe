//! Offline diagnostic: transcribe a WAV and print the wake-command gate result.
//! Never captures a microphone, saves a transcript, or executes an action.
use echo_scribe_lib::{
    asr::{pipeline::AsrPipeline, registry},
    wakeword,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        return Err("Pass one or more WAV paths".into());
    }
    let asr = AsrPipeline::default();
    asr.set_active_model(
        registry::lookup(registry::default_id())
            .ok_or("No default model")?
            .clone(),
    );
    let mut results = Vec::new();
    for path in paths {
        let text = asr.transcribe_file(std::path::Path::new(&path)).await?;
        results.push(serde_json::json!({ "path": path, "transcript": text, "command": wakeword::command_from_transcript(&text) }));
    }
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}
