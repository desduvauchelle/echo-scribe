//! Persistent local Whisper worker. Its private ggml runtime must not be linked
//! into Tucky, which already links a different ggml via llama.cpp.
//! Input: little-endian u32 sample count, followed by that many f32 samples.
//! Output: one JSON line per request; native diagnostics stay on stderr.
use serde_json::json;
use std::{
    io::{self, Read, Write},
    path::Path,
};
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};

fn transcription_params(_path: &Path) -> WhisperInferenceParams {
    // Example prose can leak into recognition as words the user never said.
    // Keep decoding unprompted, including for Turbo.
    WhisperInferenceParams::default()
}

fn emit(value: serde_json::Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    writeln!(stdout)?;
    stdout.flush()
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("Missing Whisper model path")?;
    let mut engine = WhisperEngine::load(Path::new(&path))?;
    let params = transcription_params(Path::new(&path));
    emit(json!({"ready": true}))?;
    let mut input = io::stdin().lock();
    loop {
        let mut count = [0; 4];
        match input.read_exact(&mut count) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        let count = u32::from_le_bytes(count) as usize;
        // The parent sends bounded 60-second chunks, even for long dictations.
        if count == 0 || count > 960_000 {
            return Err("Invalid audio length".into());
        }
        let mut bytes = vec![0; count * 4];
        input.read_exact(&mut bytes)?;
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        if samples.iter().any(|v| !v.is_finite() || v.abs() > 1.0) {
            return Err("Invalid audio sample".into());
        }
        // Empty/silent microphone input should not hallucinate a subtitle.
        if samples.iter().all(|v| v.abs() < 0.0001) {
            emit(json!({"text": "", "segments": []}))?;
            continue;
        }
        match engine.transcribe_with(&samples, &params) {
            Ok(result) => emit(
                json!({"text": result.text.trim(), "segments": result.segments.unwrap_or_default().iter().map(|s| json!({"start": s.start, "end": s.end, "text": s.text})).collect::<Vec<_>>()}),
            )?,
            Err(error) => emit(json!({"error": error.to_string()}))?,
        }
    }
}
fn main() {
    if let Err(error) = run() {
        let _ = emit(json!({"error": error.to_string()}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turbo_does_not_prime_transcription_with_unspoken_text() {
        let params = transcription_params(Path::new(
            "/models/whisper-turbo/ggml-large-v3-turbo-q5_0.bin",
        ));
        assert!(params.initial_prompt.is_none());
        assert!(params.language.is_none());
        assert!(!params.translate);
        assert!(params.suppress_blank);
        assert!(params.suppress_non_speech_tokens);
    }

    #[test]
    fn other_whisper_models_keep_default_decoding() {
        for path in ["/models/whisper-base/ggml-base.bin", "/models/other.bin"] {
            assert!(transcription_params(Path::new(path))
                .initial_prompt
                .is_none());
        }
    }
}
