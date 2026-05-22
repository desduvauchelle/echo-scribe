//! Drains ChunkReady events, transcribes each chunk via Parakeet, builds the
//! merged transcript in-memory, and deletes WAVs as they succeed.

use crate::asr::pipeline::AsrPipeline;
use crate::meeting::{ChunkReady, Segment, Speaker};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

/// Advance `clock` to `now_ms` iff `raw_text` contains real speech.
///
/// Used by the meeting inactivity backstop: every transcribed chunk that
/// produced non-empty text bumps the activity clock. Silent chunks (empty or
/// whitespace-only transcription) leave it untouched, so the gap since the
/// clock last moved measures how long the meeting has been quiet.
pub(crate) fn note_activity(clock: &AtomicU64, raw_text: &str, now_ms: u64) {
    if !raw_text.trim().is_empty() {
        clock.store(now_ms, Ordering::Relaxed);
    }
}

/// Wall-clock milliseconds since the Unix epoch, clamped non-negative.
fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Fires once per post-stitch segment that survives the empty-trim. Used by
/// the live guidance engine; never called during plain (non-guided) meetings.
pub type SegmentObserver = std::sync::Arc<dyn Fn(Segment) + Send + Sync>;

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
    failed_dir: PathBuf,
    /// Last OVERLAP_SAMPLES of f32 PCM per speaker. Bounded by construction.
    tails: Arc<Mutex<(Vec<f32>, Vec<f32>)>>,
    on_segment: Option<SegmentObserver>,
    /// Epoch-millis of the last chunk that produced non-empty transcription.
    /// Drives the meeting inactivity backstop (see `meeting::inactivity_should_stop`).
    last_activity_ms: Arc<AtomicU64>,
}

impl Pipeline {
    pub fn new(asr: Arc<AsrPipeline>, failed_dir: PathBuf) -> Self {
        Self {
            asr,
            builder: Arc::new(Mutex::new(TranscriptBuilder::default())),
            failed_dir,
            tails: Arc::new(Mutex::new((Vec::new(), Vec::new()))),
            on_segment: None,
            // Seed with "now" so a meeting that opens to dead air still has a
            // sane baseline for the backstop's elapsed-since-speech math.
            last_activity_ms: Arc::new(AtomicU64::new(now_ms())),
        }
    }

    /// Shared handle to the last-speech clock, for the inactivity backstop timer.
    /// Clone before moving the pipeline into `ActiveMeeting`.
    pub fn activity_clock(&self) -> Arc<AtomicU64> {
        self.last_activity_ms.clone()
    }

    /// Attach a per-segment observer. Must be called BEFORE `spawn_drain`.
    pub fn with_observer(mut self, cb: SegmentObserver) -> Self {
        self.on_segment = Some(cb);
        self
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
        let failed_dir = self.failed_dir.clone();
        let tails = self.tails.clone();
        let on_segment = self.on_segment.clone();
        let last_activity_ms = self.last_activity_ms.clone();
        // Sequential drain: process chunks strictly in `rx` arrival order.
        // One transcription runs at a time by construction (Parakeet on ANE
        // is single-tenant), so the tail-read → transcribe → tail-write
        // sequence per speaker is atomic — no later same-speaker chunk can
        // interleave its prefix-read between an earlier chunk's read and
        // its tail-write.
        tokio::spawn(async move {
            while let Some(chunk) = rx.recv().await {
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
                        let mut input = Vec::with_capacity(prefix.len() + cur.len());
                        input.extend_from_slice(&prefix);
                        input.extend_from_slice(&cur);
                        (cur, input)
                    }
                    Err(e) => {
                        error!(?e, path = %chunk.path.display(), "load chunk failed");
                        // Failed chunk: clear this speaker's overlap state so
                        // the next chunk doesn't prepend a time-discontinuous
                        // tail or stitch against a stale reference.
                        {
                            let mut t = tails.lock().await;
                            if idx == 0 {
                                t.0.clear()
                            } else {
                                t.1.clear()
                            }
                        }
                        builder.lock().await.set_last_text(chunk.speaker, "");
                        let _ = tokio::fs::create_dir_all(&failed_dir).await;
                        let dest =
                            failed_dir.join(chunk.path.file_name().unwrap_or_default());
                        let _ = tokio::fs::rename(&chunk.path, &dest).await;
                        builder.lock().await.failed.push(dest);
                        continue;
                    }
                };

                match asr.transcribe(transcribe_input, 16_000, 1).await {
                    Ok(raw_text) => {
                        // Mark meeting activity on raw (pre-stitch) speech so the
                        // inactivity backstop measures real audio, not the
                        // post-dedup transcript.
                        note_activity(&last_activity_ms, &raw_text, now_ms());
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
                            let seg = Segment {
                                speaker: chunk.speaker,
                                start_ms: chunk.start_ms,
                                end_ms: chunk.end_ms,
                                text: stitched,
                            };
                            b.push(seg.clone());
                            drop(b);
                            if let Some(cb) = &on_segment {
                                cb(seg);
                            }
                        }
                        // Free the chunk WAV — disk flush.
                        if let Err(e) = tokio::fs::remove_file(&chunk.path).await {
                            warn!(?e, path = %chunk.path.display(), "remove chunk failed");
                        }
                        // `cur` and `transcribe_input` drop here.
                        let seg_count = builder.lock().await.segments.len();
                        tracing::info!(seg_count, "[mem] chunk drained");
                        crate::util::rss::log_rss("after chunk transcribe");
                    }
                    Err(e) => {
                        error!(?e, path = %chunk.path.display(), "transcribe failed");
                        // Same rationale as the load-failure branch: don't let
                        // a failed chunk poison the next chunk's overlap/stitch.
                        {
                            let mut t = tails.lock().await;
                            if idx == 0 {
                                t.0.clear()
                            } else {
                                t.1.clear()
                            }
                        }
                        builder.lock().await.set_last_text(chunk.speaker, "");
                        let _ = tokio::fs::create_dir_all(&failed_dir).await;
                        let dest =
                            failed_dir.join(chunk.path.file_name().unwrap_or_default());
                        let _ = tokio::fs::rename(&chunk.path, &dest).await;
                        builder.lock().await.failed.push(dest);
                    }
                }
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
    fn note_activity_advances_clock_only_for_real_speech() {
        let clock = AtomicU64::new(0);
        // Silent chunks (empty / whitespace-only transcription) leave it alone.
        note_activity(&clock, "", 1_000);
        note_activity(&clock, "   ", 2_000);
        assert_eq!(clock.load(Ordering::Relaxed), 0);
        // Real speech bumps the clock to the supplied timestamp.
        note_activity(&clock, "hello team", 5_000);
        assert_eq!(clock.load(Ordering::Relaxed), 5_000);
    }

    #[test]
    fn with_observer_attaches_callback() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let asr = Arc::new(crate::asr::pipeline::AsrPipeline::default());
        let count = Arc::new(AtomicUsize::new(0));
        let count_for_cb = count.clone();
        let cb: SegmentObserver = Arc::new(move |_seg| {
            count_for_cb.fetch_add(1, Ordering::Relaxed);
        });
        let p = Pipeline::new(asr, std::path::PathBuf::from("/tmp/fail"))
            .with_observer(cb);
        if let Some(cb) = &p.on_segment {
            cb(Segment {
                speaker: Speaker::You,
                start_ms: 0,
                end_ms: 1000,
                text: "hello".into(),
            });
        }
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

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

    #[test]
    fn finalize_sorts_segments_by_start_then_speaker() {
        let mut b = TranscriptBuilder::default();
        b.push(Segment {
            speaker: Speaker::Them,
            start_ms: 1000,
            end_ms: 2000,
            text: "second".into(),
        });
        b.push(Segment {
            speaker: Speaker::You,
            start_ms: 0,
            end_ms: 1000,
            text: "first".into(),
        });
        b.push(Segment {
            speaker: Speaker::You,
            start_ms: 1000,
            end_ms: 2000,
            text: "you-at-1000".into(),
        });
        let (segs, _failed) = b.finalize();
        assert_eq!(segs[0].text, "first");
        // start_ms 1000 tie → You (0) before Them (1) per finalize()'s
        // sort key `(start_ms, You=>0u8, Them=>1u8)`.
        assert_eq!(segs[1].text, "you-at-1000");
        assert_eq!(segs[2].text, "second");
    }
}
