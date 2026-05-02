use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, Stream};
use thiserror::Error;
use tracing::{info, warn};

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error("no default input device")]
    NoDevice,
    #[error("failed to build input stream: {0}")]
    BuildStream(String),
    #[error("failed to start input stream: {0}")]
    StartStream(String),
    #[error("recorder is not running")]
    NotRunning,
}

pub struct Recorder {
    stream: Option<Stream>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            stream: None,
            samples: Arc::new(Mutex::new(Vec::new())),
            sample_rate: 0,
            channels: 0,
        }
    }

    pub fn start(&mut self) -> Result<(), RecorderError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or(RecorderError::NoDevice)?;
        let config = device
            .default_input_config()
            .map_err(|e| RecorderError::BuildStream(e.to_string()))?;
        self.sample_rate = config.sample_rate().0;
        self.channels = config.channels();
        info!(sample_rate = self.sample_rate, channels = self.channels, format = ?config.sample_format(), "starting recorder");

        // Reset buffer
        if let Ok(mut s) = self.samples.lock() {
            s.clear();
        }

        let samples = Arc::clone(&self.samples);
        let stream_config = config.config();
        let stream = match config.sample_format() {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| append_samples(&samples, data),
                |err| warn!(?err, "input stream error"),
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples(&samples, &converted);
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples(&samples, &converted);
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            other => return Err(RecorderError::BuildStream(format!("unsupported sample format {:?}", other))),
        }
        .map_err(|e| RecorderError::BuildStream(e.to_string()))?;

        stream.play().map_err(|e| RecorderError::StartStream(e.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(Vec<f32>, u32), RecorderError> {
        let stream = self.stream.take().ok_or(RecorderError::NotRunning)?;
        drop(stream); // dropping stops the cpal stream
        let samples = self.samples.lock().map(|s| s.clone()).unwrap_or_default();
        info!(sample_count = samples.len(), "stopped recorder");
        Ok((samples, self.sample_rate))
    }

    /// Channel count of the most recently started capture stream. Returns 0
    /// if the recorder has never been started.
    pub fn channels(&self) -> u16 {
        self.channels
    }
}

fn append_samples(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32]) {
    if let Ok(mut b) = buf.lock() {
        b.extend_from_slice(data);
    }
}
