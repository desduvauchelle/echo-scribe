//! Drains ChunkReady events, transcribes each chunk via Parakeet, builds the
//! merged transcript in-memory, and deletes WAVs as they succeed.

use crate::asr::pipeline::AsrPipeline;
use crate::meeting::{ChunkReady, Segment, Speaker};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tracing::{error, info, warn};

/// Seconds of the previous chunk's audio prepended to the next chunk so
/// Parakeet has acoustic context across the boundary. Bounded — only the
/// last chunk's tail is ever retained.
const OVERLAP_SECONDS: usize = 4;
const OVERLAP_SAMPLES: usize = 16_000 * OVERLAP_SECONDS;

#[derive(Default)]
pub struct TranscriptBuilder {
    pub segments: Vec<Segment>,
    pub failed: Vec<PathBuf>,
    /// Last emitted text per speaker (You, Them) for overlap stitching.
    last_text_you: String,
    last_text_them: String,
}

impl TranscriptBuilder {
    fn last_text(&self, sp: Speaker) -> &str {
        match sp {
            Speaker::You => &self.last_text_you,
            Speaker::Them => &self.last_text_them,
        }
    }
    fn set_last_text(&mut self, sp: Speaker, t: &str) {
        match sp {
            Speaker::You => self.last_text_you = t.to_string(),
            Speaker::Them => self.last_text_them = t.to_string(),
        }
    }
}

impl TranscriptBuilder {
    pub fn push(&mut self, seg: Segment) {
        if !seg.text.trim().is_empty() {
            self.segments.push(seg);
        }
    }

    pub fn finalize(mut self) -> (Vec<Segment>, Vec<PathBuf>) {
        self.segments.sort_by_key(|s| {
            (
                s.start_ms,
                match s.speaker {
                    Speaker::You => 0u8,
                    Speaker::Them => 1u8,
                },
            )
        });
        (self.segments, self.failed)
    }
}

pub struct Pipeline {
    asr: Arc<AsrPipeline>,
    builder: Arc<Mutex<TranscriptBuilder>>,
    sem: Arc<Semaphore>,
    failed_dir: PathBuf,
    /// Last OVERLAP_SAMPLES of f32 PCM per speaker. Bounded by construction.
    tails: Arc<Mutex<(Vec<f32>, Vec<f32>)>>,
}

impl Pipeline {
    pub fn new(asr: Arc<AsrPipeline>, failed_dir: PathBuf) -> Self {
        Self {
            asr,
            builder: Arc::new(Mutex::new(TranscriptBuilder::default())),
            sem: Arc::new(Semaphore::new(1)), // Parakeet on ANE is single-tenant
            failed_dir,
            tails: Arc::new(Mutex::new((Vec::new(), Vec::new()))),
        }
    }

    fn tail_index(sp: Speaker) -> usize {
        match sp {
            Speaker::You => 0,
            Speaker::Them => 1,
        }
    }

    /// Spawns a task that drains the receiver and transcribes each chunk.
    /// Returns a JoinHandle the caller awaits at meeting-end to drain remaining work.
    pub fn spawn_drain(
        &self,
        mut rx: mpsc::UnboundedReceiver<ChunkReady>,
    ) -> tokio::task::JoinHandle<()> {
        let asr = self.asr.clone();
        let builder = self.builder.clone();
        let sem = self.sem.clone();
        let failed_dir = self.failed_dir.clone();
        let tails = self.tails.clone();
        tokio::spawn(async move {
            let mut workers = Vec::new();
            while let Some(chunk) = rx.recv().await {
                let asr = asr.clone();
                let builder = builder.clone();
                let sem = sem.clone();
                let failed_dir = failed_dir.clone();
                let tails = tails.clone();
                workers.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await.expect("semaphore");
                    let idx = Pipeline::tail_index(chunk.speaker);

                    // Read this chunk's PCM, prepend the retained tail.
                    let loaded = AsrPipeline::load_wav_16k_mono_int16(&chunk.path);
                    let (cur, transcribe_input) = match loaded {
                        Ok((cur, _rate, _ch)) => {
                            let prefix = {
                                let t = tails.lock().await;
                                let side = if idx == 0 { &t.0 } else { &t.1 };
                                side.clone()
                            };
                            let mut input =
                                Vec::with_capacity(prefix.len() + cur.len());
                            input.extend_from_slice(&prefix);
                            input.extend_from_slice(&cur);
                            (cur, input)
                        }
                        Err(e) => {
                            error!(?e, path = %chunk.path.display(), "load chunk failed");
                            let _ = tokio::fs::create_dir_all(&failed_dir).await;
                            let dest = failed_dir
                                .join(chunk.path.file_name().unwrap_or_default());
                            let _ = tokio::fs::rename(&chunk.path, &dest).await;
                            builder.lock().await.failed.push(dest);
                            return;
                        }
                    };

                    match asr.transcribe(transcribe_input, 16_000, 1).await {
                        Ok(raw_text) => {
                            // Update the retained tail to this chunk's last
                            // OVERLAP_SAMPLES (bounded — old tail dropped).
                            {
                                let mut t = tails.lock().await;
                                let side = if idx == 0 { &mut t.0 } else { &mut t.1 };
                                let start = cur.len().saturating_sub(OVERLAP_SAMPLES);
                                *side = cur[start..].to_vec();
                            }
                            // Stitch: drop words duplicated from the prev tail.
                            let stitched = {
                                let b = builder.lock().await;
                                crate::meeting::stitch::strip_overlap(
                                    b.last_text(chunk.speaker),
                                    &raw_text,
                                )
                            };
                            if !stitched.trim().is_empty() {
                                let mut b = builder.lock().await;
                                b.set_last_text(chunk.speaker, &stitched);
                                b.push(Segment {
                                    speaker: chunk.speaker,
                                    start_ms: chunk.start_ms,
                                    end_ms: chunk.end_ms,
                                    text: stitched,
                                });
                            }
                            // Free the chunk WAV — disk flush.
                            if let Err(e) =
                                tokio::fs::remove_file(&chunk.path).await
                            {
                                warn!(?e, path = %chunk.path.display(), "remove chunk failed");
                            }
                            // `cur` and `transcribe_input` drop here.
                            let seg_count =
                                builder.lock().await.segments.len();
                            tracing::info!(seg_count, "[mem] chunk drained");
                            crate::util::rss::log_rss("after chunk transcribe");
                        }
                        Err(e) => {
                            error!(?e, path = %chunk.path.display(), "transcribe failed");
                            let _ = tokio::fs::create_dir_all(&failed_dir).await;
                            let dest = failed_dir
                                .join(chunk.path.file_name().unwrap_or_default());
                            let _ = tokio::fs::rename(&chunk.path, &dest).await;
                            builder.lock().await.failed.push(dest);
                        }
                    }
                }));
            }
            for w in workers {
                let _ = w.await;
            }
            info!("transcription pipeline drained");
        })
    }

    /// Take ownership of the builder (call after spawn_drain's join handle resolves).
    pub async fn finalize(self) -> (Vec<Segment>, Vec<PathBuf>) {
        let builder = Arc::try_unwrap(self.builder)
            .map_err(|_| ())
            .expect("no other refs after pipeline drain");
        builder.into_inner().finalize()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::{Segment, Speaker};

    #[test]
    fn builder_tracks_last_text_per_speaker() {
        let mut b = TranscriptBuilder::default();
        b.set_last_text(Speaker::You, "we should ship it");
        b.set_last_text(Speaker::Them, "sounds good to me");
        assert_eq!(b.last_text(Speaker::You), "we should ship it");
        assert_eq!(b.last_text(Speaker::Them), "sounds good to me");
        b.push(Segment {
            speaker: Speaker::You,
            start_ms: 0,
            end_ms: 1000,
            text: "hello".into(),
        });
        assert_eq!(b.segments.len(), 1);
    }
}
