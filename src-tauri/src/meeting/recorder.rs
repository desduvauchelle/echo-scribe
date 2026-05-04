//! Chunked WAV writer (60s rotation) and recording orchestrator.

use crate::meeting::syscap::Syscap;
use crate::meeting::{ChunkReady, MeetingError, Speaker};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const CHUNK_SECONDS: u64 = 60;
const SAMPLES_PER_CHUNK: u64 = SAMPLE_RATE as u64 * CHUNK_SECONDS;

/// Streaming WAV writer that rotates files every `CHUNK_SECONDS`.
pub struct ChunkedWavWriter {
    speaker: Speaker,
    dir: PathBuf,
    chunk_index: u32,
    samples_in_chunk: u64,
    total_samples: u64,
    writer: Option<BufWriter<File>>,
    current_path: Option<PathBuf>,
    chunk_start_ms: u64,
    on_chunk_ready: mpsc::UnboundedSender<ChunkReady>,
}

impl ChunkedWavWriter {
    pub fn new(
        speaker: Speaker,
        dir: PathBuf,
        on_chunk_ready: mpsc::UnboundedSender<ChunkReady>,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            speaker,
            dir,
            chunk_index: 0,
            samples_in_chunk: 0,
            total_samples: 0,
            writer: None,
            current_path: None,
            chunk_start_ms: 0,
            on_chunk_ready,
        })
    }

    pub fn write(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < samples.len() {
            if self.writer.is_none() {
                self.open_new_chunk()?;
            }
            let remaining = (SAMPLES_PER_CHUNK - self.samples_in_chunk) as usize;
            let take = remaining.min(samples.len() - offset);
            self.write_raw(&samples[offset..offset + take])?;
            self.samples_in_chunk += take as u64;
            self.total_samples += take as u64;
            offset += take;
            if self.samples_in_chunk >= SAMPLES_PER_CHUNK {
                self.finalize_chunk()?;
            }
        }
        Ok(())
    }

    /// Force-finalize the current chunk (called on stop).
    pub fn flush_partial(&mut self) -> std::io::Result<()> {
        if self.writer.is_some() && self.samples_in_chunk > 0 {
            self.finalize_chunk()?;
        }
        Ok(())
    }

    fn open_new_chunk(&mut self) -> std::io::Result<()> {
        let filename = format!("{}-chunk-{:04}.wav", self.speaker_tag(), self.chunk_index);
        let path = self.dir.join(&filename);
        let mut file = File::create(&path)?;
        // Stub WAV header (44 bytes); patched on finalize.
        file.write_all(&[0u8; 44])?;
        self.writer = Some(BufWriter::new(file));
        self.current_path = Some(path);
        self.samples_in_chunk = 0;
        self.chunk_start_ms = self.total_samples * 1000 / SAMPLE_RATE as u64;
        Ok(())
    }

    fn write_raw(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let writer = self.writer.as_mut().expect("writer open");
        for &s in samples {
            writer.write_all(&s.to_le_bytes())?;
        }
        Ok(())
    }

    fn finalize_chunk(&mut self) -> std::io::Result<()> {
        let mut writer = self.writer.take().expect("writer open");
        writer.flush()?;
        let mut file = writer.into_inner().map_err(|e| e.into_error())?;

        let data_bytes =
            (self.samples_in_chunk as u32) * (CHANNELS as u32) * (BITS_PER_SAMPLE as u32 / 8);
        let riff_size = 36 + data_bytes;
        let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS_PER_SAMPLE as u32 / 8);
        let block_align: u16 = CHANNELS * BITS_PER_SAMPLE / 8;

        file.seek(SeekFrom::Start(0))?;
        file.write_all(b"RIFF")?;
        file.write_all(&riff_size.to_le_bytes())?;
        file.write_all(b"WAVE")?;
        file.write_all(b"fmt ")?;
        file.write_all(&16u32.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?; // PCM
        file.write_all(&CHANNELS.to_le_bytes())?;
        file.write_all(&SAMPLE_RATE.to_le_bytes())?;
        file.write_all(&byte_rate.to_le_bytes())?;
        file.write_all(&block_align.to_le_bytes())?;
        file.write_all(&BITS_PER_SAMPLE.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&data_bytes.to_le_bytes())?;
        file.sync_all()?;

        let path = self.current_path.take().expect("path set");
        let chunk_end_ms = self.total_samples * 1000 / SAMPLE_RATE as u64;
        let ready = ChunkReady {
            speaker: self.speaker,
            path: path.clone(),
            start_ms: self.chunk_start_ms,
            end_ms: chunk_end_ms,
        };
        if let Err(e) = self.on_chunk_ready.send(ready) {
            warn!(?e, "chunk consumer dropped");
        }
        self.chunk_index += 1;
        Ok(())
    }

    fn speaker_tag(&self) -> &'static str {
        match self.speaker {
            Speaker::You => "mic",
            Speaker::Them => "sys",
        }
    }
}

/// Mic capture wrapper. Owns a dedicated thread that holds the (`!Send`)
/// `cpal::Stream` for its lifetime, so the wrapper itself is `Send + Sync`
/// (and can therefore live in `tauri::State`).
pub struct MicCapture {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl MicCapture {
    pub fn start<F>(on_samples: F) -> Result<Self, MeetingError>
    where
        F: FnMut(&[i16]) + Send + 'static,
    {
        let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), MeetingError>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let on_samples = std::sync::Arc::new(std::sync::Mutex::new(on_samples));

        let handle = std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.default_input_device() {
                Some(d) => d,
                None => {
                    let _ = init_tx
                        .send(Err(MeetingError::Audio("no default input device".into())));
                    return;
                }
            };
            let config = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    let _ = init_tx.send(Err(MeetingError::Audio(format!("config: {e}"))));
                    return;
                }
            };
            let in_sample_rate = config.sample_rate().0;
            let in_channels = config.channels();

            let cfg = cpal::StreamConfig {
                channels: in_channels,
                sample_rate: cpal::SampleRate(in_sample_rate),
                buffer_size: cpal::BufferSize::Default,
            };

            let int_buf: std::sync::Arc<std::sync::Mutex<Vec<i16>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::with_capacity(8192)));

            let stream_result = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let int_buf = int_buf.clone();
                    let on_samples = on_samples.clone();
                    device.build_input_stream(
                        &cfg,
                        move |data: &[f32], _| {
                            let resampled = crate::audio::resample::resample_to_16k_mono(
                                data,
                                in_sample_rate,
                                in_channels,
                            );
                            let mut buf = match int_buf.lock() {
                                Ok(g) => g,
                                Err(_) => return,
                            };
                            buf.clear();
                            for s in resampled {
                                let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                                buf.push(v);
                            }
                            if let Ok(mut cb) = on_samples.lock() {
                                cb(&buf);
                            }
                        },
                        |e| error!(?e, "mic stream error"),
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let int_buf = int_buf.clone();
                    let on_samples = on_samples.clone();
                    device.build_input_stream(
                        &cfg,
                        move |data: &[i16], _| {
                            let mut floats: Vec<f32> = Vec::with_capacity(data.len());
                            for &s in data {
                                floats.push(s as f32 / 32768.0);
                            }
                            let resampled = crate::audio::resample::resample_to_16k_mono(
                                &floats,
                                in_sample_rate,
                                in_channels,
                            );
                            let mut buf = match int_buf.lock() {
                                Ok(g) => g,
                                Err(_) => return,
                            };
                            buf.clear();
                            for s in resampled {
                                let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                                buf.push(v);
                            }
                            if let Ok(mut cb) = on_samples.lock() {
                                cb(&buf);
                            }
                        },
                        |e| error!(?e, "mic stream error"),
                        None,
                    )
                }
                other => {
                    let _ = init_tx.send(Err(MeetingError::Audio(format!(
                        "unsupported sample format: {other:?}"
                    ))));
                    return;
                }
            };

            let stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    let _ = init_tx
                        .send(Err(MeetingError::Audio(format!("build_input_stream: {e}"))));
                    return;
                }
            };

            if let Err(e) = stream.play() {
                let _ = init_tx.send(Err(MeetingError::Audio(format!("play: {e}"))));
                return;
            }

            info!(
                rate = in_sample_rate,
                channels = in_channels,
                "mic capture started"
            );
            let _ = init_tx.send(Ok(()));

            // Park the thread until stop is signaled. The cpal stream runs on
            // its own internal threads; we just need to keep the Stream alive.
            let _ = stop_rx.recv();
            drop(stream);
        });

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop_tx: Some(stop_tx),
                handle: Some(handle),
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(MeetingError::Audio("mic thread died during init".into())),
        }
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Owns the mic + syscap streams and routes their PCM into two ChunkedWavWriters.
pub struct Recorder {
    pub meeting_id: String,
    pub dir: PathBuf,
    syscap: Option<Syscap>,
    mic: Option<MicCapture>,
    syscap_task: Option<JoinHandle<()>>,
    syscap_evt_task: Option<JoinHandle<()>>,
    pub mic_only: bool,
    mic_writer: Arc<Mutex<ChunkedWavWriter>>,
    sys_writer: Arc<Mutex<ChunkedWavWriter>>,
}

impl Recorder {
    pub async fn start(
        meeting_id: String,
        dir: PathBuf,
        on_chunk_ready: mpsc::UnboundedSender<ChunkReady>,
        on_syscap_event: mpsc::UnboundedSender<crate::meeting::syscap::SyscapEvent>,
    ) -> Result<Self, MeetingError> {
        std::fs::create_dir_all(&dir)?;
        let mic_writer = Arc::new(Mutex::new(ChunkedWavWriter::new(
            Speaker::You,
            dir.clone(),
            on_chunk_ready.clone(),
        )?));
        let sys_writer = Arc::new(Mutex::new(ChunkedWavWriter::new(
            Speaker::Them,
            dir.clone(),
            on_chunk_ready,
        )?));

        let mw_for_mic = mic_writer.clone();
        let mic = MicCapture::start(move |samples| {
            if let Ok(mut w) = mw_for_mic.lock() {
                if let Err(e) = w.write(samples) {
                    error!(?e, "mic chunk write failed");
                }
            }
        })?;

        let (syscap, mut pcm_rx, mut evt_rx) = match Syscap::spawn() {
            Ok(s) => s,
            Err(e) => {
                warn!(?e, "syscap spawn failed; falling back to mic-only");
                let _ = on_syscap_event.send(crate::meeting::syscap::SyscapEvent::Error {
                    kind: "spawn".into(),
                    msg: e.to_string(),
                });
                return Ok(Self {
                    meeting_id,
                    dir,
                    syscap: None,
                    mic: Some(mic),
                    syscap_task: None,
                    syscap_evt_task: None,
                    mic_only: true,
                    mic_writer,
                    sys_writer,
                });
            }
        };

        let sw_for_pcm = sys_writer.clone();
        let pcm_task = tokio::spawn(async move {
            while let Some(frame) = pcm_rx.recv().await {
                if let Ok(mut w) = sw_for_pcm.lock() {
                    if let Err(e) = w.write(&frame) {
                        error!(?e, "sys chunk write failed");
                    }
                }
            }
        });

        let evt_task = tokio::spawn(async move {
            while let Some(evt) = evt_rx.recv().await {
                let _ = on_syscap_event.send(evt);
            }
        });

        Ok(Self {
            meeting_id,
            dir,
            syscap: Some(syscap),
            mic: Some(mic),
            syscap_task: Some(pcm_task),
            syscap_evt_task: Some(evt_task),
            mic_only: false,
            mic_writer,
            sys_writer,
        })
    }

    pub async fn stop(&mut self) -> Result<(), MeetingError> {
        // Stop syscap first so no more PCM arrives at the sys writer.
        if let Some(mut sc) = self.syscap.take() {
            sc.stop();
        }
        if let Some(t) = self.syscap_task.take() {
            let _ = t.await;
        }
        if let Some(t) = self.syscap_evt_task.take() {
            let _ = t.await;
        }
        // Drop mic stream (cpal stops on drop).
        self.mic.take();
        // Flush any partial chunks.
        if let Ok(mut w) = self.mic_writer.lock() {
            w.flush_partial()?;
        }
        if let Ok(mut w) = self.sys_writer.lock() {
            w.flush_partial()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_writer(
        dir: &std::path::Path,
        speaker: Speaker,
    ) -> (ChunkedWavWriter, mpsc::UnboundedReceiver<ChunkReady>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let w = ChunkedWavWriter::new(speaker, dir.to_path_buf(), tx).unwrap();
        (w, rx)
    }

    #[test]
    fn rotates_at_60_seconds() {
        let tmp = tempdir().unwrap();
        let (mut w, mut rx) = make_writer(tmp.path(), Speaker::You);
        let one_sec = vec![0i16; SAMPLE_RATE as usize];
        for _ in 0..60 {
            w.write(&one_sec).unwrap();
        }
        let extra = vec![0i16; 1600];
        w.write(&extra).unwrap();

        let chunk = rx.try_recv().expect("chunk emitted");
        assert_eq!(chunk.speaker, Speaker::You);
        assert_eq!(chunk.start_ms, 0);
        assert_eq!(chunk.end_ms, 60_000);
        assert!(chunk.path.exists());
        assert!(rx.try_recv().is_err(), "only one chunk should be emitted");
    }

    #[test]
    fn flush_partial_emits_remaining_chunk() {
        let tmp = tempdir().unwrap();
        let (mut w, mut rx) = make_writer(tmp.path(), Speaker::Them);
        let half_sec = vec![0i16; (SAMPLE_RATE / 2) as usize];
        w.write(&half_sec).unwrap();
        w.flush_partial().unwrap();

        let chunk = rx.try_recv().expect("partial emitted");
        assert_eq!(chunk.start_ms, 0);
        assert_eq!(chunk.end_ms, 500);
    }

    #[test]
    fn wav_header_is_valid_after_finalize() {
        let tmp = tempdir().unwrap();
        let (mut w, mut rx) = make_writer(tmp.path(), Speaker::You);
        let one_sec = vec![0i16; SAMPLE_RATE as usize];
        for _ in 0..60 {
            w.write(&one_sec).unwrap();
        }
        let chunk = rx.try_recv().unwrap();

        let bytes = std::fs::read(&chunk.path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[12..16], b"fmt ");
        let sr = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        assert_eq!(sr, SAMPLE_RATE);
    }
}
