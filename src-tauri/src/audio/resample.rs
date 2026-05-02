//! Resample arbitrary cpal capture buffers down to the 16 kHz mono format
//! that Parakeet expects.
//!
//! The cpal default input config on macOS is typically 48 kHz stereo (or 44.1 kHz
//! mono on AirPods). Parakeet wants exactly 16 kHz mono `f32` samples in the
//! `[-1.0, 1.0]` range, so this module:
//!
//! 1. Down-mixes to mono (averaging channels) if `channels > 1`.
//! 2. Resamples to 16 kHz with `rubato::SincFixedIn` if `from_rate != 16_000`.
//!
//! 16 kHz mono input is returned unchanged (cheap fast path).

use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use tracing::{warn};

const TARGET_RATE: u32 = 16_000;

/// Resample interleaved samples from `(from_rate, channels)` to 16 kHz mono.
///
/// Input `samples` is interleaved (channel-0 sample, channel-1 sample, …).
/// Output is a mono `Vec<f32>` at 16 kHz. On any internal failure the function
/// logs a warning and returns the best-effort partial result (or the input
/// unchanged). Callers should treat unexpectedly-short output as a soft error.
pub fn resample_to_16k_mono(samples: &[f32], from_rate: u32, channels: u16) -> Vec<f32> {
    // Step 1: down-mix to mono (deinterleave + average).
    let mono = if channels <= 1 {
        samples.to_vec()
    } else {
        let ch = channels as usize;
        let frames = samples.len() / ch;
        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            let mut acc = 0.0f32;
            for c in 0..ch {
                acc += samples[f * ch + c];
            }
            out.push(acc / ch as f32);
        }
        out
    };

    // Step 2: resample if needed.
    if from_rate == TARGET_RATE {
        return mono;
    }

    let ratio = TARGET_RATE as f64 / from_rate as f64;
    // SincFixedIn wants a fixed input chunk size; use the whole buffer.
    let chunk_size = mono.len();
    if chunk_size == 0 {
        return mono;
    }

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = match SincFixedIn::<f32>::new(ratio, 1.0, params, chunk_size, 1) {
        Ok(r) => r,
        Err(e) => {
            warn!(?e, "failed to build resampler; returning mono samples unresampled");
            return mono;
        }
    };

    let input = vec![mono.clone()];
    match resampler.process(&input, None) {
        Ok(mut out) => out.remove(0),
        Err(e) => {
            warn!(?e, "resample failed; returning mono samples unresampled");
            mono
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i as f32) / (n as f32)).collect()
    }

    #[test]
    fn no_op_when_already_16k_mono() {
        let input = ramp(1024);
        let out = resample_to_16k_mono(&input, 16_000, 1);
        assert_eq!(out, input);
    }

    #[test]
    fn downsamples_48k_mono_to_16k_with_third_length() {
        let input = ramp(48_000); // 1s of 48 kHz mono
        let out = resample_to_16k_mono(&input, 48_000, 1);
        // Allow a small fudge for the resampler's transient padding.
        let expected = 16_000;
        let diff = (out.len() as i64 - expected as i64).abs();
        assert!(
            diff < 512,
            "expected ~{} samples, got {} (diff {})",
            expected,
            out.len(),
            diff
        );
    }

    #[test]
    fn downmixes_stereo_then_resamples() {
        // 1s of 48 kHz stereo: left = 0.5, right = -0.5 → mono should be 0.0
        let frames = 48_000;
        let mut input = Vec::with_capacity(frames * 2);
        for _ in 0..frames {
            input.push(0.5);
            input.push(-0.5);
        }
        let out = resample_to_16k_mono(&input, 48_000, 2);
        let expected = 16_000;
        let diff = (out.len() as i64 - expected as i64).abs();
        assert!(diff < 512, "expected ~{} samples, got {}", expected, out.len());
        // Average of all output samples should be ~0
        let avg: f32 = out.iter().sum::<f32>() / out.len() as f32;
        assert!(avg.abs() < 1e-3, "avg should be ~0, got {}", avg);
    }
}
