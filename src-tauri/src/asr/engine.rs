//! Model dispatch and the lifecycle of isolated speech workers.
use super::parakeet::{EngineError, ParakeetEngine};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use transcribe_rs::TranscriptionSegment;

pub struct SpeechEngine {
    path: PathBuf,
    backend: Backend,
}
enum Backend {
    Parakeet(ParakeetEngine),
    Worker(SpeechProcess),
}
impl SpeechEngine {
    pub fn load(path: &Path) -> Result<Self, EngineError> {
        let backend = match path.file_name().and_then(|p| p.to_str()) {
            Some("parakeet-v3") => Backend::Parakeet(ParakeetEngine::load(path)?),
            Some("whisper-turbo") => Backend::Worker(SpeechProcess::load(
                &path.join("ggml-large-v3-turbo-q5_0.bin"),
            )?),
            #[cfg(all(any(debug_assertions, tucky_local_asr), target_os = "macos", target_arch = "aarch64"))]
            Some("qwen3-asr") => Backend::Worker(SpeechProcess::load_qwen(path)?),
            Some("whisper-base") => {
                Backend::Worker(SpeechProcess::load(&path.join("ggml-base.bin"))?)
            }
            _ => return Err(EngineError::Io("Unknown speech model".into())),
        };
        Ok(Self {
            path: path.to_owned(),
            backend,
        })
    }
    /// A model selected during an in-flight resample/warm-up must never reuse a
    /// different engine. A failed worker is recreated on the next dictation.
    pub fn matches(&mut self, path: &Path) -> bool {
        self.path == path
            && match &mut self.backend {
                Backend::Parakeet(_) => true,
                Backend::Worker(worker) => {
                    worker.healthy && matches!(worker.child.try_wait(), Ok(None))
                }
            }
    }
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, EngineError> {
        match &mut self.backend {
            Backend::Parakeet(engine) => engine.transcribe(samples),
            Backend::Worker(worker) => worker.transcribe(samples).map(|r| r.text),
        }
    }
    pub fn transcribe_segments(
        &mut self,
        samples: &[f32],
    ) -> Result<Vec<TranscriptionSegment>, EngineError> {
        match &mut self.backend {
            Backend::Parakeet(engine) => engine.transcribe_segments(samples),
            Backend::Worker(worker) => worker.transcribe(samples).map(|r| {
                r.segments
                    .into_iter()
                    .map(|s| TranscriptionSegment {
                        start: s.start,
                        end: s.end,
                        text: s.text,
                    })
                    .collect()
            }),
        }
    }
}

#[derive(Default, Deserialize)]
struct Response {
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    text: String,
    #[serde(default)]
    segments: Vec<Segment>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Segment {
    start: f32,
    end: f32,
    text: String,
}

fn worker_path() -> Result<PathBuf, EngineError> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let exe = std::env::current_exe().map_err(io_error)?;
    let bundled = exe
        .parent()
        .ok_or_else(|| EngineError::Io("Cannot locate the application".into()))?
        .join(format!("tucky-whisper{suffix}"));
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "tucky-whisper-{}{suffix}",
                env!("TUCKY_TARGET_TRIPLE")
            )));
    }
    #[cfg(not(debug_assertions))]
    Err(EngineError::Io(
        "Whisper runtime is missing. Reinstall Tucky to restore it.".into(),
    ))
}
fn io_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::Io(format!("Speech runtime: {error}"))
}
const TIMEOUT: Duration = Duration::from_secs(120);
struct SpeechProcess {
    child: Child,
    input: Option<ChildStdin>,
    responses: mpsc::Receiver<Result<Response, String>>,
    healthy: bool,
}
impl Drop for SpeechProcess {
    fn drop(&mut self) {
        // Closing stdin normally exits the worker; kill also bounds cleanup if
        // native inference is stuck. Reap it to avoid accumulating zombies.
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl SpeechProcess {
    fn load(path: &Path) -> Result<Self, EngineError> {
        let mut command = Command::new(worker_path()?);
        command.arg(path);
        Self::spawn(command)
    }
    #[cfg(all(any(debug_assertions, tucky_local_asr), target_os = "macos", target_arch = "aarch64"))]
    fn load_qwen(path: &Path) -> Result<Self, EngineError> {
        let python = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/qwen-runtime/bin/python");
        if !python.is_file() {
            return Err(io_error(
                "Qwen runtime is missing. Run bun run asr:setup, then restart the local dev app.",
            ));
        }
        let mut command = Command::new(python);
        command
            .args(["-u", "-c", include_str!("../../qwen-worker/worker.py")])
            .arg(path)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1");
        Self::spawn(command)
    }
    fn spawn(mut command: Command) -> Result<Self, EngineError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(io_error)?;
        let input = child.stdin.take();
        let output = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let response = line.map_err(|e| e.to_string()).and_then(|line| {
                    serde_json::from_str::<Response>(&line).map_err(|e| e.to_string())
                });
                let failed = response.is_err();
                if tx.send(response).is_err() || failed {
                    break;
                }
            }
        });
        let mut worker = Self {
            child,
            input,
            responses: rx,
            healthy: true,
        };
        let response = worker.receive()?;
        if !response.ready {
            return Err(io_error("Worker did not initialize"));
        }
        Ok(worker)
    }
    fn receive(&mut self) -> Result<Response, EngineError> {
        let result = self
            .responses
            .recv_timeout(TIMEOUT)
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .and_then(|r| match &r.error {
                Some(e) => Err(e.clone()),
                None => Ok(r),
            });
        match result {
            Ok(r) => Ok(r),
            Err(e) => {
                self.healthy = false;
                let _ = self.child.kill();
                Err(io_error(e))
            }
        }
    }
    fn transcribe(&mut self, samples: &[f32]) -> Result<Response, EngineError> {
        let mut combined = Response::default();
        for (index, chunk) in samples.chunks(960_000).enumerate() {
            if chunk.iter().any(|v| !v.is_finite()) {
                return Err(io_error("Invalid audio"));
            }
            let mut input = self
                .input
                .take()
                .ok_or_else(|| io_error("Worker input unavailable"))?;
            let mut bytes = Vec::with_capacity(4 + chunk.len() * 4);
            bytes.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            for sample in chunk {
                bytes.extend_from_slice(&sample.clamp(-1.0, 1.0).to_le_bytes());
            }
            // Bound blocked pipe writes as well as inference. On timeout, killing
            // the child closes its pipe and releases this short-lived writer.
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let result = input.write_all(&bytes).and_then(|_| input.flush());
                let _ = tx.send((input, result));
            });
            match rx.recv_timeout(TIMEOUT) {
                Ok((input, result)) => {
                    self.input = Some(input);
                    if let Err(error) = result {
                        self.healthy = false;
                        let _ = self.child.kill();
                        return Err(io_error(error));
                    }
                }
                Err(error) => {
                    self.healthy = false;
                    let _ = self.child.kill();
                    return Err(io_error(error));
                }
            }
            let response = self.receive()?;
            if !response.text.trim().is_empty() {
                if !combined.text.is_empty() {
                    combined.text.push(' ');
                }
                combined.text.push_str(response.text.trim());
            }
            combined
                .segments
                .extend(response.segments.into_iter().map(|mut s| {
                    s.start += index as f32 * 60.0;
                    s.end += index as f32 * 60.0;
                    s
                }));
        }
        Ok(combined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_model_is_rejected_before_loading() {
        assert!(SpeechEngine::load(Path::new("/models/unknown-model")).is_err());
    }
    #[test]
    #[ignore = "Requires downloaded Whisper Base and the built native worker"]
    fn whisper_worker_reuses_process_and_exits_on_drop() {
        let entry = crate::asr::registry::lookup("whisper-base").unwrap();
        let mut worker =
            SpeechProcess::load(&crate::asr::downloader::model_dir(entry).join("ggml-base.bin"))
                .unwrap();
        let pid = worker.child.id();
        for _ in 0..2 {
            let result = worker.transcribe(&vec![0.0; 16000]).unwrap();
            assert!(result.text.is_empty());
            assert_eq!(worker.child.id(), pid);
            assert!(worker.child.try_wait().unwrap().is_none());
        }
        drop(worker);
        #[cfg(unix)]
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "unloading must terminate the worker"
        );
    }
}
