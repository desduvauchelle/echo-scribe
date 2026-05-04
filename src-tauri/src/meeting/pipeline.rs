//! Drains ChunkReady events, transcribes each chunk via Parakeet, builds the
//! merged transcript in-memory, and deletes WAVs as they succeed.

use crate::asr::pipeline::AsrPipeline;
use crate::meeting::{ChunkReady, Segment, Speaker};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tracing::{error, info, warn};

#[derive(Default)]
pub struct TranscriptBuilder {
    pub segments: Vec<Segment>,
    pub failed: Vec<PathBuf>,
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
}

impl Pipeline {
    pub fn new(asr: Arc<AsrPipeline>, failed_dir: PathBuf) -> Self {
        Self {
            asr,
            builder: Arc::new(Mutex::new(TranscriptBuilder::default())),
            sem: Arc::new(Semaphore::new(1)), // Parakeet on ANE is single-tenant
            failed_dir,
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
        tokio::spawn(async move {
            let mut workers = Vec::new();
            while let Some(chunk) = rx.recv().await {
                let asr = asr.clone();
                let builder = builder.clone();
                let sem = sem.clone();
                let failed_dir = failed_dir.clone();
                workers.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await.expect("semaphore");
                    match asr.transcribe_file(&chunk.path).await {
                        Ok(text) => {
                            let seg = Segment {
                                speaker: chunk.speaker,
                                start_ms: chunk.start_ms,
                                end_ms: chunk.end_ms,
                                text,
                            };
                            builder.lock().await.push(seg);
                            if let Err(e) = tokio::fs::remove_file(&chunk.path).await {
                                warn!(?e, path = %chunk.path.display(), "remove chunk failed");
                            }
                        }
                        Err(e) => {
                            error!(?e, path = %chunk.path.display(), "transcribe failed");
                            let _ = tokio::fs::create_dir_all(&failed_dir).await;
                            let dest = failed_dir.join(chunk.path.file_name().unwrap_or_default());
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
