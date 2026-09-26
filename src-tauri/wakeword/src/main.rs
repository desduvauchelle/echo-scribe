//! Local keyword detector. No microphone, network, or audio-file writes.
//! Input: repeated [sample rate u32 LE, sample count u32 LE, mono f32 LE PCM].
//! Output: newline-delimited "ready" / "wake". EOF terminates the worker.
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, Wave};
use std::io::{self, Read, Write};
use std::path::Path;

fn detector(root: &Path) -> Result<KeywordSpotter, String> {
    let file = |name: &str| -> Result<Option<String>, String> {
        let path = root.join(name);
        if !path.is_file() {
            return Err(format!("Missing wake model: {}", path.display()));
        }
        Ok(Some(path.to_string_lossy().into_owned()))
    };
    let mut config = KeywordSpotterConfig::default();
    config.model_config.transducer.encoder = file("encoder.onnx")?;
    config.model_config.transducer.decoder = file("decoder.onnx")?;
    config.model_config.transducer.joiner = file("joiner.onnx")?;
    config.model_config.tokens = file("tokens.txt")?;
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 1;
    config.keywords_file = file("keywords.txt")?;
    config.keywords_score = 1.0;
    config.keywords_threshold = 0.35;
    KeywordSpotter::create(&config).ok_or_else(|| "Cannot load wake model".into())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let root = args.get(1).ok_or("Expected model directory")?;
    let kws = detector(Path::new(root))?;
    let mut stream = kws.create_stream();
    // Prime left context before declaring readiness. Without this the first
    // spoken keyword can be missed immediately after enabling/resuming.
    stream.accept_waveform(16_000, &[0.0; 16_000]);
    while kws.is_ready(&stream) {
        kws.decode(&stream);
    }
    let mut out = io::stdout().lock();
    writeln!(out, "ready")?;
    out.flush()?;
    // Offline acceptance test uses the same model and decode path as the app.
    if let Some(wav) = args.get(2) {
        let wave = Wave::read(wav).ok_or("Cannot read WAV")?;
        stream.accept_waveform(wave.sample_rate(), wave.samples());
        stream.accept_waveform(wave.sample_rate(), &vec![0.0; wave.sample_rate() as usize]);
        stream.input_finished();
        while kws.is_ready(&stream) {
            kws.decode(&stream);
            if kws
                .get_result(&stream)
                .is_some_and(|r| !r.keyword.is_empty())
            {
                writeln!(out, "wake")?;
                kws.reset(&stream);
            }
        }
        return Ok(());
    }
    let mut input = io::stdin().lock();
    let mut elapsed_samples = 0u64;
    let mut quiet_samples = 0u64;
    loop {
        let mut header = [0u8; 8];
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        let rate = u32::from_le_bytes(header[..4].try_into()?);
        let count = u32::from_le_bytes(header[4..].try_into()?) as usize;
        if !(8_000..=192_000).contains(&rate) || count == 0 || count > rate as usize {
            return Err("Invalid PCM frame".into());
        }
        let mut bytes = vec![0u8; count * 4];
        input.read_exact(&mut bytes)?;
        let pcm: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        if pcm.iter().any(|x| !x.is_finite()) {
            return Err("Invalid PCM sample".into());
        }
        stream.accept_waveform(rate as i32, &pcm);
        while kws.is_ready(&stream) {
            kws.decode(&stream);
            if kws
                .get_result(&stream)
                .is_some_and(|r| !r.keyword.is_empty())
            {
                writeln!(out, "wake")?;
                out.flush()?;
                kws.reset(&stream);
            }
        }
        elapsed_samples += count as u64;
        let energy = pcm.iter().map(|sample| sample * sample).sum::<f32>() / count as f32;
        quiet_samples = if energy < 0.003 * 0.003 {
            quiet_samples + count as u64
        } else {
            0
        };
        // Prefer a quiet boundary when releasing old feature history. A hard
        // two-minute cap also bounds the worker in continuous background noise.
        if (elapsed_samples >= rate as u64 * 60 && quiet_samples >= rate as u64)
            || elapsed_samples >= rate as u64 * 120
        {
            stream = kws.create_stream();
            stream.accept_waveform(16_000, &[0.0; 16_000]);
            while kws.is_ready(&stream) {
                kws.decode(&stream);
            }
            elapsed_samples = 0;
            quiet_samples = 0;
        }
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
