//! One benchmark per process: release model memory reliably after each run.
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    path::Path,
    time::Instant,
};
use transcribe_rs::{
    onnx::{
        parakeet::{ParakeetModel, ParakeetParams},
        Quantization,
    },
    whisper_cpp::{WhisperEngine, WhisperInferenceParams},
};
#[path = "../../src/util/rss.rs"]
#[allow(dead_code)]
mod rss;

#[derive(Deserialize)]
struct Request {
    model: String,
    path: String,
    samples: Vec<f32>,
}
#[derive(Serialize)]
struct ResultRow {
    text: String,
    load_ms: f64,
    first_ms: f64,
    warm_ms: Vec<f64>,
    audio_seconds: f64,
    loaded_rss_mib: f64,
    peak_rss_mib: f64,
    backend: String,
}

fn run(request: Request) -> Result<ResultRow, Box<dyn std::error::Error>> {
    if request.samples.len() < 1600
        || request.samples.len() > 16000 * 60
        || request
            .samples
            .iter()
            .any(|x| !x.is_finite() || x.abs() > 1.0)
    {
        return Err("Provide 0.1–60 seconds of finite 16 kHz mono audio".into());
    }
    let start = Instant::now();
    let (mut infer, backend): (Box<dyn FnMut(&[f32]) -> Result<String, String>>, _) =
        match request.model.as_str() {
            "parakeet-v3" => {
                let mut model = ParakeetModel::load(Path::new(&request.path), &Quantization::Int8)?;
                (
                    Box::new(move |samples| {
                        model
                            .transcribe_with(samples, &ParakeetParams::default())
                            .map(|r| r.text.trim().to_owned())
                            .map_err(|e| e.to_string())
                    }),
                    "ONNX · CPU",
                )
            }
            "whisper-base" | "whisper-turbo" => {
                let mut model = WhisperEngine::load(Path::new(&request.path))?;
                (
                    Box::new(move |samples| {
                        model
                            .transcribe_with(samples, &WhisperInferenceParams::default())
                            .map(|r| r.text.trim().to_owned())
                            .map_err(|e| e.to_string())
                    }),
                    if cfg!(target_os = "macos") {
                        "whisper.cpp · Metal"
                    } else {
                        "whisper.cpp · CPU"
                    },
                )
            }
            _ => return Err("Unknown model".into()),
        };
    let load_ms = start.elapsed().as_secs_f64() * 1000.0;
    let loaded_rss_mib = rss::current_rss_bytes() as f64 / 1048576.0;
    let start = Instant::now();
    let text = infer(&request.samples)?;
    let first_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut warm_ms = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        infer(&request.samples)?;
        warm_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(ResultRow {
        text,
        load_ms,
        first_ms,
        warm_ms,
        audio_seconds: request.samples.len() as f64 / 16000.0,
        loaded_rss_mib,
        peak_rss_mib: rss::max_rss_bytes() as f64 / 1048576.0,
        backend: backend.into(),
    })
}
fn main() {
    let result = (|| {
        let mut input = String::new();
        io::stdin()
            .take(24_000_000)
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())?;
        let request = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        run(request).map_err(|e| e.to_string())
    })();
    match result {
        Ok(row) => println!("{}", serde_json::to_string(&row).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
