//! On-demand audio denoising for screen recordings using RNNoise
//! (`nnnoiseless`). Operates on 48kHz mono 16-bit PCM WAV files.
//!
//! RNNoise convention: samples are f32 in the i16 range (−32768..=32767), NOT
//! normalized to −1..1.

use std::io::{Read, Write};
use std::path::Path;

use nnnoiseless::{DenoiseState, FRAME_SIZE};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DenoiseError {
    #[error("io: {0}")]
    Io(String),
    #[error("wav: {0}")]
    Wav(String),
}

/// Split `len` samples into consecutive `[start, end)` frames of at most
/// `frame` samples. The final frame may be short. Empty when `len == 0`.
fn frame_ranges(len: usize, frame: usize) -> Vec<(usize, usize)> {
    if len == 0 || frame == 0 {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + frame).min(len);
        ranges.push((start, end));
        start = end;
    }
    ranges
}

/// Read a 16-bit PCM WAV into f32 samples kept in the i16 range. Returns
/// (samples, sample_rate, channels).
fn read_wav_pcm16(path: &Path) -> Result<(Vec<f32>, u32, u16), DenoiseError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| DenoiseError::Io(e.to_string()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(DenoiseError::Wav("not a WAV file".into()));
    }
    let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
    let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    let bits = u16::from_le_bytes(bytes[34..36].try_into().unwrap());
    if bits != 16 {
        return Err(DenoiseError::Wav(format!("expected 16-bit PCM, got {bits}")));
    }
    // Find the `data` chunk.
    let mut pos = 12;
    let (data_off, data_len) = loop {
        if pos + 8 > bytes.len() {
            return Err(DenoiseError::Wav("no data chunk".into()));
        }
        let id = &bytes[pos..pos + 4];
        let sz = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            break (pos + 8, sz.min(bytes.len() - (pos + 8)));
        }
        pos += 8 + sz + (sz & 1);
    };
    let samples = bytes[data_off..data_off + data_len]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32)
        .collect();
    Ok((samples, sample_rate, channels))
}

/// Write f32 samples (in i16 range) as a 48kHz mono 16-bit PCM WAV.
fn write_wav_pcm16_mono_48k(path: &Path, samples: &[f32]) -> Result<(), DenoiseError> {
    let sample_rate: u32 = 48_000;
    let channels: u16 = 1;
    let bits: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits / 8) as u32;
    let block_align = channels * (bits / 8);
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = s.clamp(-32768.0, 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::File::create(path)
        .and_then(|mut f| f.write_all(&out))
        .map_err(|e| DenoiseError::Io(e.to_string()))
}

/// Denoise a 48kHz mono 16-bit PCM WAV with RNNoise, writing a cleaned WAV.
/// `progress(pct)` is called with 0..=100 as frames are processed.
pub fn denoise_wav(
    in_48k_mono: &Path,
    out_48k_mono: &Path,
    progress: impl Fn(u8),
) -> Result<(), DenoiseError> {
    let (samples, _rate, _channels) = read_wav_pcm16(in_48k_mono)?;
    let ranges = frame_ranges(samples.len(), FRAME_SIZE);
    let total = ranges.len();
    let mut state = DenoiseState::new();
    let mut out: Vec<f32> = Vec::with_capacity(samples.len());
    let mut in_frame = [0.0f32; FRAME_SIZE];
    let mut out_frame = [0.0f32; FRAME_SIZE];
    for (i, (start, end)) in ranges.into_iter().enumerate() {
        let n = end - start;
        in_frame[..n].copy_from_slice(&samples[start..end]);
        for v in in_frame[n..].iter_mut() {
            *v = 0.0; // zero-pad the final partial frame
        }
        state.process_frame(&mut out_frame, &in_frame);
        out.extend_from_slice(&out_frame[..n]); // truncate padding back off
        if total > 0 {
            progress(((i + 1) * 100 / total) as u8);
        }
    }
    write_wav_pcm16_mono_48k(out_48k_mono, &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_ranges_splits_correctly() {
        assert_eq!(frame_ranges(960, 480), vec![(0, 480), (480, 960)]);
        assert_eq!(
            frame_ranges(1000, 480),
            vec![(0, 480), (480, 960), (960, 1000)]
        );
        assert_eq!(frame_ranges(200, 480), vec![(0, 200)]);
        assert_eq!(frame_ranges(0, 480), Vec::<(usize, usize)>::new());
    }
}
