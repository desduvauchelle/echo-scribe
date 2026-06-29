use std::f32::consts::PI;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Build script:
///   1. Forwards to `tauri_build::build()` for the usual Tauri codegen.
///   2. Generates three short feedback WAVs (start/stop/ready) into
///      `OUT_DIR` so `audio::feedback` can `include_bytes!` them. Generating
///      them at build time avoids committing binaries while keeping the
///      runtime path zero-IO.
fn main() {
    // Build the Swift sidecars in release mode only (not during cargo check/test).
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if profile == "release" && target_os == "macos" {
        let syscap = std::process::Command::new("bash")
            .arg("../scripts/build-syscap.sh")
            .status()
            .expect("failed to run build-syscap.sh");
        if !syscap.success() {
            panic!("syscap build failed");
        }
        let calmatch = std::process::Command::new("bash")
            .arg("../scripts/build-calmatch.sh")
            .status()
            .expect("failed to run build-calmatch.sh");
        if !calmatch.success() {
            panic!("calmatch build failed");
        }
        let screenrec = std::process::Command::new("bash")
            .arg("../scripts/build-screenrec.sh")
            .status()
            .expect("failed to run build-screenrec.sh");
        if !screenrec.success() {
            panic!("screenrec build failed");
        }
    }
    println!("cargo:rerun-if-changed=syscap/main.swift");
    println!("cargo:rerun-if-changed=syscap/Package.swift");
    println!("cargo:rerun-if-changed=calmatch/main.swift");
    println!("cargo:rerun-if-changed=calmatch/Package.swift");
    println!("cargo:rerun-if-changed=screenrec/main.swift");
    println!("cargo:rerun-if-changed=screenrec/Package.swift");

    tauri_build::build();

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR must be set"));
    fs::create_dir_all(&out_dir).expect("create OUT_DIR");

    // (file_name, frequency_hz, duration_ms, peak_amplitude)
    let sounds: &[(&str, f32, f32, f32)] = &[
        // "start" — subtle low blip.
        ("start.wav", 440.0, 90.0, 0.18),
        // "stop" — subtle high blip.
        ("stop.wav", 660.0, 90.0, 0.18),
        // "ready" — mid-pitch chime, slightly longer.
        ("ready.wav", 880.0, 140.0, 0.15),
    ];

    for (name, freq, dur_ms, peak) in sounds {
        let path = out_dir.join(name);
        write_sine_wav(&path, *freq, *dur_ms, *peak).expect("write feedback wav");
    }
}

/// Write a 16-bit-PCM mono WAV at 16 kHz with a linear fade-out envelope.
/// Tiny by design (~3 KB each).
fn write_sine_wav(
    path: &std::path::Path,
    freq_hz: f32,
    duration_ms: f32,
    peak: f32,
) -> std::io::Result<()> {
    const SR: u32 = 16_000;
    let total_samples = ((SR as f32) * duration_ms / 1000.0).round() as u32;
    let bytes_per_sample = 2u32;
    let data_bytes = total_samples * bytes_per_sample;
    let chunk_size = 36 + data_bytes;

    let mut f = fs::File::create(path)?;
    // RIFF header
    f.write_all(b"RIFF")?;
    f.write_all(&chunk_size.to_le_bytes())?;
    f.write_all(b"WAVE")?;
    // fmt chunk
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?; // PCM fmt chunk size
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&1u16.to_le_bytes())?; // mono
    f.write_all(&SR.to_le_bytes())?; // sample rate
    let byte_rate: u32 = SR * bytes_per_sample;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&(bytes_per_sample as u16).to_le_bytes())?; // block align
    f.write_all(&16u16.to_le_bytes())?; // bits per sample
    // data chunk
    f.write_all(b"data")?;
    f.write_all(&data_bytes.to_le_bytes())?;

    // Linear fade-out envelope to avoid clicks.
    for n in 0..total_samples {
        let t = n as f32 / SR as f32;
        let env = 1.0 - (n as f32 / total_samples as f32);
        let s = (2.0 * PI * freq_hz * t).sin() * peak * env;
        let i16_sample = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        f.write_all(&i16_sample.to_le_bytes())?;
    }

    Ok(())
}
